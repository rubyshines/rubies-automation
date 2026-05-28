#!/usr/bin/env node

/**
 * One-off backfill: re-host any donation_partner whose logo_url is on an
 * external host onto the Shopify CDN. Idempotent — partners already on
 * cdn.shopify.com are no-ops.
 *
 * Usage:
 *   node customer-service/scripts/backfillDonationPartnerLogos.js          # dry run
 *   node customer-service/scripts/backfillDonationPartnerLogos.js --apply  # do it
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { rehostImageOnShopify, isShopifyCdnUrl } = require('../lib/shopifyFileUpload');

async function main() {
  const apply = process.argv.includes('--apply');
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('donation_partners')
    .select('id, name, logo_url')
    .eq('active', true)
    .order('id');
  if (error) throw new Error(error.message);

  const candidates = data.filter(p => p.logo_url && !isShopifyCdnUrl(p.logo_url));
  console.log(`Active partners: ${data.length}`);
  console.log(`Already on Shopify CDN: ${data.length - candidates.length}`);
  console.log(`Need re-host: ${candidates.length}`);
  for (const p of candidates) console.log(`  - #${p.id} ${p.name}  ${p.logo_url}`);
  console.log('');

  if (!apply) {
    console.log('(dry run — pass --apply to actually re-host)');
    return;
  }

  let ok = 0, fail = 0;
  for (const p of candidates) {
    process.stdout.write(`#${p.id} ${p.name} ... `);
    try {
      const res = await rehostImageOnShopify(p.logo_url, { alt: `${p.name} logo` });
      const { error: updErr } = await supabase
        .from('donation_partners')
        .update({ logo_url: res.cdnUrl, updated_at: new Date().toISOString() })
        .eq('id', p.id);
      if (updErr) throw new Error(updErr.message);
      console.log(`✓  ${res.cdnUrl}`);
      ok++;
    } catch (e) {
      console.log(`✗  ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone. ok=${ok} fail=${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
