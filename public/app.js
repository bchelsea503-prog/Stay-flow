import { S, h, GET, POST } from './util.js';
import { clockView, roomView, chatView, maintListView, maintNewView, maintDetailView, accountView } from './views-common.js';
import { myRoomsView } from './views-staff.js';
import {
  homeView, roomsBoardView, roomListView, hoursView, inventoryView, teamView, checklistView, settingsView,
} from './views-mgr.js';

const app = document.getElementById('app');
let cleanup = null;

// ---------- route table ----------
const MGR = ['owner', 'manager'], ALL = ['owner', 'manager', 'employee'];
const routes = [
  { path: 'home', roles: MGR, view: homeView },
  { path: 'rooms', roles: ['employee'], view: myRoomsView },
  { path: 'rooms', roles: MGR, view: roomsBoardView },
  { path: 'roomlist', roles: MGR, view: roomListView },
  { path: 'room', roles: ALL, view: roomView },
  { path: 'clock', roles: ALL, view: clockView },
  { path: 'hours', roles: MGR, view: hoursView },
  { path: 'inventory', roles: MGR, view: inventoryView },
  { path: 'team', roles: MGR, view: teamView },
  { path: 'checklist', roles: MGR, view: checklistView },
  { path: 'settings', roles: ['owner'], view: settingsView },
  { path: 'chat', roles: ALL, view: chatView },
  { path: 'maint', roles: ALL, view: (r, p) => (p[0] === 'new' ? maintNewView(r, p) : p[0] ? maintDetailView(r, p) : maintListView(r, p)) },
  { path: 'account', roles: ALL, view: accountView },
  { path: 'more', roles: MGR, view: moreView },
];

const NAV = {
  employee: [
    { to: 'rooms', icon: '🛏️', label: 'My rooms' }, { to: 'clock', icon: '⏱️', label: 'Clock' },
    { to: 'chat', icon: '💬', label: 'Chat', badge: 'chat' }, { to: 'maint', icon: '🔧', label: 'Maintenance' }, { to: 'account', icon: '👤', label: 'Me' },
  ],
  manager: [
    { to: 'home', icon: '📊', label: 'Home' }, { to: 'rooms', icon: '🛏️', label: 'Rooms', badge: 'review' },
    { to: 'hours', icon: '⏱️', label: 'Hours', desk: true }, { to: 'inventory', icon: '📦', label: 'Inventory', desk: true },
    { to: 'chat', icon: '💬', label: 'Chat', badge: 'chat' }, { to: 'maint', icon: '🔧', label: 'Repairs', badge: 'maintenance' },
    { to: 'team', icon: '👥', label: 'Team', desk: true }, { to: 'checklist', icon: '✅', label: 'Checklist', desk: true },
    { to: 'more', icon: '☰', label: 'More', mobile: true },
  ],
};
NAV.owner = [...NAV.manager.slice(0, -1), { to: 'settings', icon: '⚙️', label: 'Settings', desk: true }, NAV.manager.at(-1)];

async function moreView(root) {
  const items = [
    ['hours', '⏱️ Hours & payroll'], ['inventory', '📦 Inventory'], ['team', '👥 Team'], ['checklist', '✅ Cleaning checklist'],
    ['roomlist', '🚪 Room list'], S.me.role === 'owner' && ['settings', '⚙️ Settings'], ['account', '👤 My account'],
  ].filter(Boolean);
  root.append(h('h2', null, 'More'), h('ul', { class: 'cards' }, items.map(([to, label]) => h('li', null, h('a', { class: 'card link', href: '#/' + to }, label)))));
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart] = raw.split('?');
  const [name, ...params] = pathPart.split('/').filter(Boolean);
  return { name, params };
}

function defaultRoute() {
  return S.me.role === 'employee' ? 'rooms' : 'home';
}

async function render() {
  if (!S.me) return;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  let { name, params } = parseHash();
  if (!name) { location.replace('#/' + defaultRoute()); return; }
  const route = routes.find((r) => r.path === name && r.roles.includes(S.me.role));
  if (!route) { location.replace('#/' + defaultRoute()); return; }
  drawNav(name);
  const root = h('main', { class: 'view', id: 'view' });
  app.querySelector('#view')?.replaceWith(root);
  window.scrollTo(0, 0);
  try {
    cleanup = (await route.view(root, params)) || null;
  } catch (e) {
    root.replaceChildren(h('div', { class: 'note bad' }, e.message), h('button', { class: 'btn', onclick: render }, 'Try again'));
  }
  root.focus({ preventScroll: true });
}

function drawNav(active) {
  const items = NAV[S.me.role];
  const nav = document.getElementById('nav');
  nav.replaceChildren(...items.map((it) => {
    const n = S.badges[it.badge];
    const isActive = active === it.to || (it.to === 'more' && ['roomlist', 'account', 'hours', 'inventory', 'team', 'checklist', 'settings'].includes(active) && false);
    return h('a', { href: '#/' + it.to, class: (isActive ? 'on ' : '') + (it.desk ? 'desk ' : '') + (it.mobile ? 'mob ' : ''), 'aria-current': isActive ? 'page' : null },
      h('span', { class: 'ic', 'aria-hidden': 'true' }, it.icon), h('span', { class: 'lb' }, it.label), n ? h('b', { class: 'dot' }, n) : null);
  }));
}

async function refreshBadges() {
  if (!S.me) return;
  try { S.badges = await GET('/api/badges'); drawNav(parseHash().name); } catch { /* offline */ }
}

// ---------- login ----------
function showLogin(message) {
  S.me = null;
  if (cleanup) { cleanup(); cleanup = null; }
  const user = h('input', { id: 'u', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pass = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div', { class: 'note bad', hidden: !message }, message || '');
  app.replaceChildren(h('div', { class: 'login' },
    h('div', { class: 'logo', 'aria-hidden': 'true' }, '🌊'),
    h('h1', null, "Heidi's Inn"), h('p', { class: 'muted' }, 'Ilwaco, Washington · Stay Flow'),
    h('form', { class: 'card form', onsubmit: async (e) => {
      e.preventDefault();
      err.hidden = true;
      try { await POST('/api/login', { username: user.value, password: pass.value }); await start(); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; pass.value = ''; }
    } }, err, h('label', { for: 'u' }, 'Username', user), h('label', { for: 'p' }, 'Password', pass), h('button', { class: 'btn primary big' }, 'Sign in'))));
}

function shell() {
  app.replaceChildren(
    h('header', { class: 'top' }, h('span', { class: 'brand' }, '🌊 ', S.settings.property_name),
      h('span', { class: 'who' }, S.me.name, ' · ', S.me.role)),
    h('nav', { id: 'nav', 'aria-label': 'Main' }),
    h('main', { class: 'view', id: 'view' }));
}

let started = false;
async function start() {
  try {
    const me = await GET('/api/me');
    Object.assign(S, { me: me.user, settings: me.settings, today: me.today, channels: me.channels });
  } catch {
    return showLogin();
  }
  shell();
  await refreshBadges();
  if (!started) {
    started = true;
    window.addEventListener('hashchange', render);
    setInterval(refreshBadges, 20000);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshBadges());
    window.addEventListener('sf-badges', refreshBadges);
  }
  if (!location.hash) location.replace('#/' + defaultRoute());
  render();
}

window.addEventListener('sf-signed-out', () => { if (S.me) showLogin('Your session ended. Please sign in again.'); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
