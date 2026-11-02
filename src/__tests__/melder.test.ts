import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { erstelleMelder, leseDsn, pauseMs, type Einstellungen } from "../index";

const KEY = "0123456789abcdef0123456789abcdef";
const SHA = "a1b2c3d";
const ROUTEN = ["/api/klienten/[id]", "/intern/fehlerprobe"];
/** Was in keinem Fall bei Sentry ankommen darf. */
const MARKER = ["Muster Anna", "756.1234.5678.97", "anna@example.ch", "?klient=42", "Diagnose: Diabetes"];

type Antwort = { status: number; headers?: Record<string, string>; haengen?: boolean; verzoegerung?: number };
let server: Server;
let basis: string;
let empfangen: { pfad: string; headers: IncomingHttpHeaders; body: string }[] = [];
let antwortFuer: (pfad: string) => Antwort = () => ({ status: 200 });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      empfangen.push({ pfad: req.url!, headers: req.headers, body });
      const a = antwortFuer(req.url!);
      if (a.haengen) return;
      setTimeout(() => res.writeHead(a.status, a.headers).end(), a.verzoegerung ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  basis = `http://${KEY}@127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  empfangen = [];
  antwortFuer = () => ({ status: 200 });
});

function melder(teil: Partial<Einstellungen> = {}) {
  const m = erstelleMelder({
    modul: "log",
    dsn: { server: `${basis}/1`, browser: `${basis}/2` },
    release: SHA,
    environment: "produktion",
    routen: ROUTEN,
    testmodus: true,
    aus: () => false,
    protokoll: () => {},
    ...teil,
  });
  m.stoppe();
  return m;
}

const zeilen = (body: string) => body.split("\n").map((z) => JSON.parse(z));

describe("Envelope", () => {
  it("hat genau drei Zeilen mit exakt diesen Schlüsseln", async () => {
    const { diagnoseId, fertig } = melder().melde({ route: "/api/klienten/[id]", code: "antwort_5xx", status: 503 });
    expect(await fertig).toBe("gesendet");
    expect(empfangen).toHaveLength(1);
    const { pfad, headers, body } = empfangen[0];
    expect(pfad).toBe("/api/1/envelope/");
    expect(headers["x-sentry-auth"]).toBe(`Sentry sentry_version=7, sentry_key=${KEY}, sentry_client=curivo-fehlermeldung/1.0.0`);
    expect(headers["content-type"]).toBe("application/x-sentry-envelope");
    const [kopf, item, ereignis, ...rest] = zeilen(body);
    expect(rest).toHaveLength(0);
    expect(Object.keys(kopf).sort()).toEqual(["dsn", "event_id", "sent_at"]);
    expect(kopf.event_id).toBe(diagnoseId);
    expect(kopf.dsn).toBe(`${basis}/1`);
    expect(item).toEqual({ type: "event" });
    expect(Object.keys(ereignis).sort()).toEqual(
      ["environment", "event_id", "fingerprint", "level", "message", "platform", "release", "tags", "timestamp"],
    );
    expect(ereignis).toEqual({
      event_id: diagnoseId,
      timestamp: expect.any(Number),
      platform: "other",
      level: "error",
      release: SHA,
      environment: "produktion",
      message: "log antwort_5xx /api/klienten/[id]",
      fingerprint: ["log", "/api/klienten/[id]", "antwort_5xx"],
      tags: { modul: "log", route: "/api/klienten/[id]", code: "antwort_5xx", quelle: "server", status: "503" },
    });
  });
});

describe("Personendaten", () => {
  const vergiftet = (m: ReturnType<typeof melder>, x: string) =>
    m.melde({ route: x, code: x, status: x as never, quelle: x as never }).fertig;

  it("Negativkontrolle: ohne Prüfung findet die Suche jeden Marker in jedem Feld (P8)", async () => {
    const identitaet = { modul: (x: unknown) => x, environment: (x: unknown) => x, release: (x: unknown) => x,
      route: (_: unknown, x: unknown) => x, code: (x: unknown) => x, status: (x: unknown) => x, quelle: () => "server" } as never;
    for (const x of MARKER) await vergiftet(melder({ pruefer: identitaet, modul: x as never, release: x, environment: x }), x);
    MARKER.forEach((x, i) => {
      const e = zeilen(empfangen[i].body)[2];
      for (const wert of [e.release, e.environment, e.tags.modul, e.tags.route, e.tags.code, e.tags.status]) expect(wert).toBe(x);
    });
  });

  it("DSN mit Anhang oder Abfrage wird abgewiesen, nichts davon reist mit", () => {
    expect(leseDsn(`${basis}/1#Diagnose: Diabetes`, true)).toBeNull();
    expect(leseDsn(`${basis}/1?name=Muster`, true)).toBeNull();
  });

  it("ein Objekt als Release kommt nicht durch, auch wenn es sich als SHA ausgibt", async () => {
    const falsch = { toString: () => SHA, toJSON: () => "Diagnose: Diabetes" };
    await melder({ release: falsch as never }).melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig;
    expect(zeilen(empfangen[0].body)[2].release).toBe("unbekannt");
  });

  it("vergiftete Eingaben erreichen Sentry nicht", async () => {
    for (const x of MARKER) {
      const m = melder({ release: x, environment: x });
      await m.melde({ route: `/api/klienten/${x}`, code: x, status: x as never }).fertig;
      await m.melde({ route: x, code: "unbehandelt", quelle: x as never }).fertig;
    }
    expect(empfangen.length).toBe(MARKER.length * 2);
    for (const { body } of empfangen) for (const x of MARKER) expect(body).not.toContain(x);
    const e = zeilen(empfangen[0].body)[2];
    expect(e.tags).toMatchObject({ route: "unbekannt", code: "unbekannt", quelle: "server" });
    expect(e.release).toBe("unbekannt");
    expect(e.environment).toBe("unbekannt");
  });

});

describe("Ziel", () => {
  it("nimmt nur die EU-Region von Sentry, lokal nur im Testmodus", () => {
    expect(leseDsn(`https://${KEY}@o123.ingest.de.sentry.io/45`)?.url).toBe("https://o123.ingest.de.sentry.io/api/45/envelope/");
    expect(leseDsn(`https://${KEY}@o123.ingest.us.sentry.io/45`)).toBeNull();
    expect(leseDsn(`https://${KEY}@o123.ingest.de.sentry.io.boese.ch/45`)).toBeNull();
    expect(leseDsn(`http://${KEY}@o123.ingest.de.sentry.io/45`)).toBeNull();
    expect(leseDsn(`${basis}/1`)).toBeNull();
    expect(leseDsn(`${basis}/1`, true)).not.toBeNull();
    expect(leseDsn("kein dsn")).toBeNull();
    expect(leseDsn(undefined)).toBeNull();
  });

  it("ohne gültiges Ziel und mit Notschalter wird nichts gesendet", async () => {
    expect(await melder({ dsn: {} }).melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig).toBe("verworfen");
    expect(await melder({ aus: () => true }).melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig).toBe("verworfen");
    expect(empfangen).toHaveLength(0);
  });
});

describe("Sender", () => {
  it.each([
    [401, "fehler"],
    [302, "fehler"],
    [500, "fehler"],
  ])("HTTP %i → %s, ohne Weiterleitung zu folgen", async (status, ergebnis) => {
    antwortFuer = (p) => (p.startsWith("/umleitung") ? { status: 200 } : { status, headers: { location: "/umleitung" } });
    expect(await melder().melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig).toBe(ergebnis);
    expect(empfangen.every((x) => !x.pfad.startsWith("/umleitung"))).toBe(true);
  });

  it("Zeitüberschreitung nach 2 s → fehler", async () => {
    antwortFuer = () => ({ status: 200, haengen: true });
    const start = Date.now();
    expect(await melder().melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig).toBe("fehler");
    expect(Date.now() - start).toBeLessThan(3_000);
  });

  it("höchstens 10 offene Sendungen je Key", async () => {
    antwortFuer = () => ({ status: 200, haengen: true });
    const m = melder();
    const codes = ["unbehandelt", "antwort_5xx", "render_fehler", "client_absturz", "start_fehler", "transkription_endgueltig",
      "gemini_ueberlast", "rechnung_erzeugen", "pflegeplanung_speichern", "dokument_speichern"];
    const alle = [...codes.map((code) => m.melde({ route: "/intern/fehlerprobe", code })), m.melde({ route: "/api/klienten/[id]", code: "unbehandelt" })];
    expect(await alle[10].fertig).toBe("verworfen");
    await Promise.all(alle.slice(0, 10).map((x) => x.fertig));
  });

  it("429 am Browser-Key pausiert nur den Browser, Serverfehler kommen durch (R4b, Abnahme e)", async () => {
    antwortFuer = (p) => (p === "/api/2/envelope/" ? { status: 429, headers: { "retry-after": "600" } } : { status: 200 });
    const m = melder();
    expect(await m.melde({ route: "/intern/fehlerprobe", code: "client_absturz", quelle: "browser" }).fertig).toBe("fehler");
    expect(await m.melde({ route: "/api/klienten/[id]", code: "client_absturz", quelle: "browser" }).fertig).toBe("verworfen");
    expect(await m.melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig).toBe("gesendet");
    expect(empfangen.map((x) => x.pfad)).toEqual(["/api/2/envelope/", "/api/1/envelope/"]);
  });

  it("429 mit X-Sentry-Rate-Limits pausiert ebenfalls", async () => {
    antwortFuer = () => ({ status: 429, headers: { "x-sentry-rate-limits": "120:error:key" } });
    let t = 1_000_000;
    const m = melder({ jetzt: () => t });
    await m.melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig;
    t += 119_000;
    expect(await m.melde({ route: "/api/klienten/[id]", code: "unbehandelt" }).fertig).toBe("verworfen");
    t += 2_000;
    await m.melde({ route: "/api/klienten/[id]", code: "antwort_5xx" }).fertig;
    expect(empfangen).toHaveLength(2);
  });
});

describe("Mengen", () => {
  it("100 gleiche Fehler in einer Minute → eine Meldung, dann ein Häufungs-Issue (Abnahme a)", async () => {
    let t = Date.UTC(2026, 10, 2, 14, 10);
    const m = melder({ jetzt: () => t });
    for (let i = 0; i < 100; i++, t += 500) m.melde({ route: "/api/klienten/[id]", code: "unbehandelt" });
    await Promise.all(m.fasseZusammen());
    expect(empfangen).toHaveLength(2);
    const h = zeilen(empfangen[1].body)[2];
    expect(h.fingerprint).toEqual(["log", "/api/klienten/[id]", "unbehandelt", "haeufung", "2026-11-02T14"]);
    expect(h.tags.wiederholt).toBe("10-99");
    expect(h.message).toBe("log unbehandelt /api/klienten/[id] haeufung 2026-11-02T14");
    await Promise.all(m.fasseZusammen());
    expect(empfangen).toHaveLength(2);
  });

  it("wenige Wiederholungen bleiben im gewöhnlichen Issue", async () => {
    let t = 0;
    const m = melder({ jetzt: () => t });
    for (let i = 0; i < 4; i++, t += 1_000) m.melde({ route: "/api/klienten/[id]", code: "unbehandelt" });
    await Promise.all(m.fasseZusammen());
    const z = zeilen(empfangen[1].body)[2];
    expect(z.fingerprint).toEqual(["log", "/api/klienten/[id]", "unbehandelt"]);
    expect(z.tags.wiederholt).toBe("1-9");
  });

  it("Stundenkörbe nach Vorkommenszeit (R4c, Abnahme b)", async () => {
    let t = Date.UTC(2026, 10, 2, 10, 59, 30);
    const m = melder({ jetzt: () => t });
    for (let i = 0; i < 30; i++, t += 1_000) m.melde({ route: "/api/klienten/[id]", code: "unbehandelt" });
    t = Date.UTC(2026, 10, 2, 11, 0, 0);
    for (let i = 0; i < 30; i++, t += 1_000) m.melde({ route: "/api/klienten/[id]", code: "unbehandelt" });
    t = Date.UTC(2026, 10, 2, 11, 0, 45);
    await Promise.all(m.fasseZusammen());
    const stunden = empfangen.slice(1).map((x) => zeilen(x.body)[2].fingerprint[4]).sort();
    expect(stunden).toEqual(["2026-11-02T10", "2026-11-02T11"]);
  });

  it("Browser belegt höchstens 10 von 30 Meldungen je Minute", async () => {
    const t = 5_000_000;
    const m = melder({ jetzt: () => t, routen: Array.from({ length: 40 }, (_, i) => `/r${i}`) });
    const b: string[] = [];
    const s: string[] = [];
    for (let i = 0; i < 15; i++) b.push(await m.melde({ route: `/r${i}`, code: "client_absturz", quelle: "browser" }).fertig);
    for (let i = 0; i < 25; i++) s.push(await m.melde({ route: `/r${i}`, code: "unbehandelt" }).fertig);
    expect(b.filter((x) => x === "gesendet")).toHaveLength(10);
    expect(s.filter((x) => x === "gesendet")).toHaveLength(20);
  });

  it("spuele fasst zusammen und wartet auf offene Sendungen", async () => {
    let t = 0;
    const m = melder({ jetzt: () => t });
    m.melde({ route: "/intern/fehlerprobe", code: "start_fehler" });
    t += 10;
    m.melde({ route: "/intern/fehlerprobe", code: "start_fehler" });
    await m.spuele(2_000);
    expect(empfangen).toHaveLength(2);
  });
});

describe("Wirft nie", () => {
  it("kaputtes Log, kaputter Transport und giftige Meldung reissen die App nicht mit", async () => {
    const abgelehnt: unknown[] = [];
    const merke = (g: unknown) => abgelehnt.push(g);
    process.on("unhandledRejection", merke);
    try {
      const m = melder({
        protokoll: () => { throw new Error("log kaputt"); },
        fetch: (() => { throw new Error("synchron kaputt"); }) as never,
      });
      expect(await m.melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig).toBe("fehler");
      const gift = { get route(): string { throw new Error("getter"); }, code: "unbehandelt" };
      expect(await m.melde(gift).fertig).toBe("fehler");
      expect(await melder({ protokoll: () => { throw new Error("log kaputt"); } }).melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig).toBe("gesendet");
      await new Promise((r) => setTimeout(r, 20));
      expect(abgelehnt).toEqual([]);
    } finally {
      process.off("unhandledRejection", merke);
    }
  });
});

describe("Zusammenfassungen", () => {
  it("zählen ins Minutenbudget; was keinen Platz hat, bleibt im Korb", async () => {
    let t = 7_200_000;
    const m = melder({ jetzt: () => t, routen: Array.from({ length: 40 }, (_, i) => `/r${i}`) });
    for (let i = 0; i < 30; i++) await m.melde({ route: `/r${i}`, code: "unbehandelt" }).fertig;
    for (let i = 0; i < 5; i++) m.melde({ route: `/r${i}`, code: "unbehandelt" });
    expect(m.fasseZusammen()).toHaveLength(0);
    expect(empfangen).toHaveLength(30);
    t += 60_000;
    await Promise.all(m.fasseZusammen());
    expect(empfangen).toHaveLength(35);
  });

  it("nicht zugestellte Zusammenfassung geht zurück in den Korb", async () => {
    let t = 7_200_000;
    let status = 500;
    antwortFuer = () => ({ status });
    const m = melder({ jetzt: () => t });
    for (let i = 0; i < 12; i++, t += 100) m.melde({ route: "/api/klienten/[id]", code: "unbehandelt" });
    expect(await Promise.all(m.fasseZusammen())).toEqual(["fehler"]);
    status = 200;
    t += 60_000;
    await Promise.all(m.fasseZusammen());
    const z = zeilen(empfangen.at(-1)!.body)[2];
    expect(z.fingerprint[3]).toBe("haeufung");
    expect(z.tags.wiederholt).toBe("10-99");
  });

  it("gestrige Häufung wird heute nicht gemeldet (Abnahme d)", async () => {
    let t = Date.UTC(2026, 10, 1, 14);
    const m = melder({ jetzt: () => t });
    for (let i = 0; i < 20; i++, t += 100) m.melde({ route: "/api/klienten/[id]", code: "unbehandelt" });
    await new Promise((r) => setTimeout(r, 20));
    t = Date.UTC(2026, 10, 2, 9);
    expect(m.fasseZusammen()).toHaveLength(0);
    expect(empfangen).toHaveLength(1);
  });

  it("der Takt stellt nach einer Minute Ruhe von selbst zu", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    try {
      let t = 0;
      const m = erstelleMelder({ modul: "log", dsn: { server: `${basis}/1` }, release: SHA, environment: "produktion",
        routen: ROUTEN, testmodus: true, aus: () => false, protokoll: () => {}, jetzt: () => t });
      for (let i = 0; i < 3; i++, t += 100) m.melde({ route: "/api/klienten/[id]", code: "unbehandelt" });
      t += 60_000;
      vi.advanceTimersByTime(60_000);
      await new Promise((r) => setTimeout(r, 200));
      m.stoppe();
      expect(empfangen).toHaveLength(2);
      expect(zeilen(empfangen[1].body)[2].tags.wiederholt).toBe("1-9");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Pause", () => {
  it("X-Sentry-Rate-Limits gilt auch bei 200, nur für Ereignis-Kategorien, und verlängert nur", () => {
    const a = (h: Record<string, string>, s = 200) => new Response(null, { status: s, headers: h });
    expect(pauseMs(a({ "x-sentry-rate-limits": "30:transaction:key, 90:error;default:org" }), 0)).toBe(90_000);
    expect(pauseMs(a({ "x-sentry-rate-limits": "30:transaction:key" }), 0)).toBe(0);
    expect(pauseMs(a({ "x-sentry-rate-limits": "45::org" }), 0)).toBe(45_000);
    expect(pauseMs(a({ "retry-after": new Date(120_000).toUTCString() }, 429), 0)).toBe(120_000);
    expect(pauseMs(a({}, 429), 0)).toBe(60_000);
    expect(pauseMs(a({}, 200), 0)).toBe(0);
  });
});

describe("Nachträge Gegenprobe", () => {
  it("die DSN im Envelope ist die neu gebaute, nicht der übergebene Text", async () => {
    await melder({ dsn: { server: `  ${basis.replace("http:", "HTTP:")}/1  ` } }).melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig;
    expect(zeilen(empfangen[0].body)[0].dsn).toBe(`${basis}/1`);
  });

  it("eine spätere Antwort ohne Grenze verkürzt eine laufende Pause nicht", async () => {
    antwortFuer = () => (empfangen.length === 1 ? { status: 429, headers: { "retry-after": "600" } } : { status: 200, verzoegerung: 50 });
    const m = melder();
    const a = m.melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig;
    const b = m.melde({ route: "/api/klienten/[id]", code: "unbehandelt" }).fertig;
    expect((await Promise.all([a, b])).sort()).toEqual(["fehler", "gesendet"]);
    expect(await m.melde({ route: "/intern/fehlerprobe", code: "antwort_5xx" }).fertig).toBe("verworfen");
  });

  it("auch eine werfende Uhr im Antwortpfad lässt fertig nicht ablehnen", async () => {
    let aufrufe = 0;
    const m = melder({ jetzt: () => { if (++aufrufe > 4) throw new Error("uhr"); return 0; } });
    expect(await m.melde({ route: "/intern/fehlerprobe", code: "unbehandelt" }).fertig).toBe("fehler");
  });
});
