// Date helpers. The owner may be in a different timezone than the property,
// so every "day" and "week" is computed in the property's timezone.

function localDate(tz, d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// Monday of the week containing ymd
function weekStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  return addDays(ymd, -((dow + 6) % 7));
}

function isYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

function hoursBetween(startIso, endIso) {
  return Math.max(0, (Date.parse(endIso) - Date.parse(startIso)) / 3600000);
}

module.exports = { localDate, addDays, weekStart, isYmd, hoursBetween };
