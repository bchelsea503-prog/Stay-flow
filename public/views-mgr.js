import {
  S, h, GET, POST, PATCH, PUT, DEL, attempt, toast, modal, confirmBox, fmtTime, fmtDateTime, fmtDay, fmtHrs, money, ago, duration,
  pill, ROOM_LABEL, ASSIGN_LABEL, addDays, weekStart, isoToLocalInput, localInputToIso,
} from './util.js';

const isOwner = () => S.me.role === 'owner';
const stat = (label, value, cls = '', href) =>
  h(href ? 'a' : 'div', { class: 'stat ' + cls, href }, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label));

// ================= dashboard =================
export async function homeView(root) {
  const d = await GET('/api/dashboard');
  const rc = d.roomCounts;
  const totalRooms = Object.values(rc).reduce((a, b) => a + b, 0);
  root.append(h('h2', null, isOwner() ? `${S.settings.property_name}: owner view` : 'Manager dashboard'),
    h('p', { class: 'muted' }, `${fmtDay(d.today)} · property time ${fmtTime(new Date().toISOString())}`));

  root.append(h('div', { class: 'stats' },
    stat('Need cleaning', rc.dirty, rc.dirty ? 'warn' : '', '#/rooms'),
    stat('Awaiting review', d.pending.length, d.pending.length ? 'warn' : '', '#/rooms'),
    stat('Ready', `${rc.clean}/${totalRooms}`, 'ok'),
    stat('Out of order', rc.out_of_order, rc.out_of_order ? 'bad' : '', '#/roomlist')));

  // review queue
  if (d.pending.length) {
    root.append(h('section', { class: 'card' }, h('h3', null, `Rooms to review (${d.pending.length})`),
      h('ul', { class: 'list' }, d.pending.map((a) => h('li', null, h('a', { href: '#/room/' + a.id },
        h('b', null, 'Room ' + a.room_number), ` · ${a.user_name} · ${ago(a.submitted_at)} · 📷${a.photo_count}`))))));
  }
  if (d.unassigned.length) {
    root.append(h('section', { class: 'card' }, h('h3', null, `Dirty & unassigned (${d.unassigned.length})`),
      h('p', null, d.unassigned.map((r) => r.number).join(', ')),
      h('a', { class: 'btn primary', href: '#/rooms' }, 'Assign rooms')));
  }

  // who is working
  root.append(h('section', { class: 'card' }, h('h3', null, `On the clock now (${d.clockedIn.length})`),
    d.clockedIn.length
      ? h('ul', { class: 'list' }, d.clockedIn.map((c) => h('li', null,
          h('span', null, h('b', null, c.name), c.suspicious && pill('bad', 'check clock-out')),
          h('span', { class: 'muted' }, `since ${fmtTime(c.clock_in)} · ${duration(c.clock_in)}`))))
      : h('p', { class: 'muted' }, 'Nobody is clocked in.'),
    h('div', { class: 'stats small' },
      stat('Hours today', fmtHrs(d.dayHours)),
      stat('Hours this week', fmtHrs(d.weekHours)),
      stat('Overtime (wk)', fmtHrs(d.weekOvertime), d.weekOvertime ? 'warn' : ''),
      isOwner() && stat('Labor cost (wk)', money(d.weekLabor)))));

  // today's progress
  const ac = d.assignCounts;
  root.append(h('section', { class: 'card' }, h('h3', null, "Today's cleaning"),
    h('div', { class: 'stats small' },
      stat('To do', ac.assigned), stat('In progress', ac.in_progress), stat('Submitted', ac.submitted), stat('Approved', ac.approved), stat('Redo', ac.rejected, ac.rejected ? 'bad' : ''))));

  // maintenance
  const mc = d.maintCounts;
  root.append(h('section', { class: 'card' }, h('div', { class: 'row between' }, h('h3', null, 'Open maintenance'), h('a', { href: '#/maint' }, 'See all')),
    h('div', { class: 'stats small' }, stat('Urgent', mc.urgent, mc.urgent ? 'bad' : ''), stat('High', mc.high, mc.high ? 'warn' : ''), stat('Normal', mc.normal), stat('Low', mc.low)),
    d.maintTop.length && h('ul', { class: 'list' }, d.maintTop.map((m) => h('li', null, h('a', { href: '#/maint/' + m.id }, m.title), h('span', { class: 'muted' }, [m.room_number && 'Rm ' + m.room_number, m.priority].filter(Boolean).join(' · ')))))));

  // inventory
  root.append(h('section', { class: 'card' }, h('div', { class: 'row between' }, h('h3', null, 'Low stock'), h('a', { href: '#/inventory' }, 'Inventory')),
    d.lowStock.length
      ? h('ul', { class: 'list' }, d.lowStock.map((i) => h('li', null, h('b', null, i.name), h('span', { class: i.qty === 0 ? 'bad-text' : 'warn-text' }, `${i.qty} / ${i.par} ${i.unit}`))))
      : h('p', { class: 'muted' }, 'Everything is above par level. ✓')));

  if (isOwner() && d.activity) {
    root.append(h('section', { class: 'card' }, h('h3', null, 'Recent activity'),
      h('ul', { class: 'list tight' }, d.activity.map((a) => h('li', null, h('span', null, h('b', null, a.name || 'System'), ' ', a.action.replace(/_/g, ' '), a.detail ? ': ' + a.detail : ''), h('span', { class: 'muted small' }, ago(a.created_at)))))));
  }
}

// ================= rooms board =================
export async function roomsBoardView(root) {
  let date = sessionStorage.getItem('boardDate') || S.today;
  if (date < addDays(S.today, -30)) date = S.today;
  const [rows, review] = await Promise.all([GET('/api/assignments?date=' + date), GET('/api/assignments/review')]);
  const go = (d) => { sessionStorage.setItem('boardDate', d); root.replaceChildren(); roomsBoardView(root); };

  root.append(h('div', { class: 'row between' }, h('h2', null, 'Rooms'),
    h('div', { class: 'row' }, h('a', { class: 'btn ghost', href: '#/roomlist' }, 'Room list'), h('button', { class: 'btn primary', onclick: () => assignModal(date, go) }, '+ Assign'))),
    h('div', { class: 'datebar' },
      h('button', { class: 'btn ghost', onclick: () => go(addDays(date, -1)), 'aria-label': 'Previous day' }, '‹'),
      h('b', null, fmtDay(date), date === S.today ? ' (today)' : ''),
      h('button', { class: 'btn ghost', onclick: () => go(addDays(date, 1)), 'aria-label': 'Next day' }, '›'),
      date !== S.today && h('button', { class: 'btn ghost', onclick: () => go(S.today) }, 'Today')));

  const card = (a) => h('li', null, h('a', { class: 'card link room-card ' + a.status, href: '#/room/' + a.id },
    h('div', { class: 'room-num' }, a.room_number),
    h('div', { class: 'grow' }, h('b', null, a.user_name), h('div', { class: 'muted small' }, `${a.clean_type} · ${a.checks_done}/${a.checks_total} tasks · 📷${a.photo_count}${a.submitted_at ? ' · submitted ' + fmtTime(a.submitted_at) : ''}`)),
    pill(a.status, ASSIGN_LABEL[a.status])));

  if (review.length) root.append(h('h3', null, `Needs your review (${review.length})`), h('ul', { class: 'cards' }, review.map(card)));
  root.append(h('h3', null, `Assignments (${rows.length})`),
    rows.length ? h('ul', { class: 'cards' }, rows.map(card)) : h('p', { class: 'muted center' }, 'Nothing assigned for this day yet.'));
}

async function assignModal(date, done) {
  const [rooms, staff, existing] = await Promise.all([GET('/api/rooms'), GET('/api/staff'), GET('/api/assignments?date=' + date)]);
  const taken = new Set(existing.filter((a) => a.status !== 'rejected').map((a) => a.room_id));
  modal('Assign rooms', (body, close) => {
    const who = h('select', null, staff.filter((s) => s.role === 'employee' || true).map((s) => h('option', { value: s.id }, s.name + (s.role !== 'employee' ? ` (${s.role})` : ''))));
    const type = h('select', null, h('option', { value: 'checkout' }, 'Checkout clean'), h('option', { value: 'stayover' }, 'Stayover (lighter)'), h('option', { value: 'deep' }, 'Deep clean'));
    const day = h('input', { type: 'date', value: date });
    const boxes = rooms.filter((r) => r.status !== 'out_of_order').map((r) => {
      const cb = h('input', { type: 'checkbox', value: r.id, disabled: taken.has(r.id), checked: !taken.has(r.id) && r.status === 'dirty' });
      return h('label', { class: 'chip-check' + (taken.has(r.id) ? ' off' : '') }, cb, h('span', null, r.number, h('small', null, taken.has(r.id) ? 'assigned' : r.status === 'dirty' ? 'dirty' : '')));
    });
    body.append(h('div', { class: 'form' },
      h('label', null, 'Housekeeper', who), h('div', { class: 'grid2' }, h('label', null, 'Type', type), h('label', null, 'Date', day)),
      h('div', null, h('b', null, 'Rooms'), h('div', { class: 'chips' }, boxes)),
      h('button', { class: 'btn primary big', onclick: async () => {
        const ids = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked && !i.disabled).map((i) => Number(i.value));
        if (!ids.length) return toast('Pick at least one room', 'err');
        const r = await attempt(() => POST('/api/assignments', { user_id: Number(who.value), room_ids: ids, clean_type: type.value, date: day.value }));
        if (r) { toast(`${r.created} room(s) assigned`); close(); done(day.value); }
      } }, 'Assign')));
  });
}

export async function roomListView(root) {
  const rooms = await GET('/api/rooms');
  const reload = () => { root.replaceChildren(); roomListView(root); };
  const nums = h('input', { placeholder: 'Add rooms: 101, 102, 103…' });
  const type = h('input', { placeholder: 'Type (standard, suite…)', value: 'standard', list: 'rtypes' });
  root.append(h('a', { class: 'back', href: '#/rooms' }, '‹ Back'), h('h2', null, 'Room list'),
    h('form', { class: 'card form', onsubmit: async (e) => { e.preventDefault(); const r = await attempt(() => POST('/api/rooms', { numbers: nums.value, type: type.value })); if (r) { toast(`${r.added} added`); reload(); } } },
      h('div', { class: 'row' }, nums, type, h('button', { class: 'btn primary' }, 'Add'))),
    h('datalist', { id: 'rtypes' }, [...new Set(rooms.map((r) => r.type).concat(['standard', 'suite', 'king', 'double']))].map((t) => h('option', { value: t }))),
    h('ul', { class: 'cards' }, rooms.map((r) => {
      const sel = h('select', { 'aria-label': 'Status of room ' + r.number }, Object.entries(ROOM_LABEL).map(([k, v]) => h('option', { value: k, selected: k === r.status }, v)));
      sel.addEventListener('change', () => attempt(() => PATCH('/api/rooms/' + r.id, { status: sel.value }), 'Updated'));
      return h('li', { class: 'card row between' }, h('div', null, h('b', null, 'Room ' + r.number), h('div', { class: 'muted small' }, r.type)),
        h('div', { class: 'row' }, sel,
          h('button', { class: 'btn ghost', onclick: () => editRoom(r, reload) }, '✎'),
          isOwner() && h('button', { class: 'btn ghost', 'aria-label': 'Remove room', onclick: async () => { if (await confirmBox(`Remove room ${r.number}? History is kept.`, 'Remove') && await attempt(() => DEL('/api/rooms/' + r.id))) reload(); } }, '🗑')));
    })));
}

function editRoom(r, done) {
  modal('Room ' + r.number, (body, close) => {
    const type = h('input', { value: r.type });
    const notes = h('textarea', { rows: 3, placeholder: 'Standing notes housekeepers see (e.g. "pet-friendly, extra towels")' }, r.notes);
    body.append(h('div', { class: 'form' }, h('label', null, 'Type', type), h('label', null, 'Notes for housekeepers', notes),
      h('button', { class: 'btn primary', onclick: async () => { if (await attempt(() => PATCH('/api/rooms/' + r.id, { type: type.value, notes: notes.value }), 'Saved')) { close(); done(); } } }, 'Save')));
  });
}

// ================= hours =================
export async function hoursView(root) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const from = q.get('from') || weekStart(S.today);
  const to = q.get('to') || S.today;
  const [rep, entries, prod, staff] = await Promise.all([
    GET(`/api/reports/hours?from=${from}&to=${to}`), GET(`/api/clock/entries?from=${from}&to=${to}`),
    GET(`/api/reports/productivity?from=${from}&to=${to}`), GET('/api/staff'),
  ]);
  const reload = () => { root.replaceChildren(); hoursView(root); };
  const setRange = (f, t) => { location.hash = `#/hours?from=${f}&to=${t}`; };
  const f = h('input', { type: 'date', value: from }); const t = h('input', { type: 'date', value: to });
  const apply = () => f.value && t.value && setRange(f.value, t.value);
  f.addEventListener('change', apply); t.addEventListener('change', apply);
  const thisWeek = weekStart(S.today);

  root.append(h('div', { class: 'row between' }, h('h2', null, 'Hours & payroll'), h('button', { class: 'btn primary', onclick: () => entryModal(null, staff, reload) }, '+ Add time')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn ghost', onclick: () => setRange(thisWeek, S.today) }, 'This week'),
      h('button', { class: 'btn ghost', onclick: () => setRange(addDays(thisWeek, -7), addDays(thisWeek, -1)) }, 'Last week'),
      h('button', { class: 'btn ghost', onclick: () => setRange(addDays(S.today, -13), S.today) }, 'Last 14 days'),
      f, '→', t),
    h('section', { class: 'card scroll' }, h('table', null,
      h('thead', null, h('tr', null, ['Employee', 'Regular', 'OT', 'Total'].concat(isOwner() ? ['Pay'] : []).map((x) => h('th', null, x)))),
      h('tbody', null, rep.users.map((u) => h('tr', null, h('td', null, u.name, u.open && pill('ok', 'on clock')), h('td', null, fmtHrs(u.regular)), h('td', { class: u.overtime ? 'warn-text' : '' }, fmtHrs(u.overtime)), h('td', null, h('b', null, fmtHrs(u.hours))), isOwner() && h('td', null, money(u.pay)))),
        !rep.users.length && h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'No time recorded in this range.'))),
      h('tfoot', null, h('tr', null, h('td', null, 'Total'), h('td'), h('td', null, fmtHrs(rep.totals.overtime)), h('td', null, fmtHrs(rep.totals.hours)), isOwner() && h('td', null, money(rep.totals.pay)))))),
    h('a', { class: 'btn ghost block', href: `/api/reports/hours?format=csv&from=${from}&to=${to}`, download: '' }, '⬇ Download CSV for payroll'),
    h('p', { class: 'muted small' }, `Overtime = hours over ${rep.overtime_weekly_hours}/week (Mon–Sun), paid at 1.5×. Times shown in ${S.settings.timezone}.`));

  root.append(h('h3', null, 'Time entries'),
    entries.length ? h('ul', { class: 'cards' }, entries.map((e) => h('li', { class: 'card row between' },
      h('div', null, h('b', null, e.name), h('div', { class: 'muted small' }, `${fmtDateTime(e.clock_in)} → ${e.clock_out ? fmtTime(e.clock_out) : 'still on'} · ${duration(e.clock_in, e.clock_out)}${e.edited_by ? ' · edited' : ''}${e.note ? ' · ' + e.note : ''}`)),
      h('button', { class: 'btn ghost', onclick: () => entryModal(e, staff, reload) }, 'Edit')))) : h('p', { class: 'muted' }, 'No entries.'));

  root.append(h('h3', null, 'Room quality & speed'),
    h('section', { class: 'card scroll' }, h('table', null, h('thead', null, h('tr', null, ['Housekeeper', 'Rooms', 'Approved', 'Sent back', 'Avg min/room'].map((x) => h('th', null, x)))),
      h('tbody', null, prod.users.map((u) => h('tr', null, h('td', null, u.name), h('td', null, u.rooms), h('td', null, u.approved), h('td', { class: u.rejected ? 'warn-text' : '' }, u.rejected), h('td', null, u.avg_minutes ?? '—'))),
        !prod.users.length && h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'No cleanings in range.'))))));
}

function entryModal(e, staff, done) {
  modal(e ? 'Edit time entry' : 'Add time', (body, close) => {
    const who = h('select', { disabled: !!e }, staff.map((s) => h('option', { value: s.id, selected: e && s.id === e.user_id }, s.name)));
    const cin = h('input', { type: 'datetime-local', value: isoToLocalInput(e?.clock_in) });
    const cout = h('input', { type: 'datetime-local', value: isoToLocalInput(e?.clock_out) });
    const note = h('input', { placeholder: 'Reason / note', value: e?.note || '', maxlength: 200 });
    body.append(h('div', { class: 'form' }, !e && h('label', null, 'Employee', who),
      h('label', null, 'Clock in', cin), h('label', null, 'Clock out (leave blank if still working)', cout), h('label', null, 'Note', note),
      h('p', { class: 'muted small' }, `Times are in ${S.settings.timezone}. Every edit is logged.`),
      h('div', { class: 'row between' },
        e ? h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('Delete this entry?', 'Delete') && await attempt(() => DEL('/api/clock/entries/' + e.id), 'Deleted')) { close(); done(); } } }, 'Delete') : h('span'),
        h('button', { class: 'btn primary', onclick: async () => {
          const payload = { clock_in: localInputToIso(cin.value), clock_out: localInputToIso(cout.value), note: note.value };
          const r = await attempt(() => (e ? PATCH('/api/clock/entries/' + e.id, payload) : POST('/api/clock/entries', { ...payload, user_id: Number(who.value) })), 'Saved');
          if (r) { close(); done(); }
        } }, 'Save'))));
  });
}

// ================= inventory =================
export async function inventoryView(root) {
  const items = await GET('/api/inventory');
  const reload = () => { root.replaceChildren(); inventoryView(root); };
  const low = items.filter((i) => i.par > 0 && i.qty <= i.par);
  root.append(h('div', { class: 'row between' }, h('h2', null, 'Inventory'), h('button', { class: 'btn primary', onclick: () => itemModal(null, reload) }, '+ Item')));
  if (isOwner()) {
    const value = items.reduce((a, i) => a + i.qty * i.unit_cost, 0);
    root.append(h('p', { class: 'muted' }, `${items.length} items · on-hand value ${money(value)}`));
  }
  if (low.length) root.append(h('div', { class: 'note bad' }, `Low or out: ${low.map((i) => i.name).join(', ')}`));
  const byCat = {};
  items.forEach((i) => (byCat[i.category] ||= []).push(i));
  for (const [cat, list] of Object.entries(byCat)) {
    root.append(h('h3', null, cat), h('ul', { class: 'cards' }, list.map((i) => {
      const isLow = i.par > 0 && i.qty <= i.par;
      return h('li', { class: 'card row between' },
        h('div', { class: 'grow', onclick: () => itemModal(i, reload) }, h('b', null, i.name), h('div', { class: 'muted small' }, `Par ${i.par} ${i.unit}${i.location ? ' · ' + i.location : ''}`)),
        h('div', { class: 'qty ' + (i.qty === 0 ? 'bad-text' : isLow ? 'warn-text' : '') }, `${i.qty}`, h('small', null, ' ' + i.unit)),
        h('button', { class: 'btn', onclick: () => adjustModal(i, reload) }, '±'));
    })));
  }
  if (!items.length) root.append(h('p', { class: 'muted center' }, 'No items yet. Add linens, amenities, cleaning supplies…'));
}

function adjustModal(i, done) {
  modal(i.name, (body, close) => {
    const amt = h('input', { type: 'number', step: 'any', inputmode: 'decimal', placeholder: 'e.g. 12 or -3' });
    const count = h('input', { type: 'number', step: 'any', min: 0, inputmode: 'decimal', placeholder: 'Actual count' });
    const note = h('input', { placeholder: 'Note (delivery, laundry loss, …)', maxlength: 200 });
    const save = async (payload) => { if (await attempt(() => POST(`/api/inventory/${i.id}/adjust`, { ...payload, note: note.value }), 'Updated')) { close(); done(); } };
    body.append(h('div', { class: 'form' }, h('p', null, `On hand: ${i.qty} ${i.unit}`),
      h('label', null, 'Add (+) or use (−)', amt), h('button', { class: 'btn primary', onclick: () => save({ delta: amt.value }) }, 'Apply change'),
      h('hr'), h('label', null, 'Or set an exact count', count), h('button', { class: 'btn', onclick: () => save({ set: count.value }) }, 'Save recount'), note));
    GET(`/api/inventory/${i.id}/log`).then((log) => body.append(h('h4', null, 'History'), h('ul', { class: 'list tight' }, log.slice(0, 8).map((l) => h('li', null, h('span', null, `${l.delta > 0 ? '+' : ''}${l.delta} · ${l.name}${l.note ? ' · ' + l.note : ''}`), h('span', { class: 'muted small' }, ago(l.created_at)))))));
  });
}

function itemModal(i, done) {
  modal(i ? 'Edit item' : 'New item', (body, close) => {
    const f = {
      name: h('input', { value: i?.name || '', maxlength: 100 }), category: h('input', { value: i?.category || 'General', list: 'icat' }),
      unit: h('input', { value: i?.unit || 'each' }), qty: h('input', { type: 'number', step: 'any', value: 0, min: 0 }),
      par: h('input', { type: 'number', step: 'any', value: i?.par ?? 0, min: 0 }), cost: h('input', { type: 'number', step: 'any', value: i?.unit_cost ?? 0, min: 0 }),
      loc: h('input', { value: i?.location || '' }),
    };
    body.append(h('div', { class: 'form' }, h('label', null, 'Name', f.name), h('div', { class: 'grid2' }, h('label', null, 'Category', f.category), h('label', null, 'Unit', f.unit)),
      !i && h('label', null, 'Starting quantity', f.qty), h('div', { class: 'grid2' }, h('label', null, 'Par level (reorder at/below)', f.par), isOwner() && h('label', null, 'Cost per unit', f.cost)),
      h('label', null, 'Where it lives', f.loc),
      h('div', { class: 'row between' },
        i ? h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox(`Remove ${i.name}?`, 'Remove') && await attempt(() => DEL('/api/inventory/' + i.id))) { close(); done(); } } }, 'Remove') : h('span'),
        h('button', { class: 'btn primary', onclick: async () => {
          const p = { name: f.name.value, category: f.category.value, unit: f.unit.value, par: f.par.value, unit_cost: f.cost.value, location: f.loc.value, qty: f.qty.value };
          if (await attempt(() => (i ? PATCH('/api/inventory/' + i.id, p) : POST('/api/inventory', p)), 'Saved')) { close(); done(); }
        } }, 'Save'))));
  });
}

// ================= team =================
export async function teamView(root) {
  const users = await GET('/api/users');
  const reload = () => { root.replaceChildren(); teamView(root); };
  root.append(h('div', { class: 'row between' }, h('h2', null, 'Team'), h('button', { class: 'btn primary', onclick: () => userModal(null, reload) }, '+ Add person')),
    h('ul', { class: 'cards' }, users.map((u) => h('li', { class: 'card row between' + (u.active ? '' : ' inactive'), onclick: () => (u.role === 'owner' ? null : userModal(u, reload)) },
      h('div', null, h('b', null, u.name), h('div', { class: 'muted small' }, `@${u.username}${u.phone ? ' · ' + u.phone : ''}${isOwner() && u.role !== 'owner' ? ' · ' + money(u.hourly_rate) + '/hr' : ''}`)),
      h('span', null, !u.active && pill('', 'inactive'), pill(u.role === 'employee' ? '' : 'ok', u.role))))));
}

function userModal(u, done) {
  modal(u ? u.name : 'Add person', (body, close) => {
    const f = {
      name: h('input', { value: u?.name || '' }), username: h('input', { value: u?.username || '', disabled: !!u, autocapitalize: 'none', placeholder: 'login name' }),
      phone: h('input', { value: u?.phone || '', type: 'tel' }), pass: h('input', { type: 'text', autocomplete: 'off', placeholder: u ? 'Leave blank to keep' : 'At least 6 characters' }),
      rate: h('input', { type: 'number', step: '0.01', min: 0, value: u?.hourly_rate ?? 0 }),
      role: h('select', null, ['employee', 'manager'].map((r) => h('option', { value: r, selected: u?.role === r }, r))),
    };
    body.append(h('div', { class: 'form' }, h('label', null, 'Full name', f.name), h('label', null, 'Username', f.username), h('label', null, 'Phone', f.phone),
      isOwner() && h('div', { class: 'grid2' }, h('label', null, 'Role', f.role), h('label', null, 'Hourly rate ($)', f.rate)),
      h('label', null, u ? 'Reset password' : 'Password', f.pass),
      h('div', { class: 'row between' },
        u ? h('button', { class: 'btn ' + (u.active ? 'danger' : ''), onclick: async () => { if (await attempt(() => PATCH('/api/users/' + u.id, { active: !u.active }), u.active ? 'Deactivated' : 'Reactivated')) { close(); done(); } } }, u.active ? 'Deactivate' : 'Reactivate') : h('span'),
        h('button', { class: 'btn primary', onclick: async () => {
          const p = { name: f.name.value, phone: f.phone.value };
          if (isOwner()) { p.hourly_rate = f.rate.value; p.role = f.role.value; }
          if (f.pass.value) p.password = f.pass.value;
          const r = await attempt(() => (u ? PATCH('/api/users/' + u.id, p) : POST('/api/users', { ...p, username: f.username.value, password: f.pass.value, role: isOwner() ? f.role.value : 'employee' })), 'Saved');
          if (r) { close(); done(); }
        } }, 'Save'))));
  });
}

// ================= checklist template =================
export async function checklistView(root) {
  const items = await GET('/api/checklist');
  const reload = () => { root.replaceChildren(); checklistView(root); };
  const text = h('input', { placeholder: 'New task, e.g. "Wipe baseboards"', maxlength: 200 });
  const co = h('input', { type: 'checkbox' });
  root.append(h('h2', null, 'Cleaning checklist'), h('p', { class: 'muted' }, "These are the tasks every housekeeper must tick off before they can submit a room. Changes apply to rooms assigned from now on."),
    h('form', { class: 'card form', onsubmit: async (e) => { e.preventDefault(); if (text.value && await attempt(() => POST('/api/checklist', { text: text.value, checkout_only: co.checked }))) reload(); } },
      h('div', { class: 'row' }, text, h('button', { class: 'btn primary' }, 'Add')), h('label', { class: 'inline' }, co, ' Checkout cleans only (skip on stayovers)')),
    h('ul', { class: 'cards' }, items.map((it, idx) => h('li', { class: 'card row between' },
      h('div', { class: 'grow' }, it.text, it.checkout_only ? h('div', { class: 'muted small' }, 'checkout only') : null),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', 'aria-label': 'Move up', disabled: idx === 0, onclick: async () => { await swap(items[idx - 1], it); reload(); } }, '↑'),
        h('button', { class: 'btn ghost', 'aria-label': 'Edit', onclick: () => editItem(it, reload) }, '✎'),
        h('button', { class: 'btn ghost', 'aria-label': 'Delete', onclick: async () => { if (await confirmBox('Remove this task from the checklist?', 'Remove') && await attempt(() => DEL('/api/checklist/' + it.id))) reload(); } }, '🗑'))))));
}
async function swap(a, b) {
  const pa = a.position, pb = b.position === a.position ? a.position + 1 : b.position;
  await PATCH('/api/checklist/' + a.id, { position: pb });
  await PATCH('/api/checklist/' + b.id, { position: pa });
}
function editItem(it, done) {
  modal('Edit task', (body, close) => {
    const t = h('input', { value: it.text, maxlength: 200 }); const c = h('input', { type: 'checkbox', checked: !!it.checkout_only });
    body.append(h('div', { class: 'form' }, t, h('label', { class: 'inline' }, c, ' Checkout cleans only'),
      h('button', { class: 'btn primary', onclick: async () => { if (await attempt(() => PATCH('/api/checklist/' + it.id, { text: t.value, checkout_only: c.checked }), 'Saved')) { close(); done(); } } }, 'Save')));
  });
}

// ================= settings (owner) =================
export async function settingsView(root) {
  const s = await GET('/api/settings');
  const f = {
    name: h('input', { value: s.property_name }), tz: h('input', { value: s.timezone, list: 'tzs' }),
    photos: h('input', { type: 'number', min: 0, max: 10, value: s.min_photos }), ot: h('input', { type: 'number', min: 1, value: s.overtime_weekly_hours }),
    clock: h('input', { type: 'checkbox', checked: s.require_clock_in === '1' }),
  };
  root.append(h('h2', null, 'Settings'),
    h('datalist', { id: 'tzs' }, ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York'].map((z) => h('option', { value: z }))),
    h('form', { class: 'card form', onsubmit: async (e) => {
      e.preventDefault();
      if (await attempt(() => PUT('/api/settings', { property_name: f.name.value, timezone: f.tz.value, min_photos: f.photos.value, overtime_weekly_hours: f.ot.value, require_clock_in: f.clock.checked }), 'Settings saved')) setTimeout(() => location.reload(), 600);
    } },
      h('label', null, 'Property name', f.name), h('label', null, 'Property timezone (Ilwaco, WA = America/Los_Angeles)', f.tz),
      h('label', null, 'Photos required per room', f.photos), h('label', null, 'Overtime after (hours per week)', f.ot),
      h('label', { class: 'inline' }, f.clock, ' Staff must be clocked in to work on rooms'),
      h('button', { class: 'btn primary' }, 'Save settings')),
    h('section', { class: 'card' }, h('h3', null, 'Backup'), h('p', { class: 'muted' }, 'Download a full copy of your data (staff, hours, rooms, inventory). Photos are kept on the server.'),
      h('a', { class: 'btn', href: '/api/backup', download: '' }, '⬇ Download backup')));
}
