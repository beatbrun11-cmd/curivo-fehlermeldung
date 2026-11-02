/**
 * Meldet Fehler an Sentry — und nichts sonst.
 *
 * **Warum kein Sentry-SDK.** Das SDK nimmt mit, was es findet: Header,
 * Cookies, IP, Frame-Variablen, Meldungstexte, Brotkrumen, Anhänge, Sitzungen.
 * Ein Filter davor muss jeden dieser Wege kennen und stürzt bei zyklischen
 * Objekten selbst ab (Voice, 2'210 verlorene Meldungen bis 02.11.2026). Dieser
 * Melder baut das Ereignis selbst, aus drei Werten, die nur aus geschlossenen
 * Listen kommen können. Patientendaten haben keinen Weg hinein.
 *
 * **Wo die Einzelheiten bleiben.** Stack und Meldungstext loggt der Aufrufer
 * in Azure, zusammen mit der zurückgegebenen `diagnoseId`. Sentry sagt, DASS
 * und WO etwas schiefging; Azure sagt, WAS.
 */
import { randomUUID } from "node:crypto";

export const MODULE = ["voice-api", "voice-web", "log", "bill"] as const;
export const FEHLERCODES = [
  "unbehandelt",
  "antwort_5xx",
  "render_fehler",
  "client_absturz",
  "start_fehler",
  "transkription_endgueltig",
  "gemini_ueberlast",
  "rechnung_erzeugen",
  "pflegeplanung_speichern",
  "dokument_speichern",
] as const;
export const UMGEBUNGEN = ["produktion", "test", "lokal"] as const;

export type Modul = (typeof MODULE)[number];
export type Fehlercode = (typeof FEHLERCODES)[number];
export type Quelle = "server" | "browser";
export type Ergebnis = "gesendet" | "verworfen" | "fehler";

const UNBEKANNT = "unbekannt";
const MINUTE = 60_000;
const STUNDE = 3_600_000;
/** Je Prozess und Minute; Browser-Berichte belegen höchstens ihren Teil davon. */
const GRENZE_MINUTE = { gesamt: 30, browser: 10 };
const GRENZE_OFFEN = 10;
const ZEITLIMIT_MS = 2_000;
const PAUSE_STANDARD_S = 60;

export interface Einstellungen {
  modul: Modul;
  /** Je Quelle ein eigener Client-Key, damit Browser-Berichte kein Server-Budget aufbrauchen. */
  dsn: Partial<Record<Quelle, string | undefined>>;
  release: string | undefined;
  environment: string | undefined;
  /** Die generierte Routenschablonen-Liste der App. Alles andere wird `unbekannt`. */
  routen: readonly string[];
  /** Notschalter; Standard: `FEHLERMELDUNG_AUS=1` zur Laufzeit. */
  aus?: () => boolean;
  /** Erlaubt `http://127.0.0.1:<port>` als Ziel — nur für Tests mit lokalem Sammler. */
  testmodus?: boolean;
  jetzt?: () => number;
  fetch?: typeof fetch;
  protokoll?: (eintrag: Record<string, string | number>) => void;
}

export interface Meldung {
  route: string;
  code: string;
  status?: number;
  quelle?: Quelle;
}

interface Ziel {
  url: string;
  key: string;
  dsn: string;
}

export function leseDsn(dsn: string | undefined, testmodus = false): Ziel | null {
  if (!dsn) return null;
  let u: URL;
  try {
    u = new URL(dsn);
  } catch {
    return null;
  }
  const sentry = u.protocol === "https:" && /^o\d+\.ingest\.de\.sentry\.io$/.test(u.hostname) && !u.port;
  const lokal = testmodus && u.protocol === "http:" && u.hostname === "127.0.0.1";
  const projekt = u.pathname.slice(1);
  if (!(sentry || lokal) || !/^[0-9a-f]{32}$/.test(u.username) || u.password || !/^\d+$/.test(projekt)) return null;
  return { url: `${u.protocol}//${u.host}/api/${projekt}/envelope/`, key: u.username, dsn };
}

function aus<T extends string>(liste: readonly T[], wert: unknown): T | typeof UNBEKANNT {
  return liste.includes(wert as T) ? (wert as T) : UNBEKANNT;
}

export function stufe(n: number): string {
  return n < 1 ? "0" : n < 10 ? "1-9" : n < 100 ? "10-99" : "100+";
}

function pauseAus(antwort: Response): number {
  const nachher = Number(antwort.headers.get("retry-after"));
  if (nachher > 0) return nachher;
  const grenzen = Number(antwort.headers.get("x-sentry-rate-limits")?.split(":")[0]);
  return grenzen > 0 ? grenzen : PAUSE_STANDARD_S;
}

export function erstelleMelder(e: Einstellungen) {
  const jetzt = e.jetzt ?? Date.now;
  const holen = e.fetch ?? fetch;
  const istAus = e.aus ?? (() => process.env.FEHLERMELDUNG_AUS === "1");
  const protokoll = e.protokoll ?? ((x) => console.warn(JSON.stringify({ fehlermeldung: x })));
  const modul = aus(MODULE, e.modul);
  const release = /^[0-9a-f]{7,40}$/.test(e.release ?? "") ? e.release! : UNBEKANNT;
  const environment = aus(UMGEBUNGEN, e.environment);
  const ziele: Record<Quelle, Ziel | null> = {
    server: leseDsn(e.dsn.server, e.testmodus),
    browser: leseDsn(e.dsn.browser, e.testmodus),
  };

  const zuletzt = new Map<string, number>();
  /** Unterdrückte Vorkommen je (Quelle, Route, Code, Stunde des Vorkommens). */
  const koerbe = new Map<string, { quelle: Quelle; route: string; code: string; stunde: number; anzahl: number }>();
  const minute = { beginn: 0, gesamt: 0, browser: 0 };
  const pauseBis: Record<Quelle, number> = { server: 0, browser: 0 };
  const offen: Record<Quelle, Set<Promise<Ergebnis>>> = { server: new Set(), browser: new Set() };

  function sende(
    quelle: Quelle,
    felder: { route: string; code: string; status?: number },
    zusatz: { wiederholt?: string; haeufungStunde?: number } = {},
  ): { diagnoseId: string; fertig: Promise<Ergebnis> } {
    const diagnoseId = randomUUID().replace(/-/g, "");
    const ziel = ziele[quelle];
    const ende = (ergebnis: Ergebnis, grund?: string) => {
      protokoll({ diagnoseId, modul, quelle, route: felder.route, code: felder.code, ergebnis, ...(grund ? { grund } : {}) });
      return Promise.resolve(ergebnis);
    };
    if (istAus()) return { diagnoseId, fertig: ende("verworfen", "notschalter") };
    if (!ziel) return { diagnoseId, fertig: ende("verworfen", "kein_ziel") };
    if (jetzt() < pauseBis[quelle]) return { diagnoseId, fertig: ende("verworfen", "pause") };
    if (offen[quelle].size >= GRENZE_OFFEN) return { diagnoseId, fertig: ende("verworfen", "zu_viele_offen") };

    const haeufung = zusatz.haeufungStunde !== undefined;
    const stunde = haeufung ? new Date(zusatz.haeufungStunde! * STUNDE).toISOString().slice(0, 13) : "";
    const ereignis = {
      event_id: diagnoseId,
      timestamp: jetzt() / 1000,
      platform: "other",
      level: "error",
      release,
      environment,
      fingerprint: haeufung ? [modul, felder.route, felder.code, "haeufung", stunde] : [modul, felder.route, felder.code],
      message: `${modul} ${felder.code} ${felder.route}${haeufung ? ` haeufung ${stunde}` : ""}`,
      tags: {
        modul,
        route: felder.route,
        code: felder.code,
        quelle,
        ...(felder.status ? { status: String(felder.status) } : {}),
        ...(zusatz.wiederholt ? { wiederholt: zusatz.wiederholt } : {}),
      },
    };
    const body = [
      JSON.stringify({ event_id: diagnoseId, sent_at: new Date(jetzt()).toISOString(), dsn: ziel.dsn }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(ereignis),
    ].join("\n");

    const fertig: Promise<Ergebnis> = holen(ziel.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(ZEITLIMIT_MS),
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${ziel.key}, sentry_client=curivo-fehlermeldung/1.0.0`,
      },
      body,
    }).then(
      (antwort) => {
        if (antwort.status === 429) pauseBis[quelle] = jetzt() + pauseAus(antwort) * 1000;
        return antwort.ok ? ende("gesendet") : ende("fehler", `http_${antwort.status}`);
      },
      () => ende("fehler", "netz"),
    );
    offen[quelle].add(fertig);
    fertig.finally(() => offen[quelle].delete(fertig));
    return { diagnoseId, fertig };
  }

  function melde(m: Meldung): { diagnoseId: string; fertig: Promise<Ergebnis> } {
    const quelle: Quelle = m.quelle === "browser" ? "browser" : "server";
    const felder = {
      route: aus(e.routen, m.route),
      code: aus(FEHLERCODES, m.code),
      status: Number.isInteger(m.status) && m.status! >= 500 && m.status! <= 599 ? m.status : undefined,
    };
    const t = jetzt();
    const schluessel = `${quelle}|${felder.route}|${felder.code}`;
    if (t - minute.beginn >= MINUTE) Object.assign(minute, { beginn: t, gesamt: 0, browser: 0 });
    const voll = minute.gesamt >= GRENZE_MINUTE.gesamt || (quelle === "browser" && minute.browser >= GRENZE_MINUTE.browser);
    const kuerzlich = t - (zuletzt.get(schluessel) ?? -Infinity) < MINUTE;
    if (voll || kuerzlich) {
      const stunde = Math.floor(t / STUNDE);
      const korb = koerbe.get(`${schluessel}|${stunde}`) ?? { quelle, ...felder, stunde, anzahl: 0 };
      korb.anzahl++;
      koerbe.set(`${schluessel}|${stunde}`, korb);
      const diagnoseId = randomUUID().replace(/-/g, "");
      protokoll({ diagnoseId, modul, quelle, route: felder.route, code: felder.code, ergebnis: "verworfen", grund: voll ? "minutengrenze" : "wiederholung" });
      return { diagnoseId, fertig: Promise.resolve("verworfen") };
    }
    zuletzt.set(schluessel, t);
    minute.gesamt++;
    if (quelle === "browser") minute.browser++;
    return sende(quelle, felder);
  }

  /** Meldet je Korb ein Zusammenfassungsereignis; ab 10 Vorkommen als eigenes Häufungs-Issue je Stunde. */
  function fasseZusammen(): Promise<Ergebnis>[] {
    const ergebnisse = [...koerbe.values()].map((k) =>
      sende(k.quelle, k, { wiederholt: stufe(k.anzahl), ...(k.anzahl >= 10 ? { haeufungStunde: k.stunde } : {}) }).fertig,
    );
    koerbe.clear();
    return ergebnisse;
  }

  async function spuele(ms: number): Promise<void> {
    fasseZusammen();
    const alle = [...offen.server, ...offen.browser];
    await Promise.race([Promise.allSettled(alle), new Promise((r) => setTimeout(r, ms).unref())]);
  }

  const takt = setInterval(fasseZusammen, MINUTE);
  takt.unref();

  return { melde, spuele, fasseZusammen, stoppe: () => clearInterval(takt) };
}

export type Melder = ReturnType<typeof erstelleMelder>;
