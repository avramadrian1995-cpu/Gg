'use strict';

const path = require('node:path');
const express = require('express');
const { openDb, getSettings, saveSettings, tx } = require('./db');
const photos = require('./photos');
const clientAuth = require('./client-auth');
const auth = require('./auth');
const itp = require('./itp');
const notify = require('./notify');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// Wraps a handler so thrown errors (sync or async) reach the error middleware.
const h = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return next();
    }
    if (++entry.count > max) return res.status(429).json({ error: 'Prea multe cereri. Încercați din nou în câteva minute.' });
    return next();
  };
}

function str(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

// ---------- bookings ----------

function upsertVehicle(db, data, { companyId = null, overwriteContact = true } = {}) {
  const existing = db.prepare('SELECT * FROM vehicles WHERE plate = ?').get(data.plate);
  if (!existing) {
    const r = db.prepare(`
      INSERT INTO vehicles (plate, model, year, category, fuel, usage, owner_name, phone, email, company_id,
                            itp_expiry, reminder_consent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(data.plate, data.model || '', data.year || null, data.category || 'M1', data.fuel || 'benzina',
      data.usage || 'personal', data.name || '', data.phone || '', data.email || '', companyId,
      data.itpExpiry || null, data.consent ? 1 : 0);
    return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(r.lastInsertRowid);
  }
  if (overwriteContact && !existing.company_id) {
    db.prepare(`
      UPDATE vehicles SET owner_name = COALESCE(NULLIF(?, ''), owner_name), phone = COALESCE(NULLIF(?, ''), phone),
        email = COALESCE(NULLIF(?, ''), email), model = COALESCE(NULLIF(?, ''), model), year = COALESCE(?, year),
        category = ?, fuel = ?, usage = ?, reminder_consent = MAX(reminder_consent, ?)
      WHERE id = ?
    `).run(data.name || '', data.phone || '', data.email || '', data.model || '', data.year || null,
      data.category || existing.category, data.fuel || existing.fuel, data.usage || existing.usage,
      data.consent ? 1 : 0, existing.id);
  }
  return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(existing.id);
}

function serviceFor(settings, id) {
  return settings.services.find((s) => s.id === id) || settings.services[0];
}

function createBooking(db, input, { source = 'online', companyId = null, now = itp.nowLocal() } = {}) {
  const settings = getSettings(db);
  if (!itp.isDate(input.date)) fail(400, 'Alegeți o dată validă.');
  if (!/^\d{2}:\d{2}$/.test(input.time || '')) fail(400, 'Alegeți o oră validă.');

  return tx(db, () => {
    if (!itp.freeSlots(db, settings, input.date, now).includes(input.time)) {
      fail(409, 'Intervalul ales nu mai este liber. Alegeți altă oră.');
    }
    const vehicle = upsertVehicle(db, input, { companyId, overwriteContact: source !== 'fleet' });
    if (companyId && vehicle.company_id !== companyId) fail(403, 'Vehiculul nu aparține firmei dvs.');
    const clash = db.prepare(
      "SELECT date, time FROM bookings WHERE vehicle_id = ? AND status = 'confirmed' AND date >= ?",
    ).get(vehicle.id, now.date);
    if (clash) fail(409, `${vehicle.plate} are deja o programare pe ${clash.date} la ${clash.time}.`);

    const ref = auth.randomToken(5).replace(/[-_]/g, 'X').slice(0, 6).toUpperCase();
    const cancelCode = auth.randomToken(12);
    const service = serviceFor(settings, input.service);
    const r = db.prepare(`
      INSERT INTO bookings (ref, cancel_code, vehicle_id, date, time, service, source, contact_name, contact_phone, contact_email, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ref, cancelCode, vehicle.id, input.date, input.time, service.id, source,
      input.name || vehicle.owner_name, input.phone || vehicle.phone, input.email || vehicle.email, input.notes || '');
    const booking = { id: Number(r.lastInsertRowid), ref, cancelCode, date: input.date, time: input.time, plate: vehicle.plate, service };
    notify.queue(db, {
      dedupeKey: `confirm:${booking.id}`, vehicleId: vehicle.id, phone: input.phone || vehicle.phone,
      email: input.email || vehicle.email, kind: 'booking_confirmed', ...notify.templates.bookingConfirmed(settings, booking),
    });
    return booking;
  });
}

function parseVehicleInput(body, { requireContact = false } = {}) {
  const plate = itp.normalizePlate(body.plate);
  if (!itp.isPlausiblePlate(plate)) fail(400, 'Introduceți un număr de înmatriculare valid, de ex. SV 12 ABC.');
  const phone = itp.normalizePhone(body.phone);
  const email = str(body.email, 120).toLowerCase();
  if (requireContact && !itp.isMobile(phone)) fail(400, 'Introduceți un număr de mobil valid, de ex. 0745 123 456.');
  if (email && !itp.isEmail(email)) fail(400, 'Adresa de e-mail nu pare validă.');
  const year = body.year ? Number(body.year) : null;
  if (year && (year < 1950 || year > 2100)) fail(400, 'Anul fabricației nu este valid.');
  const itpExpiry = body.itpExpiry || null;
  if (itpExpiry && !itp.isDate(itpExpiry)) fail(400, 'Data expirării ITP nu este validă.');
  return {
    plate,
    phone,
    email,
    year,
    itpExpiry,
    name: str(body.name, 100),
    model: str(body.model, 60),
    category: ['M1', 'N1'].includes(body.category) ? body.category : 'M1',
    fuel: ['benzina', 'diesel', 'gpl', 'hibrid', 'electric'].includes(body.fuel) ? body.fuel : 'benzina',
    usage: ['personal', 'taxi', 'firma'].includes(body.usage) ? body.usage : 'personal',
    consent: body.consent === true,
    notes: str(body.notes, 300),
    service: str(body.service, 40),
  };
}

function vehicleStatus(v, today) {
  if (!v.itp_expiry) return { itpDays: null };
  return { itpDays: itp.daysBetween(today, v.itp_expiry) };
}

// ---------- app ----------

function createApp(db, { send = notify.providerFromEnv(), log = console.log } = {}) {
  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY === '1');
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  // CSRF defence: state-changing API calls must be JSON (forms can't send it cross-site
  // without a CORS preflight), and session cookies are SameSite=Lax.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && !req.is('application/json') && !req.is('image/*')) {
      return res.status(415).json({ error: 'Cererea trebuie trimisă ca JSON.' });
    }
    next();
  });

  app.use((req, res, next) => {
    req.user = auth.sessionUser(db, req);
    next();
  });

  const requireRole = (role) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Autentificați-vă.' });
    if (req.user.role !== role) return res.status(403).json({ error: 'Nu aveți acces la această secțiune.' });
    next();
  };

  const publicLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

  // Sends newly queued messages (confirmations, review requests) right away
  // instead of waiting for the next scheduler tick.
  let flushing = null;
  const kick = () => {
    if (!flushing) flushing = notify.flushOutbox(db, send).catch(() => {}).finally(() => { flushing = null; });
  };

  // ----- public -----

  app.get('/api/public/info', (req, res) => {
    const s = getSettings(db);
    res.json({
      station: s.station, hours: s.hours, services: s.services, slotMinutes: s.slotMinutes,
      bookingDaysAhead: s.bookingDaysAhead, closedDates: s.closedDates, today: itp.nowLocal().date,
    });
  });

  app.get('/api/public/days', (req, res) => {
    const s = getSettings(db);
    const now = itp.nowLocal();
    const days = [];
    for (let i = 0; i <= s.bookingDaysAhead; i++) {
      const date = itp.addDays(now.date, i);
      days.push({ date, free: itp.freeSlots(db, s, date, now).length, open: itp.daySlots(s, date).length > 0 });
    }
    res.json({ days });
  });

  app.get('/api/public/slots', (req, res) => {
    res.json({ date: req.query.date, slots: itp.freeSlots(db, getSettings(db), String(req.query.date || '')) });
  });

  app.post('/api/public/bookings', publicLimit, h((req, res) => {
    const input = parseVehicleInput(req.body, { requireContact: true });
    if (!input.name) fail(400, 'Introduceți numele.');
    const booking = createBooking(db, { ...input, date: req.body.date, time: req.body.time }, { source: 'online' });
    kick();
    res.status(201).json(booking);
  }));

  function publicBooking(req) {
    const b = db.prepare(`
      SELECT b.*, v.plate FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE b.ref = ?
    `).get(String(req.params.ref).toUpperCase());
    const code = String(req.query.code || req.body?.code || '');
    if (!b || b.cancel_code.length !== code.length || !require('node:crypto').timingSafeEqual(Buffer.from(b.cancel_code), Buffer.from(code))) {
      fail(404, 'Programarea nu a fost găsită.');
    }
    return b;
  }

  app.get('/api/public/bookings/:ref', publicLimit, h((req, res) => {
    const b = publicBooking(req);
    res.json({ ref: b.ref, plate: b.plate, date: b.date, time: b.time, status: b.status });
  }));

  app.post('/api/public/bookings/:ref/cancel', publicLimit, h((req, res) => {
    const b = publicBooking(req);
    if (b.status !== 'confirmed') fail(409, 'Programarea nu mai poate fi anulată.');
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
    res.json({ ok: true });
  }));

  app.post('/api/public/reminders', publicLimit, h((req, res) => {
    const input = parseVehicleInput(req.body, { requireContact: true });
    if (!input.consent) fail(400, 'Bifați acordul pentru a primi remindere.');
    if (!input.itpExpiry) fail(400, 'Introduceți data expirării ITP.');
    tx(db, () => {
      const v = upsertVehicle(db, input);
      if (!v.company_id) {
        db.prepare('UPDATE vehicles SET itp_expiry = ?, reminder_consent = 1 WHERE id = ?').run(input.itpExpiry, v.id);
      }
    });
    res.status(201).json({ ok: true });
  }));

  // ----- auth -----

  app.post('/api/auth/login', rateLimit({ windowMs: 10 * 60 * 1000, max: 10 }), h((req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(str(req.body.email, 120));
    if (!user || !auth.verifyPassword(String(req.body.password || ''), user.password_hash)) {
      fail(401, 'E-mailul sau parola nu sunt corecte.');
    }
    const { token, maxAge } = auth.createSession(db, user.id);
    res.cookie(auth.COOKIE, token, {
      httpOnly: true, sameSite: 'lax', maxAge, path: '/', secure: process.env.COOKIE_SECURE === '1',
    });
    res.json({ role: user.role });
  }));

  app.post('/api/auth/logout', (req, res) => {
    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.clearCookie(auth.COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Autentificați-vă.' });
    res.json(req.user);
  });

  app.post('/api/auth/password', h((req, res) => {
    if (!req.user) fail(401, 'Autentificați-vă.');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!auth.verifyPassword(String(req.body.current || ''), row.password_hash)) fail(400, 'Parola actuală nu este corectă.');
    const next = String(req.body.password || '');
    if (next.length < 10) fail(400, 'Parola nouă trebuie să aibă cel puțin 10 caractere.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), req.user.id);
    res.json({ ok: true });
  }));

  // ----- admin -----

  const admin = express.Router();
  admin.use(requireRole('admin'));

  admin.get('/stats', (req, res) => {
    const now = itp.nowLocal();
    const monthStart = `${now.date.slice(0, 7)}-01`;
    const one = (sql, ...p) => db.prepare(sql).get(...p).n;
    res.json({
      today: now.date,
      bookingsToday: one("SELECT COUNT(*) n FROM bookings WHERE date = ? AND status != 'cancelled'", now.date),
      bookingsWeek: one("SELECT COUNT(*) n FROM bookings WHERE date BETWEEN ? AND ? AND status = 'confirmed'", now.date, itp.addDays(now.date, 6)),
      inspectionsMonth: one('SELECT COUNT(*) n FROM inspections WHERE date >= ?', monthStart),
      revenueMonth: db.prepare('SELECT COALESCE(SUM(price), 0) n FROM inspections WHERE date >= ?').get(monthStart).n,
      expiring30: one('SELECT COUNT(*) n FROM vehicles WHERE itp_expiry BETWEEN ? AND ?', now.date, itp.addDays(now.date, 30)),
      vehicles: one('SELECT COUNT(*) n FROM vehicles'),
      withConsent: one('SELECT COUNT(*) n FROM vehicles WHERE reminder_consent = 1'),
      companies: one('SELECT COUNT(*) n FROM companies'),
      outboxQueued: one("SELECT COUNT(*) n FROM outbox WHERE status = 'queued'"),
      outboxFailed: one("SELECT COUNT(*) n FROM outbox WHERE status = 'failed'"),
    });
  });

  admin.get('/bookings', (req, res) => {
    const from = itp.isDate(req.query.from) ? req.query.from : itp.nowLocal().date;
    const to = itp.isDate(req.query.to) ? req.query.to : from;
    const rows = db.prepare(`
      SELECT b.id, b.ref, b.date, b.time, b.service, b.status, b.source, b.contact_name, b.contact_phone, b.contact_email, b.notes,
             v.id AS vehicle_id, v.plate, v.model, v.year, v.category, v.fuel, v.usage, v.itp_expiry, c.name AS company_name
      FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id LEFT JOIN companies c ON c.id = v.company_id
      WHERE b.date BETWEEN ? AND ? ORDER BY b.date, b.time
    `).all(from, to);
    const s = getSettings(db);
    res.json({
      from, to, bookings: rows.map((b) => ({
        ...b, serviceName: serviceFor(s, b.service).name, suggestedMonths: itp.suggestedValidityMonths(b, b.date),
      })),
    });
  });

  admin.post('/bookings', h((req, res) => {
    const input = parseVehicleInput(req.body);
    const booking = createBooking(db, { ...input, date: req.body.date, time: req.body.time }, { source: 'admin' });
    kick();
    res.status(201).json(booking);
  }));

  admin.patch('/bookings/:id', h((req, res) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!b) fail(404, 'Programarea nu există.');
    const status = req.body.status;
    if (status && !['confirmed', 'no_show', 'cancelled'].includes(status)) fail(400, 'Status invalid.');
    db.prepare('UPDATE bookings SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE id = ?')
      .run(status || null, req.body.notes != null ? str(req.body.notes, 300) : null, b.id);
    res.json({ ok: true });
  }));

  admin.post('/bookings/:id/complete', h((req, res) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!b) fail(404, 'Programarea nu există.');
    if (b.status === 'done') fail(409, 'Inspecția este deja înregistrată.');
    const result = req.body.result === 'respins' ? 'respins' : 'admis';
    const validUntil = result === 'admis' ? req.body.validUntil : null;
    if (result === 'admis' && !itp.isDate(validUntil)) fail(400, 'Introduceți data până la care este valabil ITP-ul.');
    const price = req.body.price === '' || req.body.price == null ? null : Number(req.body.price);
    const s = getSettings(db);
    const inspectionId = tx(db, () => {
      const today = itp.nowLocal().date;
      const ins = db.prepare(`INSERT INTO inspections (vehicle_id, booking_id, date, result, valid_until, price, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(b.vehicle_id, b.id, today, result, validUntil, Number.isFinite(price) ? price : null, str(req.body.notes, 300));
      db.prepare("UPDATE bookings SET status = 'done' WHERE id = ?").run(b.id);
      if (validUntil) db.prepare('UPDATE vehicles SET itp_expiry = ? WHERE id = ?').run(validUntil, b.vehicle_id);
      if (result === 'admis' && s.reviewRequest && s.station.reviewUrl) {
        const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(b.vehicle_id);
        notify.queue(db, {
          dedupeKey: `review:${b.id}`, vehicleId: v.id, phone: b.contact_phone, email: b.contact_email,
          kind: 'review_request', ...notify.templates.reviewRequest(s, v),
        });
      }
      return Number(ins.lastInsertRowid);
    });
    kick();
    res.json({ ok: true, inspectionId });
  }));

  admin.get('/vehicles', (req, res) => {
    const q = `%${str(req.query.q, 60).toUpperCase()}%`;
    const compact = `%${str(req.query.q, 60).toUpperCase().replace(/[^A-Z0-9]/g, '')}%`;
    const phoneDigits = itp.normalizePhone(req.query.q);
    const phoneQ = phoneDigits ? `%${phoneDigits}%` : null; // NULL never matches
    const today = itp.nowLocal().date;
    const expiring = Number(req.query.expiring) || 0;
    const rows = db.prepare(`
      SELECT v.*, c.name AS company_name,
        (SELECT MAX(date) FROM inspections i WHERE i.vehicle_id = v.id) AS last_inspection
      FROM vehicles v LEFT JOIN companies c ON c.id = v.company_id
      WHERE (REPLACE(v.plate, ' ', '') LIKE ? OR UPPER(v.owner_name) LIKE ? OR v.phone LIKE ? OR UPPER(COALESCE(c.name, '')) LIKE ?)
        ${expiring ? 'AND v.itp_expiry BETWEEN ? AND ?' : ''}
      ORDER BY v.itp_expiry IS NULL, v.itp_expiry LIMIT 500
    `).all(compact, q, phoneQ, q, ...(expiring ? [today, itp.addDays(today, expiring)] : []));
    res.json({ vehicles: rows.map((v) => ({ ...v, ...vehicleStatus(v, today) })) });
  });

  admin.patch('/vehicles/:id', h((req, res) => {
    const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
    if (!v) fail(404, 'Vehiculul nu există.');
    const input = parseVehicleInput({ ...v, ...req.body, plate: req.body.plate || v.plate, consent: req.body.consent ?? Boolean(v.reminder_consent) });
    db.prepare(`
      UPDATE vehicles SET plate = ?, model = ?, year = ?, category = ?, fuel = ?, usage = ?, owner_name = ?, phone = ?, email = ?,
        itp_expiry = ?, reminder_consent = ?, notes = ? WHERE id = ?
    `).run(input.plate, input.model, input.year, input.category, input.fuel, input.usage, input.name || v.owner_name,
      input.phone, input.email, input.itpExpiry, input.consent ? 1 : 0, input.notes, v.id);
    res.json({ ok: true });
  }));

  admin.get('/vehicles.csv', (req, res) => {
    const rows = db.prepare(`
      SELECT v.plate, v.model, v.year, v.category, v.fuel, v.usage, v.owner_name, v.phone, v.email, c.name AS company,
             v.itp_expiry, v.reminder_consent FROM vehicles v LEFT JOIN companies c ON c.id = v.company_id ORDER BY v.plate
    `).all();
    const cols = ['plate', 'model', 'year', 'category', 'fuel', 'usage', 'owner_name', 'phone', 'email', 'company', 'itp_expiry', 'reminder_consent'];
    const cell = (x) => {
      let s = String(x ?? '');
      if (/^[=+\-@]/.test(s)) s = `'${s}`; // no formula injection in Excel
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    res.type('text/csv').attachment('vehicule-miseda.csv')
      .send(`﻿${cols.join(',')}\n${rows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\n')}`);
  });

  admin.get('/outbox', (req, res) => {
    const status = ['queued', 'sent', 'failed'].includes(req.query.status) ? req.query.status : null;
    const rows = db.prepare(`
      SELECT o.id, o.channel, o.recipient, o.kind, o.status, o.error, o.created_at, o.sent_at, v.plate,
        CASE WHEN o.kind = 'login_code' THEN 'Cod de autentificare (ascuns)' ELSE o.body END AS body
      FROM outbox o LEFT JOIN vehicles v ON v.id = o.vehicle_id
      ${status ? 'WHERE o.status = ?' : ''} ORDER BY o.id DESC LIMIT 200
    `).all(...(status ? [status] : []));
    res.json({ messages: rows });
  });

  admin.post('/outbox/run', h(async (req, res) => {
    const queued = notify.scheduleReminders(db);
    const result = await notify.flushOutbox(db, send);
    res.json({ queued, ...result });
  }));

  admin.post('/outbox/:id/retry', h((req, res) => {
    db.prepare("UPDATE outbox SET status = 'queued' WHERE id = ? AND status = 'failed'").run(req.params.id);
    res.json({ ok: true });
  }));

  admin.get('/settings', (req, res) => res.json(getSettings(db)));

  admin.put('/settings', h((req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.station) {
      const cur = getSettings(db).station;
      patch.station = Object.fromEntries(Object.keys(cur).map((k) => [k, str(b.station[k] ?? cur[k], 300)]));
    }
    if (b.hours) {
      const hours = {};
      for (let d = 0; d < 7; d++) {
        const v = b.hours[d];
        if (v === null || v === undefined) hours[d] = null;
        else if (Array.isArray(v) && v.every((t) => /^\d{2}:\d{2}$/.test(t)) && v[0] < v[1]) hours[d] = [v[0], v[1]];
        else fail(400, 'Program invalid.');
      }
      patch.hours = hours;
    }
    if (b.slotMinutes != null) {
      if (![15, 20, 30, 40, 45, 60].includes(Number(b.slotMinutes))) fail(400, 'Durata intervalului trebuie să fie 15–60 min.');
      patch.slotMinutes = Number(b.slotMinutes);
    }
    if (b.lanes != null) {
      if (!(Number(b.lanes) >= 1 && Number(b.lanes) <= 5)) fail(400, 'Numărul de linii trebuie să fie 1–5.');
      patch.lanes = Number(b.lanes);
    }
    if (b.bookingDaysAhead != null) patch.bookingDaysAhead = Math.min(90, Math.max(1, Number(b.bookingDaysAhead) || 30));
    if (b.closedDates) patch.closedDates = b.closedDates.filter(itp.isDate).slice(0, 100);
    if (b.services) {
      if (!Array.isArray(b.services) || !b.services.length) fail(400, 'Adăugați cel puțin un serviciu.');
      patch.services = b.services.slice(0, 20).map((s, i) => ({
        id: str(s.id, 40) || `serviciu-${i + 1}`, name: str(s.name, 80), price: Number(s.price) || 0,
      }));
    }
    if (b.reminderDays) patch.reminderDays = [...new Set(b.reminderDays.map(Number).filter((n) => n >= 1 && n <= 90))];
    if (b.reviewRequest != null) patch.reviewRequest = Boolean(b.reviewRequest);
    res.json(saveSettings(db, patch));
  }));

  admin.get('/companies', (req, res) => {
    const today = itp.nowLocal().date;
    res.json({
      companies: db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM vehicles v WHERE v.company_id = c.id) AS vehicles,
          (SELECT COUNT(*) FROM vehicles v WHERE v.company_id = c.id AND v.itp_expiry BETWEEN ? AND ?) AS expiring,
          (SELECT GROUP_CONCAT(email, ', ') FROM users u WHERE u.company_id = c.id) AS users
        FROM companies c ORDER BY c.name
      `).all(today, itp.addDays(today, 30)),
    });
  });

  admin.post('/companies', h((req, res) => {
    const name = str(req.body.name, 120);
    const email = str(req.body.userEmail, 120).toLowerCase();
    const password = String(req.body.userPassword || '');
    if (!name) fail(400, 'Introduceți numele firmei.');
    if (!itp.isEmail(email)) fail(400, 'Introduceți e-mailul contului firmei.');
    if (password.length < 10) fail(400, 'Parola contului trebuie să aibă cel puțin 10 caractere.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'Există deja un cont cu acest e-mail.');
    const id = tx(db, () => {
      const r = db.prepare('INSERT INTO companies (name, cui, phone, email) VALUES (?, ?, ?, ?)')
        .run(name, str(req.body.cui, 20), itp.normalizePhone(req.body.phone), email);
      db.prepare("INSERT INTO users (email, name, password_hash, role, company_id) VALUES (?, ?, ?, 'fleet', ?)")
        .run(email, str(req.body.contactName, 100), auth.hashPassword(password), r.lastInsertRowid);
      return Number(r.lastInsertRowid);
    });
    res.status(201).json({ id });
  }));

  admin.post('/vehicles/:id/company', h((req, res) => {
    const companyId = req.body.companyId ? Number(req.body.companyId) : null;
    if (companyId && !db.prepare('SELECT 1 FROM companies WHERE id = ?').get(companyId)) fail(404, 'Firma nu există.');
    db.prepare('UPDATE vehicles SET company_id = ? WHERE id = ?').run(companyId, req.params.id);
    res.json({ ok: true });
  }));

  // Full file for one vehicle: bookings, inspections with photos, messages.
  admin.get('/vehicles/:id', (req, res) => {
    const v = db.prepare(`SELECT v.*, c.name AS company_name FROM vehicles v LEFT JOIN companies c ON c.id = v.company_id WHERE v.id = ?`)
      .get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Vehiculul nu există.' });
    const today = itp.nowLocal().date;
    const inspections = db.prepare('SELECT * FROM inspections WHERE vehicle_id = ? ORDER BY date DESC, id DESC').all(v.id);
    const pics = photos.listFor(db, inspections.map((i) => i.id));
    res.json({
      vehicle: { ...v, ...vehicleStatus(v, today) },
      inspections: inspections.map((i) => ({ ...i, photos: pics[i.id] || [] })),
      bookings: db.prepare('SELECT id, ref, date, time, service, status, source, contact_name, contact_phone FROM bookings WHERE vehicle_id = ? ORDER BY date DESC, time DESC LIMIT 50').all(v.id),
      messages: db.prepare('SELECT id, kind, channel, recipient, status, created_at FROM outbox WHERE vehicle_id = ? ORDER BY id DESC LIMIT 50').all(v.id),
    });
  });

  admin.post('/inspections/:id/photos', express.raw({ type: 'image/*', limit: photos.MAX_BYTES }), h((req, res) => {
    const inspection = db.prepare('SELECT * FROM inspections WHERE id = ?').get(req.params.id);
    if (!inspection) fail(404, 'Inspecția nu există.');
    if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, 'Trimiteți o poză.');
    try {
      res.status(201).json(photos.save(db, inspection, req.body));
    } catch (err) {
      if (err.status) fail(err.status, err.message);
      throw err;
    }
  }));

  admin.delete('/photos/:id', h((req, res) => {
    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
    if (!photo) fail(404, 'Poza nu există.');
    photos.remove(db, photo);
    res.json({ ok: true });
  }));

  app.use('/api/admin', admin);

  // ----- fleet -----

  const fleet = express.Router();
  fleet.use(requireRole('fleet'));

  fleet.get('/overview', (req, res) => {
    const today = itp.nowLocal().date;
    const cid = req.user.company_id;
    const vehicles = db.prepare(`
      SELECT v.*, (SELECT b.date || ' ' || b.time FROM bookings b WHERE b.vehicle_id = v.id AND b.status = 'confirmed' AND b.date >= ?
                   ORDER BY b.date, b.time LIMIT 1) AS next_booking,
        (SELECT b.id FROM bookings b WHERE b.vehicle_id = v.id AND b.status = 'confirmed' AND b.date >= ?
                   ORDER BY b.date, b.time LIMIT 1) AS next_booking_id
      FROM vehicles v WHERE v.company_id = ? ORDER BY v.itp_expiry IS NULL, v.itp_expiry
    `).all(today, today, cid).map((v) => ({ ...v, ...vehicleStatus(v, today) }));
    const rows = db.prepare(`
      SELECT i.id, i.date, i.result, i.valid_until, i.price, v.plate FROM inspections i JOIN vehicles v ON v.id = i.vehicle_id
      WHERE v.company_id = ? ORDER BY i.date DESC LIMIT 50
    `).all(cid);
    const pics = photos.listFor(db, rows.map((r) => r.id));
    const history = rows.map((r) => ({ ...r, photos: pics[r.id] || [] }));
    res.json({ company: { id: cid, name: req.user.company_name }, today, vehicles, history });
  });

  fleet.post('/vehicles', h((req, res) => {
    const input = parseVehicleInput({ ...req.body, consent: true });
    const existing = db.prepare('SELECT company_id FROM vehicles WHERE plate = ?').get(input.plate);
    if (existing && existing.company_id && existing.company_id !== req.user.company_id) {
      fail(409, 'Acest număr este deja asociat altei firme. Contactați stația.');
    }
    tx(db, () => {
      const v = upsertVehicle(db, input, { companyId: req.user.company_id });
      db.prepare(`UPDATE vehicles SET company_id = ?, model = ?, year = ?, category = ?, fuel = ?, usage = ?,
        itp_expiry = COALESCE(?, itp_expiry), reminder_consent = 1, notes = ? WHERE id = ?`)
        .run(req.user.company_id, input.model, input.year, input.category, input.fuel, input.usage === 'personal' ? 'firma' : input.usage,
          input.itpExpiry, input.notes, v.id);
    });
    res.status(201).json({ ok: true });
  }));

  fleet.patch('/vehicles/:id', h((req, res) => {
    const v = db.prepare('SELECT * FROM vehicles WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
    if (!v) fail(404, 'Vehiculul nu există.');
    const input = parseVehicleInput({ ...req.body, plate: v.plate });
    db.prepare('UPDATE vehicles SET model = ?, year = ?, category = ?, fuel = ?, usage = ?, itp_expiry = ?, notes = ? WHERE id = ?')
      .run(input.model, input.year, input.category, input.fuel, input.usage, input.itpExpiry, input.notes, v.id);
    res.json({ ok: true });
  }));

  fleet.delete('/vehicles/:id', h((req, res) => {
    const r = db.prepare('UPDATE vehicles SET company_id = NULL WHERE id = ? AND company_id = ?').run(req.params.id, req.user.company_id);
    if (!r.changes) fail(404, 'Vehiculul nu există.');
    res.json({ ok: true });
  }));

  // Books several vehicles on one day, each in the earliest free slot.
  fleet.post('/bookings', h((req, res) => {
    const ids = Array.isArray(req.body.vehicleIds) ? req.body.vehicleIds.map(Number) : [];
    if (!ids.length) fail(400, 'Selectați cel puțin un vehicul.');
    if (ids.length > 20) fail(400, 'Puteți programa cel mult 20 de vehicule odată.');
    const date = req.body.date;
    if (!itp.isDate(date)) fail(400, 'Alegeți o dată validă.');
    const s = getSettings(db);
    const created = [];
    const errors = [];
    for (const id of ids) {
      const v = db.prepare('SELECT * FROM vehicles WHERE id = ? AND company_id = ?').get(id, req.user.company_id);
      if (!v) { errors.push({ id, error: 'Vehiculul nu există.' }); continue; }
      const slot = itp.freeSlots(db, s, date)[0];
      if (!slot) { errors.push({ id, plate: v.plate, error: 'Nu mai sunt intervale libere în această zi.' }); continue; }
      try {
        const booking = createBooking(db, {
          plate: v.plate, date, time: slot, service: v.category === 'N1' ? 'itp-n1' : (v.fuel === 'diesel' ? 'itp-diesel' : 'itp-benzina'),
          email: req.user.email, name: req.user.company_name,
        }, { source: 'fleet', companyId: req.user.company_id });
        created.push({ plate: v.plate, date, time: slot, ref: booking.ref });
      } catch (err) {
        errors.push({ id, plate: v.plate, error: err.message });
      }
    }
    kick();
    res.status(created.length ? 201 : 409).json({ created, errors });
  }));

  fleet.post('/bookings/:id/cancel', h((req, res) => {
    const r = db.prepare(`
      UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'
        AND vehicle_id IN (SELECT id FROM vehicles WHERE company_id = ?)
    `).run(req.params.id, req.user.company_id);
    if (!r.changes) fail(404, 'Programarea nu există.');
    res.json({ ok: true });
  }));

  app.use('/api/fleet', fleet);

  // ----- customers (login by SMS code) -----

  // Vehicles a customer sees: private cars with their phone, or that they booked.
  const clientVehicleIds = (phone) => db.prepare(`
    SELECT id FROM vehicles WHERE company_id IS NULL
      AND (phone = ? OR id IN (SELECT vehicle_id FROM bookings WHERE contact_phone = ?))
  `).all(phone, phone).map((r) => r.id);

  const codeLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
  const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });

  app.post('/api/client/code', codeLimit, h((req, res) => {
    const phone = itp.normalizePhone(req.body.phone);
    if (!itp.isMobile(phone)) fail(400, 'Introduceți un număr de mobil valid, de ex. 0745 123 456.');
    let code;
    try {
      code = clientAuth.requestCode(db, phone);
    } catch (err) {
      if (err.status) fail(err.status, err.message);
      throw err;
    }
    if (code) {
      notify.queue(db, {
        dedupeKey: `login:${phone}:${Date.now()}`, vehicleId: null, phone, kind: 'login_code',
        subject: 'Cod de autentificare', body: `Codul tău MISEDA ITP: ${code}. Expiră în 10 minute. Nu îl da nimănui.`,
        sms: `Codul tau MISEDA ITP: ${code}. Expira in 10 minute. Nu il da nimanui.`,
      });
      kick();
    }
    // Same answer either way, so the form can't be used to test which numbers are customers.
    res.json({ ok: true });
  }));

  app.post('/api/client/login', loginLimit, h((req, res) => {
    const phone = itp.normalizePhone(req.body.phone);
    let session;
    try {
      session = clientAuth.verifyCode(db, phone, req.body.code);
    } catch (err) {
      if (err.status) fail(err.status, err.message);
      throw err;
    }
    res.cookie(clientAuth.COOKIE, session.token, {
      httpOnly: true, sameSite: 'lax', maxAge: session.maxAge, path: '/', secure: process.env.COOKIE_SECURE === '1',
    });
    res.json({ ok: true });
  }));

  app.post('/api/client/logout', (req, res) => {
    clientAuth.logout(db, req);
    res.clearCookie(clientAuth.COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  const requireClient = (req, res, next) => {
    req.clientPhone = clientAuth.clientPhone(db, req);
    if (!req.clientPhone) return res.status(401).json({ error: 'Autentificați-vă cu numărul de telefon.' });
    next();
  };

  app.get('/api/client/overview', requireClient, (req, res) => {
    const ids = clientVehicleIds(req.clientPhone);
    const today = itp.nowLocal().date;
    const s = getSettings(db);
    const vehicles = ids.map((id) => {
      const v = db.prepare('SELECT id, plate, model, year, category, itp_expiry, reminder_consent FROM vehicles WHERE id = ?').get(id);
      const inspections = db.prepare('SELECT id, date, result, valid_until, price FROM inspections WHERE vehicle_id = ? ORDER BY date DESC, id DESC').all(id);
      const pics = photos.listFor(db, inspections.map((i) => i.id));
      const bookings = db.prepare(`SELECT id, ref, date, time, service, status FROM bookings WHERE vehicle_id = ? AND contact_phone = ?
        ORDER BY date DESC, time DESC LIMIT 20`).all(id, req.clientPhone)
        .map((b) => ({ ...b, serviceName: serviceFor(s, b.service).name }));
      return { ...v, ...vehicleStatus(v, today), inspections: inspections.map((i) => ({ ...i, photos: pics[i.id] || [] })), bookings };
    });
    res.json({ phone: req.clientPhone, today, vehicles });
  });

  app.post('/api/client/bookings/:id/cancel', requireClient, h((req, res) => {
    const r = db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ? AND contact_phone = ? AND status = 'confirmed' AND date >= ?`)
      .run(req.params.id, req.clientPhone, itp.nowLocal().date);
    if (!r.changes) fail(404, 'Programarea nu poate fi anulată.');
    res.json({ ok: true });
  }));

  app.patch('/api/client/vehicles/:id', requireClient, h((req, res) => {
    const id = Number(req.params.id);
    if (!clientVehicleIds(req.clientPhone).includes(id)) fail(404, 'Vehiculul nu există.');
    db.prepare('UPDATE vehicles SET reminder_consent = ? WHERE id = ?').run(req.body.reminders ? 1 : 0, id);
    res.json({ ok: true });
  }));

  // Photos: station staff, the fleet that owns the vehicle, or its customer.
  app.get('/api/photos/:id', (req, res) => {
    const photo = db.prepare('SELECT p.*, v.company_id FROM photos p JOIN vehicles v ON v.id = p.vehicle_id WHERE p.id = ?').get(req.params.id);
    const phone = clientAuth.clientPhone(db, req);
    const allowed = photo && (
      req.user?.role === 'admin'
      || (req.user?.role === 'fleet' && photo.company_id === req.user.company_id)
      || (phone && clientVehicleIds(phone).includes(photo.vehicle_id))
    );
    if (!allowed) return res.status(404).json({ error: 'Poza nu există.' });
    res.set('Cache-Control', 'private, max-age=86400').type(photo.mime).sendFile(photos.filePath(photo));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Adresă API necunoscută.' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalid.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Fișierul este prea mare (maxim 8 MB).' });
    log(err);
    res.status(500).json({ error: 'Eroare internă. Încercați din nou.' });
  });

  return app;
}

if (require.main === module) {
  const db = openDb();
  auth.ensureAdmin(db);
  const send = notify.providerFromEnv();
  const app = createApp(db, { send });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`MISEDA ITP pornit pe http://localhost:${port}`));
  notify.startScheduler(db, send);
}

module.exports = { createApp, createBooking };
