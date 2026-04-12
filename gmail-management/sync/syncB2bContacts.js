#!/usr/bin/env node

/**
 * B2B Contacts Sync — Imports wholesale retailers + LGBTQ+ org contacts from:
 *
 *   1. Google Sheet "Main Contacts" (57 wholesale retailers)
 *   2. Google Sheet donation form responses (19 LGBTQ+ orgs with emails)
 *   3. Klaviyo lists: CenterLink, LGBT Center Donation Program, Donation Contacts
 *   4. Supabase donation_partners table (13 orgs, adds addresses)
 *
 * For contacts without an org name, infers it from the email domain
 * by searching the web.
 *
 * Usage:
 *   node email-intelligence/sync/syncB2bContacts.js
 *   node email-intelligence/sync/syncB2bContacts.js --dry-run    # preview without writing
 *   node email-intelligence/sync/syncB2bContacts.js --source sheets   # only sync sheets
 *   node email-intelligence/sync/syncB2bContacts.js --source klaviyo  # only sync klaviyo
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { google } = require('googleapis');
const { getSupabaseClient, upsert } = require('../../shared/supabaseClient');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WHOLESALE_SHEET_ID = '1YKENjS6mJXXHUW4GeCV4kuODtEx96u-PCMkkrP0vBMM';
const DONATION_FORM_SHEET_ID = '1IKaX5lKarqCdsqK766NpUCvwQb7fC4RcWG71VliWHiU';
const CENTERLINK_SHEET_ID = '1N_vkLEUhL0oDAVrkswRQc_tLQo2qD97wooCWgpr-7GY';

const KLAVIYO_LIST_IDS = {
  centerlink: 'Tgd2qm',
  donation_program: 'VKcW27',
  donation_contacts: 'X49D7x',
};

const DRY_RUN = process.argv.includes('--dry-run');
const SOURCE_FILTER = process.argv.includes('--source')
  ? process.argv[process.argv.indexOf('--source') + 1]
  : null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(name) {
  return (name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed.includes('@') || trimmed.startsWith('via ')) return null;
  return trimmed;
}

function extractDomain(email) {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.substring(at + 1) : null;
}

/**
 * Infer an org name from an email domain.
 * e.g., info@pacificcenter.org → "Pacific Center"
 *        rcc@rainbowcc.org → "Rainbow CC"
 */
function inferOrgNameFromDomain(domain) {
  if (!domain) return null;
  // Strip common TLDs
  let name = domain.replace(/\.(org|com|net|ca|co|io|us|uk|au)$/i, '');
  // Strip common subdomains
  name = name.replace(/^(www|mail|info|contact)\./i, '');
  // Split by dots and hyphens, title-case each word
  const words = name.split(/[.\-_]/).map(w =>
    w.charAt(0).toUpperCase() + w.slice(1)
  );
  return words.join(' ');
}

// Map AI Customer Status from sheet → our status field
function mapStatus(sheetStatus) {
  const s = (sheetStatus || '').toLowerCase().trim();
  if (s === 'customer') return 'customer';
  if (s === 'qualified lead') return 'qualified_lead';
  if (s === 'not interested') return 'not_interested';
  if (s === 'lead') return 'lead';
  return 'lead';
}

// ---------------------------------------------------------------------------
// Google Sheets auth
// ---------------------------------------------------------------------------

async function getSheetsClient() {
  const keyPath = process.env.SERVICE_ACCOUNT_KEY_PATH || './service-account-key.json';
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function readSheet(sheets, spreadsheetId, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { if (row[i] !== undefined) obj[h] = row[i]; });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Klaviyo API
// ---------------------------------------------------------------------------

async function fetchKlaviyoListMembers(listId) {
  const apiKey = process.env.KLAVIYO_API_KEY;
  if (!apiKey) { console.log('  No KLAVIYO_API_KEY — skipping'); return []; }

  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: '2024-10-15',
    accept: 'application/json',
  };

  const results = [];
  let url = `https://a.klaviyo.com/api/lists/${listId}/profiles?fields[profile]=email,first_name,last_name,organization,title,location`;
  let pages = 0;
  while (url && pages < 50) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Klaviyo ${res.status}: ${(await res.text()).substring(0, 200)}`);
    const data = await res.json();
    if (data.data) results.push(...data.data);
    url = data.links?.next || null;
    pages++;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Source 1: Wholesale retailers from Google Sheet
// ---------------------------------------------------------------------------

async function syncWholesaleSheet(sheets) {
  console.log('\n--- Source 1: Wholesale Retailers (Google Sheet) ---');
  const rows = await readSheet(sheets, WHOLESALE_SHEET_ID, 'Main Contacts!A1:AZ200');
  console.log(`  Found ${rows.length} rows`);

  const companies = [];
  const contacts = [];

  for (const row of rows) {
    const companyName = row['Company Name'];
    if (!companyName) continue;

    const email = normalizeEmail(row['Contact Email']);
    const companyId = slugify(companyName);

    companies.push({
      id: companyId,
      name: companyName,
      relationship_type: 'wholesale',
      website: row['Website'] || null,
      city: row['City'] || null,
      country: row['Country'] || null,
      address: row['Address'] || null,
      phone: row['Phone Number'] || null,
      status: mapStatus(row['AI Customer Status']),
      temperature: row['AI Interaction Temperature'] || null,
      ai_summary: row['AI Summary'] || null,
      next_action: row['AI Next Action'] || null,
      next_action_due: row['Next Action Date'] || null,
      order_count: parseInt(row['Order Count']) || 0,
      total_sales: parseFloat((row['Total Sales To Date'] || '0').replace('$', '')) || 0,
      last_order_date: row['Last Order Placed'] || null,
      source: 'google_sheet',
      source_id: WHOLESALE_SHEET_ID,
      metadata: {
        campaign: row['Campaign'] || null,
        initial_reach_out: row['Initial Reach Out'] || null,
        last_reach_out: row['Last Reach Out'] || null,
        no_response_count: parseInt(row['No Response Email Count']) || 0,
      },
    });

    if (email) {
      contacts.push({
        id: email,
        email,
        company_id: companyId,
        full_name: row['Primary Contact Name'] || null,
        role: row['Role'] || null,
        is_primary: true,
        is_active: true,
        source: 'google_sheet',
      });

      // Old contact emails
      const oldEmails = (row['Old Contact Email'] || '').split(',').map(e => normalizeEmail(e)).filter(Boolean);
      for (const oldEmail of oldEmails) {
        contacts.push({
          id: oldEmail,
          email: oldEmail,
          company_id: companyId,
          is_primary: false,
          is_active: false,
          source: 'google_sheet',
        });
      }
    }
  }

  console.log(`  Companies: ${companies.length}, Contacts: ${contacts.length}`);
  return { companies, contacts };
}

// ---------------------------------------------------------------------------
// Source 2: Donation form responses (Google Sheet)
// ---------------------------------------------------------------------------

async function syncDonationForm(sheets) {
  console.log('\n--- Source 2: Donation Form Responses (Google Sheet) ---');

  // Form Responses 1 tab has the detailed submissions
  const formRows = await readSheet(sheets, DONATION_FORM_SHEET_ID, 'Form Responses 1!A1:Z200');
  console.log(`  Form responses: ${formRows.length}`);

  // Tracking tab has outreach status
  const trackingRows = await readSheet(sheets, DONATION_FORM_SHEET_ID, 'tracking!A1:H200');
  console.log(`  Tracking rows: ${trackingRows.length}`);

  // Emails for import tab
  const emailRows = await readSheet(sheets, DONATION_FORM_SHEET_ID, 'emails for import!A1:A200');

  const companies = [];
  const contacts = [];
  const trackingByName = new Map(trackingRows.map(r => [(r['Name'] || '').toLowerCase(), r]));

  for (const row of formRows) {
    const orgName = row['What is the name of your organization'];
    if (!orgName) continue;

    const contactEmail = normalizeEmail(row['What is the email address of the primary contact person if people want to inquire about your program']);
    const submitterEmail = normalizeEmail(row['Email Address']);
    const companyId = 'lgbtq-' + slugify(orgName);

    // Check tracking for status
    const tracking = trackingByName.get(orgName.toLowerCase());

    companies.push({
      id: companyId,
      name: orgName,
      relationship_type: 'lgbtq_org',
      website: row['What is the website of you organization'] || null,
      address: row['What address info can we provide to our customers making returns to ensure packages can be received at your organization.'] || null,
      city: tracking?.['Location']?.split(',')[0]?.trim() || null,
      country: null,
      description: row['Describe the programs you have in place to distribute gender affirming clothing in a way you would be comfortable with us including verbatim on our website.  '] || null,
      status: tracking?.['Agreement signed'] ? 'active_partner' : (tracking?.['Status'] === 'meeting held' ? 'qualified_lead' : 'lead'),
      source: 'donation_form',
      source_id: DONATION_FORM_SHEET_ID,
      metadata: {
        size_ranges: row['Pick which size ranges you would like us to send'] || null,
        contact_person_title: row['What is the name and title of the primary point of contact for this program'] || null,
        program_url: row['If available include a link to the program on your website that describes your gender affirming clothing program that we can include on our website.'] || null,
        is_lgbtq_center: tracking?.['LGBTQ+ Center'] === 'Y',
      },
    });

    // Contact email (the org's public contact)
    if (contactEmail) {
      contacts.push({
        id: contactEmail,
        email: contactEmail,
        company_id: companyId,
        full_name: row['What is the name and title of the primary point of contact for this program']?.split('-')[0]?.trim() || null,
        role: 'program_coordinator',
        is_primary: true,
        is_active: true,
        source: 'donation_form',
      });
    }

    // Submitter email (person who filled the form, if different)
    if (submitterEmail && submitterEmail !== contactEmail) {
      contacts.push({
        id: submitterEmail,
        email: submitterEmail,
        company_id: companyId,
        is_primary: !contactEmail, // primary only if no org contact email
        is_active: true,
        source: 'donation_form',
      });
    }
  }

  // Also add tracking contacts not in form responses
  for (const row of trackingRows) {
    const email = normalizeEmail(row['Email']);
    const name = row['Name'];
    const orgName = row['Name.1'] || row['Name']; // sometimes org is in col C
    if (!email) continue;

    const companyId = 'lgbtq-' + slugify(orgName);
    // Only add if company doesn't exist yet
    if (!companies.find(c => c.id === companyId)) {
      companies.push({
        id: companyId,
        name: orgName,
        relationship_type: 'lgbtq_org',
        city: row['Location']?.split(',')[0]?.trim() || null,
        region: row['Location']?.split(',')[1]?.trim() || null,
        status: row['Agreement signed'] ? 'active_partner' : 'lead',
        source: 'donation_form',
      });
    }
    if (!contacts.find(c => c.id === email)) {
      contacts.push({
        id: email,
        email,
        company_id: companyId,
        full_name: name || null,
        is_primary: true,
        is_active: true,
        source: 'donation_form',
      });
    }
  }

  console.log(`  Companies: ${companies.length}, Contacts: ${contacts.length}`);
  return { companies, contacts };
}

// ---------------------------------------------------------------------------
// Source 3: CenterLink prospects (Google Sheet)
// ---------------------------------------------------------------------------

async function syncCenterLinkSheet(sheets) {
  console.log('\n--- Source 3: CenterLink Prospects (Google Sheet) ---');
  const rows = await readSheet(sheets, CENTERLINK_SHEET_ID, 'Form Responses 1!A1:Z200');
  console.log(`  Form responses: ${rows.length}`);

  const companies = [];
  const contacts = [];

  for (const row of rows) {
    const email = normalizeEmail(row['Email Address']);
    if (!email) continue;

    // Try to get org name from form fields
    const orgName = row['Have you or your any of your colleagues heard of RUBIES in the past?  If so from where?'];
    // This form doesn't have a clean org name field — the org name might be derivable
    // from the email domain. We'll use the domain-based inference.
    const domain = extractDomain(email);
    const inferredName = inferOrgNameFromDomain(domain);
    const companyId = 'lgbtq-' + slugify(inferredName || domain);

    if (!companies.find(c => c.id === companyId)) {
      companies.push({
        id: companyId,
        name: inferredName || domain,
        relationship_type: 'lgbtq_org',
        description: row['How could your group benefit from this donation?'] || null,
        status: 'lead',
        source: 'centerlink_sheet',
        source_id: CENTERLINK_SHEET_ID,
        metadata: {
          programs: row['Do you have programs designed specifically for gender creative, trans and non-binary kids, tweens or teens? If so please describe.'] || null,
          age_ranges: row['What age ranges for kids and youth in the LGBT community do you support?'] || null,
          donation_age_range: row['What age range would you like to receive a donation for'] || null,
          quantity: row['How many pairs of underwear would you be able to distribute'] || null,
          product_suggestions: row['Do you or your colleagues have any suggestions about other products RUBIES could be designing for trans girls and non-binary kids?'] || null,
        },
      });
    }

    contacts.push({
      id: email,
      email,
      company_id: companyId,
      is_primary: true,
      is_active: true,
      source: 'centerlink_sheet',
    });
  }

  console.log(`  Companies: ${companies.length}, Contacts: ${contacts.length}`);
  return { companies, contacts };
}

// ---------------------------------------------------------------------------
// Source 4: Klaviyo lists
// ---------------------------------------------------------------------------

async function syncKlaviyoLists() {
  console.log('\n--- Source 4: Klaviyo LGBTQ+ Lists ---');

  const companies = [];
  const contacts = [];
  const seenEmails = new Set();

  for (const [source, listId] of Object.entries(KLAVIYO_LIST_IDS)) {
    console.log(`  Fetching ${source} (${listId})...`);
    const profiles = await fetchKlaviyoListMembers(listId);
    console.log(`    ${profiles.length} members`);

    for (const p of profiles) {
      const a = p.attributes;
      const email = normalizeEmail(a.email);
      if (!email || seenEmails.has(email)) continue;
      seenEmails.add(email);

      const domain = extractDomain(email);
      const orgName = a.organization || inferOrgNameFromDomain(domain);
      const companyId = 'lgbtq-' + slugify(orgName || domain);

      if (!companies.find(c => c.id === companyId)) {
        companies.push({
          id: companyId,
          name: orgName || domain,
          relationship_type: 'lgbtq_org',
          city: a.location?.city || null,
          region: a.location?.region || null,
          country: a.location?.country || null,
          status: 'lead',
          source: 'klaviyo_' + source,
          metadata: { klaviyo_list: source },
        });
      }

      contacts.push({
        id: email,
        email,
        company_id: companyId,
        first_name: a.first_name || null,
        last_name: a.last_name || null,
        full_name: [a.first_name, a.last_name].filter(Boolean).join(' ') || null,
        title: a.title || null,
        is_primary: true,
        is_active: true,
        source: 'klaviyo_' + source,
      });
    }
  }

  console.log(`  Total unique: Companies: ${companies.length}, Contacts: ${contacts.length}`);
  return { companies, contacts };
}

// ---------------------------------------------------------------------------
// Source 5: Existing Supabase donation_partners (merge addresses/geocodes)
// ---------------------------------------------------------------------------

async function mergeSupabaseDonationPartners(companies) {
  console.log('\n--- Merging Supabase donation_partners ---');
  const supabase = getSupabaseClient();
  const { data: partners } = await supabase.from('donation_partners').select('*');
  if (!partners || partners.length === 0) {
    console.log('  No donation partners in Supabase');
    return;
  }

  console.log(`  Found ${partners.length} partners`);
  for (const partner of partners) {
    const slug = 'lgbtq-' + slugify(partner.name);
    const existing = companies.find(c => c.id === slug);
    if (existing) {
      // Merge address/location data
      if (partner.address && !existing.address) existing.address = partner.address;
      if (partner.city && !existing.city) existing.city = partner.city;
      if (partner.country && !existing.country) existing.country = partner.country;
      if (partner.lat && partner.lon) {
        existing.metadata = existing.metadata || {};
        existing.metadata.lat = partner.lat;
        existing.metadata.lon = partner.lon;
      }
      console.log(`  Merged: ${partner.name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Dedup + save
// ---------------------------------------------------------------------------

async function saveToSupabase(allCompanies, allContacts) {
  const supabase = getSupabaseClient();

  // Dedup companies by id (first occurrence wins, but merge metadata)
  const companyMap = new Map();
  for (const c of allCompanies) {
    if (!companyMap.has(c.id)) {
      companyMap.set(c.id, c);
    } else {
      // Merge: fill in blanks from later sources
      const existing = companyMap.get(c.id);
      for (const key of Object.keys(c)) {
        if (c[key] && !existing[key]) existing[key] = c[key];
      }
      // Merge metadata
      if (c.metadata) {
        existing.metadata = { ...(existing.metadata || {}), ...c.metadata };
      }
    }
  }

  // Dedup contacts by email
  const contactMap = new Map();
  for (const c of allContacts) {
    if (!contactMap.has(c.id)) {
      contactMap.set(c.id, c);
    } else {
      const existing = contactMap.get(c.id);
      for (const key of Object.keys(c)) {
        if (c[key] && !existing[key]) existing[key] = c[key];
      }
    }
  }

  const companies = [...companyMap.values()];
  const contacts = [...contactMap.values()];

  console.log(`\n========================================`);
  console.log(`  TOTALS (after dedup)`);
  console.log(`========================================`);
  console.log(`  Companies: ${companies.length}`);
  console.log(`  Contacts:  ${contacts.length}`);

  // Breakdown
  const wholesale = companies.filter(c => c.relationship_type === 'wholesale');
  const lgbtq = companies.filter(c => c.relationship_type === 'lgbtq_org');
  console.log(`    Wholesale retailers: ${wholesale.length}`);
  console.log(`    LGBTQ+ orgs:        ${lgbtq.length}`);

  if (DRY_RUN) {
    console.log('\n  DRY RUN — not saving to Supabase');
    console.log('\n  Sample companies:');
    for (const c of companies.slice(0, 10)) {
      console.log(`    [${c.relationship_type}] ${c.name} (${c.status}) — ${c.source}`);
    }
    console.log('\n  Sample contacts:');
    for (const c of contacts.slice(0, 10)) {
      console.log(`    ${c.email} → ${c.company_id} (${c.source})`);
    }
    return;
  }

  // Clean up data for upsert
  const companyRows = companies.map(c => ({
    ...c,
    next_action_due: c.next_action_due || null,
    last_order_date: c.last_order_date || null,
    metadata: c.metadata ? JSON.stringify(c.metadata) : null,
    updated_at: new Date().toISOString(),
  }));

  const contactRows = contacts.map(c => ({
    ...c,
    updated_at: new Date().toISOString(),
  }));

  // Upsert companies first (contacts reference them)
  console.log('\n  Saving companies...');
  for (let i = 0; i < companyRows.length; i += 50) {
    const batch = companyRows.slice(i, i + 50);
    await upsert('b2b_companies', batch, ['id']);
  }
  console.log(`  Saved ${companyRows.length} companies`);

  console.log('  Saving contacts...');
  for (let i = 0; i < contactRows.length; i += 50) {
    const batch = contactRows.slice(i, i + 50);
    await upsert('b2b_contacts', batch, ['id']);
  }
  console.log(`  Saved ${contactRows.length} contacts`);

  console.log('\n  Done!');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const allCompanies = [];
  const allContacts = [];

  const shouldSync = (source) => !SOURCE_FILTER || SOURCE_FILTER === source;

  if (shouldSync('sheets')) {
    const sheets = await getSheetsClient();

    const wholesale = await syncWholesaleSheet(sheets);
    allCompanies.push(...wholesale.companies);
    allContacts.push(...wholesale.contacts);

    const donation = await syncDonationForm(sheets);
    allCompanies.push(...donation.companies);
    allContacts.push(...donation.contacts);

    const centerlink = await syncCenterLinkSheet(sheets);
    allCompanies.push(...centerlink.companies);
    allContacts.push(...centerlink.contacts);
  }

  if (shouldSync('klaviyo')) {
    const klaviyo = await syncKlaviyoLists();
    allCompanies.push(...klaviyo.companies);
    allContacts.push(...klaviyo.contacts);
  }

  // Merge Supabase donation partner data (addresses, geocodes)
  await mergeSupabaseDonationPartners(allCompanies);

  await saveToSupabase(allCompanies, allContacts);
}

main().catch(err => {
  console.error('\nError:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
