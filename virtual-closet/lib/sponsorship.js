'use strict';
/**
 * Sponsoring and "add to the box" are ordinary store sales of a hidden product,
 * "Sponsor a closet": one variant per tile ($10, $25, $50, $100, Jamie
 * 2026-09-22) plus a $1 unit for any amount (closet mode's add-to-the-box).
 * The centre rides on the line item as properties, which the order mirror
 * keeps as custom_attributes, so the ledger can be rebuilt from orders alone.
 *
 * The store's /cart/add takes GET with id, quantity, properties and return_to,
 * so the closet page can hand straight to checkout with nothing to type. The
 * visible property "For" names the centre wherever Shopify lists the line
 * (cart, checkout, the confirmation email, admin); the keys the ledger reads
 * start with an underscore, which Shopify keeps on the order but never shows.
 */
const config = require('./config');
const { STORE, SPONSOR_TILES } = require('./catalog');

const PRODUCT_TITLE = 'Sponsor a closet';
const PROP_CENTRE = 'Closet';
const PROP_BOX = 'Box';
const PROP_KIND = 'Kind';
const PROP_SINCE = 'Closet since'; // the tap time (ms), written by the store's theme

/** { productId, variants: { pair: {id, numericId, cents}, ..., unit: {...} } } or null before setup. */
async function settings() {
  return config.get('sponsorship');
}

function numericId(gid) { return String(gid).split('/').pop(); }

const PROP_FOR = 'For';

/** The property Shopify shows under the line: "For: The Attic's Virtual Closet". */
function forLine(centre) { return `${centre.name}'s Virtual Closet`; }

async function checkoutUrl({ centre, box, tile, centreAdd = false }) {
  const s = await settings();
  if (!s?.variants) return null;
  // A tile is its own variant, quantity one. Anything without a variant (a
  // centre's own amount in closet mode) is the $1 unit times the dollars.
  let variant = s.variants[tile.key], qty = 1;
  if (!variant || centreAdd) { variant = s.variants.unit; qty = Math.max(1, Math.round(tile.cents / 100)); }
  if (!variant) return null;
  const params = new URLSearchParams({ id: numericId(variant.id), quantity: String(qty) });
  params.set(`properties[${PROP_FOR}]`, forLine(centre));
  params.set(`properties[_${PROP_CENTRE}]`, centre.slug);
  params.set(`properties[_${PROP_KIND}]`, centreAdd ? 'centre' : 'sponsor');
  // A link-mode centre has no boxes, so the Box property is left off.
  if (box || centre.mode !== 'link') params.set(`properties[_${PROP_BOX}]`, String(box?.number || 1));
  params.set('return_to', '/checkout');
  return `${STORE}/cart/add?${params.toString()}`;
}

/** Closet/Box/Kind from an order's note attributes (REST webhook shape or GraphQL customAttributes). */
function readOrderAttributes(order) {
  const props = {};
  for (const a of order?.note_attributes || order?.customAttributes || []) props[(a.name || a.key || '').toLowerCase()] = a.value;
  const since = parseInt(props[PROP_SINCE.toLowerCase()], 10);
  return {
    slug: props[PROP_CENTRE.toLowerCase()] || null,
    boxNumber: parseInt(props[PROP_BOX.toLowerCase()], 10) || null,
    kind: props[PROP_KIND.toLowerCase()] === 'centre' ? 'centre_add' : 'sponsor',
    sinceMs: Number.isFinite(since) ? since : null,
  };
}

/** Read a line item (REST webhook shape or mirror row) and say whether it is ours. */
function readLineItem(li, s, orderAttrs = null) {
  if (!s?.variants) return null;
  const vid = String(li.variant_id || li.shopify_variant_id || '').split('/').pop();
  const known = Object.values(s.variants).find(v => numericId(v.id) === vid);
  if (!known) return null;
  const props = {};
  for (const p of li.properties || li.custom_attributes || []) props[String(p.name || p.key || '').replace(/^_/, '').toLowerCase()] = p.value;
  const qty = li.quantity || 1;
  // `price` (webhook) and `unit_price` (mirror) are shop money, USD. What the
  // shopper actually paid is the presentment money on price_set (webhook) or
  // the mirror's presentment_unit_price, when its currency is known; the
  // ledger settles into the centre's currency from these (2026-09-22).
  const unit = Math.round(parseFloat(li.price ?? li.unit_price ?? known.cents / 100) * 100);
  const shopCurrency = String(li.price_set?.shop_money?.currency_code || li.unit_price_currency || '').toUpperCase() || null;
  const pm = li.price_set?.presentment_money;
  const pAmount = pm?.amount ?? li.presentment_unit_price;
  const pCurrency = String(pm?.currency_code || li.presentment_unit_price_currency || '').toUpperCase() || null;
  const presentment = pAmount != null && pCurrency ? { cents: Math.round(parseFloat(pAmount) * 100) * qty, currency: pCurrency } : null;
  const fromLine = props[PROP_CENTRE.toLowerCase()];
  const o = orderAttrs || {};
  return {
    slug: fromLine || o.slug || null,
    boxNumber: parseInt(props[PROP_BOX.toLowerCase()], 10) || o.boxNumber || null,
    kind: (fromLine ? props[PROP_KIND.toLowerCase()] === 'centre' : o.kind === 'centre_add') ? 'centre_add' : 'sponsor',
    amountCents: unit * qty,
    shopCurrency,
    presentment,
    lineItemId: String(li.id || li.shopify_line_item_id || '').split('/').pop(),
  };
}

module.exports = { PRODUCT_TITLE, PROP_CENTRE, PROP_BOX, PROP_KIND, PROP_SINCE, PROP_FOR, SPONSOR_TILES, forLine, settings, checkoutUrl, readLineItem, readOrderAttributes, numericId };
