// agents.js — AI agents inside the TMS (AGENTS-DESIGN.md, Phase 1).
//
// Pattern: agents PROPOSE, Tree APPROVES. Every proposal lands in
// agent_actions with its exact payload + evidence; every run, decision and
// execution writes to the append-only agent_shift_log. The executor is the
// hard gate: it applies ONLY actions in 'approved' state, and there is no
// code path from proposal to applied that skips approval for
// money-adjacent or outbound kinds (they can never be auto-applied).
//
// Phase 1 scope, honestly bounded by what exists in this codebase:
//  - Finance scan: delivered loads -> invoice_draft proposals (POD on
//    file) and pod_flag proposals (no POD — Tree's same-day flag rule).
//  - Safety scan: TMS-internal audit-exposure task list (delivered loads
//    with no delivery date, held factoring invoices). There is NO Motive
//    API in this codebase (positions arrive as snapshots), so ELD log
//    checks are a documented stub — the Safety agent never reads, changes
//    or certifies a log here, and log_annotation execution only records
//    the annotation text in the shift log as the proposal of record.
//  - Operations executor: ratecon_entry applies through db.upsertLoad with
//    the external_id discipline (driver never guessed — the payload must
//    carry the load exactly as proposed and approved).
// External hooks (Motive writes, Gmail sends, RTS submission) are stubs:
// kinds without a real internal applier fail execution with that reason
// recorded, never a fake success.

'use strict';

const db = require('./db');
const factoring = require('./factoring');

const T = () => db.TENANT;

const AGENTS = {
  finance: { label: 'Finance', blurb: 'Drafts factoring invoices on delivery, flags missing PODs the same day, drafts settlements on Thursdays. Never submits, never pays.' },
  safety: { label: 'Safety', blurb: 'Nightly audit-exposure pass: missing delivery dates, held invoices, document gaps. Proposes annotations and tasks only — never changes or certifies a log.' },
  operations: { label: 'Operations', blurb: 'Rate-con load entry proposals (external_id load-<LOAD#>, driver never guessed) and dispatch-board freshness.' },
  fuel_ifta: { label: 'Fuel & IFTA', blurb: 'Fuel statement imports and miles-by-state — arrives with the Motive breadcrumb import (stub in Phase 1).' },
  loads: { label: 'Loads', blurb: 'Priced load options by the position-first method. Never bids or books (stub in Phase 1).' },
};

// Approval-required FOREVER — auto-apply can never be enabled for these.
const HARD_GATED_KINDS = ['settlement_draft', 'factoring_submit', 'outbound_message', 'west_safety_post'];

function agentsEnabled(tenantId = T()) {
  return db.getMeta('agents_enabled') !== '0';
}
function setAgentsEnabled(on) {
  db.setMeta('agents_enabled', on ? '1' : '0');
}
// Per-kind auto-apply config (meta JSON). Default: everything OFF, and
// hard-gated kinds are refused no matter what the config says.
function autoApplyKinds() {
  try { return JSON.parse(db.getMeta('agent_auto_apply') || '{}') || {}; }
  catch (e) { return {}; }
}
function setAutoApply(kind, on) {
  if (HARD_GATED_KINDS.includes(kind)) return { ok: false, error: `${kind} is approval-required forever and cannot be auto-applied.` };
  const cfg = autoApplyKinds();
  if (on) cfg[kind] = true; else delete cfg[kind];
  db.setMeta('agent_auto_apply', JSON.stringify(cfg));
  return { ok: true, config: cfg };
}
function isAutoApply(kind) {
  if (HARD_GATED_KINDS.includes(kind)) return false;
  return !!autoApplyKinds()[kind];
}

function logEvent(agent, event, detail, actionId = null, tenantId = T()) {
  db.db.prepare(`INSERT INTO agent_shift_log (tenant_id, agent, event, detail, action_id)
    VALUES (?,?,?,?,?)`).run(tenantId, agent, event, detail || null, actionId);
}
function listLog({ agent = null, limit = 200 } = {}, tenantId = T()) {
  const base = 'SELECT * FROM agent_shift_log WHERE tenant_id = ?';
  const rows = agent
    ? db.db.prepare(base + ' AND agent = ? ORDER BY id DESC LIMIT ?').all(tenantId, agent, limit)
    : db.db.prepare(base + ' ORDER BY id DESC LIMIT ?').all(tenantId, limit);
  return rows;
}

// File a proposal. Payload + evidence are stored verbatim (JSON) so the
// owner sees the EXACT change before approving. If the kind is configured
// auto-apply (never for hard-gated kinds), it is approved by 'auto-apply'
// and executed immediately — the shift log shows both steps.
function propose({ agent, kind, summary, payload, evidence }, tenantId = T()) {
  if (!AGENTS[agent]) return { ok: false, error: `unknown agent '${agent}'` };
  if (!kind || !summary) return { ok: false, error: 'kind and summary are required' };
  const r = db.db.prepare(`INSERT INTO agent_actions
      (tenant_id, agent, kind, summary, payload, evidence)
      VALUES (?,?,?,?,?,?)`)
    .run(tenantId, agent, kind, summary,
      JSON.stringify(payload || {}), evidence ? JSON.stringify(evidence) : null);
  const action = getAction(r.lastInsertRowid, tenantId);
  logEvent(agent, 'proposed', summary, action.id, tenantId);
  if (isAutoApply(kind)) {
    approve(action.id, 'auto-apply (Tree config)', tenantId);
    const ex = execute(action.id, tenantId);
    return { ok: true, action: getAction(action.id, tenantId), autoApplied: ex.ok };
  }
  return { ok: true, action };
}

function getAction(id, tenantId = T()) {
  const a = db.db.prepare('SELECT * FROM agent_actions WHERE id = ? AND tenant_id = ?')
    .get(id, tenantId);
  if (!a) return null;
  try { a.payload_obj = JSON.parse(a.payload); } catch (e) { a.payload_obj = null; }
  try { a.evidence_obj = a.evidence ? JSON.parse(a.evidence) : null; } catch (e) { a.evidence_obj = null; }
  return a;
}
function listActions({ status = null, agent = null, limit = 200 } = {}, tenantId = T()) {
  let sql = 'SELECT * FROM agent_actions WHERE tenant_id = ?';
  const params = [tenantId];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (agent) { sql += ' AND agent = ?'; params.push(agent); }
  sql += ' ORDER BY id DESC LIMIT ?'; params.push(limit);
  return db.db.prepare(sql).all(...params).map(a => {
    try { a.payload_obj = JSON.parse(a.payload); } catch (e) { a.payload_obj = null; }
    try { a.evidence_obj = a.evidence ? JSON.parse(a.evidence) : null; } catch (e) { a.evidence_obj = null; }
    return a;
  });
}
function counts(tenantId = T()) {
  const rows = db.db.prepare(
    'SELECT status, COUNT(*) AS n FROM agent_actions WHERE tenant_id = ? GROUP BY status').all(tenantId);
  const by = {};
  for (const r of rows) by[r.status] = r.n;
  return by;
}

function approve(id, by, tenantId = T()) {
  const a = getAction(id, tenantId);
  if (!a) return { ok: false, error: 'Action not found.' };
  if (a.status !== 'proposed') return { ok: false, error: `Action is ${a.status}, not proposed.` };
  db.db.prepare(`UPDATE agent_actions SET status = 'approved', decided_by = ?,
    decided_at = datetime('now') WHERE id = ? AND tenant_id = ?`).run(by || 'owner', id, tenantId);
  logEvent(a.agent, 'approved', a.summary, id, tenantId);
  return { ok: true, action: getAction(id, tenantId) };
}
function reject(id, by, tenantId = T()) {
  const a = getAction(id, tenantId);
  if (!a) return { ok: false, error: 'Action not found.' };
  if (a.status !== 'proposed') return { ok: false, error: `Action is ${a.status}, not proposed.` };
  db.db.prepare(`UPDATE agent_actions SET status = 'rejected', decided_by = ?,
    decided_at = datetime('now') WHERE id = ? AND tenant_id = ?`).run(by || 'owner', id, tenantId);
  logEvent(a.agent, 'rejected', a.summary, id, tenantId);
  return { ok: true, action: getAction(id, tenantId) };
}

function markApplied(a, result, tenantId) {
  db.db.prepare(`UPDATE agent_actions SET status = 'applied', applied_at = datetime('now'),
    result = ? WHERE id = ? AND tenant_id = ?`).run(result, a.id, tenantId);
  logEvent(a.agent, 'applied', `${a.summary} — ${result}`, a.id, tenantId);
  return { ok: true, action: getAction(a.id, tenantId) };
}
function markFailed(a, result, tenantId) {
  db.db.prepare(`UPDATE agent_actions SET status = 'failed', result = ? WHERE id = ? AND tenant_id = ?`)
    .run(result, a.id, tenantId);
  logEvent(a.agent, 'error', `${a.summary} — ${result}`, a.id, tenantId);
  return { ok: false, error: result, action: getAction(a.id, tenantId) };
}

// THE HARD GATE. Applies ONLY an action in 'approved' state, and only when
// the kill switch is on. Appliers exist only for kinds with a real,
// internal, reversible effect; everything else fails honestly as a stub.
function execute(id, tenantId = T()) {
  const a = getAction(id, tenantId);
  if (!a) return { ok: false, error: 'Action not found.' };
  if (a.status !== 'approved') {
    return { ok: false, error: `Refused: action is ${a.status}. Only approved actions execute — approval is the gate.` };
  }
  if (!agentsEnabled(tenantId)) {
    return markFailed(a, 'Refused: agents are disabled (kill switch agents_enabled=0).', tenantId);
  }
  const p = a.payload_obj || {};
  try {
    switch (a.kind) {
      case 'invoice_draft': {
        const load = p.load_id ? db.getLoad(Number(p.load_id), tenantId) : null;
        if (!load) return markFailed(a, 'Load not found for invoice draft.', tenantId);
        const inv = factoring.createDraftForLoad(load, { tenantId, requirePod: false });
        if (!inv) return markFailed(a, 'Load is not delivered; no invoice drafted.', tenantId);
        return markApplied(a, `Factoring invoice ${inv.invoice_number} drafted (${inv.account}, $${(inv.amount_cents / 100).toFixed(2)}).`, tenantId);
      }
      case 'pod_flag': {
        // Internal bookkeeping: the flag itself is the record. The
        // factoring board computes missing PODs live, so applying the
        // flag simply acknowledges it into the audit trail.
        return markApplied(a, 'Missing-POD flag recorded; the load stays on the factoring board until a POD is attached.', tenantId);
      }
      case 'ratecon_entry': {
        const l = p.load || {};
        if (!l.external_id) return markFailed(a, 'ratecon_entry payload has no external_id — refused (upsert discipline).', tenantId);
        if (!l.date || !/^\d{4}-\d{2}-\d{2}$/.test(l.date)) return markFailed(a, 'ratecon_entry payload has no valid date.', tenantId);
        const r = db.upsertLoad({
          external_id: l.external_id, date: l.date,
          origin: l.origin || null, destination: l.destination || null,
          loaded_miles: Number(l.loaded_miles) || 0, empty_miles: Number(l.empty_miles) || 0,
          linehaul_cents: Math.round(Number(l.linehaul || 0) * 100),
          fsc_cents: Math.round(Number(l.fuel_surcharge || 0) * 100),
          broker: l.broker || null,
          broker_contact_name: l.broker_contact_name, broker_contact_email: l.broker_contact_email,
          broker_contact_phone: l.broker_contact_phone,
          driver_id: l.driver_id || null, truck_id: l.truck_id || null,
          status: l.status || 'delivered', notes: l.notes || null,
          delivery_date: l.delivery_date,
        }, tenantId);
        return markApplied(a, `Load ${l.external_id} ${r.updated ? 'updated' : 'entered'} (TMS id ${r.id}).`, tenantId);
      }
      case 'log_annotation': {
        // STUB (documented): no Motive write path exists in this codebase.
        // The annotation is recorded verbatim in the shift log as the
        // proposal of record; a human still makes it in Motive. A Safety
        // agent NEVER alters, certifies or back-dates a log.
        logEvent(a.agent, 'note',
          `Annotation of record (apply in Motive by hand): ${p.annotation || a.summary}`, a.id, tenantId);
        return markApplied(a, 'Annotation recorded in the shift log. Motive write is a stub — a human still enters it in Motive; the agent changed no log.', tenantId);
      }
      case 'safety_task': {
        return markApplied(a, 'Task acknowledged into the audit trail.', tenantId);
      }
      default:
        return markFailed(a, `No executor for kind '${a.kind}' yet (stub) — nothing was applied.`, tenantId);
    }
  } catch (e) {
    return markFailed(a, `Executor error: ${e.message}`, tenantId);
  }
}

// Execute every approved action (the API executor endpoint's batch mode).
function executeApproved(tenantId = T()) {
  const approved = listActions({ status: 'approved', limit: 100 }, tenantId);
  const results = [];
  for (const a of approved) results.push({ id: a.id, ...execute(a.id, tenantId) });
  return results;
}

// ---- dedupe: an open (proposed/approved) action for the same agent+kind+
// load is not proposed twice.
function hasOpenAction(agent, kind, loadId, tenantId = T()) {
  const rows = db.db.prepare(`SELECT payload FROM agent_actions
    WHERE tenant_id = ? AND agent = ? AND kind = ? AND status IN ('proposed','approved')`)
    .all(tenantId, agent, kind);
  return rows.some(r => {
    try { return Number(JSON.parse(r.payload).load_id) === Number(loadId); }
    catch (e) { return false; }
  });
}

// ---- Phase 1 scans (TMS-internal data only) ----
function runFinanceScan(tenantId = T()) {
  logEvent('finance', 'run_started', 'Finance scan: delivered loads → invoice drafts + POD flags.', null, tenantId);
  const loads = db.db.prepare(
    `SELECT l.*, d.name AS driver_name FROM loads l
     LEFT JOIN drivers d ON d.id = l.driver_id
     WHERE l.tenant_id = ? AND l.status = 'delivered' ORDER BY l.id`).all(tenantId);
  let proposed = 0;
  for (const load of loads) {
    if (factoring.getInvoiceByLoad(load.id, tenantId)) continue;
    const docs = factoring.loadDocs(load.id, tenantId);
    const num = factoring.loadNumber(load);
    if (docs.pod) {
      if (hasOpenAction('finance', 'invoice_draft', load.id, tenantId)) continue;
      const r = propose({
        agent: 'finance', kind: 'invoice_draft',
        summary: `Draft factoring invoice for load ${num} (${load.broker || '—'}, $${(factoring.invoiceAmountCents(load) / 100).toFixed(2)})`,
        payload: { load_id: load.id },
        evidence: { load_id: load.id, load_number: num, pod_on_file: true },
      }, tenantId);
      if (r.ok) proposed++;
    } else {
      if (hasOpenAction('finance', 'pod_flag', load.id, tenantId)) continue;
      const r = propose({
        agent: 'finance', kind: 'pod_flag',
        summary: `Delivered load ${num} (${load.driver_name || 'no driver'}) has NO POD on file — flag it today`,
        payload: { load_id: load.id },
        evidence: { load_id: load.id, load_number: num, delivery_date: load.delivery_date },
      }, tenantId);
      if (r.ok) proposed++;
    }
  }
  logEvent('finance', 'note', `Finance scan complete: ${proposed} proposal(s).`, null, tenantId);
  return { proposed };
}

function runSafetyScan(tenantId = T()) {
  logEvent('safety', 'run_started', 'Safety scan: TMS-internal audit exposure (Motive ELD checks are a stub — no Motive API in the TMS).', null, tenantId);
  let proposed = 0;
  const noDeliveryDate = db.db.prepare(
    `SELECT * FROM loads WHERE tenant_id = ? AND status = 'delivered'
     AND (delivery_date IS NULL OR delivery_date = '') ORDER BY id`).all(tenantId);
  for (const load of noDeliveryDate) {
    if (hasOpenAction('safety', 'safety_task', load.id, tenantId)) continue;
    const num = factoring.loadNumber(load);
    const r = propose({
      agent: 'safety', kind: 'safety_task',
      summary: `Load ${num} is delivered with NO delivery date — settlement week and audit records need it set`,
      payload: { load_id: load.id, task: 'set_delivery_date' },
      evidence: { load_id: load.id, load_number: num },
    }, tenantId);
    if (r.ok) proposed++;
  }
  const held = factoring.listInvoices(tenantId, 'held');
  for (const inv of held) {
    if (hasOpenAction('safety', 'safety_task', inv.load_id, tenantId)) continue;
    const r = propose({
      agent: 'safety', kind: 'safety_task',
      summary: `Factoring invoice ${inv.invoice_number} is HELD by RTS: ${inv.hold_reason || 'no reason recorded'} — paperwork exposure to clear`,
      payload: { load_id: inv.load_id, task: 'clear_held_invoice', invoice_id: inv.id },
      evidence: { invoice_id: inv.id, load_number: inv.invoice_number },
    }, tenantId);
    if (r.ok) proposed++;
  }
  logEvent('safety', 'note', `Safety scan complete: ${proposed} proposal(s). ELD log review remains manual in Motive (stub).`, null, tenantId);
  return { proposed };
}

function runScan(agent, tenantId = T()) {
  if (agent === 'finance') return runFinanceScan(tenantId);
  if (agent === 'safety') return runSafetyScan(tenantId);
  logEvent(agent, 'note', `Scan for agent '${agent}' is a Phase 1 stub — framework only, no proposals generated.`, null, tenantId);
  return { proposed: 0, stub: true };
}

module.exports = {
  AGENTS, HARD_GATED_KINDS,
  agentsEnabled, setAgentsEnabled, autoApplyKinds, setAutoApply, isAutoApply,
  logEvent, listLog, propose, getAction, listActions, counts,
  approve, reject, execute, executeApproved,
  runFinanceScan, runSafetyScan, runScan,
};
