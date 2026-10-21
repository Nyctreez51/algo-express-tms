// Performance Report + Fuel Dashboard aggregations (MorPro-style reporting).
// Reads only. Driver pay follows the settlement rule: per-mile drivers earn
// pay_rate x loaded miles; everyone else earns pay_pct % of gross (linehaul + FSC).
'use strict';

const db = require('./db');
const D = require('./dates');

const T = () => db.TENANT;

function driverPayFor(d, grossCents, loadedMiles) {
  if (d && d.pay_type === 'per_mile' && Number(d.pay_rate) > 0) {
    return Math.round(loadedMiles * d.pay_rate * 100);
  }
  return Math.round(grossCents * ((d && d.pay_pct) || 0) / 100);
}

function validYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Default range: month to date. Presets computed by the route and passed in.
function resolveRange(q) {
  const today = D.todayStr();
  const from = validYmd(q.from) || (today.slice(0, 7) + '-01');
  const to = validYmd(q.to) || today;
  return from <= to ? { from, to } : { from: to, to: from };
}

function performanceReport(q) {
  const { from, to } = resolveRange(q);
  const driverId = /^\d+$/.test(q.driver || '') ? Number(q.driver) : null;
  const truckId = /^\d+$/.test(q.truck || '') ? Number(q.truck) : null;

  const loadWhere = `l.tenant_id = ? AND l.status = 'delivered' AND l.date >= ? AND l.date <= ?`
    + (driverId ? ` AND l.driver_id = ${driverId}` : '')
    + (truckId ? ` AND l.truck_id = ${truckId}` : '');
  const loads = db.db.prepare(
    `SELECT l.*, d.name AS driver_name, d.pay_pct, d.pay_type, d.pay_rate,
       COALESCE(t.unit_number, (t.year || ' ' || t.make || ' ' || t.model)) AS truck_label
     FROM loads l LEFT JOIN drivers d ON d.id = l.driver_id
     LEFT JOIN trucks t ON t.id = l.truck_id
     WHERE ${loadWhere} ORDER BY l.date DESC`
  ).all(T(), from, to);

  const tot = { loads: 0, gross: 0, linehaul: 0, fsc: 0, loaded: 0, empty: 0, pay: 0 };
  const byDriver = new Map();
  const byTruck = new Map();
  const byBroker = new Map();
  for (const l of loads) {
    const gross = (l.linehaul_cents || 0) + (l.fsc_cents || 0);
    const pay = driverPayFor(
      { pay_type: l.pay_type, pay_pct: l.pay_pct, pay_rate: l.pay_rate },
      gross, l.loaded_miles || 0);
    tot.loads += 1; tot.gross += gross; tot.linehaul += l.linehaul_cents || 0;
    tot.fsc += l.fsc_cents || 0; tot.loaded += l.loaded_miles || 0;
    tot.empty += l.empty_miles || 0; tot.pay += pay;

    const dKey = l.driver_id || 0;
    const d = byDriver.get(dKey) || { name: l.driver_name || 'Unassigned', loads: 0, gross: 0, loaded: 0, empty: 0, pay: 0 };
    d.loads += 1; d.gross += gross; d.loaded += l.loaded_miles || 0; d.empty += l.empty_miles || 0; d.pay += pay;
    byDriver.set(dKey, d);

    const tKey = l.truck_id || 0;
    const t = byTruck.get(tKey) || { label: l.truck_label || 'Unassigned', loads: 0, gross: 0, loaded: 0, empty: 0 };
    t.loads += 1; t.gross += gross; t.loaded += l.loaded_miles || 0; t.empty += l.empty_miles || 0;
    byTruck.set(tKey, t);

    const bKey = (l.broker || '').trim() || '— (none listed)';
    const b = byBroker.get(bKey) || { broker: bKey, loads: 0, gross: 0, loaded: 0, empty: 0 };
    b.loads += 1; b.gross += gross; b.loaded += l.loaded_miles || 0; b.empty += l.empty_miles || 0;
    byBroker.set(bKey, b);
  }
  tot.miles = tot.loaded + tot.empty;
  tot.rpm = tot.miles > 0 ? tot.gross / tot.miles / 100 : 0;
  tot.deadheadPct = tot.miles > 0 ? (tot.empty / tot.miles) * 100 : 0;
  tot.netAfterPay = tot.gross - tot.pay;

  const expensesTotal = db.db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS total FROM expenses
     WHERE tenant_id = ? AND date >= ? AND date <= ?`
  ).get(T(), from, to).total;
  tot.expenses = expensesTotal;
  tot.netAfterAll = tot.gross - tot.pay - expensesTotal;

  const truckExp = db.db.prepare(
    `SELECT truck_id, COALESCE(SUM(amount_cents),0) AS total FROM expenses
     WHERE tenant_id = ? AND date >= ? AND date <= ? GROUP BY truck_id`
  ).all(T(), from, to);
  const expByTruck = new Map(truckExp.map(r => [r.truck_id || 0, r.total]));
  const truckRows = [...byTruck.entries()].map(([id, t]) => ({
    ...t, expenses: expByTruck.get(id) || 0, net: t.gross - (expByTruck.get(id) || 0),
  })).sort((a, b) => b.gross - a.gross);

  const driverRows = [...byDriver.values()].sort((a, b) => b.gross - a.gross);
  const brokerRows = [...byBroker.values()].sort((a, b) => b.gross - a.gross);
  return { from, to, tot, driverRows, truckRows, brokerRows };
}

function fuelDashboard(q) {
  const { from, to } = resolveRange(q);
  const rows = db.db.prepare(
    `SELECT e.*, COALESCE(t.unit_number, (t.year || ' ' || t.make || ' ' || t.model)) AS truck_label
     FROM expenses e LEFT JOIN trucks t ON t.id = e.truck_id
     WHERE e.tenant_id = ? AND e.category = 'fuel' AND e.date >= ? AND e.date <= ?
     ORDER BY e.date DESC`
  ).all(T(), from, to);

  const tot = { fills: 0, spend: 0, gallons: 0, galSpend: 0 };
  const byTruck = new Map();
  const byState = new Map();
  for (const e of rows) {
    tot.fills += 1; tot.spend += e.amount_cents || 0;
    if (e.gallons && e.gallons > 0) { tot.gallons += e.gallons; tot.galSpend += e.amount_cents || 0; }
    const tk = e.truck_id || 0;
    const t = byTruck.get(tk) || { label: e.truck_label || 'Unassigned', fills: 0, spend: 0, gallons: 0, galSpend: 0 };
    t.fills += 1; t.spend += e.amount_cents || 0;
    if (e.gallons && e.gallons > 0) { t.gallons += e.gallons; t.galSpend += e.amount_cents || 0; }
    byTruck.set(tk, t);
    const sk = (e.fuel_state || '').trim() || '—';
    const s = byState.get(sk) || { state: sk, fills: 0, spend: 0, gallons: 0 };
    s.fills += 1; s.spend += e.amount_cents || 0; s.gallons += e.gallons || 0;
    byState.set(sk, s);
  }
  tot.avgGal = tot.gallons > 0 ? (tot.galSpend / tot.gallons / 100) : 0;

  // Miles per truck from delivered loads in range, for MPG.
  const miles = db.db.prepare(
    `SELECT truck_id, COALESCE(SUM(loaded_miles + empty_miles),0) AS miles FROM loads
     WHERE tenant_id = ? AND status = 'delivered' AND date >= ? AND date <= ? GROUP BY truck_id`
  ).all(T(), from, to);
  const milesByTruck = new Map(miles.map(r => [r.truck_id || 0, r.miles]));
  const truckRows = [...byTruck.entries()].map(([id, t]) => {
    const mi = milesByTruck.get(id) || 0;
    return { ...t, miles: mi, avgGal: t.gallons > 0 ? (t.galSpend / t.gallons / 100) : 0, mpg: t.gallons > 0 ? mi / t.gallons : 0 };
  }).sort((a, b) => b.spend - a.spend);
  const stateRows = [...byState.values()].sort((a, b) => b.spend - a.spend);

  // Monthly trend: last 6 calendar months ending at `to`.
  const months = [];
  const [ty, tm] = to.split('-').map(Number);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(ty, tm - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const trend = db.db.prepare(
    `SELECT substr(date,1,7) AS ym, COUNT(*) AS fills, COALESCE(SUM(amount_cents),0) AS spend,
       COALESCE(SUM(CASE WHEN gallons > 0 THEN gallons ELSE 0 END),0) AS gallons
     FROM expenses WHERE tenant_id = ? AND category = 'fuel' AND substr(date,1,7) IN (${months.map(() => '?').join(',')})
     GROUP BY ym`
  ).all(T(), ...months);
  const trendByYm = new Map(trend.map(r => [r.ym, r]));
  const trendRows = months.map(ym => {
    const r = trendByYm.get(ym) || { fills: 0, spend: 0, gallons: 0 };
    return { ym, fills: r.fills, spend: r.spend, gallons: r.gallons };
  });

  return { from, to, tot, truckRows, stateRows, trendRows };
}

module.exports = { resolveRange, performanceReport, fuelDashboard, driverPayFor };
