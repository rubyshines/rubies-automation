'use strict';
/**
 * The box menu: the five styles a closet can hold (decision 2026-09-16, the
 * highest-margin, deepest-stock styles). Retail prices are the adult store
 * prices; half retail is what a sponsored or requested item costs the box.
 *
 * Colours and stock come from the product cache when it is loaded, so the
 * request form only offers what is in stock; the static list is the fallback
 * so the page renders without Supabase (tests, first boot).
 */

const SIZES = ['XS', 'S', 'M', 'L', '1X', '2X', '3X', '4X'];
const KIDS_SIZES = ['4', '6', '8', '10', '12', '14', '16'];

// Two size systems in the store. AJ, Charlie, Brooke and Ruby run 4 to 16 and
// then L, 1X, 2X, 3X: their adult XS, S and M are the 12, 14 and 16. Sassy runs
// in letters, XXS to 4X, adults only. A closet talks in the letter run above;
// these tables say what each style actually comes in and what to pick from the
// shelf (see storeSize).
const NUMERIC_ADULT_TO_STORE = { XS: '12', S: '14', M: '16' };
const STYLE_SIZES = {
  numeric: [...KIDS_SIZES, 'XS', 'S', 'M', 'L', '1X', '2X', '3X'],
  letter: ['XS', 'S', 'M', 'L', '1X', '2X', '3X', '4X'],
};

const STORE = 'https://rubyshines.com';

const MENU = [
  { key: 'aj',      name: 'AJ',                 title: 'AJ no-tuck shaping underwear',                 kind: 'underwear', sizing: 'numeric', retail_cents: 3200, half_cents: 1600, handle: 'the-aj-shaping-underwear',              colours: ['Black', 'Pink'] },
  { key: 'charlie', name: 'Charlie',            title: 'Charlie no-tuck extra cute shaping underwear', kind: 'underwear', sizing: 'numeric', retail_cents: 3300, half_cents: 1650, handle: 'the-extra-cute-shaping-underwear',       colours: ['Black', 'Sandstone'] },
  { key: 'sassy',   name: 'Sassy',              title: 'Sassy no-tuck shaping underwear',              kind: 'underwear', sizing: 'letter',  retail_cents: 3200, half_cents: 1600, handle: 'the-sassy-no-tuck-shaping-underwear',    colours: ['Black', 'Pink', 'Sandstone'] },
  { key: 'brooke',  name: 'Brooke bra',         title: 'Brooke shaping bra',                           kind: 'bra',       sizing: 'numeric', retail_cents: 4200, half_cents: 2100, handle: 'the-brooke-bra',                         colours: ['Black', 'Sandstone'] },
  { key: 'ruby',    name: 'Ruby bikini bottom', title: 'Ruby no-tuck shaping bikini bottom',           kind: 'swim',      sizing: 'numeric', retail_cents: 4800, half_cents: 2400, handle: 'the-ruby-no-tuck-shaping-bikini-bottom', colours: ['Black', 'Pink'] },
];

// Sponsor tiles, half retail per item; the larger amounts are "toward the shipment".
const SPONSOR_TILES = [
  { key: 'pair',   cents: 1600,  label: '$16',  sub: 'a pair of underwear' },
  { key: 'bra',    cents: 2100,  label: '$21',  sub: 'a bra' },
  { key: 'bottom', cents: 2400,  label: '$24',  sub: 'a bikini bottom' },
  { key: 'fifty',  cents: 5000,  label: '$50',  sub: 'toward the shipment' },
  { key: 'hundred', cents: 10000, label: '$100', sub: 'toward the shipment' },
  { key: 'full',   cents: 30000, label: '$300', sub: 'a full shipment' },
];

let _cacheTried = false;
let _live = null; // key -> { colours: [...], inStock: Set('Colour|Size') }

/** Enrich the menu from the product cache (colours and stock per size). Safe to call often. */
async function loadLive() {
  if (_live) return _live;
  if (_cacheTried) return null;
  _cacheTried = true;
  try {
    const pc = require('../../customer-service/lib/productCache');
    if (!pc.getProducts().length) await pc.loadFromSupabase();
    const products = pc.getProducts();
    const live = {};
    for (const style of MENU) {
      const p = products.find(x => x.handle === style.handle);
      if (!p) continue;
      const colours = new Set();
      const inStock = new Set();
      for (const v of p.variants || []) {
        const opts = Object.fromEntries((v.selectedOptions || []).map(o => [o.name, o.value]));
        const colour = opts.Color || opts.Colour;
        const size = normalizeSize(opts.Size || opts['Youth Size']);
        if (!colour || !size) continue;
        if ((v.inventoryQuantity || 0) > 0) {
          colours.add(colour);
          inStock.add(`${colour}|${size}`);
        }
      }
      if (colours.size) live[style.key] = { colours: [...colours], inStock };
    }
    _live = live;
    return live;
  } catch (err) {
    console.warn(`[vc] product cache unavailable, using the static menu: ${err.message}`);
    return null;
  }
}

/** Store sizes spell 1X as XL on some SKUs; customers only ever see 1X. */
function normalizeSize(s) {
  if (!s) return null;
  const up = String(s).trim().toUpperCase();
  if (up === 'XL') return '1X';
  if (up === 'XXL') return '2X';
  if (up === 'XXXL') return '3X';
  if (up === 'XXXXL') return '4X';
  return up;
}

/** Menu with live colours where known. */
async function menu() {
  const live = await loadLive();
  return MENU.map(s => ({ ...s, colours: live?.[s.key]?.colours?.length ? live[s.key].colours : s.colours }));
}

async function inStock(styleKey, colour, size) {
  const live = await loadLive();
  if (!live || !live[styleKey]) return true; // unknown: do not block the request
  return live[styleKey].inStock.has(`${colour}|${storeSize(styleKey, size)}`);
}

function styleByKey(key) { return MENU.find(s => s.key === key) || null; }

/** The sizes a style comes in, in the closet's own words (kids numbers, then the letter run). */
function styleSizes(styleKey) {
  const style = styleByKey(styleKey);
  return style ? STYLE_SIZES[style.sizing] : [];
}

/** What a centre can offer of a style: its own size settings, cut to what the style comes in. */
function sizesFor(styleKey, centre) {
  const offered = new Set([...(centre.sizes || []), ...(centre.kids_sizes ? KIDS_SIZES : [])]);
  return styleSizes(styleKey).filter(s => offered.has(s));
}

/** The size on the shelf for a size a requester chose: S on AJ is the 14; S on Sassy is S. */
function storeSize(styleKey, size) {
  const s = normalizeSize(size);
  const style = styleByKey(styleKey);
  if (!style || !s) return s;
  return style.sizing === 'numeric' ? (NUMERIC_ADULT_TO_STORE[s] || s) : s;
}

function productUrl(style) { return `${STORE}/products/${style.handle}`; }

module.exports = { SIZES, KIDS_SIZES, STYLE_SIZES, STORE, MENU, SPONSOR_TILES, menu, inStock, styleByKey, styleSizes, sizesFor, storeSize, productUrl, normalizeSize };
