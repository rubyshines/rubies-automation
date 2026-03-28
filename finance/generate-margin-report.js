#!/usr/bin/env node
/**
 * RUBIES Finance — Margin Analysis Report Generator
 * Generates a PDF report of gross/net margin analysis with raw and adjusted views.
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, 'reports');

function generateMarginReport(data, outputPath) {
  if (!fs.existsSync(path.dirname(outputPath))) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  }

  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 50, bottom: 50, left: 50, right: 50 } });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const colors = {
    brand: '#8B1A4A',    // RUBIES maroon
    dark: '#1a1a1a',
    medium: '#444444',
    light: '#666666',
    accent: '#2E7D32',
    negative: '#C62828',
    headerBg: '#F5F0F2',
    rowAlt: '#FAFAFA',
    line: '#D0D0D0',
  };

  // --- Header ---
  doc.rect(0, 0, doc.page.width, 90).fill(colors.brand);
  doc.fill('#FFFFFF')
    .fontSize(24).font('Helvetica-Bold')
    .text('RUBIES', 50, 25, { continued: true })
    .font('Helvetica').text('  Margin Analysis Report');
  doc.fontSize(11).text(`Generated: ${new Date().toLocaleDateString('en-CA')}  |  Period: ${data.years.join(' vs ')}`, 50, 58);
  doc.fill(colors.dark);

  let y = 110;

  // --- Executive Summary ---
  doc.font('Helvetica-Bold').fontSize(14).fill(colors.brand).text('Executive Summary', 50, y);
  y += 22;
  doc.font('Helvetica').fontSize(10).fill(colors.dark);
  data.summary.forEach(line => {
    doc.text(`\u2022  ${line}`, 55, y, { width: 500 });
    y += doc.heightOfString(`\u2022  ${line}`, { width: 500 }) + 4;
  });
  y += 12;

  // --- Table helper ---
  function drawTable(title, headers, rows, startY, colWidths) {
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
    const x0 = 50;

    doc.font('Helvetica-Bold').fontSize(12).fill(colors.brand).text(title, x0, startY);
    startY += 20;

    // Header row
    doc.rect(x0, startY, tableWidth, 20).fill(colors.brand);
    doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(8.5);
    let cx = x0;
    headers.forEach((h, i) => {
      const align = i === 0 ? 'left' : 'right';
      const pad = i === 0 ? 5 : 0;
      doc.text(h, cx + pad, startY + 5, { width: colWidths[i] - (i === 0 ? 5 : 8), align });
      cx += colWidths[i];
    });
    startY += 20;

    // Data rows
    doc.font('Helvetica').fontSize(8.5);
    rows.forEach((row, ri) => {
      const isBold = row._bold;
      const rowH = 18;

      if (ri % 2 === 1) {
        doc.rect(x0, startY, tableWidth, rowH).fill(colors.rowAlt);
      }
      if (isBold) {
        doc.rect(x0, startY, tableWidth, rowH).fill(colors.headerBg);
      }

      doc.fill(colors.dark).font(isBold ? 'Helvetica-Bold' : 'Helvetica');
      cx = x0;
      headers.forEach((h, i) => {
        const val = row[h] || '';
        const align = i === 0 ? 'left' : 'right';
        const pad = i === 0 ? 5 : 0;
        // Color negative changes red, positive green
        if (typeof val === 'string' && val.startsWith('-') && i === headers.length - 1) {
          doc.fill(colors.negative);
        } else if (typeof val === 'string' && val.startsWith('+') && i === headers.length - 1) {
          doc.fill(colors.accent);
        } else {
          doc.fill(colors.dark);
        }
        doc.text(val, cx + pad, startY + 5, { width: colWidths[i] - (i === 0 ? 5 : 8), align });
        cx += colWidths[i];
      });
      startY += rowH;
    });

    // Bottom border
    doc.moveTo(x0, startY).lineTo(x0 + tableWidth, startY).stroke(colors.line);
    return startY + 10;
  }

  // --- Main P&L Table ---
  const mainHeaders = ['', 'Raw 2024', 'Raw 2025', 'Ex-One-Time 2024', 'Ex-One-Time 2025', 'Full Adj 2024', 'Full Adj 2025'];
  const cw = [95, 68, 68, 85, 85, 75, 75];
  y = drawTable('Profit & Loss Comparison', mainHeaders, data.pnlRows, y, cw);

  // --- Margin Summary Table ---
  y += 5;
  const marginHeaders = ['Metric', 'Raw 2024', 'Raw 2025', 'Ex-One-Time 2024', 'Ex-One-Time 2025', 'Full Adj 2024', 'Full Adj 2025'];
  y = drawTable('Margin Summary', marginHeaders, data.marginRows, y, cw);

  // --- Exclusions + Benchmarks on page 2 ---
  doc.addPage();
  y = 50;

  doc.font('Helvetica-Bold').fontSize(12).fill(colors.brand).text('Exclusions Applied', 50, y);
  y += 22;

  data.exclusions.forEach(section => {
    doc.font('Helvetica-Bold').fontSize(10).fill(colors.medium).text(section.title, 55, y);
    y += 16;
    doc.font('Helvetica').fontSize(9).fill(colors.dark);
    section.items.forEach(item => {
      doc.text(`\u2022  ${item}`, 60, y, { width: 490 });
      y += doc.heightOfString(`\u2022  ${item}`, { width: 490 }) + 3;
    });
    y += 10;
  });

  // --- Benchmarks ---
  y += 10;
  doc.font('Helvetica-Bold').fontSize(12).fill(colors.brand).text('Industry Benchmarks (DTC Apparel)', 50, y);
  y += 20;
  const benchHeaders = ['Range', 'Gross Margin', 'Net Margin'];
  const benchCw = [120, 200, 200];
  y = drawTable('', benchHeaders, data.benchmarks, y, benchCw);

  doc.end();
  return new Promise(resolve => stream.on('finish', resolve));
}

// --- Report Data ---
const reportData = {
  years: ['2024', '2025'],
  summary: [
    'Revenue grew 27.8% year-over-year ($702K to $898K, excluding 2024 IRAP grant)',
    'Raw gross margin declined 6.6 pts (70.9% to 64.3%), but adjusted gross margin improved 3.6 pts (69.0% to 72.6%) after removing one-time fulfillment move costs and Ditso misclassification',
    'Adjusted net margin improved from 5.8% (ex-IRAP) to 16.6%, reflecting strong operating leverage',
    'Fully adjusted net margin (excluding one-time projects in both years) reached 21.1% in 2025 vs 10.3% in 2024',
    'Caution: "fully adjusted" excludes ~$100K of real 2025 spend. Ex-One-Time view (16.6% net margin) is the most defensible baseline',
  ],
  pnlRows: [
    { '': 'Total Income', 'Raw 2024': '$749,646', 'Raw 2025': '$897,515', 'Ex-One-Time 2024': '$702,151', 'Ex-One-Time 2025': '$897,515', 'Full Adj 2024': '$702,151', 'Full Adj 2025': '$897,515' },
    { '': 'COGS', 'Raw 2024': '($217,935)', 'Raw 2025': '($320,040)', 'Ex-One-Time 2024': '($217,935)', 'Ex-One-Time 2025': '($246,304)', 'Full Adj 2024': '($217,935)', 'Full Adj 2025': '($246,304)' },
    { '': 'Gross Profit', 'Raw 2024': '$531,712', 'Raw 2025': '$577,475', 'Ex-One-Time 2024': '$484,216', 'Ex-One-Time 2025': '$651,211', 'Full Adj 2024': '$484,216', 'Full Adj 2025': '$651,211', _bold: true },
    { '': 'Gross Margin', 'Raw 2024': '70.9%', 'Raw 2025': '64.3%', 'Ex-One-Time 2024': '69.0%', 'Ex-One-Time 2025': '72.6%', 'Full Adj 2024': '69.0%', 'Full Adj 2025': '72.6%', _bold: true },
    { '': '', 'Raw 2024': '', 'Raw 2025': '', 'Ex-One-Time 2024': '', 'Ex-One-Time 2025': '', 'Full Adj 2024': '', 'Full Adj 2025': '' },
    { '': 'Operating Expenses', 'Raw 2024': '($429,124)', 'Raw 2025': '($501,561)', 'Ex-One-Time 2024': '($429,124)', 'Ex-One-Time 2025': '($501,561)', 'Full Adj 2024': '($397,590)', 'Full Adj 2025': '($460,119)' },
    { '': 'Other Expenses', 'Raw 2024': '($14,159)', 'Raw 2025': '($1,451)', 'Ex-One-Time 2024': '($14,159)', 'Ex-One-Time 2025': '($1,451)', 'Full Adj 2024': '($14,159)', 'Full Adj 2025': '($1,451)' },
    { '': 'Net Profit', 'Raw 2024': '$136,156', 'Raw 2025': '$74,464', 'Ex-One-Time 2024': '$40,933', 'Ex-One-Time 2025': '$149,200', 'Full Adj 2024': '$72,467', 'Full Adj 2025': '$189,642', _bold: true },
    { '': 'Net Margin', 'Raw 2024': '18.2%', 'Raw 2025': '8.3%', 'Ex-One-Time 2024': '5.8%', 'Ex-One-Time 2025': '16.6%', 'Full Adj 2024': '10.3%', 'Full Adj 2025': '21.1%', _bold: true },
  ],
  marginRows: [
    { 'Metric': 'Gross Margin', 'Raw 2024': '70.9%', 'Raw 2025': '64.3%', 'Ex-One-Time 2024': '69.0%', 'Ex-One-Time 2025': '72.6%', 'Full Adj 2024': '69.0%', 'Full Adj 2025': '72.6%', _bold: true },
    { 'Metric': 'Net Margin', 'Raw 2024': '18.2%', 'Raw 2025': '8.3%', 'Ex-One-Time 2024': '5.8%', 'Ex-One-Time 2025': '16.6%', 'Full Adj 2024': '10.3%', 'Full Adj 2025': '21.1%', _bold: true },
    { 'Metric': 'Net Profit', 'Raw 2024': '$136,156', 'Raw 2025': '$74,464', 'Ex-One-Time 2024': '$40,933', 'Ex-One-Time 2025': '$149,200', 'Full Adj 2024': '$72,467', 'Full Adj 2025': '$189,642', _bold: true },
  ],
  exclusions: [
    {
      title: 'Ex-One-Time View (defensible baseline)',
      items: [
        '2024: Remove $47,495 IRAP government grant from income (not operating revenue)',
        '2025: Remove $37,283 CAD Inversiones Ditso from COGS (related-party payment, likely misclassified — needs accountant review)',
        '2025: Remove $36,453 CAD UPS fulfillment move duties from COGS (one-time Hamilton-to-US move)',
      ]
    },
    {
      title: 'Full Adjusted View (also removes one-time projects)',
      items: [
        '2024: Remove $26,035 one-time marketing consultants (Shih Liu, Bari Axmith, Inna Gertsberg, Aldeen, Natta Ierkhova)',
        '2024: Remove $5,499 Upwork custom dev project',
        '2025: Remove $11,824 legal fees (estate freeze — one-time)',
        '2025: Remove $9,500 Barrco shipping (fulfillment move related)',
        '2025: Remove $4,343 Andrii Ribert website development',
        '2025: Remove $3,951 Upwork custom dev project',
      ]
    },
  ],
  benchmarks: [
    { 'Range': 'Average', 'Gross Margin': '50-60% (wholesale-heavy)', 'Net Margin': '0-5% (early/growth stage)' },
    { 'Range': 'Good', 'Gross Margin': '60-70% (standard DTC)', 'Net Margin': '5-10% (established small DTC)' },
    { 'Range': 'Very Good', 'Gross Margin': '70-80% (strong DTC)', 'Net Margin': '10-15% (solid profitability)' },
    { 'Range': 'Excellent', 'Gross Margin': '80%+ (rare/luxury)', 'Net Margin': '15-20%+ (exceptional efficiency)' },
    { 'Range': 'RUBIES (Ex-One-Time)', 'Gross Margin': '72.6% — Very Good', 'Net Margin': '16.6% — Excellent', _bold: true },
  ],
};

async function main() {
  const timestamp = new Date().toISOString().slice(0, 10);
  const filename = `RUBIES-Margin-Analysis-2024-2025_${timestamp}.pdf`;

  // Save to finance/reports/ in the project
  const projectPath = path.join(REPORTS_DIR, filename);
  // Also save to Downloads for easy access
  const downloadsPath = path.join('/Users/jamiealexander/Downloads', filename);

  await generateMarginReport(reportData, projectPath);
  fs.copyFileSync(projectPath, downloadsPath);

  console.log(`Report saved to:`);
  console.log(`  Project: ${projectPath}`);
  console.log(`  Downloads: ${downloadsPath}`);
}

main().catch(console.error);
