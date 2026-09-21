/**
 * deliverables.js — one piece of work above many promises.
 *
 * A deliverable is internal work that several commitments across several
 * companies hang off: build the affiliate onboarding, make the partner
 * collateral kit, the October shipment run. It is not a promise to anyone, so
 * it is never a row on the To do list and never touches On Me; it is the fold
 * those rows sit under. Before this (2026-09-21) the list had one axis, the
 * company, and 44 rows read as 44 unrelated errands when they were about eight
 * pieces of work — five of them not doable at all until something shipped.
 *
 * One boolean says what membership means. `blocks`: members cannot be done
 * until this ships — they fold under "Waiting on: …" and sort last, but are
 * never hidden (a silently suppressed commitment is the worst failure this
 * list can have). Not `blocks`: a batch — members actionable now, grouped
 * because they are done in one sitting.
 *
 * Two rules carried over from commitments.js, on which the list's trust rests:
 *  - shipping a deliverable completes NO member. The app existing is not the
 *    same as having written to the partner; the send does that, as it does
 *    today. `shipDeliverable` returns the members it released and touches none.
 *  - the engine may attach a commitment to a deliverable (organisation: one
 *    click to undo, hides nothing); only the operator ships one.
 */
const C = require('./commitments');

const STATUSES = new Set(['open', 'shipped']);

/** Age and overdue for a surface, with its member counts. PURE. */
function decorateDeliverable(row, counts = {}, now = new Date()) {
  const today = C.todayET(now);
  const created = row.created_at ? new Date(row.created_at) : now;
  return {
    ...row,
    open_count: counts.open || 0,
    done_count: counts.done || 0,
    days_open: Math.max(0, Math.floor((now - created) / 86400000)),
    overdue: !!(row.status === 'open' && row.target_on && row.target_on < today),
  };
}

async function loadDeliverable(sb, id) {
  const { data, error } = await sb.from('b2b_deliverables').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`deliverable #${id} not found`);
  return data;
}

/** Member counts per deliverable id: { id: { open, done } }. */
async function memberCounts(sb, ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  const counts = {};
  if (!uniq.length) return counts;
  const { data, error } = await sb.from('b2b_commitments').select('id, deliverable_id, status').in('deliverable_id', uniq);
  if (error) throw new Error(error.message);
  for (const r of data || []) {
    const c = counts[r.deliverable_id] || (counts[r.deliverable_id] = { open: 0, done: 0 });
    if (r.status === 'open') c.open += 1;
    else if (r.status === 'done') c.done += 1;
  }
  return counts;
}

/**
 * The deliverables, decorated with member counts. `status` 'open' (default),
 * 'shipped' (most recent first, capped) or 'all'. Open ones read oldest first,
 * the same steady order the To do list keeps.
 */
async function listDeliverables(sb, { status = 'open', limit = 50, now = new Date() } = {}) {
  let q = sb.from('b2b_deliverables').select('*');
  if (status !== 'all') q = q.eq('status', status);
  q = status === 'shipped'
    ? q.order('shipped_at', { ascending: false }).limit(limit)
    : q.order('created_at', { ascending: true });
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data || [];
  const counts = await memberCounts(sb, rows.map(r => r.id));
  return rows.map(r => decorateDeliverable(r, counts[r.id], now));
}

async function addDeliverable(sb, { name, detail = null, blocks = true, target_on = null, notes = null, created_by = 'operator', now = new Date() } = {}) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('name required');
  const stamp = now.toISOString();
  const row = {
    name: clean,
    detail: detail ? String(detail).trim() : null,
    blocks: !!blocks,
    status: 'open',
    target_on: target_on && /^\d{4}-\d{2}-\d{2}$/.test(target_on) ? target_on : null,
    notes: notes ? String(notes).trim() : null,
    created_by: created_by === 'engine' ? 'engine' : 'operator',
    created_at: stamp,
    updated_at: stamp,
  };
  const { data, error } = await sb.from('b2b_deliverables').insert(row).select('*').single();
  if (error) throw new Error(`deliverable insert: ${error.message}`);
  return data;
}

/** Edit name / detail / blocks / target / notes. Only the fields passed change. */
async function updateDeliverable(sb, { id, name, detail, blocks, target_on, notes, now = new Date() } = {}) {
  await loadDeliverable(sb, id);
  const patch = { updated_at: now.toISOString() };
  if (typeof name === 'string' && name.trim()) patch.name = name.trim();
  if (detail !== undefined) patch.detail = detail ? String(detail).trim() : null;
  if (blocks !== undefined) patch.blocks = !!blocks;
  if (target_on !== undefined) patch.target_on = target_on && /^\d{4}-\d{2}-\d{2}$/.test(target_on) ? target_on : null;
  if (notes !== undefined) patch.notes = notes ? String(notes).trim() : null;
  const { data, error } = await sb.from('b2b_deliverables').update(patch).eq('id', id).select('*').single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * The moment the list was built for. Marks the deliverable shipped and returns
 * the open members that are now Jamie's to do — decorated, in reading order,
 * so a surface can offer each one "write to them" straight away. It completes
 * none of them: only Jamie's check or Jamie's send closes something he owes.
 */
async function shipDeliverable(sb, { id, now = new Date() } = {}) {
  const row = await loadDeliverable(sb, id);
  const stamp = now.toISOString();
  let deliverable = row;
  if (row.status !== 'shipped') {
    const { data, error } = await sb.from('b2b_deliverables')
      .update({ status: 'shipped', shipped_at: stamp, updated_at: stamp }).eq('id', id).select('*').single();
    if (error) throw new Error(error.message);
    deliverable = data;
  }
  const released = await C.listCommitments(sb, { deliverable_id: id, status: 'open', now });
  return { deliverable, released };
}

/** Back to open (a ship pressed by mistake). Members are untouched either way. */
async function reopenDeliverable(sb, { id, now = new Date() } = {}) {
  await loadDeliverable(sb, id);
  const { data, error } = await sb.from('b2b_deliverables')
    .update({ status: 'open', shipped_at: null, updated_at: now.toISOString() }).eq('id', id).select('*').single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Remove a deliverable. Its members are detached first — explicitly, not left
 * to the FK — and stay exactly as they were: open stays open, done stays done.
 * Nothing is cascaded away.
 */
async function deleteDeliverable(sb, { id, now = new Date() } = {}) {
  const row = await loadDeliverable(sb, id);
  const { data: members, error: dErr } = await sb.from('b2b_commitments')
    .update({ deliverable_id: null, updated_at: now.toISOString() }).eq('deliverable_id', id).select('id');
  if (dErr) throw new Error(dErr.message);
  const { error } = await sb.from('b2b_deliverables').delete().eq('id', id);
  if (error) throw new Error(error.message);
  return { deleted: row, detached: (members || []).length };
}

/**
 * File a commitment under a deliverable (or move it). Idempotent. Refuses a
 * shipped deliverable: new work that arrives after the ship is loose, and the
 * deliverable stays shipped.
 */
async function attachCommitment(sb, { commitment_id, deliverable_id, now = new Date() } = {}) {
  const d = await loadDeliverable(sb, deliverable_id);
  if (d.status === 'shipped') throw new Error(`deliverable #${deliverable_id} has shipped; leave the item loose or reopen the deliverable first`);
  return C.updateCommitment(sb, { id: commitment_id, deliverable_id, now });
}

async function detachCommitment(sb, { commitment_id, now = new Date() } = {}) {
  return C.updateCommitment(sb, { id: commitment_id, deliverable_id: null, now });
}

module.exports = {
  STATUSES, decorateDeliverable,
  listDeliverables, loadDeliverable, addDeliverable, updateDeliverable,
  shipDeliverable, reopenDeliverable, deleteDeliverable,
  attachCommitment, detachCommitment,
};
