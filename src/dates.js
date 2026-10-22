// dates.js — settlement-week math and formatting.
// ALGO Express settlement week runs FRIDAY through THURSDAY:
// Friday deliveries roll into the following week's settlement.

'use strict';

function pad(n) { return String(n).padStart(2, '0'); }

// Local YYYY-MM-DD for a Date (avoids UTC-shift bugs).
function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Business runs on Eastern time, but the server may run UTC (Railway
// default). "Today" must therefore be computed in America/New_York, not
// server-local time — otherwise after 8 PM Eastern the dashboard's Today
// card starts counting tomorrow and today's pickups vanish from it.
const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

function todayStr() { return ET_DATE.format(new Date()); }

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

// "September 2026" from "2026-09"
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
// ["2026-10", "2026-09", ...] newest first, in Eastern time (see todayStr).
function recentMonths(n) {
  const out = [];
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'numeric',
  }).formatToParts(new Date());
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value); // 1-12
  for (let i = 0; i < n; i++) {
    const d = new Date(y, m - 1 - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
// ["2026-09-01", "2026-09-30"] from "2026-09"
function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
}

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
  monthLabel, recentMonths, monthRange,
};
