'use strict';

let phone = '';

function showLogin() {
  $('#loginView').hidden = false;
  $('#app').hidden = true;
  $('#logoutBtn').hidden = true;
}

async function load() {
  let data;
  try {
    data = await api('/api/client/overview');
  } catch (err) {
    if (err.status === 401) { showLogin(); return; }
    throw err;
  }
  $('#loginView').hidden = true;
  $('#app').hidden = false;
  $('#logoutBtn').hidden = false;
  $('#phoneLabel').textContent = `Conectat cu ${data.phone}`;

  $('#vehicles').innerHTML = data.vehicles.length ? data.vehicles.map((v) => {
    const next = v.bookings.find((b) => b.status === 'confirmed' && b.date >= data.today);
    return `<article class="card stack">
      <div class="spread">
        <span>${plate(v.plate)} <span class="muted small">${esc([v.model, v.year].filter(Boolean).join(' · '))}</span></span>
        <span>ITP: ${v.itp_expiry ? `${fmtDate(v.itp_expiry)} ${itpChip(v.itpDays)}` : '<span class="muted">necunoscut</span>'}</span>
      </div>
      ${next ? `<div class="summary-box">
          <strong>Programare: ${fmtDate(next.date, { weekday: true })}, ora ${esc(next.time)}</strong>
          <span class="muted small">${esc(next.serviceName)} · cod ${esc(next.ref)}</span>
          <div class="row"><button class="btn sm danger" data-cancel="${next.id}">Anulează programarea</button></div>
        </div>`
        : '<div class="row"><a class="btn primary" href="/#programare">Programează ITP</a></div>'}
      <label class="check"><input type="checkbox" data-reminder="${v.id}" ${v.reminder_consent ? 'checked' : ''}>
        <span>Trimite-mi SMS înainte să expire ITP-ul</span></label>
      <div>
        <h3>Istoric ITP</h3>
        ${v.inspections.length ? v.inspections.map((i) => `<div class="insp">
            <div class="spread"><strong>${fmtDate(i.date)}</strong>
              ${i.result === 'admis' ? '<span class="chip ok">admis</span>' : '<span class="chip bad">respins</span>'}</div>
            <span class="small muted">${i.valid_until ? `Valabil până la ${fmtDate(i.valid_until)}` : ''}${i.price != null ? ` · ${i.price} lei` : ''}</span>
            ${photoGrid(i.photos)}
          </div>`).join('') : '<p class="muted small">Nicio inspecție la noi încă.</p>'}
      </div>
    </article>`;
  }).join('') : '<div class="card empty">Nu am găsit mașini pentru acest număr.</div>';
}

$('#phoneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('#phoneError');
  errorEl.hidden = true;
  phone = e.target.phone.value;
  try {
    await api('/api/client/code', { method: 'POST', body: { phone } });
    $('#codeInfo').textContent = `Dacă ${phone} are programări la noi, primești un SMS cu un cod de 6 cifre în câteva secunde.`;
    $('#phoneForm').hidden = true;
    $('#codeForm').hidden = false;
    $('#codeForm [name=code]').focus();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('#codeError');
  errorEl.hidden = true;
  try {
    await api('/api/client/login', { method: 'POST', body: { phone, code: e.target.code.value } });
    e.target.reset();
    load();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

$('#changePhone').addEventListener('click', () => {
  $('#codeForm').hidden = true;
  $('#phoneForm').hidden = false;
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/client/logout', { method: 'POST', body: {} });
  location.reload();
});

$('#vehicles').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cancel]');
  if (!btn) return;
  if (!(await confirmDialog('Sigur anulezi programarea?', 'Anulează programarea'))) return;
  try {
    await api(`/api/client/bookings/${btn.dataset.cancel}/cancel`, { method: 'POST', body: {} });
    toast('Programarea a fost anulată.');
    load();
  } catch (err) {
    toast(err.message);
  }
});

$('#vehicles').addEventListener('change', async (e) => {
  const cb = e.target.closest('[data-reminder]');
  if (!cb) return;
  try {
    await api(`/api/client/vehicles/${cb.dataset.reminder}`, { method: 'PATCH', body: { reminders: cb.checked } });
    toast(cb.checked ? 'Reminderul este activ.' : 'Nu îți mai trimitem remindere pentru această mașină.');
  } catch (err) {
    cb.checked = !cb.checked;
    toast(err.message);
  }
});

load();
