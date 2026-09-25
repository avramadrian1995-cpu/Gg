'use strict';

const state = { info: null, date: null, time: null };

function showStep(n) {
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== String(n); });
  $$('.steps li').forEach((li) => li.classList.toggle('on', li.dataset.step === String(n)));
  const card = $('#bookingCard');
  if (card.getBoundingClientRect().top < 0) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderInfo(info) {
  const s = info.station;
  $('#factAddress').textContent = s.address;
  $('#mapsLink').href = s.mapsUrl;
  const tel = `+40${s.phone.replace(/\D/g, '').replace(/^0/, '')}`;
  $('#heroPhone').href = `tel:${tel}`;
  $('#heroPhone').textContent = `Sună: ${s.phone}`;

  const todayDow = parseDay(info.today).getUTCDay();
  const h = info.hours[todayDow];
  $('#factToday').textContent = h ? `${DOW_LONG[todayDow]}: ${h[0]}–${h[1]}` : `${DOW_LONG[todayDow]}: închis`;

  $('#hoursList').innerHTML = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const hrs = info.hours[d];
    return `<tr class="${d === todayDow ? 'today' : ''}"><td>${DOW_LONG[d]}</td><td>${hrs ? `${hrs[0]} – ${hrs[1]}` : 'Închis'}</td></tr>`;
  }).join('');

  $('#priceList').innerHTML = info.services.map((sv) =>
    `<tr><td>${esc(sv.name)}</td><td>${sv.price ? `${sv.price} lei` : 'la cerere'}</td></tr>`).join('');

  $('#serviceSelect').innerHTML = info.services.map((sv) =>
    `<option value="${esc(sv.id)}">${esc(sv.name)}${sv.price ? ` – ${sv.price} lei` : ''}</option>`).join('');
}

async function loadDays() {
  const { days } = await api('/api/public/days');
  const el = $('#days');
  el.innerHTML = days.map((d) => {
    const day = parseDay(d.date);
    const label = !d.open ? 'închis' : d.free ? `${d.free} libere` : 'plin';
    return `<button type="button" class="day" data-date="${d.date}" aria-pressed="false" ${d.free ? '' : 'disabled'}
      aria-label="${fmtDate(d.date, { weekday: true })}, ${label}">
      <span class="dow">${DOW[day.getUTCDay()]}</span>
      <span class="num">${day.getUTCDate()}</span>
      <span class="free">${label}</span>
    </button>`;
  }).join('');
  const first = days.find((d) => d.free);
  if (first) selectDay(first.date);
}

async function selectDay(date) {
  state.date = date;
  state.time = null;
  $('#toStep2').disabled = true;
  $$('.day').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.date === date)));
  $('#slotsTitle').textContent = `Alege ora – ${fmtDate(date, { weekday: true })}`;
  const { slots } = await api(`/api/public/slots?date=${date}`);
  if (state.date !== date) return;
  $('#slotsEmpty').hidden = slots.length > 0;
  $('#slots').innerHTML = slots.map((t) =>
    `<button type="button" class="slot" data-time="${t}" aria-pressed="false">${t}</button>`).join('');
}

$('#days').addEventListener('click', (e) => {
  const btn = e.target.closest('.day');
  if (btn && !btn.disabled) selectDay(btn.dataset.date);
});

$('#slots').addEventListener('click', (e) => {
  const btn = e.target.closest('.slot');
  if (!btn) return;
  state.time = btn.dataset.time;
  $$('.slot').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  $('#toStep2').disabled = false;
});

$('#toStep2').addEventListener('click', () => {
  $('#slotSummary').innerHTML = `<strong>${fmtDate(state.date, { weekday: true })}, ora ${state.time}</strong>
    <span class="muted small">${esc(state.info.station.name)} · ${esc(state.info.station.address)}</span>`;
  showStep(2);
  $('#bookingForm [name=plate]').focus();
});

$('#backToStep1').addEventListener('click', () => showStep(1));

$('#bookingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const errorEl = $('#bookingError');
  errorEl.hidden = true;
  if (!data.plate.trim() || !data.name.trim() || !data.phone.trim()) {
    errorEl.textContent = 'Completează numărul mașinii, numele și telefonul.';
    errorEl.hidden = false;
    return;
  }
  const service = data.service || '';
  const btn = $('#submitBooking');
  btn.disabled = true;
  try {
    const booking = await api('/api/public/bookings', {
      method: 'POST',
      body: {
        ...data,
        consent: Boolean(data.consent),
        category: service === 'itp-n1' ? 'N1' : 'M1',
        fuel: service === 'itp-diesel' ? 'diesel' : 'benzina',
        usage: service === 'itp-taxi' ? 'taxi' : 'personal',
        date: state.date,
        time: state.time,
      },
    });
    const manageUrl = `${location.origin}/?ref=${booking.ref}&code=${encodeURIComponent(booking.cancelCode)}#programare`;
    $('#bookingDone').innerHTML = `
      <strong>Programare confirmată: ${fmtDate(booking.date, { weekday: true })}, ora ${booking.time}</strong>
      <span>${plate(booking.plate)} · Cod programare <strong>${esc(booking.ref)}</strong></span>
      <span class="muted">Ți-am trimis confirmarea prin SMS. Adu talonul, cartea de identitate a vehiculului (CIV) și RCA valabil.</span>
      <span class="small">Vezi programarea și istoricul ITP oricând în <a href="/cont/">Contul meu</a>, cu numărul de telefon.</span>
      <span class="small">Dacă nu mai poți ajunge, anulează din <a href="${esc(manageUrl)}">pagina programării</a>
        sau sună la ${esc(state.info.station.phone)}.</span>`;
    form.reset();
    showStep(3);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    if (err.status === 409) loadDays();
  } finally {
    btn.disabled = false;
  }
});

$('#newBooking').addEventListener('click', () => {
  showStep(1);
  loadDays();
});

// ----- manage an existing booking (?ref=…&code=…) -----

async function loadManage() {
  const params = new URLSearchParams(location.search);
  const ref = params.get('ref');
  const code = params.get('code');
  if (!ref || !code) return;
  $('#manageCard').hidden = false;
  const body = $('#manageBody');
  try {
    const b = await api(`/api/public/bookings/${encodeURIComponent(ref)}?code=${encodeURIComponent(code)}`);
    const statusText = { confirmed: 'Confirmată', cancelled: 'Anulată', done: 'Efectuată', no_show: 'Neprezentat' }[b.status];
    body.innerHTML = `
      <div class="summary-box">
        <span>${plate(b.plate)} · cod ${esc(b.ref)}</span>
        <strong>${fmtDate(b.date, { weekday: true })}, ora ${esc(b.time)}</strong>
        <span class="muted">Status: ${statusText}</span>
      </div>
      ${b.status === 'confirmed' ? '<div class="row"><button class="btn danger" id="cancelBooking">Anulează programarea</button></div>' : ''}`;
    $('#cancelBooking')?.addEventListener('click', async () => {
      if (!(await confirmDialog('Sigur anulezi programarea?', 'Anulează programarea'))) return;
      try {
        await api(`/api/public/bookings/${encodeURIComponent(ref)}/cancel`, { method: 'POST', body: { code } });
        toast('Programarea a fost anulată.');
        loadManage();
        loadDays();
      } catch (err) {
        toast(err.message);
      }
    });
  } catch (err) {
    body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ----- reminder sign-up -----

$('#reminderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const errorEl = $('#reminderError');
  errorEl.hidden = true;
  try {
    await api('/api/public/reminders', { method: 'POST', body: { ...data, consent: Boolean(data.consent) } });
    form.reset();
    toast('Gata! Îți trimitem SMS înainte să expire ITP-ul.');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

(async function init() {
  try {
    state.info = await api('/api/public/info');
    renderInfo(state.info);
    await loadDays();
    loadManage();
  } catch {
    $('#days').innerHTML = '<p class="error">Programările online nu sunt disponibile acum. Sunați la 0756 596 565.</p>';
  }
}());
