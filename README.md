# @curivo/fehlermeldung

Meldet Fehler aus Voice-API, Voice-Web, Log und Bill an Sentry (Region EU), ohne Personendaten.

- Gesendet werden nur Modul, Routenschablone, Fehlercode, HTTP-Status, Release und Umgebung, alle aus geschlossenen Listen. Was nicht in der Liste steht, wird `unbekannt`.
- Stack und Meldungstext loggt der Aufrufer in Azure, mit der zurückgegebenen `diagnoseId`.
- Kein Sentry-SDK, keine Browser-Verbindung zu Sentry: Browser melden an die eigene App, die über den Browser-Key weitermeldet.
- Grenzen: 1 Meldung je Route und Code pro Minute (Wiederholungen werden gezählt und zusammengefasst, ab 10 als eigenes Häufungs-Issue je Stunde), 30 pro Minute je Prozess, davon höchstens 10 aus dem Browser, 10 offene Sendungen je Key, 429 pausiert den betroffenen Key.
- Notschalter: `FEHLERMELDUNG_AUS=1`.

```ts
import { erstelleMelder } from "@curivo/fehlermeldung";
const melder = erstelleMelder({ modul: "log", dsn: { server, browser }, release, environment: "produktion", routen });
const { diagnoseId } = melder.melde({ route: "/api/klienten/[id]", code: "antwort_5xx", status: 503 });
```

Plan: `curivo-waechter/docs/ap2/PLAN_ap2-fehlermeldung_2026-11-02.md`.
