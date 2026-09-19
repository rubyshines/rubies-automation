'use strict';
/**
 * Brand constants for the surfaces that cannot read a stylesheet: the inline
 * styles in emails, colour swatches, the favicon. Values are the live
 * rubyshines.com theme's (rubies-ecom-v4, read 2026-09-16; see
 * .claude/plans/virtual-closet-handover/rubyshines-design-system.md). The
 * pages get the same values from public/closet.css.
 */

const COLOURS = {
  ink: '#310C48',     // all text on light grounds
  black: '#121212',   // buttons
  blue: '#2000A0',    // display words, links in email
  magenta: '#FB00FF', // the one accent: progress bar, the rule on an email
  orange: '#FFAA42',
  lime: '#B3FE00',
  grey: '#F3F3F3',    // card ground
  white: '#FFFFFF',
  soft: '#6E5A80',    // ink at roughly 70% on white, flattened for email clients
};

// The current pink/green wordmark. Email clients do not render SVG, so the
// emails use a PNG rasterised from public/rubies-logo.svg and hosted on the
// store's CDN (uploaded 2026-09-18 through shopifyFileUpload).
const LOGO_PNG = 'https://cdn.shopify.com/s/files/1/0255/9636/2837/files/rubies-logo-email-480.png?v=1789786411';
const FAVICON = 'https://rubyshines.com/cdn/shop/files/RUBIES-logo-pink-green-rgb.svg';

// The store's face is Fixel Display; email clients fall through the stack.
// Single quotes inside, since this lands in style="..." attributes.
const FONT_STACK = "'Fixel Display', Assistant, 'Helvetica Neue', Arial, sans-serif";

// Colourways as the store names them (the theme draws swatches from variant
// images, so these are the closest flat colours for a 16px dot).
const SWATCHES = {
  Black: '#121212',
  Pink: '#F26BC5',
  Sandstone: '#D9C3A5',
  White: '#FFFFFF',
  Mint: '#BDF5DC',
  Sunshine: '#FFE45C',
  Turquoise: '#40E0D0',
  'Neon Green': '#B3FE00',
  Orange: '#FFAA42',
  'Royal Blue': '#2000A0',
  Fuchsia: '#FB00FF',
  Unicorn: 'linear-gradient(135deg, #FB00FF, #FFAA42, #B3FE00, #40E0D0)',
  Floral: 'linear-gradient(135deg, #F26BC5 0 40%, #B3FE00 40% 70%, #FFAA42 70%)',
};

function swatch(colour) {
  return SWATCHES[colour] || COLOURS.grey;
}

module.exports = { COLOURS, LOGO_PNG, FAVICON, FONT_STACK, SWATCHES, swatch };
