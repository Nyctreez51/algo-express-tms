// Reports hub aggregations (MorPro-style report set, tranche 1 — Nov 28 2026).
// READ-ONLY. Revenue and driver pay come from src/performance.js, which reads
// driver pay through the ONE pay engine (src/pay.js) — this module never
// computes pay itself and never touches settlement math. The driver pay
// summary below reads FINALIZED settlements only: frozen truth, as paid.
'use strict';

const db = require('./db');
const perf = require('./performance');

const T = () => db.TENANT;

const CATEGORIES = ['fuel', 'maintenance', 'insurance', 'tolls', 'other'];

// Profit & loss for a range: revenue split (linehaul / FSC / gross) from
// delivered loads, driver pay, expenses by category, operating nets.
function profitAndLoss(q) {
  const { from, to } = perf.resolveRange(q);
  const p = perf.performanceReport(q);
  const catRows = expensesByCategory({ from, to });
  return {
    from, to,
    loads: p.tot.loads,
    linehaul: p.tot.linehaul,
    fsc: p.tot.fsc,
    gross: p.tot.gross,
    driverPay: p.tot.pay,
    expenses: p.tot.expenses,
    netAfterPay: p.tot.netAfterPay,
    netAfterAll: p.tot.netAfterAll,
    catRows,
  };
}

// Every expense category in the fixed CHECK order, zeros included, so the
// table shape never changes when a category has no spend in range.
function expensesByCategory(q) {
  const { from, to } = perf.resolveRange(q);
  const rows = db.db.prepare(
    `SELECT category, COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total
     FROM expenses WHERE tenant_id = ? AND date >= ? AND date <= ?
     GROUP BY category`
  ).all(T(), from, to);
  const byCat = new Map(rows.map(r => [r.category, r]));
  const grand = rows.reduce((s, r) => s + r.total, 0);
  return CATEGORIES.map(c => {
    const r = byCat.get(c) || { n: 0, total: 0 };
    return { category: c, n: r.n, total: r.total, pct: grand > 0 ? (r.total / grand) * 100 : 0 };
  });
}

// Finalized settlements whose pay week (Friday week_start) falls in range,
// grouped per driver. Drafts excluded — drafts are not pay yet.
function driverPaySummary(q) {
  const { from, to } = perf.resolveRange(q);
  const rows = db.db.prepare(
    `SELECT d.name AS driver_name, COUNT(*) AS weeks,
       COALESCE(SUM(s.gross_cents),0) AS gross,
       COALESCE(SUM(s.pay_cents),0) AS pay,
       COALESCE(SUM(s.escrow_cents),0) AS escrow,
       COALESCE(SUM(s.adjustments_cents),0) AS adjustments,
       COALESCE(SUM(s.net_cents),0) AS net
     FROM settlements s JOIN drivers d ON d.id = s.driver_id
     WHERE s.tenant_id = ? AND s.status = 'finalized'
       AND s.week_start >= ? AND s.week_start <= ?
     GROUP BY s.driver_id ORDER BY pay DESC`
  ).all(T(), from, to);
  const totals = rows.reduce((t, r) => ({
    weeks: t.weeks + r.weeks, gross: t.gross + r.gross, pay: t.pay + r.pay,
    escrow: t.escrow + r.escrow, adjustments: t.adjustments + r.adjustments,
    net: t.net + r.net,
  }), { weeks: 0, gross: 0, pay: 0, escrow: 0, adjustments: 0, net: 0 });
  return { from, to, rows, totals };
}

function reportsData(q) {
  return { pl: profitAndLoss(q), paySummary: driverPaySummary(q) };
}

module.exports = { profitAndLoss, expensesByCategory, driverPaySummary, reportsData };
