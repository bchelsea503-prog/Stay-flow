const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-'));
process.env.OWNER_PASSWORD = 'ownerpass1';
const { app, bootstrapOwner } = require('../src/server');
bootstrapOwner();

let base, server;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());

function client() {
  let cookie = '';
  const call = async (method, url, body, isForm) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body && !isForm ? { 'content-type': 'application/json' } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data };
  };
  return {
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}), patch: (u, b) => call('PATCH', u, b),
    put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u), form: (u, f) => call('POST', u, f, true),
  };
}

// 1x1 jpeg
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const photoForm = (extra = {}) => {
  const f = new FormData();
  f.append('photo', new Blob([JPG], { type: 'image/jpeg' }), 'x.jpg');
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
};

test('full workflow with role enforcement', async () => {
  const o = client();
  assert.equal((await o.get('/api/me')).status, 401);
  assert.equal((await o.post('/api/login', { username: 'owner', password: 'bad' })).status, 401);
  assert.equal((await o.post('/api/login', { username: 'owner', password: 'ownerpass1' })).status, 200);

  // staff
  const mk = await o.post('/api/users', { name: 'Mia', username: 'mia', password: 'secret1', role: 'employee', hourly_rate: 20 });
  assert.equal(mk.status, 200);
  const mgrRes = await o.post('/api/users', { name: 'Gus', username: 'gus', password: 'secret1', role: 'manager', hourly_rate: 25 });
  assert.equal(mgrRes.status, 200);
  assert.equal((await o.post('/api/users', { name: 'X', username: 'mia', password: 'secret1' })).status, 409);

  // rooms
  assert.equal((await o.post('/api/rooms', { numbers: '101, 102, 103', type: 'standard' })).data.added, 3);
  const rooms = (await o.get('/api/rooms')).data;
  assert.equal(rooms.length, 3);

  const e = client();
  await e.post('/api/login', { username: 'mia', password: 'secret1' });
  // employee boundaries
  for (const u of ['/api/users', '/api/dashboard', '/api/inventory', '/api/reports/hours', '/api/settings', '/api/clock/entries', '/api/checklist'])
    assert.equal((await e.get(u)).status, 403, u);
  assert.equal((await e.post('/api/rooms', { numbers: '999' })).status, 403);

  // manager assigns
  const m = client();
  await m.post('/api/login', { username: 'gus', password: 'secret1' });
  const miaId = (await o.get('/api/users')).data.find((u) => u.username === 'mia').id;
  assert.equal((await m.get('/api/users')).data[0].hourly_rate, undefined, 'manager must not see wages');
  assert.equal((await m.post('/api/assignments', { user_id: miaId, room_ids: [rooms[0].id, rooms[1].id], clean_type: 'checkout' })).data.created, 2);

  const mine = (await e.get('/api/assignments')).data;
  assert.equal(mine.length, 2);
  const a = mine[0];

  // must sign the acknowledgment, then clock in, before working rooms
  assert.equal((await e.post(`/api/assignments/${a.id}/start`)).status, 409);
  assert.equal((await e.post('/api/clock/in')).status, 409, 'acknowledgment required');
  assert.equal((await e.post('/api/ack', { name: 'Someone Else', agree: true })).status, 400);
  assert.equal((await e.post('/api/ack', { name: 'mia', agree: false })).status, 400);
  assert.equal((await e.post('/api/ack', { name: ' MIA ', agree: true })).status, 200);
  assert.equal((await e.post('/api/clock/in')).status, 200);
  // breaks
  assert.equal((await e.post('/api/clock/break/end')).status, 409);
  assert.equal((await e.post('/api/clock/break/start')).status, 200);
  assert.equal((await e.post('/api/clock/break/start')).status, 409);
  assert.equal((await e.get('/api/clock/status')).data.break.on_break, true);
  assert.equal((await e.post('/api/clock/break/end')).status, 200);
  assert.equal((await e.post('/api/clock/in')).status, 409);
  assert.equal((await e.post(`/api/assignments/${a.id}/start`)).status, 200);

  // cannot submit incomplete / without photo
  assert.equal((await e.post(`/api/assignments/${a.id}/submit`, {})).status, 400);
  const detail = (await e.get(`/api/assignments/${a.id}`)).data;
  for (const it of detail.items) assert.equal((await e.put(`/api/assignments/${a.id}/check`, { item_id: it.item_id, done: true })).status, 200);
  const noPhoto = await e.post(`/api/assignments/${a.id}/submit`, {});
  assert.equal(noPhoto.status, 400);
  assert.match(noPhoto.data.error, /photo/i);

  // fake image rejected, real one accepted
  const bad = new FormData();
  bad.append('photo', new Blob(['<html>not an image</html>'], { type: 'image/jpeg' }), 'x.jpg');
  assert.equal((await e.form(`/api/assignments/${a.id}/photos`, bad)).status, 400);
  const up = await e.form(`/api/assignments/${a.id}/photos`, photoForm());
  assert.equal(up.status, 200);
  assert.equal((await e.get('/uploads/' + up.data.filename)).status, 200);
  assert.equal((await client().get('/uploads/' + up.data.filename)).status, 401, 'photos need login');

  assert.equal((await e.post(`/api/assignments/${a.id}/submit`, { notes: 'done' })).status, 200);
  assert.equal((await e.put(`/api/assignments/${a.id}/check`, { item_id: detail.items[0].item_id, done: false })).status, 409, 'locked after submit');

  // other employee can't touch it
  await o.post('/api/users', { name: 'Zed', username: 'zed', password: 'secret1' });
  const z = client();
  await z.post('/api/login', { username: 'zed', password: 'secret1' });
  assert.equal((await z.get(`/api/assignments/${a.id}`)).status, 403);

  // reject then approve
  assert.equal((await m.post(`/api/assignments/${a.id}/review`, { approve: false })).status, 400);
  assert.equal((await m.post(`/api/assignments/${a.id}/review`, { approve: false, note: 'Mirror streaky', failed_items: [detail.items[0].item_id] })).status, 200);
  const redo = (await e.get(`/api/assignments/${a.id}`)).data;
  assert.equal(redo.status, 'rejected');
  assert.equal(redo.items.filter((i) => !i.done).length, 1, 'missed step must be redone');
  assert.equal((await e.post(`/api/assignments/${a.id}/submit`, {})).status, 400, 'cannot resubmit until redone');
  await e.put(`/api/assignments/${a.id}/check`, { item_id: detail.items[0].item_id, done: true });
  assert.equal((await e.post(`/api/assignments/${a.id}/submit`, {})).status, 200);
  assert.equal((await m.post(`/api/assignments/${a.id}/review`, { approve: true })).status, 200);
  assert.equal((await o.get('/api/rooms')).data.find((r) => r.id === a.room_id).status, 'clean');

  // clock out + reports
  assert.equal((await e.post('/api/clock/out', {})).status, 200);
  const rep = (await o.get('/api/reports/hours')).data;
  assert.equal(rep.users.length, 1);
  assert.ok(rep.users[0].pay !== undefined, 'owner sees pay');
  assert.equal((await m.get('/api/reports/hours')).data.users[0].pay, undefined, 'manager does not see pay');
  const csv = await o.get('/api/reports/hours?format=csv');
  assert.match(csv.data.toString(), /Employee,Regular hrs/);

  // maintenance + chat + inventory
  const mr = await e.form('/api/maintenance', photoForm({ title: 'Heater broken', room_id: rooms[0].id, priority: 'high' }));
  assert.equal(mr.status, 200);
  assert.equal((await e.patch(`/api/maintenance/${mr.data.id}`, { status: 'done' })).status, 403);
  assert.equal((await m.patch(`/api/maintenance/${mr.data.id}`, { status: 'in_progress', assigned_to: miaId })).status, 200);
  assert.equal((await e.post(`/api/maintenance/${mr.data.id}/comments`, { body: 'Tried resetting it' })).status, 200);
  assert.equal((await z.get('/api/badges')).data.unread.maintenance, 1);
  const msgs = (await z.get('/api/chat/maintenance')).data;
  assert.equal(msgs.length, 1);
  assert.equal((await z.get('/api/badges')).data.unread.maintenance, 0);
  assert.equal((await z.post('/api/chat/announcements', { body: 'hi' })).status, 403);
  assert.equal((await z.post('/api/chat/general', { body: 'hi all' })).status, 200);

  const inv = await m.post('/api/inventory', { name: 'Towels', qty: 10, par: 20 });
  assert.equal((await m.post(`/api/inventory/${inv.data.id}/adjust`, { delta: -3, note: 'laundry loss' })).status, 200);
  assert.equal((await m.post(`/api/inventory/${inv.data.id}/adjust`, { delta: -30 })).status, 400);
  assert.equal((await o.patch(`/api/inventory/${inv.data.id}`, { par: 20 })).status, 200, 'owner sets par');
  const dash = (await o.get('/api/dashboard')).data;
  assert.equal(dash.lowStock.length, 1);
  assert.equal(dash.lowStock[0].qty, 7);
  assert.ok(dash.activity.length > 5);
  assert.equal((await m.get('/api/dashboard')).data.activity, undefined);

  // owner-only standards
  assert.equal((await m.post('/api/checklist', { text: 'x' })).status, 403);
  assert.equal((await o.post('/api/checklist', { text: 'Wipe baseboards', section: 'Bedroom' })).status, 200);
  assert.equal((await m.patch(`/api/inventory/${inv.data.id}`, { par: 99 })).status, 200);
  assert.equal((await o.get('/api/inventory')).data[0].par, 20, 'manager cannot change par');

  // timecard corrections need a reason, keep the original, and are never hard-deleted
  const ents = (await m.get('/api/clock/entries')).data;
  assert.equal(ents.length, 1);
  assert.equal((await m.patch(`/api/clock/entries/${ents[0].id}`, { clock_in: ents[0].clock_in })).status, 400);
  const newIn = new Date(Date.parse(ents[0].clock_in) - 3600000).toISOString();
  assert.equal((await m.patch(`/api/clock/entries/${ents[0].id}`, { clock_in: newIn, reason: 'Forgot to clock in' })).status, 200);
  const hist = (await m.get(`/api/clock/entries/${ents[0].id}/history`)).data;
  assert.equal(hist[0].old_in, ents[0].clock_in);
  assert.equal(hist[0].new_in, newIn);
  assert.equal((await m.del(`/api/clock/entries/${ents[0].id}`)).status, 404, 'no delete endpoint');
  assert.equal((await m.post(`/api/clock/entries/${ents[0].id}/void`, {})).status, 400);

  // accountability: one warning, then the repeat is flagged; record is permanent
  const w1 = await m.post('/api/accountability', { user_id: miaId, kind: 'warning', category: 'missed cleaning step', description: 'Skipped under-bed check in 102' });
  assert.equal(w1.status, 200);
  assert.equal(w1.data.repeat, false);
  const w2 = await m.post('/api/accountability', { user_id: miaId, kind: 'warning', category: 'missed cleaning step', description: 'Skipped under-bed check again' });
  assert.equal(w2.data.repeat, true);
  assert.equal((await m.post('/api/accountability', { user_id: miaId, kind: 'warning', description: 'x' })).status, 400, 'needs description');
  assert.equal((await m.post(`/api/accountability/${w1.data.id}/retract`, { reason: 'oops' })).status, 403, 'only owner retracts');
  assert.equal((await e.get('/api/accountability?user_id=' + miaId)).status, 403);
  assert.equal((await e.get('/api/me/accountability')).data.events.length, 2, 'employee sees own record');
  assert.equal((await z.get('/api/me/accountability')).data.events.length, 0);

  // incidents: any staff can file; urgent ones raise an alert for managers
  assert.equal((await z.post('/api/incidents', { category: 'bogus', description: 'x' })).status, 400);
  const inc = await z.post('/api/incidents', { category: 'harassment', description: 'Guest in 104 shouting at me' });
  assert.equal(inc.data.urgent, 1);
  const badges = (await m.get("/api/badges")).data;
  assert.equal(badges.alerts.length, 1);
  assert.equal((await z.get('/api/badges')).data.alerts, undefined);
  assert.equal((await m.post(`/api/incidents/${inc.data.id}/review`, { note: 'Spoke with guest' })).status, 200);
  assert.equal((await m.get('/api/badges')).data.alerts.length, 0);

  // reporting gap flag is manager-only
  const gapReq = await e.form('/api/maintenance', photoForm({ title: 'Dripping tap', reporting_gap: '1' }));
  assert.equal((await o.get('/api/maintenance/' + gapReq.data.id)).data.reporting_gap, 0);
  const mgrReq = await m.form('/api/maintenance', photoForm({ title: 'Guest found broken lock', reporting_gap: '1' }));
  assert.equal((await o.get('/api/maintenance/' + mgrReq.data.id)).data.reporting_gap, 1);

  const dash2 = (await o.get('/api/dashboard')).data;
  assert.ok(dash2.attention.some((x) => x.type === 'gap'));
  assert.ok(dash2.deepDue.length > 0);
  assert.ok((await o.get('/api/employees/' + miaId + '/timeline')).data.events.length === 2);

  // deactivated users lose access immediately
  assert.equal((await o.patch(`/api/users/${miaId}`, { active: false })).status, 200);
  assert.equal((await e.get('/api/me')).status, 401);
  assert.equal((await client().post('/api/login', { username: 'mia', password: 'secret1' })).status, 401);
});
