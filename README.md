# Stay Flow – Heidi's Inn (Ilwaco, WA)

Remote-manageable housekeeping, time clock, inventory, maintenance and staff chat. It's a web app (installable on phones as a PWA), so the owner can run the inn from anywhere with a browser.

## Built from your documents

This implements the StayFlow PRD v2, the SOP Playbook, the Housekeeping SOP and the Employee Acknowledgment. The standards are enforced by the server, not just shown on screen:

| Standard | How the app enforces it |
|---|---|
| Full room checklist, no visual-pass releases | A room can't be submitted until every task is ticked **and** the proof photo(s) are attached. Then a manager inspects it; only "Approve" marks the room Ready. |
| Pattern, not a bad day | When a manager sends a room back they tick the missed steps; those steps are un-ticked for redo, and any step missed 3+ times in 30 days is flagged on the employee's profile. |
| Maintenance reported immediately | Requests are timestamped on creation (room, issue, urgency, photo) and announced in the Maintenance channel. Managers can flag a **Reporting Gap** (guest found it before staff logged it). |
| Zero-tolerance policy | Any staff member can file a one-tap incident report. Violence, threat, harassment, intoxication, theft and safety reports raise a red banner on every manager/owner screen until reviewed. |
| Accountability Standard | Per-employee log: "warnings 0 of 1 used", plus a separate zero-tolerance category. Each entry needs a manager, date and description; entries are permanent (only the owner can retract one, with a reason, and it stays visible). Logging a second warning shows the repeat notice; the decision stays human. |
| Consistency | Same checklist, same clock rules for everyone; every timestamp is server-side. |
| Employee Acknowledgment | Employees read the playbook in-app and sign by typing their full name before they can clock in. Managers see who has/hasn't signed. Bumping the version in `src/playbook.js` re-requests signatures. |
| Time clock | Clock in/out and start/end break. Flags: missed clock-out, break over policy. Corrections need a reason and keep the original (who/when/why); entries are voided, never deleted. |
| SOP targets | 30–35 min checkout, 15–20 stayover, 40–45 kitchen/suite (room type containing "suite" or "kitchen"). Housekeepers show **Behind Schedule** on the live view at 1.25× target. Inspection first-pass rate is reported against the 95% goal. |
| Deep cleans | Separate deep-clean checklist (window tracks, vent covers, shower heads/grout, filters) on a rotating schedule (default every 90 days) with a "due" list on the dashboard. |
| Inventory | Par levels (owner-only), low-stock list, supply pulls loggable against a room. |

## Roles

| | Owner | Manager | Employee |
|---|---|---|---|
| Dashboard: live shift, needs-attention, rooms, labor cost, activity log | ✅ full | ✅ (no wages) | – |
| Assign rooms, inspect/approve/send back | ✅ | ✅ | – |
| Hours, timecard corrections, CSV + print for payroll | ✅ + pay | ✅ hours only | – |
| Log warnings / zero-tolerance events | ✅ (incl. managers) | ✅ (employees) | – |
| Incident reports: review | ✅ | ✅ | – |
| Inventory (stock counts) | ✅ | ✅ | – |
| Par levels, room checklist/standard, settings, wages, backup, add managers | ✅ | – | – |
| Clock in/out, breaks | ✅ | ✅ | ✅ |
| Own rooms: checklist + proof photo + submit | ✅ | ✅ | ✅ |
| File an incident, read/sign playbook, see own record | ✅ | ✅ | ✅ |
| Team chat (Announcements is manager-post-only) | ✅ | ✅ | ✅ |
| Maintenance / supply / lost-and-found requests with photo | ✅ | ✅ (and triage) | ✅ (create, comment) |

All dates/hours use the **property timezone** (default `America/Los_Angeles`), so an owner in Russia sees the inn's real "today". Overtime is weekly (Mon–Sun, over 40 h at 1.5×).

## Decisions I made where the PRD's open questions were unanswered

Change any of these in **Settings** (or tell me and I'll change the code):

- **Time clock method:** per-employee login on their own phone (not a shared PIN or geofence).
- **Breaks:** unpaid and deducted from hours; a single break over 30 minutes is flagged. Please confirm against Washington meal/rest-break rules and your own policy.
- **Payroll export:** CSV (regular, overtime, total, break hours, plus rate and pay for the owner).
- **Manager access:** managers see timecards and accountability for employees, but not wages.

## Run it

Requires Node 22.13+.

```bash
npm install
npm run demo        # sample rooms/staff; owner password printed or set OWNER_PASSWORD
npm start           # real use, no sample data
npm test
```

First start creates the owner account: `OWNER_USERNAME` (default `owner`) and `OWNER_PASSWORD` (random one is printed to the log if unset). Change it in *My account*.

Config (env): `PORT`, `DATA_DIR` (SQLite DB + photos, default `./data`), `OWNER_USERNAME`, `OWNER_PASSWORD`, `OWNER_NAME`, `TRUST_PROXY=0` to disable proxy trust.

## Deploying so the owner can use it from abroad

The app must live on a public HTTPS server (a laptop at the inn won't work). Any host that runs a Docker container or Node 22 with a **persistent disk** works (Fly.io, Railway, Render, a small VPS…). Mount the disk at `/data`.

```bash
docker build -t stayflow .
docker run -d -p 8080:8080 -v stayflow-data:/data -e OWNER_PASSWORD='choose-a-long-one' stayflow
```

Put HTTPS in front (the hosts above do this for you; or Caddy/nginx on a VPS). Session cookies are `Secure` automatically when served over HTTPS.

**Please test access from Russia before relying on it.** Some foreign hosting domains are blocked or throttled there. A custom domain pointing at a host/VPS in a neutral region (e.g. Europe) is usually the safest choice. The owner should also download a backup regularly (*Settings → Download backup*; photos live in `DATA_DIR/uploads`, so snapshot that disk too).

## Urgent alerts by text and email

When any staff member files an **urgent** incident (violence, threat, harassment, intoxication, theft, safety), the owner and every manager (the GM) get an **email and a text**, and **one reminder** if nobody has reviewed it after 15 minutes (changeable in Settings; 0 turns it off). The red in-app banner still shows too. Non-urgent reports don't send anything.

- Each person sets their own email and mobile number under **Me → Urgent alerts**, then taps **Send test alert**. The owner can also set a manager's email under Team.
- Mobile numbers need a country code (`+7 912 345 67 89`, `+1 360 555 0123`).
- Texts are deliberately short and leave out what happened (names, details); the email and the app have the full report.
- Reporting an incident never waits on, or fails because of, a text/email problem. Every attempt (sent, failed, skipped and why) is listed in **Settings → Urgent alerts**, and a failure in the last 24 hours shows up under "Needs attention" on the dashboard. The owner's dashboard also warns if nobody can currently be reached.

**Server setup** (secrets go in environment variables, never in the app):

```bash
# Email: any SMTP service (Gmail with an app password, Postmark, Mailgun, SendGrid, ...)
SMTP_HOST=smtp.example.com  SMTP_PORT=587  SMTP_USER=...  SMTP_PASS=...  SMTP_FROM="Heidi's Inn <alerts@yourdomain.com>"
# Texts: Twilio
TWILIO_ACCOUNT_SID=AC...  TWILIO_AUTH_TOKEN=...  TWILIO_FROM=+13605550100   # or TWILIO_MESSAGING_SERVICE_SID=MG...
# Used for the link inside alerts
APP_URL=https://heidisinn-ops.com
```

Add them to `docker run` with `-e` (or an env file), e.g. `docker run ... --env-file stayflow.env stayflow`.

**Be realistic about texts to Russia.** Email is the dependable channel. Text messages from US numbers to Russian mobiles are often filtered or blocked by carriers and Twilio's Russia rules (sender registration) change, so send a test to the owner's real number *before* relying on it, and keep email on. For US recipients, Twilio requires registering your messaging use case (A2P 10DLC, or toll-free verification) before texts are delivered reliably; that takes a few days, so start it early. If the owner's phone is the weak link, a Telegram or WhatsApp channel is a good alternative to add.

## First-day setup (owner)

1. Settings: confirm property name, timezone, photos-per-room.
2. Rooms list: add your real room numbers/types (comma separated) and any standing notes.
3. Cleaning checklist: edit the starter list to Heidi's standards.
4. Team: add managers and employees (username + password). Hourly rates are visible to the owner only.
5. Inventory: add linens, amenities, supplies with par levels.

## Layout

`src/server.js` API, `src/db.js` schema, `src/time.js` timezone math, `public/` front end (no build step), `test/` API tests.

## Not built yet

- **Phone push notifications** (the app icon buzzing). Urgent incidents are sent by text and email, and show as a red banner within ~10 seconds while the app is open. Other events (e.g. a submitted room, low stock) don't send alerts yet.
- **Offline sync** for checklist/clock actions on carts with poor signal (PRD section 7). Today the app needs a connection; the shell loads offline but actions fail with a clear message.
- **Schedule-based flags** (clock-in before/after scheduled shift, late clock-ins) because there is no shift-schedule module.
- **PRD modules outside this build:** check-in/out and revenue on the Today screen, Market Watch, AI review responses and AI insight cards (the "current build" they carry forward from wasn't available to me). Guest-complaint rate (<2%) and missed departures need booking data, so they aren't tracked.
- Printing: hours and employee profile pages have print buttons (browser print/Save as PDF); there's no separate PDF generator.
