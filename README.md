# ITP Tracker

A small web app for tracking Romanian vehicle document expiry dates: **ITP**
(Inspecția Tehnică Periodică), **RCA**, **rovinietă** and **CASCO**.

## Features

- Add, edit and delete vehicles (plate, make/model, year, notes).
- ITP expiry is calculated from the last inspection date and validity period
  (1, 2 or 3 years). The period is suggested from the car's year of
  manufacture; you can always override it.
- Colour-coded status per document: valid, expiring soon (configurable
  warning window: 7/14/30/60 days) or expired. Vehicles are sorted by the
  soonest expiry.
- "Adaugă în calendar" downloads an `.ics` file with an all-day event and
  reminder for each expiry date, which you can import into Google Calendar,
  Apple Calendar or Outlook.
- JSON export/import for backups or moving to another device.
- Works offline; data is stored only in the browser (`localStorage`).
- Romanian UI, light/dark theme, mobile-friendly.

## Running

No build step. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

To host it, push the folder to any static host (e.g. GitHub Pages).

> ITP intervals suggested by the app are for passenger cars under 3.5 t and
> are only a guide. Always check the date on your ITP certificate.
