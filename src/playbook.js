// Text of the Heidi's Inn SOP Playbook and Employee Acknowledgment, as supplied by the owner.
// Bump VERSION whenever the wording changes: everyone is then asked to sign again.
const VERSION = 'playbook-2026-08';

const INTRO =
  "Heidi's Inn is under new ownership and management. Our target is a consistent 4+ star guest experience: the kind of property where an occasional off day gets a quick, professional fix, not a property carrying the same complaint for years. This playbook sets the daily standard for every shift going forward. It replaces any prior informal practice, effective immediately, and it is enforced consistently: every shift, every guest, no exceptions.";

const SECTIONS = [
  { title: '1. Our Standard', items: [
    'We operate to the standard of a 4+ star property: clean, safe, welcoming, and consistent, every single day.',
    'An occasional guest concern is normal and gets fixed fast. A pattern of the same complaint is not acceptable and will be treated as a standards failure, not bad luck.',
    'Consistency matters more than any single great day. Guests remember the one bad interaction more than ten good ones; every shift is held to the same bar.',
  ] },
  { title: '2. Cleanliness Standards', items: [
    'Every guest room is fully inspected against the room checklist before being marked ready. No room is released as "clean" from a quick visual pass alone.',
    'Bathrooms (tub/shower, toilet, sink, floor, under-sink area) are cleaned and disinfected top to bottom on every turnover. Extra attention: under beds, behind headboards, and soap/shampoo dispensers (guest-flagged trouble spots).',
    'All linens, towels, and bedding are changed on every checkout and inspected for stains or wear before returning to a room. Damaged linens are pulled from rotation, never reused.',
    'Trash emptied, surfaces wiped, floors vacuumed or mopped in every room and common area daily, not only at checkout.',
    'Any maintenance issue found while cleaning (heater, plumbing, lock, lighting) is logged the same day in the maintenance log. Not left for the next person to notice.',
  ] },
  { title: '3. Guest Experience & Attitude Standards', items: [
    'Guests are greeted promptly and treated courteously. No closed office or "be back" sign during posted hours without prior arrangement.',
    'A positive, welcoming attitude is required on every shift, with guests and with each other. This is a job expectation, not a personality bonus. A bad mood is normal off the clock. It does not show up in front of guests.',
    'Any guest complaint, big or small, goes to a manager the same day. Better to fix it on property than read about it in a review afterward.',
    'Staff do not discuss the property\'s past reviews, ownership history, or internal issues with guests. Questions about "new ownership" are answered positively and redirected to a manager if detailed.',
  ] },
  { title: '4. Maintenance Reporting', items: [
    'Any maintenance issue (heater, plumbing, lock, lighting, damage of any kind) is reported to management immediately, the moment it\'s found. Not at the end of shift. Not "when things slow down." Immediately.',
    'The maintenance log is used every time, with room number, issue, and time found.',
    'A room with an unreported known issue that reaches a guest is treated as a reporting failure, not just a maintenance failure.',
  ] },
  { title: '5. Zero-Tolerance Safety & Violence Policy', items: [
    'Violence, threats of violence, intimidation, or harassment by a guest, toward staff or other guests, results in immediate removal from the property. Police are contacted where warranted. There is no warning step.',
    'Violence, threats of violence, intimidation, harassment, or fighting by a staff member, toward a guest or a coworker, results in immediate termination on the first incident. There is no warning step, regardless of tenure or performance history.',
    'Intoxication or being under the influence while on shift is treated as a zero-tolerance safety issue and results in immediate removal from shift and, on confirmation, termination.',
    'Guest safety and staff safety are non-negotiable. When in doubt, involve a manager immediately. Never wait to see if a situation resolves on its own.',
  ] },
  { title: '6. Team Expectations', items: [
    'Shifts, rooms, and tasks assigned for the day are completed before shift end, or handed off clearly and in writing to the next shift.',
    'Staff are respectful and professional with one another. The same courtesy given to guests is expected internally.',
    'New procedures, checklists, or standards issued by management replace prior informal practices, effective immediately upon rollout.',
  ] },
  { title: '7. Accountability Standard', items: [
    'Zero-tolerance violations (violence, threats, theft, harassment, intoxication on shift) result in immediate termination on the first occurrence. There is no second chance for these.',
    'Standards issues (a missed cleaning step, an unreported maintenance item, a negative attitude with a guest, a shift left without proper handoff) follow a two-step standard: the first occurrence is a documented written warning discussed with a manager; a second occurrence of the same or a similar issue results in termination. This is not about punishing a bad day. It\'s about making sure a pattern never gets the chance to become a review.',
    'Standards are applied the same way to every person on every shift. Consistency is the point. Favoritism or repeated unofficial passes undermine the whole standard.',
  ] },
];

const ACK_TEXT = [
  'I have received and read the Housekeeping & Front-of-House SOP Playbook in full, including the Zero-Tolerance Safety & Violence Policy and the Accountability Standard.',
  'I understand the cleanliness, guest experience, attitude, maintenance-reporting, and team expectations described in it.',
  'I understand these standards replace any prior informal practices, effective immediately, and are applied the same way to everyone on every shift.',
  'I understand that violence, threats, harassment, intimidation, or intoxication on shift, by a guest or a staff member, result in immediate removal or termination, with no warning step.',
  'I understand that standards issues (missed steps, unreported maintenance, negative attitude, poor handoff) follow a documented warning on the first occurrence and termination on a second.',
  'I agree to follow these standards as a condition of my continued employment at Heidi\'s Inn.',
  'I understand that questions about any of these expectations should be raised directly with management.',
];

const ACK_CLOSING =
  'I am signing this acknowledgment of my own free will, confirming I am 100% aware of what is expected of me moving forward.';

// Housekeeping SOP (pamphlet): shown alongside the playbook.
const SOP = {
  mission: "Provide every guest with a clean, safe, comfortable room that is inspection-ready every time.",
  attendance: [
    'Arrive 10 minutes early, dressed appropriately and ready to work.',
    'Notify management immediately if an emergency affects attendance. 24 hours notice is required if you will not make a shift.',
    'Maintain a positive, respectful attitude, especially in front of our guests.',
    'Respect guest privacy and confidentiality. We have a zero tolerance theft policy.',
  ],
  targets: ['Standard checkout: 30–35 minutes', 'Stayover: 15–20 minutes', 'Kitchen/suite: 40–45 minutes', 'Quality always comes before speed.'],
  safety: 'Report maintenance issues immediately. Never use damaged equipment. Follow chemical labeling and PPE requirements. Secure master keys at all times. Knock three times before entering occupied rooms.',
  lostFound: 'Immediately turn in all found items with room number, date, and description. Never keep guest property.',
  inspection: 'Rooms must pass inspection before being released. Repeated deficiencies require coaching and retraining.',
  goals: ['95%+ inspection pass rate', 'Less than 2% cleanliness complaints', 'Zero missed departures', 'Professional guest interactions every shift'],
};

module.exports = { VERSION, INTRO, SECTIONS, ACK_TEXT, ACK_CLOSING, SOP };
