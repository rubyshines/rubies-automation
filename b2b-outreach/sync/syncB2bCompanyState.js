/**
 * syncB2bCompanyState.js — keep b2b_companies commerce/program state true.
 *
 * The cadence engine reads last_order_date / order_count / relationship_state
 * to decide reorder nudges and dormancy, but nothing ever wrote those fields
 * after the initial import — so the queue nudged retailers who ordered last
 * week ("122d since last order") and called active partners dormant.
 *
 * Daily (as a daily-sync-all sub-pipeline, after Orders) this:
 *   1. Matches Shopify orders (Supabase `orders` mirror) to companies via all
 *      known emails (b2b_contacts + general_email), non-cancelled only.
 *   2. Updates order_count / last_order_date / total_sales when drifted.
 *   3. Promotes relationship_state in_contact → active on first order
 *      (retailers/affiliates) — never touches 'lost', never downgrades.
 *   4. Marks org program_flags: donation_closet for companies matching an
 *      active donation_partners row (by website domain, name fallback);
 *      purchases for orgs with at least one order. Orgs in a program → active.
 *
 * Deterministic sync logic — no AI. Dormancy stays derived at queue time from
 * last_order_date; this module never sets 'dormant'.
 */
const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');

/**
 * Frequency-aligned reorder threshold: 0.75 × the most recent order interval,
 * clamped to [90, 365] days. The LAST interval (not median/mean) because
 * bursty histories (monthly cluster then an annual rhythm) make averages lie
 * in both directions. Null with fewer than 2 orders — cadence falls back to
 * its 90d default. Pure.
 */
function reorderThresholdDays(orders) {
  const valid = (orders || []).filter(o => !o.cancelled_at)
    .map(o => new Date(o.created_at).getTime()).sort((a, b) => a - b);
  if (valid.length < 2) return null;
  const lastIntervalDays = (valid[valid.length - 1] - valid[valid.length - 2]) / 86400000;
  return Math.min(365, Math.max(90, Math.round(lastIntervalDays * 0.75)));
}

/** "https://www.foo.org/x" → "foo.org". Pure. */
function normalizeDomain(url) {
  if (!url) return null;
  const m = String(url).toLowerCase().match(/^(?:https?:\/\/)?(?:www\.)?([^/:?#]+)/);
  return m ? m[1] : null;
}

/**
 * Compute the field updates a company needs, or null when in sync. Pure.
 * @param company  b2b_companies row
 * @param orders   matched orders [{ created_at, total_price, cancelled_at, financial_status }]
 * @param isDonationPartner  company matches an active donation_partners row
 */
function computeCompanyState(company, orders, isDonationPartner) {
  const valid = (orders || []).filter(o => !o.cancelled_at);
  const upd = {};

  const orderCount = valid.length;
  const lastOrderAt = orderCount
    ? valid.map(o => o.created_at).sort().pop()
    : null;
  const totalSales = Math.round(valid.reduce((s, o) => s + (Number(o.total_price) || 0), 0) * 100) / 100;

  if (orderCount !== (company.order_count || 0)) upd.order_count = orderCount;
  // last_order_date is a DATE column — compare and write at day granularity,
  // or every run rewrites all rows (timestamp vs date never matches).
  const prevLast = company.last_order_date ? String(company.last_order_date).slice(0, 10) : null;
  const nextLast = lastOrderAt ? new Date(lastOrderAt).toISOString().slice(0, 10) : null;
  if (nextLast && nextLast !== prevLast) upd.last_order_date = nextLast;
  if (totalSales !== Number(company.total_sales || 0)) upd.total_sales = totalSales;

  const threshold = reorderThresholdDays(valid);
  // Some sheet-imported rows carry metadata as a JSON string — parse, never discard.
  let meta = company.metadata || {};
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = { legacy_metadata: company.metadata }; } }
  if (threshold !== (meta.reorder_threshold_days ?? null) && threshold !== null) {
    upd.metadata = { ...meta, reorder_threshold_days: threshold };
  }

  const isOrg = company.relationship_type === 'lgbtq_org';
  const flags = { ...(company.program_flags || {}) };
  let flagsChanged = false;
  if (isOrg && isDonationPartner && !flags.donation_closet) { flags.donation_closet = true; flagsChanged = true; }
  if (isOrg && orderCount > 0 && !flags.purchases) { flags.purchases = true; flagsChanged = true; }
  if (flagsChanged) upd.program_flags = flags;

  // State promotion only — 'lost' is operator-owned, 'active' never downgrades
  // here, dormancy is computed at queue time.
  const state = company.relationship_state;
  const shouldBeActive = isOrg
    ? (isDonationPartner || orderCount > 0 || Object.values(flags).some(Boolean))
    : orderCount > 0;
  if (shouldBeActive && state !== 'active' && state !== 'lost') upd.relationship_state = 'active';

  return Object.keys(upd).length ? upd : null;
}

async function run() {
  const sb = getSupabaseClient();

  const companies = await fetchAllPaginated(() => sb.from('b2b_companies')
    .select('id, name, website, relationship_type, relationship_state, program_flags, order_count, last_order_date, total_sales, general_email, metadata'));
  const contacts = await fetchAllPaginated(() => sb.from('b2b_contacts')
    .select('company_id, email').not('company_id', 'is', null));

  const emailsByCompany = new Map(companies.map(c => [c.id, new Set()]));
  for (const c of companies) if (c.general_email) emailsByCompany.get(c.id).add(c.general_email.toLowerCase());
  for (const ct of contacts) emailsByCompany.get(ct.company_id)?.add(ct.email.toLowerCase());

  const emailToCompany = new Map();
  for (const [cid, emails] of emailsByCompany) for (const e of emails) emailToCompany.set(e, cid);
  const allEmails = [...emailToCompany.keys()];

  const ordersByCompany = new Map(companies.map(c => [c.id, []]));
  for (let i = 0; i < allEmails.length; i += 200) {
    const chunk = allEmails.slice(i, i + 200);
    const rows = await fetchAllPaginated(() => sb.from('orders')
      .select('customer_email, created_at, total_price, cancelled_at, financial_status')
      .in('customer_email', chunk));
    for (const o of rows) {
      const cid = emailToCompany.get((o.customer_email || '').toLowerCase());
      if (cid) ordersByCompany.get(cid).push(o);
    }
  }

  const { data: partners, error: pErr } = await sb.from('donation_partners')
    .select('name, website_url').eq('active', true);
  if (pErr) throw new Error(`donation_partners: ${pErr.message}`);
  const partnerDomains = new Set((partners || []).map(p => normalizeDomain(p.website_url)).filter(Boolean));
  const partnerNames = new Set((partners || []).map(p => (p.name || '').toLowerCase().trim()));

  let updated = 0;
  const changes = [];
  for (const c of companies) {
    // 'lost' rows are operator-closed (incl. junk-import rows grouped by
    // free-mail domain) — leave them entirely alone.
    if (c.relationship_state === 'lost') continue;
    const isPartner = (normalizeDomain(c.website) && partnerDomains.has(normalizeDomain(c.website)))
      || partnerNames.has((c.name || '').toLowerCase().trim());
    const upd = computeCompanyState(c, ordersByCompany.get(c.id), isPartner);
    if (!upd) continue;
    const { error } = await sb.from('b2b_companies')
      .update({ ...upd, updated_at: new Date().toISOString() }).eq('id', c.id);
    if (error) throw new Error(`update ${c.id}: ${error.message}`);
    updated++;
    changes.push(`${c.id}: ${Object.keys(upd).join(',')}`);
  }

  console.log(`B2B Company State — ${updated}/${companies.length} companies updated`);
  if (changes.length) console.log('  ' + changes.join('\n  '));
  return {
    sources: {
      b2b_company_state: { success: true, rowsWritten: updated, error: null },
    },
    status: 'success',
  };
}

module.exports = { run, computeCompanyState, reorderThresholdDays, normalizeDomain };

if (require.main === module) {
  run().then(r => { console.log(JSON.stringify(r.sources)); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
