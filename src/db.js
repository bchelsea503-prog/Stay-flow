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
  section TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  -- all = every clean, checkout = checkout + deep, deep = deep cleans only
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','checkout','deep')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clock_entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'device' CHECK (source IN ('device','manual')),
  edited_by INTEGER REFERENCES users(id),
  voided INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT NOT NULL DEFAULT ''
);

-- every correction keeps the original values; nothing is silently overwritten
CREATE TABLE IF NOT EXISTS clock_edits (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES clock_entries(id),
  edited_by INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  old_in TEXT, old_out TEXT, new_in TEXT, new_out TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS breaks (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES clock_entries(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  start_at TEXT NOT NULL,
  end_at TEXT
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
  reject_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_assign_date ON assignments(date, user_id);

CREATE TABLE IF NOT EXISTS assignment_checks (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES checklist_items(id),
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (assignment_id, item_id)
);

-- which checklist steps a reviewer found missed (feeds the pattern view)
CREATE TABLE IF NOT EXISTS assignment_failures (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES checklist_items(id),
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
  room_id INTEGER REFERENCES rooms(id),
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
  category TEXT NOT NULL DEFAULT 'repair' CHECK (category IN ('repair','supplies','safety','lost_found','other')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','done')),
  photo TEXT,
  reporting_gap INTEGER NOT NULL DEFAULT 0,
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

-- Warnings and zero-tolerance events are permanent. A mistaken entry can only be
-- retracted by the owner, with a reason, and stays visible in the record.
CREATE TABLE IF NOT EXISTS accountability_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('warning','zero_tolerance')),
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  manager_id INTEGER NOT NULL REFERENCES users(id),
  event_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retracted_at TEXT,
  retracted_by INTEGER REFERENCES users(id),
  retract_reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  category TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  room_id INTEGER REFERENCES rooms(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS acknowledgments (
  user_id INTEGER NOT NULL REFERENCES users(id),
  version TEXT NOT NULL,
  signed_name TEXT NOT NULL,
  signed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, version)
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
  break_unpaid: '1',
  max_break_minutes: '30',
  target_checkout_max: '35',
  target_stayover_max: '20',
  target_suite_max: '45',
  behind_factor: '1.25',
  deep_clean_interval_days: '90',
  pass_rate_target: '95',
  require_ack: '1',
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

// [section, text, scope] taken from the Heidi's Inn Housekeeping SOP and SOP Playbook
const DEFAULT_CHECKLIST = [
  ['Bedroom', 'Strip all bedding and towels; inspect for stains or wear (pull damaged linens, never reuse)', 'checkout'],
  ['Bedroom', 'Bed made tight with fresh linens', 'all'],
  ['Bedroom', 'Checked under beds and behind headboards (guest-flagged trouble spots)', 'checkout'],
  ['Bedroom', 'All surfaces dust-free', 'all'],
  ['Bedroom', 'Trash emptied', 'all'],
  ['Bedroom', 'Floors vacuumed / mopped', 'all'],
  ['Bedroom', 'Checked for guest belongings; any found turned in with room number and date', 'all'],
  ['Bathroom', 'Tub/shower, toilet, sink, floor and under-sink area cleaned and disinfected', 'all'],
  ['Bathroom', 'Soap / shampoo dispensers checked, clean and filled', 'all'],
  ['Bathroom', 'Mirrors streak-free', 'all'],
  ['Bathroom', 'Fresh towels and amenities stocked', 'all'],
  ['Kitchen / appliances', 'Refrigerator and microwave clean (where applicable)', 'all'],
  ['Final check', 'Lights, TV and HVAC all working', 'all'],
  ['Final check', 'No odors', 'all'],
  ['Final check', 'Any maintenance issue found has been reported in the app right now', 'all'],
  ['Final check', "Final self-inspection: if you wouldn't stay in it yourself, it isn't ready", 'all'],
  ['Deep clean', 'Window tracks cleaned', 'deep'],
  ['Deep clean', 'Vent covers cleaned', 'deep'],
  ['Deep clean', 'Shower heads descaled; grout cleaned', 'deep'],
  ['Deep clean', 'HVAC / appliance filters checked', 'deep'],
];

function seedChecklistIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) c FROM checklist_items').get().c;
  if (n) return;
  const ins = db.prepare("INSERT INTO checklist_items (room_type,section,text,position,scope) VALUES ('',?,?,?,?)");
  DEFAULT_CHECKLIST.forEach(([sec, t, scope], i) => ins.run(sec, t, i, scope));
}
seedChecklistIfEmpty();

const CHANNELS = [
  { id: 'announcements', label: 'Announcements', postRoles: ['owner', 'manager'] },
  { id: 'general', label: 'General', postRoles: ['owner', 'manager', 'employee'] },
  { id: 'housekeeping', label: 'Housekeeping', postRoles: ['owner', 'manager', 'employee'] },
  { id: 'maintenance', label: 'Maintenance', postRoles: ['owner', 'manager', 'employee'] },
];

module.exports = { db, tx, log, getSettings, DATA_DIR, UPLOAD_DIR, CHANNELS };
