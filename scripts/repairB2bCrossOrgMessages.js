#!/usr/bin/env node
/**
 * repairB2bCrossOrgMessages.js — remove messages sitting on the wrong company.
 *
 * Gmail threads on subject, so two unrelated conversations that share one get
 * filed together. Jamie used "agreement and next steps" for both Trans Closet
 * of the Hudson Valley and Transformation Closet (Nova Scotia); Gmail merged
 * them, and thread discovery imported the whole thread, putting nine of one
 * org's messages onto the other's record. The advisor then drafted from it.
 *
 * `discoverCompanyThreads` / `reconcileThreads` now filter per message, so this
 * cannot recur — this clears what the unfiltered version already wrote.
 *
 * A message stays only if one of the company's known addresses (contacts +
 * general_email) appears in its from/to. Companies with no known address are
 * skipped entirely rather than emptied: absence of addresses is missing data,
 * not evidence the messages are foreign.
 *
 * Usage: node scripts/repairB2bCrossOrgMessages.js [--execute]
 *   Default is print-only.
 */
require('dotenv').config();

const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');

/** Addresses in a stored from_email / to_email value. Pure. */
function storedAddresses(value) {
  return (String(value || '').match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).map(a => a.toLowerCase());
}

/**
 * Does this stored message involve the company? Pure.
 * OUR OWN address never counts as evidence — every message has jamie@ on one
 * side, so counting it would keep everything.
 */
function messageBelongs(msg, companyEmails, ourAddresses) {
  const parties = [...storedAddresses(msg.from_email), ...storedAddresses(msg.to_email)]
    .filter(a => !ourAddresses.has(a));
  if (!parties.length) return true; // nothing to judge on — keep it
  return parties.some(a => companyEmails.has(a));
}

async function main() {
  const execute = process.argv.includes('--execute');
  const sb = getSupabaseClient();
  const ourAddresses = new Set(['jamie@rubyshines.com', 'support@rubyshines.com', 'pipeline@rubyshines.com']);

  const companies = await fetchAllPaginated(() => sb.from('b2b_companies').select('id, name, general_email'));
  const contacts = await fetchAllPaginated(() => sb.from('b2b_contacts').select('company_id, email'));
  const messages = await fetchAllPaginated(() => sb.from('b2b_messages')
    .select('id, company_id, from_email, to_email, sent_at, direction'));

  const emailsByCompany = new Map(companies.map(c => [c.id, new Set()]));
  for (const c of companies) if (c.general_email) emailsByCompany.get(c.id).add(c.general_email.toLowerCase());
  for (const ct of contacts) if (ct.email) emailsByCompany.get(ct.company_id)?.add(ct.email.toLowerCase());
  const nameById = new Map(companies.map(c => [c.id, c.name]));

  const foreign = [];
  for (const m of messages) {
    const known = emailsByCompany.get(m.company_id);
    if (!known || !known.size) continue; // no addresses on file — cannot judge
    if (!messageBelongs(m, known, ourAddresses)) foreign.push(m);
  }

  if (!foreign.length) {
    console.log('No cross-org messages found.');
    return;
  }

  const byCompany = foreign.reduce((a, m) => { (a[m.company_id] ||= []).push(m); return a; }, {});
  console.log(`${foreign.length} message(s) on the wrong company${execute ? '' : ' (print-only, pass --execute to delete)'}:\n`);
  for (const [companyId, list] of Object.entries(byCompany)) {
    console.log(`  ${nameById.get(companyId) || companyId} — ${list.length}`);
    for (const m of list.slice(0, 6)) {
      const other = [...storedAddresses(m.from_email), ...storedAddresses(m.to_email)]
        .find(a => !ourAddresses.has(a)) || '?';
      console.log(`      ${m.sent_at?.slice(0, 10)} ${m.direction} — ${other}`);
    }
    if (list.length > 6) console.log(`      ... and ${list.length - 6} more`);
  }

  if (!execute) return;
  const ids = foreign.map(m => m.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { error } = await sb.from('b2b_messages').delete().in('id', ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
  }
  console.log(`\nDeleted ${ids.length} message(s).`);
}

module.exports = { messageBelongs, storedAddresses };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
