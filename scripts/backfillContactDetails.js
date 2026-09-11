#!/usr/bin/env node
/**
 * backfillContactDetails.js — fill in the names, titles and mailing addresses
 * the book never recorded, from the signatures already sitting in stored
 * inbound mail.
 *
 * The forward path (`contactDetails.harvestContactDetails`, wired into
 * `correlateInbound`) only ever sees mail that arrives from now on. This is its
 * catch-up sweep over the ~1,000 inbound messages already in `b2b_messages`,
 * the same shape as `verifyB2bAddresses.js` is for address verification.
 *
 * Everything goes through the same pure gates as the live path
 * (`planDetailsFill` for the person, `planLocationFill` for their
 * organisation's address), so the fill-only rule, the our-own-signature rule,
 * the name-must-agree rule and the address-must-not-contradict rule are
 * identical in both — this script contributes no business logic of its own, it
 * only chooses which rows to feed in.
 *
 * Usage (print-only by default):
 *   node scripts/backfillContactDetails.js --dump out.json
 *       Write every candidate contact and the text of their replies to a JSON
 *       file. No model call, no writes. For extracting the signatures
 *       elsewhere — the first backfill was read by hand rather than paying for
 *       a thousand Sonnet calls to read mail a person could read directly.
 *
 *   node scripts/backfillContactDetails.js --from-file extracted.json [--live]
 *       Apply a file of already-extracted records:
 *         [{ "email": "...", "first_name": "...", "last_name": "...", "title": "...",
 *            "street_address": "...", "city": "...", "region": "...",
 *            "country": "...", "phone": "..." }]
 *       Any field may be null. The contact fields land on the contact, the
 *       address fields on their company. Unknown addresses and gate failures
 *       are reported, never written.
 *
 *   node scripts/backfillContactDetails.js [--limit N] [--live]
 *       Extract with Sonnet for every candidate. Costs money; prints what it
 *       would write unless --live.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getSupabaseClient } = require('../shared/supabaseClient');
const {
  planDetailsFill, planLocationFill, missingDetails, extractContactDetails,
} = require('../b2b-outreach/lib/contactDetails');

/** How much of a reply carries the sender's own text and signature. A top-posted
 *  reply puts both at the very start; past this it is all quoted history. */
const BODY_CHARS = 2500;
/** Replies to read per contact, newest first. More than this is redundant: if
 *  three of someone's emails carry no signature, a fourth will not either. */
const MESSAGES_PER_CONTACT = 3;

async function pageThrough(build) {
  const out = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if ((data || []).length < 1000) break;
    from += 1000;
  }
  return out;
}

/**
 * Contacts worth looking at: active, missing something, and they have actually
 * written to us. Newest message first so the freshest signature wins.
 */
async function loadCandidates(sb) {
  const contacts = await pageThrough(() => sb.from('b2b_contacts')
    .select('email, company_id, first_name, last_name, full_name, title, is_active')
    .eq('is_active', true));
  // The subject lives on the thread, not the message.
  const messages = await pageThrough(() => sb.from('b2b_messages')
    .select('from_email, thread_id, body_text, sent_at, message_type')
    .eq('direction', 'inbound').order('sent_at', { ascending: false }));
  const threads = await pageThrough(() => sb.from('b2b_threads').select('id, subject'));
  const subjectOf = new Map(threads.map(t => [t.id, t.subject]));
  const companies = await pageThrough(() => sb.from('b2b_companies')
    .select('id, name, address, city, region, country, phone'));
  const byCompany = new Map(companies.map(c => [c.id, c]));

  const bySender = new Map();
  for (const m of messages) {
    // Machine mail is excluded for the same reason the live path excludes it:
    // an auto-responder's signature is whoever set it up, not the person.
    if (m.message_type) continue;
    const k = String(m.from_email || '').trim().toLowerCase();
    if (!k) continue;
    if (!bySender.has(k)) bySender.set(k, []);
    const list = bySender.get(k);
    if (list.length < MESSAGES_PER_CONTACT) list.push({ ...m, subject: subjectOf.get(m.thread_id) || null });
  }

  // A contact with nothing missing is still worth reading when their company
  // has no address on file — the signature answers both questions at once.
  return contacts
    .map(c => ({
      contact: c,
      company: byCompany.get(c.company_id) || null,
      company_name: byCompany.get(c.company_id)?.name || null,
      messages: bySender.get(String(c.email || '').trim().toLowerCase()) || [],
    }))
    .filter(c => c.messages.length)
    .filter(c => missingDetails(c.contact).length
      || !c.company?.address || !c.company?.phone);
}

/** Apply one planned patch to a contact. */
async function write(sb, email, patch) {
  const { error } = await sb.from('b2b_contacts')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('email', email);
  if (error) throw new Error(`${email}: ${error.message}`);
}

/** Apply one planned patch to a company. */
async function writeCompany(sb, id, patch) {
  const { error } = await sb.from('b2b_companies')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`${id}: ${error.message}`);
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const dumpTo = flag('--dump');
  const fromFile = flag('--from-file');
  const limit = Number(flag('--limit')) || Infinity;

  const sb = getSupabaseClient();
  const candidates = await loadCandidates(sb);
  console.log(`${candidates.length} active contacts are missing details and have written to us.`);

  if (dumpTo) {
    const payload = candidates.map(({ contact, company, company_name, messages }) => ({
      email: contact.email,
      company_id: contact.company_id,
      company_name,
      known: { first_name: contact.first_name, last_name: contact.last_name, full_name: contact.full_name, title: contact.title },
      company_known: company
        ? { address: company.address, city: company.city, region: company.region, country: company.country, phone: company.phone }
        : null,
      missing: missingDetails(contact),
      messages: messages.map(m => ({
        subject: m.subject || null,
        sent_at: m.sent_at,
        body: String(m.body_text || '').slice(0, BODY_CHARS),
      })),
    }));
    fs.writeFileSync(path.resolve(dumpTo), JSON.stringify(payload, null, 2));
    console.log(`Wrote ${payload.length} candidates to ${dumpTo}`);
    return;
  }

  let records = null;
  if (fromFile) {
    records = new Map();
    const parsed = JSON.parse(fs.readFileSync(path.resolve(fromFile), 'utf8'));
    for (const r of parsed) {
      const k = String(r.email || '').trim().toLowerCase();
      if (k) records.set(k, r);
    }
    console.log(`Read ${records.size} extracted records from ${fromFile}`);
  }

  const applied = [];
  const appliedCompanies = [];
  const rejected = [];
  let seen = 0;

  const companySeen = new Set();
  for (const { contact, company, company_name, messages } of candidates) {
    if (seen >= limit) break;
    seen++;
    const key = String(contact.email).trim().toLowerCase();

    let extracted;
    if (records) {
      if (!records.has(key)) continue;
      extracted = records.get(key);
    } else {
      // Newest first; stop at the first message that yields anything usable.
      extracted = { first_name: null, last_name: null, title: null };
      for (const m of messages) {
        const got = await extractContactDetails({
          subject: m.subject, body: m.body_text, sender: contact.email, companyName: company_name,
        });
        if (got.first_name || got.last_name || got.title) { extracted = got; break; }
      }
    }

    const plan = planDetailsFill(contact, extracted, { companyName: company_name });
    if (plan) {
      applied.push({ email: contact.email, company: company_name, patch: plan.patch });
      if (live) await write(sb, contact.email, plan.patch);
    } else if (extracted.first_name || extracted.last_name || extracted.title) {
      rejected.push({ email: contact.email, extracted });
    }

    // One company, one address write: several contacts can carry the same
    // signature block, and the second one through would find nothing left to
    // fill anyway (fill-only), but the state it reads is the stale copy loaded
    // at the start of the run.
    if (company && !companySeen.has(company.id)) {
      const location = planLocationFill(company, extracted);
      if (location) {
        companySeen.add(company.id);
        appliedCompanies.push({ id: company.id, name: company_name, patch: location.patch });
        if (live) await writeCompany(sb, company.id, location.patch);
      }
    }
  }

  for (const a of applied) {
    const bits = Object.entries(a.patch).map(([k, v]) => `${k}="${v}"`).join(' ');
    console.log(`${live ? 'WROTE' : 'would write'}  ${a.email.padEnd(38)} ${bits}`);
  }
  for (const a of appliedCompanies) {
    const bits = Object.entries(a.patch).map(([k, v]) => `${k}="${v}"`).join(' ');
    console.log(`${live ? 'WROTE' : 'would write'}  ${String(a.name || a.id).padEnd(38)} ${bits}`);
  }
  if (rejected.length) {
    console.log(`\n${rejected.length} extractions refused by the gate (already on file, ours, or disagreeing with the name we hold):`);
    for (const r of rejected) console.log(`  ${r.email} — ${JSON.stringify(r.extracted)}`);
  }
  console.log(`\n${applied.length} contacts and ${appliedCompanies.length} company addresses `
    + `${live ? 'updated' : 'would be updated'} (of ${seen} considered).`);
  if (!live && (applied.length || appliedCompanies.length)) console.log('Re-run with --live to write.');
}

main().catch(err => { console.error(err); process.exit(1); });
