'use strict';

// Date helpers work on "YYYY-MM-DD" strings in the station's time zone.
const TZ = 'Europe/Bucharest';

function nowLocal(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function isDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(str);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(date, months) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000);
}

function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// All slot start times for a date, from the opening hours.
function daySlots(settings, date) {
  if ((settings.closedDates || []).includes(date)) return [];
  const hours = settings.hours[weekday(date)];
  if (!hours) return [];
  const [open, close] = hours.map(toMinutes);
  const step = settings.slotMinutes;
  const out = [];
  for (let t = open; t + step <= close; t += step) out.push(fromMinutes(t));
  return out;
}

// Free slots: opening hours minus bookings at capacity, minus past times.
function freeSlots(db, settings, date, now = nowLocal()) {
  if (!isDate(date) || date < now.date) return [];
  if (daysBetween(now.date, date) > settings.bookingDaysAhead) return [];
  const taken = new Map();
  for (const row of db.prepare(
    "SELECT time, COUNT(*) AS n FROM bookings WHERE date = ? AND status IN ('confirmed', 'done') GROUP BY time",
  ).all(date)) taken.set(row.time, row.n);
  return daySlots(settings, date).filter((t) => {
    if (date === now.date && t <= now.time) return false;
    return (taken.get(t) || 0) < settings.lanes;
  });
}

// Suggested ITP validity in months. Passenger cars (M1): 36 months when new,
// 24 until 12 years old, then 12. Taxis / ride-sharing: 6 months.
// Light goods vehicles (N1): 12 months. The inspector always confirms it.
function suggestedValidityMonths(vehicle, onDate) {
  if (vehicle.usage === 'taxi') return 6;
  if (vehicle.category === 'N1') return 12;
  if (!vehicle.year) return 24;
  const age = Number(onDate.slice(0, 4)) - vehicle.year;
  if (age < 3) return 36;
  if (age < 12) return 24;
  return 12;
}

// Canonical form: letter and digit groups separated by one space, so
// "sv12abc", "SV-12-ABC" and "SV 12 ABC" are the same vehicle.
function normalizePlate(plate) {
  const compact = String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (compact.match(/[A-Z]+|\d+/g) || []).join(' ');
}

// Romanian plates: county code + 2-3 digits + 3 letters (e.g. SV 12 ABC, B 123 ABC),
// plus temporary / other formats — only a light sanity check.
function isPlausiblePlate(plate) {
  const compact = plate.replace(/\s/g, '');
  return compact.length >= 4 && compact.length <= 12 && /[A-Z]/.test(compact) && /\d/.test(compact);
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (/^(\+?40|0040)7\d{8}$/.test(digits)) return `0${digits.slice(-9)}`;
  return digits;
}

function isMobile(phone) {
  return /^07\d{8}$/.test(phone);
}

function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

module.exports = {
  TZ, nowLocal, isDate, addDays, addMonths, daysBetween, weekday,
  daySlots, freeSlots, suggestedValidityMonths,
  normalizePlate, isPlausiblePlate, normalizePhone, isMobile, isEmail,
};
