// dates.js — settlement-week math and formatting.
// ALGO Express settlement week runs FRIDAY through THURSDAY:
// Friday deliveries roll into the following week's settlement.

'use strict';

function pad(n) { return String(n).padStart(2, '0'); }

// Local YYYY-MM-DD for a Date (avoids UTC-shift bugs).
function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayStr() { return ymd(new Date()); }

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDaysStr(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

// Friday (day 5) that starts the settlement week containing `dateStr`.
function weekStartOf(dateStr) {
  const d = parseYmd(dateStr);
  const diff = (d.getDay() - 5 + 7) % 7; // days since Friday
  d.setDate(d.getDate() - diff);
  return ymd(d);
}

// [friday, thursday] for a week-start Friday.
function weekRange(weekStart) {
  return [weekStart, addDaysStr(weekStart, 6)];
}

function monthStart(s) { return s.slice(0, 7) + '-01'; }
function yearStart(s) { return s.slice(0, 4) + '-01-01'; }

function fmtMoney(cents) {
  const v = (cents || 0) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(n) {
  return (n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// "Oct 18, 2026"
function fmtDate(s) {
  if (!s) return '—';
  const d = parseYmd(s);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// "Oct 18 – Oct 24"
function fmtWeekRange(weekStart) {
  const [a, b] = weekRange(weekStart);
  const da = parseYmd(a), dbb = parseYmd(b);
  const f = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${f(da)} – ${f(dbb)}, ${dbb.getFullYear()}`;
}

module.exports = {
  todayStr, parseYmd, addDaysStr, weekStartOf, weekRange,
  monthStart, yearStart, fmtMoney, fmtNum, fmtDate, fmtWeekRange,
};
