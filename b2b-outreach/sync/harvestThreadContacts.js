#!/usr/bin/env node
/**
 * harvestThreadContacts.js — everyone on a company's mail becomes a contact.
 *
 * The one-off over the existing book, and the same function the nightly
 * "Thread Contacts" step runs over the last week. Print-only by default: it
 * lists who would be added to which company and who was left out and why
 * (free-mail cc's, addresses on file for another company).
 *
 * Usage:
 *   node b2b-outreach/sync/harvestThreadContacts.js                 # last 400 days, print
 *   node b2b-outreach/sync/harvestThreadContacts.js --write         # add them
 *   options: --days 400  --company <id>
 */
require('dotenv').config();
const { getSupabaseClient } = require('../../shared/supabaseClient');
const { sweep } = require('../lib/threadContacts');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
}

(async () => {
  const write = process.argv.includes('--write');
  const r = await sweep(getSupabaseClient(), {
    days: Number(arg('--days', 400)), write, companyId: arg('--company', null), log: l => console.log(l),
  });
  console.log(`\n${r.messages} messages across ${r.companies} companies · ${write ? 'added' : 'would add'} ${r.added.length}`);
  const byReason = {};
  for (const s of r.skipped) (byReason[s.reason] ||= []).push(`${s.email} (${s.company_id})`);
  for (const [reason, list] of Object.entries(byReason)) console.log(`\nskipped ${reason}: ${list.length}\n  ${list.slice(0, 40).join('\n  ')}${list.length > 40 ? `\n  … ${list.length - 40} more` : ''}`);
  if (r.errors.length) console.log(`\nerrors: ${JSON.stringify(r.errors)}`);
  if (!write) console.log('\nPrint-only. Re-run with --write to add them.');
})().catch(e => { console.error(e); process.exit(1); });
