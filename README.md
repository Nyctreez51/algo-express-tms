# ALGO Express TMS

A multi-user Transportation Management System for ALGO Express LLC.
Loads, expenses, drivers, equipment, settlements, document uploads
(rate confirmations + PODs), and dashboards — with separate logins for
the owner, dispatch, viewers, and drivers.

## Run it (one command)

```bash
cd ~/workspace/tms
npm install   # once
npm start
```

Then open **http://localhost:3000**.

The very first visit shows a **setup page** — create the owner account
there. After that, the owner invites everyone else from **Users** in the app.

Data lives in `./data/tms.db` (SQLite). Back it up by copying that file.

## Configuration

Copy `.env.example` to `.env` to change defaults:

| Variable       | Default          | What it does                              |
|----------------|------------------|-------------------------------------------|
| `PORT`         | `3000`           | Port the app listens on                   |
| `DB_PATH`      | `./data/tms.db`  | Where the SQLite database file lives      |
| `SESSION_DAYS` | `7`              | How long logins stay signed in            |
| `UPLOAD_DIR`   | `./data/uploads` | Where rate confirmations + PODs are stored|

## Documents — rate confirmations & PODs

Every load has a detail page (click any load in the Loads list) with an
**upload form** (owner/editor only): pick **Rate confirmation** or
**Proof of delivery**, attach one or more files, upload. Only **PDF, JPG,
PNG** up to **10MB** per file are accepted; anything else is rejected.

- Staff (owner/editor/viewer) see View/Download links on the load detail
  page; owner/editor can also delete documents.
- Drivers see their **own** loads' documents only — a driver can never
  view or download another driver's files (enforced server-side).
- Files are stored on disk under `UPLOAD_DIR` and served through an
  auth-checked route — never from a public directory.

## Roles

| Role     | Who        | Can do                                                                 |
|----------|------------|------------------------------------------------------------------------|
| `owner`  | Tree       | Everything: all data, invite/disable users, API keys, upload/delete documents |
| `editor` | Erica      | Add/edit loads, expenses, drivers, trucks; upload/delete documents. Cannot manage users. |
| `viewer` | Approved   | Read-only: dashboard + settlements, view/download load documents. No data entry, no user management. |
| `driver` | Drivers    | **Only their own numbers**, on phone-friendly pages: this week's pay/miles, YTD pay/miles/loads, their load list, their settlement history, and their own loads' rate confirmations + PODs. They cannot see other drivers, company financials, or expenses. |

The owner creates logins on the **Users** page (email + temporary password +
role). A `driver` login **must** be linked to that driver's record.

## Business rules baked in

- **Settlement week = Friday → Thursday.** A Friday delivery counts toward
  the week that starts that Friday. The Settlements page defaults to the
  current week and lets you flip through past weeks.
- **Driver pay = gross × pay %.** Gross = linehaul + fuel surcharge (always
  stored separately on every load). Default pay is **30%**, editable per
  driver on the Drivers page.
- **Money is stored as integer cents** — no floating-point rounding issues.

## Pointing a domain / subdomain at it

On your hosting (VPS, Railway, Render, etc.):

1. Deploy this folder, run `npm install && npm start` (use a process
   manager like `pm2` or systemd so it restarts on reboot).
2. Put it behind HTTPS (Caddy or Nginx can terminate TLS automatically).
3. In your DNS (Cloudflare), add an **A record** for e.g. `tms.algoexpress.net`
   pointing at the server's IP, then reverse-proxy to `localhost:3000`.
4. In `src/auth.js`, uncomment the `secure: true` cookie flag once HTTPS
   is on.

## Railway deploy (current hosting)

1. Push to GitHub — Railway auto-deploys from the `main` branch.
2. **Persistent uploads:** Railway's filesystem is wiped on every redeploy,
   so uploaded rate confirmations and PODs need a Volume:
   - In the Railway dashboard, open the `algo-express-tms` service →
     **Volumes** → **New Volume**, mount path **`/data/uploads`**.
   - On the service's **Variables** tab, set **`UPLOAD_DIR=/data/uploads`**.
   - Redeploy. Uploads now survive redeploys.
3. **Database persistence (important):** the SQLite database at
   `./data/tms.db` is wiped on redeploy too. Put it on the same volume:
   set **`DB_PATH=/data/tms.db`** in Variables (the `/data` parent is
   created automatically). Back up by downloading the file from the
   volume, or copy it before redeploys.
4. Custom domain: service **Settings → Networking → Custom Domain**
   (e.g. `tms.algoexpress.net`), then add the DNS records Railway shows
   in Cloudflare.

## JSON sync API (for the daily sheet job)

Base: `/api/v1`. Authenticate with header **`X-API-Key: <key>`**.
Generate keys on the Users page (owner only). Money in the API is **dollars**
(decimals fine); the API stores cents.

**`GET /api/v1/health`** — no auth. Returns `{"ok": true}`.

**`POST /api/v1/loads/upsert`** — insert or update a load. When
`external_id` matches an existing row, that row is **updated** (no
duplicates) and the response says `"updated": true`.

```json
{
  "external_id": "sheet-row-123",
  "date": "2026-10-18",
  "origin": "Decatur, GA",
  "destination": "Stone Mountain, GA",
  "loaded_miles": 10,
  "empty_miles": 5,
  "linehaul": 400.00,
  "fuel_surcharge": 96.40,
  "broker": "PLS",
  "driver": "Jason Clark",
  "truck": "101",
  "status": "delivered",
  "notes": ""
}
```

- `date` (YYYY-MM-DD) is required. `linehaul` and `fuel_surcharge` are
  always stored separately.
- `driver` accepts a driver **name** or `driver_id`. `truck` accepts a
  **unit_number** or `truck_id`. Unknown names resolve to empty (not an error).
- `status`: `booked` | `in_transit` | `delivered` | `cancelled`.

**`POST /api/v1/expenses/upsert`** — same upsert behavior on `external_id`.

```json
{
  "external_id": "sheet-row-456",
  "date": "2026-10-18",
  "truck": "101",
  "category": "fuel",
  "amount": 226.10,
  "notes": "Pilot, I-20"
}
```

- `date` and `amount` are required. `category`: `fuel` | `maintenance` |
  `insurance` | `tolls` | `other` (anything else becomes `other`).

Errors return `{"ok": false, "error": "..."}` with HTTP 400/401.

## Seeded data

- Company: ALGO Express LLC, MC-1656363, USDOT 4266729
- Drivers: Trion Thomas, Jason Clark, Donte Murrill, Shdermon Hammond,
  Michael Parker (30% pay, active)
- Equipment (from the 10/18/2026 COI): 8 tractors including the 2025
  Freightliner Cascadia, plus the 2026 Fontaine 53' step deck and the
  2014 Utility reefer trailer
- **No loads or expenses** — those start empty for real data entry / sync.

## For developers

- Stack: Node 20+ (uses built-in `node:sqlite` — no native modules),
  Express, bcryptjs, multer (document uploads). No build step, no frontend framework.
- Source: `server.js` (entry), `src/db.js` (schema/seed/queries),
  `src/auth.js` (sessions/roles), `src/routes.js` (pages + API),
  `src/views.js` (templates), `src/dates.js` (settlement-week math).
- Every business table has `tenant_id` (today: single tenant `'algo'`)
  so the app can serve multiple fleets later.
- Driver pages (`/driver/*`) are mobile-first with a bottom tab bar and
  `apple-mobile-web-app-capable` meta tags — drivers can "Add to Home
  Screen" on iPhone for an app-like feel.

<!-- storage persistence verified 2026-10-18 -->
