'use strict';

// Customer login without a password: a 6-digit code sent by SMS to the phone
// number on their bookings. Codes are stored hashed, expire after 10 minutes
// and allow 5 attempts; a new code can be requested once a minute.

const crypto = require('node:crypto');
const auth = require('./auth');

const COOKIE = 'miseda_client';
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const SESSION_DAYS = 90;

function hashCode(phone, code) {
  return crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');
}

function hasVehicles(db, phone) {
  return Boolean(db.prepare(`
    SELECT 1 FROM vehicles WHERE phone = ? AND company_id IS NULL
    UNION SELECT 1 FROM bookings WHERE contact_phone = ? LIMIT 1
  `).get(phone, phone));
}

// Returns the code to send, or null when this phone has nothing to show.
function requestCode(db, phone, now = Date.now()) {
  const last = db.prepare('SELECT sent_at FROM login_codes WHERE phone = ?').get(phone);
  if (last && now - Date.parse(last.sent_at) < RESEND_SECONDS * 1000) {
    const err = new Error('Am trimis deja un cod. Așteptați un minut înainte să cereți altul.');
    err.status = 429;
    throw err;
  }
  if (!hasVehicles(db, phone)) return null;
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare(`
    INSERT INTO login_codes (phone, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at
  `).run(phone, hashCode(phone, code), new Date(now + CODE_MINUTES * 60000).toISOString(), new Date(now).toISOString());
  return code;
}

function verifyCode(db, phone, code, now = Date.now()) {
  const row = db.prepare('SELECT * FROM login_codes WHERE phone = ?').get(phone);
  const invalid = () => {
    const err = new Error('Codul nu este corect sau a expirat. Cereți un cod nou.');
    err.status = 401;
    return err;
  };
  if (!row || Date.parse(row.expires_at) < now || row.attempts >= MAX_ATTEMPTS) throw invalid();
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(hashCode(phone, String(code || '').replace(/\D/g, '')), 'hex');
  if (!crypto.timingSafeEqual(expected, actual)) {
    db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE phone = ?').run(phone);
    throw invalid();
  }
  db.prepare('DELETE FROM login_codes WHERE phone = ?').run(phone);
  const token = auth.randomToken();
  db.prepare('INSERT INTO client_sessions (token, phone, expires_at) VALUES (?, ?, ?)')
    .run(token, phone, new Date(now + SESSION_DAYS * 86400000).toISOString());
  db.prepare('DELETE FROM client_sessions WHERE expires_at < ?').run(new Date(now).toISOString());
  return { token, maxAge: SESSION_DAYS * 86400000 };
}

function clientPhone(db, req) {
  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare('SELECT phone FROM client_sessions WHERE token = ? AND expires_at > ?').get(token, new Date().toISOString());
  return row ? row.phone : null;
}

function logout(db, req) {
  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM client_sessions WHERE token = ?').run(token);
}

module.exports = { COOKIE, requestCode, verifyCode, clientPhone, logout };
