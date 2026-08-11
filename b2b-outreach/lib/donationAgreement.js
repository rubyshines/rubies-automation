/**
 * donationAgreement.js — generate the RUBIES LGBTQ+ Organization Donation
 * Program Partnership Agreement for one org, as a signed PDF.
 *
 * Deliberately deterministic, with no AI anywhere in it. This is a contract:
 * the clause wording must be byte-identical every time it goes out, or we
 * cannot say what we actually agreed to with any given partner. The only two
 * variables are the org's name and its discount rate, and the rate is a
 * lookup, not a judgment. (House rule: AI decides, code calculates — this is
 * squarely calculation.)
 *
 * Replaces a manual routine: copy the Google Doc, type the org name in, export
 * to PDF, attach. Same output, minus the chance of sending the wrong org's copy.
 *
 * The founder's signature is embedded, matching the pre-signed PDF partners
 * already receive; the counter-signature line below it is left blank for them.
 */
const fs = require('fs');
const path = require('path');

const SIGNATURE_PATH = path.join(__dirname, '../assets/jamie-signature.png');

/**
 * Partner discount by country. US and Australia get 50%, everywhere else 30%,
 * matching wholesale pricing — the gap covers duties we absorb on other
 * destinations. Pure.
 *
 * NOTE: Trans Healthkit Projekt (Germany) holds a signed agreement stating 50%,
 * issued in error before this rule was settled. Jamie's call 2026-08-11 is that
 * they move to the standard 30% German rate rather than the rule bending around
 * one mis-issued document; if they raise it we say plainly that we made a
 * mistake. So the country lookup is the single source of truth for every
 * partner, with no historical exceptions carved out of it.
 */
const FIFTY_PERCENT_COUNTRIES = new Set([
  'us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america',
  'au', 'aus', 'australia',
]);

function partnerDiscountPercent(country) {
  const key = String(country || '').trim().toLowerCase();
  if (!key) return 30; // unknown country: quote the conservative rate
  return FIFTY_PERCENT_COUNTRIES.has(key) ? 50 : 30;
}

/** Filename partners receive. Pure. */
function agreementFilename(orgName) {
  const clean = String(orgName || '').replace(/[\\/:*?"<>|]/g, '').trim();
  return `RUBIES LGBTQ+ Organization Donation Partnership Agreement - ${clean}.pdf`;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The agreement as HTML, ready for PDF rendering. Pure apart from reading the
 * signature asset, which is passed in so this stays testable.
 */
function agreementHtml({ orgName, discountPercent, signatureDataUri = '' }) {
  if (!orgName?.trim()) throw new Error('orgName is required');
  if (![30, 50].includes(discountPercent)) throw new Error(`discountPercent must be 30 or 50, got ${discountPercent}`);
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: letter; margin: 0.9in 1in; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.5; color: #000; }
  /* 13pt keeps the title on one line at letter width, as in the original. */
  h1 { font-size: 13pt; font-weight: normal; color: #444; margin: 0 0 26px; }
  p { margin: 0 0 16px; }
  ul { margin: 0 0 22px; padding-left: 26px; }
  li { margin-bottom: 7px; }
  .sig-label { margin: 34px 0 0; }
  .sig-img { height: 58px; margin: 2px 0 0; display: block; }
  .sig-line { border-bottom: 1px solid #000; width: 340px; margin: 0; }
  .sig-name { margin: 4px 0 0; }
  .countersign { border-bottom: 1px solid #000; width: 340px; margin: 74px 0 0; }
</style></head><body>
  <h1>RUBIES LGBTQ+ Organization Donation Program Partnership Agreement</h1>

  <p>The following agreement between RUBIES Apparel Inc and ${escapeHtml(orgName.trim())}
  establishes the shared responsibilities of RUBIES and partner organizations in the RUBIES
  LGBTQ+ Organization Donation Program. In this program RUBIES customers that live in a
  region close to your organization will be instructed to send returns and pre-loved items
  directly to you.</p>

  <p>The partner organization agrees to the following in order to participate in a partnership
  with RUBIES to provide gender affirming clothing to local community members:</p>
  <ul>
    <li>Provide a primary point of contact for all communication related to the program.</li>
    <li>Process and make available any clothing sent to your organization available within one
    month after receipt. The clothing should be offered for free or for a very nominal fee.</li>
    <li>Promote RUBIES clothing availability on your social media.</li>
  </ul>

  <p>RUBIES agrees to the following in order to participate in a partnership with RUBIES to
  provide gender affirming clothing to local community members:</p>
  <ul>
    <li>Provide your organization with a ${discountPercent}% discount off the retail price of all
    RUBIES merchandise.</li>
    <li>Include your organization in the roster of organizations that RUBIES customers will be
    directed to return items to. Customers that are geographically close will be more likely to
    be referred to your organization.</li>
    <li>Provide customers with packaging instructions for their donations.</li>
    <li>Provide your organization with materials to help educate your community about our
    gender affirming products.</li>
  </ul>

  <p class="sig-label">Signed on</p>
  ${signatureDataUri ? `<img class="sig-img" src="${signatureDataUri}" alt="">` : '<div style="height:58px"></div>'}
  <div class="sig-line"></div>
  <p class="sig-name">Jamie Alexander - RUBIES Founder</p>
  <div class="countersign"></div>
</body></html>`;
}

/** The stored signature as a data URI, so the HTML is self-contained. */
function signatureDataUri() {
  const png = fs.readFileSync(SIGNATURE_PATH);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * Render the agreement to a PDF buffer.
 * @returns { filename, buffer, discountPercent }
 */
async function renderAgreementPdf({ orgName, country, discountPercent } = {}) {
  const pct = discountPercent ?? partnerDiscountPercent(country);
  const html = agreementHtml({ orgName, discountPercent: pct, signatureDataUri: signatureDataUri() });

  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const buffer = await page.pdf({ format: 'letter', printBackground: true });
    return { filename: agreementFilename(orgName), buffer, discountPercent: pct };
  } finally {
    await browser.close();
  }
}

module.exports = {
  partnerDiscountPercent,
  agreementFilename,
  agreementHtml,
  signatureDataUri,
  renderAgreementPdf,
  SIGNATURE_PATH,
};
