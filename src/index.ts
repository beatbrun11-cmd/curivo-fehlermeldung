/**
 * Meldet Fehler an Sentry — und nichts sonst.
 *
 * **Warum kein Sentry-SDK.** Das SDK nimmt mit, was es findet: Header,
 * Cookies, IP, Frame-Variablen, Meldungstexte, Brotkrumen, Anhänge, Sitzungen.
 * Ein Filter davor muss jeden dieser Wege kennen und stürzt bei zyklischen
 * Objekten selbst ab (Voice, 2'210 verlorene Meldungen bis 02.11.2026). Dieser
 * Melder baut das Ereignis selbst, aus Werten, die nur aus geschlossenen
 * Listen kommen können. Patientendaten haben keinen Weg hinein.
 *
 * **Wo die Einzelheiten bleiben.** Stack und Meldungstext loggt der Aufrufer
 * in Azure, zusammen mit der zurückgegebenen `diagnoseId`. Sentry sagt, DASS
 * und WO etwas schiefging; Azure sagt, WAS.
 *
 * **Der Melder wirft nie.** Jeder öffentliche Aufruf und der Takt fangen alles
 * ab; `fertig` löst immer auf, nie mit einer Ablehnung.
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
const GRENZE_KOERBE = 500;
const ZEITLIMIT_MS = 2_000;
const PAUSE_STANDARD_MS = 60_000;

const ausListe = (liste: readonly string[], wert: unknown): string =>
  typeof wert === "string" && liste.includes(wert) ? wert : UNBEKANNT;

/**
 * Die Prüfungen, getrennt vom Versand, damit ein Test sie durch die Identität
 * ersetzen und so beweisen kann, dass seine Markersuche überhaupt greift.
 */
export const pruefer = {
  modul: (x: unknown) => ausListe(MODULE, x),
  environment: (x: unknown) => ausListe(UMGEBUNGEN, x),
  release: (x: unknown) => (typeof x === "string" && /^[0-9a-f]{7,40}$/.test(x) ? x : UNBEKANNT),
  route: (routen: readonly string[], x: unknown) => ausListe(routen, x),
  code: (x: unknown) => ausListe(FEHLERCODES, x),
  status: (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 500 && x <= 599 ? String(x) : undefined),
  quelle: (x: unknown): Quelle => (x === "browser" ? "browser" : "server"),
};
export type Pruefer = typeof pruefer;

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
  protokoll?: (eintrag: Record<string, string>) => void;
  /** Nur für die Negativkontrolle der Tests. */
  pruefer?: Pruefer;
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

/** Baut Ziel und DSN neu aus den geprüften Teilen; vom übergebenen Text wird nichts weitergereicht. */
export function leseDsn(dsn: unknown, testmodus = false): Ziel | null {
  if (typeof dsn !== "string") return null;
  let u: URL;
  try {
    u = new URL(dsn);
  } catch {
    return null;
  }
  const sentry = u.protocol === "https:" && /^o\d+\.ingest\.de\.sentry\.io$/.test(u.hostname) && !u.port;
  const lokal = testmodus && u.protocol === "http:" && u.hostname === "127.0.0.1";
  const projekt = u.pathname.slice(1);
  if (!(sentry || lokal) || !/^[0-9a-f]{32}$/.test(u.username) || u.password || u.search || u.hash || !/^\d+$/.test(projekt)) return null;
  const host = `${u.protocol}//${u.host}`;
  return { url: `${host}/api/${projekt}/envelope/`, key: u.username, dsn: `${u.protocol}//${u.username}@${u.host}/${projekt}` };
}

export function stufe(n: number): string {
  return n < 1 ? "0" : n < 10 ? "1-9" : n < 100 ? "10-99" : "100+";
}

/**
 * Wie lange ein Key schweigen muss. `X-Sentry-Rate-Limits` gilt bei jedem
 * Status und geht vor; Einträge ohne Kategorie oder mit `error`/`default`
 * betreffen Ereignisse. Sonst bei 429 `Retry-After` (Sekunden oder Datum).
 */
export function pauseMs(antwort: Response, jetzt: number): number {
  const grenzen = antwort.headers.get("x-sentry-rate-limits");
  if (grenzen) {
    let ms = 0;
    for (const eintrag of grenzen.split(",")) {
      const [sekunden, kategorien = ""] = eintrag.trim().split(":");
      const k = kategorien ? kategorien.split(";") : [];
      if (!k.length || k.includes("error") || k.includes("default")) ms = Math.max(ms, (Number(sekunden) || 0) * 1000);
    }
    return ms;
  }
  if (antwort.status !== 429) return 0;
  const nachher = antwort.headers.get("retry-after");
  if (nachher && Number(nachher) > 0) return Number(nachher) * 1000;
  const datum = nachher ? Date.parse(nachher) - jetzt : NaN;
  return datum > 0 ? datum : PAUSE_STANDARD_MS;
}

interface Felder {
  quelle: Quelle;
  route: string;
  code: string;
  status?: string;
}
interface Korb extends Felder {
  stunde: number;
  anzahl: number;
}

export function erstelleMelder(e: Einstellungen) {
  const p = e.pruefer ?? pruefer;
  const jetzt = e.jetzt ?? Date.now;
  const holen = e.fetch ?? fetch;
  const istAus = e.aus ?? (() => process.env.FEHLERMELDUNG_AUS === "1");
  const protokoll = (x: Record<string, string>) => {
    try {
      (e.protokoll ?? ((y) => console.warn(JSON.stringify({ fehlermeldung: y }))))(x);
    } catch {
      // Ein kaputtes Log darf den Melder nicht mitreissen.
    }
  };
  const modul = p.modul(e.modul);
  const release = p.release(e.release);
  const environment = p.environment(e.environment);
  const ziele: Record<Quelle, Ziel | null> = {
    server: leseDsn(e.dsn?.server, e.testmodus),
    browser: leseDsn(e.dsn?.browser, e.testmodus),
  };

  const zuletzt = new Map<string, number>();
  /** Nicht einzeln zugestellte Vorkommen je (Quelle, Route, Code, Stunde des Vorkommens). */
  const koerbe = new Map<string, Korb>();
  const minute = { beginn: -Infinity, gesamt: 0, browser: 0 };
  const pauseBis: Record<Quelle, number> = { server: 0, browser: 0 };
  const offen: Record<Quelle, Set<Promise<Ergebnis>>> = { server: new Set(), browser: new Set() };

  const neueId = () => randomUUID().replace(/-/g, "");
  const schluessel = (f: Felder) => `${f.quelle}|${f.route}|${f.code}|${f.status ?? ""}`;

  function inKorb(f: Felder, stunde: number, anzahl: number) {
    const k = `${schluessel(f)}|${stunde}`;
    const korb = koerbe.get(k);
    if (korb) korb.anzahl += anzahl;
    else if (koerbe.size < GRENZE_KOERBE) koerbe.set(k, { ...f, stunde, anzahl });
    else protokoll({ modul, route: f.route, code: f.code, ergebnis: "verworfen", grund: "koerbe_voll" });
  }

  /** Belegt einen Platz im Minutenbudget, falls frei. */
  function budget(quelle: Quelle, t: number): boolean {
    if (t - minute.beginn >= MINUTE) Object.assign(minute, { beginn: t, gesamt: 0, browser: 0 });
    if (minute.gesamt >= GRENZE_MINUTE.gesamt || (quelle === "browser" && minute.browser >= GRENZE_MINUTE.browser)) return false;
    minute.gesamt++;
    if (quelle === "browser") minute.browser++;
    return true;
  }

  const sendbar = (q: Quelle) => !istAus() && ziele[q] !== null && jetzt() >= pauseBis[q] && offen[q].size < GRENZE_OFFEN;

  function sende(f: Felder, diagnoseId: string, zusatz: { wiederholt?: string; haeufungStunde?: number } = {}): Promise<Ergebnis> {
    const ziel = ziele[f.quelle]!;
    const ende = (ergebnis: Ergebnis, grund?: string): Ergebnis => {
      protokoll({ diagnoseId, modul, quelle: f.quelle, route: f.route, code: f.code, ergebnis, ...(grund ? { grund } : {}) });
      return ergebnis;
    };
    const haeufung = zusatz.haeufungStunde !== undefined;
    const stunde = haeufung ? new Date(zusatz.haeufungStunde! * STUNDE).toISOString().slice(0, 13) : "";
    const ereignis = {
      event_id: diagnoseId,
      timestamp: jetzt() / 1000,
      platform: "other",
      level: "error",
      release,
      environment,
      fingerprint: haeufung ? [modul, f.route, f.code, "haeufung", stunde] : [modul, f.route, f.code],
      message: `${modul} ${f.code} ${f.route}${haeufung ? ` haeufung ${stunde}` : ""}`,
      tags: {
        modul,
        route: f.route,
        code: f.code,
        quelle: f.quelle,
        ...(f.status ? { status: f.status } : {}),
        ...(zusatz.wiederholt ? { wiederholt: zusatz.wiederholt } : {}),
      },
    };
    const body = [
      JSON.stringify({ event_id: diagnoseId, sent_at: new Date(jetzt()).toISOString(), dsn: ziel.dsn }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(ereignis),
    ].join("\n");

    const fertig = Promise.resolve()
      .then(() =>
        holen(ziel.url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(ZEITLIMIT_MS),
          headers: {
            "content-type": "application/x-sentry-envelope",
            "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${ziel.key}, sentry_client=curivo-fehlermeldung/1.0.0`,
          },
          body,
        }),
      )
      .then(
        (antwort) => {
          pauseBis[f.quelle] = Math.max(pauseBis[f.quelle], jetzt() + pauseMs(antwort, jetzt()));
          return antwort.ok ? ende("gesendet") : ende("fehler", `http_${antwort.status}`);
        },
        () => ende("fehler", "netz"),
      )
      .catch((): Ergebnis => "fehler");
    offen[f.quelle].add(fertig);
    void fertig.then(() => offen[f.quelle].delete(fertig));
    return fertig;
  }

  function melde(m: Meldung): { diagnoseId: string; fertig: Promise<Ergebnis> } {
    const diagnoseId = neueId();
    try {
      const f: Felder = { quelle: p.quelle(m?.quelle), route: p.route(e.routen, m?.route), code: p.code(m?.code), status: p.status(m?.status) };
      const verworfen = (grund: string) => {
        protokoll({ diagnoseId, modul, quelle: f.quelle, route: f.route, code: f.code, ergebnis: "verworfen", grund });
        return { diagnoseId, fertig: Promise.resolve<Ergebnis>("verworfen") };
      };
      if (istAus()) return verworfen("notschalter");
      if (!ziele[f.quelle]) return verworfen("kein_ziel");
      const t = jetzt();
      const stunde = Math.floor(t / STUNDE);
      const k = schluessel(f);
      const kuerzlich = t - (zuletzt.get(k) ?? -Infinity) < MINUTE;
      if (kuerzlich || !sendbar(f.quelle) || !budget(f.quelle, t)) {
        inKorb(f, stunde, 1);
        return verworfen(kuerzlich ? "wiederholung" : "grenze");
      }
      zuletzt.set(k, t);
      if (zuletzt.size > GRENZE_KOERBE) for (const [s, z] of zuletzt) if (t - z >= MINUTE) zuletzt.delete(s);
      const fertig = sende(f, diagnoseId).then((r) => {
        if (r !== "gesendet") inKorb(f, stunde, 1);
        return r;
      });
      return { diagnoseId, fertig };
    } catch {
      return { diagnoseId, fertig: Promise.resolve("fehler") };
    }
  }

  /**
   * Meldet je Korb ein Zusammenfassungsereignis, ab 10 Vorkommen als eigenes
   * Häufungs-Issue je Stunde. Zusammenfassungen zählen ins Minutenbudget; was
   * keinen Platz findet oder nicht ankommt, bleibt im Korb. Körbe älter als die
   * Vorstunde verfallen — eine gestrige Häufung wird heute nicht mehr gemeldet.
   */
  function fasseZusammen(): Promise<Ergebnis>[] {
    try {
      const t = jetzt();
      const ergebnisse: Promise<Ergebnis>[] = [];
      for (const [k, korb] of koerbe) {
        if (korb.stunde < Math.floor(t / STUNDE) - 1) {
          koerbe.delete(k);
          protokoll({ modul, route: korb.route, code: korb.code, ergebnis: "verworfen", grund: "korb_verfallen", anzahl: String(korb.anzahl) });
          continue;
        }
        if (!sendbar(korb.quelle) || !budget(korb.quelle, t)) continue;
        koerbe.delete(k);
        const { stunde, anzahl, ...f } = korb;
        const zusatz = { wiederholt: stufe(anzahl), ...(anzahl >= 10 ? { haeufungStunde: stunde } : {}) };
        ergebnisse.push(
          sende(f, neueId(), zusatz).then((r) => {
            if (r !== "gesendet") inKorb(f, stunde, anzahl);
            return r;
          }),
        );
      }
      return ergebnisse;
    } catch {
      return [];
    }
  }

  async function spuele(ms: number): Promise<void> {
    try {
      fasseZusammen();
      const alle = [...offen.server, ...offen.browser];
      if (!alle.length) return;
      let uhr: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(alle), new Promise((r) => (uhr = setTimeout(r, ms)))]);
      clearTimeout(uhr);
    } catch {
      // siehe Kopf: der Melder wirft nie.
    }
  }

  const takt = setInterval(fasseZusammen, MINUTE);
  takt.unref();

  return { melde, spuele, fasseZusammen, stoppe: () => clearInterval(takt) };
}

export type Melder = ReturnType<typeof erstelleMelder>;
