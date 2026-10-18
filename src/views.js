// views.js — HTML templates. Mobile-first: every page is designed for a phone
// first, then widens on desktop. Driver pages get a bottom tab bar so the app
// feels native when added to a phone home screen.

'use strict';

const { fmtMoney, fmtNum, fmtDate, fmtWeekRange, monthLabel, recentMonths } = require('./dates');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f141b;--card:#1a2230;--line:#2a3547;--txt:#eef2f7;--mut:#9aa7bd;
--acc:#f5a623;--acc2:#2f9e6e;--danger:#e05656;--radius:12px}
body{background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.45;-webkit-text-size-adjust:100%}
a{color:var(--acc);text-decoration:none}
.wrap{max-width:1080px;margin:0 auto;padding:16px 14px 90px}
.topbar{background:#141b26;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10}
.topbar .in{max-width:1080px;margin:0 auto;padding:10px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.brand{font-weight:800;font-size:18px;color:#fff;letter-spacing:.3px}
.brand span{color:var(--acc)}
.nav{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}
.nav a{color:var(--mut);padding:8px 10px;border-radius:8px;font-size:14px;font-weight:600}
.nav a.on,.nav a:hover{color:#fff;background:var(--card)}
h1{font-size:22px;margin:6px 0 14px}
h2{font-size:17px;margin:18px 0 10px;color:#fff}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(min-width:760px){.grid{grid-template-columns:repeat(4,1fr)}}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px}
.stat .lbl{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.6px}
.stat .val{font-size:24px;font-weight:800;margin-top:4px}
.stat .sub{font-size:12px;color:var(--mut);margin-top:2px}
.tblwrap{overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--card)}
table{width:100%;border-collapse:collapse;font-size:14px;min-width:640px}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.5px}
tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
form.f .row{margin-bottom:12px}
label{display:block;font-size:13px;color:var(--mut);margin-bottom:5px;font-weight:600}
input,select,textarea{width:100%;background:#0f141b;border:1px solid var(--line);color:var(--txt);border-radius:10px;padding:12px;font-size:16px}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--acc)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.btn{display:inline-block;background:var(--acc);color:#191104;font-weight:800;border:none;border-radius:10px;padding:13px 18px;font-size:16px;cursor:pointer;min-height:48px}
.btn.ghost{background:transparent;color:var(--acc);border:1px solid var(--acc)}
.btn.danger{background:transparent;color:var(--danger);border:1px solid var(--danger)}
.btn.small{padding:8px 12px;font-size:14px;min-height:40px}
.alert{background:#3a2b12;border:1px solid var(--acc);color:#ffd98a;padding:12px;border-radius:10px;margin-bottom:14px;font-size:14px}
.err{background:#3a1717;border:1px solid var(--danger);color:#ffb3b3;padding:12px;border-radius:10px;margin-bottom:14px;font-size:14px}
.okmsg{background:#12362a;border:1px solid var(--acc2);color:#9fe8c6;padding:12px;border-radius:10px;margin-bottom:14px;font-size:14px}
.mut{color:var(--mut);font-size:13px}
.rowflex{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.spacer{flex:1}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;background:#243044;color:var(--mut)}
.pill.green{background:#12362a;color:#9fe8c6}.pill.amber{background:#3a2b12;color:#ffd98a}
/* driver bottom tab bar */
.tabbar{display:none}
body.driver .tabbar{display:flex;position:fixed;bottom:0;left:0;right:0;background:#141b26;border-top:1px solid var(--line);z-index:20}
body.driver .tabbar a{flex:1;text-align:center;padding:12px 4px 14px;color:var(--mut);font-size:12px;font-weight:700}
body.driver .tabbar a.on{color:var(--acc)}
body.driver .wrap{padding-bottom:96px}
.bigstat .val{font-size:32px}
.loginbox{max-width:420px;margin:8vh auto 0}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:14px}
.kv dt{color:var(--mut)}.kv dd{text-align:right;font-variant-numeric:tabular-nums}
code{background:#0f141b;border:1px solid var(--line);padding:2px 6px;border-radius:6px;font-size:13px}
pre{background:#0f141b;border:1px solid var(--line);padding:12px;border-radius:10px;overflow-x:auto;font-size:12.5px}
`;

function navFor(user) {
  if (!user) return '';
  const r = user.role;
  const link = (href, label, active) =>
    `<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`;
  if (r === 'driver') return ''; // drivers use the bottom tab bar
  let links = link('/dashboard', 'Dashboard', '/dashboard')
    + link('/fleet', 'Fleet map', '/fleet')
    + link('/loads', 'Loads', '/loads')
    + link('/expenses', 'Expenses', '/expenses')
    + link('/settlements', 'Settlements', '/settlements');
  if (r === 'owner' || r === 'editor') {
    links += link('/drivers', 'Drivers', '/drivers') + link('/trucks', 'Trucks', '/trucks');
  }
  if (r === 'owner') {
    links += link('/users', 'Users', '/users') + link('/api-docs', 'API', '/api-docs');
  }
  const roleLabel = { owner: 'Owner', editor: 'Dispatcher', viewer: 'Viewer' }[r] || r;
  links += `<a href="/logout">Log out (${esc(user.email)} · ${roleLabel})</a>`;
  return `<div class="nav">${links}</div>`;
}

function tabbar(active) {
  const t = (href, label) =>
    `<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`;
  return `<nav class="tabbar">${t('/driver', '🏠<br>Home')}${t('/driver/loads', '🚛<br>My Loads')}${t('/driver/settlements', '💵<br>Pay')}</nav>`;
}

function layout({ title, user, body, active = '', bare = false }) {
  const bodyClass = user && user.role === 'driver' ? 'driver' : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0f141b">
<title>${esc(title)} · ALGO Express TMS</title>
<style>${CSS}</style></head>
<body class="${bodyClass}">
${bare ? '' : `<header class="topbar"><div class="in">
<div class="brand">ALGO <span>Express</span> TMS</div>${navFor(user)}</div></header>`}
<main class="wrap">${body}</main>
${user && user.role === 'driver' ? tabbar(active) : ''}
</body></html>`;
}

// ---------- shared components ----------
function statCard(label, value, sub) {
  return `<div class="card stat"><div class="lbl">${esc(label)}</div>
<div class="val">${value}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
}

function flash(q) {
  if (q.err) return `<div class="err">${esc(q.err)}</div>`;
  if (q.ok) return `<div class="okmsg">${esc(q.ok)}</div>`;
  return '';
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function docTypePill(t) {
  return t === 'pod'
    ? '<span class="pill green">POD</span>'
    : '<span class="pill amber">Rate con</span>';
}

// Shared document list. docBase is '/documents' for staff, '/driver/documents' for drivers.
function docsTable(docs, { canManage, docBase }) {
  const rows = docs.map(d => `<tr>
<td>${docTypePill(d.doc_type)}</td>
<td>${esc(d.original_name)}</td>
<td class="num">${fmtSize(d.size_bytes)}</td>
<td class="mut">${esc((d.uploaded_at || '').slice(0, 10))}</td>
<td><div class="rowflex">
<a class="btn small ghost" href="${docBase}/${d.id}">View</a>
<a class="btn small ghost" href="${docBase}/${d.id}?download=1">Download</a>
${canManage ? `<form method="post" action="/documents/${d.id}/delete" style="display:inline" onsubmit="return confirm('Delete this document?')"><button class="btn small danger">Delete</button></form>` : ''}
</div></td></tr>`).join('');
  return `<div class="tblwrap"><table>
<tr><th>Type</th><th>File</th><th class="num">Size</th><th>Uploaded</th><th></th></tr>
${rows || '<tr><td colspan="5" class="mut">No documents attached yet.</td></tr>'}</table></div>`;
}

// ---------- auth pages ----------
function setupPage() {
  return layout({
    title: 'Set up', user: null, bare: true,
    body: `<div class="loginbox"><div class="card">
<h1>ALGO Express TMS — first-time setup</h1>
<p class="mut" style="margin-bottom:14px">Create the owner account. You will use this login yourself; you can invite Erica and others afterwards.</p>
<form class="f" method="post" action="/setup">
<div class="row"><label>Email</label><input name="email" type="email" required autocomplete="username"></div>
<div class="row"><label>Password (min 8 characters)</label><input name="password" type="password" minlength="8" required autocomplete="new-password"></div>
<button class="btn" style="width:100%">Create owner account</button>
</form></div></div>`,
  });
}

function loginPage(q = {}) {
  return layout({
    title: 'Log in', user: null, bare: true,
    body: `<div class="loginbox"><div class="card">
<h1>ALGO Express TMS</h1>${flash(q)}
<form class="f" method="post" action="/login">
<div class="row"><label>Email</label><input name="email" type="email" required autocomplete="username"></div>
<div class="row"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>
<button class="btn" style="width:100%">Log in</button>
</form></div></div>`,
  });
}

// ---------- dashboard ----------
function dashboardPage(user, d) {
  const monthOpts = (d.months || recentMonths(12)).map(m =>
    `<option value="${m}" ${m === d.monthYm ? 'selected' : ''}>${esc(monthLabel(m))}</option>`).join('');
  const cards = `
<form method="get" action="/dashboard" class="rowflex" style="margin-bottom:12px">
<label style="margin:0">Month</label>
<select name="month" onchange="this.form.submit()" style="max-width:220px">${monthOpts}</select></form>
<div class="grid">
${statCard('Today', fmtMoney(d.today.revenue), `${d.today.loads} loads`)}
${statCard('This week (Fri–Thu)', fmtMoney(d.week.revenue), `${d.week.loads} loads`)}
${statCard(monthLabel(d.monthYm), fmtMoney(d.month.revenue),
  `${d.month.loads} loads · ${fmtNum(d.month.miles)} mi · ${fmtMoney(d.monthExpenses)} expenses`)}
${statCard('Year to date', fmtMoney(d.ytd.revenue), `${d.ytd.loads} loads · ${fmtNum(d.ytd.miles)} mi`)}
</div>

<h2>Per-truck profit · YTD</h2>
<div class="tblwrap"><table><tr><th>Truck</th><th class="num">Revenue</th><th class="num">Expenses</th><th class="num">Profit</th></tr>
${d.trucks.map(t => `<tr><td>${esc(t.label)}</td><td class="num">${fmtMoney(t.revenue)}</td>
<td class="num">${fmtMoney(t.expenses)}</td><td class="num">${fmtMoney(t.revenue - t.expenses)}</td></tr>`).join('') || '<tr><td colspan="4" class="mut">No data yet.</td></tr>'}
</table></div>

<h2>Per-driver totals · YTD</h2>
<div class="tblwrap"><table><tr><th>Driver</th><th class="num">Loads</th><th class="num">Miles</th><th class="num">Gross</th><th class="num">Pay</th></tr>
${d.drivers.map(x => `<tr><td>${esc(x.name)}</td><td class="num">${x.loads}</td>
<td class="num">${fmtNum(x.miles)}</td><td class="num">${fmtMoney(x.gross)}</td><td class="num">${fmtMoney(x.pay)}</td></tr>`).join('') || '<tr><td colspan="5" class="mut">No data yet.</td></tr>'}
</table></div>

<h2>Expenses by category · YTD</h2>
<div class="tblwrap"><table><tr><th>Category</th><th class="num">Amount</th></tr>
${d.expCats.map(c => `<tr><td style="text-transform:capitalize">${esc(c.category)}</td><td class="num">${fmtMoney(c.total)}</td></tr>`).join('') || '<tr><td colspan="2" class="mut">No data yet.</td></tr>'}
</table></div>

<h2>Expenses by truck · YTD</h2>
<div class="tblwrap"><table><tr><th>Truck</th><th class="num">Amount</th></tr>
${d.expTrucks.map(c => `<tr><td>${esc(c.label)}</td><td class="num">${fmtMoney(c.total)}</td></tr>`).join('') || '<tr><td colspan="2" class="mut">No data yet.</td></tr>'}
</table></div>`;
  return layout({ title: 'Dashboard', user, active: '/dashboard', body: `<h1>Dashboard</h1>${cards}` });
}

// ---------- loads ----------
function loadsPage(user, loads, drivers, trucks, q, docCounts = {}, month = null) {
  const canE = user.role === 'owner' || user.role === 'editor';
  const monthOpts = `<option value="">All months</option>` + recentMonths(12).map(m =>
    `<option value="${m}" ${m === month ? 'selected' : ''}>${esc(monthLabel(m))}</option>`).join('');
  const rows = loads.map(l => {
    const gross = (l.linehaul_cents || 0) + (l.fsc_cents || 0);
    const dc = docCounts[l.id] || 0;
    return `<tr><td><a href="/loads/${l.id}">${esc(fmtDate(l.date))}</a></td>
<td><a href="/loads/${l.id}">${esc(l.origin || '')} → ${esc(l.destination || '')}</a>${dc ? ` <span class="pill">📎 ${dc}</span>` : ''}</td>
<td class="num">${fmtNum((l.loaded_miles || 0) + (l.empty_miles || 0))}</td>
<td class="num">${fmtMoney(gross)}</td><td>${esc(l.driver_name || '—')}</td>
<td>${esc(l.truck_label || '—')}</td><td>${esc(l.broker || '—')}</td>
<td>${canE ? `<a class="btn small ghost" href="/loads/${l.id}/edit">Edit</a>` : ''}</td></tr>`;
  }).join('');
  return layout({
    title: 'Loads', user, active: '/loads',
    body: `${flash(q)}<div class="rowflex"><h1 style="margin:0">Loads</h1><div class="spacer"></div>
<form method="get" action="/loads" style="margin:0"><select name="month" onchange="this.form.submit()" style="max-width:180px">${monthOpts}</select></form>
${canE ? '<a class=\"btn\" href=\"/loads/new\">+ Add load</a>' : ''}</div>
<div class="tblwrap" style="margin-top:12px"><table>
<tr><th>Date</th><th>Lane</th><th class="num">Miles</th><th class="num">Gross</th><th>Driver</th><th>Truck</th><th>Broker</th><th></th></tr>
${rows || '<tr><td colspan="8" class="mut">No loads yet.</td></tr>'}</table></div>`,
  });
}

// Load detail: facts + rate confirmations / PODs. Upload + delete need editor/owner.
function loadDetailPage(user, load, docs, q) {
  const canE = user.role === 'owner' || user.role === 'editor';
  const gross = (load.linehaul_cents || 0) + (load.fsc_cents || 0);
  const body = `${flash(q)}
<div class="rowflex"><h1 style="margin:0">Load — ${esc(fmtDate(load.date))}</h1><div class="spacer"></div>
${canE ? `<a class="btn ghost" href="/loads/${load.id}/edit">Edit load</a>` : ''}
<a class="btn ghost" href="/loads">All loads</a></div>
<div class="card" style="margin-top:12px"><dl class="kv">
<dt>Lane</dt><dd style="text-align:left">${esc(load.origin || '—')} → ${esc(load.destination || '—')}</dd>
<dt>Date</dt><dd>${esc(fmtDate(load.date))}</dd>
<dt>Miles</dt><dd>${fmtNum((load.loaded_miles || 0) + (load.empty_miles || 0))} (${fmtNum(load.loaded_miles || 0)} loaded + ${fmtNum(load.empty_miles || 0)} empty)</dd>
<dt>Linehaul</dt><dd>${fmtMoney(load.linehaul_cents || 0)}</dd>
<dt>Fuel surcharge</dt><dd>${fmtMoney(load.fsc_cents || 0)}</dd>
<dt>Gross</dt><dd><b>${fmtMoney(gross)}</b></dd>
<dt>Broker</dt><dd style="text-align:left">${esc(load.broker || '—')}</dd>
<dt>Driver</dt><dd style="text-align:left">${esc(load.driver_name || '—')}</dd>
<dt>Truck</dt><dd style="text-align:left">${esc(load.truck_label || '—')}</dd>
<dt>Status</dt><dd style="text-align:left">${esc(load.status || '')}</dd>
${load.notes ? `<dt>Notes</dt><dd style="text-align:left">${esc(load.notes)}</dd>` : ''}
</dl></div>
<h2>Documents — rate confirmations &amp; PODs</h2>
${docsTable(docs, { canManage: canE, docBase: '/documents' })}
${canE ? `<h2>Attach documents</h2>
<form class="f card" method="post" action="/loads/${load.id}/documents" enctype="multipart/form-data">
<div class="two">
<div class="row"><label>Document type</label><select name="doc_type">
<option value="ratecon">Rate confirmation</option>
<option value="pod">Proof of delivery (POD)</option></select></div>
<div class="row"><label>Files — PDF, JPG, or PNG, max 10MB each</label>
<input type="file" name="files" multiple accept=".pdf,.jpg,.jpeg,.png" required></div></div>
<button class="btn">Upload</button>
<p class="mut" style="margin-top:8px">Upload the rate confirmation when the load is booked, and the POD when it delivers.</p>
</form>` : ''}`;
  return layout({ title: 'Load detail', user, active: '/loads', body });
}

function loadForm(l, drivers, trucks, q, isEdit) {
  const drvOpts = drivers.map(d =>
    `<option value="${d.id}" ${l.driver_id == d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  const trkOpts = trucks.map(t => {
    const lbl = t.unit_number || `${t.year || ''} ${t.make || ''} ${t.model || ''}`.trim();
    return `<option value="${t.id}" ${l.truck_id == t.id ? 'selected' : ''}>${esc(lbl)} (${t.type})</option>`;
  }).join('');
  return `<h1>${isEdit ? 'Edit load' : 'Add load'}</h1>${flash(q)}
<form class="f card" method="post" action="${isEdit ? '/loads/' + l.id + '/edit' : '/loads/new'}">
<div class="two">
<div class="row"><label>Date</label><input name="date" type="date" required value="${esc(l.date || '')}"></div>
<div class="row"><label>Status</label><select name="status">
${['delivered', 'in_transit', 'booked', 'cancelled'].map(s => `<option ${l.status === s ? 'selected' : ''}>${s}</option>`).join('')}
</select></div></div>
<div class="two">
<div class="row"><label>Origin</label><input name="origin" value="${esc(l.origin || '')}" placeholder="Decatur, GA"></div>
<div class="row"><label>Destination</label><input name="destination" value="${esc(l.destination || '')}" placeholder="Stone Mountain, GA"></div></div>
<div class="two">
<div class="row"><label>Loaded miles</label><input name="loaded_miles" type="number" step="0.1" min="0" value="${esc(l.loaded_miles || '')}"></div>
<div class="row"><label>Empty miles</label><input name="empty_miles" type="number" step="0.1" min="0" value="${esc(l.empty_miles || '')}"></div></div>
<div class="two">
<div class="row"><label>Linehaul $</label><input name="linehaul" type="number" step="0.01" min="0" value="${l.linehaul_cents != null ? esc((l.linehaul_cents / 100).toFixed(2)) : ''}"></div>
<div class="row"><label>Fuel surcharge $</label><input name="fsc" type="number" step="0.01" min="0" value="${l.fsc_cents != null ? esc((l.fsc_cents / 100).toFixed(2)) : ''}"></div></div>
<div class="two">
<div class="row"><label>Broker / shipper</label><input name="broker" value="${esc(l.broker || '')}"></div>
<div class="row"><label>External ID (sheet sync)</label><input name="external_id" value="${esc(l.external_id || '')}"></div></div>
<div class="two">
<div class="row"><label>Driver</label><select name="driver_id"><option value="">—</option>${drvOpts}</select></div>
<div class="row"><label>Truck</label><select name="truck_id"><option value="">—</option>${trkOpts}</select></div></div>
<div class="row"><label>Notes</label><textarea name="notes" rows="2">${esc(l.notes || '')}</textarea></div>
<button class="btn">Save load</button>
<a class="btn ghost" href="/loads" style="margin-left:8px">Cancel</a></form>`;
}

// ---------- expenses ----------
function expensesPage(user, expenses, q) {
  const canE = user.role === 'owner' || user.role === 'editor';
  const rows = expenses.map(e => `<tr><td>${esc(fmtDate(e.date))}</td>
<td style="text-transform:capitalize">${esc(e.category)}</td><td>${esc(e.truck_label || '—')}</td>
<td class="num">${fmtMoney(e.amount_cents)}</td><td>${esc(e.notes || '')}</td>
<td>${canE ? `<a class="btn small ghost" href="/expenses/${e.id}/edit">Edit</a>` : ''}</td></tr>`).join('');
  return layout({
    title: 'Expenses', user, active: '/expenses',
    body: `${flash(q)}<div class="rowflex"><h1 style="margin:0">Expenses</h1><div class="spacer"></div>
${canE ? '<a class="btn" href="/expenses/new">+ Add expense</a>' : ''}</div>
<div class="tblwrap" style="margin-top:12px"><table>
<tr><th>Date</th><th>Category</th><th>Truck</th><th class="num">Amount</th><th>Notes</th><th></th></tr>
${rows || '<tr><td colspan="6" class="mut">No expenses yet.</td></tr>'}</table></div>`,
  });
}

function expenseForm(e, trucks, q, isEdit) {
  const trkOpts = trucks.map(t => {
    const lbl = t.unit_number || `${t.year || ''} ${t.make || ''} ${t.model || ''}`.trim();
    return `<option value="${t.id}" ${e.truck_id == t.id ? 'selected' : ''}>${esc(lbl)} (${t.type})</option>`;
  }).join('');
  const cats = ['fuel', 'maintenance', 'insurance', 'tolls', 'other'];
  return `<h1>${isEdit ? 'Edit expense' : 'Add expense'}</h1>${flash(q)}
<form class="f card" method="post" action="${isEdit ? '/expenses/' + e.id + '/edit' : '/expenses/new'}">
<div class="two">
<div class="row"><label>Date</label><input name="date" type="date" required value="${esc(e.date || '')}"></div>
<div class="row"><label>Category</label><select name="category">
${cats.map(c => `<option value="${c}" ${e.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>
<div class="two">
<div class="row"><label>Truck</label><select name="truck_id"><option value="">—</option>${trkOpts}</select></div>
<div class="row"><label>Amount $</label><input name="amount" type="number" step="0.01" min="0" required value="${e.amount_cents != null ? esc((e.amount_cents / 100).toFixed(2)) : ''}"></div></div>
<div class="two">
<div class="row"><label>Gallons (fuel only, for IFTA)</label><input name="gallons" type="number" step="0.001" min="0" value="${e.gallons != null ? esc(String(e.gallons)) : ''}"></div>
<div class="row"><label>Fuel state (IFTA, 2 letters)</label><input name="fuel_state" maxlength="2" style="text-transform:uppercase" value="${esc(e.fuel_state || '')}" placeholder="GA"></div></div>
<div class="row"><label>External ID (sheet sync)</label><input name="external_id" value="${esc(e.external_id || '')}"></div>
<div class="row"><label>Notes</label><textarea name="notes" rows="2">${esc(e.notes || '')}</textarea></div>
<button class="btn">Save expense</button>
<a class="btn ghost" href="/expenses" style="margin-left:8px">Cancel</a></form>`;
}

// ---------- settlements ----------
function settlementsPage(user, weekStart, weeks, rows, q) {
  const groups = {};
  weeks.forEach(w => { const k = w.slice(0, 7); (groups[k] = groups[k] || []).push(w); });
  const opts = Object.keys(groups).map(k =>
    `<optgroup label="${esc(monthLabel(k))}">` + groups[k].map(w =>
      `<option value="${w}" ${w === weekStart ? 'selected' : ''}>${esc(fmtWeekRange(w))}</option>`
    ).join('') + `</optgroup>`).join('');
  const body = rows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.loads}</td>
<td class="num">${fmtNum(r.miles)}</td><td class="num">${fmtMoney(r.gross)}</td>
<td class="num">${fmtMoney(r.pay)}<div class="mut" style="font-size:11px">${esc(r.pay_basis || '')}</div></td><td class="num">${fmtMoney(r.ytd_pay)}</td>
<td class="num">${r.ytd_loads}</td></tr>`).join('');
  return layout({
    title: 'Settlements', user, active: '/settlements',
    body: `<h1>Settlements</h1>
<p class="mut" style="margin-bottom:10px">Settlement week runs <b>Friday → Thursday</b>. Driver pay = gross × pay % <i>or</i> loaded miles × per-mile rate, per each driver's terms.</p>
${flash(q)}
<form method="get" action="/settlements" class="rowflex" style="margin-bottom:12px">
<label style="margin:0">Week</label>
<select name="week" onchange="this.form.submit()" style="max-width:320px">${opts}</select></form>
<div class="tblwrap"><table>
<tr><th>Driver</th><th class="num">Loads</th><th class="num">Miles</th><th class="num">Gross</th><th class="num">Pay</th><th class="num">YTD pay</th><th class="num">YTD loads</th></tr>
${body || '<tr><td colspan="7" class="mut">No loads this week.</td></tr>'}</table></div>`,
  });
}

// ---------- drivers & trucks ----------
function driversPage(user, drivers, q) {
  const rows = drivers.map(d => {
    const payLabel = d.pay_type === 'per_mile' && Number(d.pay_rate) > 0
      ? `$${Number(d.pay_rate).toFixed(2)}/mi` : `${d.pay_pct}%`;
    return `<tr><td>${esc(d.name)}</td><td>${esc(d.phone || '—')}</td>
<td class="num">${payLabel}</td>
<td><span class="pill ${d.status === 'active' ? 'green' : ''}">${esc(d.status)}</span></td>
<td><a class="btn small ghost" href="/drivers/${d.id}/edit">Edit</a></td></tr>`;
  }).join('');
  return layout({
    title: 'Drivers', user, active: '/drivers',
    body: `${flash(q)}<div class="rowflex"><h1 style="margin:0">Drivers</h1><div class="spacer"></div>
<a class="btn" href="/drivers/new">+ Add driver</a></div>
<div class="tblwrap" style="margin-top:12px"><table>
<tr><th>Name</th><th>Phone</th><th class="num">Pay</th><th>Status</th><th></th></tr>
${rows || '<tr><td colspan="5" class="mut">No drivers yet.</td></tr>'}</table></div>`,
  });
}

function driverForm(d, q, isEdit) {
  return `<h1>${isEdit ? 'Edit driver' : 'Add driver'}</h1>${flash(q)}
<form class="f card" method="post" action="${isEdit ? '/drivers/' + d.id + '/edit' : '/drivers/new'}">
<div class="two">
<div class="row"><label>Name</label><input name="name" required value="${esc(d.name || '')}"></div>
<div class="row"><label>Phone</label><input name="phone" value="${esc(d.phone || '')}"></div></div>
<div class="two">
<div class="row"><label>Pay type</label><select name="pay_type">
${['percent', 'per_mile'].map(s => `<option value="${s}" ${d.pay_type === s ? 'selected' : ''}>${s === 'per_mile' ? 'Per mile' : '% of gross'}</option>`).join('')}</select></div>
<div class="row"><label>Pay % of gross</label><input name="pay_pct" type="number" step="0.1" min="0" max="100" value="${esc(d.pay_pct ?? 30)}"></div></div>
<div class="row"><label>Per-mile rate ($/loaded mi, only if pay type is Per mile)</label><input name="pay_rate" type="number" step="0.01" min="0" value="${esc(d.pay_rate ?? '')}" placeholder="0.65"></div>
<div class="two">
<div class="row"><label>Status</label><select name="status">
${['active', 'inactive'].map(s => `<option ${d.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div>
<div class="row"><label>Notes</label><textarea name="notes" rows="2">${esc(d.notes || '')}</textarea></div>
<button class="btn">Save driver</button>
<a class="btn ghost" href="/drivers" style="margin-left:8px">Cancel</a></form>`;
}

function trucksPage(user, trucks, q) {
  const rows = trucks.map(t => {
    const lbl = t.unit_number ? `#${esc(t.unit_number)} — ` : '';
    return `<tr><td>${lbl}${esc([t.year, t.make, t.model].filter(Boolean).join(' '))}</td>
<td style="text-transform:capitalize">${esc(t.type)}</td><td><code>${esc(t.vin || '—')}</code></td>
<td><span class="pill ${t.status === 'active' ? 'green' : ''}">${esc(t.status)}</span></td>
<td><a class="btn small ghost" href="/trucks/${t.id}/edit">Edit</a></td></tr>`;
  }).join('');
  return layout({
    title: 'Trucks', user, active: '/trucks',
    body: `${flash(q)}<div class="rowflex"><h1 style="margin:0">Equipment</h1><div class="spacer"></div>
<a class="btn" href="/trucks/new">+ Add unit</a></div>
<div class="tblwrap" style="margin-top:12px"><table>
<tr><th>Unit</th><th>Type</th><th>VIN</th><th>Status</th><th></th></tr>
${rows || '<tr><td colspan="5" class="mut">No equipment yet.</td></tr>'}</table></div>`,
  });
}

function truckForm(t, q, isEdit) {
  return `<h1>${isEdit ? 'Edit unit' : 'Add unit'}</h1>${flash(q)}
<form class="f card" method="post" action="${isEdit ? '/trucks/' + t.id + '/edit' : '/trucks/new'}">
<div class="two">
<div class="row"><label>Unit #</label><input name="unit_number" value="${esc(t.unit_number || '')}" placeholder="e.g. 101"></div>
<div class="row"><label>Type</label><select name="type">
${['tractor', 'trailer'].map(s => `<option value="${s}" ${t.type === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div>
<div class="two">
<div class="row"><label>Year</label><input name="year" type="number" value="${esc(t.year || '')}"></div>
<div class="row"><label>Make</label><input name="make" value="${esc(t.make || '')}"></div></div>
<div class="two">
<div class="row"><label>Model</label><input name="model" value="${esc(t.model || '')}"></div>
<div class="row"><label>VIN</label><input name="vin" value="${esc(t.vin || '')}"></div></div>
<div class="row"><label>Trailer description (for tractors)</label><input name="trailer_desc" value="${esc(t.trailer_desc || '')}"></div>
<div class="row"><label>Status</label><select name="status">
${['active', 'inactive', 'shop'].map(s => `<option ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
<div class="row"><label>Notes</label><textarea name="notes" rows="2">${esc(t.notes || '')}</textarea></div>
<button class="btn">Save unit</button>
<a class="btn ghost" href="/trucks" style="margin-left:8px">Cancel</a></form>`;
}

// ---------- users (owner) ----------
function usersPage(user, users, drivers, q, newKey) {
  const rows = users.map(u => `<tr><td>${esc(u.email)}</td><td style="text-transform:capitalize">${esc(u.role)}</td>
<td>${esc(u.driver_name || '—')}</td>
<td><span class="pill ${u.active ? 'green' : ''}">${u.active ? 'active' : 'disabled'}</span></td>
<td class="mut">${esc((u.created_at || '').slice(0, 10))}</td>
<td>${u.id !== user.id ? `<form method="post" action="/users/${u.id}/toggle" style="display:inline">
<button class="btn small ghost">${u.active ? 'Disable' : 'Enable'}</button></form>` : '<span class="mut">you</span>'}</td></tr>`).join('');
  const drvOpts = drivers.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  return layout({
    title: 'Users', user, active: '/users',
    body: `<h1>Users & access</h1>${flash(q)}
${newKey ? `<div class="okmsg">New API key (shown once — copy it now):<br><code>${esc(newKey)}</code></div>` : ''}
<div class="tblwrap"><table>
<tr><th>Email</th><th>Role</th><th>Driver</th><th>Status</th><th>Added</th><th></th></tr>${rows}</table></div>
<h2>Invite someone</h2>
<form class="f card" method="post" action="/users/new">
<div class="two">
<div class="row"><label>Email</label><input name="email" type="email" required></div>
<div class="row"><label>Temporary password</label><input name="password" required minlength="8"></div></div>
<div class="two">
<div class="row"><label>Role</label><select name="role" id="roleSel" onchange="document.getElementById('drvRow').style.display=this.value==='driver'?'block':'none'">
<option value="editor">Editor — dispatch (Erica): add/edit everything</option>
<option value="viewer">Viewer — read-only dashboards</option>
<option value="driver">Driver — sees only their own numbers</option>
<option value="owner">Owner — full access</option></select></div>
<div class="row" id="drvRow" style="display:none"><label>Linked driver (required for Driver role)</label>
<select name="driver_id"><option value="">— pick driver —</option>${drvOpts}</select></div></div>
<button class="btn">Create login</button></form>
<h2>API keys</h2>
<p class="mut" style="margin-bottom:10px">Used by the daily sheet-sync job. Keys are shown once.</p>
<form method="post" action="/api-keys" class="rowflex" style="margin-bottom:10px">
<input name="name" placeholder="Key name (e.g. sheet-sync)" required style="max-width:260px">
<button class="btn small">Generate key</button></form>`,
  });
}

// ---------- driver-facing pages (mobile-first, own data only) ----------
function driverHome(user, s) {
  const trip = s.trip;
  const loadOpts = (s.openLoads || []).map(l =>
    `<option value="${l.id}">${esc(fmtDate(l.date))} · ${esc(l.origin || '')} → ${esc(l.destination || '')}</option>`).join('');
  const tripCard = trip ? `
<div class="card" style="margin-bottom:12px">
<p style="margin:0 0 6px"><span class="pill green">● LIVE</span> <b>Trip active — sharing your location</b></p>
<p class="mut" style="margin:0 0 8px">Keep this page open while driving. iPhones stop sharing when the screen locks. Location stops when you end the trip.</p>
<form method="post" action="/driver/trip/end"><button class="btn danger">End trip</button></form>
<div id="tripstatus" class="mut" style="margin-top:8px"></div></div>
<script>(function(){
var el=document.getElementById('tripstatus');
if(!navigator.geolocation){el.textContent='Location not supported on this device.';return;}
var lastSent=0;
function send(pos){
  var now=Date.now(); if(now-lastSent<45000) return; lastSent=now;
  fetch('/driver/position',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({lat:pos.coords.latitude,lon:pos.coords.longitude,
      accuracy:pos.coords.accuracy,speed:pos.coords.speed,heading:pos.coords.heading})})
    .then(function(r){return r.json();}).then(function(j){
      el.textContent=j.ok?('Sharing ✓ '+new Date().toLocaleTimeString()):'Trip ended.';})
    .catch(function(){el.textContent='Connection issue — will retry.';});
}
navigator.geolocation.watchPosition(send,
  function(){el.textContent='Location permission needed — allow location access for this site.';},
  {enableHighAccuracy:true,maximumAge:30000,timeout:20000});
})();</script>` : `
<div class="card" style="margin-bottom:12px">
<p style="margin:0 0 8px"><b>Trip tracking</b></p>
<p class="mut" style="margin:0 0 8px">Start a trip when you roll. Dispatch sees your live location until you end it.</p>
<form method="post" action="/driver/trip/start"><div class="row">
<label>Load (optional)</label><select name="load_id"><option value="">Just driving / positioning</option>${loadOpts}</select></div>
<button class="btn">Start trip</button></form></div>`;
  const body = `
<h1 style="font-size:20px">Hi, ${esc(user.driver_name || 'driver')} 👋</h1>
<p class="mut" style="margin-bottom:12px">Week of ${esc(fmtWeekRange(s.weekStart))} · Fri–Thu</p>
${tripCard}
<div class="grid bigstat">
${statCard('This week pay', fmtMoney(s.week.pay), `${s.week.loads} loads`)}
${statCard('This week miles', fmtNum(s.week.miles), fmtMoney(s.week.gross) + ' gross')}
</div>
<h2>Year to date</h2>
<div class="grid bigstat">
${statCard('YTD pay', fmtMoney(s.ytd.pay), `${s.ytd.loads} loads`)}
${statCard('YTD miles', fmtNum(s.ytd.miles), fmtMoney(s.ytd.gross) + ' gross')}
</div>
<h2>Recent loads</h2>
<div class="tblwrap"><table>
<tr><th>Date</th><th>Lane</th><th class="num">Miles</th><th class="num">Gross</th></tr>
${s.recent.map(l => `<tr><td>${esc(fmtDate(l.date))}</td>
<td>${esc(l.origin || '')} → ${esc(l.destination || '')}</td>
<td class="num">${fmtNum((l.loaded_miles || 0) + (l.empty_miles || 0))}</td>
<td class="num">${fmtMoney((l.linehaul_cents || 0) + (l.fsc_cents || 0))}</td></tr>`).join('')
  || '<tr><td colspan="4" class="mut">No loads yet.</td></tr>'}
</table></div>`;
  return layout({ title: 'My dashboard', user, active: '/driver', body });
}

function driverLoads(user, loads) {
  const rows = loads.map(l => `<tr><td><a href="/driver/loads/${l.id}">${esc(fmtDate(l.date))}</a></td>
<td><a href="/driver/loads/${l.id}">${esc(l.origin || '')} → ${esc(l.destination || '')}</a></td>
<td class="num">${fmtNum((l.loaded_miles || 0) + (l.empty_miles || 0))}</td>
<td class="num">${fmtMoney((l.linehaul_cents || 0) + (l.fsc_cents || 0))}</td>
<td>${esc(l.status || '')}</td></tr>`).join('');
  return layout({
    title: 'My loads', user, active: '/driver/loads',
    body: `<h1>My loads</h1><p class="mut" style="margin-bottom:10px">Tap a load to see its rate confirmation and POD documents.</p>
<div class="tblwrap"><table>
<tr><th>Date</th><th>Lane</th><th class="num">Miles</th><th class="num">Gross</th><th>Status</th></tr>
${rows || '<tr><td colspan="5" class="mut">No loads yet.</td></tr>'}</table></div>`,
  });
}

// Driver load detail — facts plus the driver's own rate con / POD documents.
function driverLoadDetail(user, load, docs) {
  const gross = (load.linehaul_cents || 0) + (load.fsc_cents || 0);
  const body = `<h1 style="font-size:20px">${esc(load.origin || '')} → ${esc(load.destination || '')}</h1>
<p class="mut" style="margin-bottom:12px">${esc(fmtDate(load.date))}</p>
<div class="card"><dl class="kv">
<dt>Miles</dt><dd>${fmtNum((load.loaded_miles || 0) + (load.empty_miles || 0))}</dd>
<dt>Gross</dt><dd><b>${fmtMoney(gross)}</b></dd>
<dt>Status</dt><dd style="text-align:left">${esc(load.status || '')}</dd>
</dl></div>
<h2>Documents</h2>
${docsTable(docs, { canManage: false, docBase: '/driver/documents' })}`;
  return layout({ title: 'Load detail', user, active: '/driver/loads', body });
}

function driverSettlements(user, weeks) {
  const rows = weeks.map(w => `<tr><td>${esc(fmtWeekRange(w.weekStart))}</td>
<td class="num">${w.loads}</td><td class="num">${fmtNum(w.miles)}</td>
<td class="num">${fmtMoney(w.gross)}</td><td class="num"><b>${fmtMoney(w.pay)}</b><div class="mut" style="font-size:11px">${esc(w.pay_basis || '')}</div></td></tr>`).join('');
  return layout({
    title: 'My settlements', user, active: '/driver/settlements',
    body: `<h1>My settlements</h1>
<p class="mut" style="margin-bottom:10px">Settlement week runs <b>Friday → Thursday</b>.</p>
<div class="tblwrap"><table>
<tr><th>Week</th><th class="num">Loads</th><th class="num">Miles</th><th class="num">Gross</th><th class="num">Pay</th></tr>
${rows || '<tr><td colspan="5" class="mut">No settlements yet.</td></tr>'}</table></div>`,
  });
}

// ---------- fleet map (live trip tracking) ----------
function fleetPage(user) {
  return layout({
    title: 'Fleet map', user, active: '/fleet',
    body: `<h1>Fleet map</h1>
<p class="mut" style="margin-bottom:10px">Live positions from drivers' phones — only while a trip is active. Refreshes every 30 seconds.</p>
<div id="fleetmap" style="height:55vh;min-height:320px;border-radius:12px;z-index:0"></div>
<div id="fleetlist" style="margin-top:12px"></div>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>(function(){
var map=L.map('fleetmap').setView([33.75,-84.39],6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
var markers={};
function ago(iso){
  if(!iso) return 'no fix yet';
  var s=Math.floor((Date.now()-new Date(iso.replace(' ','T')+'Z'))/1000);
  if(s<60) return s+'s ago'; var m=Math.floor(s/60);
  if(m<60) return m+'m ago'; return Math.floor(m/60)+'h '+(m%60)+'m ago';
}
function refresh(){
  fetch('/fleet/data').then(function(r){return r.json();}).then(function(d){
    var seen={}, html='';
    d.trips.forEach(function(t){
      seen[t.trip_id]=1;
      var lane=t.origin?(' · '+t.origin+' → '+t.destination):'';
      var mph=(t.speed!=null)?Math.round(t.speed)+' mph · ':'';
      html+='<div class="card" style="margin-bottom:8px"><b>'+t.driver_name+'</b>'+lane+
        '<div class="mut">'+mph+ago(t.recorded_at)+' · '+t.fixes+' fixes</div></div>';
      if(t.lat!=null){
        var popup='<b>'+t.driver_name+'</b>'+(t.origin?('<br>'+t.origin+' → '+t.destination):'')+
          '<br>'+mph+ago(t.recorded_at);
        if(markers[t.trip_id]){markers[t.trip_id].setLatLng([t.lat,t.lon]).setPopupContent(popup);}
        else{markers[t.trip_id]=L.marker([t.lat,t.lon]).addTo(map).bindPopup(popup);}
      }
    });
    Object.keys(markers).forEach(function(k){ if(!seen[k]){map.removeLayer(markers[k]);delete markers[k];} });
    document.getElementById('fleetlist').innerHTML=html||'<p class="mut">No active trips right now.</p>';
  }).catch(function(){});
}
refresh(); setInterval(refresh,30000);
})();</script>`,
  });
}

// ---------- API docs ----------
function apiDocsPage(user, keys) {
  const rows = keys.map(k => `<tr><td>${esc(k.name)}</td><td class="mut">${esc((k.created_at || '').slice(0, 10))}</td>
<td><form method="post" action="/api-keys/${k.id}/delete" onsubmit="return confirm('Delete this key?')">
<button class="btn small danger">Delete</button></form></td></tr>`).join('');
  return layout({
    title: 'API', user, active: '/api-docs',
    body: `<h1>API — sheet sync</h1>
<p class="mut" style="margin-bottom:10px">The daily job pushes Erica's spreadsheet rows through these endpoints.
Authenticate with header <code>X-API-Key</code>. Money is in <b>dollars</b> (decimals ok); the API stores cents.</p>
<h2>POST /api/v1/loads/upsert</h2>
<pre>{
  "external_id": "sheet-row-123",   // optional; when present the row is updated not duplicated
  "date": "2026-10-18",             // required, YYYY-MM-DD
  "origin": "Decatur, GA",
  "destination": "Stone Mountain, GA",
  "loaded_miles": 10,
  "empty_miles": 5,
  "linehaul": 400.00,               // dollars
  "fuel_surcharge": 96.40,          // dollars, stored separately from linehaul
  "broker": "PLS",
  "driver": "Jason Clark",          // driver name (or driver_id)
  "truck": "101",                   // unit_number (or truck_id)
  "status": "delivered",            // booked | in_transit | delivered | cancelled
  "notes": ""
}</pre>
<h2>POST /api/v1/expenses/upsert</h2>
<pre>{
  "external_id": "sheet-row-456",
  "date": "2026-10-18",             // required, YYYY-MM-DD
  "truck": "101",                   // unit_number (or truck_id)
  "category": "fuel",               // fuel | maintenance | insurance | tolls | other
  "amount": 226.10,                 // required, dollars
  "notes": "Pilot, I-20"
}</pre>
<h2>GET /api/v1/health</h2>
<p class="mut">No auth. Returns <code>{"ok": true}</code>.</p>
<h2>Keys</h2>
<div class="tblwrap"><table><tr><th>Name</th><th>Created</th><th></th></tr>
${rows || '<tr><td colspan="3" class="mut">No keys yet — generate one on the Users page.</td></tr>'}</table></div>`,
  });
}

module.exports = {
  esc, layout, flash,
  setupPage, loginPage,
  dashboardPage, loadsPage, loadForm, loadDetailPage,
  expensesPage, expenseForm,
  settlementsPage, driversPage, driverForm, trucksPage, truckForm,
  usersPage, apiDocsPage,
  driverHome, driverLoads, driverLoadDetail, driverSettlements,
};
