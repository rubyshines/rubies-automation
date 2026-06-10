/**
 * backfillOrgContacts.js — Phase-1 prerequisite of the outreach migration
 * (Design #8): the ~12 live LGBTQ+ org relationships found in the Gmail
 * corpus (b2b-historical-findings.md §1.3) that have no b2b_companies/
 * b2b_contacts rows. Without them, reply-correlation misses active
 * relationships on day one.
 *
 * Idempotent: upserts by company id / contact email; safe to re-run.
 * Dry-run by default; --execute writes.
 *
 * Usage: node gmail-management/scripts/backfillOrgContacts.js [--execute]
 */
require('dotenv').config();
const { getSupabaseClient } = require('../../shared/supabaseClient');
const sb = getSupabaseClient();
const EXECUTE = process.argv.includes('--execute');

// Source: .claude/plans/b2b-historical-findings.md §1.3 (2026-06-10).
// notes carry the bespoke-arrangement facts the advisor must know (locked
// 2026-06-10: bespoke arrangements live as profile notes, not schema).
const ORGS = [
  { id: 'transgender-victoria', name: 'Transgender Victoria', country: 'Australia', email: 'ez@tgv.org.au', full_name: 'Ez Lowes', role: 'program_coordinator', title: 'Affirmation Station Manager', status: 'qualified_lead', notes: 'Donation-routing partner-in-progress (15-msg thread in corpus).' },
  { id: 'fenway-health', name: 'Fenway Health', city: 'Boston', region: 'MA', country: 'USA', email: 'cskaggs@fenwayhealth.org', full_name: 'Courtney Skaggs', role: 'program_coordinator', title: 'Trans Health Program', status: 'active_partner', notes: 'BESPOKE ARRANGEMENT: active gift-card program (~$720 outstanding as of Jun 2026). Advisor must know this before drafting.' },
  { id: 'gr-trans-foundation', name: 'GR Trans Foundation', city: 'Grand Rapids', region: 'MI', country: 'USA', email: 'info@grtransfoundation.org', full_name: 'Gage', role: 'program_coordinator', status: 'active_partner', notes: 'BESPOKE ARRANGEMENT: annual discount-code program ("partner in this program"). Advisor must know this before drafting.' },
  { id: 'lumenus-foundation', name: 'Lumenus Foundation', city: 'Toronto', region: 'ON', country: 'Canada', email: 'lchampion@lumenus.ca', full_name: 'Laura Champion', role: 'program_coordinator', status: 'active_partner', notes: 'Recurring Pride event partner.' },
  { id: 'socirc', name: 'SoCirC', country: 'Canada', email: 'rachel@socirc.ca', full_name: 'Rachel David', role: 'program_coordinator', status: 'active_partner', notes: 'Pride party performer/partner; $500 donation history.' },
  { id: 'tdsb-gsd-team', name: 'TDSB Gender & Sexual Diversity Team', city: 'Toronto', region: 'ON', country: 'Canada', email: 'ilana.david@tdsb.on.ca', full_name: 'Ilana David', role: 'program_coordinator', status: 'qualified_lead', notes: 'Event amplification partner.' },
  { id: 'colage', name: 'COLAGE', country: 'USA', email: 'katyc@colage.org', full_name: 'Katy Chatel', role: 'program_coordinator', status: 'lead', notes: 'Inbound event-donation requester.' },
  { id: 'montgomery-pride-united', name: 'Montgomery Pride United', city: 'Montgomery', region: 'AL', country: 'USA', email: 'lorelei@montgomeryprideunited.org', full_name: 'Lorelei', role: 'program_coordinator', status: 'qualified_lead', notes: 'Onboarding in progress (met 2026-06-04).' },
  { id: 'unity-conejo', name: 'Unity Conejo', region: 'CA', country: 'USA', email: 'jess@unityconejo.org', full_name: 'Jess', role: 'program_coordinator', status: 'qualified_lead', notes: 'Partnership discussion in progress.' },
  { id: 'thprojekt', name: 'THProjekt', country: 'Germany', email: 'thprojekt@gmx.net', full_name: 'Billy', role: 'program_coordinator', status: 'active_partner', notes: 'Donation closet partner — signed agreement Apr 2026.' },
  { id: 'mcminnville-trans-network', name: 'McMinnville Trans Network', region: 'OR', country: 'USA', email: null, full_name: null, role: null, status: 'lead', notes: 'Return-routing destination referenced in corpus; no direct thread or email yet — company row only.' },
  { id: 'carleton-cusa', name: 'Carleton CUSA Gender & Sexuality Resource Centre', city: 'Ottawa', region: 'ON', country: 'Canada', email: 'eman.elnaidany1@cusaonline.ca', full_name: 'Eman Elnaidany', role: 'program_coordinator', status: 'active_partner', notes: 'Human contact behind the gsrc@ alias already in b2b_contacts.' },
];

(async () => {
  console.log(EXECUTE ? '=== EXECUTE ===' : '=== DRY RUN (pass --execute to write) ===');
  let companies = 0, contacts = 0, skippedContacts = 0;
  for (const org of ORGS) {
    const companyRow = {
      id: org.id,
      name: org.name,
      relationship_type: 'lgbtq_org',
      city: org.city || null,
      region: org.region || null,
      country: org.country || null,
      status: org.status,
      temperature: 'warm',
      source: 'email',
      metadata: { backfill: 'historical_findings_2026_06_10' },
      updated_at: new Date().toISOString(),
    };
    if (EXECUTE) {
      const { error } = await sb.from('b2b_companies').upsert(companyRow, { onConflict: 'id' });
      if (error) throw new Error(`${org.id} company: ${error.message}`);
    } else {
      console.log(`  company: ${org.id} (${org.status})`);
    }
    companies++;

    if (!org.email) { skippedContacts++; continue; }
    const email = org.email.toLowerCase();
    const contactRow = {
      id: email,
      email,
      company_id: org.id,
      full_name: org.full_name || null,
      role: org.role || null,
      title: org.title || null,
      is_primary: true,
      is_active: true,
      source: 'email_detected',
      notes: org.notes,
      updated_at: new Date().toISOString(),
    };
    if (EXECUTE) {
      const { error } = await sb.from('b2b_contacts').upsert(contactRow, { onConflict: 'email' });
      if (error) throw new Error(`${org.id} contact: ${error.message}`);
    } else {
      console.log(`    contact: ${email} (${org.full_name || '—'})`);
    }
    contacts++;
  }
  console.log(`\n${EXECUTE ? 'Wrote' : 'Would write'}: ${companies} companies, ${contacts} contacts (${skippedContacts} org(s) without email — company row only)`);
})().catch(e => { console.error(e); process.exit(1); });
