// Small DOM + API helpers shared by every screen.
export const S = { me: null, settings: null, today: '', channels: [], badges: {} };

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

export async function api(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opt);
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') window.dispatchEvent(new Event('sf-signed-out'));
    const err = new Error(data?.error || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
export const GET = (u) => api('GET', u);
export const POST = (u, b = {}) => api('POST', u, b);
export const PATCH = (u, b) => api('PATCH', u, b);
export const PUT = (u, b) => api('PUT', u, b);
export const DEL = (u) => api('DELETE', u);

// ---------- toasts / modal ----------
export function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 5000 : 2500);
}

export async function attempt(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r === undefined ? true : r;
  } catch (e) {
    toast(e.message, 'err');
    return false;
  }
}

export function modal(title, build) {
  const close = () => back.remove();
  const body = h('div', { class: 'modal-body' });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
    body);
  const back = h('div', { class: 'backdrop', onclick: (e) => e.target === back && close() }, box);
  document.body.append(back);
  build(body, close);
  const first = body.querySelector('input,select,textarea');
  if (first) first.focus();
  return close;
}

export function confirmBox(message, okLabel = 'Yes') {
  return new Promise((resolve) => {
    modal('Please confirm', (body, close) => {
      body.append(
        h('p', null, message),
        h('div', { class: 'row end' },
          h('button', { class: 'btn ghost', onclick: () => { close(); resolve(false); } }, 'Cancel'),
          h('button', { class: 'btn danger', onclick: () => { close(); resolve(true); } }, okLabel))
      );
    });
  });
}

// ---------- formatting (always in the property's timezone) ----------
const tzName = () => S.settings?.timezone || 'America/Los_Angeles';
export const fmtTime = (iso) =>
  iso ? new Intl.DateTimeFormat('en-US', { timeZone: tzName(), hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—';
export const fmtDateTime = (iso) =>
  iso ? new Intl.DateTimeFormat('en-US', { timeZone: tzName(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—';
export const fmtDay = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
};
export const fmtHrs = (n) => (Math.round(n * 100) / 100).toFixed(2);
export const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  if (m < 1440) return Math.round(m / 60) + ' hr ago';
  return Math.round(m / 1440) + ' d ago';
}
export function duration(fromIso, toIso) {
  const mins = Math.max(0, Math.round((Date.parse(toIso || new Date().toISOString()) - Date.parse(fromIso)) / 60000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}
export const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
export const weekStart = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return addDays(ymd, -((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7));
};

// Convert between an ISO instant and the "YYYY-MM-DDTHH:mm" text of a datetime-local input, in property time.
export function isoToLocalInput(iso) {
  if (!iso) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tzName(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(iso)).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function localInputToIso(text) {
  if (!text) return null;
  const [d, t] = text.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  let guess = Date.UTC(y, mo - 1, da, hh, mm);
  for (let i = 0; i < 2; i++) {
    const shown = isoToLocalInput(new Date(guess).toISOString());
    const [sd, st] = shown.split('T');
    const [sy, smo, sda] = sd.split('-').map(Number);
    const [shh, smm] = st.split(':').map(Number);
    guess += Date.UTC(y, mo - 1, da, hh, mm) - Date.UTC(sy, smo - 1, sda, shh, smm);
  }
  return new Date(guess).toISOString();
}

export const ROOM_LABEL = { dirty: 'Needs cleaning', in_progress: 'Being cleaned', review: 'Awaiting review', clean: 'Ready', out_of_order: 'Out of order' };
export const ASSIGN_LABEL = { assigned: 'To do', in_progress: 'In progress', submitted: 'Submitted', approved: 'Approved', rejected: 'Redo needed' };
export const pill = (cls, text) => h('span', { class: 'pill ' + cls }, text);

// ---------- photos ----------
// Shrinks big phone photos before upload so they go through on slow connections.
export async function shrinkImage(file, max = 1600, quality = 0.82) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    return blob || file;
  } catch {
    return file;
  }
}

export function photoPicker(label, onPick, { multiple = false } = {}) {
  const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    input.value = '';
    if (f) onPick(await shrinkImage(f));
  });
  return h('span', null, input, h('button', { class: 'btn', type: 'button', onclick: () => input.click() }, label));
}

export const photoUrl = (name) => '/uploads/' + name;
export function viewPhoto(name) {
  modal('Photo', (body) => body.append(h('img', { class: 'full-photo', src: photoUrl(name), alt: 'Uploaded photo' })));
}
