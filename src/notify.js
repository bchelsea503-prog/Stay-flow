// Text (SMS) and email alerts for the owner and managers (the GM).
//
// Credentials come from environment variables, never the database:
//   Email : SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE=1 for port 465
//   SMS   : TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM (a number)
//           or TWILIO_MESSAGING_SERVICE_SID
//   Links : APP_URL, e.g. https://heidisinn-ops.com
const nodemailer = require('nodemailer');
const { db, getSettings } = require('./db');

const CAT_LABEL = {
  violence: 'Violence or fighting', threat: 'Threat or intimidation', harassment: 'Harassment',
  intoxication: 'Intoxication on shift', theft: 'Theft', safety: 'Safety hazard or emergency',
  standards: 'Standards issue', guest_complaint: 'Guest complaint', other: 'Incident',
};

const env = () => process.env;
const appUrl = () => (env().APP_URL || '').replace(/\/$/, '');

// ---- providers (replaceable in tests) ----
let transports = null;

function defaultTransports() {
  return {
    async email({ to, subject, text }) {
      const e = env();
      const t = nodemailer.createTransport({
        host: e.SMTP_HOST, port: Number(e.SMTP_PORT) || 587, secure: e.SMTP_SECURE === '1',
        auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined,
      });
      await t.sendMail({ from: e.SMTP_FROM || e.SMTP_USER, to, subject, text });
    },
    async sms({ to, text }) {
      const e = env();
      const body = new URLSearchParams({ To: to, Body: text });
      if (e.TWILIO_MESSAGING_SERVICE_SID) body.set('MessagingServiceSid', e.TWILIO_MESSAGING_SERVICE_SID);
      else body.set('From', e.TWILIO_FROM);
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${e.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(`Twilio ${res.status}${j.message ? ': ' + j.message : ''}`);
      }
    },
  };
}
const providers = () => transports || (transports = defaultTransports());
function setTransports(t) { transports = t; } // tests

function configured() {
  const e = env();
  return {
    email: !!(e.SMTP_HOST && (e.SMTP_FROM || e.SMTP_USER)),
    sms: !!(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && (e.TWILIO_FROM || e.TWILIO_MESSAGING_SERVICE_SID)),
  };
}

// E.164. A bare 10-digit number is assumed to be US; anything else must start with + and a country code.
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;

// Owner and managers who are active and have opted in. Contact details come from their own profile.
function recipients() {
  return db.prepare("SELECT id,name,role,email,phone,alert_sms,alert_email FROM users WHERE active=1 AND role IN ('owner','manager') ORDER BY role, name").all();
}

function record(incidentId, userId, channel, kind, status, detail = '') {
  db.prepare('INSERT INTO notifications (incident_id,user_id,channel,kind,status,detail) VALUES (?,?,?,?,?,?)')
    .run(incidentId, userId, channel, kind, status, String(detail).slice(0, 300));
}

async function deliver(r, msg, incidentId, kind) {
  const cfg = configured();
  const jobs = [];
  if (r.alert_email) {
    if (!r.email) record(incidentId, r.id, 'email', kind, 'skipped', 'No email address on file');
    else if (!cfg.email) record(incidentId, r.id, 'email', kind, 'skipped', 'Email is not configured on the server');
    else jobs.push(providers().email({ to: r.email, subject: msg.subject, text: msg.email })
      .then(() => record(incidentId, r.id, 'email', kind, 'sent'))
      .catch((e) => record(incidentId, r.id, 'email', kind, 'failed', e.message)));
  }
  if (r.alert_sms) {
    const to = normalizePhone(r.phone);
    if (!r.phone) record(incidentId, r.id, 'sms', kind, 'skipped', 'No mobile number on file');
    else if (!to) record(incidentId, r.id, 'sms', kind, 'skipped', 'Mobile number needs a country code, e.g. +7…');
    else if (!cfg.sms) record(incidentId, r.id, 'sms', kind, 'skipped', 'Text messaging is not configured on the server');
    else jobs.push(providers().sms({ to, text: msg.sms })
      .then(() => record(incidentId, r.id, 'sms', kind, 'sent'))
      .catch((e) => record(incidentId, r.id, 'sms', kind, 'failed', e.message)));
  }
  await Promise.all(jobs);
}

function messageFor(inc, reminder) {
  const label = CAT_LABEL[inc.category] || inc.category;
  const where = inc.room_number ? ` in Room ${inc.room_number}` : '';
  const link = appUrl() ? `${appUrl()}/#/incidents` : '';
  const tag = reminder ? 'REMINDER, still unreviewed' : 'URGENT';
  // Texts stay short and leave out the details of what happened; those are in the app and the email.
  return {
    subject: `[${tag}] Heidi's Inn: ${label}${where}`,
    sms: `Heidi's Inn ${tag}: ${label}${where}, reported by ${inc.reporter}.${link ? ' Review: ' + link : ' Open the Stay Flow app.'}`,
    email: [
      `${tag}: ${label}${where}`, '',
      `Reported by: ${inc.reporter}`, `Time: ${inc.created_at} (UTC)`, '', 'What was reported:', inc.description, '',
      link ? `Review and mark it handled: ${link}` : 'Open the Stay Flow app to review it.',
      '', 'If anyone is in danger, call 911 first.',
    ].join('\n'),
  };
}

function loadIncident(id) {
  return db.prepare(
    `SELECT i.*, u.name AS reporter, r.number AS room_number FROM incidents i
     JOIN users u ON u.id=i.reporter_id LEFT JOIN rooms r ON r.id=i.room_id WHERE i.id=?`
  ).get(id);
}

async function notifyIncident(incidentId, { reminder = false } = {}) {
  const inc = loadIncident(incidentId);
  if (!inc || !inc.urgent) return;
  const msg = messageFor(inc, reminder);
  for (const r of recipients()) await deliver(r, msg, inc.id, reminder ? 'reminder' : 'alert');
}

// One reminder for urgent incidents nobody has reviewed after N minutes (0 turns it off).
async function sendDueReminders() {
  const mins = Number(getSettings().alert_reminder_minutes) || 0;
  if (!mins) return 0;
  const cutoff = new Date(Date.now() - mins * 60000).toISOString();
  const due = db.prepare("SELECT id FROM incidents WHERE urgent=1 AND status='open' AND reminded_at IS NULL AND created_at<=?").all(cutoff);
  for (const { id } of due) {
    db.prepare('UPDATE incidents SET reminded_at=? WHERE id=?').run(new Date().toISOString(), id);
    await notifyIncident(id, { reminder: true }).catch(() => {});
  }
  return due.length;
}

// A real message to the signed-in person's own contact details, so they know it works.
async function sendTest(userId) {
  const r = db.prepare('SELECT id,name,role,email,phone,alert_sms,alert_email FROM users WHERE id=?').get(userId);
  const msg = {
    subject: "Heidi's Inn: test alert",
    sms: "Heidi's Inn: this is a test alert from Stay Flow. If you got this, urgent alerts will reach you.",
    email: 'This is a test alert from Stay Flow. If you got this, urgent incident alerts will reach you at this address.',
  };
  await deliver({ ...r, alert_sms: 1, alert_email: 1 }, msg, null, 'test');
  return db.prepare("SELECT channel,status,detail FROM notifications WHERE user_id=? AND kind='test' ORDER BY id DESC LIMIT 2").all(userId);
}

function recentLog(limit = 15) {
  return db.prepare(
    `SELECT n.id,n.channel,n.kind,n.status,n.detail,n.created_at,u.name FROM notifications n
     LEFT JOIN users u ON u.id=n.user_id ORDER BY n.id DESC LIMIT ?`
  ).all(limit);
}

module.exports = { notifyIncident, sendDueReminders, sendTest, configured, recipients, recentLog, normalizePhone, validEmail, setTransports };
