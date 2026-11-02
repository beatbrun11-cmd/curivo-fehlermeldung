import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { erstelleMelder, leseDsn, type Einstellungen } from "../index";

const KEY = "0123456789abcdef0123456789abcdef";
const SHA = "a1b2c3d";
const ROUTEN = ["/api/klienten/[id]", "/intern/fehlerprobe"];
/** Was in keinem Fall bei Sentry ankommen darf. */
const MARKER = ["Muster Anna", "756.1234.5678.97", "anna@example.ch", "?klient=42", "Diagnose: Diabetes"];

type Antwort = { status: number; headers?: Record<string, string>; haengen?: boolean };
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
      res.writeHead(a.status, a.headers).end();
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
    expect(headers["x-sentry-auth"]).toContain(`sentry_key=${KEY}`);
    expect(headers["content-type"]).toBe("application/x-sentry-envelope");
    const [kopf, item, ereignis, ...rest] = zeilen(body);
    expect(rest).toHaveLength(0);
    expect(Object.keys(kopf).sort()).toEqual(["dsn", "event_id", "sent_at"]);
    expect(item).toEqual({ type: "event" });
    expect(Object.keys(ereignis).sort()).toEqual(
      ["environment", "event_id", "fingerprint", "level", "message", "platform", "release", "tags", "timestamp"],
    );
    expect(ereignis).toMatchObject({
      event_id: diagnoseId,
      release: SHA,
      environment: "produktion",
      message: "log antwort_5xx /api/klienten/[id]",
      fingerprint: ["log", "/api/klienten/[id]", "antwort_5xx"],
      tags: { modul: "log", route: "/api/klienten/[id]", code: "antwort_5xx", quelle: "server", status: "503" },
    });
  });
});

describe("Personendaten", () => {
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

  it("Positivkontrolle: steht der Marker in der vertrauten Routenliste, findet die Suche ihn", async () => {
    for (const x of MARKER) await melder({ routen: [x] }).melde({ route: x, code: "unbehandelt" }).fertig;
    MARKER.forEach((x, i) => expect(empfangen[i].body).toContain(JSON.stringify(x).slice(1, -1)));
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
