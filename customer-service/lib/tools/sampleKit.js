/**
 * Wholesale sample kit MCP tools.
 *
 * Two-phase like every other order tool: create_sample_kit stages a draft and
 * shows the operator what is in the box and why, complete_sample_kit finishes it
 * and records the samples event against the retailer.
 *
 * The recipe and the colour rule live in ../sampleKit.js. This file is the
 * interface: resolve the company, resolve the customer, build the draft, render
 * the preview.
 */

const {
  createDraftOrder,
  completeDraftOrder,
  normalizeGid,
  getAdminUrl,
} = require('../shopify');
const { getSupabaseClient } = require('../../../shared/supabaseClient');
const {
  getShippingMethodTitle,
  applyShippingAddressOverride,
  SHIPPING_ADDRESS_OVERRIDE_SCHEMA,
  normalizeCountryCode,
  unknownDestinationWarning,
} = require('../orderUtils');
const { findOrCreateCustomer } = require('./createOrder');
const {
  buildSampleKit,
  fmtCover,
  MIN_WEEKS_COVER,
  MIN_UNITS,
  SALES_WINDOW_DAYS,
  KIT_GARMENTS,
} = require('../sampleKit');

/** The tag the B2B cadence keys on. Any tag containing "sample" counts; this is
 *  the spelling the November 2025 kits used, kept so the history reads as one
 *  series rather than two. */
const KIT_TAG = 'sample kit reach out';

async function loadCompany(companyId) {
  const sb = getSupabaseClient();
  const { data, error } = await sb.from('b2b_companies')
    .select('id, name, relationship_type, city, region, country, samples_shipped_at, outreach_paused_at')
    .eq('id', companyId).maybeSingle();
  if (error) throw new Error(`Could not read b2b_companies: ${error.message}`);
  return data;
}

function text(t) {
  return { content: [{ type: 'text', text: t }] };
}

// ---------------------------------------------------------------------------
// Phase 1 — stage the kit
// ---------------------------------------------------------------------------

async function handleCreateSampleKit({
  company_id, company_name, email, first_name, last_name, phone,
  size, colors, shipping_address, note, shipping_speed,
}) {
  if (!email) return text('An email is required — the kit needs a Shopify customer to hang off.');
  if (!size) return text('A size is required. The kit ships one size per store (S, M, L, 1X ...).');

  // --- the store -----------------------------------------------------------
  let company = null;
  if (company_id) {
    company = await loadCompany(company_id);
    if (!company) {
      return text(`No company "${company_id}" in b2b_companies. Use b2b_search to find the right id, or b2b_add_prospect to put the store in the book first. To send a kit to a store that is deliberately not in the book, pass company_name instead.`);
    }
  }
  const storeName = company_name || company?.name || null;
  if (!storeName) {
    return text('Pass company_id (preferred, so the samples event is recorded against the store) or company_name. The store name is printed on the shipping label — a courier delivering to a retail address needs it.');
  }

  // --- the box -------------------------------------------------------------
  let kit;
  try {
    kit = await buildSampleKit({ size, colors: colors || {} });
  } catch (err) {
    return text(`Could not build the kit: ${err.message}`);
  }
  if (!kit.lines.length) {
    return text(`Nothing in the catalog matches size "${size}" for any kit garment. Check the size.`);
  }

  // --- the customer --------------------------------------------------------
  const addressForCustomer = shipping_address
    ? { ...shipping_address, company: shipping_address.company || storeName }
    : null;
  const customerInfo = await findOrCreateCustomer({
    email, first_name, last_name, phone, address: addressForCustomer,
  });

  const effectiveShippingAddress = applyShippingAddressOverride(
    null,
    { ...(shipping_address || {}), company: shipping_address?.company || storeName,
      first_name: shipping_address?.first_name || first_name,
      last_name: shipping_address?.last_name || last_name },
  );

  const shipCountry = effectiveShippingAddress?.country || '';
  const speed = shipping_speed === 'expedited' ? 'expedited' : 'standard';
  const shippingTitle = await getShippingMethodTitle(shipCountry, speed);

  // --- the preview ---------------------------------------------------------
  let md = `**Wholesale Sample Kit — ${storeName}**\n\n`;
  md += `**Size:** ${kit.size}\n`;
  md += `**Contact:** ${customerInfo.name || `${first_name || ''} ${last_name || ''}`.trim()}`;
  if (customerInfo.created) md += ` (newly created)`;
  md += `\n**Email:** ${customerInfo.email || email}\n`;
  if (company) {
    md += `**In the book:** ${company.id} (${company.relationship_type})`;
    if (company.samples_shipped_at) md += ` — ⚠️ already has samples recorded ${String(company.samples_shipped_at).slice(0, 10)}`;
    if (company.outreach_paused_at) md += ` — ⚠️ outreach is paused for this company`;
    md += `\n`;
  } else {
    md += `**In the book:** not linked — the samples event will NOT be recorded against a company.\n`;
  }
  if (effectiveShippingAddress) {
    const a = effectiveShippingAddress;
    md += `**Ship to:** ${[a.company, a.address1, a.address2, a.city, `${a.province || ''} ${a.zip || ''}`, a.country].filter(Boolean).join(', ')}\n`;
  }
  if (!normalizeCountryCode(shipCountry)) {
    md += `\n${unknownDestinationWarning(shippingTitle)}\n`;
  }

  md += `\n**In the box:**\n`;
  for (const l of kit.lines) {
    md += `  1x ${l.label}${l.variantTitle ? ` — ${l.variantTitle}` : ''} [${l.sku}]\n`;
  }

  // Every colour decision, shown. A substitution the operator cannot see is a
  // substitution they cannot overrule.
  md += `\n**Colour choices** (cover = stock ÷ sales rate over the last ${SALES_WINDOW_DAYS} days; floor is ${MIN_WEEKS_COVER}w and ${MIN_UNITS} units):\n`;
  for (const p of kit.picks) {
    if (!p.chosen) {
      md += `  - ${p.garment.label}: **not included** — ${p.reason}\n`;
      continue;
    }
    const cov = `${fmtCover(p.chosen.weeksCover)} on ${p.chosen.qty} units`;
    if (p.status === 'default') {
      md += `  - ${p.garment.label}: ${p.chosen.color} (default) — ${cov}\n`;
    } else if (p.status === 'forced') {
      md += `  - ${p.garment.label}: ${p.chosen.color} — set by you — ${cov}\n`;
    } else if (p.status === 'substituted') {
      md += `  - ${p.garment.label}: **${p.chosen.color} instead of ${p.garment.defaultColor}** — ${p.reason}; ${p.chosen.color} is ${cov}\n`;
    } else {
      md += `  - ${p.garment.label}: ⚠️ ${p.chosen.color} — ${p.reason}; sending it anyway at ${cov}\n`;
    }
  }

  if (kit.warnings.length) {
    md += `\n**Check before sending:**\n`;
    for (const w of kit.warnings) md += `  - ${w}\n`;
  }

  // --- the draft -----------------------------------------------------------
  const kitNote = note
    || `Wholesale sample kit for ${storeName}${company ? ` (${company.id})` : ''} — size ${kit.size}.`;

  const draftInput = {
    customerId: customerInfo.id,
    lineItems: kit.lines.map(l => ({
      variantId: l.variantId,
      quantity: l.quantity,
      appliedDiscount: { title: 'Free / Samples', value: 100, valueType: 'PERCENTAGE' },
    })),
    note: kitNote,
    tags: [KIT_TAG, 'wholesale-samples', 'cs-mcp'],
    shippingLine: { title: shippingTitle, price: 0 },
  };
  if (effectiveShippingAddress) draftInput.shippingAddress = effectiveShippingAddress;

  const draftOrder = await createDraftOrder(draftInput);

  md += `\n---\n**Draft created — awaiting confirmation**\n\n`;
  md += `**Draft:** ${draftOrder.name} — ${getAdminUrl(draftOrder.id)}\n`;
  md += `**Total:** $${draftOrder.totalPrice}\n`;
  md += `\nReview it, then call complete_sample_kit with draft_order_id="${draftOrder.id}"`;
  md += company ? ` and company_id="${company.id}".` : ' (no company_id — nothing will be recorded against a store).';

  return text(md);
}

// ---------------------------------------------------------------------------
// Phase 2 — send it, and record that we did
// ---------------------------------------------------------------------------

async function handleCompleteSampleKit({ draft_order_id, company_id }) {
  const draftGid = normalizeGid(draft_order_id, 'DraftOrder');
  const completed = await completeDraftOrder(draftGid);
  const order = completed.order;

  const lines = [
    '**Sample Kit Sent**',
    '',
    `**Order:** ${order.name} — ${getAdminUrl(order.id)}`,
    '**Status:** Completed (marked as paid, $0)',
  ];

  if (company_id) {
    // Stamp the samples event directly rather than waiting for the nightly
    // sync to infer it from a $0 sample-tagged order matched on email. We know
    // which store this is — the operator named it — so there is nothing to
    // infer, and this is the only writer of samples_shopify_order_id.
    //
    // A later kit overwrites an earlier date on purpose: post_samples_checkin
    // is a question about the kit they are holding now, and the cadence stops
    // asking after 60 days.
    const sb = getSupabaseClient();
    const { error } = await sb.from('b2b_companies').update({
      samples_shipped_at: new Date().toISOString(),
      samples_shopify_order_id: order.id,
    }).eq('id', company_id);
    if (error) {
      lines.push('', `⚠️ The order went through but the samples event was NOT recorded against ${company_id}: ${error.message}. The cadence will not raise a check-in until this is fixed.`);
    } else {
      lines.push('', `**Recorded against:** ${company_id} — samples_shipped_at set, so a post-samples check-in comes due in 14 days.`);
    }
  } else {
    lines.push('', '⚠️ No company_id passed, so no samples event was recorded and no check-in will come due.');
  }

  return text(lines.join('\n'));
}

// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'create_sample_kit',
    description:
      'Stage the standard wholesale sample kit for a prospective retailer: the retail kit postcard plus Charlie, AJ, the Brooke bra, the Ava bra and the Ruby bikini bottom, one size, free, shipping covered. ' +
      'Colours default to Sandstone (Pink for Ruby, which has no Sandstone) but are checked against stock first: a colourway with less than ' + MIN_WEEKS_COVER + ' weeks of cover is swapped for a healthier one, because the kit should only show a buyer colours we could fill a reorder in. Every choice is shown with its numbers. ' +
      'Two-phase: this stages a DRAFT and returns its admin link; review it, then call complete_sample_kit. Pass company_id so the samples event is recorded against the store and the cadence raises a check-in.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'string', description: 'b2b_companies id slug (e.g. "forbidden-fruit"). Strongly preferred: it puts the store name on the label and records the samples event, which is what makes the post-samples check-in fire. Use b2b_search to find it.' },
        company_name: { type: 'string', description: 'Store name for the shipping label, when the store is deliberately not in the book. Overrides the company record\'s name when both are given.' },
        email: { type: 'string', description: 'Contact email. Finds or creates the Shopify customer.' },
        first_name: { type: 'string', description: 'Contact first name.' },
        last_name: { type: 'string', description: 'Contact last name.' },
        phone: { type: 'string', description: 'Contact phone (new customers only).' },
        size: { type: 'string', description: 'The single size the kit ships in — S, M, L, 1X, 2X ... Either spelling works (1X and XL are the same size). Kits go out one size per store.' },
        colors: {
          type: 'object',
          description: 'Force a colour per garment, overriding the stock rule. Keys: ' + KIT_GARMENTS.map(g => g.key).join(', ') + '. Values are SKU colour codes (SND, BLK, PNK). Only set this when you have a reason — the default is stock-aware.',
          properties: Object.fromEntries(KIT_GARMENTS.map(g => [g.key, { type: 'string' }])),
        },
        shipping_address: SHIPPING_ADDRESS_OVERRIDE_SCHEMA,
        shipping_speed: { type: 'string', enum: ['standard', 'expedited'], description: 'Default standard.' },
        note: { type: 'string', description: 'Order note. Defaults to a line naming the store and size.' },
      },
      required: ['email', 'size'],
    },
    handler: handleCreateSampleKit,
  },
  {
    name: 'complete_sample_kit',
    description: 'Complete a staged sample kit draft: marks it paid at $0 and releases it to the warehouse, then records the samples event on the company (samples_shipped_at + samples_shopify_order_id) so the post-samples check-in comes due. Always confirm with the operator before calling this.',
    inputSchema: {
      type: 'object',
      properties: {
        draft_order_id: { type: 'string', description: 'Draft order GID from create_sample_kit.' },
        company_id: { type: 'string', description: 'b2b_companies id the kit is for. Without it the order still sends but no samples event is recorded and no check-in fires.' },
      },
      required: ['draft_order_id'],
    },
    handler: handleCompleteSampleKit,
  },
];

module.exports = tools;
