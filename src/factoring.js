// factoring.js — RTS factoring inside the TMS (FACTORING-DESIGN.md, Phase A).
//
// Lifecycle: delivered load + POD attached -> invoice auto-drafts -> owner
// approves (draft -> ready) -> owner submits an account batch (ready ->
// submitted) -> purchased/funded/held recorded as RTS reports them.
//
// PHASE A HONESTY: there is NO programmatic RTS submission path in our
// tooling — RTS is operated through its web portal. "Submit batch" here
// therefore does two real things and nothing fake: (1) it produces the
// complete RTS-ready submission packet (account, PO #, invoice, rate con +
// POD checklist, the standard note) on the confirm screen, and (2) it
// records the invoices as submitted once the owner confirms the portal
// submission was made. Status after that (purchased/funded/held) is
// recorded manually or via POST /api/v1/factoring/upsert. Nothing in this
// module talks to RTS.
//
// Money is INTEGER cents. This module never touches src/pay.js; the
// settlement link is read-only (loads.settlement_id -> `advanced` flag).

'use strict';

const db = require('./db');

const T = () => db.TENANT;

const NOTE_TEXT = 'All paperwork have been uploaded.';
const DEFAULT_PAYOUT = 'Standard ACH to PNC ••••6335'; // Tree's standing choice (Nov 24–26, 2026 filings)
const ACCOUNTS = {
  QAP: { code: 'QAP', label: 'QAP W/ TQL', member: '168612QAP' },
  NONRECOURSE: { code: 'NONRECOURSE', label: 'NONRECOURSE', member: '168612NONREC' },
};

// Merlin-side factoring covers Parker + Thompson loads only; Erica factors
// her own bookings (standing scope rule). Other drivers' invoices stay
// visible on the board but are excluded from the submit queue.
const MERLIN_DRIVER_NAMES = ['michael parker', 'jerimiah thompson'];
function scopeForDriverName(name) {
  return MERLIN_DRIVER_NAMES.includes(String(name || '').trim().toLowerCase())
    ? 'merlin' : 'other';
}

// ---- account + PO rules (hard-coded in v1, per design) ----
function accountForBroker(broker) {
  const b = String(broker || '').toLowerCase();
  // ONLY TQL goes to QAP. Everything else — incl. C.H. Robinson — NONRECOURSE.
  if (/\btql\b/.test(b) || b.includes('total quality logistics')) return 'QAP';
  return 'NONRECOURSE';
}

// The load number as brokers/factors know it: external_id minus the
// 'load-' prefix the sync uses; falls back to the TMS id.
function loadNumber(load) {
  const ext = String(load.external_id || '').trim();
  if (ext) return ext.replace(/^load-/i, '');
  return String(load.id);
}

function isArmada(broker) {
  return String(broker || '').toLowerCase().includes('armada');
}
function isSpot(broker) {
  return String(broker || '').toLowerCase().includes('spot');
}

// PO # suggestion per the design: TQL -> the load number; Armada -> the
// return LoadID printed on the POD (not stored in the TMS, so null — it is
// entered at draft review); Spot -> the con's PO # (also not stored
// structured, so null). Null means "must be entered before approval".
function suggestedPo(load) {
  if (accountForBroker(load.broker) === 'QAP') return loadNumber(load);
  return null;
}

// ---- RTS Amendment #2 fee math ----
// Tiers by prior-30-day PURCHASED volume. The amendment's lower tiers run
// "up to 3.75%"; below $50K/mo we use that worst-case 3.75% so the
// expected fee never understates. QAP debtors pay the lesser of the tier
// or 2.00%. Prime adder = US Prime − 6.75% (floored at 0), applied to both.
function getPrimeRate() {
  const v = Number(db.getMeta('us_prime_rate'));
  return Number.isFinite(v) && v > 0 ? v : 7.00; // 7.00% at Amendment #2 signing
}
function setPrimeRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 30) return null;
  db.setMeta('us_prime_rate', n.toFixed(2));
  return n;
}
function primeAdderPct() {
  return Math.max(0, getPrimeRate() - 6.75);
}
function tierRatePct(volumeCents) {
  const v = volumeCents || 0;
  if (v >= 15000000) return 1.85;
  if (v >= 10000000) return 2.00;
  if (v >= 5000000) return 2.25;
  return 3.75;
}
function effectiveRatePct(account, volumeCents) {
  const tier = tierRatePct(volumeCents);
  const base = account === 'QAP' ? Math.min(tier, 2.00) : tier;
  return Math.round((base + primeAdderPct()) * 10000) / 10000;
}
function expectedFeeCents(amountCents, account, volumeCents) {
  return Math.round((amountCents || 0) * effectiveRatePct(account, volumeCents) / 100);
}

// Purchased volume in the 30 days before `asOf` (YYYY-MM-DD): invoices RTS
// has bought (status purchased/funded with a purchased_at stamp). Uses the
// funded amount when recorded, else the invoice amount.
function prior30PurchasedVolumeCents(tenantId = T(), asOf = null) {
  const row = db.db.prepare(
    `SELECT COALESCE(SUM(COALESCE(funded_cents, amount_cents)), 0) AS v
     FROM factoring_invoices
     WHERE tenant_id = ? AND purchased_at IS NOT NULL
       AND date(purchased_at) > date(COALESCE(?, 'now'), '-30 days')
       AND date(purchased_at) <= date(COALESCE(?, 'now'))`
  ).get(tenantId, asOf, asOf);
  return row ? row.v : 0;
}

// ---- documents on a load (the packet checklist) ----
function loadDocs(loadId, tenantId = T()) {
  const rows = db.db.prepare(
    'SELECT doc_type, COUNT(*) AS n FROM documents WHERE tenant_id = ? AND load_id = ? GROUP BY doc_type'
  ).all(tenantId, loadId);
  const by = {};
  for (const r of rows) by[r.doc_type] = r.n;
  return { ratecon: (by.ratecon || 0) > 0, pod: (by.pod || 0) > 0,
    rateconCount: by.ratecon || 0, podCount: by.pod || 0 };
}

function invoiceAmountCents(load) {
  return (load.linehaul_cents || 0) + (load.fsc_cents || 0)
    + (load.detention_cents || 0) + (load.accessorial_cents || 0);
}

// Create the draft invoice for a delivered load if none exists. With
// requirePod (the automatic hook) a POD document must be attached first —
// a pickup BOL is not a delivery POD, and RTS cannot take the invoice
// without one. The Finance agent's approved drafts pass requirePod:false;
// the board's checklist still flags the missing POD before approval.
// Idempotent via UNIQUE(tenant_id, load_id).
function createDraftForLoad(load, { tenantId = T(), requirePod = true } = {}) {
  if (!load || load.status !== 'delivered') return null;
  const existing = getInvoiceByLoad(load.id, tenantId);
  if (existing) return existing;
  const docs = loadDocs(load.id, tenantId);
  if (requirePod && !docs.pod) return null;
  const account = accountForBroker(load.broker);
  const amount = invoiceAmountCents(load);
  const vol = prior30PurchasedVolumeCents(tenantId);
  const r = db.db.prepare(
    `INSERT INTO factoring_invoices
       (tenant_id, load_id, invoice_number, broker, account, po_number,
        amount_cents, status, payout_method, expected_fee_cents, advanced)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(tenantId, load.id, loadNumber(load), load.broker || null, account,
    suggestedPo(load), amount, 'draft', DEFAULT_PAYOUT,
    expectedFeeCents(amount, account, vol),
    load.settlement_id ? 1 : 0);
  return getInvoice(r.lastInsertRowid, tenantId);
}

// Auto-draft hook: call after a load is saved delivered or a document is
// uploaded. Never throws into the caller's flow.
function ensureDraftOnDelivery(loadId, tenantId = T()) {
  try {
    const load = db.getLoad(loadId, tenantId);
    if (!load || load.status !== 'delivered' || !load.delivery_date) return null;
    return createDraftForLoad(load, { tenantId, requirePod: true });
  } catch (e) { return null; }
}

function getInvoice(id, tenantId = T()) {
  return db.db.prepare(
    `SELECT fi.*, l.date AS load_date, l.delivery_date, l.origin, l.destination,
       l.external_id, l.settlement_id, d.name AS driver_name
     FROM factoring_invoices fi
     JOIN loads l ON l.id = fi.load_id
     LEFT JOIN drivers d ON d.id = l.driver_id
     WHERE fi.id = ? AND fi.tenant_id = ?`).get(id, tenantId) || null;
}
function getInvoiceByLoad(loadId, tenantId = T()) {
  return db.db.prepare(
    'SELECT * FROM factoring_invoices WHERE tenant_id = ? AND load_id = ?')
    .get(tenantId, loadId) || null;
}
function listInvoices(tenantId = T(), status = null) {
  const base = `SELECT fi.*, l.date AS load_date, l.delivery_date, l.origin,
      l.destination, l.external_id, d.name AS driver_name
    FROM factoring_invoices fi
    JOIN loads l ON l.id = fi.load_id
    LEFT JOIN drivers d ON d.id = l.driver_id
    WHERE fi.tenant_id = ?`;
  const rows = status
    ? db.db.prepare(base + ' AND fi.status = ? ORDER BY fi.created_at DESC').all(tenantId, status)
    : db.db.prepare(base + ' ORDER BY fi.created_at DESC').all(tenantId);
  for (const r of rows) r.scope = scopeForDriverName(r.driver_name);
  return rows;
}

// Delivered loads with no POD attached and no invoice yet — the same-day
// missing-POD flag list (Tree's rule: flag it the day it delivers).
function missingPodLoads(tenantId = T()) {
  const rows = db.db.prepare(
    `SELECT l.*, d.name AS driver_name FROM loads l
     LEFT JOIN drivers d ON d.id = l.driver_id
     WHERE l.tenant_id = ? AND l.status = 'delivered'
       AND NOT EXISTS (SELECT 1 FROM documents doc
         WHERE doc.tenant_id = l.tenant_id AND doc.load_id = l.id AND doc.doc_type = 'pod')
       AND NOT EXISTS (SELECT 1 FROM factoring_invoices fi
         WHERE fi.tenant_id = l.tenant_id AND fi.load_id = l.id)
     ORDER BY l.delivery_date DESC, l.id DESC`).all(tenantId);
  for (const r of rows) r.scope = scopeForDriverName(r.driver_name);
  return rows;
}

function boardData(tenantId = T()) {
  const all = listInvoices(tenantId);
  const by = (s) => all.filter(i => i.status === s);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  return {
    drafts: by('draft'),
    ready: by('ready'),
    submitted: by('submitted'),
    purchased: by('purchased'),
    held: by('held'),
    fundedThisWeek: by('funded').filter(i => (i.funded_at || '') >= weekAgo),
    missingPod: missingPodLoads(tenantId),
    volume30: prior30PurchasedVolumeCents(tenantId),
    primeRate: getPrimeRate(),
  };
}

function setPo(id, po, tenantId = T()) {
  const inv = getInvoice(id, tenantId);
  if (!inv) return null;
  db.db.prepare(`UPDATE factoring_invoices SET po_number = ?, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?`).run(String(po || '').trim() || null, id, tenantId);
  return getInvoice(id, tenantId);
}

// draft -> ready. Blocked without a PO # (RTS disables Submit until a PO
// exists) and without both packet documents attached.
function approve(id, tenantId = T()) {
  const inv = getInvoice(id, tenantId);
  if (!inv) return { ok: false, error: 'Invoice not found.' };
  if (inv.status !== 'draft') return { ok: false, error: `Invoice is ${inv.status}, not draft.` };
  if (!inv.po_number) return { ok: false, error: 'PO # is required before approval — RTS will not take the invoice without one.' };
  const docs = loadDocs(inv.load_id, tenantId);
  if (!docs.ratecon || !docs.pod) {
    return { ok: false, error: `Packet incomplete: rate con ${docs.ratecon ? '✓' : 'MISSING'}, POD ${docs.pod ? '✓' : 'MISSING'}. Documents can only be attached while creating the RTS invoice, so both must be on the load first.` };
  }
  db.db.prepare(`UPDATE factoring_invoices SET status = 'ready', updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
  return { ok: true, invoice: getInvoice(id, tenantId) };
}

// The batch the owner is about to submit in one account: ready invoices in
// Merlin's scope only, each with a PO and a complete packet. The confirm
// screen lists exactly these — never a blind submit (RTS submits the whole
// account at once, so what the TMS marks submitted must match the portal).
function submitBatchPreview(account, tenantId = T()) {
  if (!ACCOUNTS[account]) return [];
  return listInvoices(tenantId, 'ready')
    .filter(i => i.account === account && i.scope === 'merlin' && i.po_number);
}

function submitBatch(account, tenantId = T()) {
  const batch = submitBatchPreview(account, tenantId);
  const upd = db.db.prepare(`UPDATE factoring_invoices
    SET status = 'submitted', submitted_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ? AND status = 'ready'`);
  for (const inv of batch) upd.run(inv.id, tenantId);
  return batch.map(i => getInvoice(i.id, tenantId));
}

// Record a status RTS has reported (Phase A: manual confirm or API
// write-back). purchased/funded stamp their timestamps and amounts;
// held keeps RTS's reason verbatim.
function recordStatus(id, { status, funded_cents, actual_fee_cents, hold_reason }, tenantId = T()) {
  const inv = getInvoice(id, tenantId);
  if (!inv) return { ok: false, error: 'Invoice not found.' };
  const allowed = ['submitted', 'purchased', 'funded', 'held', 'void', 'draft', 'ready'];
  if (!allowed.includes(status)) return { ok: false, error: 'Bad status.' };
  const sets = ['status = ?', "updated_at = datetime('now')"];
  const params = [status];
  if (status === 'submitted' && !inv.submitted_at) sets.push("submitted_at = datetime('now')");
  if (status === 'purchased' && !inv.purchased_at) sets.push("purchased_at = datetime('now')");
  if (status === 'funded' && !inv.funded_at) sets.push("funded_at = datetime('now')");
  if (funded_cents != null) { sets.push('funded_cents = ?'); params.push(funded_cents); }
  if (actual_fee_cents != null) { sets.push('actual_fee_cents = ?'); params.push(actual_fee_cents); }
  // Settlement link (read-only from pay.js): if the load was already paid
  // in a finalized settlement by the time RTS buys/funds it, Tree advanced
  // the money — record that so the funded deposit reconciles as repayment.
  if ((status === 'purchased' || status === 'funded') && inv.settlement_id) {
    sets.push('advanced = 1');
  }
  if (status === 'held') { sets.push('hold_reason = ?'); params.push(hold_reason || null); }
  if (status !== 'held' && hold_reason !== undefined) { sets.push('hold_reason = ?'); params.push(hold_reason || null); }
  params.push(id, tenantId);
  db.db.prepare(`UPDATE factoring_invoices SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`)
    .run(...params);
  return { ok: true, invoice: getInvoice(id, tenantId) };
}

// API write-back (Merlin's factoring runs): find the invoice by id, by
// load external_id, or by invoice number; update status/PO/amounts. With
// action:'draft', create the draft for a delivered load instead.
function upsertFromApi(body, tenantId = T()) {
  const b = body || {};
  if (b.action === 'draft') {
    let load = null;
    if (b.load_external_id) {
      load = db.db.prepare('SELECT * FROM loads WHERE tenant_id = ? AND external_id = ?')
        .get(tenantId, b.load_external_id);
    } else if (b.load_id) {
      load = db.getLoad(Number(b.load_id), tenantId);
    }
    if (!load) return { ok: false, error: 'load not found' };
    const inv = createDraftForLoad(load, { tenantId, requirePod: false });
    if (!inv) return { ok: false, error: 'load is not delivered; no draft created' };
    return { ok: true, invoice: inv, created: inv.status === 'draft' };
  }
  let inv = null;
  if (b.id) inv = getInvoice(Number(b.id), tenantId);
  if (!inv && b.load_external_id) {
    const load = db.db.prepare('SELECT id FROM loads WHERE tenant_id = ? AND external_id = ?')
      .get(tenantId, b.load_external_id);
    if (load) inv = getInvoiceByLoad(load.id, tenantId);
  }
  if (!inv && b.invoice_number) {
    inv = db.db.prepare('SELECT * FROM factoring_invoices WHERE tenant_id = ? AND invoice_number = ?')
      .get(tenantId, String(b.invoice_number)) || null;
    if (inv) inv = getInvoice(inv.id, tenantId);
  }
  if (!inv) return { ok: false, error: 'invoice not found' };
  if (b.po_number !== undefined) setPo(inv.id, b.po_number, tenantId);
  if (b.payout_method !== undefined) {
    db.db.prepare(`UPDATE factoring_invoices SET payout_method = ?, updated_at = datetime('now')
      WHERE id = ? AND tenant_id = ?`).run(b.payout_method || null, inv.id, tenantId);
  }
  if (b.status) {
    const toC = (x) => x == null ? null : Math.round(Number(x) * 100);
    const r = recordStatus(inv.id, {
      status: b.status,
      funded_cents: b.funded != null ? toC(b.funded) : (b.funded_cents != null ? Number(b.funded_cents) : null),
      actual_fee_cents: b.actual_fee != null ? toC(b.actual_fee) : (b.actual_fee_cents != null ? Number(b.actual_fee_cents) : null),
      hold_reason: b.hold_reason,
    }, tenantId);
    if (!r.ok) return r;
    inv = r.invoice;
  } else {
    inv = getInvoice(inv.id, tenantId);
  }
  return { ok: true, invoice: inv };
}

module.exports = {
  NOTE_TEXT, DEFAULT_PAYOUT, ACCOUNTS, MERLIN_DRIVER_NAMES,
  scopeForDriverName, accountForBroker, loadNumber, isArmada, isSpot, suggestedPo,
  getPrimeRate, setPrimeRate, primeAdderPct, tierRatePct, effectiveRatePct,
  expectedFeeCents, prior30PurchasedVolumeCents,
  loadDocs, invoiceAmountCents, createDraftForLoad, ensureDraftOnDelivery,
  getInvoice, getInvoiceByLoad, listInvoices, missingPodLoads, boardData,
  setPo, approve, submitBatchPreview, submitBatch, recordStatus, upsertFromApi,
};
