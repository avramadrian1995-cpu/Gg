'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  cui        TEXT,
  phone      TEXT,
  email      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'fleet')),
  company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  id               INTEGER PRIMARY KEY,
  plate            TEXT NOT NULL UNIQUE,
  model            TEXT NOT NULL DEFAULT '',
  year             INTEGER,
  category         TEXT NOT NULL DEFAULT 'M1',
  fuel             TEXT NOT NULL DEFAULT 'benzina',
  usage            TEXT NOT NULL DEFAULT 'personal',
  owner_name       TEXT NOT NULL DEFAULT '',
  phone            TEXT NOT NULL DEFAULT '',
  email            TEXT NOT NULL DEFAULT '',
  company_id       INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  itp_expiry       TEXT,
  rca_expiry       TEXT,
  vignette_expiry  TEXT,
  reminder_consent INTEGER NOT NULL DEFAULT 0,
  notes            TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id          INTEGER PRIMARY KEY,
  ref         TEXT NOT NULL UNIQUE,
  cancel_code TEXT NOT NULL,
  vehicle_id  INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  time        TEXT NOT NULL,
  service     TEXT NOT NULL DEFAULT 'itp',
  status      TEXT NOT NULL DEFAULT 'confirmed'
              CHECK (status IN ('confirmed', 'done', 'no_show', 'cancelled')),
  source      TEXT NOT NULL DEFAULT 'online',
  contact_name  TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date, time);

CREATE TABLE IF NOT EXISTS inspections (
  id          INTEGER PRIMARY KEY,
  vehicle_id  INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  booking_id  INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  date        TEXT NOT NULL,
  result      TEXT NOT NULL CHECK (result IN ('admis', 'respins')),
  valid_until TEXT,
  price       REAL,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AUTOINCREMENT: ids are never reused, because photo URLs (/api/photos/<id>)
-- are cached by browsers and a reused id would show a deleted picture.
CREATE TABLE IF NOT EXISTS photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  vehicle_id    INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  file          TEXT NOT NULL UNIQUE,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS photos_inspection ON photos(inspection_id);

-- Customer login by SMS code (no password).
CREATE TABLE IF NOT EXISTS login_codes (
  phone      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_sessions (
  token      TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('sms', 'email')),
  recipient  TEXT NOT NULL,
  subject    TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT
);
`;

const DEFAULT_SETTINGS = {
  station: {
    name: 'MISEDA INSPECT S.R.L.',
    rarCode: 'SV096',
    address: 'Str. Izvoarelor Nr. 2C, Rădăuți, jud. Suceava',
    phone: '0756 596 565',
    email: '',
    website: 'https://misedainspectsrl.ro',
    privacyUrl: 'https://misedainspectsrl.ro/confidentialitate',
    mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Str.+Izvoarelor+2C+R%C4%83d%C4%83u%C8%9Bi',
    reviewUrl: '',
  },
  // 0 = Sunday … 6 = Saturday; null = closed
  hours: {
    0: null,
    1: ['09:00', '18:00'],
    2: ['09:00', '18:00'],
    3: ['09:00', '18:00'],
    4: ['09:00', '18:00'],
    5: ['09:00', '18:00'],
    6: ['09:00', '13:00'],
  },
  slotMinutes: 30,
  lanes: 1,
  bookingDaysAhead: 30,
  closedDates: [],
  // Example prices — the station sets real ones in the admin dashboard.
  services: [
    { id: 'itp-benzina', name: 'ITP autoturism benzină / GPL', price: 150 },
    { id: 'itp-diesel', name: 'ITP autoturism diesel', price: 180 },
    { id: 'itp-n1', name: 'ITP utilitară ușoară (N1, sub 3,5 t)', price: 200 },
    { id: 'itp-taxi', name: 'ITP taxi / ride-sharing', price: 180 },
  ],
  reminderDays: [30, 7, 1],
  reviewRequest: true,
};

function dataDir() {
  return process.env.DATA_DIR || path.join(__dirname, '..', 'data');
}

function openDb(file = process.env.DB_FILE || path.join(dataDir(), 'miseda.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, JSON.stringify(value));
  return db;
}

function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = JSON.parse(row.value);
  return { ...DEFAULT_SETTINGS, ...out };
}

function saveSettings(db, patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    stmt.run(key, JSON.stringify(value));
  }
  return getSettings(db);
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, getSettings, saveSettings, tx, dataDir, DEFAULT_SETTINGS };
