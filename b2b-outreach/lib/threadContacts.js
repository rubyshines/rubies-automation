/**
 * threadContacts.js — everyone on the conversation is a contact.
 *
 * Only the sender was ever registered, and only when the correlator reached
 * the company through the domain fallback. The people a contact copies — the
 * coordinator, the director, the colleague who will actually run the closet —
 * were on every message and on file nowhere: The Q Corner had four people on
 * one reply and zero contacts (2026-09-14). So every address on the From, To
 * and Cc of a message that belongs to a company becomes a contact of that
 * company: non-primary, active, named from the header where the header names
 * them. Live from the correlator for inbound mail; a nightly sweep is the
 * catch-up and the only path for outbound cc and manual sends.
 *
 * The rules live in planThreadContacts so they are testable without a database:
 *   - Never primary, never a change to an existing row. Who we write to is an
 *     operator decision (promote / replace in updateContact.js); this only
 *     makes the person visible and reachable.
 *   - Attributed by domain, never by presence alone. An address counts only at
 *     a domain the company is already known by: its website, its general
 *     inbox, a contact on file, or the sender the message was correlated to.
 *     A free-mail address cc'd on a thread could be anyone (identity across
 *     the stores is matched on domain, never on name), so it is reported for
 *     the operator, not added.
 *   - An address already on file for ANOTHER company is refused, not moved.
 *   - Ours and system mailboxes never register.
 *   - Names fill only. A header name lands on a NEW row; an existing row keeps
 *     what it has whatever the header says — the signature harvest's rule.
 */
const { identifyingDomain, isSystemMailbox } = require('./emailDomains');

const SOURCE = 'thread_header';
const OUR_DOMAIN = 'rubyshines.com';

/** Every address in a header-ish value. Lowercased. Pure. */
function addressesIn(value) {
  return (String(value || '').match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).map(a => a.toLowerCase());
}

function isOurs(email) {
  return String(email || '').toLowerCase().endsWith(`@${OUR_DOMAIN}`);
}

// Words that make a display name a team or a mailbox, not a person. "Youth
// Services Team" split First/Last would greet someone "Hi Youth,".
const NOT_A_PERSON = new Set([
  'team', 'teams', 'staff', 'office', 'services', 'service', 'dept', 'department', 'center', 'centre',
  'clinic', 'program', 'programs', 'programme', 'support', 'info', 'admin', 'sales', 'hello', 'contact',
  'inc', 'llc', 'ltd', 'org', 'foundation', 'group', 'committee', 'board', 'council', 'network', 'project',
  'outreach', 'reception', 'frontdesk', 'desk', 'inbox', 'mail', 'email', 'volunteer', 'volunteers',
]);

/**
 * A header display name as first / last / full, or null when it is not a
 * person's name. Outlook writes "Last, First"; everyone else "First Last". A
 * single word ("TheQCorner"), an address, or a team name is not a name. Pure.
 */
function splitDisplayName(raw) {
  const s = String(raw || '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!s || s.includes('@')) return null;
  let first; let last;
  if (s.includes(',')) {
    const [l, f] = s.split(',').map(x => x.trim());
    last = l; first = f;
  } else {
    const parts = s.split(' ');
    if (parts.length < 2) return null;
    first = parts[0]; last = parts.slice(1).join(' ');
  }
  if (!first || !last) return null;
  const word = /^[\p{L}][\p{L}'.-]*$/u;
  if (!word.test(first) || !last.split(' ').every(w => word.test(w))) return null;
  const words = `${first} ${last}`.toLowerCase().replace(/[.,]/g, '').split(' ');
  if (words.some(w => NOT_A_PERSON.has(w))) return null;
  return { first_name: first, last_name: last, full_name: `${first} ${last}` };
}

/**
 * The people on a message, as [{ email, name }], from whatever the caller
 * has: `people` with names (the push path reads them off the headers), and
 * the from/to/cc strings the record keeps (addresses only). Deduplicated on
 * address; a name wins over no name. Pure.
 */
function peopleFromMessage(msg = {}) {
  const byEmail = new Map();
  const add = (email, name) => {
    const e = String(email || '').toLowerCase().trim();
    if (!e.includes('@')) return;
    const cur = byEmail.get(e);
    if (!cur) byEmail.set(e, { email: e, name: name || null });
    else if (!cur.name && name) cur.name = name;
  };
  for (const p of msg.people || []) add(p?.email, p?.name);
  for (const a of addressesIn(msg.from_email)) add(a, msg.from_name || null);
  for (const a of addressesIn(msg.to_email)) add(a, null);
  for (const a of addressesIn(msg.cc_email)) add(a, null);
  return [...byEmail.values()];
}

/**
 * Which of `people` become contacts of `company`, and why the rest do not.
 *
 * @param company   { id, website, general_email } (may be null: sender domain still counts)
 * @param senders   addresses already attributed to this company (the message's
 *                  correlated sender, or every inbound sender in a sweep)
 * @param people    [{ email, name }]
 * @param existing  contact rows on file for the candidate addresses, ANY company:
 *                  [{ email, company_id }]
 * @param onFile    contact rows on file for THIS company: [{ email }]
 * @returns { add: [row], skipped: [{ email, reason }] }
 */
function planThreadContacts({ company, senders = [], people = [], existing = [], onFile = [], today = new Date() } = {}) {
  const known = new Set();
  const learn = v => { const d = identifyingDomain(v); if (d) known.add(d); };
  if (company) { learn(company.website); learn(company.general_email); }
  for (const s of senders) learn(s);
  for (const c of onFile) learn(c.email);
  const mine = new Set(onFile.map(c => String(c.email).toLowerCase()));
  const elsewhere = new Map(existing
    .filter(c => c.company_id && (!company || c.company_id !== company.id))
    .map(c => [String(c.email).toLowerCase(), c.company_id]));
  const stamp = today.toISOString().slice(0, 10);

  const add = [];
  const skipped = [];
  const seen = new Set();
  for (const p of people) {
    const email = String(p?.email || '').toLowerCase().trim();
    if (!email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    if (isOurs(email)) continue;
    if (isSystemMailbox(email)) { skipped.push({ email, reason: 'system_mailbox' }); continue; }
    if (mine.has(email)) { skipped.push({ email, reason: 'on_file' }); continue; }
    if (elsewhere.has(email)) { skipped.push({ email, reason: 'other_company', company_id: elsewhere.get(email) }); continue; }
    const domain = identifyingDomain(email);
    if (!domain) { skipped.push({ email, reason: 'generic_domain' }); continue; }
    if (!known.has(domain)) { skipped.push({ email, reason: 'unknown_domain', domain }); continue; }
    const name = splitDisplayName(p.name);
    add.push({
      id: email, email, company_id: company?.id || null,
      ...(name || { first_name: null, last_name: null, full_name: null }),
      is_primary: false, is_active: true, source: SOURCE,
      notes: `Auto-added ${stamp}: on the To/Cc of this company's email.`,
    });
  }
  return { add, skipped };
}

/**
 * Register the people on one message for one company. Fail-soft on lookups
 * (a harvest never blocks a correlation); the insert is insert-only, so a row
 * that appeared meanwhile is left as it is.
 */
async function harvestThreadContacts(sb, { company_id, sender, senders, people = [] } = {}) {
  if (!company_id || !people.length) return { added: [], skipped: [] };
  const emails = [...new Set(people.map(p => String(p?.email || '').toLowerCase()).filter(e => e.includes('@')))];
  const [{ data: company }, { data: existing, error: eErr }, { data: onFile, error: oErr }] = await Promise.all([
    sb.from('b2b_companies').select('id, website, general_email').eq('id', company_id).maybeSingle(),
    sb.from('b2b_contacts').select('email, company_id').in('email', emails),
    sb.from('b2b_contacts').select('email').eq('company_id', company_id),
  ]);
  if (eErr) throw new Error(`contact lookup: ${eErr.message}`);
  if (oErr) throw new Error(`contact lookup: ${oErr.message}`);
  const plan = planThreadContacts({
    company: company || { id: company_id },
    senders: senders || (sender ? [sender] : []),
    people, existing: existing || [], onFile: onFile || [],
  });
  if (plan.add.length) {
    const { error } = await sb.from('b2b_contacts')
      .upsert(plan.add, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw new Error(`contact insert: ${error.message}`);
  }
  return { added: plan.add.map(r => r.email), skipped: plan.skipped };
}

/**
 * The catch-up: every company's recent messages, both directions, people
 * gathered per company and planned once. Names come from the intake's
 * from_name for senders; To/Cc names are not on the record, so those rows
 * arrive unnamed and the signature harvest fills them when they write.
 * Print-only unless `write`. Paginated: b2b_messages is past 1000 rows.
 */
async function sweep(sb, { days = 7, write = false, companyId = null, log = () => {} } = {}) {
  const { NON_REPLY_INBOUND_TYPES } = require('./replyCorrelation');
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const messages = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from('b2b_messages')
      .select('id, company_id, direction, message_type, from_email, to_email, cc_email, gmail_message_id')
      .gte('sent_at', since).order('id', { ascending: true }).range(from, from + 999);
    if (companyId) q = q.eq('company_id', companyId);
    const { data, error } = await q;
    if (error) throw new Error(`messages: ${error.message}`);
    messages.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const real = messages.filter(m => m.company_id
    && !(m.direction === 'inbound' && m.message_type && NON_REPLY_INBOUND_TYPES.has(m.message_type)));

  // Sender names, from the intake record, in batches.
  const nameByGmailId = new Map();
  const ids = [...new Set(real.filter(m => m.direction === 'inbound' && m.gmail_message_id).map(m => m.gmail_message_id))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('email_messages').select('gmail_message_id, from_name').in('gmail_message_id', ids.slice(i, i + 200));
    for (const r of data || []) if (r.from_name) nameByGmailId.set(r.gmail_message_id, r.from_name);
  }

  const byCompany = new Map();
  for (const m of real) {
    if (!byCompany.has(m.company_id)) byCompany.set(m.company_id, { people: [], senders: [] });
    const g = byCompany.get(m.company_id);
    const fromName = m.direction === 'inbound' ? nameByGmailId.get(m.gmail_message_id) || null : null;
    g.people.push(...peopleFromMessage({ ...m, from_name: fromName }));
    if (m.direction === 'inbound') g.senders.push(...addressesIn(m.from_email));
  }

  const report = { companies: byCompany.size, messages: real.length, added: [], skipped: [], errors: [] };
  for (const [company_id, g] of byCompany) {
    try {
      const emails = [...new Set(g.people.map(p => p.email))];
      const [{ data: company }, { data: existing }, { data: onFile }] = await Promise.all([
        sb.from('b2b_companies').select('id, website, general_email').eq('id', company_id).maybeSingle(),
        sb.from('b2b_contacts').select('email, company_id').in('email', emails),
        sb.from('b2b_contacts').select('email').eq('company_id', company_id),
      ]);
      const plan = planThreadContacts({
        company: company || { id: company_id }, senders: [...new Set(g.senders)],
        people: g.people, existing: existing || [], onFile: onFile || [],
      });
      for (const s of plan.skipped) if (s.reason !== 'on_file') report.skipped.push({ company_id, ...s });
      if (!plan.add.length) continue;
      if (write) {
        const { error } = await sb.from('b2b_contacts').upsert(plan.add, { onConflict: 'id', ignoreDuplicates: true });
        if (error) throw new Error(error.message);
      }
      for (const r of plan.add) report.added.push({ company_id, email: r.email, name: r.full_name });
      log(`${write ? 'added' : 'would add'} ${plan.add.map(r => r.full_name ? `${r.email} (${r.full_name})` : r.email).join(', ')} → ${company_id}`);
    } catch (e) {
      report.errors.push({ company_id, error: e.message });
    }
  }
  return report;
}

module.exports = {
  SOURCE,
  splitDisplayName,
  peopleFromMessage,
  planThreadContacts,
  harvestThreadContacts,
  sweep,
};
