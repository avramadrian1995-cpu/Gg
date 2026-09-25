'use strict';

const { getSettings } = require('./db');
const { nowLocal, addDays, isMobile, isEmail } = require('./itp');

// ---------- message templates ----------
// Each template gives a full text (e-mail) and a short `sms` text. SMS text is
// sent without diacritics and kept to one 160-character GSM-7 part: with
// diacritics a part holds only 70 characters and costs 2–4x more.

function fmt(date) {
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y}`;
}

function plain(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[șş]/g, 's').replace(/[ȘŞ]/g, 'S').replace(/[țţ]/g, 't').replace(/[ȚŢ]/g, 'T');
}

function sms(text) {
  const out = plain(text).replace(/\s+/g, ' ').trim();
  return out.slice(0, 160);
}

function short(s) {
  return {
    name: s.station.name.replace(/\s*S\.?R\.?L\.?$/i, '').trim(),
    address: s.station.address.split(', jud.')[0],
    phone: s.station.phone.replace(/\s/g, ''),
  };
}

function stationLine(s) {
  return `${s.station.name}, ${s.station.address}. Tel ${s.station.phone}`;
}

const templates = {
  bookingConfirmed: (s, b) => ({
    subject: `Programare ITP confirmată – ${b.plate}`,
    body: `Programare ITP confirmată pentru ${b.plate}: ${fmt(b.date)} ora ${b.time}. `
      + `Cod programare ${b.ref}. Aduceți talonul, cartea de identitate a vehiculului (CIV) și RCA valabil. ${stationLine(s)}`,
    sms: sms(`ITP confirmat ${b.plate}: ${fmt(b.date).slice(0, 5)} ora ${b.time}, cod ${b.ref}. Aduceti talon, CIV, RCA. `
      + `${short(s).name}, ${short(s).address}, ${short(s).phone}`),
  }),
  bookingTomorrow: (s, b) => ({
    subject: `Mâine aveți ITP – ${b.plate}`,
    body: `Vă reamintim: mâine, ${fmt(b.date)} ora ${b.time}, ITP pentru ${b.plate}. `
      + `Dacă nu puteți ajunge, sunați la ${s.station.phone}. ${s.station.name}`,
    sms: sms(`Maine ${fmt(b.date).slice(0, 5)} ora ${b.time}: ITP ${b.plate} la ${short(s).name}, ${short(s).address}. `
      + `Nu puteti ajunge? Sunati ${short(s).phone}`),
  }),
  itpExpiring: (s, v, days, bookUrl) => ({
    subject: `ITP-ul pentru ${v.plate} expiră ${days <= 1 ? 'mâine' : `în ${days} zile`}`,
    body: `ITP-ul pentru ${v.plate} expiră pe ${fmt(v.itp_expiry)}. `
      + `Programați-vă online: ${bookUrl} sau la ${s.station.phone}. ${s.station.name}`,
    sms: sms(`ITP ${v.plate} expira pe ${fmt(v.itp_expiry)}. Programare: ${bookUrl} sau ${short(s).phone}. ${short(s).name}`),
  }),
  reviewRequest: (s, v) => ({
    subject: `Mulțumim că ați ales ${short(s).name}`,
    body: `Mulțumim pentru vizită, ${v.plate}! Ne ajutați cu o recenzie? ${s.station.reviewUrl} ${s.station.name}`,
    sms: sms(`Multumim, ${v.plate}! O recenzie ne ajuta mult: ${s.station.reviewUrl} ${short(s).name}`),
  }),
};

// ---------- outbox ----------

// Queues one message per available channel. dedupeKey makes it idempotent.
function queue(db, { dedupeKey, vehicleId, phone, email, kind, subject, body, sms: smsBody }) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO outbox (dedupe_key, vehicle_id, channel, recipient, subject, body, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let queued = 0;
  if (phone && isMobile(phone)) queued += stmt.run(`${dedupeKey}:sms`, vehicleId, 'sms', phone, subject, smsBody || body, kind).changes;
  if (email && isEmail(email)) queued += stmt.run(`${dedupeKey}:email`, vehicleId, 'email', email, subject, body, kind).changes;
  return queued;
}

// ---------- providers ----------
// NOTIFY_PROVIDER=log (default): messages are only logged and marked sent —
// useful until an SMS / e-mail gateway is contracted.
// NOTIFY_PROVIDER=webhook: POSTs {channel, to, subject, body} as JSON to
// NOTIFY_WEBHOOK_URL (with optional NOTIFY_WEBHOOK_TOKEN as Bearer). Most
// Romanian SMS gateways and e-mail services can be bridged this way.

function providerFromEnv(env = process.env, log = console.log) {
  if (env.NOTIFY_PROVIDER === 'webhook') {
    if (!env.NOTIFY_WEBHOOK_URL) throw new Error('NOTIFY_WEBHOOK_URL lipsește');
    return async (msg) => {
      const res = await fetch(env.NOTIFY_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.NOTIFY_WEBHOOK_TOKEN ? { authorization: `Bearer ${env.NOTIFY_WEBHOOK_TOKEN}` } : {}),
        },
        body: JSON.stringify({ channel: msg.channel, to: msg.recipient, subject: msg.subject, body: msg.body }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    };
  }
  return async (msg) => log(`[${msg.channel} → ${msg.recipient}] ${msg.body}`);
}

async function flushOutbox(db, send, limit = 50) {
  const rows = db.prepare("SELECT * FROM outbox WHERE status = 'queued' ORDER BY id LIMIT ?").all(limit);
  const ok = db.prepare("UPDATE outbox SET status = 'sent', sent_at = datetime('now'), error = NULL WHERE id = ?");
  // Login codes are not kept readable once sent.
  const redact = db.prepare("UPDATE outbox SET body = 'Cod de autentificare (ascuns)' WHERE id = ? AND kind = 'login_code'");
  const fail = db.prepare("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?");
  let sent = 0;
  for (const msg of rows) {
    try {
      await send(msg);
      ok.run(msg.id);
      redact.run(msg.id);
      sent++;
    } catch (err) {
      fail.run(String(err.message || err).slice(0, 300), msg.id);
    }
  }
  return { sent, failed: rows.length - sent };
}

// ---------- daily reminder scan ----------

function scheduleReminders(db, { publicUrl = process.env.PUBLIC_URL || '', now = nowLocal() } = {}) {
  const s = getSettings(db);
  const bookUrl = `${publicUrl.replace(/\/$/, '')}/#programare`;
  let queued = 0;

  // ITP expiring in exactly N days (per reminderDays), for consenting owners
  // with no upcoming booking.
  for (const days of s.reminderDays) {
    const target = addDays(now.date, days);
    const vehicles = db.prepare(`
      SELECT v.* FROM vehicles v
      WHERE v.itp_expiry = ? AND v.reminder_consent = 1
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.vehicle_id = v.id AND b.status = 'confirmed' AND b.date >= ?)
    `).all(target, now.date);
    for (const v of vehicles) {
      const t = templates.itpExpiring(s, v, days, bookUrl);
      queued += queue(db, {
        dedupeKey: `itp:${v.id}:${v.itp_expiry}:${days}`, vehicleId: v.id, phone: v.phone, email: v.email, kind: 'itp_expiring', ...t,
      });
    }
  }

  // Day-before booking reminders.
  const tomorrow = addDays(now.date, 1);
  const bookings = db.prepare(`
    SELECT b.*, v.plate FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
    WHERE b.date = ? AND b.status = 'confirmed'
  `).all(tomorrow);
  for (const b of bookings) {
    queued += queue(db, {
      dedupeKey: `tomorrow:${b.id}`, vehicleId: b.vehicle_id, phone: b.contact_phone, email: b.contact_email,
      kind: 'booking_tomorrow', ...templates.bookingTomorrow(s, b),
    });
  }
  return queued;
}

// Runs the scan + send loop: once at start, then every `intervalMs`.
function startScheduler(db, send, { intervalMs = 15 * 60 * 1000, log = console.log } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const queued = scheduleReminders(db);
      const { sent, failed } = await flushOutbox(db, send);
      if (queued || sent || failed) log(`Remindere: ${queued} noi, ${sent} trimise, ${failed} eșuate`);
    } catch (err) {
      log(`Eroare remindere: ${err.message}`);
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { templates, queue, providerFromEnv, flushOutbox, scheduleReminders, startScheduler };
