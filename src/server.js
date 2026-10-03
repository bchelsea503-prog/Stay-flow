const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { db, tx, log, getSettings, UPLOAD_DIR, DATA_DIR, CHANNELS } = require('./db');
const { localDate, addDays, weekStart, isYmd, hoursBetween } = require('./time');
const playbook = require('./playbook');

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '0' ? false : 1);
app.disable('x-powered-by');

// ---------- helpers ----------
const now = () => new Date().toISOString();
const nowMs = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HttpError = (status, msg) => Object.assign(new Error(msg), { status });
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v) => (Number.isInteger(Number(v)) && v !== '' && v !== null ? Number(v) : null);
const num = (v) => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
const tz = () => getSettings().timezone;
const today = () => localDate(tz());
const r2 = (n) => Math.round(n * 100) / 100;

function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 6) throw HttpError(400, 'Password must be at least 6 characters');
  if (p.length > 200) throw HttpError(400, 'Password too long');
}

// ---------- security headers ----------
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// ---------- auth ----------
const COOKIE = 'sf_session';
const SESSION_DAYS = 30;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const failures = new Map(); // key -> {n, until}

function throttleKey(req, username) {
  return `${req.ip}|${String(username).toLowerCase()}`;
}

function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(nowMs() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(token), userId, exp);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: SESSION_DAYS * 86400000,
    path: '/',
  });
}

function loadUser(req, _res, next) {
  const token = req.cookies[COOKIE];
  if (token) {
    const row = db
      .prepare(
        `SELECT u.id,u.name,u.username,u.role,u.active,u.phone,u.hourly_rate FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE s.token_hash=? AND s.expires_at>?`
      )
      .get(sha(token), now());
    if (row && row.active) req.user = row;
  }
  next();
}
app.use(loadUser);

const need = (...roles) => (req, _res, next) => {
  if (!req.user) return next(HttpError(401, 'Please sign in'));
  if (roles.length && !roles.includes(req.user.role)) return next(HttpError(403, 'Not allowed'));
  next();
};
const anyUser = need();
const mgr = need('owner', 'manager');
const owner = need('owner');

app.post('/api/login', (req, res) => {
  const username = str(req.body.username, 80);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const key = throttleKey(req, username);
  const f = failures.get(key);
  if (f && f.n >= 8 && f.until > nowMs()) throw HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  // compare against a dummy hash when user is missing to keep timing similar
  const ok = bcrypt.compareSync(password, u ? u.pass_hash : DUMMY_HASH);
  if (!u || !ok) {
    failures.set(key, { n: (f && f.until > nowMs() ? f.n : 0) + 1, until: nowMs() + 15 * 60000 });
    throw HttpError(401, 'Wrong username or password');
  }
  failures.delete(key);
  createSession(res, req, u.id);
  log(u.id, 'login');
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const t = req.cookies[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(t));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', anyUser, (req, res) => {
  const { id, name, username, role, phone } = req.user;
  const s = getSettings();
  res.json({
    user: { id, name, username, role, phone },
    settings: {
      property_name: s.property_name,
      timezone: s.timezone,
      min_photos: Number(s.min_photos),
      require_clock_in: s.require_clock_in === '1',
    },
    today: today(),
    channels: CHANNELS.map((c) => ({ ...c, canPost: c.postRoles.includes(role) })),
  });
});

app.post('/api/me/password', anyUser, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.current || ''), u.pass_hash)) throw HttpError(400, 'Current password is wrong');
  validatePassword(req.body.next);
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(req.body.next, 10), u.id);
  // sign out other devices
  const t = req.cookies[COOKIE];
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(u.id, sha(t));
  log(u.id, 'password_changed');
  res.json({ ok: true });
});

// ---------- uploads ----------
const MAGIC = [
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { ext: 'png', test: (b) => b.slice(0, 4).toString('hex') === '89504e47' },
  { ext: 'webp', test: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  { ext: 'heic', test: (b) => b.slice(4, 8).toString() === 'ftyp' },
];
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + '.tmp'),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// Verifies the uploaded file really is an image and renames it with the proper extension.
function finalizeUpload(file) {
  if (!file) return null;
  const fd = fs.openSync(file.path, 'r');
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  const kind = MAGIC.find((m) => m.test(buf));
  if (!kind) {
    fs.unlinkSync(file.path);
    throw HttpError(400, 'That file is not a supported image (use JPG, PNG, WebP or HEIC)');
  }
  const name = file.filename.replace(/\.tmp$/, '.' + kind.ext);
  fs.renameSync(file.path, path.join(UPLOAD_DIR, name));
  return name;
}

function dropUpload(name) {
  if (name && /^[a-f0-9]{32}\.(jpg|png|webp|heic)$/.test(name)) fs.rm(path.join(UPLOAD_DIR, name), () => {});
}

app.get('/uploads/:name', anyUser, (req, res, next) => {
  const m = /^[a-f0-9]{32}\.(jpg|png|webp|heic)$/.exec(req.params.name);
  if (!m) return next(HttpError(404, 'Not found'));
  const file = path.join(UPLOAD_DIR, req.params.name);
  if (!fs.existsSync(file)) return next(HttpError(404, 'Not found'));
  res.set({ 'Content-Type': MIME[m[1]], 'Cache-Control': 'private, max-age=86400' });
  fs.createReadStream(file).pipe(res);
});

// ---------- users ----------
const userCols = (viewer) =>
  'id,name,username,role,phone,active,created_at' + (viewer.role === 'owner' ? ',hourly_rate' : '');

app.get('/api/users', mgr, (req, res) => {
  res.json(db.prepare(`SELECT ${userCols(req.user)} FROM users ORDER BY active DESC, role, name`).all());
});

// Light list for pickers (assign room, assign maintenance)
app.get('/api/staff', anyUser, (_req, res) => {
  res.json(db.prepare('SELECT id,name,role FROM users WHERE active=1 ORDER BY name').all());
});

app.post('/api/users', mgr, (req, res) => {
  const role = str(req.body.role, 20) || 'employee';
  if (!['manager', 'employee'].includes(role)) throw HttpError(400, 'Role must be manager or employee');
  if (role === 'manager' && req.user.role !== 'owner') throw HttpError(403, 'Only the owner can add managers');
  const name = str(req.body.name, 80);
  const username = str(req.body.username, 40).toLowerCase();
  if (!name) throw HttpError(400, 'Name is required');
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw HttpError(400, 'Username: 3-40 letters, numbers, . _ -');
  validatePassword(req.body.password);
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw HttpError(409, 'That username is taken');
  const rate = req.user.role === 'owner' ? Math.max(0, num(req.body.hourly_rate) ?? 0) : 0;
  const r = db
    .prepare('INSERT INTO users (name,username,pass_hash,role,hourly_rate,phone) VALUES (?,?,?,?,?,?)')
    .run(name, username, bcrypt.hashSync(req.body.password, 10), role, rate, str(req.body.phone, 40));
  log(req.user.id, 'user_created', `${name} (${role})`);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.patch('/api/users/:id', mgr, (req, res) => {
  const id = int(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) throw HttpError(404, 'No such user');
  const isOwner = req.user.role === 'owner';
  if (!isOwner && u.role !== 'employee') throw HttpError(403, 'Managers can only edit employees');
  if (u.id === req.user.id && req.body.active === false) throw HttpError(400, "You can't deactivate yourself");
  const b = req.body;
  const name = b.name !== undefined ? str(b.name, 80) || u.name : u.name;
  const phone = b.phone !== undefined ? str(b.phone, 40) : u.phone;
  let active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
  let rate = u.hourly_rate;
  if (isOwner && b.hourly_rate !== undefined) rate = Math.max(0, num(b.hourly_rate) ?? u.hourly_rate);
  let role = u.role;
  if (isOwner && b.role && u.role !== 'owner' && ['manager', 'employee'].includes(b.role)) role = b.role;
  db.prepare('UPDATE users SET name=?,phone=?,active=?,hourly_rate=?,role=? WHERE id=?').run(name, phone, active, rate, role, id);
  if (b.password) {
    validatePassword(b.password);
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(bcrypt.hashSync(b.password, 10), id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  log(req.user.id, 'user_updated', `${u.name}${b.password ? ' (password reset)' : ''}${!active ? ' (deactivated)' : ''}`);
  res.json({ ok: true });
});

// ---------- time clock ----------
// All timestamps are taken from the server clock, never from the device.
function openEntry(userId) {
  return db.prepare('SELECT * FROM clock_entries WHERE user_id=? AND clock_out IS NULL AND voided=0 ORDER BY id DESC').get(userId);
}
const openBreak = (entryId) => db.prepare('SELECT * FROM breaks WHERE entry_id=? AND end_at IS NULL').get(entryId);

function breakMinutes(entryId, until) {
  return db.prepare('SELECT start_at,end_at FROM breaks WHERE entry_id=?').all(entryId)
    .reduce((a, b) => a + hoursBetween(b.start_at, b.end_at || until) * 60, 0);
}

function hasSigned(userId) {
  return !!db.prepare('SELECT 1 FROM acknowledgments WHERE user_id=? AND version=?').get(userId, playbook.VERSION);
}

app.get('/api/clock/status', anyUser, (req, res) => {
  const open = openEntry(req.user.id);
  const t = today();
  const recent = db
    .prepare('SELECT id,clock_in,clock_out FROM clock_entries WHERE user_id=? AND voided=0 ORDER BY clock_in DESC LIMIT 14')
    .all(req.user.id);
  const z = tz();
  const unpaid = getSettings().break_unpaid === '1';
  const n = now();
  let todayHours = 0;
  for (const e of recent) {
    if (localDate(z, new Date(e.clock_in)) !== t) continue;
    todayHours += hoursBetween(e.clock_in, e.clock_out || n) - (unpaid ? breakMinutes(e.id, n) / 60 : 0);
  }
  let brk = null;
  if (open) {
    const b = openBreak(open.id);
    brk = { on_break: !!b, since: b?.start_at || null, minutes_today: Math.round(breakMinutes(open.id, n)) };
  }
  res.json({
    open: open ? { id: open.id, clock_in: open.clock_in } : null,
    break: brk, today_hours: r2(Math.max(0, todayHours)), recent,
    needs_ack: req.user.role === 'employee' && getSettings().require_ack === '1' && !hasSigned(req.user.id),
  });
});

app.post('/api/clock/in', anyUser, (req, res) => {
  if (openEntry(req.user.id)) throw HttpError(409, "You're already clocked in");
  if (req.user.role === 'employee' && getSettings().require_ack === '1' && !hasSigned(req.user.id))
    throw HttpError(409, 'Please read and sign the Employee Acknowledgment first. Open it from the link on the Clock screen or Me > SOP Playbook.');
  db.prepare('INSERT INTO clock_entries (user_id,clock_in) VALUES (?,?)').run(req.user.id, now());
  log(req.user.id, 'clock_in');
  res.json({ ok: true });
});

app.post('/api/clock/break/start', anyUser, (req, res) => {
  const e = openEntry(req.user.id);
  if (!e) throw HttpError(409, "You're not clocked in");
  if (openBreak(e.id)) throw HttpError(409, "You're already on a break");
  db.prepare('INSERT INTO breaks (entry_id,user_id,start_at) VALUES (?,?,?)').run(e.id, req.user.id, now());
  log(req.user.id, 'break_start');
  res.json({ ok: true });
});

app.post('/api/clock/break/end', anyUser, (req, res) => {
  const e = openEntry(req.user.id);
  const b = e && openBreak(e.id);
  if (!b) throw HttpError(409, "You're not on a break");
  db.prepare('UPDATE breaks SET end_at=? WHERE id=?').run(now(), b.id);
  log(req.user.id, 'break_end');
  res.json({ ok: true });
});

app.post('/api/clock/out', anyUser, (req, res) => {
  const e = openEntry(req.user.id);
  if (!e) throw HttpError(409, "You're not clocked in");
  const busy = db
    .prepare("SELECT COUNT(*) c FROM assignments WHERE user_id=? AND status='in_progress'")
    .get(req.user.id).c;
  if (busy && !req.body.force) throw HttpError(409, `You still have ${busy} room(s) started but not submitted. Clock out anyway?`);
  const t = now();
  tx(() => {
    db.prepare('UPDATE breaks SET end_at=? WHERE entry_id=? AND end_at IS NULL').run(t, e.id);
    db.prepare('UPDATE clock_entries SET clock_out=? WHERE id=?').run(t, e.id);
  });
  log(req.user.id, 'clock_out');
  res.json({ ok: true });
});

function validIso(s) {
  return typeof s === 'string' && !isNaN(Date.parse(s)) ? new Date(s).toISOString() : null;
}
function needReason(v) {
  const r = str(v, 300);
  if (r.length < 3) throw HttpError(400, 'A reason is required for every timecard correction');
  return r;
}

// Entries for a date range with break totals and discrepancy flags.
function entriesFor(from, to, userId) {
  const s = getSettings();
  const z = s.timezone;
  const maxBreak = Number(s.max_break_minutes) || 30;
  const forgot = Number(s.forgotten_clockout_hours) || 14;
  const n = now();
  let rows = db
    .prepare(
      `SELECT c.*, u.name FROM clock_entries c JOIN users u ON u.id=c.user_id
       WHERE c.voided=0 AND c.clock_in >= ? AND c.clock_in <= ? ORDER BY c.clock_in DESC`
    )
    .all(addDays(from, -1) + 'T00:00:00Z', addDays(to, 2) + 'T00:00:00Z')
    .filter((e) => {
      const d = localDate(z, new Date(e.clock_in));
      return d >= from && d <= to;
    });
  if (userId) rows = rows.filter((e) => e.user_id === userId);
  const brk = db.prepare('SELECT start_at,end_at FROM breaks WHERE entry_id=?');
  for (const e of rows) {
    const bs = brk.all(e.id);
    e.break_minutes = Math.round(bs.reduce((a, b) => a + hoursBetween(b.start_at, b.end_at || n) * 60, 0));
    e.flags = [];
    if (!e.clock_out && hoursBetween(e.clock_in, n) > forgot) e.flags.push('Missed clock-out?');
    if (bs.some((b) => hoursBetween(b.start_at, b.end_at || n) * 60 > maxBreak)) e.flags.push(`Break over ${maxBreak} min`);
    e.edited = !!db.prepare('SELECT 1 FROM clock_edits WHERE entry_id=?').get(e.id);
  }
  return rows;
}

app.get('/api/clock/entries', mgr, (req, res) => {
  const t = today();
  const from = isYmd(req.query.from) ? req.query.from : addDays(t, -13);
  const to = isYmd(req.query.to) ? req.query.to : t;
  res.json(entriesFor(from, to, int(req.query.user_id)));
});

app.get('/api/clock/entries/:id/history', mgr, (req, res) => {
  res.json(db.prepare(
    `SELECT e.*, u.name AS editor FROM clock_edits e JOIN users u ON u.id=e.edited_by WHERE e.entry_id=? ORDER BY e.id DESC`
  ).all(int(req.params.id)));
});

function checkTimes(cin, cout, rawOut) {
  if (!cin || (rawOut && !cout)) throw HttpError(400, 'Invalid time');
  if (cout && Date.parse(cout) <= Date.parse(cin)) throw HttpError(400, 'Clock-out must be after clock-in');
  if (cout && hoursBetween(cin, cout) > 24) throw HttpError(400, "A single shift can't be longer than 24 hours");
}

app.post('/api/clock/entries', mgr, (req, res) => {
  const uid = int(req.body.user_id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if (!u) throw HttpError(400, 'Pick an employee');
  const reason = needReason(req.body.reason);
  const cin = validIso(req.body.clock_in);
  const cout = req.body.clock_out ? validIso(req.body.clock_out) : null;
  checkTimes(cin, cout, req.body.clock_out);
  tx(() => {
    const r = db.prepare("INSERT INTO clock_entries (user_id,clock_in,clock_out,note,source,edited_by) VALUES (?,?,?,?,'manual',?)")
      .run(uid, cin, cout, reason, req.user.id);
    db.prepare('INSERT INTO clock_edits (entry_id,edited_by,action,reason,new_in,new_out) VALUES (?,?,?,?,?,?)')
      .run(Number(r.lastInsertRowid), req.user.id, 'added', reason, cin, cout);
  });
  log(req.user.id, 'time_added', `${u.name}: ${reason}`);
  res.json({ ok: true });
});

app.patch('/api/clock/entries/:id', mgr, (req, res) => {
  const e = db.prepare('SELECT c.*,u.name FROM clock_entries c JOIN users u ON u.id=c.user_id WHERE c.id=? AND c.voided=0').get(int(req.params.id));
  if (!e) throw HttpError(404, 'No such entry');
  const reason = needReason(req.body.reason);
  const cin = req.body.clock_in !== undefined ? validIso(req.body.clock_in) : e.clock_in;
  let cout = e.clock_out;
  if (req.body.clock_out !== undefined) cout = req.body.clock_out ? validIso(req.body.clock_out) : null;
  checkTimes(cin, cout, req.body.clock_out);
  tx(() => {
    db.prepare('INSERT INTO clock_edits (entry_id,edited_by,action,reason,old_in,old_out,new_in,new_out) VALUES (?,?,?,?,?,?,?,?)')
      .run(e.id, req.user.id, 'edited', reason, e.clock_in, e.clock_out, cin, cout);
    db.prepare('UPDATE clock_entries SET clock_in=?,clock_out=?,edited_by=? WHERE id=?').run(cin, cout, req.user.id, e.id);
  });
  log(req.user.id, 'time_edited', `${e.name}: ${reason}`);
  res.json({ ok: true });
});

// Entries are never deleted: voiding hides them from totals but keeps the record and who/why.
app.post('/api/clock/entries/:id/void', mgr, (req, res) => {
  const e = db.prepare('SELECT c.*,u.name FROM clock_entries c JOIN users u ON u.id=c.user_id WHERE c.id=? AND c.voided=0').get(int(req.params.id));
  if (!e) throw HttpError(404, 'No such entry');
  const reason = needReason(req.body.reason);
  tx(() => {
    db.prepare('INSERT INTO clock_edits (entry_id,edited_by,action,reason,old_in,old_out) VALUES (?,?,?,?,?,?)')
      .run(e.id, req.user.id, 'voided', reason, e.clock_in, e.clock_out);
    db.prepare('UPDATE clock_entries SET voided=1, void_reason=?, edited_by=? WHERE id=?').run(reason, req.user.id, e.id);
  });
  log(req.user.id, 'time_voided', `${e.name}: ${reason}`);
  res.json({ ok: true });
});

// ---------- hours report ----------
function hoursReport(from, to, withPay) {
  const s = getSettings();
  const z = s.timezone;
  const otLimit = Number(s.overtime_weekly_hours) || 40;
  const unpaidBreaks = s.break_unpaid === '1';
  const entries = db
    .prepare(
      `SELECT c.*, u.name, u.hourly_rate, u.role FROM clock_entries c JOIN users u ON u.id=c.user_id
       WHERE c.voided=0 AND c.clock_in >= ? AND c.clock_in <= ? ORDER BY c.clock_in`
    )
    .all(addDays(from, -1) + 'T00:00:00Z', addDays(to, 2) + 'T00:00:00Z');
  const byUser = new Map();
  const t = now();
  for (const e of entries) {
    const d = localDate(z, new Date(e.clock_in));
    if (d < from || d > to) continue;
    let hrs = hoursBetween(e.clock_in, e.clock_out || t);
    const brk = breakMinutes(e.id, t) / 60;
    if (unpaidBreaks) hrs = Math.max(0, hrs - brk);
    let u = byUser.get(e.user_id);
    if (!u) {
      u = { id: e.user_id, name: e.name, role: e.role, rate: e.hourly_rate, hours: 0, breaks: 0, days: {}, weeks: {}, open: false };
      byUser.set(e.user_id, u);
    }
    u.hours += hrs;
    u.breaks += brk;
    u.days[d] = (u.days[d] || 0) + hrs;
    const wk = weekStart(d);
    u.weeks[wk] = (u.weeks[wk] || 0) + hrs;
    if (!e.clock_out) u.open = true;
  }
  const users = [...byUser.values()].map((u) => {
    let overtime = 0;
    for (const h of Object.values(u.weeks)) overtime += Math.max(0, h - otLimit);
    const regular = u.hours - overtime;
    const out = {
      id: u.id, name: u.name, role: u.role, open: u.open,
      hours: r2(u.hours), regular: r2(regular), overtime: r2(overtime), break_hours: r2(u.breaks),
      days: Object.fromEntries(Object.entries(u.days).map(([k, v]) => [k, r2(v)])),
    };
    if (withPay) {
      out.rate = u.rate;
      out.pay = r2(regular * u.rate + overtime * u.rate * 1.5);
    }
    return out;
  });
  users.sort((a, b) => a.name.localeCompare(b.name));
  const totals = {
    hours: r2(users.reduce((a, u) => a + u.hours, 0)),
    overtime: r2(users.reduce((a, u) => a + u.overtime, 0)),
  };
  if (withPay) totals.pay = r2(users.reduce((a, u) => a + u.pay, 0));
  return { from, to, overtime_weekly_hours: otLimit, breaks_unpaid: unpaidBreaks, users, totals };
}

function rangeFromQuery(q) {
  const t = today();
  const from = isYmd(q.from) ? q.from : weekStart(t);
  const to = isYmd(q.to) ? q.to : t;
  if (from > to) throw HttpError(400, 'Start date is after end date');
  if (Date.parse(to) - Date.parse(from) > 400 * 86400000) throw HttpError(400, 'Range too long');
  return { from, to };
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

app.get('/api/reports/hours', mgr, (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const rep = hoursReport(from, to, req.user.role === 'owner');
  if (req.query.format === 'csv') {
    const pay = req.user.role === 'owner';
    const lines = [['Employee', 'Regular hrs', 'Overtime hrs', 'Total hrs', 'Break hrs (' + (rep.breaks_unpaid ? 'unpaid, excluded' : 'paid, included') + ')'].concat(pay ? ['Rate', 'Gross pay'] : [])];
    for (const u of rep.users) lines.push([u.name, u.regular, u.overtime, u.hours, u.break_hours].concat(pay ? [u.rate, u.pay] : []));
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="hours_${from}_to_${to}.csv"`,
    });
    return res.send(lines.map((l) => l.map(csvCell).join(',')).join('\n'));
  }
  res.json(rep);
});

// ---------- rooms ----------
app.get('/api/rooms', anyUser, (req, res) => {
  const rows = db.prepare('SELECT * FROM rooms WHERE active=1 ORDER BY CAST(number AS INTEGER), number').all();
  res.json(rows);
});

const ROOM_STATUS = ['dirty', 'in_progress', 'review', 'clean', 'out_of_order'];

app.post('/api/rooms', mgr, (req, res) => {
  // accepts a single room or "numbers": "101, 102, 103"
  const nums = str(req.body.numbers || req.body.number, 2000)
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200);
  if (!nums.length) throw HttpError(400, 'Enter a room number');
  const type = str(req.body.type, 40) || 'standard';
  let added = 0;
  tx(() => {
    for (const n of nums) {
      if (n.length > 20) continue;
      const ex = db.prepare('SELECT id,active FROM rooms WHERE number=?').get(n);
      if (ex) {
        if (!ex.active) { db.prepare('UPDATE rooms SET active=1,type=? WHERE id=?').run(type, ex.id); added++; }
        continue;
      }
      db.prepare('INSERT INTO rooms (number,type,status) VALUES (?,?,?)').run(n, type, 'clean');
      added++;
    }
  });
  log(req.user.id, 'rooms_added', nums.join(', '));
  res.json({ added });
});

app.patch('/api/rooms/:id', mgr, (req, res) => {
  const r = db.prepare('SELECT * FROM rooms WHERE id=?').get(int(req.params.id));
  if (!r) throw HttpError(404, 'No such room');
  const type = req.body.type !== undefined ? str(req.body.type, 40) || r.type : r.type;
  const notes = req.body.notes !== undefined ? str(req.body.notes, 500) : r.notes;
  let status = r.status;
  if (req.body.status !== undefined) {
    if (!ROOM_STATUS.includes(req.body.status)) throw HttpError(400, 'Bad status');
    status = req.body.status;
  }
  db.prepare('UPDATE rooms SET type=?,notes=?,status=? WHERE id=?').run(type, notes, status, r.id);
  if (status !== r.status) log(req.user.id, 'room_status', `Room ${r.number}: ${r.status} → ${status}`);
  res.json({ ok: true });
});

app.delete('/api/rooms/:id', owner, (req, res) => {
  const r = db.prepare('SELECT * FROM rooms WHERE id=?').get(int(req.params.id));
  if (!r) throw HttpError(404, 'No such room');
  db.prepare('UPDATE rooms SET active=0 WHERE id=?').run(r.id); // soft delete keeps history
  log(req.user.id, 'room_removed', r.number);
  res.json({ ok: true });
});

app.post('/api/rooms/mark-dirty', mgr, (req, res) => {
  const ids = Array.isArray(req.body.room_ids) ? req.body.room_ids.map(int).filter(Boolean) : [];
  let n = 0;
  tx(() => {
    for (const id of ids) n += Number(db.prepare("UPDATE rooms SET status='dirty' WHERE id=? AND status='clean'").run(id).changes);
  });
  res.json({ updated: n });
});

// ---------- checklist template ----------
// Managers can view the standard; only the owner edits it (PRD: "edit playbook standards").
const SCOPES = ['all', 'checkout', 'deep'];

app.get('/api/checklist', mgr, (_req, res) => {
  res.json(db.prepare('SELECT * FROM checklist_items WHERE active=1 ORDER BY room_type, position, id').all());
});

app.post('/api/checklist', owner, (req, res) => {
  const text = str(req.body.text, 200);
  if (!text) throw HttpError(400, 'Describe the task');
  const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM checklist_items').get().p;
  const scope = SCOPES.includes(req.body.scope) ? req.body.scope : 'all';
  const r = db
    .prepare('INSERT INTO checklist_items (room_type,section,text,position,scope) VALUES (?,?,?,?,?)')
    .run(str(req.body.room_type, 40), str(req.body.section, 40), text, pos, scope);
  log(req.user.id, 'checklist_added', text);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.patch('/api/checklist/:id', owner, (req, res) => {
  const it = db.prepare('SELECT * FROM checklist_items WHERE id=?').get(int(req.params.id));
  if (!it) throw HttpError(404, 'No such item');
  const b = req.body;
  db.prepare('UPDATE checklist_items SET text=?,room_type=?,section=?,scope=?,position=? WHERE id=?').run(
    b.text !== undefined ? str(b.text, 200) || it.text : it.text,
    b.room_type !== undefined ? str(b.room_type, 40) : it.room_type,
    b.section !== undefined ? str(b.section, 40) : it.section,
    SCOPES.includes(b.scope) ? b.scope : it.scope,
    b.position !== undefined ? int(b.position) ?? it.position : it.position,
    it.id
  );
  log(req.user.id, 'checklist_edited', it.text);
  res.json({ ok: true });
});

app.delete('/api/checklist/:id', owner, (req, res) => {
  // Deactivate rather than delete so past inspections keep their records.
  db.prepare('UPDATE checklist_items SET active=0 WHERE id=?').run(int(req.params.id));
  log(req.user.id, 'checklist_removed', String(req.params.id));
  res.json({ ok: true });
});

// ---------- assignments (room cleaning) ----------
const ASSIGN_SELECT = `
  SELECT a.*, r.number AS room_number, r.type AS room_type, r.notes AS room_notes, u.name AS user_name,
    (SELECT COUNT(*) FROM assignment_checks c WHERE c.assignment_id=a.id) AS checks_total,
    (SELECT COUNT(*) FROM assignment_checks c WHERE c.assignment_id=a.id AND c.done=1) AS checks_done,
    (SELECT COUNT(*) FROM assignment_photos p WHERE p.assignment_id=a.id) AS photo_count
  FROM assignments a JOIN rooms r ON r.id=a.room_id JOIN users u ON u.id=a.user_id`;

// Target minutes (upper end of the SOP range) for a cleaning.
function targetMax(a, s = getSettings()) {
  if (a.clean_type === 'stayover') return Number(s.target_stayover_max) || 20;
  if (a.clean_type === 'deep') return null; // the SOP sets no deep-clean target
  return /suite|kitchen/i.test(a.room_type || '') ? Number(s.target_suite_max) || 45 : Number(s.target_checkout_max) || 35;
}

app.get('/api/assignments', anyUser, (req, res) => {
  const t = today();
  if (req.user.role === 'employee') {
    // Today's rooms plus anything from earlier days that never got finished.
    const rows = db
      .prepare(
        `${ASSIGN_SELECT} WHERE a.user_id=? AND (a.date=? OR (a.date<? AND a.status IN ('assigned','in_progress','rejected')))
         ORDER BY CAST(r.number AS INTEGER), r.number`
      )
      .all(req.user.id, t, t);
    return res.json(rows);
  }
  const date = isYmd(req.query.date) ? req.query.date : t;
  res.json(db.prepare(`${ASSIGN_SELECT} WHERE a.date=? ORDER BY CAST(r.number AS INTEGER), r.number`).all(date));
});

app.get('/api/assignments/review', mgr, (_req, res) => {
  res.json(db.prepare(`${ASSIGN_SELECT} WHERE a.status='submitted' ORDER BY a.submitted_at`).all());
});

app.post('/api/assignments', mgr, (req, res) => {
  const date = isYmd(req.body.date) ? req.body.date : today();
  const uid = int(req.body.user_id);
  const user = db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(uid);
  if (!user) throw HttpError(400, 'Pick a staff member');
  const ids = (Array.isArray(req.body.room_ids) ? req.body.room_ids : [req.body.room_id]).map(int).filter(Boolean);
  if (!ids.length) throw HttpError(400, 'Pick at least one room');
  const cleanType = ['checkout', 'stayover', 'deep'].includes(req.body.clean_type) ? req.body.clean_type : 'checkout';
  const created = [];
  tx(() => {
    for (const rid of ids) {
      const room = db.prepare('SELECT * FROM rooms WHERE id=? AND active=1').get(rid);
      if (!room) continue;
      const dup = db
        .prepare("SELECT 1 FROM assignments WHERE room_id=? AND date=? AND status<>'rejected'")
        .get(rid, date);
      if (dup) continue;
      const r = db
        .prepare('INSERT INTO assignments (room_id,user_id,date,clean_type,created_by) VALUES (?,?,?,?,?)')
        .run(rid, uid, date, cleanType, req.user.id);
      const aid = Number(r.lastInsertRowid);
      const items = db
        .prepare(
          `SELECT id FROM checklist_items WHERE active=1 AND (room_type='' OR room_type=?) ${
            cleanType === 'stayover' ? "AND scope='all'" : cleanType === 'checkout' ? "AND scope IN ('all','checkout')" : ''
          } ORDER BY position,id`
        )
        .all(room.type);
      const ins = db.prepare('INSERT INTO assignment_checks (assignment_id,item_id) VALUES (?,?)');
      for (const it of items) ins.run(aid, it.id);
      if (room.status === 'clean' && date === today()) db.prepare("UPDATE rooms SET status='dirty' WHERE id=?").run(rid);
      created.push(aid);
    }
  });
  log(req.user.id, 'rooms_assigned', `${created.length} room(s) to ${user.name} for ${date}`);
  res.json({ created: created.length, skipped: ids.length - created.length });
});

app.delete('/api/assignments/:id', mgr, (req, res) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(int(req.params.id));
  if (!a) throw HttpError(404, 'No such assignment');
  if (a.status === 'approved') throw HttpError(400, 'Approved cleanings are kept as a record');
  const photos = db.prepare('SELECT filename FROM assignment_photos WHERE assignment_id=?').all(a.id);
  db.prepare('DELETE FROM assignments WHERE id=?').run(a.id);
  photos.forEach((p) => dropUpload(p.filename));
  res.json({ ok: true });
});

function loadAssignment(req, { mineOnly = true } = {}) {
  const a = db.prepare(`${ASSIGN_SELECT} WHERE a.id=?`).get(int(req.params.id));
  if (!a) throw HttpError(404, 'No such assignment');
  if (mineOnly && req.user.role === 'employee' && a.user_id !== req.user.id) throw HttpError(403, 'This room is assigned to someone else');
  return a;
}

app.get('/api/assignments/:id', anyUser, (req, res) => {
  const a = loadAssignment(req);
  a.items = db
    .prepare(
      `SELECT c.item_id, c.done, i.text, i.section,
        EXISTS(SELECT 1 FROM assignment_failures f WHERE f.assignment_id=c.assignment_id AND f.item_id=c.item_id) AS failed
       FROM assignment_checks c JOIN checklist_items i ON i.id=c.item_id
       WHERE c.assignment_id=? ORDER BY i.position, i.id`
    )
    .all(a.id);
  a.photos = db.prepare('SELECT id,filename,created_at FROM assignment_photos WHERE assignment_id=? ORDER BY id').all(a.id);
  a.target_max = targetMax(a);
  if (a.reviewed_by) a.reviewer = db.prepare('SELECT name FROM users WHERE id=?').get(a.reviewed_by)?.name;
  res.json(a);
});

const editable = (a) => ['assigned', 'in_progress', 'rejected'].includes(a.status);

function requireClockedIn(req) {
  if (req.user.role !== 'employee') return; // managers pitching in don't need to punch
  if (getSettings().require_clock_in === '1' && !openEntry(req.user.id)) throw HttpError(409, 'Clock in first, then start your rooms');
}

app.post('/api/assignments/:id/start', anyUser, (req, res) => {
  const a = loadAssignment(req);
  if (!editable(a)) throw HttpError(409, 'This room is already submitted');
  requireClockedIn(req);
  tx(() => {
    db.prepare("UPDATE assignments SET status='in_progress', started_at=COALESCE(started_at,?) WHERE id=?").run(now(), a.id);
    db.prepare("UPDATE rooms SET status='in_progress' WHERE id=? AND status<>'out_of_order'").run(a.room_id);
  });
  res.json({ ok: true });
});

app.put('/api/assignments/:id/check', anyUser, (req, res) => {
  const a = loadAssignment(req);
  if (!editable(a)) throw HttpError(409, 'This room is already submitted');
  const item = int(req.body.item_id);
  const r = db
    .prepare('UPDATE assignment_checks SET done=? WHERE assignment_id=? AND item_id=?')
    .run(req.body.done ? 1 : 0, a.id, item);
  if (!r.changes) throw HttpError(404, 'No such checklist item');
  if (a.status === 'assigned') {
    requireClockedIn(req);
    db.prepare("UPDATE assignments SET status='in_progress', started_at=COALESCE(started_at,?) WHERE id=?").run(now(), a.id);
    db.prepare("UPDATE rooms SET status='in_progress' WHERE id=? AND status<>'out_of_order'").run(a.room_id);
  }
  res.json({ ok: true });
});

app.post('/api/assignments/:id/photos', anyUser, upload.single('photo'), (req, res) => {
  let name;
  try {
    const a = loadAssignment(req);
    if (!editable(a)) throw HttpError(409, 'This room is already submitted');
    if (!req.file) throw HttpError(400, 'No photo received');
    const count = db.prepare('SELECT COUNT(*) c FROM assignment_photos WHERE assignment_id=?').get(a.id).c;
    if (count >= 10) throw HttpError(400, 'Up to 10 photos per room');
    name = finalizeUpload(req.file);
    const r = db.prepare('INSERT INTO assignment_photos (assignment_id,filename) VALUES (?,?)').run(a.id, name);
    res.json({ id: Number(r.lastInsertRowid), filename: name });
  } catch (e) {
    if (req.file && !name) fs.rm(req.file.path, () => {});
    throw e;
  }
});

app.delete('/api/assignments/:id/photos/:pid', anyUser, (req, res) => {
  const a = loadAssignment(req);
  if (!editable(a) && req.user.role === 'employee') throw HttpError(409, 'This room is already submitted');
  const p = db.prepare('SELECT * FROM assignment_photos WHERE id=? AND assignment_id=?').get(int(req.params.pid), a.id);
  if (!p) throw HttpError(404, 'No such photo');
  db.prepare('DELETE FROM assignment_photos WHERE id=?').run(p.id);
  dropUpload(p.filename);
  res.json({ ok: true });
});

app.post('/api/assignments/:id/submit', anyUser, (req, res) => {
  const a = loadAssignment(req);
  if (!editable(a)) throw HttpError(409, 'This room is already submitted');
  requireClockedIn(req);
  const s = getSettings();
  const missing = a.checks_total - a.checks_done;
  if (missing > 0) throw HttpError(400, `${missing} checklist item(s) still unchecked`);
  const minPhotos = Number(s.min_photos) || 1;
  if (a.photo_count < minPhotos) throw HttpError(400, `Add at least ${minPhotos} photo${minPhotos > 1 ? 's' : ''} of the finished room`);
  tx(() => {
    db.prepare("UPDATE assignments SET status='submitted', submitted_at=?, notes=? WHERE id=?").run(now(), str(req.body.notes, 500), a.id);
    db.prepare("UPDATE rooms SET status='review' WHERE id=? AND status<>'out_of_order'").run(a.room_id);
  });
  log(req.user.id, 'room_submitted', `Room ${a.room_number}`);
  res.json({ ok: true });
});

app.post('/api/assignments/:id/review', mgr, (req, res) => {
  const a = loadAssignment(req, { mineOnly: false });
  if (a.status !== 'submitted') throw HttpError(409, 'This room is not waiting for review');
  const approve = !!req.body.approve;
  const note = str(req.body.note, 500);
  if (!approve && !note) throw HttpError(400, 'Tell them what needs to be redone');
  const failed = approve ? [] : (Array.isArray(req.body.failed_items) ? req.body.failed_items.map(int).filter(Boolean) : []);
  tx(() => {
    db.prepare('UPDATE assignments SET status=?, reviewed_by=?, reviewed_at=?, review_note=?, reject_count=reject_count+? WHERE id=?').run(
      approve ? 'approved' : 'rejected', req.user.id, now(), note, approve ? 0 : 1, a.id
    );
    db.prepare('DELETE FROM assignment_failures WHERE assignment_id=?').run(a.id);
    for (const itemId of failed) {
      if (db.prepare('SELECT 1 FROM assignment_checks WHERE assignment_id=? AND item_id=?').get(a.id, itemId))
        db.prepare('INSERT OR IGNORE INTO assignment_failures (assignment_id,item_id) VALUES (?,?)').run(a.id, itemId);
    }
    if (!approve) db.prepare('UPDATE assignment_checks SET done=0 WHERE assignment_id=? AND item_id IN (SELECT item_id FROM assignment_failures WHERE assignment_id=?)').run(a.id, a.id);
    db.prepare("UPDATE rooms SET status=? WHERE id=? AND status<>'out_of_order'").run(approve ? 'clean' : 'dirty', a.room_id);
  });
  log(req.user.id, approve ? 'room_approved' : 'room_rejected', `Room ${a.room_number} (${a.user_name})${note ? ': ' + note : ''}`);
  res.json({ ok: true });
});

// ---------- inventory ----------
app.get('/api/inventory', mgr, (_req, res) => {
  res.json(db.prepare('SELECT * FROM inventory_items WHERE active=1 ORDER BY category, name').all());
});

app.post('/api/inventory', mgr, (req, res) => {
  const name = str(req.body.name, 100);
  if (!name) throw HttpError(400, 'Item name is required');
  const r = db
    .prepare('INSERT INTO inventory_items (name,category,unit,qty,par,unit_cost,location) VALUES (?,?,?,?,?,?,?)')
    .run(
      name, str(req.body.category, 40) || 'General', str(req.body.unit, 20) || 'each',
      Math.max(0, num(req.body.qty) ?? 0), req.user.role === 'owner' ? Math.max(0, num(req.body.par) ?? 0) : 0,
      req.user.role === 'owner' ? Math.max(0, num(req.body.unit_cost) ?? 0) : 0, str(req.body.location, 60)
    );
  const id = Number(r.lastInsertRowid);
  if ((num(req.body.qty) ?? 0) > 0) db.prepare('INSERT INTO inventory_log (item_id,user_id,delta,note) VALUES (?,?,?,?)').run(id, req.user.id, num(req.body.qty), 'Opening count');
  log(req.user.id, 'inventory_added', name);
  res.json({ id });
});

app.patch('/api/inventory/:id', mgr, (req, res) => {
  const it = db.prepare('SELECT * FROM inventory_items WHERE id=?').get(int(req.params.id));
  if (!it) throw HttpError(404, 'No such item');
  const b = req.body;
  db.prepare('UPDATE inventory_items SET name=?,category=?,unit=?,par=?,unit_cost=?,location=? WHERE id=?').run(
    b.name !== undefined ? str(b.name, 100) || it.name : it.name,
    b.category !== undefined ? str(b.category, 40) || it.category : it.category,
    b.unit !== undefined ? str(b.unit, 20) || it.unit : it.unit,
    req.user.role === 'owner' && b.par !== undefined ? Math.max(0, num(b.par) ?? it.par) : it.par,
    req.user.role === 'owner' && b.unit_cost !== undefined ? Math.max(0, num(b.unit_cost) ?? it.unit_cost) : it.unit_cost,
    b.location !== undefined ? str(b.location, 60) : it.location,
    it.id
  );
  res.json({ ok: true });
});

app.delete('/api/inventory/:id', mgr, (req, res) => {
  db.prepare('UPDATE inventory_items SET active=0 WHERE id=?').run(int(req.params.id));
  res.json({ ok: true });
});

// delta is positive for restock, negative for use / waste. "set" does a recount.
app.post('/api/inventory/:id/adjust', mgr, (req, res) => {
  const it = db.prepare('SELECT * FROM inventory_items WHERE id=?').get(int(req.params.id));
  if (!it) throw HttpError(404, 'No such item');
  let delta = num(req.body.delta);
  if (req.body.set !== undefined && req.body.set !== null && req.body.set !== '') {
    const target = num(req.body.set);
    if (target === null || target < 0) throw HttpError(400, 'Enter a valid count');
    delta = target - it.qty;
  }
  if (delta === null || delta === 0) throw HttpError(400, 'Enter an amount');
  if (it.qty + delta < 0) throw HttpError(400, `Only ${it.qty} ${it.unit} on hand`);
  tx(() => {
    db.prepare('UPDATE inventory_items SET qty=qty+? WHERE id=?').run(delta, it.id);
    const roomId = int(req.body.room_id);
    db.prepare('INSERT INTO inventory_log (item_id,user_id,delta,room_id,note) VALUES (?,?,?,?,?)').run(
      it.id, req.user.id, delta, roomId && db.prepare('SELECT 1 FROM rooms WHERE id=?').get(roomId) ? roomId : null,
      str(req.body.note, 200) || (req.body.set !== undefined ? 'Recount' : '')
    );
  });
  res.json({ ok: true });
});

app.get('/api/inventory/:id/log', mgr, (req, res) => {
  res.json(
    db.prepare(
      `SELECT l.*, u.name, r.number AS room_number FROM inventory_log l JOIN users u ON u.id=l.user_id
       LEFT JOIN rooms r ON r.id=l.room_id WHERE l.item_id=? ORDER BY l.id DESC LIMIT 50`
    ).all(int(req.params.id))
  );
});

// ---------- chat ----------
const channelDef = (id) => {
  const c = CHANNELS.find((x) => x.id === id);
  if (!c) throw HttpError(404, 'No such channel');
  return c;
};

function postMessage(channel, userId, body, photo) {
  const r = db.prepare('INSERT INTO messages (channel,user_id,body,photo) VALUES (?,?,?,?)').run(channel, userId, body, photo || null);
  return Number(r.lastInsertRowid);
}

app.get('/api/chat/:channel', anyUser, (req, res) => {
  channelDef(req.params.channel);
  const after = int(req.query.after) || 0;
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT m.id,m.body,m.photo,m.created_at,m.user_id,u.name,u.role FROM messages m JOIN users u ON u.id=m.user_id
         WHERE m.channel=? AND m.id>? ORDER BY m.id DESC LIMIT 100
       ) ORDER BY id`
    )
    .all(req.params.channel, after);
  if (rows.length) {
    db.prepare(
      `INSERT INTO chat_reads (user_id,channel,last_id) VALUES (?,?,?)
       ON CONFLICT(user_id,channel) DO UPDATE SET last_id=MAX(last_id,excluded.last_id)`
    ).run(req.user.id, req.params.channel, rows[rows.length - 1].id);
  }
  res.json(rows);
});

app.post('/api/chat/:channel', anyUser, upload.single('photo'), (req, res) => {
  let name;
  try {
    const c = channelDef(req.params.channel);
    if (!c.postRoles.includes(req.user.role)) throw HttpError(403, 'Only managers can post here');
    const body = str(req.body.body, 2000);
    if (req.file) name = finalizeUpload(req.file);
    if (!body && !name) throw HttpError(400, 'Write a message first');
    const id = postMessage(c.id, req.user.id, body, name);
    res.json({ id });
  } catch (e) {
    if (req.file && !name) fs.rm(req.file.path, () => {});
    if (name) dropUpload(name);
    throw e;
  }
});

app.get('/api/badges', anyUser, (req, res) => {
  const unread = {};
  for (const c of CHANNELS) {
    unread[c.id] = db
      .prepare(
        `SELECT COUNT(*) c FROM messages m WHERE m.channel=? AND m.user_id<>? AND m.id > COALESCE((SELECT last_id FROM chat_reads WHERE user_id=? AND channel=?),0)`
      )
      .get(c.id, req.user.id, req.user.id, c.id).c;
  }
  const out = {
    unread,
    chat: Object.values(unread).reduce((a, b) => a + b, 0),
    maintenance: db.prepare("SELECT COUNT(*) c FROM maintenance WHERE status<>'done'").get().c,
  };
  if (req.user.role !== 'employee') {
    out.review = db.prepare("SELECT COUNT(*) c FROM assignments WHERE status='submitted'").get().c;
    out.incidents = db.prepare("SELECT COUNT(*) c FROM incidents WHERE status='open'").get().c;
    const urgent = db.prepare(`${INC_SELECT} WHERE i.status='open' AND i.urgent=1 ORDER BY i.id DESC LIMIT 3`).all();
    out.alerts = urgent.map((i) => ({ id: i.id, category: i.category, reporter: i.reporter, room: i.room_number, at: i.created_at }));
  }
  res.json(out);
});

// ---------- maintenance ----------
const MAINT_SELECT = `
  SELECT m.*, r.number AS room_number, rep.name AS reporter, asg.name AS assignee,
    (SELECT COUNT(*) FROM maintenance_comments c WHERE c.request_id=m.id) AS comment_count
  FROM maintenance m LEFT JOIN rooms r ON r.id=m.room_id JOIN users rep ON rep.id=m.reported_by LEFT JOIN users asg ON asg.id=m.assigned_to`;

app.get('/api/maintenance', anyUser, (req, res) => {
  const where = req.query.status === 'done' ? "m.status='done'" : req.query.status === 'all' ? '1=1' : "m.status<>'done'";
  res.json(
    db
      .prepare(
        `${MAINT_SELECT} WHERE ${where} ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.id DESC LIMIT 200`
      )
      .all()
  );
});

app.get('/api/maintenance/:id', anyUser, (req, res) => {
  const m = db.prepare(`${MAINT_SELECT} WHERE m.id=?`).get(int(req.params.id));
  if (!m) throw HttpError(404, 'No such request');
  m.comments = db
    .prepare('SELECT c.*,u.name FROM maintenance_comments c JOIN users u ON u.id=c.user_id WHERE c.request_id=? ORDER BY c.id')
    .all(m.id);
  res.json(m);
});

app.post('/api/maintenance', anyUser, upload.single('photo'), (req, res) => {
  let name;
  try {
    const title = str(req.body.title, 120);
    if (!title) throw HttpError(400, 'Give the request a short title');
    const roomId = int(req.body.room_id);
    if (roomId && !db.prepare('SELECT 1 FROM rooms WHERE id=?').get(roomId)) throw HttpError(400, 'No such room');
    const category = ['repair', 'supplies', 'safety', 'lost_found', 'other'].includes(req.body.category) ? req.body.category : 'repair';
    const priority = ['low', 'normal', 'high', 'urgent'].includes(req.body.priority) ? req.body.priority : 'normal';
    if (req.file) name = finalizeUpload(req.file);
    const r = db
      .prepare(
        'INSERT INTO maintenance (room_id,location,category,title,description,priority,photo,reporting_gap,reported_by) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(roomId || null, str(req.body.location, 80), category, title, str(req.body.description, 1500), priority, name || null,
        req.user.role !== 'employee' && String(req.body.reporting_gap) === '1' ? 1 : 0, req.user.id);
    const room = roomId ? db.prepare('SELECT number FROM rooms WHERE id=?').get(roomId).number : null;
    postMessage(
      'maintenance', req.user.id,
      `🔧 New ${priority} request${room ? ' – Room ' + room : ''}: ${title}`, null
    );
    log(req.user.id, 'maintenance_created', `${room ? 'Room ' + room + ': ' : ''}${title} [${priority}]`);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch (e) {
    if (req.file && !name) fs.rm(req.file.path, () => {});
    if (name) dropUpload(name);
    throw e;
  }
});

app.patch('/api/maintenance/:id', mgr, (req, res) => {
  const m = db.prepare('SELECT * FROM maintenance WHERE id=?').get(int(req.params.id));
  if (!m) throw HttpError(404, 'No such request');
  const b = req.body;
  const status = ['open', 'in_progress', 'waiting', 'done'].includes(b.status) ? b.status : m.status;
  const priority = ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : m.priority;
  let assigned = m.assigned_to;
  if (b.assigned_to !== undefined) {
    assigned = b.assigned_to ? int(b.assigned_to) : null;
    if (assigned && !db.prepare('SELECT 1 FROM users WHERE id=? AND active=1').get(assigned)) throw HttpError(400, 'No such staff member');
  }
  const resolved = status === 'done' ? m.resolved_at || now() : null;
  const gap = b.reporting_gap !== undefined ? (b.reporting_gap ? 1 : 0) : m.reporting_gap;
  db.prepare('UPDATE maintenance SET status=?,priority=?,assigned_to=?,resolved_at=?,reporting_gap=? WHERE id=?').run(status, priority, assigned, resolved, gap, m.id);
  if (gap !== m.reporting_gap) log(req.user.id, gap ? 'reporting_gap_flagged' : 'reporting_gap_cleared', `#${m.id} ${m.title}`);
  if (status !== m.status) log(req.user.id, 'maintenance_status', `#${m.id} ${m.title}: ${m.status} → ${status}`);
  res.json({ ok: true });
});

app.post('/api/maintenance/:id/comments', anyUser, (req, res) => {
  const m = db.prepare('SELECT 1 FROM maintenance WHERE id=?').get(int(req.params.id));
  if (!m) throw HttpError(404, 'No such request');
  const body = str(req.body.body, 1000);
  if (!body) throw HttpError(400, 'Write a comment first');
  db.prepare('INSERT INTO maintenance_comments (request_id,user_id,body) VALUES (?,?,?)').run(int(req.params.id), req.user.id, body);
  res.json({ ok: true });
});

// ---------- playbook & acknowledgment ----------
app.get('/api/playbook', anyUser, (req, res) => {
  const signed = db.prepare('SELECT signed_name,signed_at FROM acknowledgments WHERE user_id=? AND version=?').get(req.user.id, playbook.VERSION) || null;
  res.json({ ...playbook, signed, required: req.user.role === 'employee' && getSettings().require_ack === '1' });
});

app.post('/api/ack', anyUser, (req, res) => {
  const typed = str(req.body.name, 100).replace(/\s+/g, ' ');
  if (typed.toLowerCase() !== req.user.name.replace(/\s+/g, ' ').toLowerCase())
    throw HttpError(400, `Type your full name exactly as it appears: ${req.user.name}`);
  if (req.body.agree !== true) throw HttpError(400, 'Tick the box to confirm you have read and agree');
  db.prepare('INSERT OR IGNORE INTO acknowledgments (user_id,version,signed_name) VALUES (?,?,?)').run(req.user.id, playbook.VERSION, typed);
  log(req.user.id, 'acknowledgment_signed', playbook.VERSION);
  res.json({ ok: true });
});

app.get('/api/ack/status', mgr, (_req, res) => {
  res.json(db.prepare(
    `SELECT u.id,u.name,u.role,a.signed_at FROM users u LEFT JOIN acknowledgments a ON a.user_id=u.id AND a.version=?
     WHERE u.active=1 AND u.role<>'owner' ORDER BY a.signed_at IS NOT NULL, u.name`
  ).all(playbook.VERSION));
});

// ---------- accountability log ----------
const ACC_SELECT = `SELECT e.*, m.name AS manager, r.name AS retracted_by_name FROM accountability_events e
  JOIN users m ON m.id=e.manager_id LEFT JOIN users r ON r.id=e.retracted_by`;
const ZERO_TOLERANCE_CATS = ['violence', 'threat', 'harassment', 'intoxication', 'theft'];
const STANDARDS_CATS = ['missed cleaning step', 'unreported maintenance', 'attitude with a guest', 'shift handoff', 'other standards issue'];

function warningCount(userId) {
  return db.prepare("SELECT COUNT(*) c FROM accountability_events WHERE user_id=? AND kind='warning' AND retracted_at IS NULL").get(userId).c;
}

app.get('/api/accountability/summary', mgr, (_req, res) => {
  const rows = db.prepare("SELECT id,name,role FROM users WHERE active=1 AND role<>'owner' ORDER BY name").all();
  for (const u of rows) {
    u.warnings = warningCount(u.id);
    u.zero_tolerance = db.prepare("SELECT COUNT(*) c FROM accountability_events WHERE user_id=? AND kind='zero_tolerance' AND retracted_at IS NULL").get(u.id).c;
  }
  res.json(rows);
});

app.get('/api/accountability', mgr, (req, res) => {
  const uid = int(req.query.user_id);
  if (!uid) throw HttpError(400, 'Pick an employee');
  res.json({ warnings_used: warningCount(uid), events: db.prepare(`${ACC_SELECT} WHERE e.user_id=? ORDER BY e.event_date DESC, e.id DESC`).all(uid) });
});

// Employees can see their own record (PRD: "view own accountability record").
app.get('/api/me/accountability', anyUser, (req, res) => {
  res.json({ warnings_used: warningCount(req.user.id), events: db.prepare(`${ACC_SELECT} WHERE e.user_id=? ORDER BY e.event_date DESC, e.id DESC`).all(req.user.id) });
});

app.post('/api/accountability', mgr, (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id=? AND role<>'owner'").get(int(req.body.user_id));
  if (!target) throw HttpError(400, 'Pick a staff member');
  if (target.role === 'manager' && req.user.role !== 'owner') throw HttpError(403, 'Only the owner can log events against a manager');
  const kind = req.body.kind === 'zero_tolerance' ? 'zero_tolerance' : 'warning';
  const description = str(req.body.description, 1500);
  if (description.length < 5) throw HttpError(400, 'Describe what happened (who, when, what)');
  const eventDate = isYmd(req.body.event_date) ? req.body.event_date : today();
  if (eventDate > today()) throw HttpError(400, "The date can't be in the future");
  const prior = kind === 'warning' ? warningCount(target.id) : 0;
  const r = db.prepare('INSERT INTO accountability_events (user_id,kind,category,description,manager_id,event_date) VALUES (?,?,?,?,?,?)')
    .run(target.id, kind, str(req.body.category, 60), description, req.user.id, eventDate);
  log(req.user.id, kind === 'warning' ? 'warning_logged' : 'zero_tolerance_logged', `${target.name}: ${str(req.body.category, 60)}`);
  res.json({
    id: Number(r.lastInsertRowid),
    // Informational only; the decision to terminate stays with the owner.
    repeat: prior >= 1,
    message: prior >= 1 ? 'This is a repeat standards issue. Under the Accountability Standard a second occurrence results in termination.' : undefined,
  });
});

app.post('/api/accountability/:id/retract', owner, (req, res) => {
  const e = db.prepare('SELECT * FROM accountability_events WHERE id=? AND retracted_at IS NULL').get(int(req.params.id));
  if (!e) throw HttpError(404, 'No such entry');
  const reason = str(req.body.reason, 300);
  if (reason.length < 3) throw HttpError(400, 'A reason is required');
  db.prepare('UPDATE accountability_events SET retracted_at=?, retracted_by=?, retract_reason=? WHERE id=?').run(now(), req.user.id, reason, e.id);
  log(req.user.id, 'accountability_retracted', `#${e.id}: ${reason}`);
  res.json({ ok: true });
});

// ---------- incident reports (any staff member) ----------
const INCIDENT_CATS = {
  violence: true, threat: true, harassment: true, intoxication: true, theft: true, safety: true, // urgent: alerts managers at once
  standards: false, guest_complaint: false, other: false,
};
const INC_SELECT = `SELECT i.*, u.name AS reporter, r.number AS room_number, rv.name AS reviewer
  FROM incidents i JOIN users u ON u.id=i.reporter_id LEFT JOIN rooms r ON r.id=i.room_id LEFT JOIN users rv ON rv.id=i.reviewed_by`;

app.post('/api/incidents', anyUser, (req, res) => {
  const category = str(req.body.category, 30);
  if (!(category in INCIDENT_CATS)) throw HttpError(400, 'Pick a category');
  const description = str(req.body.description, 1500);
  if (description.length < 3) throw HttpError(400, 'Say briefly what happened');
  const roomId = int(req.body.room_id);
  const r = db.prepare('INSERT INTO incidents (reporter_id,category,urgent,room_id,description) VALUES (?,?,?,?,?)').run(
    req.user.id, category, INCIDENT_CATS[category] ? 1 : 0, roomId && db.prepare('SELECT 1 FROM rooms WHERE id=?').get(roomId) ? roomId : null, description
  );
  log(req.user.id, INCIDENT_CATS[category] ? 'URGENT_incident_reported' : 'incident_reported', `${category}: ${description.slice(0, 80)}`);
  res.json({ id: Number(r.lastInsertRowid), urgent: INCIDENT_CATS[category] });
});

app.get('/api/incidents', anyUser, (req, res) => {
  if (req.user.role === 'employee') {
    return res.json(db.prepare(`${INC_SELECT} WHERE i.reporter_id=? ORDER BY i.id DESC LIMIT 50`).all(req.user.id));
  }
  const status = req.query.status === 'all' ? '1=1' : "i.status='open'";
  res.json(db.prepare(`${INC_SELECT} WHERE ${status} ORDER BY i.status, i.urgent DESC, i.id DESC LIMIT 100`).all());
});

app.post('/api/incidents/:id/review', mgr, (req, res) => {
  const i = db.prepare('SELECT * FROM incidents WHERE id=?').get(int(req.params.id));
  if (!i) throw HttpError(404, 'No such report');
  db.prepare("UPDATE incidents SET status='reviewed', reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?").run(req.user.id, now(), str(req.body.note, 500), i.id);
  log(req.user.id, 'incident_reviewed', `#${i.id} ${i.category}`);
  res.json({ ok: true });
});

// ---------- employee pattern view ----------
app.get('/api/employees/:id/timeline', mgr, (req, res) => {
  const u = db.prepare('SELECT id,name,role,phone FROM users WHERE id=?').get(int(req.params.id));
  if (!u) throw HttpError(404, 'No such person');
  const since = addDays(today(), -30);
  const rejections = db.prepare(
    `SELECT a.id,a.date,r.number AS room_number,a.review_note,a.reject_count FROM assignments a JOIN rooms r ON r.id=a.room_id
     WHERE a.user_id=? AND a.reject_count>0 AND a.date>=? ORDER BY a.date DESC`
  ).all(u.id, since);
  const patterns = db.prepare(
    `SELECT i.text, COUNT(*) AS times FROM assignment_failures f JOIN assignments a ON a.id=f.assignment_id
     JOIN checklist_items i ON i.id=f.item_id WHERE a.user_id=? AND a.date>=? GROUP BY i.id HAVING times>=3 ORDER BY times DESC`
  ).all(u.id, since);
  const s = db.prepare(
    `SELECT COUNT(*) AS reviewed, SUM(status='approved' AND reject_count=0) AS first_pass,
      AVG(CASE WHEN started_at IS NOT NULL AND submitted_at IS NOT NULL THEN (julianday(submitted_at)-julianday(started_at))*1440 END) AS avg_minutes
     FROM assignments WHERE user_id=? AND date>=? AND (status='approved' OR reject_count>0)`
  ).get(u.id, since);
  const clock = entriesFor(since, today(), u.id);
  res.json({
    user: u, since,
    stats: { reviewed: s.reviewed, first_pass: s.first_pass || 0, avg_minutes: s.avg_minutes == null ? null : Math.round(s.avg_minutes) },
    rejections, patterns,
    clock_flags: clock.filter((e) => e.flags.length).map((e) => ({ id: e.id, clock_in: e.clock_in, flags: e.flags })),
    warnings_used: warningCount(u.id),
    events: db.prepare(`${ACC_SELECT} WHERE e.user_id=? ORDER BY e.event_date DESC, e.id DESC`).all(u.id),
    incidents: db.prepare(`${INC_SELECT} WHERE i.reporter_id=? ORDER BY i.id DESC LIMIT 10`).all(u.id),
    signed: !!hasSigned(u.id),
  });
});

// ---------- dashboard & reports ----------
app.get('/api/dashboard', mgr, (req, res) => {
  const s = getSettings();
  const z = s.timezone;
  const t = localDate(z);
  const isOwner = req.user.role === 'owner';

  const rooms = db.prepare("SELECT status, COUNT(*) c FROM rooms WHERE active=1 GROUP BY status").all();
  const roomCounts = Object.fromEntries(ROOM_STATUS.map((x) => [x, 0]));
  rooms.forEach((r) => (roomCounts[r.status] = r.c));

  const assigns = db.prepare('SELECT status, COUNT(*) c FROM assignments WHERE date=? GROUP BY status').all(t);
  const assignCounts = { assigned: 0, in_progress: 0, submitted: 0, approved: 0, rejected: 0 };
  assigns.forEach((r) => (assignCounts[r.status] = r.c));

  const unassigned = db
    .prepare(
      `SELECT id,number FROM rooms WHERE active=1 AND status='dirty' AND id NOT IN
       (SELECT room_id FROM assignments WHERE date=? AND status<>'rejected') ORDER BY CAST(number AS INTEGER)`
    )
    .all(t);

  const clockedIn = db
    .prepare(
      `SELECT c.id,c.user_id,c.clock_in,u.name,u.role FROM clock_entries c JOIN users u ON u.id=c.user_id
       WHERE c.clock_out IS NULL AND c.voided=0 ORDER BY c.clock_in`
    )
    .all();
  const forgotLimit = Number(s.forgotten_clockout_hours) || 14;
  const factor = Number(s.behind_factor) || 1.25;
  let behindCount = 0;
  for (const c of clockedIn) {
    c.suspicious = hoursBetween(c.clock_in, now()) > forgotLimit;
    const active = db.prepare(`${ASSIGN_SELECT} WHERE a.user_id=? AND a.status='in_progress' ORDER BY a.started_at DESC LIMIT 1`).get(c.user_id);
    const total = db.prepare("SELECT COUNT(*) c FROM assignments WHERE user_id=? AND date=?").get(c.user_id, t).c;
    const done = db.prepare("SELECT COUNT(*) c FROM assignments WHERE user_id=? AND date=? AND status IN ('submitted','approved')").get(c.user_id, t).c;
    c.rooms_total = total; c.rooms_done = done;
    c.task = active ? `Room ${active.room_number}` : null;
    const tgt = active ? targetMax(active, s) : null;
    const mins = active?.started_at ? hoursBetween(active.started_at, now()) * 60 : 0;
    const onBreak = !!db.prepare('SELECT 1 FROM breaks WHERE entry_id=? AND end_at IS NULL').get(c.id);
    c.status = onBreak ? 'On Break' : tgt && mins > tgt * factor ? 'Behind Schedule' : active ? 'On Task' : 'Clocked in';
    if (c.status === 'Behind Schedule') behindCount++;
  }
  const todayEntries = entriesFor(t, t);
  const attention = [];
  todayEntries.forEach((e) => e.flags.forEach((f) => attention.push({ type: 'clock', text: `${e.name}: ${f}` })));
  const openGaps = db.prepare("SELECT COUNT(*) c FROM maintenance WHERE reporting_gap=1 AND status<>'done'").get().c;
  if (openGaps) attention.push({ type: 'gap', text: `${openGaps} open maintenance item(s) flagged as Reporting Gap`, href: '#/maint' });
  const unsigned = db.prepare(
    `SELECT COUNT(*) c FROM users u WHERE u.active=1 AND u.role<>'owner' AND NOT EXISTS (SELECT 1 FROM acknowledgments a WHERE a.user_id=u.id AND a.version=?)`
  ).get(playbook.VERSION).c;
  if (unsigned) attention.push({ type: 'ack', text: `${unsigned} staff member(s) have not signed the Employee Acknowledgment`, href: '#/team' });
  const openInc = db.prepare("SELECT COUNT(*) c FROM incidents WHERE status='open'").get().c;
  if (openInc) attention.push({ type: 'incident', text: `${openInc} incident report(s) waiting for review`, href: '#/incidents' });
  if (behindCount) attention.push({ type: 'behind', text: `${behindCount} housekeeper(s) behind schedule on a room`, href: '#/home' });

  const interval = Number(s.deep_clean_interval_days) || 90;
  const deepDue = db.prepare(
    `SELECT r.id,r.number,
      (SELECT MAX(a.date) FROM assignments a WHERE a.room_id=r.id AND a.clean_type='deep' AND a.status IN ('submitted','approved')) AS last_deep
     FROM rooms r WHERE r.active=1 AND r.status<>'out_of_order'`
  ).all().filter((r) => !r.last_deep || r.last_deep <= addDays(t, -interval))
    .sort((a, b) => (a.last_deep || '').localeCompare(b.last_deep || '')).slice(0, 12);

  const week = hoursReport(weekStart(t), t, isOwner);
  const dayHours = r2(week.users.reduce((a, u) => a + (u.days[t] || 0), 0));

  const lowStock = db
    .prepare('SELECT id,name,qty,par,unit FROM inventory_items WHERE active=1 AND par>0 AND qty<=par ORDER BY (qty*1.0/par), name LIMIT 20')
    .all();

  const maint = db.prepare("SELECT priority, COUNT(*) c FROM maintenance WHERE status<>'done' GROUP BY priority").all();
  const maintCounts = { urgent: 0, high: 0, normal: 0, low: 0 };
  maint.forEach((r) => (maintCounts[r.priority] = r.c));
  const maintTop = db
    .prepare(
      `${MAINT_SELECT} WHERE m.status<>'done' ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.id DESC LIMIT 5`
    )
    .all();

  const pending = db.prepare(`${ASSIGN_SELECT} WHERE a.status='submitted' ORDER BY a.submitted_at LIMIT 20`).all();

  const out = {
    today: t, roomCounts, assignCounts, unassigned, clockedIn, dayHours, attention, deepDue, deepIntervalDays: interval,
    weekHours: week.totals.hours, weekOvertime: week.totals.overtime,
    lowStock, maintCounts, maintTop, pending,
  };
  if (isOwner) {
    out.weekLabor = week.totals.pay;
    out.activity = db
      .prepare('SELECT a.id,a.action,a.detail,a.created_at,u.name FROM activity a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 25')
      .all();
  }
  res.json(out);
});

// Quality & speed per housekeeper. "First-pass" = approved without ever being sent back (the SOP's inspection pass rate).
app.get('/api/reports/productivity', mgr, (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const rows = db
    .prepare(
      `SELECT u.id,u.name,
        COUNT(*) AS rooms,
        SUM(a.status='approved' AND a.reject_count=0) AS first_pass,
        SUM(a.reject_count) AS sent_back,
        AVG(CASE WHEN a.started_at IS NOT NULL AND a.submitted_at IS NOT NULL
          THEN (julianday(a.submitted_at)-julianday(a.started_at))*1440 END) AS avg_minutes
       FROM assignments a JOIN users u ON u.id=a.user_id
       WHERE a.date BETWEEN ? AND ? AND (a.status='approved' OR a.reject_count>0)
       GROUP BY u.id ORDER BY u.name`
    )
    .all(from, to)
    .map((r) => ({
      ...r, first_pass: r.first_pass || 0, sent_back: r.sent_back || 0,
      pass_rate: r.rooms ? Math.round(((r.first_pass || 0) / r.rooms) * 100) : null,
      avg_minutes: r.avg_minutes == null ? null : Math.round(r.avg_minutes),
    }));
  res.json({ from, to, pass_rate_target: Number(getSettings().pass_rate_target) || 95, users: rows });
});

// ---------- settings (owner) ----------
app.get('/api/settings', owner, (_req, res) => res.json(getSettings()));

app.put('/api/settings', owner, (req, res) => {
  const b = req.body;
  const up = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  if (b.property_name !== undefined) up.run('property_name', str(b.property_name, 80) || "Heidi's Inn");
  if (b.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch { throw HttpError(400, 'Unknown timezone'); }
    up.run('timezone', b.timezone);
  }
  if (b.min_photos !== undefined) up.run('min_photos', String(Math.min(10, Math.max(0, int(b.min_photos) ?? 1))));
  if (b.require_clock_in !== undefined) up.run('require_clock_in', b.require_clock_in ? '1' : '0');
  if (b.overtime_weekly_hours !== undefined) up.run('overtime_weekly_hours', String(Math.max(1, num(b.overtime_weekly_hours) ?? 40)));
  const numSetting = (key, min, max) => {
    if (b[key] === undefined) return;
    const v = num(b[key]);
    if (v === null || v < min || v > max) throw HttpError(400, `${key.replace(/_/g, ' ')} must be between ${min} and ${max}`);
    up.run(key, String(v));
  };
  numSetting('max_break_minutes', 1, 240); numSetting('target_checkout_max', 5, 240); numSetting('target_stayover_max', 5, 240);
  numSetting('target_suite_max', 5, 240); numSetting('behind_factor', 1, 5); numSetting('deep_clean_interval_days', 7, 730);
  numSetting('pass_rate_target', 1, 100); numSetting('forgotten_clockout_hours', 6, 48);
  if (b.break_unpaid !== undefined) up.run('break_unpaid', b.break_unpaid ? '1' : '0');
  if (b.require_ack !== undefined) up.run('require_ack', b.require_ack ? '1' : '0');
  log(req.user.id, 'settings_changed');
  res.json({ ok: true });
});

// Consistent snapshot of the database the owner can download and keep.
app.get('/api/backup', owner, (req, res, next) => {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `backup-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  res.download(file, `stayflow-backup-${today()}.db`, (err) => {
    fs.rm(file, () => {});
    if (err && !res.headersSent) next(err);
  });
});

// ---------- static front end ----------
const PUBLIC = path.join(__dirname, '..', 'public');
app.get('/sw.js', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, 'sw.js')));
app.use(express.static(PUBLIC, { maxAge: '5m', index: 'index.html' }));

app.use('/api', (_req, _res, next) => next(HttpError(404, 'Not found')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  let status = err.status || 500;
  let message = err.message;
  if (err instanceof multer.MulterError) {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (15 MB max)' : 'Upload failed';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Bad request';
  } else if (status === 500) {
    console.error(err);
    message = 'Something went wrong on the server';
  }
  res.status(status).json({ error: message });
});

// ---------- startup ----------
function bootstrapOwner() {
  if (db.prepare('SELECT 1 FROM users').get()) return;
  const username = (process.env.OWNER_USERNAME || 'owner').toLowerCase();
  const generated = !process.env.OWNER_PASSWORD;
  const password = process.env.OWNER_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (name,username,pass_hash,role) VALUES (?,?,?,'owner')").run(
    process.env.OWNER_NAME || 'Owner', username, bcrypt.hashSync(password, 10)
  );
  console.log('\n=== First run: owner account created ===');
  console.log(`    username: ${username}`);
  console.log(generated ? `    password: ${password}   (change it after signing in)` : '    password: (from OWNER_PASSWORD)');
  console.log('========================================\n');
}

function housekeepingJobs() {
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());
  for (const [k, v] of failures) if (v.until < nowMs()) failures.delete(k);
}

if (require.main === module) {
  bootstrapOwner();
  if (process.env.SEED_DEMO === '1') require('./seed-demo')();
  housekeepingJobs();
  setInterval(housekeepingJobs, 3600000).unref();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Stay Flow running on http://localhost:${port}`));
}

module.exports = { app, bootstrapOwner };
