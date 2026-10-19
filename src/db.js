// db.js — SQLite storage (Node's built-in node:sqlite), schema, seed data, queries.
// Money is stored as INTEGER cents everywhere. Dates are TEXT 'YYYY-MM-DD'.
// Every business table carries tenant_id so the app can one day serve many
// fleets (Tree's resale goal). Today exactly one tenant is seeded: 'algo'.

'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tms.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  mc_number   TEXT,
  usdot_number TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','editor','viewer','driver')),
  driver_id     INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trucks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  unit_number TEXT,
  year        INTEGER,
  make        TEXT,
  model       TEXT,
  vin         TEXT,
  type        TEXT NOT NULL DEFAULT 'tractor' CHECK (type IN ('tractor','trailer')),
  trailer_desc TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS drivers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  phone       TEXT,
  pay_pct     REAL NOT NULL DEFAULT 30,   -- percent of gross paid to driver
  pay_type    TEXT NOT NULL DEFAULT 'percent', -- 'percent' | 'per_mile'
  pay_rate    REAL,                        -- dollars per loaded mile when pay_type='per_mile'
  status      TEXT NOT NULL DEFAULT 'active',
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS loads (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL,
  external_id    TEXT,                     -- id from Erica's sheet; upsert key
  date           TEXT NOT NULL,            -- YYYY-MM-DD
  origin         TEXT,
  destination    TEXT,
  loaded_miles   REAL NOT NULL DEFAULT 0,
  empty_miles    REAL NOT NULL DEFAULT 0,
  linehaul_cents INTEGER NOT NULL DEFAULT 0,
  fsc_cents      INTEGER NOT NULL DEFAULT 0,
  broker         TEXT,
  driver_id      INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  truck_id       INTEGER REFERENCES trucks(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'delivered',
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, external_id)
);

-- Live trip tracking (driver phone GPS; Path 1: web-based, while page is open).
CREATE TABLE IF NOT EXISTS trips (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  driver_id  INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  load_id    INTEGER REFERENCES loads(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT,                       -- NULL = trip currently active
  start_lat  REAL, start_lon REAL,
  end_lat    REAL, end_lon REAL
);
CREATE TABLE IF NOT EXISTS positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  trip_id     INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  accuracy    REAL,                       -- meters, as reported by the phone
  speed       REAL,                       -- mph (converted from m/s at ingest)
  heading     REAL,                       -- degrees, as reported by the phone
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(tenant_id, driver_id, started_at);
CREATE INDEX IF NOT EXISTS idx_positions_trip ON positions(tenant_id, trip_id, recorded_at);

CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  external_id  TEXT,
  date         TEXT NOT NULL,              -- YYYY-MM-DD
  truck_id     INTEGER REFERENCES trucks(id) ON DELETE SET NULL,
  category     TEXT NOT NULL CHECK (category IN ('fuel','maintenance','insurance','tolls','other')),
  amount_cents INTEGER NOT NULL,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, external_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL,                -- sha256 of the key; plaintext shown once
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT NOT NULL,
  load_id       INTEGER NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('ratecon','pod')),
  original_name TEXT NOT NULL,              -- filename as uploaded, for display/download
  stored_path   TEXT NOT NULL,              -- absolute path on disk
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_load ON documents(tenant_id, load_id);

-- driver escrow ledger: +withholding builds the balance, -deduction/-release draw it down
CREATE TABLE IF NOT EXISTS escrow_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  driver_id    INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,              -- YYYY-MM-DD
  amount_cents INTEGER NOT NULL,           -- +withholding, -deduction/release
  entry_type   TEXT NOT NULL CHECK (entry_type IN ('withholding','deduction','release','adjustment')),
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_escrow_driver ON escrow_entries(tenant_id, driver_id, date);

CREATE INDEX IF NOT EXISTS idx_loads_tenant_date ON loads(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_loads_driver ON loads(tenant_id, driver_id);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_date ON expenses(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
`;

db.exec(SCHEMA);

// ---- Seed: company, drivers, equipment (facts only — no financials) ----
const TENANT = 'algo';

function seed() {
  const hasCompany = db.prepare('SELECT 1 FROM companies WHERE tenant_id = ?').get(TENANT);
  if (hasCompany) return;

  db.prepare(
    'INSERT INTO companies (tenant_id, name, mc_number, usdot_number) VALUES (?,?,?,?)'
  ).run(TENANT, 'ALGO Express LLC', 'MC-1656363', '4266729');

  // Drivers — from Tree, Oct 2026. Phones unknown; pay default 30% of gross.
  const drivers = [
    'Trion Thomas',
    'Jason Clark',
    'Donte Murrill',
    'Shdermon Hammond',
    'Michael Parker',
  ];
  const insD = db.prepare(
    'INSERT INTO drivers (tenant_id, name, pay_pct, status) VALUES (?,?,30,?)'
  );
  for (const name of drivers) insD.run(TENANT, name, 'active');

  // Equipment — scheduled on the 10/18/2026 GEICO COI (verified VINs).
  // NOTE: the COI spells the trailer maker "FONTEIN"; correct spelling used here.
  const units = [
    // year, make, model, vin, type, primary?
    [2025, 'Freightliner', 'Cascadia', '3AKJHHDR7SSVS9058', 'tractor', 'Primary unit — 2025 Freightliner + 53\' Fontaine step deck'],
    [2020, 'International', 'LT625', '3HSDZAPR0LN869265', 'tractor', null],
    [2021, 'International', 'LT625', '3HSDZAPR5MN233135', 'tractor', null],
    [2020, 'International', 'LT625', '3HSDZAPR8LN121301', 'tractor', null],
    [2022, 'Freightliner', 'Cascadia', '3AKJHHDR7NSMY4904', 'tractor', null],
    [2022, 'International', 'MV607', '3HAEUMML4NL457972', 'tractor', null],
    [2021, 'International', 'LT625', '3HSDZAPR9MN104556', 'tractor', null],
    [2022, 'Peterbilt', '579', '1XPBD49X1ND813981', 'tractor', null],
    [2026, 'Fontaine', "53' step deck", '13N2532C3T1576257', 'trailer', 'Primary trailer — pairs with 2025 Cascadia'],
    [2014, 'Utility', '3000R reefer', '1UYVS253XEM057418', 'trailer', null],
  ];
  const insT = db.prepare(
    'INSERT INTO trucks (tenant_id, year, make, model, vin, type, notes, status) VALUES (?,?,?,?,?,?,?,?)'
  );
  for (const [year, make, model, vin, type, notes] of units) {
    insT.run(TENANT, year, make, model, vin, type, notes, 'active');
  }
}
seed();

// ---- one-time migrations for databases created before a schema change ----
function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  const cols = db.prepare(`PRAGMA table_info(drivers)`).all().map(c => c.name);
  if (!cols.includes('pay_type')) db.exec(`ALTER TABLE drivers ADD COLUMN pay_type TEXT NOT NULL DEFAULT 'percent'`);
  if (!cols.includes('pay_rate')) db.exec(`ALTER TABLE drivers ADD COLUMN pay_rate REAL`);
  // IFTA fuel fields on expenses (gallons + purchase state).
  const ecols = db.prepare(`PRAGMA table_info(expenses)`).all().map(c => c.name);
  if (!ecols.includes('gallons')) db.exec(`ALTER TABLE expenses ADD COLUMN gallons REAL`);
  if (!ecols.includes('fuel_state')) db.exec(`ALTER TABLE expenses ADD COLUMN fuel_state TEXT`);
  // Owner-confirmed driver pay terms, Oct 18 2026. Runs once; never overwrites
  // values the owner later changes in the UI.
  const done = db.prepare(`SELECT v FROM meta WHERE k='payterms-2026-10-18'`).get();
  if (!done) {
    db.prepare(`UPDATE drivers SET pay_type='per_mile', pay_rate=0.65
      WHERE tenant_id=? AND name IN ('Donte Murrill','Shdermon Hammond')`).run(TENANT);
    db.prepare(`UPDATE drivers SET pay_pct=35 WHERE tenant_id=? AND name='Michael Parker'`).run(TENANT);
    db.prepare(`UPDATE drivers SET pay_pct=25 WHERE tenant_id=? AND name='Jason Clark'`).run(TENANT);
    db.prepare(`INSERT INTO meta (k,v) VALUES ('payterms-2026-10-18','1')`).run();
  }
}
migrate();

// ---- Query helpers ----
function userCount(tenantId = TENANT) {
  return db.prepare('SELECT COUNT(*) AS c FROM users WHERE tenant_id = ?').get(tenantId).c;
}

function findUserByEmail(tenantId, email) {
  return db.prepare('SELECT * FROM users WHERE tenant_id = ? AND email = ? COLLATE NOCASE')
    .get(tenantId, email);
}

function findUserById(id) {
  return db.prepare(
    `SELECT u.*, d.name AS driver_name FROM users u
     LEFT JOIN drivers d ON d.id = u.driver_id WHERE u.id = ?`
  ).get(id);
}

function createUser({ tenantId = TENANT, email, passwordHash, role, driverId = null }) {
  const r = db.prepare(
    'INSERT INTO users (tenant_id, email, password_hash, role, driver_id) VALUES (?,?,?,?,?)'
  ).run(tenantId, email, passwordHash, role, driverId);
  return r.lastInsertRowid;
}

function listUsers(tenantId = TENANT) {
  return db.prepare(
    `SELECT u.id, u.email, u.role, u.active, u.created_at, d.name AS driver_name
     FROM users u LEFT JOIN drivers d ON d.id = u.driver_id
     WHERE u.tenant_id = ? ORDER BY u.created_at`
  ).all(tenantId);
}

function setUserActive(id, active) {
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(token, userId, days) {
  const exp = new Date(Date.now() + days * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, userId, exp);
}

function getSession(token) {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  return findUserById(s.user_id);
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function getCompany(tenantId = TENANT) {
  return db.prepare('SELECT * FROM companies WHERE tenant_id = ?').get(tenantId);
}

// ---- Trucks ----
function listTrucks(tenantId = TENANT) {
  return db.prepare('SELECT * FROM trucks WHERE tenant_id = ? ORDER BY type, year DESC').all(tenantId);
}
function getTruck(id, tenantId = TENANT) {
  return db.prepare('SELECT * FROM trucks WHERE id = ? AND tenant_id = ?').get(id, tenantId);
}
function saveTruck(t, tenantId = TENANT) {
  if (t.id) {
    db.prepare(`UPDATE trucks SET unit_number=?, year=?, make=?, model=?, vin=?,
      type=?, trailer_desc=?, status=?, notes=? WHERE id=? AND tenant_id=?`)
      .run(t.unit_number || null, t.year || null, t.make || null, t.model || null,
        t.vin || null, t.type || 'tractor', t.trailer_desc || null,
        t.status || 'active', t.notes || null, t.id, tenantId);
    return t.id;
  }
  const r = db.prepare(`INSERT INTO trucks
    (tenant_id, unit_number, year, make, model, vin, type, trailer_desc, status, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(tenantId, t.unit_number || null, t.year || null, t.make || null, t.model || null,
      t.vin || null, t.type || 'tractor', t.trailer_desc || null,
      t.status || 'active', t.notes || null);
  return r.lastInsertRowid;
}
function findTruckByUnit(unitNumber, tenantId = TENANT) {
  return db.prepare('SELECT * FROM trucks WHERE tenant_id = ? AND unit_number = ?')
    .get(tenantId, unitNumber);
}

// ---- Drivers ----
function listDrivers(tenantId = TENANT) {
  return db.prepare('SELECT * FROM drivers WHERE tenant_id = ? ORDER BY name').all(tenantId);
}
function getDriver(id, tenantId = TENANT) {
  return db.prepare('SELECT * FROM drivers WHERE id = ? AND tenant_id = ?').get(id, tenantId);
}
function findDriverByName(name, tenantId = TENANT) {
  return db.prepare('SELECT * FROM drivers WHERE tenant_id = ? AND name = ? COLLATE NOCASE')
    .get(tenantId, name);
}
function saveDriver(d, tenantId = TENANT) {
  const payType = d.pay_type === 'per_mile' ? 'per_mile' : 'percent';
  const payRate = payType === 'per_mile' ? (Number(d.pay_rate) || null) : null;
  if (d.id) {
    db.prepare(`UPDATE drivers SET name=?, phone=?, pay_pct=?, pay_type=?, pay_rate=?, status=?, notes=?
      WHERE id=? AND tenant_id=?`)
      .run(d.name, d.phone || null, d.pay_pct ?? 30, payType, payRate,
        d.status || 'active', d.notes || null, d.id, tenantId);
    return d.id;
  }
  const r = db.prepare(
    'INSERT INTO drivers (tenant_id, name, phone, pay_pct, pay_type, pay_rate, status, notes) VALUES (?,?,?,?,?,?,?,?)'
  ).run(tenantId, d.name, d.phone || null, d.pay_pct ?? 30, payType, payRate, d.status || 'active', d.notes || null);
  return r.lastInsertRowid;
}

// ---- Loads ----
function listLoads(tenantId = TENANT, { driverId = null, limit = 500 } = {}) {
  let sql = `SELECT l.*, d.name AS driver_name,
      COALESCE(t.unit_number, t.year || ' ' || t.make || ' ' || t.model) AS truck_label
    FROM loads l LEFT JOIN drivers d ON d.id = l.driver_id
    LEFT JOIN trucks t ON t.id = l.truck_id
    WHERE l.tenant_id = ?`;
  const params = [tenantId];
  if (driverId) { sql += ' AND l.driver_id = ?'; params.push(driverId); }
  sql += ' ORDER BY l.date DESC, l.id DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}
function getLoad(id, tenantId = TENANT) {
  return db.prepare('SELECT * FROM loads WHERE id = ? AND tenant_id = ?').get(id, tenantId);
}
function saveLoad(l, tenantId = TENANT) {
  if (l.id) {
    db.prepare(`UPDATE loads SET date=?, origin=?, destination=?, loaded_miles=?, empty_miles=?,
      linehaul_cents=?, fsc_cents=?, broker=?, driver_id=?, truck_id=?, status=?, notes=?
      WHERE id=? AND tenant_id=?`)
      .run(l.date, l.origin || null, l.destination || null, l.loaded_miles || 0,
        l.empty_miles || 0, l.linehaul_cents || 0, l.fsc_cents || 0, l.broker || null,
        l.driver_id || null, l.truck_id || null, l.status || 'delivered', l.notes || null,
        l.id, tenantId);
    return l.id;
  }
  const r = db.prepare(`INSERT INTO loads
    (tenant_id, external_id, date, origin, destination, loaded_miles, empty_miles,
     linehaul_cents, fsc_cents, broker, driver_id, truck_id, status, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(tenantId, l.external_id || null, l.date, l.origin || null, l.destination || null,
      l.loaded_miles || 0, l.empty_miles || 0, l.linehaul_cents || 0, l.fsc_cents || 0,
      l.broker || null, l.driver_id || null, l.truck_id || null,
      l.status || 'delivered', l.notes || null);
  return r.lastInsertRowid;
}
function upsertLoad(l, tenantId = TENANT) {
  if (l.external_id) {
    const ex = db.prepare('SELECT id FROM loads WHERE tenant_id = ? AND external_id = ?')
      .get(tenantId, l.external_id);
    if (ex) { l.id = ex.id; return { id: saveLoad(l, tenantId), updated: true }; }
  }
  return { id: saveLoad(l, tenantId), updated: false };
}
function deleteLoad(id, tenantId = TENANT) {
  db.prepare('DELETE FROM loads WHERE id = ? AND tenant_id = ?').run(id, tenantId);
}

// ---- Expenses ----
function listExpenses(tenantId = TENANT, { limit = 500 } = {}) {
  return db.prepare(`SELECT e.*,
      COALESCE(t.unit_number, t.year || ' ' || t.make || ' ' || t.model) AS truck_label
    FROM expenses e LEFT JOIN trucks t ON t.id = e.truck_id
    WHERE e.tenant_id = ? ORDER BY e.date DESC, e.id DESC LIMIT ?`).all(tenantId, limit);
}
function getExpense(id, tenantId = TENANT) {
  return db.prepare('SELECT * FROM expenses WHERE id = ? AND tenant_id = ?').get(id, tenantId);
}
function saveExpense(e, tenantId = TENANT) {
  const gallons = e.gallons != null && Number.isFinite(Number(e.gallons)) ? Number(e.gallons) : null;
  const fuelState = e.fuel_state ? String(e.fuel_state).toUpperCase().slice(0, 2) : null;
  if (e.id) {
    db.prepare(`UPDATE expenses SET date=?, truck_id=?, category=?, amount_cents=?, notes=?,
      gallons=?, fuel_state=? WHERE id=? AND tenant_id=?`)
      .run(e.date, e.truck_id || null, e.category, e.amount_cents, e.notes || null,
        gallons, fuelState, e.id, tenantId);
    return e.id;
  }
  const r = db.prepare(`INSERT INTO expenses
    (tenant_id, external_id, date, truck_id, category, amount_cents, notes, gallons, fuel_state)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(tenantId, e.external_id || null, e.date, e.truck_id || null, e.category,
      e.amount_cents, e.notes || null, gallons, fuelState);
  return r.lastInsertRowid;
}

// ---------- live trip tracking ----------
function activeTrip(driverId, tenantId = TENANT) {
  return db.prepare(`SELECT t.*, d.name AS driver_name,
      (SELECT COUNT(*) FROM positions p WHERE p.trip_id = t.id AND p.tenant_id = t.tenant_id) AS fixes
    FROM trips t JOIN drivers d ON d.id = t.driver_id
    WHERE t.tenant_id = ? AND t.driver_id = ? AND t.ended_at IS NULL
    ORDER BY t.started_at DESC LIMIT 1`).get(tenantId, driverId);
}
function startTrip(driverId, loadId, tenantId = TENANT) {
  db.prepare(`UPDATE trips SET ended_at = datetime('now')
    WHERE tenant_id = ? AND driver_id = ? AND ended_at IS NULL`).run(tenantId, driverId);
  const r = db.prepare(`INSERT INTO trips (tenant_id, driver_id, load_id) VALUES (?,?,?)`)
    .run(tenantId, driverId, loadId || null);
  return r.lastInsertRowid;
}
function endTrip(driverId, tenantId = TENANT) {
  const t = activeTrip(driverId, tenantId);
  if (!t) return null;
  db.prepare(`UPDATE trips SET ended_at = datetime('now') WHERE id = ? AND tenant_id = ?`)
    .run(t.id, tenantId);
  return t.id;
}
function addPosition(driverId, pos, tenantId = TENANT) {
  const t = activeTrip(driverId, tenantId);
  if (!t) return null;
  const lat = Number(pos.lat), lon = Number(pos.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  db.prepare(`INSERT INTO positions
    (tenant_id, trip_id, lat, lon, accuracy, speed, heading) VALUES (?,?,?,?,?,?,?)`)
    .run(tenantId, t.id, lat, lon,
      pos.accuracy != null ? Number(pos.accuracy) : null,
      pos.speed != null ? Number(pos.speed) : null,
      pos.heading != null ? Number(pos.heading) : null);
  if (t.fixes === 0) {
    db.prepare(`UPDATE trips SET start_lat = ?, start_lon = ? WHERE id = ?`).run(lat, lon, t.id);
  }
  return t.id;
}
// Active trips with latest fix — for the owner's fleet map.
function fleetSnapshot(tenantId = TENANT) {
  return db.prepare(
    `SELECT t.id AS trip_id, t.driver_id, d.name AS driver_name, t.load_id,
      l.origin, l.destination, t.started_at,
      p.lat, p.lon, p.speed, p.recorded_at,
      (SELECT COUNT(*) FROM positions WHERE trip_id = t.id) AS fixes
    FROM trips t
    JOIN drivers d ON d.id = t.driver_id
    LEFT JOIN loads l ON l.id = t.load_id
    LEFT JOIN positions p ON p.id = (
      SELECT id FROM positions WHERE trip_id = t.id AND tenant_id = t.tenant_id
      ORDER BY recorded_at DESC LIMIT 1)
    WHERE t.tenant_id = ? AND t.ended_at IS NULL
    ORDER BY d.name`).all(tenantId);
}
function upsertExpense(e, tenantId = TENANT) {
  if (e.external_id) {
    const ex = db.prepare('SELECT id FROM expenses WHERE tenant_id = ? AND external_id = ?')
      .get(tenantId, e.external_id);
    if (ex) { e.id = ex.id; return { id: saveExpense(e, tenantId), updated: true }; }
  }
  return { id: saveExpense(e, tenantId), updated: false };
}
function deleteExpense(id, tenantId = TENANT) {
  db.prepare('DELETE FROM expenses WHERE id = ? AND tenant_id = ?').run(id, tenantId);
}

// ---- Driver escrow ledger ----
function createEscrowEntry(e, tenantId = TENANT) {
  const r = db.prepare(`INSERT INTO escrow_entries
    (tenant_id, driver_id, date, amount_cents, entry_type, notes)
    VALUES (?,?,?,?,?,?)`)
    .run(tenantId, e.driver_id, e.date, e.amount_cents, e.entry_type, e.notes || null);
  return r.lastInsertRowid;
}
function listEscrowEntries(driverId, tenantId = TENANT) {
  return db.prepare(`SELECT * FROM escrow_entries
    WHERE tenant_id = ? AND driver_id = ? ORDER BY date DESC, id DESC`).all(tenantId, driverId);
}
function escrowBalance(driverId, tenantId = TENANT) {
  const r = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS bal FROM escrow_entries
    WHERE tenant_id = ? AND driver_id = ?`).get(tenantId, driverId);
  return r.bal;
}
function escrowWithheld(driverId, w0, w1, tenantId = TENANT) {
  const r = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS amt FROM escrow_entries
    WHERE tenant_id = ? AND driver_id = ? AND date >= ? AND date <= ?
    AND entry_type = 'withholding'`).get(tenantId, driverId, w0, w1);
  return r.amt;
}

// ---- Documents (rate confirmations + PODs attached to loads) ----
function listDocumentsByLoad(loadId, tenantId = TENANT) {
  return db.prepare(`SELECT d.*, u.email AS uploaded_by_email
    FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
    WHERE d.load_id = ? AND d.tenant_id = ? ORDER BY d.uploaded_at`)
    .all(loadId, tenantId);
}
function getDocument(id, tenantId = TENANT) {
  return db.prepare('SELECT * FROM documents WHERE id = ? AND tenant_id = ?')
    .get(id, tenantId);
}
function createDocument(doc, tenantId = TENANT) {
  const r = db.prepare(`INSERT INTO documents
    (tenant_id, load_id, doc_type, original_name, stored_path, mime, size_bytes, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(tenantId, doc.load_id, doc.doc_type, doc.original_name, doc.stored_path,
      doc.mime, doc.size_bytes, doc.uploaded_by || null);
  return r.lastInsertRowid;
}
function deleteDocument(id, tenantId = TENANT) {
  const d = getDocument(id, tenantId);
  if (d) db.prepare('DELETE FROM documents WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  return d; // caller removes the file from disk
}

// ---- API keys ----
function createApiKey(tenantId, name) {
  const key = 'tms_' + crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  db.prepare('INSERT INTO api_keys (tenant_id, name, key_hash) VALUES (?,?,?)')
    .run(tenantId, name, hash);
  return key; // plaintext returned ONCE
}
function findTenantByApiKey(key) {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const row = db.prepare('SELECT tenant_id FROM api_keys WHERE key_hash = ?').get(hash);
  return row ? row.tenant_id : null;
}
function listApiKeys(tenantId = TENANT) {
  return db.prepare('SELECT id, name, created_at FROM api_keys WHERE tenant_id = ? ORDER BY id')
    .all(tenantId);
}
function deleteApiKey(id, tenantId = TENANT) {
  db.prepare('DELETE FROM api_keys WHERE id = ? AND tenant_id = ?').run(id, tenantId);
}

module.exports = {
  TENANT,
  db,
  userCount, findUserByEmail, findUserById, createUser, listUsers, setUserActive,
  newSessionToken, createSession, getSession, deleteSession,
  getCompany,
  listTrucks, getTruck, saveTruck, findTruckByUnit,
  listDrivers, getDriver, findDriverByName, saveDriver,
  listLoads, getLoad, saveLoad, upsertLoad, deleteLoad,
  listExpenses, getExpense, saveExpense, upsertExpense, deleteExpense,
  createEscrowEntry, listEscrowEntries, escrowBalance, escrowWithheld,
  listDocumentsByLoad, getDocument, createDocument, deleteDocument,
  createApiKey, findTenantByApiKey, listApiKeys, deleteApiKey,
  activeTrip, startTrip, endTrip, addPosition, fleetSnapshot,
};
