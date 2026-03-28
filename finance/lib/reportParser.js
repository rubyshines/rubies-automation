/**
 * QBO Report Parser
 *
 * QuickBooks report JSON uses a deeply nested Rows/ColData structure.
 * This module flattens it into usable rows + summary objects.
 *
 * Usage:
 *   const { parseReport, parseProfitAndLoss } = require('./reportParser');
 *   const parsed = parseReport(rawReportJson);
 *   // => { header, columns, rows: [{ name, values, children }], summary }
 */

// ---------------------------------------------------------------------------
// Generic report parser
// ---------------------------------------------------------------------------

function parseReport(reportJson) {
  if (!reportJson) return { header: {}, columns: [], rows: [], summary: {} };

  const header = {
    reportName: reportJson.Header?.ReportName || '',
    startPeriod: reportJson.Header?.StartPeriod || '',
    endPeriod: reportJson.Header?.EndPeriod || '',
    currency: reportJson.Header?.Currency || 'USD',
    accountingMethod: reportJson.Header?.Option?.find(o => o.Name === 'AccountingMethod')?.Value || 'Accrual',
  };

  const columns = (reportJson.Columns?.Column || []).map(c => ({
    label: c.ColTitle || '',
    type: c.ColType || '',
  }));

  const rows = parseRows(reportJson.Rows?.Row || []);

  const summary = extractSummary(rows, header.reportName);

  return { header, columns, rows, summary };
}

// ---------------------------------------------------------------------------
// Row parsing (recursive — handles sections + sub-sections)
// ---------------------------------------------------------------------------

function parseRows(rowArray) {
  const result = [];

  for (const row of rowArray) {
    if (row.type === 'Section') {
      const section = {
        name: row.Header?.ColData?.[0]?.value || '',
        type: 'section',
        values: (row.Header?.ColData || []).slice(1).map(c => parseNumeric(c.value)),
        children: [],
        summary: null,
      };

      // Recurse into section rows
      if (row.Rows?.Row) {
        section.children = parseRows(row.Rows.Row);
      }

      // Section summary/total row
      if (row.Summary?.ColData) {
        section.summary = {
          name: row.Summary.ColData[0]?.value || '',
          values: row.Summary.ColData.slice(1).map(c => parseNumeric(c.value)),
        };
      }

      result.push(section);
    } else if (row.type === 'Data' || row.ColData) {
      const colData = row.ColData || [];
      result.push({
        name: colData[0]?.value || '',
        type: 'data',
        values: colData.slice(1).map(c => parseNumeric(c.value)),
        id: colData[0]?.id || null,
      });
    }
  }

  return result;
}

function parseNumeric(val) {
  if (val == null || val === '') return null;
  const n = parseFloat(val);
  return isNaN(n) ? val : n;
}

// ---------------------------------------------------------------------------
// Summary extraction (report-type specific)
// ---------------------------------------------------------------------------

function extractSummary(rows, reportName) {
  const summary = {};
  const name = (reportName || '').toLowerCase();

  if (name.includes('profit') || name.includes('loss') || name.includes('income')) {
    summary.type = 'ProfitAndLoss';
    extractPLSummary(rows, summary);
  } else if (name.includes('balance')) {
    summary.type = 'BalanceSheet';
    extractBSSummary(rows, summary);
  } else if (name.includes('cash')) {
    summary.type = 'CashFlow';
    extractCFSummary(rows, summary);
  }

  return summary;
}

function extractPLSummary(rows, summary) {
  for (const row of rows) {
    const sectionName = (row.name || '').toLowerCase();

    if (sectionName.includes('income') && !sectionName.includes('other') && !sectionName.includes('net') && !sectionName.includes('cost')) {
      if (row.summary) summary.totalIncome = row.summary.values[0];
    }
    if (sectionName.includes('cost of goods') || sectionName.includes('cogs')) {
      if (row.summary) summary.costOfGoodsSold = row.summary.values[0];
    }
    if (sectionName.includes('gross profit')) {
      if (row.values?.[0] != null) summary.grossProfit = row.values[0];
      else if (row.summary) summary.grossProfit = row.summary.values[0];
    }
    if (sectionName.includes('expense') && !sectionName.includes('other')) {
      if (row.summary) summary.totalExpenses = row.summary.values[0];
    }
    if (sectionName.includes('other income')) {
      if (row.summary) summary.otherIncome = row.summary.values[0];
    }
    if (sectionName.includes('other expense')) {
      if (row.summary) summary.otherExpenses = row.summary.values[0];
    }
    if (sectionName.includes('net operating income')) {
      if (row.values?.[0] != null) summary.netOperatingIncome = row.values[0];
      else if (row.summary) summary.netOperatingIncome = row.summary.values[0];
    }
    if (sectionName.includes('net income') || sectionName.includes('net profit')) {
      if (row.values?.[0] != null) summary.netIncome = row.values[0];
      else if (row.summary) summary.netIncome = row.summary.values[0];
    }
  }

  // Compute gross profit if not explicitly in report
  if (summary.grossProfit == null && summary.totalIncome != null && summary.costOfGoodsSold != null) {
    summary.grossProfit = summary.totalIncome - summary.costOfGoodsSold;
  }

  // Compute margins
  if (summary.totalIncome && summary.totalIncome !== 0) {
    if (summary.grossProfit != null) {
      summary.grossMarginPct = summary.grossProfit / summary.totalIncome;
    }
    if (summary.netIncome != null) {
      summary.netMarginPct = summary.netIncome / summary.totalIncome;
    }
  }
}

function extractBSSummary(rows, summary) {
  for (const row of rows) {
    const sectionName = (row.name || '').toLowerCase();

    if (sectionName.includes('total asset')) {
      if (row.values?.[0] != null) summary.totalAssets = row.values[0];
      else if (row.summary) summary.totalAssets = row.summary.values[0];
    }
    if (sectionName.includes('total liabilit')) {
      if (row.values?.[0] != null) summary.totalLiabilities = row.values[0];
      else if (row.summary) summary.totalLiabilities = row.summary.values[0];
    }
    if (sectionName.includes('total equity') || sectionName.includes("total stockholders' equity") || sectionName.includes("total owner's equity")) {
      if (row.values?.[0] != null) summary.totalEquity = row.values[0];
      else if (row.summary) summary.totalEquity = row.summary.values[0];
    }
    if (sectionName.includes('current asset')) {
      if (row.summary) summary.currentAssets = row.summary.values[0];
    }
    if (sectionName.includes('current liabilit')) {
      if (row.summary) summary.currentLiabilities = row.summary.values[0];
    }

    // Recurse into sections
    if (row.children) {
      extractBSSummary(row.children, summary);
    }
  }

  // Current ratio
  if (summary.currentAssets != null && summary.currentLiabilities != null && summary.currentLiabilities !== 0) {
    summary.currentRatio = summary.currentAssets / summary.currentLiabilities;
  }
}

function extractCFSummary(rows, summary) {
  for (const row of rows) {
    const sectionName = (row.name || '').toLowerCase();

    if (sectionName.includes('operating')) {
      if (row.summary) summary.operatingCashFlow = row.summary.values[0];
    }
    if (sectionName.includes('investing')) {
      if (row.summary) summary.investingCashFlow = row.summary.values[0];
    }
    if (sectionName.includes('financing')) {
      if (row.summary) summary.financingCashFlow = row.summary.values[0];
    }

    // Recurse
    if (row.children) {
      extractCFSummary(row.children, summary);
    }
  }

  // Net cash change
  const ops = summary.operatingCashFlow || 0;
  const inv = summary.investingCashFlow || 0;
  const fin = summary.financingCashFlow || 0;
  if (ops || inv || fin) {
    summary.netCashChange = ops + inv + fin;
  }
}

// ---------------------------------------------------------------------------
// Helpers: extract all line items from a parsed report
// ---------------------------------------------------------------------------

function flattenRows(rows, parentName = '') {
  const result = [];
  for (const row of rows) {
    const fullName = parentName ? `${parentName} > ${row.name}` : row.name;

    if (row.type === 'data') {
      result.push({ name: row.name, fullName, values: row.values, id: row.id });
    }

    if (row.type === 'section') {
      if (row.children) {
        result.push(...flattenRows(row.children, fullName));
      }
      if (row.summary) {
        result.push({
          name: row.summary.name,
          fullName: `${fullName} > ${row.summary.name}`,
          values: row.summary.values,
          isTotal: true,
        });
      }
    }
  }
  return result;
}

function getSectionByName(rows, namePattern) {
  const pattern = namePattern.toLowerCase();
  for (const row of rows) {
    if (row.type === 'section' && (row.name || '').toLowerCase().includes(pattern)) {
      return row;
    }
  }
  return null;
}

module.exports = {
  parseReport,
  flattenRows,
  getSectionByName,
  parseNumeric,
};
