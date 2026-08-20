/**
 * updateContact.js — put a named person on a company and make them the one we
 * actually write to.
 *
 * The gap this closes: the advisor could read "Riley has left, direct all
 * contact to Matt at matt.valdespino@..." out of an auto-reply, say so in the
 * relationship summary, and the Send box still addressed Riley — because
 * `resolveRecipient` reads `b2b_contacts`, and nothing short of a SQL console
 * could change that row. Knowing a contact had changed and being unable to act
 * on it is worse than not knowing.
 *
 * Three things move together, which is the whole point of doing it in one
 * operation rather than three edits:
 *   1. the new person is stored, active, and the ONLY primary
 *   2. the person they replace is deactivated (they left; that is what
 *      is_active false means in this schema)
 *   3. `contact_unknown` clears, because a company with a known good address is
 *      by definition no longer contact-unknown, and while it is set the cadence
 *      refuses to draft.
 */

/** Lowercase + trim. Contact ids ARE the email, so this decides row identity. */
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Work out the writes for a contact change. PURE — no I/O, so the ordering
 * rules below are directly testable.
 *
 * @param existing  b2b_contacts rows already on the company
 * @param input     { email, full_name, title, role, replaces }
 * @returns {{ contact, demote: string[], deactivate: string[] }}
 */
function planContactUpdate(existing, { email, full_name, title, role, replaces } = {}) {
  const next = normalizeEmail(email);
  if (!next) throw new Error('email required');
  if (!EMAIL_RE.test(next)) throw new Error(`'${email}' is not an email address`);

  const rows = existing || [];
  const replacing = replaces ? normalizeEmail(replaces) : null;

  // Everyone else loses primary. `resolveRecipient` takes the first row ordered
  // by is_primary, and 20 companies in this table already carry more than one
  // active primary — which made who actually received an email a function of
  // whatever order Postgres returned. A contact update must not add to that.
  const demote = rows
    .filter(c => normalizeEmail(c.email) !== next && c.is_primary)
    .map(c => normalizeEmail(c.email));

  // Only the named predecessor is retired. Deactivating every other contact
  // would be wrong: orgs legitimately have several people on file, and only one
  // of them has left.
  const deactivate = rows
    .filter(c => replacing
      && normalizeEmail(c.email) === replacing
      && normalizeEmail(c.email) !== next
      && c.is_active !== false)
    .map(c => normalizeEmail(c.email));

  return {
    contact: {
      id: next,
      email: next,
      full_name: full_name?.trim() || null,
      title: title?.trim() || null,
      role: role?.trim() || null,
      is_primary: true,
      is_active: true,
    },
    demote,
    deactivate,
  };
}

/**
 * Apply a contact change for a company.
 * @returns {{ company_id, contact, demoted, deactivated, previous_recipient }}
 */
async function updateCompanyContact(sb, { company_id, email, full_name, title, role, replaces } = {}) {
  if (!company_id) throw new Error('company_id required');

  const { data: company, error: cErr } = await sb.from('b2b_companies')
    .select('id, name').eq('id', company_id).maybeSingle();
  if (cErr) throw new Error(cErr.message);
  if (!company) throw new Error(`company '${company_id}' not found`);

  const { data: existing, error: eErr } = await sb.from('b2b_contacts')
    .select('email, full_name, is_primary, is_active, company_id').eq('company_id', company_id);
  if (eErr) throw new Error(eErr.message);

  const previous = (existing || []).find(c => c.is_active !== false && c.is_primary) || null;
  const plan = planContactUpdate(existing, { email, full_name, title, role, replaces });

  // An email is unique across the whole table, so the address may already sit on
  // ANOTHER company. Refuse rather than silently move it — that is how one org's
  // correspondence ends up filed under another, which this codebase has fixed
  // twice already.
  const { data: owner, error: oErr } = await sb.from('b2b_contacts')
    .select('company_id').eq('email', plan.contact.email).maybeSingle();
  if (oErr) throw new Error(oErr.message);
  if (owner && owner.company_id && owner.company_id !== company_id) {
    throw new Error(`${plan.contact.email} is already on '${owner.company_id}' — move it there deliberately rather than reassigning silently`);
  }

  // Demote first: for a moment two rows would otherwise both be primary, and a
  // send landing in that window picks by row order.
  if (plan.demote.length) {
    const { error } = await sb.from('b2b_contacts')
      .update({ is_primary: false }).in('email', plan.demote);
    if (error) throw new Error(`demote: ${error.message}`);
  }

  const { error: upErr } = await sb.from('b2b_contacts')
    .upsert({ ...plan.contact, company_id, source: 'operator_update' }, { onConflict: 'email' });
  if (upErr) throw new Error(`save contact: ${upErr.message}`);

  if (plan.deactivate.length) {
    const { error } = await sb.from('b2b_contacts')
      .update({ is_active: false }).in('email', plan.deactivate);
    if (error) throw new Error(`deactivate: ${error.message}`);
  }

  // A known good address means the company is reachable again. Left set, the
  // cadence keeps refusing to draft for a contact problem that is now solved.
  const { error: coErr } = await sb.from('b2b_companies')
    .update({ contact_unknown: false, updated_at: new Date().toISOString() }).eq('id', company_id);
  if (coErr) throw new Error(`clear contact_unknown: ${coErr.message}`);

  return {
    company_id,
    company_name: company.name,
    contact: plan.contact,
    demoted: plan.demote,
    deactivated: plan.deactivate,
    previous_recipient: previous?.email || null,
  };
}

/**
 * Promote a contact already on file to be the one we write to.
 *
 * Distinct from updateCompanyContact: that one is "a new person exists", this is
 * "the right person was already here". Charly Robles auto-registered from her own
 * reply (correlateInbound's domain fallback), so retyping her name and address to
 * make her primary would be asking the operator to enter data we already hold.
 */
async function setPrimaryContact(sb, { company_id, email } = {}) {
  if (!company_id) throw new Error('company_id required');
  const target = normalizeEmail(email);
  if (!target) throw new Error('email required');

  const { data: rows, error } = await sb.from('b2b_contacts')
    .select('email, is_primary, is_active').eq('company_id', company_id);
  if (error) throw new Error(error.message);
  const found = (rows || []).find(c => normalizeEmail(c.email) === target);
  if (!found) throw new Error(`${target} is not a contact on '${company_id}'`);

  const demote = (rows || [])
    .filter(c => normalizeEmail(c.email) !== target && c.is_primary)
    .map(c => c.email);
  if (demote.length) {
    const { error: dErr } = await sb.from('b2b_contacts')
      .update({ is_primary: false }).in('email', demote);
    if (dErr) throw new Error(`demote: ${dErr.message}`);
  }
  // Promoting a deactivated contact reactivates them: choosing to write to
  // someone is a statement that they are reachable.
  const { error: pErr } = await sb.from('b2b_contacts')
    .update({ is_primary: true, is_active: true }).eq('email', found.email);
  if (pErr) throw new Error(`promote: ${pErr.message}`);

  await sb.from('b2b_companies')
    .update({ contact_unknown: false, updated_at: new Date().toISOString() }).eq('id', company_id);

  return { company_id, email: found.email, demoted: demote };
}

/**
 * Retire a contact. Deactivates rather than deletes.
 *
 * Their address is what makes their own messages resolve to this company
 * (`messageInvolves` matches on known addresses), so a hard delete would orphan
 * their history and let a future import file it somewhere else. Refuses to
 * retire the last reachable contact when there is no general inbox to fall back
 * to — that silently makes the company unwriteable.
 */
async function removeCompanyContact(sb, { company_id, email } = {}) {
  if (!company_id) throw new Error('company_id required');
  const target = normalizeEmail(email);
  if (!target) throw new Error('email required');

  const { data: rows, error } = await sb.from('b2b_contacts')
    .select('email, is_primary, is_active').eq('company_id', company_id);
  if (error) throw new Error(error.message);
  const found = (rows || []).find(c => normalizeEmail(c.email) === target);
  if (!found) throw new Error(`${target} is not a contact on '${company_id}'`);

  const otherActive = (rows || []).filter(c =>
    normalizeEmail(c.email) !== target && c.is_active !== false);
  if (!otherActive.length) {
    const { data: co } = await sb.from('b2b_companies')
      .select('general_email').eq('id', company_id).maybeSingle();
    if (!co?.general_email) {
      throw new Error(`${target} is the only way to reach this company — add another contact or a general email first`);
    }
  }

  const { error: rErr } = await sb.from('b2b_contacts')
    .update({ is_active: false, is_primary: false }).eq('email', found.email);
  if (rErr) throw new Error(`remove: ${rErr.message}`);

  // Removing the primary leaves nobody nominated, and resolveRecipient would
  // then fall back to row order. Promote the most plausible remaining person.
  let promoted = null;
  if (found.is_primary && otherActive.length) {
    promoted = otherActive[0].email;
    await sb.from('b2b_contacts').update({ is_primary: true }).eq('email', promoted);
  }
  return { company_id, removed: found.email, promoted };
}

/**
 * Put a retired contact back on the active list.
 *
 * Deliberately does NOT make them primary: undoing a removal and choosing who to
 * write to are different decisions, and silently redirecting mail as a side
 * effect of an undo is exactly the kind of surprise this module exists to avoid.
 */
async function restoreCompanyContact(sb, { company_id, email } = {}) {
  if (!company_id) throw new Error('company_id required');
  const target = normalizeEmail(email);
  if (!target) throw new Error('email required');

  const { data: rows, error } = await sb.from('b2b_contacts')
    .select('email, is_active').eq('company_id', company_id);
  if (error) throw new Error(error.message);
  const found = (rows || []).find(c => normalizeEmail(c.email) === target);
  if (!found) throw new Error(`${target} is not a contact on '${company_id}'`);

  const { error: uErr } = await sb.from('b2b_contacts')
    .update({ is_active: true }).eq('email', found.email);
  if (uErr) throw new Error(`restore: ${uErr.message}`);
  return { company_id, restored: found.email };
}

module.exports = {
  updateCompanyContact, planContactUpdate, normalizeEmail,
  setPrimaryContact, removeCompanyContact, restoreCompanyContact,
};
