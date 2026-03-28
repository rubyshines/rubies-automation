#!/usr/bin/env node
/**
 * RUBIES Finance — Business Valuation Report Generator
 * Generates a PDF with current and projected valuations under multiple scenarios.
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, 'reports');

function generateValuationReport(data, outputPath) {
  if (!fs.existsSync(path.dirname(outputPath))) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 50, bottom: 50, left: 50, right: 50 } });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const colors = {
    brand: '#8B1A4A',
    dark: '#1a1a1a',
    medium: '#444444',
    light: '#666666',
    accent: '#2E7D32',
    negative: '#C62828',
    headerBg: '#F5F0F2',
    rowAlt: '#FAFAFA',
    line: '#D0D0D0',
  };

  // --- Helper: draw table ---
  function drawTable(title, headers, rows, startY, colWidths, opts = {}) {
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
    const x0 = opts.x0 || 50;

    if (title) {
      doc.font('Helvetica-Bold').fontSize(12).fill(colors.brand).text(title, x0, startY);
      startY += 20;
    }

    // Header row
    doc.rect(x0, startY, tableWidth, 20).fill(colors.brand);
    doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(opts.fontSize || 8.5);
    let cx = x0;
    headers.forEach((h, i) => {
      const align = i === 0 ? 'left' : 'right';
      doc.text(h, cx + 5, startY + 5, { width: colWidths[i] - 10, align });
      cx += colWidths[i];
    });
    startY += 20;

    // Data rows
    doc.font('Helvetica').fontSize(opts.fontSize || 8.5);
    rows.forEach((row, ri) => {
      const isBold = row._bold;
      const isHighlight = row._highlight;
      const rowH = opts.rowHeight || 18;

      if (isHighlight) {
        doc.rect(x0, startY, tableWidth, rowH).fill('#FFF3E0');
      } else if (isBold) {
        doc.rect(x0, startY, tableWidth, rowH).fill(colors.headerBg);
      } else if (ri % 2 === 1) {
        doc.rect(x0, startY, tableWidth, rowH).fill(colors.rowAlt);
      }

      doc.fill(colors.dark).font(isBold || isHighlight ? 'Helvetica-Bold' : 'Helvetica');
      cx = x0;
      headers.forEach((h, i) => {
        const val = row[h] || '';
        const align = i === 0 ? 'left' : 'right';
        doc.text(val, cx + 5, startY + 5, { width: colWidths[i] - 10, align });
        cx += colWidths[i];
      });
      startY += rowH;
    });

    doc.moveTo(x0, startY).lineTo(x0 + tableWidth, startY).stroke(colors.line);
    return startY + 8;
  }

  // --- Helper: section heading ---
  function sectionHeading(text, y) {
    doc.font('Helvetica-Bold').fontSize(13).fill(colors.brand).text(text, 50, y);
    return y + 20;
  }

  // --- Helper: bullet list ---
  function bulletList(items, y, opts = {}) {
    const fontSize = opts.fontSize || 9;
    const width = opts.width || 490;
    doc.font('Helvetica').fontSize(fontSize).fill(colors.dark);
    items.forEach(item => {
      const isBold = item.startsWith('**');
      const text = item.replace(/\*\*/g, '');
      doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(`\u2022  ${text}`, 55, y, { width });
      y += doc.heightOfString(`\u2022  ${text}`, { width }) + 3;
    });
    return y;
  }

  // =========================================================================
  // PAGE 1 — Header + Executive Summary + Current State
  // =========================================================================
  doc.rect(0, 0, doc.page.width, 90).fill(colors.brand);
  doc.fill('#FFFFFF')
    .fontSize(24).font('Helvetica-Bold')
    .text('RUBIES', 50, 25, { continued: true })
    .font('Helvetica').text('  Business Valuation Report');
  doc.fontSize(11).text(`Generated: ${new Date().toLocaleDateString('en-CA')}  |  Confidential — Internal Use Only`, 50, 58);
  doc.fill(colors.dark);

  let y = 110;

  // --- Executive Summary ---
  y = sectionHeading('Executive Summary', y);
  y = bulletList([
    'RUBIES is a DTC gender-affirming underwear brand generating ~$898K CAD (2025), growing 28% YoY',
    'Strong fundamentals: 72.6% gross margin, 16.6% net margin (ex-one-time basis)',
    'Current valuation range: $700K — $1.2M CAD (2.5-3.5x SDE)',
    '**Projected end-of-2026 valuation: $1.4M — $2.0M CAD** with AI automation + revenue growth to $1.2M+',
    'Key value driver: AI-powered operations reduce owner involvement to 12-15 hrs/week, making the business near semi-passive',
  ], y);
  y += 8;

  // --- Current Financial Snapshot ---
  y = sectionHeading('Current Financial Snapshot (2025, Ex-One-Time)', y);
  const snapHeaders = ['Metric', '2024', '2025', 'YoY Change'];
  const snapCw = [160, 100, 100, 100];
  y = drawTable('', snapHeaders, [
    { 'Metric': 'Revenue', '2024': '$702,151', '2025': '$897,515', 'YoY Change': '+27.8%' },
    { 'Metric': 'Gross Profit', '2024': '$484,216', '2025': '$651,211', 'YoY Change': '+34.5%' },
    { 'Metric': 'Gross Margin', '2024': '69.0%', '2025': '72.6%', 'YoY Change': '+3.6 pts', _bold: true },
    { 'Metric': 'Net Profit', '2024': '$40,933', '2025': '$149,200', 'YoY Change': '+264%' },
    { 'Metric': 'Net Margin', '2024': '5.8%', '2025': '16.6%', 'YoY Change': '+10.8 pts', _bold: true },
  ], y, snapCw);
  y += 5;

  // --- SDE Calculation ---
  y = sectionHeading("Seller's Discretionary Earnings (SDE)", y);
  const sdeHeaders = ['Component', 'Current (2025)', 'Projected (2026)'];
  const sdeCw = [220, 120, 120];
  y = drawTable('', sdeHeaders, [
    { 'Component': 'Net Profit (ex-one-time)', 'Current (2025)': '$149,200', 'Projected (2026)': '$180,000' },
    { 'Component': 'Owner Salary', 'Current (2025)': '$150,000', 'Projected (2026)': '$150,000' },
    { 'Component': 'Home Office', 'Current (2025)': '$4,654', 'Projected (2026)': '$5,000' },
    { 'Component': 'Vehicle', 'Current (2025)': '$4,260', 'Projected (2026)': '$4,500' },
    { 'Component': 'SDE', 'Current (2025)': '$308,114', 'Projected (2026)': '$339,500', _bold: true },
  ], y, sdeCw);

  // =========================================================================
  // PAGE 2 — Valuation Scenarios
  // =========================================================================
  doc.addPage();
  y = 50;

  y = sectionHeading('Valuation Scenarios', y);

  // --- Scenario 1: Today ---
  doc.font('Helvetica-Bold').fontSize(10).fill(colors.medium).text('Scenario 1: Sell Today (as-is)', 55, y);
  y += 16;
  const s1Headers = ['', 'Multiple', 'Valuation (CAD)'];
  const s1Cw = [200, 100, 160];
  y = drawTable('', s1Headers, [
    { '': 'Conservative', 'Multiple': '2.0x SDE', 'Valuation (CAD)': '$616,000' },
    { '': 'Mid-range', 'Multiple': '3.0x SDE', 'Valuation (CAD)': '$924,000' },
    { '': 'Optimistic', 'Multiple': '3.5x SDE', 'Valuation (CAD)': '$1,078,000' },
    { '': 'Most Likely Range', 'Multiple': '2.5-3.0x', 'Valuation (CAD)': '$770K — $924K', _bold: true },
  ], y, s1Cw);
  y += 5;

  doc.font('Helvetica').fontSize(8.5).fill(colors.light)
    .text('Assumptions: Owner works ~20 hrs/week, business still somewhat owner-dependent, sub-$1M revenue, niche market.', 55, y, { width: 490 });
  y += 22;

  // --- Scenario 2: End of 2026 with AI ---
  doc.font('Helvetica-Bold').fontSize(10).fill(colors.medium).text('Scenario 2: End of 2026 — AI Automation Complete, 12-15 hrs/week', 55, y);
  y += 16;
  y = drawTable('', s1Headers, [
    { '': 'Conservative', 'Multiple': '3.5x SDE', 'Valuation (CAD)': '$1,188,000' },
    { '': 'Mid-range', 'Multiple': '4.5x SDE', 'Valuation (CAD)': '$1,528,000' },
    { '': 'Optimistic (strategic buyer)', 'Multiple': '5.0x SDE', 'Valuation (CAD)': '$1,698,000' },
    { '': 'Most Likely Range', 'Multiple': '4.0-4.5x', 'Valuation (CAD)': '$1.36M — $1.53M', _bold: true },
  ], y, s1Cw);
  y += 5;

  doc.font('Helvetica').fontSize(8.5).fill(colors.light)
    .text('Assumptions: Revenue $1.2M+, AI CS advisor handles exchanges/sizing end-to-end, financial analysis automated, daily syncs unattended, owner at 12-15 hrs/week.', 55, y, { width: 490 });
  y += 30;

  // --- Scenario 3: Stretch ---
  doc.font('Helvetica-Bold').fontSize(10).fill(colors.medium).text('Scenario 3: Stretch — $1.5M Revenue + Subscription Model', 55, y);
  y += 16;
  const stretchSDE = 420000; // ~$1.5M * 15% net + $150K salary + $10K perks
  y = drawTable('', s1Headers, [
    { '': 'Mid-range', 'Multiple': '4.5x SDE', 'Valuation (CAD)': '$1,890,000' },
    { '': 'Optimistic (strategic buyer)', 'Multiple': '5.5x SDE', 'Valuation (CAD)': '$2,310,000' },
    { '': 'Target Range', 'Multiple': '4.5-5.5x', 'Valuation (CAD)': '$1.9M — $2.3M', _bold: true },
  ], y, s1Cw);
  y += 5;

  doc.font('Helvetica').fontSize(8.5).fill(colors.light)
    .text('Assumptions: Revenue hits $1.5M, recurring subscription revenue established, wholesale channel growing, 2+ years of $1M+ revenue, owner at 10-12 hrs/week.', 55, y, { width: 490 });
  y += 30;

  // --- Multiple Drivers ---
  y = sectionHeading('What Drives the Multiple', y);
  const driverHeaders = ['Factor', 'Impact', 'Status'];
  const driverCw = [220, 80, 160];
  y = drawTable('', driverHeaders, [
    { 'Factor': 'Owner works <15 hrs/week', 'Impact': '+0.5-1.0x', 'Status': 'In progress (target: end 2026)' },
    { 'Factor': 'AI-automated customer service', 'Impact': '+0.5x', 'Status': 'Building (exchange advisor 95% accurate)' },
    { 'Factor': 'Automated operations (syncs, reports)', 'Impact': '+0.25-0.5x', 'Status': 'Done (9 daily pipelines)' },
    { 'Factor': 'Revenue > $1M', 'Impact': '+0.5x', 'Status': 'Projected 2026' },
    { 'Factor': 'Recurring revenue (subscription)', 'Impact': '+0.5-1.0x', 'Status': 'Not started' },
    { 'Factor': 'Diversified channels (wholesale)', 'Impact': '+0.25x', 'Status': 'Early stage' },
    { 'Factor': '3+ year growth track record', 'Impact': '+0.25x', 'Status': 'On track (2024-2026)' },
    { 'Factor': 'Niche / small buyer pool', 'Impact': '-0.5x', 'Status': 'Structural — mitigate with scale' },
  ], y, driverCw);

  // =========================================================================
  // PAGE 3 — AI Automation Value + Recommendations
  // =========================================================================
  doc.addPage();
  y = 50;

  y = sectionHeading('AI Automation — Enterprise Value Impact', y);
  y = bulletList([
    '**CS Exchange Advisor** — Deterministic decision tree + AI parser handles sizing, exchanges, donations. 95% action accuracy validated on 198 conversations. Saves 5-8 hrs/week of owner CS time.',
    '**Financial Analysis** — QBO syncs daily to Supabase. Margin reports, transaction analysis, and expense classification generated on demand. No manual bookkeeping review needed.',
    '**Daily Operations** — 9 automated pipelines (SEO, email, reviews, products, inventory, orders, customers, conversations, finance) run unattended with consolidated status emails.',
    '**Product Catalog** — Shopify-to-Supabase sync with fuzzy search, size normalization across two sizing systems, wholesale pricing automation.',
    '**Knowledge Base** — 63 embedded articles, semantic search across 3,500+ past conversations, FAQ pattern matching. New owner can answer any CS question without tribal knowledge.',
  ], y, { fontSize: 9 });
  y += 10;

  // --- Owner hours breakdown ---
  y = sectionHeading('Owner Time Breakdown — Current vs Projected', y);
  const hoursHeaders = ['Activity', 'Current (hrs/wk)', 'With AI (hrs/wk)', 'Savings'];
  const hoursCw = [180, 90, 90, 100];
  y = drawTable('', hoursHeaders, [
    { 'Activity': 'Customer Service', 'Current (hrs/wk)': '8-10', 'With AI (hrs/wk)': '2-3', 'Savings': '6-7 hrs' },
    { 'Activity': 'Financial Review', 'Current (hrs/wk)': '3-4', 'With AI (hrs/wk)': '1', 'Savings': '2-3 hrs' },
    { 'Activity': 'Order Management', 'Current (hrs/wk)': '3-4', 'With AI (hrs/wk)': '1-2', 'Savings': '2 hrs' },
    { 'Activity': 'Marketing / Content', 'Current (hrs/wk)': '4-5', 'With AI (hrs/wk)': '3-4', 'Savings': '1 hr' },
    { 'Activity': 'Product Dev / Sourcing', 'Current (hrs/wk)': '3-4', 'With AI (hrs/wk)': '3-4', 'Savings': '0' },
    { 'Activity': 'Operations / Admin', 'Current (hrs/wk)': '2-3', 'With AI (hrs/wk)': '1', 'Savings': '1-2 hrs' },
    { 'Activity': 'Total', 'Current (hrs/wk)': '23-30', 'With AI (hrs/wk)': '12-15', 'Savings': '12-15 hrs', _bold: true },
  ], y, hoursCw);
  y += 10;

  // --- Recommendations ---
  y = sectionHeading('Recommendations to Maximize Valuation', y);
  y = bulletList([
    '**Complete CS AI advisor (H1 2026)** — Biggest single lever. Each hour removed from owner workload directly increases the multiple. Target: fully autonomous exchange handling.',
    '**Cross $1M revenue (2026)** — Psychological threshold for buyers. Pricing strategy already projects $1.1-1.3M. This alone moves the multiple up 0.5x.',
    '**Document everything** — SOPs for supplier relationships, seasonal ordering cadence, marketing calendar. A buyer needs to see they can step in with minimal ramp.',
    '**Explore subscription model** — Even a small subscription cohort (underwear replenishment, seasonal drops) adds recurring revenue which commands premium multiples.',
    '**Build wholesale channel** — Diversifies revenue beyond DTC. Even 10-15% wholesale revenue reduces single-channel risk premium.',
    '**Two full years at $1M+** — If you can show 2026 and 2027 both above $1M with growing margins, the track record alone justifies 4-5x.',
    '**Consider timing** — The gender-affirming market is growing. Strategic buyers (larger underwear brands, LGBTQ+ focused companies) may pay a premium for market entry.',
  ], y, { fontSize: 9 });

  // =========================================================================
  // PAGE 4 — Valuation Summary
  // =========================================================================
  doc.addPage();
  y = 50;

  y = sectionHeading('Valuation Summary', y);
  y += 5;

  const sumHeaders = ['Scenario', 'Timeline', 'Owner Hrs/Wk', 'Revenue', 'SDE', 'Multiple', 'Valuation'];
  const sumCw = [100, 65, 65, 70, 65, 55, 95];
  y = drawTable('', sumHeaders, [
    { 'Scenario': 'Today (as-is)', 'Timeline': 'Now', 'Owner Hrs/Wk': '20-25', 'Revenue': '$898K', 'SDE': '$308K', 'Multiple': '2.5-3.0x', 'Valuation': '$770K-$924K' },
    { 'Scenario': 'AI Automated', 'Timeline': 'End 2026', 'Owner Hrs/Wk': '12-15', 'Revenue': '$1.2M', 'SDE': '$340K', 'Multiple': '4.0-4.5x', 'Valuation': '$1.36M-$1.53M', _highlight: true },
    { 'Scenario': 'Stretch', 'Timeline': '2027', 'Owner Hrs/Wk': '10-12', 'Revenue': '$1.5M', 'SDE': '$420K', 'Multiple': '4.5-5.5x', 'Valuation': '$1.9M-$2.3M' },
  ], y, sumCw);
  y += 15;

  // Key insight box
  doc.roundedRect(50, y, 510, 70, 5).fill('#F5F0F2');
  doc.font('Helvetica-Bold').fontSize(10).fill(colors.brand).text('Key Insight', 65, y + 10);
  doc.font('Helvetica').fontSize(9).fill(colors.dark)
    .text('The AI automation work currently in progress (CS advisor, financial analysis, daily syncs) is not just an operational improvement — it is directly building $400K-$600K of enterprise value by transforming a 25hr/week owner-operated business into a 12-15hr/week semi-passive asset. Every hour removed from the owner\'s week increases the exit multiple.', 65, y + 25, { width: 480 });
  y += 90;

  // Methodology note
  y = sectionHeading('Methodology & Disclaimers', y);
  doc.font('Helvetica').fontSize(8).fill(colors.light);
  const disclaimers = [
    'Valuations based on SDE (Seller\'s Discretionary Earnings) multiples, the standard methodology for small businesses with <$5M revenue.',
    'Multiples benchmarked against DTC e-commerce brand transactions in the $500K-$2M revenue range (sources: Empire Flippers, FE International, Quiet Light).',
    'Revenue multiple cross-checks applied (1.0-2.5x for DTC brands at this scale).',
    'All figures in Canadian Dollars (CAD). Financial data sourced from QuickBooks Online via automated Supabase sync.',
    'This is an internal planning document, not a formal business appraisal. A certified business valuator (CBV) should be engaged for any transaction.',
    'Projected figures assume continuation of current growth trends, margin stability, and successful completion of AI automation roadmap.',
  ];
  disclaimers.forEach(d => {
    doc.text(`\u2022  ${d}`, 55, y, { width: 500 });
    y += doc.heightOfString(`\u2022  ${d}`, { width: 500 }) + 2;
  });

  doc.end();
  return new Promise(resolve => stream.on('finish', resolve));
}

async function main() {
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `RUBIES-Valuation-Report_${timestamp}.pdf`;

  const projectPath = path.join(REPORTS_DIR, filename);
  const downloadsPath = path.join('/Users/jamiealexander/Downloads', filename);

  await generateValuationReport({}, projectPath);
  fs.copyFileSync(projectPath, downloadsPath);

  console.log(`Report saved to:`);
  console.log(`  Project: ${projectPath}`);
  console.log(`  Downloads: ${downloadsPath}`);
}

main().catch(console.error);
