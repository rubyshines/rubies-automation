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

module.exports = { updateCompanyContact, planContactUpdate, normalizeEmail };
