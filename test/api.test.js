'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/server');
const auth = require('../src/auth');
const itp = require('../src/itp');
const notify = require('../src/notify');

async function setup() {
  const db = openDb(':memory:');
  const sent = [];
  const app = createApp(db, { send: async (m) => sent.push(m), log: () => {} });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (path, { method = 'GET', body } = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    };
  };
  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('admin@test.ro', 'A', ?, 'admin')")
    .run(auth.hashPassword('admin-password'));
  return { db, sent, client, close: () => server.close() };
}

async function firstFreeSlot(call) {
  const { data } = await call('/api/public/days');
  const day = data.days.find((d) => d.free > 1);
  const slots = (await call(`/api/public/slots?date=${day.date}`)).data.slots;
  return { date: day.date, time: slots[0], slots };
}

test('date helpers', () => {
  assert.equal(itp.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(itp.addMonths('2025-08-31', 6), '2026-02-28');
  assert.equal(itp.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(itp.isDate('2026-02-30'), false);
  assert.equal(itp.normalizePlate(' sv-12 abc '), 'SV 12 ABC');
  assert.equal(itp.normalizePlate('b123abc'), 'B 123 ABC');
  assert.equal(itp.normalizePhone('+40 745 123 456'), '0745123456');
  assert.equal(itp.suggestedValidityMonths({ category: 'M1', year: 2024 }, '2026-05-01'), 36);
  assert.equal(itp.suggestedValidityMonths({ category: 'M1', year: 2016 }, '2026-05-01'), 24);
  assert.equal(itp.suggestedValidityMonths({ category: 'M1', year: 2010 }, '2026-05-01'), 12);
  assert.equal(itp.suggestedValidityMonths({ category: 'M1', usage: 'taxi', year: 2024 }, '2026-05-01'), 6);
});

test('slots follow opening hours and skip closed days', () => {
  const db = openDb(':memory:');
  const s = require('../src/db').getSettings(db);
  const now = { date: '2026-09-21', time: '08:00' }; // Monday
  assert.equal(itp.freeSlots(db, s, '2026-09-21', now).length, 18); // 09:00–18:00, 30 min
  assert.equal(itp.freeSlots(db, s, '2026-09-26', now).length, 8); // Saturday 09–13
  assert.equal(itp.freeSlots(db, s, '2026-09-27', now).length, 0); // Sunday
  assert.deepEqual(itp.freeSlots(db, s, '2026-09-21', { date: '2026-09-21', time: '17:10' }), ['17:30']);
  assert.equal(itp.freeSlots(db, s, '2026-09-20', now).length, 0); // past
});

test('public booking: validation, double booking, confirmation, cancel', async (t) => {
  const { client, sent, db, close } = await setup();
  t.after(close);
  const call = client();
  const { date, time, slots } = await firstFreeSlot(call);

  let r = await call('/api/public/bookings', { method: 'POST', body: { plate: 'SV12ABC', name: 'Ion', phone: '123', date, time } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /mobil/);

  r = await call('/api/public/bookings', {
    method: 'POST', body: { plate: 'sv 12 abc', name: 'Ion Pop', phone: '0745 123 456', date, time, consent: true, year: 2015 },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.plate, 'SV 12 ABC');
  const booking = r.data;

  // Same slot again (1 lane) → conflict.
  r = await call('/api/public/bookings', { method: 'POST', body: { plate: 'SV 99 XYZ', name: 'Ana', phone: '0745000111', date, time } });
  assert.equal(r.status, 409);

  // Same vehicle again → conflict.
  r = await call('/api/public/bookings', { method: 'POST', body: { plate: 'SV12ABC', name: 'Ion', phone: '0745123456', date, time: slots[1] } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /are deja o programare/);

  // Slot no longer offered.
  r = await call(`/api/public/slots?date=${date}`);
  assert.ok(!r.data.slots.includes(time));

  // Confirmation SMS queued and sent by flush.
  await notify.flushOutbox(db, async (m) => sent.push(m));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].recipient, '0745123456');
  assert.match(sent[0].body, /SV 12 ABC/);

  // Wrong code can't read or cancel.
  r = await call(`/api/public/bookings/${booking.ref}?code=wrong`);
  assert.equal(r.status, 404);
  r = await call(`/api/public/bookings/${booking.ref}/cancel`, { method: 'POST', body: { code: booking.cancelCode } });
  assert.equal(r.status, 200);
  r = await call(`/api/public/slots?date=${date}`);
  assert.ok(r.data.slots.includes(time));
});

test('non-JSON writes are rejected (CSRF guard)', async (t) => {
  const { close, client } = await setup();
  t.after(close);
  const call = client();
  const { status } = await call('/api/auth/logout', { method: 'POST' });
  assert.equal(status, 415);
});

test('admin: auth required, complete inspection updates ITP and reminders fire', async (t) => {
  const { client, db, close } = await setup();
  t.after(close);
  const anon = client();
  assert.equal((await anon('/api/admin/stats')).status, 401);

  const call = client();
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'admin@test.ro', password: 'nope' } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'ADMIN@test.ro', password: 'admin-password' } })).status, 200);

  const { date, time } = await firstFreeSlot(call);
  let r = await call('/api/admin/bookings', { method: 'POST', body: { plate: 'SV 01 AAA', name: 'Maria', phone: '0740000001', date, time, consent: true, year: 2012 } });
  assert.equal(r.status, 201);

  r = await call(`/api/admin/bookings?from=${date}&to=${date}`);
  const b = r.data.bookings.find((x) => x.plate === 'SV 01 AAA');
  assert.equal(b.suggestedMonths, 12);

  r = await call(`/api/admin/bookings/${b.id}/complete`, { method: 'POST', body: { result: 'admis', validUntil: '2027-10-01', price: 150 } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT itp_expiry FROM vehicles WHERE plate = 'SV 01 AAA'").get().itp_expiry, '2027-10-01');
  assert.equal((await call(`/api/admin/bookings/${b.id}/complete`, { method: 'POST', body: { result: 'admis', validUntil: '2027-10-01' } })).status, 409);

  // Reminder 30 days before expiry, sent once.
  const now = { date: itp.addDays('2027-10-01', -30), time: '10:00' };
  assert.equal(notify.scheduleReminders(db, { now }), 1);
  assert.equal(notify.scheduleReminders(db, { now }), 0);
  const msg = db.prepare("SELECT * FROM outbox WHERE kind = 'itp_expiring'").get();
  assert.match(msg.body, /expira pe 01\.10\.2027/);
  assert.ok(msg.body.length <= 160);

  // No reminder without consent.
  db.prepare("UPDATE vehicles SET reminder_consent = 0, itp_expiry = ? WHERE plate = 'SV 01 AAA'").run(itp.addDays(now.date, 7));
  assert.equal(notify.scheduleReminders(db, { now }), 0);

  r = await call('/api/admin/vehicles.csv');
  assert.match(r.data, /SV 01 AAA/);
});

test('fleet: isolation between companies and bulk booking', async (t) => {
  const { client, close } = await setup();
  t.after(close);
  const admin = client();
  await admin('/api/auth/login', { method: 'POST', body: { email: 'admin@test.ro', password: 'admin-password' } });
  for (const [name, email] of [['Firma A', 'a@firma.ro'], ['Firma B', 'b@firma.ro']]) {
    const r = await admin('/api/admin/companies', { method: 'POST', body: { name, userEmail: email, userPassword: 'fleet-password' } });
    assert.equal(r.status, 201);
  }

  const a = client();
  await a('/api/auth/login', { method: 'POST', body: { email: 'a@firma.ro', password: 'fleet-password' } });
  assert.equal((await a('/api/admin/stats')).status, 403);
  for (const p of ['SV 10 AAA', 'SV 11 AAA', 'SV 12 AAA']) {
    assert.equal((await a('/api/fleet/vehicles', { method: 'POST', body: { plate: p, category: 'N1', itpExpiry: '2026-10-10' } })).status, 201);
  }

  const b = client();
  await b('/api/auth/login', { method: 'POST', body: { email: 'b@firma.ro', password: 'fleet-password' } });
  assert.equal((await b('/api/fleet/vehicles', { method: 'POST', body: { plate: 'SV 10 AAA' } })).status, 409);
  const bView = await b('/api/fleet/overview');
  assert.equal(bView.data.vehicles.length, 0);

  const aView = await a('/api/fleet/overview');
  const ids = aView.data.vehicles.map((v) => v.id);
  assert.equal((await b('/api/fleet/bookings', { method: 'POST', body: { vehicleIds: ids, date: '2099-01-01' } })).status, 409);

  const { date } = await firstFreeSlot(a);
  const r = await a('/api/fleet/bookings', { method: 'POST', body: { vehicleIds: ids, date } });
  assert.equal(r.status, 201);
  assert.equal(r.data.created.length, 3);
  assert.equal(new Set(r.data.created.map((c) => c.time)).size, 3);
});
