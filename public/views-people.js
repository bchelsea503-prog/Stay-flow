import {
  S, h, GET, POST, attempt, toast, modal, confirmBox, fmtDateTime, fmtDay, ago, pill,
} from './util.js';

const isMgr = () => S.me.role !== 'employee';
const isOwner = () => S.me.role === 'owner';

// ================= playbook + digital acknowledgment =================
export async function playbookView(root) {
  const pb = await GET('/api/playbook');
  root.append(h('h2', null, 'SOP Playbook'));
  if (pb.required && !pb.signed) root.append(h('div', { class: 'note bad' }, 'Please read this in full, then sign at the bottom. You can\'t clock in until you have.'));
  if (pb.signed) root.append(h('div', { class: 'note ok' }, `✓ Signed by ${pb.signed.signed_name} on ${fmtDateTime(pb.signed.signed_at)}`));
  root.append(h('p', null, pb.INTRO || pb.intro));

  const sop = pb.SOP || pb.sop;
  root.append(h('section', { class: 'card' }, h('h3', null, 'Housekeeping SOP'),
    h('p', null, h('b', null, 'Mission: '), sop.mission),
    h('b', null, 'Attendance & professionalism'), h('ul', null, sop.attendance.map((t) => h('li', null, t))),
    h('b', null, 'Target room times'), h('ul', null, sop.targets.map((t) => h('li', null, t))),
    h('p', null, h('b', null, 'Safety: '), sop.safety),
    h('p', null, h('b', null, 'Lost & found: '), sop.lostFound),
    h('p', null, h('b', null, 'Inspection: '), sop.inspection),
    h('b', null, 'Goals'), h('ul', null, sop.goals.map((t) => h('li', null, t)))));

  for (const sec of pb.SECTIONS || pb.sections) {
    root.append(h('section', { class: 'card' }, h('h3', null, sec.title), h('ul', null, sec.items.map((t) => h('li', null, t)))));
  }

  const ack = pb.ACK_TEXT || pb.ack_text;
  const name = h('input', { placeholder: S.me.name, autocomplete: 'off' });
  const agree = h('input', { type: 'checkbox' });
  root.append(h('section', { class: 'card' }, h('h3', null, 'Employee Acknowledgment of Expectations'),
    h('p', null, 'By signing below, I confirm that I:'), h('ul', null, ack.map((t) => h('li', null, t))),
    h('p', null, pb.ACK_CLOSING || pb.ack_closing),
    !pb.signed && h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      if (await attempt(() => POST('/api/ack', { name: name.value, agree: agree.checked }), 'Signed. Thank you!')) { root.replaceChildren(); playbookView(root); }
    } },
      h('label', { class: 'inline' }, agree, ' I have read and agree to all of the above'),
      h('label', null, `Type your full name to sign (${S.me.name})`, name),
      h('button', { class: 'btn primary big' }, 'Sign acknowledgment'))));
}

// ================= incident report =================
const INCIDENT_CATS = [
  ['violence', 'Violence or fighting', true], ['threat', 'Threat or intimidation', true], ['harassment', 'Harassment', true],
  ['intoxication', 'Intoxication / under the influence', true], ['theft', 'Theft', true], ['safety', 'Safety hazard or emergency', true],
  ['standards', 'Standards issue (missed step, handoff, attitude)', false], ['guest_complaint', 'Guest complaint', false], ['other', 'Something else', false],
];
const catLabel = (c) => INCIDENT_CATS.find((x) => x[0] === c)?.[1] || c;

export async function incidentNewView(root) {
  const rooms = await GET('/api/rooms');
  const cat = h('select', null, h('option', { value: '' }, 'What happened?'), INCIDENT_CATS.map(([v, l, u]) => h('option', { value: v }, (u ? '🚨 ' : '') + l)));
  const room = h('select', null, h('option', { value: '' }, 'No specific room'), rooms.map((r) => h('option', { value: r.id }, 'Room ' + r.number)));
  const desc = h('textarea', { rows: 4, placeholder: 'Who, what, when, where. A few words is fine.', maxlength: 1500 });
  const hint = h('div', { class: 'note bad', hidden: true }, '🚨 Managers are alerted right away. If anyone is in danger, call 911 first.');
  cat.addEventListener('change', () => { hint.hidden = !INCIDENT_CATS.find((x) => x[0] === cat.value)?.[2]; });
  root.append(h('a', { class: 'back', href: 'javascript:history.back()' }, '‹ Back'), h('h2', null, 'Report an incident'),
    h('form', { class: 'card form', onsubmit: async (e) => {
      e.preventDefault();
      const r = await attempt(() => POST('/api/incidents', { category: cat.value, room_id: room.value, description: desc.value }));
      if (r) { toast(r.urgent ? 'Managers have been alerted' : 'Sent to your manager'); history.back(); }
    } }, hint, h('label', null, 'Type', cat), h('label', null, 'Room', room), h('label', null, 'What happened', desc), h('button', { class: 'btn danger big' }, 'Send report')));
}

export async function incidentsView(root) {
  const filter = sessionStorage.getItem('incFilter') || 'open';
  const rows = await GET('/api/incidents?status=' + filter);
  const reload = () => { root.replaceChildren(); incidentsView(root); window.dispatchEvent(new Event('sf-badges')); };
  root.append(h('h2', null, 'Incident reports'),
    h('div', { class: 'tabs' }, [['open', 'Waiting'], ['all', 'All']].map(([f, l]) => h('a', { class: 'tab' + (f === filter ? ' on' : ''), href: '#/incidents', onclick: () => sessionStorage.setItem('incFilter', f) }, l))),
    rows.length ? h('ul', { class: 'cards' }, rows.map((i) => h('li', { class: 'card' },
      h('div', { class: 'row between' }, h('b', null, (i.urgent ? '🚨 ' : '') + catLabel(i.category)), pill(i.status === 'open' ? (i.urgent ? 'bad' : 'warn') : 'ok', i.status === 'open' ? 'needs review' : 'reviewed')),
      h('p', null, i.description),
      h('div', { class: 'muted small' }, `${i.reporter}${i.room_number ? ' · Room ' + i.room_number : ''} · ${fmtDateTime(i.created_at)}`),
      i.status === 'reviewed' && h('div', { class: 'muted small' }, `Reviewed by ${i.reviewer}${i.review_note ? ': ' + i.review_note : ''}`),
      i.status === 'open' && h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => modal('Mark reviewed', (b, close) => {
        const note = h('textarea', { rows: 2, placeholder: 'What was done? (optional)' });
        b.append(h('div', { class: 'form' }, note, h('button', { class: 'btn primary', onclick: async () => { if (await attempt(() => POST(`/api/incidents/${i.id}/review`, { note: note.value }), 'Marked reviewed')) { close(); reload(); } } }, 'Mark reviewed')));
      }) }, 'Mark reviewed'))))) : h('p', { class: 'muted center' }, 'Nothing here.'));
}

// ================= my account + my record =================
export async function accountView(root) {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const nxt = h('input', { type: 'password', autocomplete: 'new-password', minlength: 6 });
  const rec = await GET('/api/me/accountability');
  root.append(h('h2', null, 'My account'),
    h('section', { class: 'card' }, h('b', null, S.me.name), h('div', { class: 'muted' }, `@${S.me.username} · ${S.me.role}`)),
    h('a', { class: 'card link', href: '#/playbook' }, '📘 SOP Playbook & my signed acknowledgment'));
  if (S.me.role !== 'owner') {
    root.append(h('section', { class: 'card' }, h('h3', null, 'My record'),
      h('p', null, `Standards warnings: ${rec.warnings_used} of 1 used`),
      rec.events.length ? h('ul', { class: 'list' }, rec.events.map(eventRow)) : h('p', { class: 'muted' }, 'Clean record. Keep it up!')));
  }
  root.append(
    h('form', { class: 'card form', onsubmit: async (e) => {
      e.preventDefault();
      if (await attempt(() => POST('/api/me/password', { current: cur.value, next: nxt.value }), 'Password changed')) { cur.value = ''; nxt.value = ''; }
    } }, h('h3', null, 'Change password'), h('label', null, 'Current password', cur), h('label', null, 'New password (6+ characters)', nxt), h('button', { class: 'btn primary' }, 'Update password')),
    h('a', { class: 'btn danger block', href: '#/incident/new' }, '🚨 Report an incident'),
    h('button', { class: 'btn ghost block', onclick: async () => { await POST('/api/logout'); location.hash = ''; location.reload(); } }, 'Sign out'));
}

function eventRow(e) {
  return h('li', { class: e.retracted_at ? 'retracted' : '' },
    h('div', null,
      h('b', null, e.kind === 'zero_tolerance' ? '⛔ Zero-tolerance' : '⚠ Warning'), e.category ? ` · ${e.category}` : '',
      e.retracted_at && pill('', 'retracted'),
      h('div', null, e.description),
      h('div', { class: 'muted small' }, `${fmtDay(e.event_date)} · logged by ${e.manager}`),
      e.retracted_at && h('div', { class: 'muted small' }, `Retracted by ${e.retracted_by_name}: ${e.retract_reason}`)));
}

// ================= employee profile (manager/owner) =================
export async function employeeView(root, [id]) {
  const t = await GET(`/api/employees/${id}/timeline`);
  const reload = () => { root.replaceChildren(); employeeView(root, [id]); };
  const st = t.stats;
  const rate = st.reviewed ? Math.round((st.first_pass / st.reviewed) * 100) : null;
  root.append(h('a', { class: 'back', href: '#/team' }, '‹ Team'),
    h('div', { class: 'row between' }, h('h2', null, t.user.name), h('button', { class: 'btn ghost no-print', onclick: () => window.print() }, '🖨 Print')),
    h('p', { class: 'muted' }, `${t.user.role}${t.user.phone ? ' · ' + t.user.phone : ''} · ${t.signed ? '✓ Acknowledgment signed' : '✗ Acknowledgment NOT signed'}`));

  const used = t.warnings_used;
  root.append(h('section', { class: 'card' },
    h('div', { class: 'row between' }, h('h3', null, 'Accountability'), h('button', { class: 'btn primary no-print', onclick: () => logModal(t.user, reload) }, '+ Log entry')),
    h('div', { class: 'note ' + (used ? 'bad' : 'ok') }, used ? `Warnings: ${used} of 1 used. The next same or similar issue means termination under the Accountability Standard.` : 'Warnings: 0 of 1 used'),
    t.events.length ? h('ul', { class: 'list' }, t.events.map((e) => h('li', { class: e.retracted_at ? 'retracted' : '' }, eventRow(e),
      isOwner() && !e.retracted_at && h('button', { class: 'btn ghost no-print', onclick: () => retractModal(e, reload) }, 'Retract')))) : h('p', { class: 'muted' }, 'No warnings or incidents on record.')));

  root.append(h('section', { class: 'card' }, h('h3', null, `Last 30 days (since ${fmtDay(t.since)})`),
    h('div', { class: 'stats small' },
      h('div', { class: 'stat' }, h('div', { class: 'v' }, st.reviewed), h('div', { class: 'l' }, 'Rooms inspected')),
      h('div', { class: 'stat ' + (rate !== null && rate < 95 ? 'warn' : 'ok') }, h('div', { class: 'v' }, rate === null ? '—' : rate + '%'), h('div', { class: 'l' }, 'First-pass rate (goal 95%)')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, st.avg_minutes ?? '—'), h('div', { class: 'l' }, 'Avg min / room'))),
    t.patterns.length ? h('div', { class: 'note bad' }, h('b', null, 'Pattern, not a bad day: '), t.patterns.map((p) => `"${p.text}" missed ${p.times}×`).join('; ')) : h('p', { class: 'muted small' }, 'No repeated missed steps.'),
    t.rejections.length ? h('ul', { class: 'list tight' }, t.rejections.map((r) => h('li', null, h('span', null, `Room ${r.room_number}: ${r.review_note || 'sent back'}`), h('span', { class: 'muted small' }, fmtDay(r.date))))) : null,
    t.clock_flags.length ? [h('h4', null, 'Time clock flags'), h('ul', { class: 'list tight' }, t.clock_flags.map((c) => h('li', null, h('span', null, c.flags.join(', ')), h('span', { class: 'muted small' }, fmtDateTime(c.clock_in)))))] : null));

  if (t.incidents.length) root.append(h('section', { class: 'card' }, h('h3', null, 'Incident reports filed by this person'), h('ul', { class: 'list tight' }, t.incidents.map((i) => h('li', null, h('span', null, `${catLabel(i.category)}: ${i.description}`), h('span', { class: 'muted small' }, ago(i.created_at)))))));
}

function logModal(user, done) {
  modal(`Log entry: ${user.name}`, (body, close) => {
    const kind = h('select', null, h('option', { value: 'warning' }, 'Documented written warning (standards issue)'), h('option', { value: 'zero_tolerance' }, 'Zero-tolerance event (violence, threats, theft, harassment, intoxication)'));
    const cat = h('input', { placeholder: 'Category, e.g. missed cleaning step', list: 'acc-cats', maxlength: 60 });
    const date = h('input', { type: 'date', value: S.today, max: S.today });
    const desc = h('textarea', { rows: 4, placeholder: 'What happened, when, and what was discussed with the employee', maxlength: 1500 });
    body.append(h('div', { class: 'form' },
      h('datalist', { id: 'acc-cats' }, ['missed cleaning step', 'unreported maintenance', 'attitude with a guest', 'shift handoff', 'violence', 'threat', 'harassment', 'intoxication', 'theft'].map((c) => h('option', { value: c }))),
      h('label', null, 'Type', kind), h('label', null, 'Category', cat), h('label', null, 'Date of event', date), h('label', null, 'Description', desc),
      h('p', { class: 'muted small' }, `This is permanent and recorded under your name (${S.me.name}). Only the owner can retract an entry, with a reason.`),
      h('button', { class: 'btn primary', onclick: async () => {
        const r = await attempt(() => POST('/api/accountability', { user_id: user.id, kind: kind.value, category: cat.value, event_date: date.value, description: desc.value }), 'Logged');
        if (r) { if (r.message) toast(r.message, 'err'); close(); done(); }
      } }, 'Save entry')));
  });
}

function retractModal(e, done) {
  modal('Retract entry', (body, close) => {
    const reason = h('input', { placeholder: 'Reason (kept on record)', maxlength: 300 });
    body.append(h('div', { class: 'form' }, h('p', null, 'The entry stays visible, marked as retracted, and no longer counts toward the warning limit.'), reason,
      h('button', { class: 'btn danger', onclick: async () => { if (await attempt(() => POST(`/api/accountability/${e.id}/retract`, { reason: reason.value }), 'Retracted')) { close(); done(); } } }, 'Retract')));
  });
}
