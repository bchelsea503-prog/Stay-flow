import { S, h, GET, pill, ASSIGN_LABEL, fmtDay } from './util.js';
import { clockCard } from './views-common.js';

// Employee home: clock card + today's rooms. Employees see nothing beyond this, chat and maintenance.
export async function myRoomsView(root) {
  const [card, rows] = await Promise.all([clockCard(), GET('/api/assignments')]);
  const open = rows.filter((a) => !['submitted', 'approved'].includes(a.status));
  const finished = rows.filter((a) => ['submitted', 'approved'].includes(a.status));
  root.append(h('h2', null, `Hi, ${S.me.name.split(' ')[0]} 👋`), card);
  const item = (a) => h('li', null, h('a', { class: 'card link room-card ' + a.status, href: '#/room/' + a.id },
    h('div', { class: 'room-num' }, a.room_number),
    h('div', { class: 'grow' },
      h('b', null, a.clean_type === 'stayover' ? 'Stayover' : a.clean_type === 'deep' ? 'Deep clean' : 'Checkout clean'),
      h('div', { class: 'muted small' }, `${a.checks_done}/${a.checks_total} tasks · ${a.photo_count} photo${a.photo_count === 1 ? '' : 's'}${a.date < S.today ? ' · from ' + fmtDay(a.date) : ''}`),
      a.status === 'rejected' && h('div', { class: 'bad-text small' }, '↩ ' + a.review_note)),
    pill(a.status, ASSIGN_LABEL[a.status])));
  root.append(h('h3', null, `My rooms (${open.length} left)`),
    open.length ? h('ul', { class: 'cards' }, open.map(item)) : h('p', { class: 'muted center' }, rows.length ? 'All done for today! 🎉' : 'No rooms assigned yet. Check with your manager.'));
  if (finished.length) root.append(h('h3', null, 'Finished'), h('ul', { class: 'cards' }, finished.map(item)));
}
