'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'A apărut o eroare. Încercați din nou.');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const DOW = ['Dum', 'Lun', 'Mar', 'Mie', 'Joi', 'Vin', 'Sâm'];
const DOW_LONG = ['Duminică', 'Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri', 'Sâmbătă'];
const MONTHS = ['ian.', 'feb.', 'mar.', 'apr.', 'mai', 'iun.', 'iul.', 'aug.', 'sept.', 'oct.', 'nov.', 'dec.'];

function parseDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtDate(date, { weekday = false } = {}) {
  if (!date) return '—';
  const d = parseDay(date);
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return weekday ? `${DOW_LONG[d.getUTCDay()]}, ${base}` : base;
}

function addDays(date, days) {
  const d = parseDay(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(date, months) {
  const d = parseDay(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

function plate(text) {
  return `<span class="plate"><span>${esc(text)}</span></span>`;
}

function itpChip(days) {
  if (days === null || days === undefined) return '<span class="chip none">necunoscut</span>';
  if (days < 0) return `<span class="chip bad">expirat de ${-days} ${days === -1 ? 'zi' : 'zile'}</span>`;
  if (days === 0) return '<span class="chip bad">expiră azi</span>';
  if (days <= 30) return `<span class="chip warn">${days} ${days === 1 ? 'zi' : 'zile'}</span>`;
  return `<span class="chip ok">${days} zile</span>`;
}

let toastTimer;
function toast(text) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// Shows a <dialog> built from HTML; resolves with the submitted form's data or null.
function formDialog(html) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = html;
    document.body.append(dlg);
    const form = $('form', dlg);
    const errorEl = $('.error', dlg);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (e.submitter?.value === 'cancel') { dlg.close(); return; }
      const data = Object.fromEntries(new FormData(form));
      // File inputs keep every selected file, not only the last one.
      for (const input of $$('input[type=file]', form)) data[input.name] = [...input.files];
      dlg.resolveWith = data;
      dlg.close();
    });
    $$('[value="cancel"]', dlg).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); dlg.close(); }));
    dlg.addEventListener('close', () => { resolve(dlg.resolveWith || null); dlg.remove(); });
    dlg.showError = (msg) => { if (errorEl) { errorEl.textContent = msg; errorEl.hidden = false; } };
    dlg.showModal();
  });
}

function confirmDialog(text, yes = 'Da') {
  return formDialog(`
    <form method="dialog">
      <p>${esc(text)}</p>
      <div class="row">
        <button class="btn ghost" value="cancel">Renunță</button>
        <button class="btn primary" value="ok">${esc(yes)}</button>
      </div>
    </form>`).then((r) => r !== null);
}

// Shrinks a photo on the device (max 1600 px, JPEG) before uploading it,
// so phone camera pictures of 4–8 MB become ~300 KB.
async function shrinkImage(file, maxSide = 1600) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.82));
}

async function uploadPhotos(inspectionId, files) {
  let ok = 0;
  const errors = [];
  for (const file of files) {
    try {
      const blob = await shrinkImage(file);
      const res = await fetch(`/api/admin/inspections/${inspectionId}/photos`, {
        method: 'POST', headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob, credentials: 'same-origin',
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Încărcarea a eșuat.');
      ok++;
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }
  return { ok, errors };
}

function photoGrid(photos, { deletable = false } = {}) {
  if (!photos?.length) return '';
  return `<div class="photos">${photos.map((p) => `<span class="photo">
      <a href="${p.url}" target="_blank" rel="noopener"><img src="${p.url}" alt="Poză ITP" loading="lazy"></a>
      ${deletable ? `<button type="button" class="photo-del" data-del-photo="${p.id}" aria-label="Șterge poza">×</button>` : ''}
    </span>`).join('')}</div>`;
}
