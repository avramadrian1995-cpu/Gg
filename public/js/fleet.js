'use strict';

let data = null;
const selected = new Set();

async function start() {
  try {
    const me = await api('/api/auth/me');
    if (me.role !== 'fleet') throw new Error();
    $('#companyName').textContent = me.company_name;
    $('#userNav').hidden = false;
    $('#loginView').hidden = true;
    $('#app').hidden = false;
    load();
  } catch {
    $('#loginView').hidden = false;
    $('#app').hidden = true;
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    if (r.role === 'admin') { location.href = '/admin/'; return; }
    start();
  } catch (err) {
    $('#loginError').textContent = err.message;
    $('#loginError').hidden = false;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: {} });
  location.reload();
});

async function load() {
  data = await api('/api/fleet/overview');
  const v = data.vehicles;
  const expired = v.filter((x) => x.itpDays !== null && x.itpDays < 0).length;
  const soon = v.filter((x) => x.itpDays !== null && x.itpDays >= 0 && x.itpDays <= 30).length;
  const booked = v.filter((x) => x.next_booking).length;
  $('#stats').innerHTML = [
    ['Vehicule', v.length, ''],
    ['ITP expirat', expired, expired ? 'bad' : ''],
    ['Expiră în 30 zile', soon, soon ? 'warn' : ''],
    ['Programate', booked, ''],
  ].map(([l, val, cls]) => `<div class="stat"><div class="label">${l}</div><div class="value ${cls}">${val}</div></div>`).join('');

  $('#vehicleRows').innerHTML = v.length ? v.map((x) => {
    const [date, time] = (x.next_booking || '').split(' ');
    return `<tr>
      <td><input type="checkbox" data-sel="${x.id}" ${selected.has(x.id) ? 'checked' : ''} ${x.next_booking ? 'disabled' : ''}
        aria-label="Selectează ${esc(x.plate)}"></td>
      <td>${plate(x.plate)}<div class="small muted">${esc([x.model, x.year, x.category].filter(Boolean).join(' · '))}</div></td>
      <td class="num">${x.itp_expiry ? fmtDate(x.itp_expiry) : '—'}</td>
      <td>${itpChip(x.itpDays)}</td>
      <td>${x.next_booking ? `<strong>${fmtDate(date)}</strong>, ${esc(time)}
        <button class="btn sm danger" data-cancel="${x.next_booking_id}">Anulează</button>` : '<span class="muted">—</span>'}</td>
      <td><div class="row">
        <button class="btn sm" data-edit="${x.id}">Editează</button>
        <button class="btn sm danger" data-remove="${x.id}">Scoate</button></div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty">Nu ai adăugat încă vehicule. Apasă „Adaugă vehicul”.</td></tr>';

  $('#historyRows').innerHTML = data.history.length ? data.history.map((h) => `<tr>
      <td class="num">${fmtDate(h.date)}</td>
      <td>${plate(h.plate)}${photoGrid(h.photos)}</td>
      <td>${h.result === 'admis' ? '<span class="chip ok">admis</span>' : '<span class="chip bad">respins</span>'}</td>
      <td class="num">${h.valid_until ? fmtDate(h.valid_until) : '—'}</td>
      <td class="num">${h.price != null ? `${h.price} lei` : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">Nicio inspecție încă.</td></tr>';

  for (const id of [...selected]) if (!v.some((x) => x.id === id && !x.next_booking)) selected.delete(id);
  updateSelection();
}

function updateSelection() {
  $('#bookSelected').disabled = selected.size === 0;
  $('#selInfo').textContent = selected.size ? `${selected.size} selectate` : 'Bifează vehiculele pe care vrei să le programezi.';
}

$('#selectAll').addEventListener('change', (e) => {
  $$('[data-sel]').forEach((cb) => {
    if (cb.disabled) return;
    cb.checked = e.target.checked;
    const id = Number(cb.dataset.sel);
    if (cb.checked) selected.add(id); else selected.delete(id);
  });
  updateSelection();
});

$('#vehicleRows').addEventListener('change', (e) => {
  const cb = e.target.closest('[data-sel]');
  if (!cb) return;
  const id = Number(cb.dataset.sel);
  if (cb.checked) selected.add(id); else selected.delete(id);
  updateSelection();
});

function vehicleForm(v = {}) {
  const sel = (name, value, opts) => `<select name="${name}">${opts.map(([val, label]) =>
    `<option value="${val}" ${val === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  return `
    <form method="dialog" class="stack">
      <h3>${v.id ? `Editează ${esc(v.plate)}` : 'Adaugă vehicul'}</h3>
      <div class="fields">
        <label>Număr înmatriculare <input name="plate" value="${esc(v.plate || '')}" ${v.id ? 'readonly' : 'required'}></label>
        <label>Marcă / model <input name="model" value="${esc(v.model || '')}"></label>
        <label>An fabricație <input name="year" type="number" min="1950" max="2100" value="${esc(v.year ?? '')}"></label>
      </div>
      <div class="fields">
        <label>Categorie ${sel('category', v.category || 'M1', [['M1', 'Autoturism (M1)'], ['N1', 'Utilitară sub 3,5 t (N1)']])}</label>
        <label>Combustibil ${sel('fuel', v.fuel || 'diesel', [['benzina', 'benzină'], ['diesel', 'diesel'], ['gpl', 'GPL'], ['hibrid', 'hibrid'], ['electric', 'electric']])}</label>
        <label>Utilizare ${sel('usage', v.usage || 'firma', [['firma', 'firmă'], ['taxi', 'taxi / ride-sharing']])}</label>
        <label>ITP expiră <input type="date" name="itpExpiry" value="${esc(v.itp_expiry || '')}"></label>
      </div>
      <label>Observații (șofer, punct de lucru) <input name="notes" value="${esc(v.notes || '')}" maxlength="300"></label>
      <div class="row">
        <button class="btn ghost" value="cancel">Renunță</button>
        <button class="btn primary" value="ok">Salvează</button>
      </div>
    </form>`;
}

$('#addVehicle').addEventListener('click', async () => {
  const form = await formDialog(vehicleForm());
  if (!form) return;
  try {
    await api('/api/fleet/vehicles', { method: 'POST', body: form });
    toast(`${form.plate.toUpperCase()} a fost adăugat.`);
    load();
  } catch (err) {
    toast(err.message);
  }
});

$('#vehicleRows').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  const remove = e.target.closest('[data-remove]');
  const cancel = e.target.closest('[data-cancel]');
  try {
    if (edit) {
      const v = data.vehicles.find((x) => String(x.id) === edit.dataset.edit);
      const form = await formDialog(vehicleForm(v));
      if (!form) return;
      await api(`/api/fleet/vehicles/${v.id}`, { method: 'PATCH', body: form });
      toast('Vehicul actualizat.');
    } else if (remove) {
      const v = data.vehicles.find((x) => String(x.id) === remove.dataset.remove);
      if (!(await confirmDialog(`Scoți ${v.plate} din flota firmei?`, 'Scoate'))) return;
      await api(`/api/fleet/vehicles/${v.id}`, { method: 'DELETE' });
      toast(`${v.plate} a fost scos din flotă.`);
    } else if (cancel) {
      if (!(await confirmDialog('Anulezi această programare?', 'Anulează programarea'))) return;
      await api(`/api/fleet/bookings/${cancel.dataset.cancel}/cancel`, { method: 'POST', body: {} });
      toast('Programarea a fost anulată.');
    } else {
      return;
    }
    load();
  } catch (err) {
    toast(err.message);
  }
});

$('#bookSelected').addEventListener('click', async () => {
  const { days } = await api('/api/public/days');
  const usable = days.filter((d) => d.free > 0);
  if (!usable.length) { toast('Nu sunt zile libere în perioada următoare. Sunați la stație.'); return; }
  const form = await formDialog(`
    <form method="dialog" class="stack">
      <h3>Programează ${selected.size} ${selected.size === 1 ? 'vehicul' : 'vehicule'}</h3>
      <label>Ziua
        <select name="date">${usable.map((d) => `<option value="${d.date}">${fmtDate(d.date, { weekday: true })} – ${d.free} intervale libere</option>`).join('')}</select>
      </label>
      <p class="small muted">Fiecare vehicul primește primul interval liber din ziua aleasă, unul după altul.</p>
      <div class="row">
        <button class="btn ghost" value="cancel">Renunță</button>
        <button class="btn primary" value="ok">Programează</button>
      </div>
    </form>`);
  if (!form) return;
  try {
    const r = await api('/api/fleet/bookings', { method: 'POST', body: { vehicleIds: [...selected], date: form.date } });
    report(r);
  } catch (err) {
    if (err.data?.errors) report(err.data); else toast(err.message);
  }
  selected.clear();
  load();
});

function report(r) {
  formDialog(`
    <form method="dialog" class="stack">
      <h3>Rezultat programare</h3>
      ${r.created.length ? `<ul>${r.created.map((c) => `<li>${plate(c.plate)} – ${fmtDate(c.date)}, ora <strong>${esc(c.time)}</strong></li>`).join('')}</ul>` : ''}
      ${r.errors.length ? `<ul class="error">${r.errors.map((c) => `<li>${esc(c.plate || '')}: ${esc(c.error)}</li>`).join('')}</ul>` : ''}
      <div class="row"><button class="btn primary" value="ok">OK</button></div>
    </form>`);
}

start();
