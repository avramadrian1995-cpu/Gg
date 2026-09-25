'use strict';

let today = null;
let settings = null;
let companies = [];

const STATUS = {
  confirmed: ['Confirmată', 'ok'],
  done: ['Efectuată', 'none'],
  no_show: ['Neprezentat', 'bad'],
  cancelled: ['Anulată', 'none'],
};
const SOURCE = { online: 'online', admin: 'telefon', fleet: 'flotă' };
const KIND = {
  booking_confirmed: 'Confirmare', booking_tomorrow: 'Programare mâine', itp_expiring: 'ITP expiră', review_request: 'Recenzie',
};

// ---------- auth ----------

async function start() {
  try {
    const me = await api('/api/auth/me');
    if (me.role !== 'admin') throw new Error();
    $('#userEmail').textContent = me.email;
    $('#userNav').hidden = false;
    $('#loginForm').hidden = true;
    $('#app').hidden = false;
    await loadStats();
    today = today || (await api('/api/public/info')).today;
    $('#bookingDate').value = today;
    loadBookings();
  } catch {
    $('#loginForm').hidden = false;
    $('#app').hidden = true;
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    await api('/api/auth/login', { method: 'POST', body: data });
    $('#loginError').hidden = true;
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

// ---------- tabs ----------

const loaders = {
  bookings: () => loadBookings(),
  vehicles: () => loadVehicles(),
  companies: () => loadCompanies(),
  outbox: () => loadOutbox(),
  settings: () => loadSettings(),
};

$('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  $$('.tabs [data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
  $$('[data-tabpanel]').forEach((p) => { p.hidden = p.dataset.tabpanel !== tab.dataset.tab; });
  loaders[tab.dataset.tab]();
});

// ---------- stats ----------

async function loadStats() {
  const s = await api('/api/admin/stats');
  today = s.today;
  const tiles = [
    ['Programări azi', s.bookingsToday],
    ['Următoarele 7 zile', s.bookingsWeek],
    ['Inspecții luna asta', s.inspectionsMonth],
    ['Încasări luna asta', `${Math.round(s.revenueMonth).toLocaleString('ro-RO')} lei`],
    ['ITP expiră în 30 zile', s.expiring30],
    ['Clienți cu SMS activ', `${s.withConsent} / ${s.vehicles}`],
  ];
  if (s.outboxFailed) tiles.push(['Mesaje eșuate', s.outboxFailed]);
  $('#stats').innerHTML = tiles.map(([label, value]) =>
    `<div class="stat"><div class="label">${label}</div><div class="value">${esc(value)}</div></div>`).join('');
}

// ---------- bookings ----------

let bookings = [];

async function loadBookings() {
  const date = $('#bookingDate').value || today;
  const data = await api(`/api/admin/bookings?from=${date}&to=${date}`);
  bookings = data.bookings;
  const active = bookings.filter((b) => b.status !== 'cancelled').length;
  $('#dayInfo').textContent = `${fmtDate(date, { weekday: true })} · ${active} ${active === 1 ? 'programare' : 'programări'}`;
  $('#bookingRows').innerHTML = bookings.length ? bookings.map((b) => {
    const [label, cls] = STATUS[b.status];
    const itpDays = b.itp_expiry ? Math.round((parseDay(b.itp_expiry) - parseDay(today)) / 86400000) : null;
    return `<tr class="${b.status === 'cancelled' ? 'dim' : ''}">
      <td class="num"><strong>${esc(b.time)}</strong></td>
      <td>${plate(b.plate)}<div class="small muted">${esc([b.model, b.year].filter(Boolean).join(' · '))}${b.company_name ? ` · ${esc(b.company_name)}` : ''}</div></td>
      <td>${esc(b.contact_name)}<div class="small muted">${esc(b.contact_phone)}</div></td>
      <td>${esc(b.serviceName)}<div class="small muted">${SOURCE[b.source] || b.source}</div></td>
      <td>${b.itp_expiry ? `${fmtDate(b.itp_expiry)}<div>${itpChip(itpDays)}</div>` : '<span class="muted">—</span>'}</td>
      <td><span class="chip ${cls}">${label}</span></td>
      <td>${b.status === 'confirmed' ? `<div class="row">
        <button class="btn sm primary" data-act="complete" data-id="${b.id}">Înregistrează ITP</button>
        <button class="btn sm" data-act="no_show" data-id="${b.id}">Nu a venit</button>
        <button class="btn sm danger" data-act="cancel" data-id="${b.id}">Anulează</button></div>` : ''}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">Nicio programare în această zi.</td></tr>';
}

$('#bookingDate').addEventListener('change', loadBookings);
$('#prevDay').addEventListener('click', () => { $('#bookingDate').value = addDays($('#bookingDate').value || today, -1); loadBookings(); });
$('#nextDay').addEventListener('click', () => { $('#bookingDate').value = addDays($('#bookingDate').value || today, 1); loadBookings(); });
$('#todayBtn').addEventListener('click', () => { $('#bookingDate').value = today; loadBookings(); });

$('#bookingRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const b = bookings.find((x) => String(x.id) === btn.dataset.id);
  try {
    if (btn.dataset.act === 'complete') {
      await completeBooking(b);
    } else if (btn.dataset.act === 'no_show') {
      await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { status: 'no_show' } });
      toast(`${b.plate} marcat ca neprezentat.`);
    } else if (btn.dataset.act === 'cancel') {
      if (!(await confirmDialog(`Anulezi programarea pentru ${b.plate} de la ${b.time}?`, 'Anulează programarea'))) return;
      await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { status: 'cancelled' } });
      toast('Programarea a fost anulată.');
    }
    loadBookings();
    loadStats();
  } catch (err) {
    toast(err.message);
  }
});

async function completeBooking(b) {
  const inspectionDay = today;
  const suggested = addMonths(inspectionDay, b.suggestedMonths);
  const service = settings?.services?.find((s) => s.id === b.service) || (await ensureSettings()).services.find((s) => s.id === b.service);
  const data = await formDialog(`
    <form method="dialog" class="stack">
      <h3>Înregistrează ITP – ${esc(b.plate)}</h3>
      <div class="fields">
        <label>Rezultat
          <select name="result"><option value="admis">Admis</option><option value="respins">Respins</option></select>
        </label>
        <label>Valabil până la
          <input type="date" name="validUntil" value="${suggested}">
        </label>
        <label>Preț încasat (lei)
          <input type="number" name="price" min="0" step="1" value="${service?.price ?? ''}">
        </label>
      </div>
      <p class="small muted">Sugestie: ${b.suggestedMonths} luni${b.year ? ` (an fabricație ${b.year})` : ''}. Verifică pe certificat și corectează dacă e cazul.</p>
      <label>Observații <input name="notes" maxlength="300"></label>
      <div class="row">
        <button class="btn ghost" value="cancel">Renunță</button>
        <button class="btn primary" value="ok">Salvează</button>
      </div>
    </form>`);
  if (!data) return;
  await api(`/api/admin/bookings/${b.id}/complete`, { method: 'POST', body: data });
  toast(data.result === 'admis' ? `ITP înregistrat. Următorul reminder pentru ${b.plate} este programat automat.` : 'Inspecție respinsă înregistrată.');
}

$('#newBookingBtn').addEventListener('click', async () => {
  const s = await ensureSettings();
  const date = $('#bookingDate').value || today;
  const { slots } = await api(`/api/public/slots?date=${date}`);
  if (!slots.length) { toast('Nu mai sunt intervale libere în această zi.'); return; }
  const data = await formDialog(`
    <form method="dialog" class="stack">
      <h3>Programare nouă – ${fmtDate(date, { weekday: true })}</h3>
      <div class="fields">
        <label>Ora <select name="time">${slots.map((t) => `<option>${t}</option>`).join('')}</select></label>
        <label>Număr înmatriculare <input name="plate" required></label>
        <label>Serviciu <select name="service">${s.services.map((sv) => `<option value="${esc(sv.id)}">${esc(sv.name)}</option>`).join('')}</select></label>
      </div>
      <div class="fields">
        <label>Nume client <input name="name"></label>
        <label>Telefon <input name="phone" type="tel"></label>
        <label>An fabricație <input name="year" type="number" min="1950" max="2100"></label>
      </div>
      <label class="check"><input type="checkbox" name="consent"> <span>Clientul este de acord cu SMS-uri de reminder</span></label>
      <div class="row">
        <button class="btn ghost" value="cancel">Renunță</button>
        <button class="btn primary" value="ok">Programează</button>
      </div>
    </form>`);
  if (!data) return;
  try {
    await api('/api/admin/bookings', {
      method: 'POST',
      body: {
        ...data,
        date,
        consent: Boolean(data.consent),
        category: data.service === 'itp-n1' ? 'N1' : 'M1',
        fuel: data.service === 'itp-diesel' ? 'diesel' : 'benzina',
        usage: data.service === 'itp-taxi' ? 'taxi' : 'personal',
      },
    });
    toast('Programare adăugată.');
    loadBookings();
    loadStats();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- vehicles ----------

let vehicles = [];
let searchTimer;

async function loadVehicles() {
  const q = encodeURIComponent($('#vehicleSearch').value);
  const data = await api(`/api/admin/vehicles?q=${q}&expiring=${$('#vehicleFilter').value}`);
  vehicles = data.vehicles;
  $('#vehicleRows').innerHTML = vehicles.length ? vehicles.map((v) => `<tr>
      <td>${plate(v.plate)}<div class="small muted">${esc([v.model, v.year, v.category, v.usage === 'taxi' ? 'taxi' : ''].filter(Boolean).join(' · '))}</div></td>
      <td>${esc(v.company_name || v.owner_name || '—')}</td>
      <td class="small">${esc(v.phone)}${v.email ? `<br>${esc(v.email)}` : ''}</td>
      <td>${v.itp_expiry ? `${fmtDate(v.itp_expiry)}<div>${itpChip(v.itpDays)}</div>` : '<span class="muted">—</span>'}</td>
      <td class="num">${v.last_inspection ? fmtDate(v.last_inspection) : '—'}</td>
      <td>${v.reminder_consent ? '<span class="chip ok">da</span>' : '<span class="chip none">nu</span>'}</td>
      <td><button class="btn sm" data-edit="${v.id}">Editează</button></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">Niciun vehicul găsit.</td></tr>';
}

$('#vehicleSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadVehicles, 250); });
$('#vehicleFilter').addEventListener('change', loadVehicles);

$('#vehicleRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-edit]');
  if (!btn) return;
  const v = vehicles.find((x) => String(x.id) === btn.dataset.edit);
  if (!companies.length) companies = (await api('/api/admin/companies')).companies;
  const sel = (name, value, opts) => `<select name="${name}">${opts.map(([val, label]) =>
    `<option value="${val}" ${String(val) === String(value) ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  const data = await formDialog(`
    <form method="dialog" class="stack">
      <h3>Editează ${esc(v.plate)}</h3>
      <div class="fields">
        <label>Număr <input name="plate" value="${esc(v.plate)}"></label>
        <label>Marcă / model <input name="model" value="${esc(v.model)}"></label>
        <label>An fabricație <input name="year" type="number" value="${esc(v.year ?? '')}"></label>
        <label>Categorie ${sel('category', v.category, [['M1', 'M1 autoturism'], ['N1', 'N1 utilitară']])}</label>
        <label>Combustibil ${sel('fuel', v.fuel, [['benzina', 'benzină'], ['diesel', 'diesel'], ['gpl', 'GPL'], ['hibrid', 'hibrid'], ['electric', 'electric']])}</label>
        <label>Utilizare ${sel('usage', v.usage, [['personal', 'personal'], ['firma', 'firmă'], ['taxi', 'taxi / ride-sharing']])}</label>
      </div>
      <div class="fields">
        <label>Proprietar <input name="name" value="${esc(v.owner_name)}"></label>
        <label>Telefon <input name="phone" value="${esc(v.phone)}"></label>
        <label>E-mail <input name="email" value="${esc(v.email)}"></label>
        <label>ITP expiră <input type="date" name="itpExpiry" value="${esc(v.itp_expiry || '')}"></label>
        <label>Firmă ${sel('companyId', v.company_id || '', [['', '—'], ...companies.map((c) => [c.id, esc(c.name)])])}</label>
      </div>
      <label class="check"><input type="checkbox" name="consent" ${v.reminder_consent ? 'checked' : ''}> <span>Acord SMS reminder</span></label>
      <label>Observații <input name="notes" value="${esc(v.notes)}"></label>
      <div class="row">
        <button class="btn ghost" value="cancel">Renunță</button>
        <button class="btn primary" value="ok">Salvează</button>
      </div>
    </form>`);
  if (!data) return;
  try {
    await api(`/api/admin/vehicles/${v.id}`, { method: 'PATCH', body: { ...data, consent: Boolean(data.consent) } });
    if (String(data.companyId || '') !== String(v.company_id || '')) {
      await api(`/api/admin/vehicles/${v.id}/company`, { method: 'POST', body: { companyId: data.companyId || null } });
    }
    toast('Vehicul actualizat.');
    loadVehicles();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- companies ----------

async function loadCompanies() {
  companies = (await api('/api/admin/companies')).companies;
  $('#companyRows').innerHTML = companies.length ? companies.map((c) => `<tr>
      <td><strong>${esc(c.name)}</strong><div class="small muted">${esc(c.phone || '')}</div></td>
      <td>${esc(c.cui || '—')}</td>
      <td class="small">${esc(c.users || '—')}</td>
      <td class="num">${c.vehicles}</td>
      <td>${c.expiring ? `<span class="chip warn">${c.expiring}</span>` : '<span class="chip ok">0</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">Nicio firmă încă. Adaugă prima flotă.</td></tr>';
}

$('#newCompanyBtn').addEventListener('click', async () => {
  const data = await formDialog(`
    <form method="dialog" class="stack">
      <h3>Firmă nouă</h3>
      <div class="fields">
        <label>Denumire <input name="name" required></label>
        <label>CUI <input name="cui"></label>
        <label>Telefon <input name="phone" type="tel"></label>
      </div>
      <h3>Cont în portalul de flote</h3>
      <div class="fields">
        <label>Persoană de contact <input name="contactName"></label>
        <label>E-mail (login) <input name="userEmail" type="email" required></label>
        <label>Parolă inițială (min. 10) <input name="userPassword" minlength="10" required></label>
      </div>
      <p class="small muted">Trimite datele de autentificare firmei. Contul are acces doar la vehiculele propriei firme.</p>
      <div class="row">
        <button class="btn ghost" value="cancel">Renunță</button>
        <button class="btn primary" value="ok">Creează</button>
      </div>
    </form>`);
  if (!data) return;
  try {
    await api('/api/admin/companies', { method: 'POST', body: data });
    toast('Firmă creată.');
    loadCompanies();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- outbox ----------

async function loadOutbox() {
  const status = $('#outboxFilter').value;
  const { messages } = await api(`/api/admin/outbox${status ? `?status=${status}` : ''}`);
  const label = { queued: ['în așteptare', 'warn'], sent: ['trimis', 'ok'], failed: ['eșuat', 'bad'] };
  $('#outboxRows').innerHTML = messages.length ? messages.map((m) => `<tr>
      <td class="num small">${esc(m.created_at.slice(0, 16))}</td>
      <td>${KIND[m.kind] || esc(m.kind)}${m.plate ? `<div>${plate(m.plate)}</div>` : ''}</td>
      <td>${m.channel.toUpperCase()}</td>
      <td class="small">${esc(m.recipient)}</td>
      <td class="small">${esc(m.body)}</td>
      <td><span class="chip ${label[m.status][1]}">${label[m.status][0]}</span>
        ${m.status === 'failed' ? `<div class="small error">${esc(m.error || '')}</div><button class="btn sm" data-retry="${m.id}">Reîncearcă</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">Niciun mesaj.</td></tr>';
}

$('#outboxFilter').addEventListener('change', loadOutbox);
$('#runOutbox').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/outbox/run', { method: 'POST', body: {} });
    toast(`${r.queued} mesaje noi, ${r.sent} trimise${r.failed ? `, ${r.failed} eșuate` : ''}.`);
    loadOutbox();
    loadStats();
  } catch (err) {
    toast(err.message);
  }
});
$('#outboxRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-retry]');
  if (!btn) return;
  await api(`/api/admin/outbox/${btn.dataset.retry}/retry`, { method: 'POST', body: {} });
  loadOutbox();
});

// ---------- settings ----------

async function ensureSettings() {
  if (!settings) settings = await api('/api/admin/settings');
  return settings;
}

function serviceRow(s = { id: '', name: '', price: '' }) {
  return `<div class="fields service-row">
    <label>Cod <input data-f="id" value="${esc(s.id)}" placeholder="itp-benzina"></label>
    <label>Denumire <input data-f="name" value="${esc(s.name)}"></label>
    <label>Preț (lei) <input data-f="price" type="number" min="0" value="${esc(s.price)}"></label>
  </div>`;
}

async function loadSettings() {
  settings = await api('/api/admin/settings');
  const f = $('#settingsForm');
  for (const [k, v] of Object.entries(settings.station)) {
    const input = f.elements[`station.${k}`];
    if (input) input.value = v;
  }
  f.elements.slotMinutes.value = String(settings.slotMinutes);
  f.elements.lanes.value = settings.lanes;
  f.elements.bookingDaysAhead.value = settings.bookingDaysAhead;
  f.elements.closedDates.value = settings.closedDates.join(', ');
  f.elements.reminderDays.value = settings.reminderDays.join(', ');
  f.elements.reviewRequest.checked = settings.reviewRequest;
  $('#hoursFields').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const h = settings.hours[d];
    return `<label>${DOW_LONG[d]}
      <input data-day="${d}" value="${h ? `${h[0]}-${h[1]}` : 'închis'}" placeholder="09:00-18:00 sau închis"></label>`;
  }).join('');
  $('#servicesFields').innerHTML = settings.services.map(serviceRow).join('');
}

$('#addService').addEventListener('click', () => $('#servicesFields').insertAdjacentHTML('beforeend', serviceRow()));

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const errorEl = $('#settingsError');
  errorEl.hidden = true;
  try {
    const hours = {};
    for (const input of $$('[data-day]', f)) {
      const val = input.value.trim().toLowerCase();
      if (!val || val.startsWith('închis') || val.startsWith('inchis')) { hours[input.dataset.day] = null; continue; }
      const m = val.match(/^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/);
      if (!m) throw new Error(`Programul pentru ${DOW_LONG[input.dataset.day]} trebuie scris ca 09:00-18:00 sau „închis”.`);
      hours[input.dataset.day] = [`${m[1].padStart(2, '0')}:${m[2]}`, `${m[3].padStart(2, '0')}:${m[4]}`];
    }
    const station = {};
    for (const k of Object.keys(settings.station)) station[k] = f.elements[`station.${k}`]?.value ?? settings.station[k];
    const services = $$('.service-row', f).map((row) => Object.fromEntries($$('[data-f]', row).map((i) => [i.dataset.f, i.value])))
      .filter((s) => s.name.trim());
    settings = await api('/api/admin/settings', {
      method: 'PUT',
      body: {
        station,
        hours,
        services,
        slotMinutes: Number(f.elements.slotMinutes.value),
        lanes: Number(f.elements.lanes.value),
        bookingDaysAhead: Number(f.elements.bookingDaysAhead.value),
        closedDates: f.elements.closedDates.value.split(/[\s,]+/).filter(Boolean),
        reminderDays: f.elements.reminderDays.value.split(/[\s,]+/).filter(Boolean).map(Number),
        reviewRequest: f.elements.reviewRequest.checked,
      },
    });
    toast('Setări salvate.');
    loadSettings();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    toast('Parola a fost schimbată.');
  } catch (err) {
    toast(err.message);
  }
});

start();
