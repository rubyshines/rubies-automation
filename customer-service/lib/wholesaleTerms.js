/**
 * Per-partner wholesale terms — negotiated deal overrides stored on
 * b2b_companies (wholesale_discount_percent, wholesale_incoterms,
 * wholesale_currency). NULL columns mean "no negotiated override", so a
 * partner with no row or all-NULL columns behaves exactly like the
 * country/zone defaults.
 *
 * Precedence for every field: explicit tool param > stored partner terms >
 * country/zone default. resolveWholesaleTerms is the pure precedence step
 * (unit-tested); lookupPartnerTerms is the Supabase lookup.
 */

const { getSupabaseClient } = require('../../shared/supabaseClient');

const TERMS_COLUMNS = 'id, name, relationship_type, wholesale_discount_percent, wholesale_incoterms, wholesale_currency';

function hasTerms(row) {
  return row && (
    row.wholesale_discount_percent != null ||
    row.wholesale_incoterms != null ||
    row.wholesale_currency != null
  );
}

/**
 * Find stored wholesale terms for a customer email. Exact-match only — active
 * b2b_contacts.email plus b2b_companies.general_email — and scoped to
 * relationship_type='wholesale', so an org row sharing the partner's domain
 * (the known duplicate-rows shape) can never supply terms. Returns
 * { terms, warning }: terms is the company row or null; no match, an
 * ambiguous match, or a failed lookup (e.g. columns missing pre-migration)
 * all return null — no match means no facts, never a guess. The warning is
 * surfaced in the order preview so a silent fallback is visible.
 */
async function lookupPartnerTerms(customerEmail) {
  const email = (customerEmail || '').toLowerCase().trim();
  if (!email) return { terms: null, warning: null };
  try {
    const sb = getSupabaseClient();

    const { data: contacts, error: cErr } = await sb
      .from('b2b_contacts')
      .select('company_id')
      .eq('email', email)
      .eq('is_active', true);
    if (cErr) throw new Error(cErr.message);
    const companyIds = [...new Set((contacts || []).map(c => c.company_id).filter(Boolean))];

    let rows = [];
    if (companyIds.length > 0) {
      const { data, error } = await sb
        .from('b2b_companies')
        .select(TERMS_COLUMNS)
        .in('id', companyIds)
        .eq('relationship_type', 'wholesale');
      if (error) throw new Error(error.message);
      rows = data || [];
    }

    const { data: byGeneral, error: gErr } = await sb
      .from('b2b_companies')
      .select(TERMS_COLUMNS)
      .eq('general_email', email)
      .eq('relationship_type', 'wholesale');
    if (gErr) throw new Error(gErr.message);
    for (const row of byGeneral || []) {
      if (!rows.some(r => r.id === row.id)) rows.push(row);
    }

    const withTerms = rows.filter(hasTerms);
    if (withTerms.length === 1) return { terms: withTerms[0], warning: null };
    if (withTerms.length > 1) {
      return {
        terms: null,
        warning: `${email} matches ${withTerms.length} wholesale companies with stored terms (${withTerms.map(r => r.name).join(', ')}) — using country defaults. Fix the duplicate rows.`,
      };
    }
    return { terms: null, warning: null };
  } catch (err) {
    // Fail soft: a lookup error (network, columns missing pre-migration) must
    // not block order creation — fall back to defaults, but say so.
    return { terms: null, warning: `Partner terms lookup failed (${err.message}) — using country defaults.` };
  }
}

/**
 * Pure precedence: explicit tool params beat stored partner terms beat
 * country defaults. Returns each resolved value with its source
 * ('param' | 'partner' | 'default') so the preview can show WHY an order
 * priced and routed the way it did.
 */
function resolveWholesaleTerms({ countryCode, params = {}, partner = null }) {
  const cc = (countryCode || '').toUpperCase();
  const defaultDiscount = (cc === 'US' || cc === 'AU') ? 50 : 30;

  let discountPercent, discountSource;
  if (params.discount_percent != null) {
    discountPercent = params.discount_percent; discountSource = 'param';
  } else if (partner && partner.wholesale_discount_percent != null) {
    discountPercent = Number(partner.wholesale_discount_percent); discountSource = 'partner';
  } else {
    discountPercent = defaultDiscount; discountSource = 'default';
  }

  let incoterms = null, incotermsSource = 'default';
  if (params.incoterms === 'ddp' || params.incoterms === 'ddu') {
    incoterms = params.incoterms; incotermsSource = 'param';
  } else if (partner && (partner.wholesale_incoterms === 'ddp' || partner.wholesale_incoterms === 'ddu')) {
    incoterms = partner.wholesale_incoterms; incotermsSource = 'partner';
  }

  let currency = null, currencySource = 'default';
  if (partner && partner.wholesale_currency) {
    currency = partner.wholesale_currency; currencySource = 'partner';
  }

  return {
    discountPercent, discountSource,
    incoterms, incotermsSource,   // incoterms null = let the shipping zone decide
    currency, currencySource,     // currency null = customer's local currency
    partnerName: partner ? partner.name : null,
  };
}

/** Human-readable incoterms meaning for previews. */
function incotermsLabel(incoterms) {
  return incoterms === 'ddu'
    ? 'DDU — partner pays duties/VAT at import'
    : 'DDP — RUBIES pays duties/VAT';
}

module.exports = { lookupPartnerTerms, resolveWholesaleTerms, incotermsLabel };
