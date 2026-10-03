const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'stayflow.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','employee')),
  hourly_rate REAL NOT NULL DEFAULT 0,
  phone TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'standard',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'clean' CHECK (status IN ('dirty','in_progress','review','clean','out_of_order')),
  active INTEGER NOT NULL DEFAULT 1
);

-- room_type '' = applies to every room
CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY,
  room_type TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  checkout_only INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clock_entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  note TEXT NOT NULL DEFAULT '',
  edited_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_clock_user ON clock_entries(user_id, clock_in);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  clean_type TEXT NOT NULL DEFAULT 'checkout' CHECK (clean_type IN ('checkout','stayover','deep')),
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','submitted','approved','rejected')),
  started_at TEXT,
  submitted_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_assign_date ON assignments(date, user_id);

CREATE TABLE IF NOT EXISTS assignment_checks (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES checklist_items(id),
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (assignment_id, item_id)
);

CREATE TABLE IF NOT EXISTS assignment_photos (
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  unit TEXT NOT NULL DEFAULT 'each',
  qty REAL NOT NULL DEFAULT 0,
  par REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS inventory_log (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  photo TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_msg_channel ON messages(channel, id);

CREATE TABLE IF NOT EXISTS chat_reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  last_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel)
);

CREATE TABLE IF NOT EXISTS maintenance (
  id INTEGER PRIMARY KEY,
  room_id INTEGER REFERENCES rooms(id),
  location TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'repair' CHECK (category IN ('repair','supplies','safety','other')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','done')),
  photo TEXT,
  reported_by INTEGER NOT NULL REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS maintenance_comments (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES maintenance(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

const DEFAULT_SETTINGS = {
  property_name: "Heidi's Inn",
  timezone: 'America/Los_Angeles',
  min_photos: '1',
  require_clock_in: '1',
  overtime_weekly_hours: '40',
  forgotten_clockout_hours: '14',
};

const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key,value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function log(userId, action, detail = '') {
  db.prepare('INSERT INTO activity (user_id,action,detail) VALUES (?,?,?)').run(userId ?? null, action, detail);
}

// [text, checkout_only]
const DEFAULT_CHECKLIST = [
  ['Strip all bedding and remove used towels', 1],
  ['Make bed with fresh linens, pillows straightened', 0],
  ['Dust all surfaces, headboard, lamps and TV stand', 0],
  ['Wipe down desk, nightstands, remote and door handles', 0],
  ['Check under beds and in drawers/closet for guest items', 1],
  ['Clean and sanitize toilet, sink, counter and mirror', 0],
  ['Scrub shower/tub, fixtures and shower curtain checked', 0],
  ['Restock towels, soap, shampoo and toilet paper', 0],
  ['Empty all trash cans and replace liners', 0],
  ['Clean microwave/fridge/coffee maker (if in room)', 0],
  ['Vacuum carpet / sweep and mop hard floors', 0],
  ['Windows, blinds and curtains tidy; lights and TV working', 0],
  ['Report anything broken or missing via Maintenance', 0],
];

function seedChecklistIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) c FROM checklist_items').get().c;
  if (n) return;
  const ins = db.prepare("INSERT INTO checklist_items (room_type,text,position,checkout_only) VALUES ('',?,?,?)");
  DEFAULT_CHECKLIST.forEach(([t, co], i) => ins.run(t, i, co));
}
seedChecklistIfEmpty();

const CHANNELS = [
  { id: 'announcements', label: 'Announcements', postRoles: ['owner', 'manager'] },
  { id: 'general', label: 'General', postRoles: ['owner', 'manager', 'employee'] },
  { id: 'housekeeping', label: 'Housekeeping', postRoles: ['owner', 'manager', 'employee'] },
  { id: 'maintenance', label: 'Maintenance', postRoles: ['owner', 'manager', 'employee'] },
];

module.exports = { db, tx, log, getSettings, DATA_DIR, UPLOAD_DIR, CHANNELS };
