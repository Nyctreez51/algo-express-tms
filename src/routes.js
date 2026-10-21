// routes.js — all HTTP routes: pages, auth, and the JSON sync API.
// Money arrives from forms/API in DOLLARS and is stored as INTEGER cents.

'use strict';

const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const db = require('./db');
const auth = require('./auth');
const AZ = require('./analyze');
const perf = require('./performance');
const RC = require('./ratecon');
const v = require('./views');
const D = require('./dates');
const { fmtNum } = require('./dates');

const router = express.Router();

// ---------- document uploads (rate confirmations + PODs) ----------
// Files live on disk under UPLOAD_DIR. On Railway, add a Volume mounted at
// /data/uploads and set UPLOAD_DIR=/data/uploads so files survive redeploys.
// Local default is ./data/uploads (never committed to the repo).
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_DOCS = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};
const ALLOWED_EXTS = ['.pdf', '.jpg', '.jpeg', '.png'];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB per file

const docStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOAD_DIR, 'load_' + req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = ALLOWED_DOCS[file.mimetype] ||
      ALLOWED_EXTS.find(e => e === path.extname(file.originalname).toLowerCase()) || '.bin';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});

function docFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_DOCS[file.mimetype] && ALLOWED_EXTS.includes(ext)) return cb(null, true);
  cb(new Error('Only PDF, JPG, and PNG files are allowed (max 10MB each).'));
}

const uploadDocs = multer({
  storage: docStorage,
  fileFilter: docFileFilter,
  limits: { fileSize: MAX_FILE_BYTES, files: 10 },
}).array('files', 10);

// Stream a stored file after auth + ownership checks (never a public directory).
function serveDocument(res, doc, { download = false } = {}) {
  if (!doc.stored_path || !fs.existsSync(doc.stored_path)) {
    return res.status(404).send('File missing on disk.');
  }
  const safeName = String(doc.original_name).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'document';
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Length', doc.size_bytes);
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${safeName}"`);
  fs.createReadStream(doc.stored_path).pipe(res);
}

// "$1,234.56" / 1234.56 / "" -> cents (integer)
function toCents(x) {
  if (x == null || x === '') return 0;
  const n = Number(String(x).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function toNum(x, fb = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fb;
}
const T = () => db.TENANT;

// ---------- public ----------
router.get('/', (req, res) => {
  if (db.userCount() === 0) return res.redirect('/setup');
  if (!req.user) return res.redirect('/login');
  return res.redirect(req.user.role === 'driver' ? '/driver' : '/dashboard');
});

router.get('/setup', (req, res) => {
  if (db.userCount() > 0) return res.redirect('/login');
  res.send(v.setupPage());
});

router.post('/setup', express.urlencoded({ extended: false }), (req, res) => {
  if (db.userCount() > 0) return res.redirect('/login');
  const email = String(req.body.email || '').trim().toLowerCase();
  const pw = String(req.body.password || '');
  if (!email.includes('@') || pw.length < 8) {
    return res.status(400).send(v.setupPage());
  }
  const id = db.createUser({
    email, passwordHash: auth.hashPassword(pw), role: 'owner',
  });
  auth.startSession(res, db.findUserById(id));
  res.redirect('/dashboard');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.send(v.loginPage(req.query));
});

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = db.findUserByEmail(T(), email);
  if (!u || !u.active || !auth.verifyPassword(String(req.body.password || ''), u.password_hash)) {
    return res.status(401).send(v.loginPage({ err: 'Wrong email or password.' }));
  }
  auth.startSession(res, db.findUserById(u.id));
  res.redirect(u.role === 'driver' ? '/driver' : '/dashboard');
});

router.get('/logout', (req, res) => {
  auth.endSession(req, res);
  res.redirect('/login');
});

router.get('/api/v1/health', (req, res) => res.json({ ok: true }));

// ---------- JSON sync API (X-API-Key; NOT behind session login) ----------
function apiAuth(req, res, next) {
  const key = req.get('X-API-Key');
  const tenantId = key && db.findTenantByApiKey(key);
  if (!tenantId) return res.status(401).json({ ok: false, error: 'bad api key' });
  req.tenantId = tenantId;
  next();
}

function resolveDriverId(tenantId, ref) {
  if (!ref) return null;
  if (/^\d+$/.test(String(ref))) {
    const d = db.getDriver(Number(ref), tenantId);
    return d ? d.id : null;
  }
  const d = db.findDriverByName(String(ref).trim(), tenantId);
  return d ? d.id : null;
}
function resolveTruckId(tenantId, ref) {
  if (!ref) return null;
  if (/^\d+$/.test(String(ref))) {
    const t = db.getTruck(Number(ref), tenantId);
    return t ? t.id : null;
  }
  const t = db.findTruckByUnit(String(ref).trim(), tenantId);
  return t ? t.id : null;
}

router.post('/api/v1/loads/upsert', apiAuth, express.json(), (req, res) => {
  const b = req.body || {};
  if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
    return res.status(400).json({ ok: false, error: 'date is required (YYYY-MM-DD)' });
  }
  const r = db.upsertLoad({
    external_id: b.external_id || null,
    date: b.date,
    origin: b.origin || null,
    destination: b.destination || null,
    loaded_miles: toNum(b.loaded_miles),
    empty_miles: toNum(b.empty_miles),
    linehaul_cents: toCents(b.linehaul),
    fsc_cents: toCents(b.fuel_surcharge),
    broker: b.broker || null,
    driver_id: resolveDriverId(req.tenantId, b.driver ?? b.driver_id),
    truck_id: resolveTruckId(req.tenantId, b.truck ?? b.truck_id),
    status: b.status || 'delivered',
    notes: b.notes || null,
  }, req.tenantId);
  res.json({ ok: true, id: r.id, updated: r.updated });
});

router.post('/api/v1/expenses/upsert', apiAuth, express.json(), (req, res) => {
  const b = req.body || {};
  const cats = ['fuel', 'maintenance', 'insurance', 'tolls', 'other'];
  if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
    return res.status(400).json({ ok: false, error: 'date is required (YYYY-MM-DD)' });
  }
  if (b.amount == null || !Number.isFinite(Number(b.amount))) {
    return res.status(400).json({ ok: false, error: 'amount is required' });
  }
  const r = db.upsertExpense({
    external_id: b.external_id || null,
    date: b.date,
    truck_id: resolveTruckId(req.tenantId, b.truck ?? b.truck_id),
    category: cats.includes(b.category) ? b.category : 'other',
    amount_cents: toCents(b.amount),
    notes: b.notes || null,
    gallons: b.gallons != null ? Number(b.gallons) : null,
    fuel_state: b.fuel_state || b.state || null,
  }, req.tenantId);
  res.json({ ok: true, id: r.id, updated: r.updated });
});

// ---------- everything below needs a login ----------
router.use(auth.requireAuth, auth.scopeGuard);

// ----- dashboard (owner/editor/viewer) -----
function revenueBetween(from, to, driverId = null) {
  let sql = `SELECT COUNT(*) AS loads,
      COALESCE(SUM(loaded_miles + empty_miles),0) AS miles,
      COALESCE(SUM(loaded_miles),0) AS loaded_miles,
      COALESCE(SUM(linehaul_cents + fsc_cents),0) AS revenue
    FROM loads WHERE tenant_id = ? AND date >= ? AND date <= ?`;
  const p = [T(), from, to];
  if (driverId) { sql += ' AND driver_id = ?'; p.push(driverId); }
  return db.db.prepare(sql).get(...p);
}

function dashboardData(monthYm) {
  const today = D.todayStr();
  const ws = D.weekStartOf(today);
  const [w0, w1] = D.weekRange(ws);
  const y0 = D.yearStart(today);
  const ytd = revenueBetween(y0, today);
  const months = D.recentMonths(12);
  if (!monthYm || !/^\d{4}-\d{2}$/.test(monthYm)) monthYm = months[0];
  const [m0, m1] = D.monthRange(monthYm);
  const month = revenueBetween(m0, m1);
  const monthExpenses = db.db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS total FROM expenses
     WHERE tenant_id = ? AND date >= ? AND date <= ?`
  ).get(T(), m0, m1).total;

  const trucks = db.db.prepare(
    `SELECT COALESCE(t.unit_number, (t.year || ' ' || t.make || ' ' || t.model)) AS label,
      COALESCE((SELECT SUM(l.linehaul_cents + l.fsc_cents) FROM loads l
        WHERE l.tenant_id = t.tenant_id AND l.truck_id = t.id AND l.date >= ?),0) AS revenue,
      COALESCE((SELECT SUM(e.amount_cents) FROM expenses e
        WHERE e.tenant_id = t.tenant_id AND e.truck_id = t.id AND e.date >= ?),0) AS expenses
    FROM trucks t WHERE t.tenant_id = ? AND t.type = 'tractor' ORDER BY revenue DESC`
  ).all(y0, y0, T());

  const drivers = db.db.prepare(
    `SELECT d.id, d.name, d.pay_pct,
      COUNT(l.id) AS loads,
      COALESCE(SUM(l.loaded_miles + l.empty_miles),0) AS miles,
      COALESCE(SUM(l.linehaul_cents + l.fsc_cents),0) AS gross
    FROM drivers d LEFT JOIN loads l
      ON l.driver_id = d.id AND l.tenant_id = d.tenant_id AND l.date >= ?
    WHERE d.tenant_id = ? GROUP BY d.id ORDER BY gross DESC`
  ).all(y0, T());
  drivers.forEach(x => { x.pay = Math.round(x.gross * (x.pay_pct || 0) / 100); });

  const expCats = db.db.prepare(
    `SELECT category, SUM(amount_cents) AS total FROM expenses
     WHERE tenant_id = ? AND date >= ? GROUP BY category ORDER BY total DESC`
  ).all(T(), y0);
  const expTrucks = db.db.prepare(
    `SELECT COALESCE(t.unit_number, (t.year || ' ' || t.make || ' ' || t.model), 'Unassigned') AS label,
      SUM(e.amount_cents) AS total
     FROM expenses e LEFT JOIN trucks t ON t.id = e.truck_id
     WHERE e.tenant_id = ? AND e.date >= ? GROUP BY e.truck_id ORDER BY total DESC`
  ).all(T(), y0);

  return {
    today: revenueBetween(today, today),
    week: revenueBetween(w0, w1),
    month, monthYm, months, monthExpenses,
    ytd, trucks, drivers, expCats, expTrucks,
  };
}

router.get('/dashboard', auth.requireRoles('owner', 'editor', 'viewer'), (req, res) => {
  res.send(v.dashboardPage(req.user, dashboardData(req.query.month)));
});

// ----- loads -----
router.get('/loads', auth.requireRoles('owner', 'editor', 'viewer'), (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  let loads = db.listLoads();
  if (month) {
    const [m0, m1] = D.monthRange(month);
    loads = loads.filter(l => l.date >= m0 && l.date <= m1);
  }
  res.send(v.loadsPage(req.user, loads, db.listDrivers(), db.listTrucks(), req.query, docCounts(T()), month));
});
router.get('/loads/new', auth.canEdit, (req, res) => {
  res.send(v.layout({ title: 'Add load', user: req.user, active: '/loads',
    body: v.loadForm({}, db.listDrivers(), db.listTrucks(), req.query, false) }));
});
router.post('/loads/new', auth.canEdit, express.urlencoded({ extended: false }), (req, res) => {
  const b = req.body;
  db.saveLoad({
    date: b.date, origin: b.origin, destination: b.destination,
    loaded_miles: toNum(b.loaded_miles), empty_miles: toNum(b.empty_miles),
    linehaul_cents: toCents(b.linehaul), fsc_cents: toCents(b.fsc),
    broker: b.broker, external_id: b.external_id,
    driver_id: b.driver_id || null, truck_id: b.truck_id || null,
    status: b.status, notes: b.notes,
  });
  res.redirect('/loads?ok=Load+saved.');
});
router.get('/loads/:id/edit', auth.canEdit, (req, res) => {
  const l = db.getLoad(req.params.id);
  if (!l) return res.status(404).send('Not found');
  res.send(v.layout({ title: 'Edit load', user: req.user, active: '/loads',
    body: v.loadForm(l, db.listDrivers(), db.listTrucks(), req.query, true) }));
});
router.post('/loads/:id/edit', auth.canEdit, express.urlencoded({ extended: false }), (req, res) => {
  const b = req.body;
  db.saveLoad({
    id: Number(req.params.id), date: b.date, origin: b.origin, destination: b.destination,
    loaded_miles: toNum(b.loaded_miles), empty_miles: toNum(b.empty_miles),
    linehaul_cents: toCents(b.linehaul), fsc_cents: toCents(b.fsc),
    broker: b.broker, driver_id: b.driver_id || null, truck_id: b.truck_id || null,
    status: b.status, notes: b.notes,
  });
  res.redirect('/loads?ok=Load+updated.');
});
router.post('/loads/:id/delete', auth.canEdit, (req, res) => {
  db.deleteLoad(req.params.id);
  res.redirect('/loads?ok=Load+deleted.');
});

// ----- load detail + documents (owner/editor/viewer) -----
function docCounts(tenantId) {
  const rows = db.db.prepare(
    'SELECT load_id, COUNT(*) AS c FROM documents WHERE tenant_id = ? GROUP BY load_id'
  ).all(tenantId);
  const m = {};
  for (const r of rows) m[r.load_id] = r.c;
  return m;
}

function loadDetailContext(id) {
  const load = db.getLoad(id);
  if (!load) return null;
  const drv = load.driver_id ? db.getDriver(load.driver_id) : null;
  const trk = load.truck_id ? db.getTruck(load.truck_id) : null;
  load.driver_name = drv ? drv.name : null;
  load.truck_label = trk
    ? (trk.unit_number || [trk.year, trk.make, trk.model].filter(Boolean).join(' '))
    : null;
  return { load, docs: db.listDocumentsByLoad(load.id) };
}

router.get('/loads/:id', auth.requireRoles('owner', 'editor', 'viewer'), (req, res) => {
  const ctx = loadDetailContext(req.params.id);
  if (!ctx) return res.status(404).send('Not found');
  res.send(v.loadDetailPage(req.user, ctx.load, ctx.docs, req.query));
});

router.post('/loads/:id/documents', auth.canEdit, (req, res) => {
  const load = db.getLoad(req.params.id);
  if (!load) return res.status(404).send('Load not found');
  uploadDocs(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'A file was over the 10MB limit.'
        : (err.message || 'Upload failed.');
      return res.redirect(`/loads/${load.id}?err=${encodeURIComponent(msg)}`);
    }
    if (!req.files || !req.files.length) {
      return res.redirect(`/loads/${load.id}?err=${encodeURIComponent('No files received — pick at least one file.')}`);
    }
    const docType = req.body.doc_type === 'pod' ? 'pod' : 'ratecon';
    for (const f of req.files) {
      db.createDocument({
        load_id: load.id,
        doc_type: docType,
        original_name: String(f.originalname).slice(0, 200),
        stored_path: f.path,
        mime: f.mimetype,
        size_bytes: f.size,
        uploaded_by: req.user.id,
      });
    }
    res.redirect(`/loads/${load.id}?ok=${encodeURIComponent(req.files.length + ' document(s) uploaded.')}`);
  });
});

router.post('/documents/:id/delete', auth.canEdit, (req, res) => {
  const doc = db.deleteDocument(req.params.id);
  if (!doc) return res.status(404).send('Not found');
  try { fs.unlinkSync(doc.stored_path); } catch (e) { /* already gone */ }
  res.redirect(`/loads/${doc.load_id}?ok=${encodeURIComponent('Document deleted.')}`);
});

// Staff view/download of a document (owner/editor/viewer). Auth + tenant
// scoping happen here; files are never served from a public directory.
router.get('/documents/:id', auth.requireRoles('owner', 'editor', 'viewer'), (req, res) => {
  const doc = db.getDocument(req.params.id);
  const load = doc && db.getLoad(doc.load_id);
  if (!doc || !load) return res.status(404).send('Not found');
  serveDocument(res, doc, { download: req.query.download === '1' });
});

// ----- expenses -----
router.get('/expenses', auth.requireRoles('owner', 'editor', 'viewer'), (req, res) => {
  res.send(v.expensesPage(req.user, db.listExpenses(), req.query));
});
router.get('/expenses/new', auth.canEdit, (req, res) => {
  res.send(v.layout({ title: 'Add expense', user: req.user, active: '/expenses',
    body: v.expenseForm({}, db.listTrucks(), req.query, false) }));
});
router.post('/expenses/new', auth.canEdit, express.urlencoded({ extended: false }), (req, res) => {
  const b = req.body;
  db.saveExpense({
    date: b.date, truck_id: b.truck_id || null, category: b.category,
    amount_cents: toCents(b.amount), notes: b.notes, external_id: b.external_id,
    gallons: b.gallons || null, fuel_state: b.fuel_state || null,
  });
  res.redirect('/expenses?ok=Expense+saved.');
});
router.get('/expenses/:id/edit', auth.canEdit, (req, res) => {
  const e = db.getExpense(req.params.id);
  if (!e) return res.status(404).send('Not found');
  res.send(v.layout({ title: 'Edit expense', user: req.user, active: '/expenses',
    body: v.expenseForm(e, db.listTrucks(), req.query, true) }));
});
router.post('/expenses/:id/edit', auth.canEdit, express.urlencoded({ extended: false }), (req, res) => {
  const b = req.body;
  db.saveExpense({
    id: Number(req.params.id), date: b.date, truck_id: b.truck_id || null,
    category: b.category, amount_cents: toCents(b.amount), notes: b.notes,
    gallons: b.gallons || null, fuel_state: b.fuel_state || null,
  });
  res.redirect('/expenses?ok=Expense+updated.');
});
router.post('/expenses/:id/delete', auth.canEdit, (req, res) => {
  db.deleteExpense(req.params.id);
  res.redirect('/expenses?ok=Expense+deleted.');
});

// ----- settlements (Fri–Thu weeks) -----
function settlementWeek(weekStart) {
  const [w0, w1] = D.weekRange(weekStart);
  const y0 = D.yearStart(w1);
  const rows = db.db.prepare(
    `SELECT d.id, d.name, d.pay_pct, d.pay_type, d.pay_rate,
      COUNT(l.id) AS loads,
      COALESCE(SUM(l.loaded_miles + l.empty_miles),0) AS miles,
      COALESCE(SUM(l.loaded_miles),0) AS loaded_miles,
      COALESCE(SUM(l.linehaul_cents + l.fsc_cents),0) AS gross,
      COALESCE((SELECT SUM(l2.linehaul_cents + l2.fsc_cents) FROM loads l2
        WHERE l2.tenant_id = d.tenant_id AND l2.driver_id = d.id AND l2.date >= ?),0) AS ytd_gross,
      COALESCE((SELECT SUM(l2.loaded_miles) FROM loads l2
        WHERE l2.tenant_id = d.tenant_id AND l2.driver_id = d.id AND l2.date >= ?),0) AS ytd_loaded_miles,
      COALESCE((SELECT COUNT(*) FROM loads l3
        WHERE l3.tenant_id = d.tenant_id AND l3.driver_id = d.id AND l3.date >= ?),0) AS ytd_loads
    FROM drivers d LEFT JOIN loads l
      ON l.driver_id = d.id AND l.tenant_id = d.tenant_id AND l.date >= ? AND l.date <= ?
    WHERE d.tenant_id = ? AND d.status = 'active'
    GROUP BY d.id ORDER BY d.name`
  ).all(y0, y0, y0, w0, w1, T());
  rows.forEach(r => {
    if (r.pay_type === 'per_mile' && Number(r.pay_rate) > 0) {
      r.pay = Math.round(r.loaded_miles * r.pay_rate * 100);       // cents
      r.ytd_pay = Math.round(r.ytd_loaded_miles * r.pay_rate * 100);
      r.pay_basis = `$${Number(r.pay_rate).toFixed(2)}/mi × ${fmtNum(r.loaded_miles)} mi`;
    } else {
      r.pay = Math.round(r.gross * (r.pay_pct || 0) / 100);
      r.ytd_pay = Math.round(r.ytd_gross * (r.pay_pct || 0) / 100);
      r.pay_basis = `${r.pay_pct || 0}% of gross`;
    }
    r.escrow_withheld = db.escrowWithheld(r.id, w0, w1, T());
    r.escrow_balance = db.escrowBalance(r.id, T());
  });
  return rows;
}

function recentWeekStarts(n = 26) {
  const out = [];
  let ws = D.weekStartOf(D.todayStr());
  for (let i = 0; i < n; i++) { out.push(ws); ws = D.addDaysStr(ws, -7); }
  return out;
}

router.get('/settlements', auth.requireRoles('owner', 'editor', 'viewer'), (req, res) => {
  let week = req.query.week || D.weekStartOf(D.todayStr());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) week = D.weekStartOf(D.todayStr());
  res.send(v.settlementsPage(req.user, week, recentWeekStarts(), settlementWeek(week), req.query));
});

// ---------- performance report + fuel dashboard (owner/editor/viewer) ----------
function reportPresets() {
  const today = D.todayStr();
  return [
    { label: 'This month', from: today.slice(0, 7) + '-01', to: today },
    { label: 'Last 30 days', from: D.addDaysStr(today, -29), to: today },
    { label: 'Last 90 days', from: D.addDaysStr(today, -89), to: today },
    { label: 'Year to date', from: D.yearStart(today), to: today },
    { label: 'All time', from: '2024-01-01', to: today },
  ];
}

router.get('/performance', auth.requireRoles('owner', 'editor', 'viewer'), (req, res) => {
  const d = perf.performanceReport(req.query);
  res.send(v.performancePage(req.user, d, req.query, db.listDrivers(), db.listTrucks(), reportPresets()));
});

router.get('/fuel-dashboard', auth.requireRoles('owner', 'editor', 'viewer'), (req, res) => {
  const d = perf.fuelDashboard(req.query);
  res.send(v.fuelDashboardPage(req.user, d, req.query, reportPresets()));
});

// ----- drivers -----
router.get('/drivers', auth.canEdit, (req, res) => {
  const drivers = db.listDrivers().map(d => ({ ...d, escrow_balance: db.escrowBalance(d.id) }));
  res.send(v.driversPage(req.user, drivers, req.query));
});
router.get('/drivers/new', auth.canEdit, (req, res) => {
  res.send(v.layout({ title: 'Add driver', user: req.user, active: '/drivers',
    body: v.driverForm({}, req.query, false) }));
});
router.post('/drivers/new', auth.canEdit, express.urlencoded({ extended: false }), (req, res) => {
  const b = req.body;
  db.saveDriver({ name: b.name.trim(), phone: b.phone, pay_pct: toNum(b.pay_pct, 30),
    pay_type: b.pay_type, pay_rate: toNum(b.pay_rate, null),
    status: b.status, notes: b.notes });
  res.redirect('/drivers?ok=Driver+added.');
});
router.get('/drivers/:id/edit', auth.canEdit, (req, res) => {
  const d = db.getDriver(req.params.id);
  if (!d) return res.status(404).send('Not found');
  res.send(v.layout({ title: 'Edit driver', user: req.user, active: '/drivers',
    body: v.driverForm(d, req.query, true) }));
});
router.post('/drivers/:id/edit', auth.canEdit, express.urlencoded({ extended: false }), (req, res) => {
  const b = req.body;
  db.saveDriver({ id: Number(req.params.id), name: b.name.trim(), phone: b.phone,
    pay_pct: toNum(b.pay_pct, 30), pay_type: b.pay_type, pay_rate: toNum(b.pay_rate, null),
    status: b.status, notes: b.notes });
  res.redirect('/drivers?ok=Driver+updated.');
});

// ----- driver escrow ledger -----
router.get('/drivers/:id/escrow', auth.canEdit, (req, res) => {
  const d = db.getDriver(Number(req.params.id));
  if (!d) return res.status(404).send('Driver not found');
  res.send(v.escrowPage(req.user, d, db.listEscrowEntries(d.id), db.escrowBalance(d.id), req.query));
});
router.post('/drivers/:id/escrow', auth.canEdit, express.urlencoded({ extended: false }), (req, res) => {
  const id = Number(req.params.id);
  const d = db.getDriver(id);
  if (!d) return res.status(404).send('Driver not found');
  const b = req.body;
  const type = ['withholding', 'deduction', 'release', 'adjustment'].includes(b.entry_type) ? b.entry_type : 'withholding';
  let cents = Math.round(Number(b.amount) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return res.redirect(`/drivers/${id}/escrow?err=Enter+a+positive+amount.`);
  if (type === 'deduction' || type === 'release') cents = -cents;   // draw the balance down
  db.createEscrowEntry({ driver_id: id, date: b.date || D.todayStr(), amount_cents: cents,
    entry_type: type, notes: (b.notes || '').trim() || null });
  res.redirect(`/drivers/${id}/escrow?ok=Escrow+entry+recorded.`);
});
// one-click $100 weekly withholding for every active driver
router.post('/escrow/withhold-weekly', auth.canEdit, express.urlencoded({ extended: false }), (req, res) => {
  const date = req.body.date || D.todayStr();
  const drivers = db.listDrivers().filter(d => d.status === 'active');
  let n = 0;
  for (const d of drivers) {
    db.createEscrowEntry({ driver_id: d.id, date, amount_cents: 10000,
      entry_type: 'withholding', notes: 'Weekly $100 escrow withholding' });
    n++;
  }
  res.redirect(`/settlements?ok=${n}+drivers+withheld+$100+escrow.`);
});

// ----- trucks -----
router.get('/trucks', auth.canEdit, (req, res) => {
  res.send(v.trucksPage(req.user, db.listTrucks(), req.query));
});
router.get('/trucks/new', auth.canEdit, (req, res) => {
  res.send(v.layout({ title: 'Add unit', user: req.user, active: '/trucks',
    body: v.truckForm({ type: 'tractor' }, req.query, false) }));
});
router.post('/trucks/new', auth.canEdit, express.urlencoded({ extended: false }), (req, res) => {
  const b = req.body;
  db.saveTruck({ unit_number: b.unit_number, year: toNum(b.year) || null, make: b.make,
    model: b.model, vin: b.vin, type: b.type, trailer_desc: b.trailer_desc,
    status: b.status, notes: b.notes });
  res.redirect('/trucks?ok=Unit+added.');
});
router.get('/trucks/:id/edit', auth.canEdit, (req, res) => {
  const t = db.getTruck(req.params.id);
  if (!t) return res.status(404).send('Not found');
  res.send(v.layout({ title: 'Edit unit', user: req.user, active: '/trucks',
    body: v.truckForm(t, req.query, true) }));
});
router.post('/trucks/:id/edit', auth.canEdit, express.urlencoded({ extended: false }), (req, res) => {
  const b = req.body;
  db.saveTruck({ id: Number(req.params.id), unit_number: b.unit_number,
    year: toNum(b.year) || null, make: b.make, model: b.model, vin: b.vin,
    type: b.type, trailer_desc: b.trailer_desc, status: b.status, notes: b.notes });
  res.redirect('/trucks?ok=Unit+updated.');
});

// ----- users + API keys (owner) -----
router.get('/users', auth.ownerOnly, (req, res) => {
  res.send(v.usersPage(req.user, db.listUsers(), db.listDrivers(), req.query, req.query.key));
});
router.post('/users/new', auth.ownerOnly, express.urlencoded({ extended: false }), (req, res) => {
  const b = req.body;
  const email = String(b.email || '').trim().toLowerCase();
  const role = b.role;
  if (!email.includes('@') || !['owner', 'editor', 'viewer', 'driver'].includes(role)) {
    return res.redirect('/users?err=Check+the+form.');
  }
  if (role === 'driver' && !b.driver_id) {
    return res.redirect('/users?err=Pick+the+driver+this+login+belongs+to.');
  }
  if (db.findUserByEmail(T(), email)) {
    return res.redirect('/users?err=That+email+already+has+a+login.');
  }
  db.createUser({
    email, passwordHash: auth.hashPassword(String(b.password || '')),
    role, driverId: b.driver_id || null,
  });
  res.redirect('/users?ok=Login+created.');
});
router.post('/users/:id/toggle', auth.ownerOnly, (req, res) => {
  const u = db.findUserById(req.params.id);
  if (u && u.id !== req.user.id) db.setUserActive(u.id, !u.active);
  res.redirect('/users');
});
router.post('/api-keys', auth.ownerOnly, express.urlencoded({ extended: false }), (req, res) => {
  const key = db.createApiKey(T(), String(req.body.name || 'sync').slice(0, 60));
  res.redirect('/users?key=' + encodeURIComponent(key) + '&ok=Key+created+-+copy+it+now.');
});
router.post('/api-keys/:id/delete', auth.ownerOnly, (req, res) => {
  db.deleteApiKey(req.params.id, T());
  res.redirect('/api-docs?ok=Key+deleted.');
});
router.get('/api-docs', auth.ownerOnly, (req, res) => {
  res.send(v.apiDocsPage(req.user, db.listApiKeys(), req.query));
});

// ----- driver self-service (driver role only; own data enforced) -----
function driverStats(driverId) {
  const drv = db.getDriver(driverId);
  const today = D.todayStr();
  const ws = D.weekStartOf(today);
  const [w0, w1] = D.weekRange(ws);
  const y0 = D.yearStart(today);
  const week = revenueBetween(w0, w1, driverId);
  const ytd = revenueBetween(y0, today, driverId);
  const payPct = (drv && drv.pay_pct) || 0;
  const recent = db.listLoads(T(), { driverId, limit: 10 });
  const openLoads = db.listLoads(T(), { driverId, limit: 50 })
    .filter(l => l.status === 'booked' || l.status === 'in_transit');
  return {
    weekStart: ws,
    week: { ...week, pay: Math.round(week.revenue * payPct / 100) },
    ytd: { ...ytd, pay: Math.round(ytd.revenue * payPct / 100) },
    recent, payPct,
    trip: db.activeTrip(driverId, T()),
    openLoads,
  };
}

router.get('/driver', auth.requireRoles('driver'), (req, res) => {
  if (!req.user.driver_id) return res.status(403).send('No driver linked to this login.');
  res.send(v.driverHome(req.user, driverStats(req.user.driver_id)));
});
router.get('/driver/loads', auth.requireRoles('driver'), (req, res) => {
  if (!req.user.driver_id) return res.status(403).send('No driver linked to this login.');
  res.send(v.driverLoads(req.user, db.listLoads(T(), { driverId: req.user.driver_id })));
});
router.get('/driver/settlements', auth.requireRoles('driver'), (req, res) => {
  if (!req.user.driver_id) return res.status(403).send('No driver linked to this login.');
  const drv = db.getDriver(req.user.driver_id);
  const perMile = drv && drv.pay_type === 'per_mile' && Number(drv.pay_rate) > 0;
  const payPct = (drv && drv.pay_pct) || 0;
  const weeks = recentWeekStarts(26).map(weekStart => {
    const [w0, w1] = D.weekRange(weekStart);
    const r = revenueBetween(w0, w1, req.user.driver_id);
    const pay = perMile
      ? Math.round(r.loaded_miles * drv.pay_rate * 100)
      : Math.round(r.revenue * payPct / 100);
    return { weekStart, loads: r.loads, miles: r.miles, gross: r.revenue, pay,
      pay_basis: perMile ? `$${Number(drv.pay_rate).toFixed(2)}/mi` : `${payPct}%`,
      escrow_withheld: db.escrowWithheld(req.user.driver_id, w0, w1) };
  }).filter(w => w.loads > 0);
  const escrow_balance = db.escrowBalance(req.user.driver_id);
  res.send(v.driverSettlements(req.user, weeks, escrow_balance));
});

// ----- live trip tracking (driver phone GPS) -----
// Driver starts a trip; the phone posts positions while the page is open.
router.post('/driver/trip/start', auth.requireRoles('driver'), express.urlencoded({ extended: false }), (req, res) => {
  if (!req.user.driver_id) return res.status(403).send('No driver linked to this login.');
  const loadId = req.body.load_id ? Number(req.body.load_id) : null;
  const id = db.startTrip(req.user.driver_id, loadId, T());
  res.redirect('/driver?ok=Trip+started.+Keep+this+page+open+while+driving.');
});
router.post('/driver/trip/end', auth.requireRoles('driver'), express.urlencoded({ extended: false }), (req, res) => {
  if (!req.user.driver_id) return res.status(403).send('No driver linked to this login.');
  db.endTrip(req.user.driver_id, T());
  res.redirect('/driver?ok=Trip+ended.');
});
router.post('/driver/position', auth.requireRoles('driver'), express.json(), (req, res) => {
  if (!req.user.driver_id) return res.status(403).json({ ok: false });
  const b = req.body || {};
  // Phones report speed in meters/second; store mph.
  const mph = b.speed != null && Number.isFinite(Number(b.speed)) ? Number(b.speed) * 2.23694 : null;
  const id = db.addPosition(req.user.driver_id,
    { lat: b.lat, lon: b.lon, accuracy: b.accuracy, speed: mph, heading: b.heading }, T());
  res.json({ ok: !!id });
});

// ----- rate-con upload (loads not on Erica's sheet) -----
const rateconTmp = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOAD_DIR, 'ratecon_tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = ALLOWED_DOCS[file.mimetype] ||
      ALLOWED_EXTS.find(e => e === path.extname(file.originalname).toLowerCase()) || '.bin';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});
const uploadRatecon = multer({
  storage: rateconTmp, fileFilter: docFileFilter, limits: { fileSize: MAX_FILE_BYTES },
});
router.get('/ratecon', auth.requireRoles('owner', 'editor'), (req, res) => {
  res.send(v.rateconPage(req.user, db.listDrivers(T()), req.query, {}, null));
});

// Step 1 of the upload flow: read the file, fill the form from it. The file
// is kept in ratecon_tmp and carried through as a hidden field, so the save
// step still attaches it to the load. Typed values win over parsed ones.
router.post('/ratecon/parse', auth.requireRoles('owner', 'editor'),
  uploadRatecon.single('ratecon'), async (req, res) => {
  const b = req.body || {};
  if (!req.file) return res.redirect('/ratecon?err=Pick+the+rate+con+file+first.');
  const values = {
    load_number: b.load_number || '', driver_id: b.driver_id || '',
    date: b.date || '', delivery_date: b.delivery_date || '',
    origin: b.origin || '', destination: b.destination || '',
    loaded_miles: b.loaded_miles || '', empty_miles: b.empty_miles || '',
    linehaul: b.linehaul || '', fsc: b.fsc || '', broker: b.broker || '',
    status: b.status || 'booked',
  };
  let parsed = { filled: [], fileName: req.file.originalname,
    parsed_file: path.basename(req.file.path), parsed_name: req.file.originalname, note: null };
  try {
    if (/\.pdf$/i.test(req.file.originalname) || req.file.mimetype === 'application/pdf') {
      const pdf = require('pdf-parse');
      const data = await pdf(fs.readFileSync(req.file.path));
      const out = RC.parseRateconText(data.text);
      for (const [k, v] of Object.entries(out.fields)) {
        if (!values[k]) values[k] = v;
      }
      parsed.filled = out.filled;
      if (!out.filled.length) parsed.note = 'Could not read any fields from this PDF — fill in by hand below. The file is still kept for the save step.';
    } else {
      parsed.note = 'Photos and images cannot be read automatically — fill in by hand below. The file is still kept for the save step.';
    }
  } catch (e) {
    parsed.note = 'Could not read this file — fill in by hand below. The file is still kept for the save step.';
  }
  res.send(v.rateconPage(req.user, db.listDrivers(T()), req.query, values, parsed));
});

router.post('/ratecon', auth.requireRoles('owner', 'editor'),
  uploadRatecon.single('ratecon'), (req, res) => {
  const b = req.body || {};
  const loadNumber = String(b.load_number || '').trim();
  if (!loadNumber) return res.redirect('/ratecon?err=Load+number+is+required.');
  if (!req.file && !b.parsed_file) return res.redirect('/ratecon?err=Attach+the+rate+con+file.');
  const loadedMiles = Number(b.loaded_miles) || 0;
  let linehaulC = toCents(b.linehaul);
  let fscC = b.fsc === '' || b.fsc == null ? null : toCents(b.fsc);
  // 65c fallback: blank FSC + miles + a stated total -> carve FSC out of the total.
  if (fscC == null && loadedMiles > 0 && linehaulC > 0) {
    fscC = Math.min(Math.round(loadedMiles * 0.65 * 100), linehaulC);
    linehaulC -= fscC;
  }
  const r = db.upsertLoad({
    external_id: 'load-' + loadNumber,
    date: b.date || D.todayStr(),
    origin: b.origin || null, destination: b.destination || null,
    loaded_miles: loadedMiles, empty_miles: Number(b.empty_miles) || 0,
    linehaul_cents: linehaulC, fsc_cents: fscC || 0,
    broker: b.broker || null,
    driver_id: b.driver_id ? Number(b.driver_id) : null,
    status: b.status || 'booked',
    notes: b.delivery_date ? ('Deliver ' + b.delivery_date) : null,
  }, T());
  if (req.file) {
    const dir = path.join(UPLOAD_DIR, 'load_' + r.id);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(req.file.path));
    fs.renameSync(req.file.path, dest);
    db.createDocument({
      load_id: r.id, doc_type: 'ratecon',
      original_name: req.file.originalname,
      stored_path: path.join('load_' + r.id, path.basename(dest)),
      mime: req.file.mimetype, size_bytes: req.file.size,
      uploaded_by: req.user.id,
    }, T());
  } else if (b.parsed_file && /^[A-Za-z0-9._-]+$/.test(b.parsed_file)) {
    // File carried over from the "Read rate con" step.
    const tmpPath = path.join(UPLOAD_DIR, 'ratecon_tmp', b.parsed_file);
    if (fs.existsSync(tmpPath)) {
      const dir = path.join(UPLOAD_DIR, 'load_' + r.id);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, b.parsed_file);
      fs.renameSync(tmpPath, dest);
      const ext = path.extname(b.parsed_name || '').toLowerCase();
      db.createDocument({
        load_id: r.id, doc_type: 'ratecon',
        original_name: b.parsed_name || b.parsed_file,
        stored_path: path.join('load_' + r.id, b.parsed_file),
        mime: ext === '.pdf' ? 'application/pdf' : 'application/octet-stream',
        size_bytes: fs.statSync(dest).size,
        uploaded_by: req.user.id,
      }, T());
    }
  }
  res.redirect('/loads/' + r.id + (r.updated ? '?ok=Load+updated+with+rate+con.' : '?ok=Load+created+from+rate+con.'));
});

// ----- fleet map (owner/editor) -----
router.get('/fleet', auth.requireRoles('owner', 'editor'), (req, res) => {
  res.send(v.fleetPage(req.user));
});
router.get('/fleet/data', auth.requireRoles('owner', 'editor'), (req, res) => {
  res.json({ ok: true, trips: db.fleetSnapshot(T()) });
});

// ----- fuel discounts (RXO feed): best stops near a location -----
router.get('/fuel/near', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: 'Not signed in.' });
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  const radius = Math.min(Math.max(Number(req.query.radius) || 60, 5), 150);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ ok: false, error: 'Bad coordinates.' });
  }
  const info = db.fuelFeedInfo(T());
  if (!info.count) return res.json({ ok: true, feed_date: null, stops: [] });
  const stops = db.nearestFuelStops(lat, lon, radius, 5, T());
  res.json({ ok: true, feed_date: info.feed_date, stops });
});

router.get('/fuel', auth.requireRoles('owner', 'editor'), (req, res) => {
  const info = db.fuelFeedInfo(T());
  const trucks = db.fleetSnapshot(T())
    .filter(t => t.lat != null && t.lon != null)
    .map(t => ({ ...t, stops: db.nearestFuelStops(t.lat, t.lon, 60, 3, T()) }));
  res.send(v.fuelPage(req.user, info, trucks, req.query));
});

const fuelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });router.post('/fuel/upload', auth.requireRoles('owner', 'editor'), fuelUpload.single('feed'), (req, res) => {
  if (!req.file) return res.redirect('/fuel?err=' + encodeURIComponent('No file chosen.'));
  let XLSX;
  try { XLSX = require('xlsx'); } catch (e) {
    return res.redirect('/fuel?err=' + encodeURIComponent('Spreadsheet parser unavailable on the server.'));
  }
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  } catch (e) {
    return res.redirect('/fuel?err=' + encodeURIComponent('Could not read that spreadsheet.'));
  }
  const { geocodeCity } = require('./geocode');
  const stops = [];
  let feedDate = null, skipped = 0;
  for (const r of rows) {
    const name = String(r.TSName || r.Name || '').trim();
    const city = String(r.City || '').trim();
    const state = String(r.State || '').trim().toUpperCase();
    const pump = Number(r.PumpPrice), price = Number(r.CustomerPrice);
    if (!name || !state || !Number.isFinite(pump) || !Number.isFinite(price)) { skipped++; continue; }
    const ll = geocodeCity(city, state);
    if (!ll) { skipped++; continue; }
    const sav = Number(r.Savings);
    stops.push({
      name, location: String(r.Location || '').trim(), city, state,
      pump, price, savings: Number.isFinite(sav) ? sav : Math.round((pump - price) * 10000) / 10000,
      lat: ll[0], lon: ll[1],
    });
    let d = null;
    if (r.Date instanceof Date && !isNaN(r.Date)) d = r.Date;
    else if (Number.isFinite(Number(r.Date)) && Number(r.Date) > 20000) {
      d = new Date(Date.UTC(1899, 11, 30) + Number(r.Date) * 86400000); // Excel serial
    }
    if (d) feedDate = d.toISOString().slice(0, 10);
  }
  if (!stops.length) {
    return res.redirect('/fuel?err=' + encodeURIComponent('No usable stops found in that file — nothing was changed.'));
  }
  if (!feedDate) feedDate = new Date().toISOString().slice(0, 10);
  const n = db.replaceFuelStops(stops, feedDate, 'RXO price feed (uploaded)', T());
  res.redirect('/fuel?ok=' + encodeURIComponent(
    `Fuel feed updated: ${n} stops priced as of ${feedDate}${skipped ? ` (${skipped} rows skipped — unrecognized place or bad data)` : ''}.`));
});

// ----- load analyzer (owner/editor) -----
router.get('/analyzer', auth.requireRoles('owner', 'editor'), (req, res) => {
  res.send(v.analyzerPage(req.user, db.listDrivers(), req.query));
});

router.get('/analyzer/data', auth.requireRoles('owner', 'editor'), async (req, res) => {
  const q = req.query;
  const driver = q.driver_id ? db.getDriver(Number(q.driver_id)) : null;
  const ctx = {
    driver: driver || null,
    fuelNear: (lat, lon) => db.nearestFuelStops(lat, lon, 60, 1, T())[0] || null,
    historyLoads: db.deliveredLoadsLite(T()),
  };
  const out = await AZ.analyze({
    origin: q.origin, destination: q.destination, rate: q.rate,
    truckFrom: q.truckFrom, deadheadOverride: q.deadheadOverride,
    mpg: q.mpg, fuelPrice: q.fuelPrice, fixedPerDay: q.fixedPerDay,
    backhaulRate: q.backhaulRate, pickupDate: q.pickupDate, deliveryDate: q.deliveryDate,
  }, ctx);
  res.json(out);
});

router.post('/analyzer/create', auth.requireRoles('owner', 'editor'),
  express.urlencoded({ extended: false }), (req, res) => {
    const b = req.body;
    const id = db.saveLoad({
      date: b.date || new Date().toISOString().slice(0, 10),
      origin: b.origin || null, destination: b.destination || null,
      loaded_miles: Number(b.loaded_miles) || 0, empty_miles: Number(b.empty_miles) || 0,
      linehaul_cents: Math.round((Number(b.linehaul) || 0) * 100),
      fsc_cents: Math.round((Number(b.fsc) || 0) * 100),
      broker: b.broker || null,
      driver_id: b.driver_id ? Number(b.driver_id) : null,
      truck_id: null, status: 'booked',
      notes: b.notes || 'Created from Load Analyzer.',
    }, T());
    res.redirect(`/loads/${id}?ok=` + encodeURIComponent('Load created from analyzer.'));
  });

// Driver load detail — own loads only, with their documents.
router.get('/driver/loads/:id', auth.requireRoles('driver'), (req, res) => {
  if (!req.user.driver_id) return res.status(403).send('No driver linked to this login.');
  const load = db.getLoad(req.params.id);
  if (!load || load.driver_id !== req.user.driver_id) {
    return res.status(404).send('Not found');
  }
  res.send(v.driverLoadDetail(req.user, load, db.listDocumentsByLoad(load.id)));
});

// Driver document view/download — ONLY documents on the driver's own loads.
// 404 (not 403) so one driver can never confirm another driver's docs exist.
router.get('/driver/documents/:id', auth.requireRoles('driver'), (req, res) => {
  if (!req.user.driver_id) return res.status(403).send('No driver linked to this login.');
  const doc = db.getDocument(req.params.id);
  const load = doc && db.getLoad(doc.load_id);
  if (!doc || !load || load.driver_id !== req.user.driver_id) {
    return res.status(404).send('Not found');
  }
  serveDocument(res, doc, { download: req.query.download === '1' });
});

module.exports = router;
