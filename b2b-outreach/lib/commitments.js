/**
 * commitments.js — one structured list of what Jamie owes and is waiting on.
 *
 * A commitment is a row: what, to whom (company, optional), who owes it
 * (`me` | `them`), where it came from (a meeting, a message, a queue claim, the
 * follow-up ladder, or typed in), by when, and whether it is done. Before this
 * (2026-09-10) the record held prose only — the relationship summary's single
 * next-step sentence and the advisor's free-text promise list — so nothing could
 * be listed, counted or checked off, and every call's action items evaporated.
 *
 * On Me is DERIVED from here. A company is on Jamie when it has at least one
 * open row owned by me. `b2b_companies.on_me_at / on_me_source / on_me_note`
 * are kept as a denormalised copy maintained by `syncOnMeFlag`, the same status
 * `last_outbound_at` has: every existing reader (cadence suppression, the
 * pending-draft merge, the panel badge, the send path) keeps working, and
 * nothing but this module writes those columns.
 *
 * Three ways in, one write path (`upsertCommitments`): a meeting's Next Steps,
 * the relationship summariser reading mail, or the operator. Dedupe is on
 * (company, owner, normalised text) against OPEN rows, so a re-run adds nothing.
 *
 * The rule that keeps the list trustworthy: the engine may complete THEIRS,
 * never MINE (`completeCommitment` enforces it). Mine close by Jamie's check or
 * by his send (`settleOnSend`).
 */
const OWNERS = new Set(['me', 'them']);
const SOURCES = new Set(['meeting', 'email', 'claim', 'cadence', 'manual', 'backfill']);
const STOPWORDS = new Set(['the', 'and', 'with', 'for', 'of', 'to', 'in', 'on', 'at', 'a', 'an']);

// Names that mean "us" when a meeting summary prefixes an action item with a
// person. Wispr writes "(Jamie Alexander) Send ~20 codes"; anything else named
// is the other side.
const OUR_NAMES = ['jamie', 'rubies', 'rubys', 'ruby'];

/** Lowercase, strip punctuation, collapse whitespace. PURE. */
function normalizeText(text) {
  return String(text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Who a named actor is. PURE. `me` for Jamie / RUBIES, `them` for anyone else. */
function classifyOwner(name) {
  const n = normalizeText(name);
  if (!n) return 'them';
  return n.split(' ').some(w => OUR_NAMES.includes(w)) ? 'me' : 'them';
}

/**
 * Pull the action items out of a Wispr meeting summary. PURE.
 *
 * Wispr's summary is markdown with a "### Next Steps" section whose bullets
 * read "- (Name) verb…". That section IS the structured field (the API's
 * `todos` array is empty on every meeting we have seen), and parsing it is the
 * strictest extractor there is: nothing is added that the notes did not list.
 *
 * @returns {{ owner: 'me'|'them', owner_name: string|null, text: string }[]}
 */
function parseNextSteps(summary) {
  const lines = String(summary || '').split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^#{1,6}\s*(.+?)\s*:?$/.exec(line);
    if (heading) {
      inSection = /^(next steps?|action items?|to[- ]?dos?|follow[- ]?ups?)$/i.test(heading[1].replace(/<[^>]+>/g, '').trim());
      continue;
    }
    if (!inSection) continue;
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    let text = bullet[1].trim();
    let ownerName = null;
    const named = /^\(([^)]+)\)\s*(.+)$/.exec(text) || /^\*\*([^*]+)\*\*:?\s*(.+)$/.exec(text) || /^([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3}):\s+(.+)$/.exec(text);
    if (named) { ownerName = named[1].trim(); text = named[2].trim(); }
    // Wispr escapes markdown-significant characters in its summaries ("\\~8 pairs").
    text = text.replace(/\\([~*_`#\\])/g, '$1');
    if (!text) continue;
    out.push({ owner: classifyOwner(ownerName), owner_name: ownerName, text });
  }
  return out;
}

/** Today's date in Eastern time as YYYY-MM-DD. PURE given `now`. */
function todayET(now = new Date()) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * The order the To do list reads in. PURE.
 *
 * Pinned first (Jamie's "today"), then overdue by how overdue, then dated by
 * date, then undated oldest first — so the top of the list is always the thing
 * most in need of attention without anyone maintaining a priority number.
 */
function orderCommitments(rows, now = new Date()) {
  const today = todayET(now);
  const rank = r => (r.pinned_at ? 0 : r.due_on && r.due_on < today ? 1 : r.due_on ? 2 : 3);
  return [...rows].sort((a, b) => {
    const ra = rank(a); const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return String(a.pinned_at).localeCompare(String(b.pinned_at));
    if (ra === 1 || ra === 2) return String(a.due_on).localeCompare(String(b.due_on)) || String(a.created_at).localeCompare(String(b.created_at));
    return String(a.created_at).localeCompare(String(b.created_at));
  });
}

/** Decorate a row for a surface: age, overdue, and the company it belongs to. PURE. */
function decorate(row, company, now = new Date()) {
  const today = todayET(now);
  const created = row.created_at ? new Date(row.created_at) : now;
  return {
    ...row,
    company_name: company ? company.name : null,
    channel: company ? company.relationship_type : null,
    days_open: Math.max(0, Math.floor((now - created) / 86400000)),
    overdue: !!(row.status === 'open' && row.due_on && row.due_on < today),
  };
}

async function loadCompanies(sb, ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return new Map();
  const { data, error } = await sb.from('b2b_companies').select('id, name, relationship_type').in('id', uniq);
  if (error) throw new Error(error.message);
  return new Map((data || []).map(c => [c.id, c]));
}

/** Open rows for one company, oldest first. */
async function openCommitmentsForCompany(sb, companyId) {
  if (!companyId) return [];
  const { data, error } = await sb.from('b2b_commitments').select('*')
    .eq('company_id', companyId).eq('status', 'open').order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * Recompute the derived On Me columns for a company from its open me-rows.
 * The ONLY writer of on_me_at / on_me_source / on_me_note.
 */
async function syncOnMeFlag(sb, companyId) {
  if (!companyId) return null;
  const open = (await openCommitmentsForCompany(sb, companyId)).filter(r => r.owner === 'me');
  const cadence = open.find(r => r.source === 'cadence');
  const patch = open.length
    ? { on_me_at: open[0].created_at, on_me_source: cadence ? 'cadence' : 'operator', on_me_note: cadence ? cadence.text : null }
    : { on_me_at: null, on_me_source: null, on_me_note: null };
  const { error } = await sb.from('b2b_companies').update(patch).eq('id', companyId);
  if (error) throw new Error(`on me sync: ${error.message}`);
  return patch;
}

/**
 * The one write path. Dedupes against OPEN rows on (owner, normalised text)
 * so any source can re-run without doubling the list.
 *
 * @param items [{ owner, text, due_on?, completes_on_send?, thread_id?, source_message_id?, blocked_by? }]
 * @returns {{ inserted: object[], matched: object[] }}
 */
async function upsertCommitments(sb, {
  company_id = null, items = [], meeting_id = null, thread_id = null,
  source, created_by = 'operator', now = new Date(),
} = {}) {
  if (!SOURCES.has(source)) throw new Error(`source must be one of ${[...SOURCES].join(', ')}`);
  const clean = items.map(i => ({
    ...i,
    owner: OWNERS.has(i.owner) ? i.owner : 'me',
    text: String(i.text || '').trim(),
    due_on: i.due_on && /^\d{4}-\d{2}-\d{2}$/.test(i.due_on) ? i.due_on : null,
  })).filter(i => i.text);
  if (!clean.length) return { inserted: [], matched: [] };

  // Open rows for the same company (or the same nowhere, for general items).
  let q = sb.from('b2b_commitments').select('id, owner, text').eq('status', 'open');
  q = company_id ? q.eq('company_id', company_id) : q.is('company_id', null);
  const { data: existing, error } = await q;
  if (error) throw new Error(error.message);
  const seen = new Map((existing || []).map(r => [`${r.owner}|${normalizeText(r.text)}`, r]));

  const inserted = [];
  const matched = [];
  const stamp = now.toISOString();
  for (const i of clean) {
    const key = `${i.owner}|${normalizeText(i.text)}`;
    if (seen.has(key)) { matched.push(seen.get(key)); continue; }
    const row = {
      company_id,
      thread_id: i.thread_id ?? thread_id ?? null,
      meeting_id: i.meeting_id ?? meeting_id ?? null,
      source_message_id: i.source_message_id ?? null,
      owner: i.owner,
      text: i.text,
      original_text: i.text,
      due_on: i.due_on,
      status: 'open',
      completes_on_send: !!i.completes_on_send,
      blocked_by: i.blocked_by ?? null,
      source,
      created_by,
      created_at: stamp,
      updated_at: stamp,
    };
    const { data, error: iErr } = await sb.from('b2b_commitments').insert(row).select('*').single();
    if (iErr) throw new Error(`commitment insert: ${iErr.message}`);
    inserted.push(data);
    seen.set(key, data);
  }
  if (inserted.length) await syncOnMeFlag(sb, company_id);
  return { inserted, matched };
}

/** One item, typed in (or claimed). Returns the row, new or already there. */
async function addCommitment(sb, { company_id = null, owner = 'me', text, due_on = null, source = 'manual', created_by = 'operator', thread_id = null, meeting_id = null, completes_on_send = false, now = new Date() } = {}) {
  const r = await upsertCommitments(sb, {
    company_id, meeting_id, thread_id, source, created_by, now,
    items: [{ owner, text, due_on, completes_on_send }],
  });
  return r.inserted[0] || r.matched[0] || null;
}

async function loadCommitment(sb, id) {
  const { data, error } = await sb.from('b2b_commitments').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`commitment #${id} not found`);
  return data;
}

/** Edit text / date / owner / company / pin / block. Only the fields passed change. */
async function updateCommitment(sb, { id, text, due_on, owner, company_id, pinned, blocked_by, now = new Date() } = {}) {
  const row = await loadCommitment(sb, id);
  const patch = { updated_at: now.toISOString() };
  if (typeof text === 'string' && text.trim()) patch.text = text.trim();
  if (due_on !== undefined) patch.due_on = due_on && /^\d{4}-\d{2}-\d{2}$/.test(due_on) ? due_on : null;
  if (owner !== undefined) { if (!OWNERS.has(owner)) throw new Error("owner must be 'me' or 'them'"); patch.owner = owner; }
  if (company_id !== undefined) patch.company_id = company_id || null;
  if (pinned !== undefined) patch.pinned_at = pinned ? now.toISOString() : null;
  if (blocked_by !== undefined) patch.blocked_by = blocked_by || null;
  const { data, error } = await sb.from('b2b_commitments').update(patch).eq('id', id).select('*').single();
  if (error) throw new Error(error.message);
  await syncOnMeFlag(sb, row.company_id);
  if (data.company_id !== row.company_id) await syncOnMeFlag(sb, data.company_id);
  return data;
}

/**
 * Mark done. `by` is 'operator', 'send' or 'engine' — and the engine may only
 * close what THEY owe. A model reading mail never decides Jamie has done a
 * thing; that is the asymmetry the whole list's trustworthiness rests on.
 */
async function completeCommitment(sb, { id, by = 'operator', done_message_id = null, now = new Date() } = {}) {
  const row = await loadCommitment(sb, id);
  if (row.status === 'done') return row;
  if (by === 'engine' && row.owner !== 'them') {
    throw new Error(`the engine may not complete commitment #${id}: it is owned by me`);
  }
  const stamp = now.toISOString();
  const { data, error } = await sb.from('b2b_commitments')
    .update({ status: 'done', done_at: stamp, done_by: by, done_message_id: done_message_id || null, updated_at: stamp })
    .eq('id', id).select('*').single();
  if (error) throw new Error(error.message);
  await syncOnMeFlag(sb, row.company_id);
  return data;
}

async function reopenCommitment(sb, { id, now = new Date() } = {}) {
  const row = await loadCommitment(sb, id);
  const { data, error } = await sb.from('b2b_commitments')
    .update({ status: 'open', done_at: null, done_by: null, done_message_id: null, updated_at: now.toISOString() })
    .eq('id', id).select('*').single();
  if (error) throw new Error(error.message);
  await syncOnMeFlag(sb, row.company_id);
  return data;
}

/** A wrong capture. Gone, not done — done is history the summariser may read. */
async function deleteCommitment(sb, { id } = {}) {
  const row = await loadCommitment(sb, id);
  const { error } = await sb.from('b2b_commitments').delete().eq('id', id);
  if (error) throw new Error(error.message);
  await syncOnMeFlag(sb, row.company_id);
  return row;
}

/**
 * What a send settles. Called from sendB2bEmail after the message row exists.
 *
 *  - the commitment the composer was opened from ("Done, write to them"),
 *    carried on the draft as structured.completes_commitment_id;
 *  - every open `completes_on_send` row for the company on this thread (or
 *    with no thread) — the claim-created "reply to them" items.
 *
 * Nothing else: sending Le JAG their codes does not finish shipping the stand.
 */
async function settleOnSend(sb, { company_id, thread_id = null, message_id = null, draft = null, now = new Date() } = {}) {
  if (!company_id) return { completed: [] };
  const completed = [];
  const fromDraft = draft?.structured?.completes_commitment_id;
  const open = await openCommitmentsForCompany(sb, company_id);
  for (const r of open) {
    const named = fromDraft && Number(fromDraft) === Number(r.id);
    const replyItem = r.completes_on_send && (!r.thread_id || !thread_id || Number(r.thread_id) === Number(thread_id));
    if (!named && !replyItem) continue;
    await completeCommitment(sb, { id: r.id, by: 'send', done_message_id: message_id, now });
    completed.push(r.id);
  }
  return { completed };
}

/**
 * "Back to queue": the operator is un-claiming. The system-made stubs (a
 * claim's "reply to them", the ladder's hand-off) are removed; anything with
 * real content — a meeting's action item, a typed-in promise — stays, and the
 * company stays on me while any of those remain.
 */
async function abandonClaims(sb, { company_id } = {}) {
  const open = await openCommitmentsForCompany(sb, company_id);
  const stubs = open.filter(r => r.owner === 'me' && (r.source === 'claim' || r.source === 'cadence'));
  for (const r of stubs) {
    const { error } = await sb.from('b2b_commitments').delete().eq('id', r.id);
    if (error) throw new Error(error.message);
  }
  await syncOnMeFlag(sb, company_id);
  const remaining = open.filter(r => r.owner === 'me' && !stubs.includes(r));
  return { removed: stubs.length, remaining: remaining.length };
}

/**
 * The To do list. Open by default; `status: 'done'` for the done fold (recent
 * first, capped). Decorated with company name / channel / age / overdue and
 * returned in reading order.
 */
async function listCommitments(sb, { company_id, owner, status = 'open', channel = null, limit = 500, now = new Date() } = {}) {
  let q = sb.from('b2b_commitments').select('*').eq('status', status);
  if (company_id) q = q.eq('company_id', company_id);
  if (owner) q = q.eq('owner', owner);
  q = status === 'done' ? q.order('done_at', { ascending: false }).limit(limit) : q.order('created_at', { ascending: true }).limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const companies = await loadCompanies(sb, (data || []).map(r => r.company_id));
  let rows = (data || []).map(r => decorate(r, companies.get(r.company_id), now));
  if (channel) rows = rows.filter(r => r.channel === channel);
  return status === 'done' ? rows : orderCommitments(rows, now);
}

/**
 * On Me as a query: companies with at least one open me-row, oldest claim
 * first, each with its items. What fetchOnMe reads now.
 */
async function companiesOnMe(sb, { channel = null, now = new Date() } = {}) {
  const { data, error } = await sb.from('b2b_commitments').select('*')
    .eq('status', 'open').eq('owner', 'me').not('company_id', 'is', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  const byCompany = new Map();
  for (const r of data || []) {
    if (!byCompany.has(r.company_id)) byCompany.set(r.company_id, []);
    byCompany.get(r.company_id).push(r);
  }
  const companies = await loadCompanies(sb, [...byCompany.keys()]);
  const groups = [];
  for (const [cid, items] of byCompany) {
    const c = companies.get(cid);
    if (!c) continue;
    if (channel && c.relationship_type !== channel) continue;
    const ordered = orderCommitments(items.map(r => decorate(r, c, now)), now);
    const cadence = items.find(r => r.source === 'cadence');
    groups.push({
      company_id: cid,
      company_name: c.name,
      channel: c.relationship_type,
      on_me_at: items[0].created_at,
      count: items.length,
      items: ordered,
      oldest_text: items[0].text,
      claimed_by: cadence ? 'cadence' : 'operator',
      claim_note: cadence ? cadence.text : null,
    });
  }
  groups.sort((a, b) => String(a.on_me_at).localeCompare(String(b.on_me_at)));
  return groups;
}

module.exports = {
  OWNERS, SOURCES,
  normalizeText, classifyOwner, parseNextSteps, todayET, orderCommitments, decorate,
  openCommitmentsForCompany, syncOnMeFlag,
  upsertCommitments, addCommitment, updateCommitment, completeCommitment, reopenCommitment,
  deleteCommitment, settleOnSend, abandonClaims, listCommitments, companiesOnMe,
};
