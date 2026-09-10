/**
 * Wholesale price list tools.
 *
 *   wholesale_price_list          — the sheet and terms at a rate, as markdown (no files)
 *   wholesale_price_list_publish  — write assets/wholesale-pricing.json to the theme + auto-merge
 *
 * The list itself lives in b2b-outreach/lib/wholesalePriceList.js; sending it
 * to a retailer is the `wholesale_terms` template (b2b_template), which links
 * the page.
 */

const {
  buildPriceList, wholesaleTermsLines, loadSheetProducts, PAGE_URL, PAGE_DISCOUNT_PERCENT,
} = require('../../../b2b-outreach/lib/wholesalePriceList');
const { publishWholesalePricing } = require('../wholesalePriceListPublish');

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

async function handleList({ discount_percent, all_products } = {}) {
  const pct = discount_percent == null ? PAGE_DISCOUNT_PERCENT : Number(discount_percent);
  const products = await loadSheetProducts();
  const list = buildPriceList(products, { discountPercent: pct, featured: all_products !== true });
  const lines = [`## RUBIES Wholesale Price List (${pct}% off retail, ${list.currency})${all_products ? ' — every eligible product' : ''}`];
  for (const s of list.sections) {
    lines.push('', `### ${s.name}`, '', '| Product | Sizes | Retail | Wholesale |', '|---|---|---:|---:|');
    for (const p of s.products) {
      p.bands.forEach((b, i) => lines.push(`| ${i ? '' : `[${p.product}](${p.url})`} | ${b.sizes} | ${money(b.retail)} | ${money(b.wholesale)} |`));
    }
  }
  lines.push('', '### Terms');
  for (const t of wholesaleTermsLines(pct)) lines.push(`- ${t}`);
  lines.push('', `Page (${PAGE_DISCOUNT_PERCENT}%): ${PAGE_URL}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handlePublish({ dry_run, merge } = {}) {
  const result = await publishWholesalePricing({
    dry_run: dry_run === true,
    merge: merge !== false,
  });
  const lines = [
    result.path
      ? `Wrote ${result.count} products at ${result.discount_percent}% to ${result.path}`
      : `Published ${result.count} products at ${result.discount_percent}%.`,
  ];

  if (result.dryRun) {
    lines.push('', '_(dry_run)_ — working tree only. No commit, no push, no deploy.');
  } else if (result.noOp) {
    lines.push('', 'No content change vs origin/main — nothing to commit or deploy.');
  } else if (result.merged) {
    lines.push('', '**Merged + deploying** — Shopify auto-pulls main within ~30s.');
    if (result.prUrl) lines.push(`PR (merged): ${result.prUrl}`);
    if (result.liveUrl) lines.push('', `Live page: ${result.liveUrl}`);
    if (result.mergeWarning) lines.push('', `_(${result.mergeWarning})_`);
  } else {
    const prCompareUrl = result.remoteUrl
      ? result.remoteUrl.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '') + `/compare/${result.baseBranch}...${result.branch}?expand=1`
      : null;
    lines.push('', result.mergeError
      ? `Pushed branch **${result.branch}** but auto-merge failed: ${result.mergeError}`
      : `Pushed branch **${result.branch}** (merge skipped because merge:false).`);
    if (prCompareUrl) lines.push(`Open PR: ${prCompareUrl}`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }], _structured: result };
}

module.exports = [
  {
    name: 'wholesale_price_list',
    description: `The RUBIES wholesale terms and line sheet as markdown, at a rate (default ${PAGE_DISCOUNT_PERCENT}%). The sheet is the curated featured subset in popularity order (Underwear, Swimwear, Bras; edit FEATURED in wholesalePriceList.js to change it); pass all_products: true for every eligible catalog product. Each product lists one band per price ("Youth 4-11", "Adult 12-16, XS-4X"), wholesale = retail less the discount. This is the same data the storefront page shows (the wholesale_terms email template links that page). No files are written.`,
    inputSchema: {
      type: 'object',
      properties: {
        discount_percent: { type: 'number', description: `Rate to price at. Default ${PAGE_DISCOUNT_PERCENT} (US/AU); international retailers are 30.` },
        all_products: { type: 'boolean', description: 'true = every eligible product A-Z, not just the featured sheet. Use when a retailer asks about a style the sheet does not list.' },
      },
    },
    handler: handleList,
  },
  {
    name: 'wholesale_price_list_publish',
    description: `Publish the wholesale line sheet (featured products at the page rate, ${PAGE_DISCOUNT_PERCENT}%, with their current Shopify product photos) → assets/wholesale-pricing.json on the rubies-ecom-v4 theme repo, AND auto-merge to main so Shopify deploys it (~30s) to ${PAGE_URL}. This also runs by itself: set_product_prices publishes after every committed price change, and the nightly sync publishes after the product sync (needs GITHUB_TOKEN on Railway). Commits nothing when only the timestamp changed. With GITHUB_TOKEN set it commits straight to the theme's main through the GitHub API; otherwise it uses an isolated git worktree + PR so any in-progress theme branch is untouched. Pass dry_run: true to only update the theme working tree (no commit/push/merge). Pass merge: false to commit+push but skip the auto-merge.`,
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'If true, only write the JSON to the theme working tree — no commit, no push, no deploy.' },
        merge: { type: 'boolean', description: 'If false, commit+push to a branch but do not merge. Default true → auto-merge → auto-deploy.' },
      },
    },
    handler: handlePublish,
  },
];
