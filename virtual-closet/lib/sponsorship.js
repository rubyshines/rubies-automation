'use strict';
/**
 * Sponsoring and "add to the box" are ordinary store sales of a hidden product,
 * "Sponsor a closet": one variant per tile plus a $1 unit for any amount. The
 * centre and box ride on the line item as properties, which the order mirror
 * keeps as custom_attributes, so the ledger can be rebuilt from orders alone.
 *
 * The store's /cart/add takes GET with id, quantity, properties and return_to,
 * so the closet page can hand straight to checkout with nothing to type.
 */
const config = require('./config');
const { STORE, SPONSOR_TILES } = require('./catalog');

const PRODUCT_TITLE = 'Sponsor a closet';
const PROP_CENTRE = 'Closet';
const PROP_BOX = 'Box';
const PROP_KIND = 'Kind';

/** { productId, variants: { pair: {id, numericId, cents}, ..., unit: {...} } } or null before setup. */
async function settings() {
  return config.get('sponsorship');
}

function numericId(gid) { return String(gid).split('/').pop(); }

async function checkoutUrl({ centre, box, tile, centreAdd = false }) {
  const s = await settings();
  if (!s?.variants) return null;
  let variant, qty;
  if (centreAdd) { variant = s.variants.unit; qty = Math.max(1, Math.round(tile.cents / 100)); }
  else { variant = s.variants[tile.key]; qty = 1; }
  if (!variant) return null;
  const params = new URLSearchParams({
    id: numericId(variant.id), quantity: String(qty),
    [`properties[${PROP_CENTRE}]`]: centre.slug,
    [`properties[${PROP_BOX}]`]: String(box?.number || 1),
    [`properties[${PROP_KIND}]`]: centreAdd ? 'centre' : 'sponsor',
    return_to: '/checkout',
  });
  return `${STORE}/cart/add?${params.toString()}`;
}

/** Read a line item (REST webhook shape or mirror row) and say whether it is ours. */
function readLineItem(li, s) {
  if (!s?.variants) return null;
  const vid = String(li.variant_id || li.shopify_variant_id || '').split('/').pop();
  const known = Object.values(s.variants).find(v => numericId(v.id) === vid);
  if (!known) return null;
  const props = {};
  for (const p of li.properties || li.custom_attributes || []) props[(p.name || p.key || '').toLowerCase()] = p.value;
  const qty = li.quantity || 1;
  const unit = Math.round(parseFloat(li.price ?? li.unit_price ?? known.cents / 100) * 100);
  return {
    slug: props[PROP_CENTRE.toLowerCase()] || null,
    boxNumber: parseInt(props[PROP_BOX.toLowerCase()], 10) || null,
    kind: props[PROP_KIND.toLowerCase()] === 'centre' ? 'centre_add' : 'sponsor',
    amountCents: unit * qty,
    lineItemId: String(li.id || li.shopify_line_item_id || '').split('/').pop(),
  };
}

module.exports = { PRODUCT_TITLE, PROP_CENTRE, PROP_BOX, PROP_KIND, SPONSOR_TILES, settings, checkoutUrl, readLineItem, numericId };
