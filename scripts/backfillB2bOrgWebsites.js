#!/usr/bin/env node
/**
 * backfillB2bOrgWebsites.js — give the website-less imported rows a website,
 * derived from their contact's email domain.
 *
 * The CenterLink Klaviyo/sheet imports created ~126 org rows carrying nothing
 * but a name slug and an email — no website, no description. They can't be
 * researched, drafted for, or judged in that state. But the name slug IS the
 * domain (`Pacificcenter` → pacificcenter.org), and 121 of them have a contact
 * on their own org domain, so the website is sitting right there in the email.
 *
 * Derived, not verified: the row records `metadata.website_source =
 * 'email_domain'` so the research pass (and anyone reading the row) knows this
 * was inferred rather than confirmed.
 *
 * Free-mail domains are never used — a gmail.com contact tells us nothing about
 * the org, and writing "https://gmail.com" onto a company row would be worse
 * than leaving it null.
 *
 * Usage: node scripts/backfillB2bOrgWebsites.js [--execute]
 *   Default is print-only.
 */
require('dotenv').config();

const { getSupabaseClient, fetchAllPaginated } = require('../shared/supabaseClient');

const FREE_MAIL = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'live.com', 'msn.com', 'me.com', 'mac.com', 'protonmail.com',
  'proton.me', 'gmx.com', 'yandex.com', 'mail.com', 'comcast.net', 'att.net',
  'verizon.net', 'sbcglobal.net', 'googlemail.com', 'ymail.com', 'yahoo.co.uk',
  'hotmail.co.uk', 'outlook.com.au', 'bigpond.com',
]);

/**
 * Org website from an email address, or null when the domain tells us nothing.
 * Pure.
 */
function deriveWebsiteFromEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
  if (!domain || FREE_MAIL.has(domain)) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  if (!/\.[a-z]{2,}$/.test(domain)) return null;
  return `https://${domain}`;
}

/**
 * Pick the website for a company from its contacts. Prefers the primary
 * contact, then the first active one that yields a usable domain. Returns null
 * when the company already has a website or no contact yields a domain. Pure.
 */
function chooseWebsite(company, contacts) {
  if (company.website) return null;
  const active = (contacts || []).filter(c => c.is_active !== false);
  const ordered = [...active.filter(c => c.is_primary), ...active.filter(c => !c.is_primary)];
  for (const c of ordered) {
    const site = deriveWebsiteFromEmail(c.email);
    if (site) return site;
  }
  return deriveWebsiteFromEmail(company.general_email);
}

/** Metadata may still be a stringified blob if the field repair hasn't run. Pure. */
function parseMetadata(meta) {
  if (typeof meta === 'string') {
    try { const p = JSON.parse(meta); return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {}; } catch { return {}; }
  }
  return (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta : {};
}

async function main() {
  const execute = process.argv.includes('--execute');
  const sb = getSupabaseClient();

  const companies = await fetchAllPaginated(() => sb.from('b2b_companies')
    .select('id, name, website, general_email, relationship_type, source, metadata'));
  const contacts = await fetchAllPaginated(() => sb.from('b2b_contacts')
    .select('company_id, email, is_active, is_primary').not('company_id', 'is', null));

  const byCompany = new Map();
  for (const c of contacts) {
    if (!byCompany.has(c.company_id)) byCompany.set(c.company_id, []);
    byCompany.get(c.company_id).push(c);
  }

  const updates = [];
  for (const c of companies) {
    const website = chooseWebsite(c, byCompany.get(c.id));
    if (!website) continue;
    updates.push({
      company: c,
      website,
      metadata: { ...parseMetadata(c.metadata), website_source: 'email_domain' },
    });
  }

  if (!updates.length) {
    console.log('Nothing to backfill — every website-less row lacks a usable contact domain.');
    return;
  }

  const bySource = updates.reduce((a, u) => { a[u.company.source || '?'] = (a[u.company.source || '?'] || 0) + 1; return a; }, {});
  console.log(`${updates.length} companies get a derived website${execute ? '' : ' (print-only, pass --execute to apply)'}`);
  console.log(`by source: ${JSON.stringify(bySource)}\n`);
  for (const u of updates) console.log(`  ${u.company.name} → ${u.website}`);

  if (!execute) return;

  let applied = 0;
  for (const u of updates) {
    const { error } = await sb.from('b2b_companies')
      .update({ website: u.website, metadata: u.metadata, updated_at: new Date().toISOString() })
      .eq('id', u.company.id);
    if (error) throw new Error(`update ${u.company.id} (${u.company.name}): ${error.message}`);
    applied++;
  }
  console.log(`\nApplied ${applied}/${updates.length}.`);
}

module.exports = { deriveWebsiteFromEmail, chooseWebsite, parseMetadata };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
