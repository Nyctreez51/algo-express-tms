// golden-settlements.js — HARD acceptance test for the settlements
// pay-basis fix (spec: settlements-pay-basis-fix-spec-2026-11-22.md §5).
//
// Builds an isolated database holding the Nov 13–19, 2026 pay week in its
// FINAL recorded state and requires the pay engine (src/pay.js) to
// reproduce the finalized Nov 20, 2026 settlements TO THE CENT:
//   total pay $10,408.80 · escrow −$400.00 · adjustments −$107.61
//   ACH cash out $9,901.19
// Plus the spec's negative tests (§5.4). Exit 0 = pass, 1 = fail.
// Run: node test/golden-settlements.js
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-golden-'));
process.env.DB_PATH = path.join(tmp, 'test.db');

const db = require('../src/db');
const pay = require('../src/pay');
const T = db.TENANT;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}
const money = (c) => '$' + (c / 100).toFixed(2);

// ---------- seed drivers not in the boot seed ----------
for (const d of [
  { name: 'Jerimiah Thompson', pay_pct: 35, pay_type: 'percent', pay_rate: null, status: 'active' },
  { name: 'Robert Davis Jr', pay_pct: 30, pay_type: 'percent', pay_rate: null, status: 'active' },
  { name: 'Tyler Carter', pay_pct: 30, pay_type: 'per_mile', pay_rate: 0.60, status: 'inactive' },
]) {
  if (!db.findDriverByName(d.name, T)) db.saveDriver(d, T);
}
db.seedPayProfiles(T); // profiles for the drivers added above (boot seed got the rest)

const D = (name) => db.findDriverByName(name, T).id;
const parker = D('Michael Parker'), jerimiah = D('Jerimiah Thompson'),
  donte = D('Donte Murrill'), hammond = D('Shdermon Hammond'), robert = D('Robert Davis Jr');

// ---------- prior finalized settlements (YTD before this week) ----------
const insSettlement = db.db.prepare(`INSERT INTO settlements
  (tenant_id, driver_id, week_start, status, gross_cents, pay_cents, escrow_cents,
   adjustments_cents, net_cents, finalized_at)
  VALUES (?, ?, '2026-11-06', 'finalized', 0, ?, 0, 0, ?, datetime('now'))`);
const priorPay = new Map([[parker, 771517], [jerimiah, 408303], [donte, 511458], [hammond, 584740]]);
const priorSettlementId = new Map();
for (const [driverId, payCents] of priorPay) {
  priorSettlementId.set(driverId, insSettlement.run(T, driverId, payCents, payCents).lastInsertRowid);
}

// ---------- load inserter ----------
const insLoad = db.db.prepare(`INSERT INTO loads
  (tenant_id, external_id, date, origin, destination, loaded_miles, empty_miles,
   linehaul_cents, fsc_cents, broker, driver_id, status, delivery_date,
   pay_override_cents, settlement_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
function load(driverId, ext, pickup, delivery, miles, lh, fsc, extra = {}) {
  return insLoad.run(T, 'load-' + ext, pickup, 'A', 'B', miles, 0, lh, fsc,
    extra.broker || 'Test Broker', driverId, extra.status || 'delivered',
    delivery, extra.override != null ? extra.override : null,
    extra.settlementId || null).lastInsertRowid;
}

// One already-paid load per driver from the prior week (stamped) — the
// engine must never pick it up again (double-pay lock).
for (const [driverId] of priorPay) {
  load(driverId, 'PRIOR-' + driverId, '2026-11-09', '2026-11-10', 100, 10000, 0,
    { settlementId: Number(priorSettlementId.get(driverId)) });
}

// ---------- the golden week (Nov 13–19, 2026) ----------
// Michael Parker — 35% of gross (incl. the Nov 12 roll-in at gross basis)
load(parker, '1172674', '2026-11-11', '2026-11-12', 0, 100000, 0);
load(parker, '132694942', '2026-11-12', '2026-11-13', 0, 140000, 0);
load(parker, '132698548', '2026-11-13', '2026-11-14', 0, 75000, 0);
load(parker, '132741358', '2026-11-14', '2026-11-15', 0, 140000, 0);
load(parker, '39200106', '2026-11-15', '2026-11-16', 0, 50000, 0);
load(parker, '132743104', '2026-11-16', '2026-11-17', 0, 140000, 0);
load(parker, '39129433', '2026-11-17', '2026-11-18', 0, 95000, 0);
load(parker, '132787909', '2026-11-18', '2026-11-19', 0, 235000, 0);
// Jerimiah Thompson — 35% of gross (incl. Nov 12 roll-in + Thu-delivered 978442)
load(jerimiah, '10639', '2026-11-11', '2026-11-12', 0, 80000, 0);
load(jerimiah, '132721798', '2026-11-14', '2026-11-15', 0, 140000, 0);
load(jerimiah, '132742249', '2026-11-14', '2026-11-15', 0, 140000, 0);
load(jerimiah, '27886', '2026-11-16', '2026-11-17', 0, 80000, 0);
load(jerimiah, '24727782', '2026-11-16', '2026-11-17', 0, 50000, 0);
load(jerimiah, '132765222', '2026-11-17', '2026-11-18', 0, 235000, 0);
load(jerimiah, '978442', '2026-11-18', '2026-11-19', 0, 110000, 0);
// Donte Murrill — $0.65 x loaded (pay) miles, splits per the reconciliation
load(donte, '310838', '2026-11-14', '2026-11-15', 214, 79300, 10700);
load(donte, '747303', '2026-11-14', '2026-11-15', 332, 163400, 16600);
load(donte, '1576671', '2026-11-17', '2026-11-18', 319, 154050, 15950);
load(donte, '132708074', '2026-11-18', '2026-11-19', 363, 101850, 18150);
// Shdermon Hammond — $0.65 x SHEET miles + the $150 TONU flat override
load(hammond, 'LD1812058', '2026-11-10', '2026-11-12', 1084, 290800, 54200);
load(hammond, '132731422', '2026-11-16', '2026-11-17', 863, 166850, 43150);
load(hammond, '9947366', '2026-11-18', '2026-11-18', 0, 15000, 0, { override: 15000 });
load(hammond, '3143317', '2026-11-17', '2026-11-18', 157, 147150, 7850);
// Robert Davis Jr — 30% of linehaul on the stored 50c split (paid week)
load(robert, '39167047', '2026-11-12', '2026-11-16', 2280, 586000, 114000);

// Negative-test loads planted INSIDE the golden week (must be excluded):
load(donte, 'CXL1', '2026-11-13', '2026-11-14', 500, 99900, 0, { status: 'cancelled' });
load(jerimiah, 'TRANSIT1', '2026-11-15', '2026-11-16', 400, 88800, 0, { status: 'in_transit' });

// Escrow withholdings ($100, Week 3 of 10) — none for Robert (no agreement)
for (const id of [parker, jerimiah, donte, hammond]) {
  db.createEscrowEntry({ driver_id: id, date: '2026-11-13', amount_cents: 10000,
    entry_type: 'withholding', notes: 'Weekly $100 escrow withholding' }, T);
}
// Parker's advance deduction: $140 advance Nov 15 less $32.39 headlight receipt
pay.createAdjustment({ driverId: parker, weekStart: '2026-11-13', kind: 'advance',
  amountCents: -10761, notes: '$140 advance Nov 15 less $32.39 TA headlight receipt' }, T);

// ---------- GOLDEN TEST: week of Fri 2026-11-13 ----------
const WEEK = '2026-11-13';
const expected = new Map([
  [parker,   { name: 'Michael Parker',    loads: 8, gross: 975000, pay: 341250, escrow: 10000, adj: -10761, net: 320489, ytd: 1112767 }],
  [jerimiah, { name: 'Jerimiah Thompson', loads: 7, gross: 835000, pay: 292250, escrow: 10000, adj: 0, net: 282250, ytd: 700553 }],
  [donte,    { name: 'Donte Murrill',     loads: 4, gross: 560000, pay: 79820, escrow: 10000, adj: 0, net: 69820, ytd: 591278 }],
  [hammond,  { name: 'Shdermon Hammond',  loads: 4, gross: 725000, pay: 151760, escrow: 10000, adj: 0, net: 141760, ytd: 736500 }],
  [robert,   { name: 'Robert Davis Jr',   loads: 1, gross: 700000, pay: 175800, escrow: 0, adj: 0, net: 175800, ytd: 175800 }],
]);
console.log(`\n=== GOLDEN WEEK ${WEEK} (draft build) ===`);
let totPay = 0, totEscrow = 0, totAdj = 0, totNet = 0;
for (const [driverId, e] of expected) {
  const s = pay.buildSettlement(driverId, WEEK, T);
  console.log(`-- ${e.name}: ${s.loads} loads, gross ${money(s.gross_cents)}, pay ${money(s.pay_cents)}, escrow ${money(s.escrow_cents)}, adj ${money(s.adjustments_cents)}, net ${money(s.net_cents)}, YTD ${money(s.ytd_pay_cents)}`);
  check(`${e.name} loads`, s.loads, e.loads);
  check(`${e.name} gross`, s.gross_cents, e.gross);
  check(`${e.name} pay`, s.pay_cents, e.pay);
  check(`${e.name} escrow`, s.escrow_cents, e.escrow);
  check(`${e.name} adjustments`, s.adjustments_cents, e.adj);
  check(`${e.name} NET`, s.net_cents, e.net);
  check(`${e.name} YTD pay`, s.ytd_pay_cents, e.ytd);
  check(`${e.name} exceptions`, s.exceptions.length, 0);
  totPay += s.pay_cents; totEscrow += s.escrow_cents; totAdj += s.adjustments_cents; totNet += s.net_cents;
}
console.log(`-- WEEK TOTALS: pay ${money(totPay)}, escrow ${money(totEscrow)}, adj ${money(totAdj)}, ACH ${money(totNet)}`);
check('TOTAL driver pay', totPay, 1040880);
check('TOTAL escrow', totEscrow, 40000);
check('TOTAL adjustments', totAdj, -10761);
check('TOTAL ACH CASH OUT', totNet, 990119);

// Spot-check line-level math: roll-in flag + TONU override + Robert's split
const pLines = pay.buildSettlement(parker, WEEK, T).lines;
const rollIn = pLines.find(l => l.external_id === 'load-1172674');
check('Parker roll-in 1172674 pay (35% of gross)', rollIn.pay_cents, 35000);
check('Parker roll-in flagged', rollIn.rolled_in, 1);
const hLines = pay.buildSettlement(hammond, WEEK, T).lines;
check('Hammond TONU override pay', hLines.find(l => l.external_id === 'load-9947366').pay_cents, 15000);
const rLines = pay.buildSettlement(robert, WEEK, T).lines;
check('Robert 39167047 pay (30% of LH $5,860)', rLines[0].pay_cents, 175800);
check('Robert 39167047 stored FSC', rLines[0].fsc_cents, 114000);

// ---------- finalize: freeze + idempotence + double-pay lock ----------
console.log('\n=== FINALIZE / FREEZE ===');
for (const [driverId, e] of expected) {
  const r = pay.finalizeSettlement(driverId, WEEK, T);
  check(`${e.name} finalize ok`, !!r.settlement && !r.error, true);
}
for (const [driverId, e] of expected) {
  const s = pay.buildSettlement(driverId, WEEK, T);
  check(`${e.name} frozen status`, s.status, 'finalized');
  check(`${e.name} frozen NET`, s.net_cents, e.net);
  check(`${e.name} frozen YTD`, s.ytd_pay_cents, e.ytd);
}
const again = pay.finalizeSettlement(parker, WEEK, T);
check('Re-finalize is a no-op (already)', again.already, true);
const parkerNext = pay.buildSettlement(parker, '2026-11-20', T);
check('Parker next week: stamped loads never roll in again', parkerNext.lines.length, 0);

// ---------- negative tests: next week (2026-11-20) ----------
// Robert at 25% now; a no-split linehaul load must be flagged, not paid.
load(robert, 'RWK2', '2026-11-21', '2026-11-23', 2000, 400000, 100000);
load(robert, 'RNOSPLIT', '2026-11-22', '2026-11-24', 1500, 100000, 0);
const rNext = pay.buildSettlement(robert, '2026-11-20', T);
check('Robert next-week pay at 25% of LH', rNext.pay_cents, 100000);
check('Robert next-week exceptions (no split)', rNext.exceptions.length, 1);
check('Robert finalize blocked by exception', !!pay.finalizeSettlement(robert, '2026-11-20', T).error, true);
const rGolden = pay.buildSettlement(robert, WEEK, T);
check('Robert golden week still 30% after rate change', rGolden.pay_cents, 175800);

// Per-mile driver earns $0 on empty miles.
load(donte, 'EMPTY1', '2026-11-24', '2026-11-25', 0, 50000, 0);
db.db.prepare('UPDATE loads SET empty_miles = 300 WHERE external_id = ?').run('load-EMPTY1');
const dNext = pay.buildSettlement(donte, '2026-11-20', T);
check('Donte empty-miles load pays $0', dNext.pay_cents, 0);
check('Donte empty-miles load counted once', dNext.lines.length, 1);

console.log(failures ? `\n*** GOLDEN TEST FAILED: ${failures} check(s) ***` : '\n*** GOLDEN TEST PASSED — all checks ***');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
