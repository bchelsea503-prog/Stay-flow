// Optional sample data for trying the app out (SEED_DEMO=1). Never runs by default.
const bcrypt = require('bcryptjs');
const { db } = require('./db');

module.exports = function seedDemo() {
  if (db.prepare('SELECT COUNT(*) c FROM rooms').get().c) return;
  const hash = bcrypt.hashSync('demo1234', 10);
  const addUser = db.prepare('INSERT OR IGNORE INTO users (name,username,pass_hash,role,hourly_rate) VALUES (?,?,?,?,?)');
  addUser.run('Demo Manager', 'manager', hash, 'manager', 22);
  addUser.run('Maria Lopez', 'maria', hash, 'employee', 18);
  addUser.run('Sam Carter', 'sam', hash, 'employee', 18);
  const addRoom = db.prepare('INSERT INTO rooms (number,type,status) VALUES (?,?,?)');
  for (let i = 1; i <= 10; i++) addRoom.run(String(100 + i), i % 4 === 0 ? 'suite' : 'standard', i <= 6 ? 'dirty' : 'clean');
  const addInv = db.prepare('INSERT INTO inventory_items (name,category,unit,qty,par,unit_cost,location) VALUES (?,?,?,?,?,?,?)');
  addInv.run('Bath towels', 'Linens', 'each', 60, 50, 6.5, 'Linen closet');
  addInv.run('Hand towels', 'Linens', 'each', 18, 30, 3, 'Linen closet');
  addInv.run('Toilet paper', 'Supplies', 'roll', 24, 40, 0.6, 'Storage');
  addInv.run('Shampoo (1oz)', 'Amenities', 'each', 120, 100, 0.25, 'Storage');
  addInv.run('All-purpose cleaner', 'Chemicals', 'bottle', 4, 3, 4.2, 'Janitor closet');
  const admin = db.prepare("SELECT id FROM users WHERE role='manager' LIMIT 1").get();
  const room = db.prepare("SELECT id FROM rooms WHERE number='103'").get();
  db.prepare('INSERT INTO maintenance (room_id,title,description,priority,reported_by) VALUES (?,?,?,?,?)').run(
    room.id, 'Bathroom faucet drips', 'Constant drip from the sink faucet.', 'normal', admin.id
  );
  db.prepare('INSERT INTO messages (channel,user_id,body) VALUES (?,?,?)').run('announcements', admin.id, 'Welcome to the new Stay Flow app. Clock in, do your rooms, add photos, done.');
  console.log('Demo data loaded (staff password: demo1234)');
};
