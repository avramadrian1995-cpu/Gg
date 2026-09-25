'use strict';

const crypto = require('node:crypto');

const SESSION_DAYS = 14;
const COOKIE = 'miseda_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function createSession(db, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  return { token, maxAge: SESSION_DAYS * 86400000 };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionUser(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.company_id, c.name AS company_name
    FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN companies c ON c.id = u.company_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, new Date().toISOString()) || null;
}

// Creates the first admin account on an empty database.
function ensureAdmin(db, log = console.log) {
  const exists = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (exists) return null;
  const email = process.env.ADMIN_EMAIL || 'admin@miseda.local';
  const password = process.env.ADMIN_PASSWORD || randomToken(9);
  db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, 'Administrator', ?, 'admin')")
    .run(email, hashPassword(password));
  if (!process.env.ADMIN_PASSWORD) {
    log(`\n  Cont administrator creat: ${email} / parola: ${password}\n  Schimb-o din panoul de administrare.\n`);
  }
  return { email, password };
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, randomToken, createSession, sessionUser, parseCookies, ensureAdmin,
};
