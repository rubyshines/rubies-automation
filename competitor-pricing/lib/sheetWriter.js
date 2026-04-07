const { getSheetsClient } = require('../../shared/googleSheetsClient');

const SHEET_ID = '1JHry_C9qCUrBlXQdUOqnC34gDPgcfSDCw0LtfKyhN5U';

async function writeToSheet({ date, results, rubiesProducts, competitors, priceChanges }) {
  const sheets = await getSheetsClient();
  const tabName = date;

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tabInfo = spreadsheet.data.sheets.find(
    (s) => s.properties && s.properties.title === tabName,
  );
  if (!tabInfo) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      },
    });
  }

  const rows = [];
  const boldRows = []; // track which rows should be bold

  // Header
  rows.push(['', 'Product', 'Price (USD)', 'Diff $', 'Diff %']);
  boldRows.push(rows.length - 1);

  const categories = [
    { key: 'underwear', label: 'Underwear' },
    { key: 'swim_bottom', label: 'Swim Bottom' },
    { key: 'swim_top', label: 'Swim / Bikini Top' },
    { key: 'swimsuit', label: 'One-Piece Swimsuit' },
    { key: 'bra', label: 'Bra' },
    { key: 'bra_seamless', label: 'Seamless Bra' },
  ];

  const allCategoryAvgs = [];

  for (const cat of categories) {
    const rubies = rubiesProducts.find((p) => p.category === cat.key);
    if (!rubies) continue;

    const catResults = results.filter(
      (r) => r.category === cat.key && !r.scrapeError && r.priceUsd,
    );

    // Calculate avg
    let diffDollar = '';
    let diffPct = '';
    if (catResults.length > 0) {
      const avgComp = catResults.reduce((s, r) => s + r.priceUsd, 0) / catResults.length;
      const diff = Math.round(rubies.priceUsd - avgComp);
      const pct = Math.round(((rubies.priceUsd - avgComp) / avgComp) * 100);
      diffDollar = `${diff > 0 ? '+' : '-'}$${Math.abs(diff)}`;
      diffPct = `${pct > 0 ? '+' : ''}${pct}%`;
      allCategoryAvgs.push({ label: cat.label, rubies: rubies.priceUsd, avg: Math.round(avgComp), diff, pct });
    }

    // RUBIES row (bold)
    rows.push([cat.label, hyperlink(rubies.url, `RUBIES ${rubies.name}`), `$${rubies.priceUsd}`, diffDollar, diffPct]);
    boldRows.push(rows.length - 1);

    // Competitor rows
    for (const r of catResults) {
      const diff = Math.round(r.priceUsd - rubies.priceUsd);
      const pct = Math.round(((r.priceUsd - rubies.priceUsd) / rubies.priceUsd) * 100);
      rows.push([
        '',
        hyperlink(r.productUrl, `${r.competitor} - ${r.productName}`),
        `$${Math.round(r.priceUsd)}`,
        diff === 0 ? 0 : diff,
        pct === 0 ? '0%' : `${pct}%`,
      ]);
    }

    rows.push([]);
  }

  // Summary
  const summaryStartRow = rows.length;
  rows.push(['SUMMARY', '', '', '', '']);
  boldRows.push(rows.length - 1);
  rows.push(['Category', 'RUBIES', 'Avg Competitor', 'Diff $', 'Diff %']);
  boldRows.push(rows.length - 1);

  for (const ca of allCategoryAvgs) {
    rows.push([
      ca.label,
      `$${ca.rubies}`,
      `$${ca.avg}`,
      `${ca.diff > 0 ? '+' : '-'}$${Math.abs(ca.diff)}`,
      `${ca.pct > 0 ? '+' : ''}${ca.pct}%`,
    ]);
  }

  if (allCategoryAvgs.length > 0) {
    const avgR = Math.round(allCategoryAvgs.reduce((s, c) => s + c.rubies, 0) / allCategoryAvgs.length);
    const avgC = Math.round(allCategoryAvgs.reduce((s, c) => s + c.avg, 0) / allCategoryAvgs.length);
    const diff = avgR - avgC;
    const pct = avgC ? Math.round((diff / avgC) * 100) : 0;
    rows.push([
      'OVERALL',
      `$${avgR}`,
      `$${avgC}`,
      `${diff > 0 ? '+' : '-'}$${Math.abs(diff)}`,
      `${pct > 0 ? '+' : ''}${pct}%`,
    ]);
    boldRows.push(rows.length - 1);
  }

  // Price changes
  if (priceChanges && priceChanges.length > 0) {
    rows.push([]);
    rows.push(['PRICE CHANGES vs Last Month', '', '', '', '']);
    boldRows.push(rows.length - 1);
    rows.push(['Competitor', 'Product', 'Was', 'Now', 'Change']);
    boldRows.push(rows.length - 1);
    for (const c of priceChanges) {
      const delta = Math.round(c.currentPrice - c.previousPrice);
      rows.push([c.competitor, c.productName, `$${Math.round(c.previousPrice)}`, `$${Math.round(c.currentPrice)}`, `${delta > 0 ? '+' : '-'}$${Math.abs(delta)}`]);
    }
  }

  // Write data
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!A1:Z9999`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  // Apply bold formatting
  const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tab = sheetMeta.data.sheets.find((s) => s.properties.title === tabName);
  const sheetTabId = tab.properties.sheetId;

  const formatRequests = boldRows.map((rowIdx) => ({
    repeatCell: {
      range: { sheetId: sheetTabId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: 0, endColumnIndex: 5 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  }));

  // Right-align columns C, D, E (price and diff columns)
  formatRequests.push({
    repeatCell: {
      range: { sheetId: sheetTabId, startRowIndex: 0, endRowIndex: rows.length, startColumnIndex: 2, endColumnIndex: 5 },
      cell: { userEnteredFormat: { horizontalAlignment: 'RIGHT' } },
      fields: 'userEnteredFormat.horizontalAlignment',
    },
  });

  if (formatRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: formatRequests },
    });
  }

  console.log(`  Sheet tab "${tabName}" written with ${rows.length} rows`);
}

function hyperlink(url, text) {
  if (!url || !text) return text || '';
  const safeUrl = url.replace(/"/g, '%22');
  const safeText = String(text).replace(/"/g, '""');
  return `=HYPERLINK("${safeUrl}","${safeText}")`;
}

module.exports = { writeToSheet, SHEET_ID };
