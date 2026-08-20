#!/usr/bin/env node

/**
 * Migrate donation partners from the rubies-ecom-v4 theme template into the
 * donation_partners table, with full fidelity (lat/lng, logo URL, size_range,
 * full descriptions, multi-line mailing address).
 *
 * The theme template at rubies-ecom-v4/templates/page.donate-preloved.json is
 * the canonical source for these fields today. This script imports it once so
 * rubies-automations becomes the single source of truth going forward.
 *
 * Reconciles to existing rows by name (handling known alias for BAGLY).
 *
 * Prereq: customer-service/migrations-2026-05-28-donation-partners-superset.sql
 * must be applied in Supabase first.
 *
 * Usage:
 *   node customer-service/import/importDonationPartnersFromTheme.js
 *   node customer-service/import/importDonationPartnersFromTheme.js --dry
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { parseSizeAcceptance } = require('../lib/sizeAcceptance');

const THEME_TEMPLATE = path.resolve(
  __dirname, '../../../rubies-ecom-v4/templates/page.donate-preloved.json'
);

// Pre-resolved CDN URLs for the two shopify://shop_images/ refs in the theme.
// Resolved via Shopify Admin GraphQL `files(query:"filename:...")` 2026-05-28.
const SHOP_IMAGE_CDN = {
  'shopify://shop_images/TransOpenWardrobe_logo_whiteoverlay-300x205.png':
    'https://cdn.shopify.com/s/files/1/0255/9636/2837/files/TransOpenWardrobe_logo_whiteoverlay-300x205.png?v=1770132644',
  'shopify://shop_images/Lalgbtcenter-logo_webp.png':
    'https://cdn.shopify.com/s/files/1/0255/9636/2837/files/Lalgbtcenter-logo_webp.png?v=1763654835',
};

// Existing DB rows may use shorter names than the theme. Match by either.
const NAME_ALIASES = {
  'BAGLY - Boston Alliance of LGBTQ Youth': ['BAGLY'],
};

// Country code, region, city are not in the theme JSON. Infer from name/address
// since they're already correct in the DB for all 14 orgs. Use this map only
// when inserting a brand-new row (none expected today).
const GEO_OVERRIDES = {
  'Trans* Open Wardrobe': { country_code: 'CH', region: 'Bern', city: 'Bern' },
  'LGBT Center of Raleigh': { country_code: 'US', region: 'North Carolina', city: 'Raleigh' },
  'TransPonder': { country_code: 'US', region: 'Oregon', city: 'Eugene' },
  'Valid USA': { country_code: 'US', region: 'Arizona', city: 'Tucson' },
  'OUT MetroWest': { country_code: 'US', region: 'Massachusetts', city: 'Framingham' },
  'Rainbow Youth Center': { country_code: 'US', region: 'Colorado', city: 'Durango' },
  'Oasis Youth Center': { country_code: 'US', region: 'Washington', city: 'Tacoma' },
  'BAGLY - Boston Alliance of LGBTQ Youth': { country_code: 'US', region: 'Massachusetts', city: 'Boston' },
  'Massachusetts Transgender Political Coalition': { country_code: 'US', region: 'Massachusetts', city: 'Boston' },
  'Skipping Stone': { country_code: 'CA', region: 'Alberta', city: 'Calgary' },
  'McMinnville Trans Network': { country_code: 'US', region: 'Oregon', city: 'McMinnville' },
  'Transformation Closet with Sexual Health Nova Scotia': { country_code: 'CA', region: 'Nova Scotia', city: 'Halifax' },
  'Yellow House Student Centre for Equity and Inclusion': { country_code: 'CA', region: 'Ontario', city: 'Kingston' },
  'RISE @ Los Angeles LGBT Center': { country_code: 'US', region: 'California', city: 'Los Angeles' },
};

function resolveLogoUrl(block) {
  if (block.image_url) return block.image_url;
  if (block.image && SHOP_IMAGE_CDN[block.image]) return SHOP_IMAGE_CDN[block.image];
  return null;
}

/**
 * Parse the multi-line mailing_address into a single comma-joined "street, city,
 * region zip" string suitable for the legacy `address` column. Strips the
 * "RUBIES Returns" and "c/o ..." prefix lines.
 */
function deriveLegacyAddress(mailingAddress, orgName) {
  const lines = mailingAddress.split('\n').map(l => l.trim()).filter(Boolean);
  const filtered = lines.filter((l, i) => {
    if (i === 0 && /^rubies returns/i.test(l)) return false;
    if (/^c\/o\s/i.test(l)) return false;
    if (l.toLowerCase() === orgName.toLowerCase()) return false;
    return true;
  });
  return filtered.join(', ');
}

function readThemePartners() {
  const raw = fs.readFileSync(THEME_TEMPLATE, 'utf8');
  // Strip the JS comment header (starts with /* ... */) since the file is JSON5-ish
  const jsonStart = raw.indexOf('{');
  const json = JSON.parse(raw.slice(jsonStart));

  const section = json.sections?.preloved_returns_map;
  if (!section || section.type !== 'preloved-returns-map') {
    throw new Error('preloved_returns_map section not found in theme template');
  }

  const order = section.block_order || Object.keys(section.blocks || {});
  return order.map(key => {
    const block = section.blocks[key];
    if (!block || block.type !== 'organization') return null;
    const s = block.settings;
    return {
      name: s.name,
      mailing_address: s.address,
      description: s.description,
      size_range: s.size_range,
      logo_url: resolveLogoUrl(s),
      website_url: s.org_url || null,
      latitude: parseFloat(s.lat),
      longitude: parseFloat(s.lng),
    };
  }).filter(Boolean);
}

async function findExistingRow(supabase, partner) {
  // Try exact-name match first, then any aliased older name.
  const names = [partner.name, ...(NAME_ALIASES[partner.name] || [])];
  for (const n of names) {
    const { data, error } = await supabase
      .from('donation_partners')
      .select('*')
      .eq('name', n)
      .limit(1);
    if (error) throw new Error(`Lookup failed for ${n}: ${error.message}`);
    if (data && data.length > 0) return data[0];
  }
  return null;
}

async function main() {
  const dryRun = process.argv.includes('--dry');
  const partners = readThemePartners();
  console.log(`Read ${partners.length} partners from ${THEME_TEMPLATE}\n`);

  // Validate everything before writing.
  const issues = [];
  for (const p of partners) {
    if (!p.name) issues.push('Missing name on a block');
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) {
      issues.push(`${p.name}: missing or invalid lat/lng (${p.latitude}, ${p.longitude})`);
    }
    if (!p.logo_url) issues.push(`${p.name}: missing logo_url (image_url empty and image ref not in SHOP_IMAGE_CDN)`);
    if (!p.mailing_address) issues.push(`${p.name}: missing mailing_address`);
  }
  if (issues.length) {
    console.error('Validation failed:');
    for (const i of issues) console.error('  - ' + i);
    process.exit(1);
  }

  const supabase = getSupabaseClient();

  let updated = 0, inserted = 0;
  for (const p of partners) {
    const existing = await findExistingRow(supabase, p);
    const legacyAddress = deriveLegacyAddress(p.mailing_address, p.name);

    const payload = {
      name: p.name,
      mailing_address: p.mailing_address,
      description: p.description,
      // The theme carried sizes as free text; the registry stores the two
      // categories routing filters on (see lib/sizeAcceptance.js).
      ...parseSizeAcceptance(p.size_range),
      logo_url: p.logo_url,
      website_url: p.website_url,
      latitude: p.latitude,
      longitude: p.longitude,
      address: legacyAddress,
      active: true,
      updated_at: new Date().toISOString(),
    };

    // Preserve existing geo info when present; otherwise apply override.
    const geo = GEO_OVERRIDES[p.name] || {};
    if (!existing?.country_code && geo.country_code) payload.country_code = geo.country_code;
    if (!existing?.region && geo.region) payload.region = geo.region;
    if (!existing?.city && geo.city) payload.city = geo.city;

    if (existing) {
      if (dryRun) {
        console.log(`  [dry] would UPDATE id=${existing.id} ${p.name}`);
      } else {
        const { error } = await supabase
          .from('donation_partners')
          .update(payload)
          .eq('id', existing.id);
        if (error) { console.error(`  ✗ ${p.name}: ${error.message}`); continue; }
        // Normalize name to theme canonical (BAGLY -> BAGLY - Boston Alliance...).
        if (existing.name !== p.name) {
          console.log(`  ✓ ${p.name} (renamed from "${existing.name}")`);
        } else {
          console.log(`  ✓ ${p.name}`);
        }
      }
      updated++;
    } else {
      // New row — need country_code minimally.
      if (!payload.country_code) payload.country_code = geo.country_code || 'US';
      if (dryRun) {
        console.log(`  [dry] would INSERT ${p.name}`);
      } else {
        const { error } = await supabase
          .from('donation_partners')
          .insert({ ...payload, donations_routed: 0 });
        if (error) { console.error(`  ✗ ${p.name}: ${error.message}`); continue; }
        console.log(`  + ${p.name} (new)`);
      }
      inserted++;
    }
  }

  console.log(`\n${dryRun ? '[dry] ' : ''}Done. updated=${updated} inserted=${inserted}`);
}

main().catch(err => { console.error(err); process.exit(1); });
