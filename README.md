# Stay Flow – Heidi's Inn (Ilwaco, WA)

Remote-manageable housekeeping, time clock, inventory, maintenance and staff chat. It's a web app (installable on phones as a PWA), so the owner can run the inn from anywhere with a browser.

## Roles

| | Owner | Manager | Employee |
|---|---|---|---|
| Dashboard (rooms, who's clocked in, labor cost, low stock, maintenance, activity log) | ✅ full | ✅ (no wages) | – |
| Assign rooms, review & approve/send back with photos | ✅ | ✅ | – |
| Hours report, edit/add time, CSV for payroll | ✅ + pay | ✅ hours only | – |
| Inventory, team, checklist template | ✅ | ✅ | – |
| Settings, backup download, add managers, wage rates | ✅ | – | – |
| Clock in / out | ✅ | ✅ | ✅ |
| Own rooms: checklist + proof photo + submit | ✅ | ✅ | ✅ |
| Team chat (Announcements is manager-post-only) | ✅ | ✅ | ✅ |
| Maintenance / supply requests with photo | ✅ | ✅ (and triage) | ✅ (create, comment) |

**Proof of cleaning is enforced by the server:** a room can't be submitted until every checklist task is ticked and at least N photos (default 1, configurable) are attached. Managers then approve it or send it back with a note.

All dates/hours use the **property timezone** (default `America/Los_Angeles`), so an owner in Russia sees the inn's real "today". Overtime is computed weekly (Mon–Sun, default over 40 h at 1.5×).

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

## First-day setup (owner)

1. Settings: confirm property name, timezone, photos-per-room.
2. Rooms list: add your real room numbers/types (comma separated) and any standing notes.
3. Cleaning checklist: edit the starter list to Heidi's standards.
4. Team: add managers and employees (username + password). Hourly rates are visible to the owner only.
5. Inventory: add linens, amenities, supplies with par levels.

## Layout

`src/server.js` API, `src/db.js` schema, `src/time.js` timezone math, `public/` front end (no build step), `test/` API tests.

## Not included (ideas for later)

Push notifications (chat/badges poll every ~20 s while the app is open), PMS/booking sync (room "dirty" status is set manually or when rooms are assigned), payroll integration (CSV export instead), password-reset email (owner/manager resets in Team).
