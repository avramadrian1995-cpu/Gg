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

const $ = (id) => document.getElementById(id);

// ---------- storage ----------

function loadVehicles() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveVehicles() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vehicles));
  } catch {
    // storage unavailable (private mode etc.) — keep working in memory
  }
}

function loadWarnDays() {
  try {
    return Number(localStorage.getItem(WARN_KEY)) || 30;
  } catch {
    return 30;
  }
}

let vehicles = loadVehicles();

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
    const docs = DOCS.map((doc) => {
      const days = daysUntil(v[doc.key]);
      const st = statusOf(days, warnDays);
      if (st.cls === 'bad') expired++;
      if (st.cls === 'warn') soon++;
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
          <span class="plate">${escapeHtml(v.plate)}</span>
          <span class="model">${escapeHtml([v.model, v.year].filter(Boolean).join(' · '))}</span>
        </div>
        <div class="docs">${docs}</div>
        ${v.notes ? `<p class="notes">${escapeHtml(v.notes)}</p>` : ''}
        <div class="vehicle-actions">
          <button type="button" class="small" data-action="edit" data-id="${v.id}">Editează</button>
          <button type="button" class="small" data-action="ics" data-id="${v.id}">Adaugă în calendar</button>
          <button type="button" class="small danger" data-action="delete" data-id="${v.id}">Șterge</button>
        </div>
      </article>`;
  }).join('');

  const pills = [
    `<span class="pill none">${vehicles.length} ${vehicles.length === 1 ? 'mașină' : 'mașini'}</span>`,
  ];
  if (expired) pills.push(`<span class="pill bad">${expired} expirate</span>`);
  if (soon) pills.push(`<span class="pill warn">${soon} expiră curând</span>`);
  if (!expired && !soon) pills.push('<span class="pill ok">Totul în regulă</span>');
  $('summary').innerHTML = pills.join('');
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
    vehicles = vehicles.map((v) => (v.id === id ? { ...v, ...data } : v));
  } else {
    vehicles.push({ id: crypto.randomUUID?.() ?? String(Date.now()), ...data });
  }
  saveVehicles();
  resetForm();
  render();
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
      if (confirm(`Ștergi ${vehicle.plate}?`)) {
        vehicles = vehicles.filter((v) => v.id !== vehicle.id);
        saveVehicles();
        if ($('vehicleId').value === vehicle.id) resetForm();
        render();
      }
      break;
    case 'ics':
      downloadIcs(vehicle);
      break;
  }
});

$('warnDays').value = String(loadWarnDays());
$('warnDays').addEventListener('change', () => {
  try { localStorage.setItem(WARN_KEY, $('warnDays').value); } catch { /* ignore */ }
  render();
});

// ---------- calendar export (.ics) ----------

function icsDate(date) {
  return toInputDate(date).replace(/-/g, '');
}

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
      const next = new Date(date.getTime() + DAY_MS);
      const summary = `Expiră ${doc.label} – ${vehicle.plate}`;
      return [
        'BEGIN:VEVENT',
        `UID:${vehicle.id}-${doc.key}-${icsDate(date)}@itp-tracker`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(date)}`,
        `DTEND;VALUE=DATE:${icsDate(next)}`,
        `SUMMARY:${icsEscape(summary)}`,
        'BEGIN:VALARM',
        `TRIGGER:-P${warnDays}D`,
        'ACTION:DISPLAY',
        `DESCRIPTION:${icsEscape(summary)}`,
        'END:VALARM',
        'END:VEVENT',
      ].join('\r\n');
    });

  if (!events.length) {
    alert('Nu există date de expirare pentru această mașină.');
    return;
  }

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

$('exportBtn').addEventListener('click', () => {
  download(`itp-tracker-${toInputDate(today())}.json`, JSON.stringify(vehicles, null, 2), 'application/json');
});

$('importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data) || !data.every((v) => v && typeof v.plate === 'string' && v.id)) {
      throw new Error('format invalid');
    }
    if (vehicles.length && !confirm(`Înlocuiești cele ${vehicles.length} mașini existente cu ${data.length} din fișier?`)) {
      return;
    }
    vehicles = data;
    saveVehicles();
    resetForm();
    render();
  } catch (err) {
    alert(`Importul a eșuat: ${err.message}`);
  }
});

// ---------- init ----------

updateItpHint();
render();
