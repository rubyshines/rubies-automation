const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const { getSupabaseClient, upsert } = require('../shared/supabaseClient');
const { getSendgridClient } = require('../shared/sendgridClient');
const { tryShopifyJson, detectShopifyCurrency, closeBrowser } = require('./lib/priceScraper');
const { writeToSheet } = require('./lib/sheetWriter');
const { buildEmail } = require('./lib/emailTemplate');
const { RUBIES_PRODUCTS, COMPETITORS, EXCHANGE_RATE_FALLBACKS } = require('./lib/config');

// ---------------------------------------------------------------------------
// Exchange rates
// ---------------------------------------------------------------------------
let _exchangeRates = null;

async function loadExchangeRates() {
  try {
    for (const apiUrl of [
      'https://open.er-api.com/v6/latest/USD',
      'https://api.exchangerate.host/latest?base=USD',
    ]) {
      try {
        const res = await fetch(apiUrl);
        const data = await res.json();
        if (data && data.rates) { _exchangeRates = data.rates; break; }
      } catch { continue; }
    }
    if (_exchangeRates) console.log('  Exchange rates loaded');
  } catch {
    console.warn('  Exchange rate APIs failed, using fallbacks');
  }
}

function toUsd(amount, currency) {
  if (currency === 'USD') return amount;
  if (_exchangeRates && _exchangeRates[currency]) {
    return Math.round((amount / _exchangeRates[currency]) * 100) / 100;
  }
  if (EXCHANGE_RATE_FALLBACKS[currency]) {
    return Math.round(amount * EXCHANGE_RATE_FALLBACKS[currency] * 100) / 100;
  }
  return amount;
}

// ---------------------------------------------------------------------------
// Pull current RUBIES adult-tier prices live from Shopify so the report
// never drifts after a price change. Each product's `priceUsd` is replaced
// with the max variant price (adult tier; youth is the cheaper variants).
// Falls back to whatever was hardcoded in config if the fetch fails.
// ---------------------------------------------------------------------------
async function loadRubiesAdultPrices() {
  for (const product of RUBIES_PRODUCTS) {
    try {
      const jsonUrl = product.url.replace(/\/?$/, '.json');
      const res = await fetch(jsonUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': '' },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        console.warn(`  RUBIES ${product.name}: HTTP ${res.status}, keeping $${product.priceUsd}`);
        continue;
      }
      const data = await res.json();
      const variants = data?.product?.variants || [];
      const prices = variants
        .map((v) => parseFloat(v.price))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (prices.length === 0) {
        console.warn(`  RUBIES ${product.name}: no variant prices, keeping $${product.priceUsd}`);
        continue;
      }
      const maxLocal = Math.max(...prices);
      const baseCurrency = (await detectShopifyCurrency(product.url)) || 'USD';
      product.priceUsd = toUsd(maxLocal, baseCurrency);
      console.log(`  RUBIES ${product.name}: ${baseCurrency} ${maxLocal} (adult tier) = $${product.priceUsd}`);
    } catch (err) {
      console.warn(`  RUBIES ${product.name}: ${err.message}, keeping $${product.priceUsd}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scrape all products
// ---------------------------------------------------------------------------
async function scrapeAll() {
  await loadExchangeRates();

  // Pull our own current adult-tier prices so the comparison is fresh
  await loadRubiesAdultPrices();

  // Pre-warm currency detection for all domains
  for (const comp of COMPETITORS) {
    if (comp.products.length > 0) {
      await detectShopifyCurrency(comp.products[0].url);
    }
  }
  console.log('  Store currencies detected');

  // Build list of all jobs
  const jobs = [];
  for (const comp of COMPETITORS) {
    for (const product of comp.products) {
      jobs.push({ comp, product });
    }
  }

  // First pass: try all products, 1s between requests
  const results = new Map(); // key: "brand:category"
  let pending = [...jobs];

  for (let round = 1; round <= 4; round++) {
    if (round > 1) {
      console.log(`  Round ${round}: retrying ${pending.length} failed product(s) after 30s cooldown...`);
      await new Promise((r) => setTimeout(r, 30000));
    }

    const stillFailing = [];

    for (const { comp, product } of pending) {
      const key = `${comp.brand}:${product.category}`;
      console.log(`  ${comp.brand} — ${product.name}${round > 1 ? ` (retry ${round - 1})` : ''}`);
      try {
        const data = await tryShopifyJson(product.url);
        if (!data) {
          console.log('    -> null response');
          stillFailing.push({ comp, product });
          continue;
        }

        const currency = data.currency_code || comp.currency;
        const priceUsd = toUsd(data.price, currency);
        const rubies = RUBIES_PRODUCTS.find((p) => p.category === product.category);
        const priceDiffUsd = rubies ? Math.round((priceUsd - rubies.priceUsd) * 100) / 100 : null;
        const priceDiffPct = rubies?.priceUsd
          ? Math.round(((priceUsd - rubies.priceUsd) / rubies.priceUsd) * 1000) / 10 : null;

        results.set(key, {
          competitor: comp.brand, domain: comp.domain, category: product.category,
          productName: data.product_name || product.name, productUrl: product.url,
          priceLocal: data.price, currencyCode: currency, priceUsd,
          compareAtPriceUsd: data.compare_at_price ? toUsd(data.compare_at_price, currency) : null,
          inStock: data.in_stock !== false, scrapeMethod: 'shopify_json',
          scrapeError: null, priceDiffUsd, priceDiffPct,
        });
        console.log(`    -> ${currency} ${data.price} = USD $${priceUsd}`);
      } catch (err) {
        console.log(`    -> ERROR: ${err.message}`);
        stillFailing.push({ comp, product });
      }
    }

    pending = stillFailing;
    if (pending.length === 0) {
      console.log(`  All products scraped successfully${round > 1 ? ` after ${round} rounds` : ''}`);
      break;
    }
  }

  // Any still-failing products get error entries
  for (const { comp, product } of pending) {
    const key = `${comp.brand}:${product.category}`;
    if (!results.has(key)) {
      results.set(key, {
        competitor: comp.brand, domain: comp.domain, category: product.category,
        productName: product.name, productUrl: product.url,
        priceLocal: null, currencyCode: comp.currency, priceUsd: null,
        compareAtPriceUsd: null, inStock: false, scrapeMethod: 'shopify_json',
        scrapeError: 'Failed after 4 attempts',
      });
    }
  }

  return [...results.values()];
}

// ---------------------------------------------------------------------------
// Detect price changes vs previous month
// ---------------------------------------------------------------------------
async function detectPriceChanges(results, scrapeDate) {
  try {
    const supabase = getSupabaseClient();
    const { data: previous } = await supabase
      .from('competitor_prices')
      .select('competitor_brand, product_category, product_name, price_local, currency_code, price_usd, scrape_date')
      .lt('scrape_date', scrapeDate)
      .not('price_local', 'is', null)
      .order('scrape_date', { ascending: false });

    if (!previous || previous.length === 0) return [];

    // Most recent price per competitor+category
    const prevMap = new Map();
    for (const row of previous) {
      const key = `${row.competitor_brand}:${row.product_category}`;
      if (!prevMap.has(key)) prevMap.set(key, row);
    }

    // Compare in the merchant's own currency. Real price changes show in local
    // currency; market FX wobble doesn't. This avoids flagging $1 USD shifts
    // that are just CAD/EUR rate movement. If the store changed currency
    // (e.g. CA stopped serving CAD), skip — not comparable.
    const changes = [];
    for (const r of results) {
      if (!r.priceLocal || r.scrapeError) continue;
      const key = `${r.competitor}:${r.category}`;
      const prev = prevMap.get(key);
      if (!prev || prev.currency_code !== r.currencyCode) continue;
      if (Math.abs(Number(prev.price_local) - r.priceLocal) > 0.5) {
        changes.push({
          competitor: r.competitor,
          category: r.category,
          productName: r.productName,
          previousPrice: Number(prev.price_usd),
          currentPrice: r.priceUsd,
          previousPriceLocal: Number(prev.price_local),
          currentPriceLocal: r.priceLocal,
          currency: r.currencyCode,
          previousDate: prev.scrape_date,
        });
      }
    }
    return changes;
  } catch (err) {
    console.warn('  Price change detection failed:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Send consolidated HTML email — price changes first, then full summary
// ---------------------------------------------------------------------------
async function sendSummaryEmail(date, results, priceChanges) {
  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.log('  SendGrid not configured — skipping email');
    return;
  }

  const categories = [...new Set(RUBIES_PRODUCTS.map((p) => p.category))];
  const competitorNames = [...new Set(COMPETITORS.map((c) => c.brand))];
  const categoryRows = [];

  for (const cat of categories) {
    const rubies = RUBIES_PRODUCTS.find((p) => p.category === cat);
    const comps = [];
    for (const comp of competitorNames) {
      const r = results.find((x) => x.competitor === comp && x.category === cat);
      if (r && !r.scrapeError && r.priceUsd) {
        comps.push({
          name: comp, product: r.productName, priceUsd: r.priceUsd,
          diff: Math.round(r.priceUsd - rubies.priceUsd),
        });
      }
    }
    const avg = comps.length > 0
      ? Math.round(comps.reduce((s, c) => s + c.priceUsd, 0) / comps.length)
      : null;
    categoryRows.push({
      label: { underwear: 'Underwear', swim_bottom: 'Swim Bottom', swim_top: 'Swim / Bikini Top',
        swimsuit: 'One-Piece', bra: 'Bra', bra_seamless: 'Seamless Bra' }[cat] || cat,
      rubiesProduct: rubies.name, rubiesPrice: rubies.priceUsd,
      avgCompetitor: avg, competitors: comps,
    });
  }

  const avgs = categoryRows.filter((c) => c.avgCompetitor);
  const overallRubies = avgs.length > 0 ? Math.round(avgs.reduce((s, c) => s + c.rubiesPrice, 0) / avgs.length) : 0;
  const overallComp = avgs.length > 0 ? Math.round(avgs.reduce((s, c) => s + c.avgCompetitor, 0) / avgs.length) : 0;

  const html = buildEmail({
    date,
    categoryRows,
    overall: { rubiesAvg: overallRubies, competitorAvg: overallComp, diff: overallRubies - overallComp },
    priceChanges,
    insights: null,
    errors: results.filter((r) => r.scrapeError).map((r) => ({
      competitor: r.competitor, category: r.category, error: r.scrapeError,
    })),
  });

  const hasChanges = priceChanges.length > 0;
  const errors = results.filter((r) => r.scrapeError);
  const icon = errors.length > 0 ? '⚠️' : hasChanges ? '📊' : '✅';
  const month = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  await sgMail.send({
    to: 'jamie@rubyshines.com',
    from: 'pipeline@rubyshines.com',
    subject: `${icon} Competitor Pricing — ${month}${hasChanges ? ` — ${priceChanges.length} price change(s)` : ''}`,
    html,
  });

  console.log('  Summary email sent');
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------
async function run() {
  console.log('Competitor Pricing Pipeline — starting');

  const scrapeDate = new Date().toISOString().slice(0, 10);
  const pipelineResults = { competitor_prices: { success: false, rowsWritten: 0, error: null } };

  try {
    // 1. Scrape
    const results = await scrapeAll();

    // 2. Upsert to Supabase
    let rowsWritten = 0;
    try {
      const rows = results.map((r) => ({
        scrape_date: scrapeDate, competitor_brand: r.competitor,
        competitor_domain: r.domain, product_category: r.category,
        product_name: r.productName, product_url: r.productUrl,
        price_local: r.priceLocal, currency_code: r.currencyCode,
        price_usd: r.priceUsd, compare_at_price_usd: r.compareAtPriceUsd,
        in_stock: r.inStock,
        rubies_product_name: (RUBIES_PRODUCTS.find((p) => p.category === r.category) || {}).name || '',
        rubies_price_usd: (RUBIES_PRODUCTS.find((p) => p.category === r.category) || {}).priceUsd || 0,
        price_diff_usd: r.priceDiffUsd, price_diff_pct: r.priceDiffPct,
        scrape_method: r.scrapeMethod, scrape_error: r.scrapeError,
      }));
      rowsWritten = await upsert('competitor_prices', rows, ['scrape_date', 'competitor_brand', 'product_category']);
      console.log(`  ${rowsWritten} rows upserted to Supabase`);
    } catch (dbErr) {
      console.warn('  Supabase upsert failed (non-critical):', dbErr.message);
    }

    // 3. Detect price changes vs previous month
    const priceChanges = await detectPriceChanges(results, scrapeDate);
    if (priceChanges.length > 0) {
      console.log(`  ${priceChanges.length} price change(s) detected`);
    } else {
      console.log('  No price changes detected');
    }

    // 4. Write Google Sheet (always)
    const competitorNames = [...new Set(COMPETITORS.map((c) => c.brand))];
    try {
      await writeToSheet({ date: scrapeDate, results, rubiesProducts: RUBIES_PRODUCTS, competitors: competitorNames, priceChanges });
    } catch (sheetErr) {
      console.warn('  Sheet write failed (non-critical):', sheetErr.message);
    }

    // 5. Send summary email (always)
    try {
      await sendSummaryEmail(scrapeDate, results, priceChanges);
    } catch (emailErr) {
      console.warn('  Email send failed (non-critical):', emailErr.message);
    }

    const errorCount = results.filter((r) => r.scrapeError).length;
    pipelineResults.competitor_prices = {
      success: true, rowsWritten,
      error: errorCount > 0 ? `${errorCount} scrape error(s)` : null,
    };

    console.log('Competitor Pricing Pipeline — done');
  } catch (err) {
    console.error('Competitor Pricing Pipeline — FAILED:', err.message);
    pipelineResults.competitor_prices = { success: false, rowsWritten: 0, error: err.message };
  } finally {
    await closeBrowser();
  }

  return {
    sources: pipelineResults,
    status: Object.values(pipelineResults).every((r) => r.success) ? 'success' : 'failure',
  };
}

module.exports = { run };

if (require.main === module) {
  run()
    .then((result) => {
      console.log('\nResult:', JSON.stringify(result, null, 2));
      process.exit(result.status === 'success' ? 0 : 1);
    })
    .catch((err) => {
      console.error('Pipeline failed:', err);
      process.exit(1);
    });
}
