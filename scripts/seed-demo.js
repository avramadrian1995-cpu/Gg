'use strict';

// Fills a database with example data for trying the app. Never run it on the
// production database: it refuses if the database already has vehicles.
//   DB_FILE=data/demo.db node scripts/seed-demo.js

const { openDb, tx } = require('../src/db');
const auth = require('../src/auth');
const itp = require('../src/itp');
const { createBooking } = require('../src/server');

const db = openDb();
if (db.prepare('SELECT COUNT(*) n FROM vehicles').get().n) {
  console.error('Baza de date are deja vehicule. Scriptul demo rulează doar pe o bază goală.');
  process.exit(1);
}

const today = itp.nowLocal().date;
const pw = 'demo-parola-123';

tx(db, () => {
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
    db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('admin@demo.ro', 'Admin demo', ?, 'admin')")
      .run(auth.hashPassword(pw));
  }
  const c = db.prepare("INSERT INTO companies (name, cui, phone, email) VALUES ('Transport Demo SRL', 'RO00000000', '0740000000', 'flota@demo.ro')").run();
  db.prepare("INSERT INTO users (email, name, password_hash, role, company_id) VALUES ('flota@demo.ro', 'Dispecer demo', ?, 'fleet', ?)")
    .run(auth.hashPassword(pw), c.lastInsertRowid);

  const add = db.prepare(`INSERT INTO vehicles (plate, model, year, category, fuel, usage, owner_name, phone, company_id, itp_expiry, reminder_consent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const fleet = [
    ['SV 10 TDM', 'Ford Transit', 2019, 'N1', 'diesel', -4],
    ['SV 11 TDM', 'Renault Master', 2018, 'N1', 'diesel', 12],
    ['SV 12 TDM', 'Dacia Logan', 2021, 'M1', 'benzina', 26],
    ['SV 14 TDM', 'Skoda Octavia', 2020, 'M1', 'diesel', 95],
    ['SV 15 TDM', 'VW Crafter', 2017, 'N1', 'diesel', 140],
  ];
  for (const [p, m, y, cat, f, d] of fleet) add.run(p, m, y, cat, f, 'firma', '', '', c.lastInsertRowid, itp.addDays(today, d));

  const people = [
    ['SV 21 ABC', 'Dacia Sandero', 2015, 'Ion Popescu', '0745000101', 8],
    ['SV 33 MIS', 'VW Golf', 2011, 'Maria Ionescu', '0745000102', 29],
    ['SV 45 RDT', 'Opel Astra', 2009, 'Vasile Rusu', '0745000103', 3],
    ['SV 07 XYZ', 'Toyota Corolla', 2022, 'Elena Moraru', '0745000104', 400],
  ];
  for (const [p, m, y, n, ph, d] of people) add.run(p, m, y, 'M1', 'benzina', 'personal', n, ph, null, itp.addDays(today, d));
});

// Bookings for the next working day, through the normal booking path.
let day = today;
for (let i = 0; i < 7; i++) {
  day = itp.addDays(day, 1);
  if (itp.weekday(day) >= 1 && itp.weekday(day) <= 5) break;
}
const now = { date: today, time: '00:00' };
const bookings = [
  ['SV 21 ABC', 'Ion Popescu', '0745000101', '09:00', 'itp-benzina'],
  ['SV 33 MIS', 'Maria Ionescu', '0745000102', '09:30', 'itp-benzina'],
  ['SV 88 TAX', 'Andrei Taxi', '0745000105', '10:30', 'itp-taxi'],
  ['SV 45 RDT', 'Vasile Rusu', '0745000103', '12:00', 'itp-benzina'],
];
for (const [plate, name, phone, time, service] of bookings) {
  createBooking(db, { plate, name, phone, date: day, time, service, usage: service === 'itp-taxi' ? 'taxi' : 'personal', consent: true }, { now });
}
const fleetIds = db.prepare("SELECT id FROM vehicles WHERE plate IN ('SV 10 TDM', 'SV 11 TDM')").all();
for (const [i, { id }] of fleetIds.entries()) {
  const v = db.prepare('SELECT plate FROM vehicles WHERE id = ?').get(id);
  createBooking(db, { plate: v.plate, date: day, time: ['14:00', '14:30'][i], service: 'itp-n1', name: 'Transport Demo SRL', email: 'flota@demo.ro' },
    { source: 'fleet', companyId: db.prepare('SELECT company_id FROM vehicles WHERE id = ?').get(id).company_id, now });
}

// A few past inspections.
const insp = db.prepare('INSERT INTO inspections (vehicle_id, date, result, valid_until, price) VALUES (?, ?, ?, ?, ?)');
for (const [plate, back, result, price] of [['SV 07 XYZ', 35, 'admis', 150], ['SV 14 TDM', 635, 'admis', 180], ['SV 15 TDM', 225, 'admis', 200]]) {
  const v = db.prepare('SELECT id, itp_expiry FROM vehicles WHERE plate = ?').get(plate);
  insp.run(v.id, itp.addDays(today, -back), result, v.itp_expiry, price);
}

console.log(`Date demo create. Programări pe ${day}.\n  Admin: admin@demo.ro / ${pw}\n  Flotă: flota@demo.ro / ${pw}`);
