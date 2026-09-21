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
  // Every amount is the $1 unit variant times the dollars (tiles are even
  // dollars since 2026-09-21; the per-item variants on the product stay
  // unused). A tile with its own variant still works if one is ever added.
  let variant = s.variants[tile.key], qty = 1;
  if (!variant || centreAdd) { variant = s.variants.unit; qty = Math.max(1, Math.round(tile.cents / 100)); }
  if (!variant) return null;
  // The documented cart permalink: creates a cart with the line and goes to
  // checkout. Attribution rides as cart attributes, which land on the order
  // as note attributes; the ledger reads those (see readOrderAttributes).
  const params = new URLSearchParams({ [`attributes[${PROP_CENTRE}]`]: centre.slug });
  // A link-mode centre has no boxes, so the Box attribute is left off.
  if (box || centre.mode !== 'link') params.set(`attributes[${PROP_BOX}]`, String(box?.number || 1));
  params.set(`attributes[${PROP_KIND}]`, centreAdd ? 'centre' : 'sponsor');
  return `${STORE}/cart/${numericId(variant.id)}:${qty}?${params.toString()}`;
}

/** Closet/Box/Kind from an order's note attributes (REST webhook shape or GraphQL customAttributes). */
function readOrderAttributes(order) {
  const props = {};
  for (const a of order?.note_attributes || order?.customAttributes || []) props[(a.name || a.key || '').toLowerCase()] = a.value;
  return {
    slug: props[PROP_CENTRE.toLowerCase()] || null,
    boxNumber: parseInt(props[PROP_BOX.toLowerCase()], 10) || null,
    kind: props[PROP_KIND.toLowerCase()] === 'centre' ? 'centre_add' : 'sponsor',
  };
}

/** Read a line item (REST webhook shape or mirror row) and say whether it is ours. */
function readLineItem(li, s, orderAttrs = null) {
  if (!s?.variants) return null;
  const vid = String(li.variant_id || li.shopify_variant_id || '').split('/').pop();
  const known = Object.values(s.variants).find(v => numericId(v.id) === vid);
  if (!known) return null;
  const props = {};
  for (const p of li.properties || li.custom_attributes || []) props[(p.name || p.key || '').toLowerCase()] = p.value;
  const qty = li.quantity || 1;
  const unit = Math.round(parseFloat(li.price ?? li.unit_price ?? known.cents / 100) * 100);
  const fromLine = props[PROP_CENTRE.toLowerCase()];
  const o = orderAttrs || {};
  return {
    slug: fromLine || o.slug || null,
    boxNumber: parseInt(props[PROP_BOX.toLowerCase()], 10) || o.boxNumber || null,
    kind: (fromLine ? props[PROP_KIND.toLowerCase()] === 'centre' : o.kind === 'centre_add') ? 'centre_add' : 'sponsor',
    amountCents: unit * qty,
    lineItemId: String(li.id || li.shopify_line_item_id || '').split('/').pop(),
  };
}

module.exports = { PRODUCT_TITLE, PROP_CENTRE, PROP_BOX, PROP_KIND, SPONSOR_TILES, settings, checkoutUrl, readLineItem, readOrderAttributes, numericId };
