// pay.js — THE driver-pay engine (Settlements pay-basis fix, Nov 22 2026).
//
// Before this module the TMS had four separate pay computations that
// disagreed (owner Settlements page, driver Pay page, Truck Weeks,
// Performance/Analyzer). Every one of them now reads through here.
//
// Rules (Tree's, current):
//  - Pay week is Friday–Thursday by DELIVERY date. A load is payable in
//    the week it was delivered; a load delivered earlier but never paid
//    (settlement_id IS NULL) rolls into the current week, flagged.
//  - Each driver is paid from his effective-dated pay profile
//    (driver_pay_profiles), selected per load by the load's delivery date:
//      percent_gross    -> pay_pct % of (linehaul + FSC)
//      percent_linehaul -> pay_pct % of linehaul (the STORED split; the
//                          engine never re-derives FSC or miles)
//      per_mile         -> pay_rate x LOADED miles (empty miles never paid)
//    A load's pay_override_cents (flat fee, e.g. a TONU) wins over all.
//  - Pay is rounded per load (half-up), then summed. Never round the week.
//  - A percent_linehaul load with gross > 0 but NO FSC split on file is an
//    EXCEPTION: it is excluded from the draft and flagged, never silently
//    paid on gross.
//  - Finalizing a settlement freezes it: lines + totals are stored, each
//    load is stamped with the settlement id (the double-pay lock), and
//    the week is never recomputed. Corrections land as adjustments in a
//    later week (settlement_adjustments).
//  - YTD pay = sum of pay over FINALIZED settlements (+ the current draft
//    when previewing). Never recomputed from loads.
'use strict';

const db = require('./db');
const D = require('./dates');

const T = () => db.TENANT;

// Round half-up to integer cents (all pay figures are non-negative).
function roundCents(x) { return Math.round(x); }

// The profile in effect for a driver on a date. Falls back to the drivers
// row cache (legacy mapping: 'percent' = percent of gross) when the driver
// has no profile rows at all, so an unseeded driver still gets one
// consistent answer everywhere.
function profileFor(driverId, dateStr, tenantId = T()) {
  if (!driverId) return null;
  const d = dateStr || D.todayStr();
  const p = db.db.prepare(
    `SELECT * FROM driver_pay_profiles
     WHERE tenant_id = ? AND driver_id = ? AND effective_from <= ?
       AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY effective_from DESC, id DESC LIMIT 1`
  ).get(tenantId, driverId, d, d);
  if (p) return p;
  const drv = db.getDriver(driverId, tenantId);
  if (!drv) return null;
  if (drv.pay_type === 'per_mile' && Number(drv.pay_rate) > 0) {
    return { driver_id: driverId, pay_type: 'per_mile', pay_pct: null,
      pay_rate: Number(drv.pay_rate), fsc_rate: 0.50, fallback: true };
  }
  return { driver_id: driverId, pay_type: 'percent_gross',
    pay_pct: Number(drv.pay_pct) || 0, pay_rate: null, fsc_rate: 0.50, fallback: true };
}

// The driver's CURRENT profile (for entry-time decisions like the FSC
// fallback rate), or null.
function currentProfile(driverId, tenantId = T()) {
  return profileFor(driverId, D.todayStr(), tenantId);
}

// Fallback FSC rate for the entry-time split: the driver's profile rate,
// standing $0.50/mi (Tree, Nov 13 2026).
function fscRateFor(driverId, tenantId = T()) {
  const p = driverId ? currentProfile(driverId, tenantId) : null;
  return p && Number(p.fsc_rate) > 0 ? Number(p.fsc_rate) : 0.50;
}

// Entry-time LH/FSC split (used by the rate-con save path): a stated FSC
// always wins (handled by callers); when none is stated, carve the
// fallback FSC out of the gross. Amounts in integer cents.
function splitFallback(grossCents, loadedMiles, fscRate) {
  const rate = Number(fscRate) > 0 ? Number(fscRate) : 0.50;
  const fsc = Math.max(0, Math.min(roundCents(rate * (loadedMiles || 0) * 100), grossCents || 0));
  return { fsc_cents: fsc, linehaul_cents: (grossCents || 0) - fsc };
}

// Pay for ONE load under a profile. Returns { pay_cents, exception } —
// exception is a string when the load must NOT be paid as-is.
function payForLoad(profile, load) {
  const gross = (load.linehaul_cents || 0) + (load.fsc_cents || 0);
  if (load.pay_override_cents != null) {
    return { pay_cents: load.pay_override_cents, exception: null };
  }
  if (!profile) return { pay_cents: 0, exception: 'no pay profile for driver' };
  if (profile.pay_type === 'per_mile') {
    const rate = Number(profile.pay_rate) || 0;
    if (!(rate > 0)) return { pay_cents: 0, exception: 'per-mile profile has no rate' };
    return { pay_cents: roundCents((load.loaded_miles || 0) * rate * 100), exception: null };
  }
  const pct = Number(profile.pay_pct) || 0;
  if (profile.pay_type === 'percent_linehaul') {
    // No FSC split on file (fsc = 0 on a paying load): pct x linehaul
    // would silently pay on gross. Flag it instead (spec §4, test 3).
    if (gross > 0 && (load.fsc_cents || 0) === 0) {
      return { pay_cents: 0, exception: 'no FSC split on file' };
    }
    return { pay_cents: roundCents((load.linehaul_cents || 0) * pct / 100), exception: null };
  }
  // percent_gross
  return { pay_cents: roundCents(gross * pct / 100), exception: null };
}

function payBasisLabel(profile) {
  if (!profile) return 'no pay terms';
  if (profile.pay_type === 'per_mile') return `$${Number(profile.pay_rate || 0).toFixed(2)}/mi × loaded miles`;
  if (profile.pay_type === 'percent_linehaul') return `${profile.pay_pct || 0}% of linehaul`;
  return `${profile.pay_pct || 0}% of gross`;
}

// Loads payable for (driver, week): delivered, delivery_date in the week
// OR delivered earlier and never paid (roll-in), and not already stamped
// into a finalized settlement.
function payableLoads(driverId, weekStart, tenantId = T()) {
  const [w0, w1] = D.weekRange(weekStart);
  return db.db.prepare(
    `SELECT * FROM loads
     WHERE tenant_id = ? AND driver_id = ? AND status = 'delivered'
       AND settlement_id IS NULL
       AND delivery_date IS NOT NULL AND delivery_date <= ?
     ORDER BY delivery_date, id`
  ).all(tenantId, driverId, w1);
}

function getSettlement(driverId, weekStart, tenantId = T()) {
  return db.db.prepare(
    `SELECT * FROM settlements WHERE tenant_id = ? AND driver_id = ? AND week_start = ?`
  ).get(tenantId, driverId, weekStart) || null;
}

function listAdjustments(driverId, weekStart, tenantId = T()) {
  return db.db.prepare(
    `SELECT * FROM settlement_adjustments
     WHERE tenant_id = ? AND driver_id = ? AND week_start = ? ORDER BY id`
  ).all(tenantId, driverId, weekStart);
}

function createAdjustment({ driverId, weekStart, kind, amountCents, notes }, tenantId = T()) {
  const r = db.db.prepare(
    `INSERT INTO settlement_adjustments (tenant_id, driver_id, week_start, kind, amount_cents, notes)
     VALUES (?,?,?,?,?,?)`
  ).run(tenantId, driverId, weekStart, kind, amountCents, notes || null);
  return r.lastInsertRowid;
}

// YTD pay from FINALIZED settlements only (standing rule: YTD is the sum
// of settlement earnings, rebuilt from statements — never from loads).
function ytdPay(driverId, tenantId = T()) {
  const r = db.db.prepare(
    `SELECT COALESCE(SUM(pay_cents),0) AS pay, COALESCE(SUM(n),0) AS loads FROM (
       SELECT s.pay_cents, (SELECT COUNT(*) FROM settlement_lines sl WHERE sl.settlement_id = s.id) AS n
       FROM settlements s
       WHERE s.tenant_id = ? AND s.driver_id = ? AND s.status = 'finalized')`
  ).get(tenantId, driverId);
  return { pay_cents: r.pay, loads: r.loads };
}

// Build (or read back) the settlement for one driver + week.
// Returns a plain object the pages render:
// { driver_id, name, week_start, status, lines[], exceptions[],
//   loads, miles, loaded_miles, gross_cents, pay_cents, escrow_cents,
//   adjustments[], adjustments_cents, net_cents, pay_basis,
//   ytd_pay_cents, ytd_loads, escrow_balance_cents, settlement_id }
function buildSettlement(driverId, weekStart, tenantId = T()) {
  const [w0, w1] = D.weekRange(weekStart);
  const drv = db.getDriver(driverId, tenantId);
  const name = drv ? drv.name : 'Unknown driver';
  const fin = getSettlement(driverId, weekStart, tenantId);
  const ytd = ytdPay(driverId, tenantId);
  const escrowBalance = db.escrowBalance(driverId, tenantId);

  if (fin && fin.status === 'finalized') {
    const lines = db.db.prepare(
      `SELECT sl.*, l.external_id, l.date AS pickup_date, l.delivery_date,
         l.origin, l.destination, l.broker
       FROM settlement_lines sl JOIN loads l ON l.id = sl.load_id
       WHERE sl.settlement_id = ? ORDER BY l.delivery_date, l.id`
    ).all(fin.id);
    const basisProfile = lines.length
      ? { pay_type: lines[0].pay_type, pay_pct: null, pay_rate: null } : null;
    return {
      driver_id: driverId, name, week_start: weekStart, status: 'finalized',
      settlement_id: fin.id, lines, exceptions: [],
      loads: lines.length,
      miles: lines.reduce((s, x) => s + (x.loaded_miles || 0), 0),
      loaded_miles: lines.reduce((s, x) => s + (x.loaded_miles || 0), 0),
      gross_cents: fin.gross_cents, pay_cents: fin.pay_cents,
      escrow_cents: fin.escrow_cents, adjustments: listAdjustments(driverId, weekStart, tenantId),
      adjustments_cents: fin.adjustments_cents, net_cents: fin.net_cents,
      pay_basis: basisProfile ? basisLabelForStored(basisProfile, fin) : '',
      ytd_pay_cents: ytd.pay_cents, ytd_loads: ytd.loads,
      escrow_balance_cents: escrowBalance,
    };
  }

  // Draft: compute live from payable loads.
  const lines = [], exceptions = [];
  let gross = 0, pay = 0, loadedMiles = 0;
  const basisLabels = new Set();
  for (const load of payableLoads(driverId, weekStart, tenantId)) {
    const profile = profileFor(driverId, load.delivery_date, tenantId);
    const res = payForLoad(profile, load);
    const lgross = (load.linehaul_cents || 0) + (load.fsc_cents || 0);
    if (res.exception) {
      exceptions.push({ load_id: load.id, external_id: load.external_id,
        delivery_date: load.delivery_date, gross_cents: lgross, reason: res.exception });
      continue;
    }
    basisLabels.add(payBasisLabel(profile));
    lines.push({
      load_id: load.id, external_id: load.external_id,
      pickup_date: load.date, delivery_date: load.delivery_date,
      origin: load.origin, destination: load.destination, broker: load.broker,
      pay_type: load.pay_override_cents != null ? 'flat_override' : profile.pay_type,
      loaded_miles: load.loaded_miles || 0,
      gross_cents: lgross, linehaul_cents: load.linehaul_cents || 0,
      fsc_cents: load.fsc_cents || 0, pay_cents: res.pay_cents,
      rolled_in: load.delivery_date < w0 ? 1 : 0,
    });
    gross += lgross; pay += res.pay_cents; loadedMiles += load.loaded_miles || 0;
  }
  const adjustments = listAdjustments(driverId, weekStart, tenantId);
  const adjCents = adjustments.reduce((s, a) => s + a.amount_cents, 0);
  const escrow = db.escrowWithheld(driverId, w0, w1, tenantId);
  const profileNow = currentProfile(driverId, tenantId);
  return {
    driver_id: driverId, name, week_start: weekStart, status: 'draft',
    settlement_id: fin ? fin.id : null, lines, exceptions,
    loads: lines.length, miles: loadedMiles, loaded_miles: loadedMiles,
    gross_cents: gross, pay_cents: pay,
    escrow_cents: escrow, adjustments, adjustments_cents: adjCents,
    net_cents: pay - escrow + adjCents,
    pay_basis: basisLabels.size ? [...basisLabels].join('; ') : payBasisLabel(profileNow),
    ytd_pay_cents: ytd.pay_cents + pay, ytd_loads: ytd.loads + lines.length,
    escrow_balance_cents: escrowBalance,
  };
}

// Label for a finalized settlement's stored basis (pay_type only is kept
// per line; the percent/rate lives on the profile that was in effect).
function basisLabelForStored(lineProfile, settlement) {
  const p = profileFor(settlement.driver_id, settlement.week_start, settlement.tenant_id);
  if (p && p.pay_type === lineProfile.pay_type) return payBasisLabel(p);
  if (lineProfile.pay_type === 'flat_override') return 'flat fee';
  if (lineProfile.pay_type === 'per_mile') return 'per loaded mile';
  if (lineProfile.pay_type === 'percent_linehaul') return '% of linehaul';
  return '% of gross';
}

// Freeze a draft settlement: store lines + totals, stamp its loads.
// Idempotent — finalizing an already-finalized week returns it unchanged.
// Returns { settlement, already } or { error }.
function finalizeSettlement(driverId, weekStart, tenantId = T()) {
  const existing = getSettlement(driverId, weekStart, tenantId);
  if (existing && existing.status === 'finalized') return { settlement: existing, already: true };
  const built = buildSettlement(driverId, weekStart, tenantId);
  if (built.exceptions.length) {
    return { error: `${built.exceptions.length} load(s) have no FSC split on file — resolve before finalizing.` };
  }
  if (!built.lines.length && !built.adjustments.length) {
    return { error: 'Nothing to finalize — no payable loads or adjustments this week.' };
  }
  db.db.exec('BEGIN');
  try {
    let sid;
    if (existing) {
      sid = existing.id;
      db.db.prepare(`UPDATE settlements SET status='finalized', gross_cents=?, pay_cents=?,
        escrow_cents=?, adjustments_cents=?, net_cents=?, finalized_at=datetime('now')
        WHERE id=?`).run(built.gross_cents, built.pay_cents, built.escrow_cents,
        built.adjustments_cents, built.net_cents, sid);
      db.db.prepare('DELETE FROM settlement_lines WHERE settlement_id = ?').run(sid);
    } else {
      const r = db.db.prepare(`INSERT INTO settlements
        (tenant_id, driver_id, week_start, status, gross_cents, pay_cents,
         escrow_cents, adjustments_cents, net_cents, finalized_at)
        VALUES (?,?,?,'finalized',?,?,?,?,?,datetime('now'))`)
        .run(tenantId, driverId, weekStart, built.gross_cents, built.pay_cents,
          built.escrow_cents, built.adjustments_cents, built.net_cents);
      sid = r.lastInsertRowid;
    }
    const insLine = db.db.prepare(`INSERT INTO settlement_lines
      (settlement_id, load_id, pay_type, loaded_miles, gross_cents, linehaul_cents, fsc_cents, pay_cents, rolled_in)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const stamp = db.db.prepare('UPDATE loads SET settlement_id = ? WHERE id = ? AND tenant_id = ?');
    for (const ln of built.lines) {
      insLine.run(sid, ln.load_id, ln.pay_type, ln.loaded_miles, ln.gross_cents,
        ln.linehaul_cents, ln.fsc_cents, ln.pay_cents, ln.rolled_in);
      stamp.run(sid, ln.load_id, tenantId);
    }
    db.db.exec('COMMIT');
    return { settlement: getSettlement(driverId, weekStart, tenantId), already: false };
  } catch (e) {
    db.db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = {
  roundCents, profileFor, currentProfile, fscRateFor, splitFallback,
  payForLoad, payBasisLabel, payableLoads, getSettlement,
  listAdjustments, createAdjustment, ytdPay,
  buildSettlement, finalizeSettlement,
};
