'use strict';

const STORAGE_KEY = 'itp-tracker.vehicles.v1';
const WARN_KEY = 'itp-tracker.warnDays';
const DAY_MS = 24 * 60 * 60 * 1000;

const DOCS = [
  { key: 'itpExpiry', label: 'ITP' },
  { key: 'rcaExpiry', label: 'RCA' },
  { key: 'vignetteExpiry', label: 'Rovinietă' },
  { key: 'cascoExpiry', label: 'CASCO' },
];

// When the page runs as a claude.ai artifact, `window.claude` exists and the
// sandbox blocks plain downloads; .ics files are not an allowed save type there.
const IN_CLAUDE = Boolean(window.claude?.use);

const $ = (id) => document.getElementById(id);

// ---------- dates ----------

// Parse "YYYY-MM-DD" as a local date (avoids UTC off-by-one).
function parseDate(str) {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function toInputDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function daysUntil(str) {
  const date = parseDate(str);
  if (!date) return null;
  return Math.round((date - today()) / DAY_MS);
}

function addYears(date, years) {
  const result = new Date(date.getFullYear() + years, date.getMonth(), date.getDate());
  // 29 Feb + N years on a non-leap year rolls to 1 Mar; clamp to 28 Feb
  if (result.getMonth() !== date.getMonth()) result.setDate(0);
  return result;
}

function formatDate(str) {
  const date = parseDate(str);
  return date ? date.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

// Suggested ITP interval for passenger cars (M1, < 3.5t) in Romania:
// new car: 3 years, up to 12 years old: 2 years, older: 1 year.
// Taxis, driving-school cars etc. have different rules — user can override.
function suggestedInterval(year) {
  if (!year) return null;
  const age = new Date().getFullYear() - year;
  if (age < 3) return 3;
  if (age < 12) return 2;
  return 1;
}

// ---------- storage ----------
// Always kept in localStorage. Inside a claude.ai artifact it is also kept in
// the viewer's private cloud document, so it follows them across devices.

function exampleVehicle() {
  const t = today();
  const itpExpiry = addDays(t, 20);
  return {
    id: 'example',
    example: true,
    plate: 'B 01 XMP',
    model: 'Dacia Logan',
    year: 2016,
    itpDone: toInputDate(addYears(itpExpiry, -2)),
    itpInterval: '2',
    itpExpiry: toInputDate(itpExpiry),
    rcaExpiry: toInputDate(addDays(t, 140)),
    vignetteExpiry: toInputDate(addDays(t, -3)),
    cascoExpiry: '',
    notes: 'Mașină de exemplu. Șterge-o după ce adaugi una reală.',
  };
}

// Returns null when nothing was ever saved (first visit).
function readLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return null;
  }
}

function loadWarnDays() {
  try {
    return Number(localStorage.getItem(WARN_KEY)) || 30;
  } catch {
    return 30;
  }
}

let vehicles = readLocal() ?? [exampleVehicle()];
let cloudDoc = null;
let cloudBusy = false;
let cloudDirty = false;

function saveVehicles() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vehicles));
    localStorage.setItem(WARN_KEY, $('warnDays').value);
  } catch {
    // storage unavailable (private mode etc.) — keep working in memory
  }
  if (cloudDoc) saveCloud();
}

// One write at a time; changes made while a write is in flight are
// coalesced into the next one.
async function saveCloud() {
  cloudDirty = true;
  if (cloudBusy) return;
  cloudBusy = true;
  while (cloudDirty) {
    cloudDirty = false;
    try {
      await cloudDoc.set({
        vehicles: JSON.parse(JSON.stringify(vehicles)),
        warnDays: Number($('warnDays').value),
      });
    } catch {
      showToast('Nu am putut salva în cont. Modificările rămân în acest browser.');
      break;
    }
  }
  cloudBusy = false;
}

async function connectCloud() {
  if (!IN_CLAUDE) return;
  try {
    const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
    if (!db || !user) return;
    const uid = await user.id();
    if (!uid) return;
    const ref = db.doc(`data/users/${uid}/garage`);
    const snap = await ref.get();
    cloudDoc = ref;
    if (snap.exists) {
      const data = snap.data();
      vehicles = Array.isArray(data.vehicles) ? data.vehicles.map((v) => ({ ...v })) : [];
      if ([7, 14, 30, 60].includes(data.warnDays)) $('warnDays').value = String(data.warnDays);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(vehicles)); } catch { /* ignore */ }
      render();
    } else {
      saveCloud();
    }
    $('storageNote').textContent = 'Datele sunt salvate în contul tău și sunt vizibile doar pentru tine.';
  } catch {
    // stay on localStorage
  }
}

// ---------- status ----------

function statusOf(days, warnDays) {
  if (days === null) return { cls: 'none', text: 'nesetat' };
  if (days < 0) return { cls: 'bad', text: `expirat de ${-days} ${days === -1 ? 'zi' : 'zile'}` };
  if (days === 0) return { cls: 'bad', text: 'expiră azi' };
  if (days <= warnDays) return { cls: 'warn', text: `${days} ${days === 1 ? 'zi' : 'zile'} rămase` };
  return { cls: 'ok', text: `${days} zile rămase` };
}

// ---------- rendering ----------

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function soonestDays(vehicle) {
  const all = DOCS.map((d) => daysUntil(vehicle[d.key])).filter((d) => d !== null);
  return all.length ? Math.min(...all) : Infinity;
}

function icsDate(date) {
  return toInputDate(date).replace(/-/g, '');
}

function googleCalendarUrl(vehicle, doc) {
  const date = parseDate(vehicle[doc.key]);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Expiră ${doc.label} – ${vehicle.plate}`,
    dates: `${icsDate(date)}/${icsDate(addDays(date, 1))}`,
    details: [vehicle.model, vehicle.notes].filter(Boolean).join('\n'),
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

const openCalendars = new Set();

function calendarRow(v) {
  const links = DOCS
    .filter((doc) => parseDate(v[doc.key]))
    .map((doc) => `<a href="${googleCalendarUrl(v, doc)}" target="_blank" rel="noopener">${doc.label} în Google Calendar</a>`);
  if (!links.length) return '<div class="cal">Nu există date de expirare pentru această mașină.</div>';
  const ics = IN_CLAUDE ? '' : `<button type="button" class="small" data-action="ics" data-id="${escapeHtml(v.id)}">Descarcă .ics (toate)</button>`;
  return `<div class="cal">${links.join('')}${ics}</div>`;
}

function render() {
  const warnDays = Number($('warnDays').value);
  const list = $('vehicleList');

  if (!vehicles.length) {
    list.innerHTML = '<p class="empty">Nicio mașină adăugată încă.</p>';
    $('summary').innerHTML = '';
    return;
  }

  const sorted = [...vehicles].sort((a, b) => soonestDays(a) - soonestDays(b));
  let expired = 0;
  let soon = 0;

  list.innerHTML = sorted.map((v) => {
    const id = escapeHtml(v.id);
    const docs = DOCS.map((doc) => {
      const days = daysUntil(v[doc.key]);
      const st = statusOf(days, warnDays);
      if (!v.example && st.cls === 'bad') expired++;
      if (!v.example && st.cls === 'warn') soon++;
      return `
        <div class="doc ${st.cls}">
          <strong>${doc.label}</strong>
          <div>${formatDate(v[doc.key])}</div>
          <div class="days">${st.text}</div>
        </div>`;
    }).join('');

    return `
      <article class="vehicle">
        <div class="vehicle-head">
          <span>
            <span class="plate"><span>${escapeHtml(v.plate)}</span></span>
            ${v.example ? '<span class="tag none">Exemplu</span>' : ''}
          </span>
          <span class="model">${escapeHtml([v.model, v.year].filter(Boolean).join(' · '))}</span>
        </div>
        <div class="docs">${docs}</div>
        ${v.notes ? `<p class="notes">${escapeHtml(v.notes)}</p>` : ''}
        <div class="vehicle-actions">
          <button type="button" class="small" data-action="edit" data-id="${id}">Editează</button>
          <button type="button" class="small" data-action="calendar" data-id="${id}" aria-expanded="${openCalendars.has(v.id)}">Adaugă în calendar</button>
          <button type="button" class="small danger" data-action="delete" data-id="${id}">Șterge</button>
        </div>
        ${openCalendars.has(v.id) ? calendarRow(v) : ''}
      </article>`;
  }).join('');

  const real = vehicles.filter((v) => !v.example).length;
  const pills = [`<span class="pill none">${real} ${real === 1 ? 'mașină' : 'mașini'}</span>`];
  if (expired) pills.push(`<span class="pill bad">${expired} ${expired === 1 ? 'document expirat' : 'documente expirate'}</span>`);
  if (soon) pills.push(`<span class="pill warn">${soon} expiră curând</span>`);
  if (real && !expired && !soon) pills.push('<span class="pill ok">Totul în regulă</span>');
  $('summary').innerHTML = pills.join('');
}

// ---------- confirmations & messages (in-page; no alert/confirm) ----------

let confirmAction = null;
let toastTimer = null;

function askConfirm(text, yesLabel, action) {
  $('toast').hidden = true;
  $('confirmText').textContent = text;
  $('confirmYes').textContent = yesLabel;
  confirmAction = action;
  $('confirmBar').hidden = false;
  $('confirmNo').focus();
}

function closeConfirm() {
  $('confirmBar').hidden = true;
  confirmAction = null;
}

$('confirmYes').addEventListener('click', () => {
  const action = confirmAction;
  closeConfirm();
  action?.();
});
$('confirmNo').addEventListener('click', closeConfirm);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('confirmBar').hidden) closeConfirm();
});

function showToast(text) {
  if (!$('confirmBar').hidden) return;
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

// ---------- form ----------

const FIELDS = ['plate', 'model', 'year', 'itpDone', 'itpInterval', 'itpExpiry',
  'rcaExpiry', 'vignetteExpiry', 'cascoExpiry', 'notes'];

function resetForm() {
  $('vehicleForm').reset();
  $('vehicleId').value = '';
  $('formTitle').textContent = 'Adaugă mașină';
  $('cancelBtn').hidden = true;
  updateItpHint();
}

function fillForm(v) {
  FIELDS.forEach((f) => { $(f).value = v[f] ?? ''; });
  if (!v.itpInterval) $('itpInterval').value = '2';
  $('vehicleId').value = v.id;
  $('formTitle').textContent = `Editează ${v.plate}`;
  $('cancelBtn').hidden = false;
  updateItpHint();
  $('vehicleForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function recalcItpExpiry() {
  const done = parseDate($('itpDone').value);
  if (!done) return;
  $('itpExpiry').value = toInputDate(addYears(done, Number($('itpInterval').value)));
}

function updateItpHint() {
  const suggestion = suggestedInterval(Number($('year').value));
  const base = 'Completează data inspecției și valabilitatea, iar data expirării se calculează automat. O poți modifica manual.';
  $('itpHint').textContent = suggestion
    ? `${base} Pentru un autoturism din ${$('year').value}, valabilitatea uzuală este ${suggestion} ${suggestion === 1 ? 'an' : 'ani'}.`
    : base;
}

$('itpDone').addEventListener('change', recalcItpExpiry);
$('itpInterval').addEventListener('change', recalcItpExpiry);
$('year').addEventListener('input', () => {
  updateItpHint();
  const suggestion = suggestedInterval(Number($('year').value));
  if (suggestion && !$('vehicleId').value) {
    $('itpInterval').value = String(suggestion);
    recalcItpExpiry();
  }
});

$('vehicleForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = {};
  FIELDS.forEach((f) => { data[f] = $(f).value.trim(); });
  data.plate = data.plate.toUpperCase().replace(/\s+/g, ' ');
  data.year = data.year ? Number(data.year) : '';

  const id = $('vehicleId').value;
  if (id) {
    vehicles = vehicles.map((v) => (v.id === id ? { ...v, ...data, example: false } : v));
  } else {
    vehicles.push({ id: crypto.randomUUID?.() ?? String(Date.now()), ...data });
  }
  saveVehicles();
  resetForm();
  render();
  showToast(id ? `${data.plate} a fost actualizată.` : `${data.plate} a fost adăugată.`);
});

$('cancelBtn').addEventListener('click', resetForm);

// ---------- list actions ----------

$('vehicleList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const vehicle = vehicles.find((v) => v.id === btn.dataset.id);
  if (!vehicle) return;

  switch (btn.dataset.action) {
    case 'edit':
      fillForm(vehicle);
      break;
    case 'delete':
      askConfirm(`Ștergi ${vehicle.plate}?`, 'Șterge', () => {
        vehicles = vehicles.filter((v) => v.id !== vehicle.id);
        openCalendars.delete(vehicle.id);
        saveVehicles();
        if ($('vehicleId').value === vehicle.id) resetForm();
        render();
        showToast(`${vehicle.plate} a fost ștearsă.`);
      });
      break;
    case 'calendar':
      if (openCalendars.has(vehicle.id)) openCalendars.delete(vehicle.id);
      else openCalendars.add(vehicle.id);
      render();
      break;
    case 'ics':
      downloadIcs(vehicle);
      break;
  }
});

$('warnDays').value = String(loadWarnDays());
$('warnDays').addEventListener('change', () => {
  saveVehicles();
  render();
});

// ---------- calendar export (.ics, outside claude.ai only) ----------

function icsEscape(str) {
  return String(str).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
}

function downloadIcs(vehicle) {
  const warnDays = Number($('warnDays').value);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const events = DOCS
    .filter((doc) => parseDate(vehicle[doc.key]))
    .map((doc) => {
      const date = parseDate(vehicle[doc.key]);
      const summary = `Expiră ${doc.label} – ${vehicle.plate}`;
      return [
        'BEGIN:VEVENT',
        `UID:${vehicle.id}-${doc.key}-${icsDate(date)}@itp-tracker`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(date)}`,
        `DTEND;VALUE=DATE:${icsDate(addDays(date, 1))}`,
        `SUMMARY:${icsEscape(summary)}`,
        'BEGIN:VALARM',
        `TRIGGER:-P${warnDays}D`,
        'ACTION:DISPLAY',
        `DESCRIPTION:${icsEscape(summary)}`,
        'END:VALARM',
        'END:VEVENT',
      ].join('\r\n');
    });

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ITP Tracker//RO',
    'CALSCALE:GREGORIAN',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');

  download(`${vehicle.plate.replace(/\s+/g, '')}-expirari.ics`, ics, 'text/calendar');
}

// ---------- import / export ----------

let downloadsApi = null;
if (IN_CLAUDE) {
  // Plain downloads are blocked in the artifact viewer; use its save dialog,
  // and hide Export when that is unavailable.
  $('exportBtn').hidden = true;
  window.claude.use('downloads').then((api) => {
    downloadsApi = api;
    $('exportBtn').hidden = !api;
  }).catch(() => {});
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$('exportBtn').addEventListener('click', async () => {
  const filename = `itp-tracker-${toInputDate(today())}.json`;
  const data = JSON.stringify(vehicles.filter((v) => !v.example), null, 2);
  if (!downloadsApi) {
    download(filename, data, 'application/json');
    return;
  }
  try {
    await downloadsApi.save({ filename, data });
    showToast('Backup salvat.');
  } catch (err) {
    if (err?.code === 'rate_limited') showToast('Există deja o salvare în curs. Încearcă din nou în câteva secunde.');
    else if (err?.code !== 'declined') showToast('Salvarea fișierului nu este disponibilă aici.');
  }
});

function applyImport(data) {
  vehicles = data;
  openCalendars.clear();
  saveVehicles();
  resetForm();
  render();
  showToast(`Am importat ${data.length} ${data.length === 1 ? 'mașină' : 'mașini'}.`);
}

$('importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showToast('Fișierul nu este un JSON valid. Alege un fișier creat cu Export.');
    return;
  }
  if (!Array.isArray(data) || !data.every((v) => v && typeof v.plate === 'string' && v.id)) {
    showToast('Fișierul nu conține mașini. Alege un fișier creat cu Export.');
    return;
  }
  const existing = vehicles.filter((v) => !v.example).length;
  if (existing) {
    askConfirm(`Înlocuiești cele ${existing} mașini existente cu ${data.length} din fișier?`, 'Înlocuiește', () => applyImport(data));
  } else {
    applyImport(data);
  }
});

// ---------- init ----------

updateItpHint();
render();
connectCloud();
