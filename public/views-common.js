import {
  S, h, GET, POST, PATCH, PUT, DEL, api, toast, attempt, modal, confirmBox, fmtTime, fmtDateTime, fmtDay, ago, duration,
  pill, ROOM_LABEL, ASSIGN_LABEL, photoPicker, photoUrl, viewPhoto, isoToLocalInput,
} from './util.js';

const isMgr = () => S.me.role !== 'employee';

// ================= clock card =================
export async function clockCard(onChange) {
  const card = h('section', { class: 'card clock' });
  let tick;
  async function render() {
    clearInterval(tick);
    const st = await GET('/api/clock/status');
    card.replaceChildren();
    if (st.open) {
      const onBreak = st.break?.on_break;
      const stamp = onBreak ? st.break.since : st.open.clock_in;
      const timer = h('div', { class: 'big-time' }, duration(stamp));
      tick = setInterval(() => { if (!card.isConnected) return clearInterval(tick); timer.textContent = duration(stamp); }, 15000);
      card.append(
        h('div', { class: 'row between' },
          h('div', null, onBreak ? pill('warn', 'On break') : pill('ok', 'Clocked in'),
            h('div', { class: 'muted' }, onBreak ? 'Break started ' + fmtTime(st.break.since) : 'Since ' + fmtTime(st.open.clock_in)),
            st.break.minutes_today > 0 && !onBreak && h('div', { class: 'muted small' }, `Breaks today: ${st.break.minutes_today} min`)),
          timer),
        h('div', { class: 'row' },
          h('button', { class: 'btn big grow ' + (onBreak ? 'primary' : ''), onclick: async () => {
            if (await attempt(() => POST(onBreak ? '/api/clock/break/end' : '/api/clock/break/start'), onBreak ? 'Welcome back' : 'Break started')) { await render(); onChange?.(); }
          } }, onBreak ? 'End break' : 'Start break'),
          h('button', { class: 'btn big grow danger', onclick: () => out(false) }, 'Clock out'))
      );
    } else {
      card.append(
        h('div', { class: 'row between' }, h('div', null, pill('', 'Clocked out'), h('div', { class: 'muted' }, `Today: ${st.today_hours.toFixed(2)} hrs`))),
        st.needs_ack && h('div', { class: 'note bad' }, 'Before your first shift you need to read and sign the Employee Acknowledgment. ', h('a', { href: '#/playbook' }, 'Open it now')),
        h('button', { class: 'btn big primary', onclick: async () => { if (await attempt(() => POST('/api/clock/in'), 'Clocked in')) { await render(); onChange?.(); } } }, 'Clock in')
      );
    }
    card._status = st;
  }
  async function out(force) {
    try {
      await POST('/api/clock/out', { force });
      toast('Clocked out. Have a good one!');
      await render(); onChange?.();
    } catch (e) {
      if (e.status === 409 && /anyway/.test(e.message)) {
        if (await confirmBox(e.message, 'Clock out anyway')) out(true);
      } else toast(e.message, 'err');
    }
  }
  await render();
  return card;
}

export async function clockView(root) {
  root.append(h('h2', null, 'Time clock'), await clockCard());
  const st = await GET('/api/clock/status');
  root.append(
    h('section', { class: 'card' }, h('h3', null, 'Recent shifts'),
      st.recent.length
        ? h('ul', { class: 'list' }, st.recent.map((e) => h('li', null,
            h('div', null, h('b', null, fmtDateTime(e.clock_in)), ' → ', e.clock_out ? fmtTime(e.clock_out) : h('i', null, 'now')),
            h('span', { class: 'muted' }, duration(e.clock_in, e.clock_out)))))
        : h('p', { class: 'muted' }, 'No shifts yet.'),
      h('p', { class: 'muted small' }, 'Something look wrong? Tell your manager and they can fix it.'))
  );
}

// ================= room detail (checklist + photos) =================
export async function roomView(root, [id]) {
  const a = await GET('/api/assignments/' + id);
  const mine = a.user_id === S.me.id;
  const canEdit = ['assigned', 'in_progress', 'rejected'].includes(a.status) && (mine || isMgr());
  root.append(h('a', { class: 'back', href: isMgr() ? '#/rooms' : '#/rooms' }, '‹ Back'));
  root.append(
    h('div', { class: 'row between' },
      h('h2', null, `Room ${a.room_number}`),
      pill(a.status, ASSIGN_LABEL[a.status])),
    h('p', { class: 'muted' }, `${a.clean_type === 'stayover' ? 'Stayover' : a.clean_type === 'deep' ? 'Deep clean' : 'Checkout'} · ${a.user_name} · ${fmtDay(a.date)}${a.target_max ? ` · target ≤ ${a.target_max} min` : ''}`),
    a.started_at && a.status === 'in_progress' && h('p', { class: 'muted small' }, `Started ${fmtTime(a.started_at)} (${duration(a.started_at)} ago). Quality always comes before speed.`)
  );
  if (a.room_notes) root.append(h('div', { class: 'note' }, '📌 ' + a.room_notes));
  if (a.status === 'rejected') root.append(h('div', { class: 'note bad' }, `Needs another pass${a.reviewer ? ' (' + a.reviewer + ')' : ''}: ${a.review_note}`));
  if (a.status === 'approved' && a.review_note) root.append(h('div', { class: 'note ok' }, a.review_note));

  const done = () => a.items.filter((i) => i.done).length;
  const progress = h('div', { class: 'progress-label' });
  const bar = h('div', { class: 'bar' }, h('i'));
  const updateProgress = () => {
    progress.textContent = `${done()} of ${a.items.length} tasks done`;
    bar.firstChild.style.width = (a.items.length ? (done() / a.items.length) * 100 : 0) + '%';
  };

  const review = isMgr() && a.status === 'submitted';
  const missed = new Set();
  const listBox = h('div');
  let lastSection = null;
  for (const it of a.items) {
    if (it.section !== lastSection) { lastSection = it.section; listBox.append(h('h4', { class: 'sect' }, it.section || 'Tasks')); }
    const box = h('input', { type: 'checkbox', checked: !!it.done, disabled: !canEdit });
    box.addEventListener('change', async () => {
      const ok = await attempt(() => PUT(`/api/assignments/${a.id}/check`, { item_id: it.item_id, done: box.checked }));
      if (ok) { it.done = box.checked ? 1 : 0; updateProgress(); } else box.checked = !box.checked;
    });
    const miss = review && h('input', { type: 'checkbox', class: 'miss', 'aria-label': 'Mark as missed: ' + it.text, onchange: (e) => (e.target.checked ? missed.add(it.item_id) : missed.delete(it.item_id)) });
    listBox.append(h('div', { class: 'check-row' + (it.failed && a.status === 'rejected' ? ' failed' : '') },
      h('label', null, box, h('span', null, it.text, it.failed && a.status === 'rejected' ? h('em', null, ' (missed, redo)') : null)),
      review && h('label', { class: 'miss-label' }, miss, ' missed')));
  }
  updateProgress();
  root.append(h('section', { class: 'card' }, h('h3', null, 'Checklist'), progress, bar, listBox));

  // photos
  const photoBox = h('div', { class: 'photos' });
  const need = S.settings.min_photos;
  const drawPhotos = () => {
    photoBox.replaceChildren(...a.photos.map((p) => h('div', { class: 'ph' },
      h('img', { src: photoUrl(p.filename), alt: 'Room photo', loading: 'lazy', onclick: () => viewPhoto(p.filename) }),
      canEdit && h('button', { class: 'x', 'aria-label': 'Remove photo', onclick: async () => {
        if (!(await confirmBox('Remove this photo?', 'Remove'))) return;
        if (await attempt(() => DEL(`/api/assignments/${a.id}/photos/${p.id}`))) { a.photos = a.photos.filter((q) => q.id !== p.id); drawPhotos(); }
      } }, '✕'),
      h('div', { class: 'ts' }, fmtTime(p.created_at))
    )));
    if (!a.photos.length) photoBox.append(h('p', { class: 'muted' }, canEdit ? `Take a photo of the finished room (${need} required).` : 'No photos.'));
  };
  drawPhotos();
  const addBtn = canEdit && photoPicker('📷 Add photo', async (blob) => {
    const fd = new FormData();
    fd.append('photo', blob, 'room.jpg');
    toast('Uploading…');
    const r = await attempt(() => api('POST', `/api/assignments/${a.id}/photos`, fd));
    if (r) { a.photos.push({ id: r.id, filename: r.filename, created_at: new Date().toISOString() }); drawPhotos(); toast('Photo added'); }
  });
  root.append(h('section', { class: 'card' }, h('h3', null, 'Proof photos'), photoBox, addBtn));

  if (canEdit) {
    const notes = h('textarea', { rows: 2, placeholder: 'Anything the manager should know? (optional)', maxlength: 500 });
    root.append(h('section', { class: 'card' },
      notes,
      h('button', { class: 'btn big primary', onclick: async () => {
        if (await attempt(() => POST(`/api/assignments/${a.id}/submit`, { notes: notes.value }), 'Room submitted. Nice work!')) location.hash = '#/rooms';
      } }, 'Submit room for review'),
      h('a', { class: 'btn ghost block', href: `#/maint/new?room=${a.room_id}` }, '🔧 Something broken? Report it')));
  } else if (a.notes) {
    root.append(h('section', { class: 'card' }, h('h3', null, 'Housekeeper notes'), h('p', null, a.notes)));
  }

  if (review) {
    const note = h('textarea', { rows: 2, placeholder: 'Feedback (required if sending back). Tick any missed steps in the checklist above.', maxlength: 500 });
    root.append(h('section', { class: 'card review' }, h('h3', null, 'Inspection'), note,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary grow', onclick: async () => { if (await attempt(() => POST(`/api/assignments/${a.id}/review`, { approve: true, note: note.value }), 'Approved')) history.back(); } }, '✓ Approve'),
        h('button', { class: 'btn danger grow', onclick: async () => { if (await attempt(() => POST(`/api/assignments/${a.id}/review`, { approve: false, note: note.value, failed_items: [...missed] }), 'Sent back')) history.back(); } }, 'Send back for redo'))));
  }
  if (isMgr() && a.status !== 'approved') {
    root.append(h('button', { class: 'btn ghost block', onclick: async () => {
      if (await confirmBox(`Remove Room ${a.room_number} from ${a.user_name}'s list?`, 'Remove') && await attempt(() => DEL('/api/assignments/' + a.id), 'Removed')) history.back();
    } }, 'Unassign this room'));
  }
}

// ================= chat =================
export async function chatView(root, [channelArg]) {
  const chans = S.channels;
  const channel = chans.find((c) => c.id === channelArg) || chans.find((c) => c.id === 'general');
  root.append(h('h2', null, 'Team chat'));
  root.append(h('div', { class: 'tabs' }, chans.map((c) => {
    const n = S.badges.unread?.[c.id];
    return h('a', { class: 'tab' + (c.id === channel.id ? ' on' : ''), href: '#/chat/' + c.id }, c.label, n ? h('b', { class: 'dot' }, n) : null);
  })));
  const feed = h('div', { class: 'feed', 'aria-live': 'polite' });
  root.append(feed);
  let last = 0;
  let timer;
  const draw = (m) => {
    const mine = m.user_id === S.me.id;
    const bubble = h('div', { class: 'msg' + (mine ? ' mine' : '') },
      !mine && h('div', { class: 'who' }, m.name, m.role !== 'employee' && h('span', { class: 'role' }, m.role)),
      m.body && h('div', { class: 'body' }, m.body),
      m.photo && h('img', { src: photoUrl(m.photo), alt: 'Shared photo', loading: 'lazy', onclick: () => viewPhoto(m.photo) }),
      h('div', { class: 'when' }, fmtDateTime(m.created_at)));
    feed.append(bubble);
  };
  async function load() {
    const rows = await GET(`/api/chat/${channel.id}?after=${last}`);
    if (!rows.length) return;
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80 || last === 0;
    rows.forEach((m) => { draw(m); last = Math.max(last, m.id); });
    if (atBottom) feed.scrollTop = feed.scrollHeight;
    window.dispatchEvent(new Event('sf-badges'));
  }
  await load();
  if (!last) feed.append(h('p', { class: 'muted center' }, 'No messages yet.'));
  timer = setInterval(() => { if (!feed.isConnected) return clearInterval(timer); load().catch(() => {}); }, 5000);

  if (channel.canPost) {
    const input = h('input', { type: 'text', placeholder: 'Message ' + channel.label, maxlength: 2000, enterkeyhint: 'send' });
    let pending = null;
    const chip = h('span', { class: 'chip', hidden: true });
    const send = async () => {
      if (!input.value.trim() && !pending) return;
      const fd = new FormData();
      fd.append('body', input.value);
      if (pending) fd.append('photo', pending, 'chat.jpg');
      if (await attempt(() => api('POST', '/api/chat/' + channel.id, fd))) {
        input.value = ''; pending = null; chip.hidden = true;
        feed.querySelector('p.center')?.remove();
        await load(); feed.scrollTop = feed.scrollHeight;
      }
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && send());
    root.append(h('div', { class: 'composer' },
      photoPicker('📷', (b) => { pending = b; chip.hidden = false; chip.textContent = 'Photo attached ✕'; }),
      chip, input, h('button', { class: 'btn primary', onclick: send }, 'Send')));
    chip.addEventListener('click', () => { pending = null; chip.hidden = true; });
  } else {
    root.append(h('p', { class: 'muted center' }, 'Only managers can post in this channel.'));
  }
  return () => clearInterval(timer);
}

// ================= maintenance =================
const PRI = { urgent: 'bad', high: 'warn', normal: '', low: 'muted' };
const CAT = { repair: '🔧 Repair', supplies: '🧴 Supplies', safety: '⚠️ Safety', lost_found: '🔍 Lost & found', other: 'Other' };
const MSTATUS = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting on parts', done: 'Done' };

export async function maintListView(root) {
  const filter = (sessionStorage.getItem('maintFilter') || 'open');
  const rows = await GET('/api/maintenance?status=' + filter);
  root.append(
    h('div', { class: 'row between' }, h('h2', null, 'Maintenance'), h('a', { class: 'btn primary', href: '#/maint/new' }, '+ New request')),
    h('div', { class: 'tabs' }, ['open', 'done'].map((f) => h('a', { class: 'tab' + (f === filter ? ' on' : ''), href: '#/maint', onclick: () => sessionStorage.setItem('maintFilter', f) }, f === 'open' ? 'Open' : 'Completed'))),
    rows.length
      ? h('ul', { class: 'cards' }, rows.map((m) => h('li', null, h('a', { class: 'card link', href: '#/maint/' + m.id },
          h('div', { class: 'row between' }, h('b', null, m.title), h('span', null, m.reporting_gap ? pill('bad', 'reporting gap') : null, pill(PRI[m.priority], m.priority))),
          h('div', { class: 'muted small' }, [CAT[m.category], m.room_number ? 'Room ' + m.room_number : m.location, MSTATUS[m.status]].filter(Boolean).join(' · ')),
          h('div', { class: 'muted small' }, `${m.reporter} · ${ago(m.created_at)}${m.assignee ? ' · assigned to ' + m.assignee : ''}${m.comment_count ? ' · 💬' + m.comment_count : ''}`)))))
      : h('p', { class: 'muted center' }, filter === 'open' ? 'Nothing open. 🎉' : 'Nothing completed yet.')
  );
}

export async function maintNewView(root) {
  const rooms = await GET('/api/rooms');
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  let photo = null;
  const f = {
    room: h('select', null, h('option', { value: '' }, 'Not a specific room'), rooms.map((r) => h('option', { value: r.id, selected: q.get('room') == r.id }, 'Room ' + r.number))),
    location: h('input', { placeholder: 'Or where? (lobby, laundry, parking lot…)', maxlength: 80 }),
    category: h('select', null, Object.entries(CAT).map(([k, v]) => h('option', { value: k }, v))),
    priority: h('select', null, ['low', 'normal', 'high', 'urgent'].map((p) => h('option', { value: p, selected: p === 'normal' }, p[0].toUpperCase() + p.slice(1)))),
    title: h('input', { placeholder: 'What is the problem? (short)', maxlength: 120, required: true }),
    desc: h('textarea', { rows: 3, placeholder: 'Details (optional). For lost & found: what it is, room number, date.', maxlength: 1500 }),
    gap: h('input', { type: 'checkbox' }),
  };
  const chip = h('span', { class: 'muted' });
  root.append(h('a', { class: 'back', href: '#/maint' }, '‹ Back'), h('h2', null, 'New request'),
    h('form', { class: 'card form', onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData();
      fd.append('room_id', f.room.value); fd.append('location', f.location.value); fd.append('category', f.category.value);
      fd.append('priority', f.priority.value); fd.append('title', f.title.value); fd.append('description', f.desc.value); fd.append('reporting_gap', f.gap.checked ? '1' : '0');
      if (photo) fd.append('photo', photo, 'issue.jpg');
      if (await attempt(() => api('POST', '/api/maintenance', fd), 'Request sent')) location.hash = '#/maint';
    } },
      h('label', null, 'Title', f.title), h('label', null, 'Room', f.room), h('label', null, 'Other location', f.location),
      h('div', { class: 'grid2' }, h('label', null, 'Type', f.category), h('label', null, 'How urgent?', f.priority)),
      h('label', null, 'Details', f.desc),
      isMgr() && h('label', { class: 'inline' }, f.gap, ' A guest reported this and staff never logged it (Reporting Gap)'),
      h('div', { class: 'row' }, photoPicker('📷 Add photo', (b) => { photo = b; chip.textContent = '✓ Photo attached'; }), chip),
      h('button', { class: 'btn primary big' }, 'Send request')));
}

export async function maintDetailView(root, [id]) {
  const m = await GET('/api/maintenance/' + id);
  const staff = isMgr() ? await GET('/api/staff') : [];
  root.append(h('a', { class: 'back', href: '#/maint' }, '‹ Back'),
    h('div', { class: 'row between' }, h('h2', null, m.title), pill(PRI[m.priority], m.priority)),
    m.reporting_gap ? h('div', { class: 'note bad' }, 'Reporting Gap: a guest found this before staff logged it. Per the playbook this is a reporting failure, not just a maintenance failure.') : null,
    h('p', { class: 'muted' }, [CAT[m.category], m.room_number ? 'Room ' + m.room_number : m.location, `by ${m.reporter}`, fmtDateTime(m.created_at)].filter(Boolean).join(' · ')));
  if (m.description) root.append(h('p', { class: 'card' }, m.description));
  if (m.photo) root.append(h('img', { class: 'issue-photo', src: photoUrl(m.photo), alt: 'Issue photo', onclick: () => viewPhoto(m.photo) }));

  if (isMgr()) {
    const status = h('select', null, Object.entries(MSTATUS).map(([k, v]) => h('option', { value: k, selected: k === m.status }, v)));
    const pri = h('select', null, ['low', 'normal', 'high', 'urgent'].map((p) => h('option', { value: p, selected: p === m.priority }, p)));
    const gapBox = h('input', { type: 'checkbox', checked: !!m.reporting_gap });
    const who = h('select', null, h('option', { value: '' }, 'Unassigned'), staff.map((s) => h('option', { value: s.id, selected: s.id === m.assigned_to }, s.name)));
    root.append(h('section', { class: 'card form' },
      h('div', { class: 'grid2' }, h('label', null, 'Status', status), h('label', null, 'Priority', pri)),
      h('label', null, 'Assigned to', who),
      h('label', { class: 'inline' }, gapBox, ' Reporting Gap: a guest found this, staff had not logged it'),
      h('button', { class: 'btn primary', onclick: async () => {
        if (await attempt(() => PATCH('/api/maintenance/' + m.id, { status: status.value, priority: pri.value, assigned_to: who.value || null, reporting_gap: gapBox.checked }), 'Saved')) location.reload();
      } }, 'Save changes')));
  } else {
    root.append(h('p', null, 'Status: ', pill(m.status === 'done' ? 'ok' : '', MSTATUS[m.status]), m.assignee ? ` · ${m.assignee} is on it` : ''));
  }

  const thread = h('ul', { class: 'list' }, m.comments.map((c) => h('li', null, h('div', null, h('b', null, c.name), ' ', h('span', { class: 'muted small' }, ago(c.created_at))), h('div', null, c.body))));
  const box = h('input', { placeholder: 'Add an update…', maxlength: 1000 });
  root.append(h('section', { class: 'card' }, h('h3', null, 'Updates'), m.comments.length ? thread : h('p', { class: 'muted' }, 'No updates yet.'),
    h('div', { class: 'composer' }, box, h('button', { class: 'btn', onclick: async () => {
      if (box.value.trim() && await attempt(() => POST(`/api/maintenance/${m.id}/comments`, { body: box.value }))) location.reload();
    } }, 'Post'))));
}
