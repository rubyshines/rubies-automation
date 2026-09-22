'use strict';
/**
 * "Shop with 20% off": one Shopify discount, "Virtual Closet 20%", 20% off an
 * order, once per customer (new or returning, Jamie 2026-09-18). Each click
 * draws a fresh code on that discount so nothing reusable is ever shown, and
 * the code's prefix says which centre the order belongs to. The shopper is
 * sent to the store's discount URL, which applies it silently at checkout.
 */
const crypto = require('crypto');
const config = require('./config');
const { db, must } = require('./db');
const { STORE } = require('./catalog');
const { allowLiveWrite } = require('../../shared/liveWrites');

const TITLE = 'Virtual Closet 20%';
const PERCENT = 20;

function codeFor(centre) {
  const tag = String(centre.slug || 'closet').replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase() || 'CLOSET';
  return `VC-${tag}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/** The discount's numeric id, creating the discount on first use. */
async function ensureDiscount() {
  const existing = await config.get('discount');
  if (existing?.numericId) return existing;
  const shopify = require('../../customer-service/lib/shopify');
  let node = await shopify.findDiscountNodeByTitle(TITLE);
  if (!node) {
    const created = await shopify.createDiscountCode({
      title: TITLE,
      code: codeFor({ slug: 'seed' }),
      startsAt: new Date().toISOString(),
      appliesOncePerCustomer: true,
      customerSelection: { all: true },
      customerGets: { value: { percentage: PERCENT / 100 }, items: { all: true } },
      combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
    });
    node = { id: created.id, numericId: created.id.split('/').pop() };
  }
  const value = { id: node.id, numericId: node.numericId, title: TITLE };
  await config.set('discount', value);
  return value;
}

/**
 * Where on the store a tap may land. Only a product or collection path,
 * never a full URL, so the closet's redirect cannot be pointed off-site.
 */
function storePath(to) {
  const t = String(to || '');
  return /^\/(products|collections)\/[a-z0-9][a-z0-9-]*\/?$/i.test(t) ? t : '/collections/all';
}

/**
 * A tap on Shop or on a style. Reuses the shopper's previous code for this
 * centre while it is still unused (the same device tapping twice gets one
 * code, not a trail of them); otherwise mints a fresh one. Returns the store
 * URL that applies the code plus the code itself, for the cookie.
 */
async function shopVisit(centre, { redirect = '/collections/all', previousCode = null } = {}) {
  redirect = storePath(redirect);
  // What the theme needs, on the landing path: slug, code, tap time, name,
  // and `used` when the code this device had before was already spent (a
  // fresh code is minted, but Shopify will refuse it at checkout, so the cart
  // says so up front). Kept in the theme's own cookie for 30 days.
  const landing = (code, used) => `${redirect}?vc=${encodeURIComponent([centre.slug, code, Date.now(), centre.name || '', used ? 'used' : ''].join('|'))}`;
  // A public page click writes a permanent code to the live store, so off the
  // real deployment this sends the shopper to the store without one. Guarding
  // the click rather than the store call keeps ensureDiscount's lookup working
  // locally, which is what tells us the discount is configured at all.
  if (!allowLiveWrite(`mint a Shopify discount code for ${centre.slug}`)) {
    return { url: `${STORE}${redirect}`, code: null };
  }
  let used = false;
  if (previousCode) {
    const known = await centreForCode(previousCode);
    if (known && known.centre_id === centre.id) {
      if (!known.order_id) return { url: applyUrl(known.code, landing(known.code, false)), code: known.code, reused: true };
      used = true;
    }
  }
  const discount = await ensureDiscount();
  const shopify = require('../../customer-service/lib/shopify');
  let code;
  for (let attempt = 0; attempt < 3; attempt++) {
    code = codeFor(centre);
    try { await shopify.addCodeToPriceRule(discount.numericId, code); break; } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  must(await db().from('vc_discount_codes').insert({ centre_id: centre.id, code }), 'record code');
  return { url: applyUrl(code, landing(code, used)), code, reused: false, used };
}

function applyUrl(code, redirect) {
  return `${STORE}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(redirect)}`;
}

/** Issue a code for this click and return the store URL that applies it. */
async function shopUrlFor(centre, opts = {}) {
  return (await shopVisit(centre, opts)).url;
}

/** Which centre a discount code belongs to (null when it is not ours). */
async function centreForCode(code) {
  if (!code || !/^VC-/i.test(code)) return null;
  const row = must(await db().from('vc_discount_codes').select('centre_id, code, order_id').eq('code', String(code).toUpperCase()).maybeSingle(), 'code lookup');
  return row;
}

module.exports = { TITLE, PERCENT, ensureDiscount, shopVisit, shopUrlFor, storePath, centreForCode, codeFor };
