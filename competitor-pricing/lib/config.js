/**
 * Competitor pricing configuration.
 *
 * Products manually curated by Jamie — the most comparable product per category.
 * Pipeline uses Shopify JSON API (minimal headers) + /meta.json currency detection
 * + live FX conversion to get USD prices deterministically.
 *
 * RUBIES_PRODUCTS.priceUsd values below are fallback only. The pipeline pulls
 * the live adult-tier price (max variant) from rubyshines.com on each run.
 *
 * Last curated: 2026-04-07
 */

const SHEET_ID = '1JHry_C9qCUrBlXQdUOqnC34gDPgcfSDCw0LtfKyhN5U';

const RUBIES_PRODUCTS = [
  { name: 'AJ Underwear', category: 'underwear', priceUsd: 28, url: 'https://rubyshines.com/products/the-aj-shaping-underwear' },
  { name: 'Ruby Bikini Bottom', category: 'swim_bottom', priceUsd: 44, url: 'https://rubyshines.com/products/the-ruby-no-tuck-shaping-bikini-bottom' },
  { name: 'Mia Halter Bikini Top', category: 'swim_top', priceUsd: 39, url: 'https://rubyshines.com/products/the-mia-halter-bikini-top' },
  { name: 'Sky One-Piece', category: 'swimsuit', priceUsd: 59, url: 'https://rubyshines.com/products/the-sky-shaping-one-piece' },
  { name: 'Brooke Bra', category: 'bra', priceUsd: 39, url: 'https://rubyshines.com/products/the-brooke-bra' },
  { name: 'Ava Seamless Bra', category: 'bra_seamless', priceUsd: 43, url: 'https://rubyshines.com/products/the-ava-seamless-shaping-bra' },
];

const COMPETITORS = [
  {
    brand: 'TomboyX',
    domain: 'tomboyx.com',
    currency: 'USD',
    products: [
      {
        category: 'underwear',
        name: 'Tucking Bikini',
        url: 'https://tomboyx.com/products/tucking-bikini-black-v2',
        collection_url: 'https://tomboyx.com/collections/tucking-underwear',
      },
      {
        category: 'swim_bottom',
        name: 'Swim Tucking Bikini',
        url: 'https://tomboyx.com/products/swim-tucking-bikini-black',
        collection_url: 'https://tomboyx.com/collections/swim-tucking',
      },
      {
        category: 'swimsuit',
        name: 'Swim Tucking One-Piece',
        url: 'https://tomboyx.com/products/swim-tucking-one-piece-black',
        collection_url: 'https://tomboyx.com/collections/swim-tucking',
      },
      {
        category: 'bra',
        name: 'Essentials Soft Bra',
        url: 'https://tomboyx.com/products/essentials-soft-bra-retro-black-logo-v2',
        collection_url: 'https://tomboyx.com/collections/bras',
      },
    ],
  },
  {
    brand: 'Origami Customs',
    domain: 'origamicustoms.com',
    currency: 'CAD',
    products: [
      {
        category: 'underwear',
        name: 'Hipster Gaff',
        url: 'https://origamicustoms.com/products/mesh-gaff-hipster-underwear',
        collection_url: 'https://origamicustoms.com/collections/compression-gaffs',
      },
      {
        category: 'swim_bottom',
        name: 'High Waist Cheeky Swimsuit Bottom',
        url: 'https://origamicustoms.com/products/swim-high-waist-cheeky',
        collection_url: 'https://origamicustoms.com/collections/swim',
      },
      {
        category: 'swim_top',
        name: 'Swim Crop Top',
        url: 'https://origamicustoms.com/products/swim-crop',
        collection_url: 'https://origamicustoms.com/collections/swim',
      },
    ],
  },
  {
    brand: 'En Femme',
    domain: 'enfemmestyle.com',
    currency: 'USD',
    products: [
      {
        category: 'underwear',
        name: 'Comfort Smooth Tucking Thong',
        url: 'https://enfemmestyle.com/products/comfort-smooth-thong-gaff',
        collection_url: 'https://enfemmestyle.com/collections/all',
      },
      {
        category: 'swim_bottom',
        name: 'Tucking Hipster Bikini Swim Bottom',
        url: 'https://enfemmestyle.com/products/en-femme-strappy-tucking-hipster-bikini-bottom',
        collection_url: 'https://enfemmestyle.com/collections/all',
      },
      {
        category: 'swimsuit',
        name: 'Scoop Neck Sport Tank Tucking Swimsuit',
        url: 'https://enfemmestyle.com/products/en-femme-scoop-neck-sport-tank-swimsuit',
        collection_url: 'https://enfemmestyle.com/collections/all',
      },
      {
        category: 'bra',
        name: 'Sleek Design Light Support Bra',
        url: 'https://enfemmestyle.com/products/en-femme-sleek-design-light-support-bra',
        collection_url: 'https://enfemmestyle.com/collections/all',
      },
    ],
  },
  {
    brand: 'UNTAG',
    domain: 'untag.com',
    currency: 'EUR',
    products: [
      {
        category: 'underwear',
        name: 'Tucking Panties',
        url: 'https://untag.com/products/tucking-panties-21-black',
        collection_url: 'https://untag.com/collections/tucking',
      },
      {
        category: 'swim_bottom',
        name: 'Tucking Bikini Brief',
        url: 'https://untag.com/products/tucking-bikini-brief-36-black',
        collection_url: 'https://untag.com/collections/swimwear',
      },
      {
        category: 'swimsuit',
        name: 'One Piece Zipper',
        url: 'https://untag.com/products/one-piece-zipper-black',
        collection_url: 'https://untag.com/collections/swimwear',
      },
      {
        category: 'bra',
        name: 'Bra Top',
        url: 'https://untag.com/products/bra-top-13',
        collection_url: 'https://untag.com/collections/bra-tops',
      },
    ],
  },
  // LeoLines — Etsy-based, no Shopify JSON support. Dropped for now.
  {
    brand: 'Knix',
    domain: 'knix.ca',
    currency: 'CAD',
    // Mainstream comparable for Ava Seamless Bra
    products: [
      {
        category: 'bra_seamless',
        name: 'Shape & Smooth Bra',
        url: 'https://knix.ca/products/shape-smooth-bra',
        collection_url: 'https://knix.ca/collections/bras',
      },
    ],
  },
];

// Fallback exchange rates if API is unreachable
const EXCHANGE_RATE_FALLBACKS = {
  GBP: 1.27,
  EUR: 1.08,
  CAD: 0.74,
  AUD: 0.66,
};

module.exports = { SHEET_ID, RUBIES_PRODUCTS, COMPETITORS, EXCHANGE_RATE_FALLBACKS };
