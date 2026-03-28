/**
 * MCP Tool: tax_estimate
 *
 * C-Corp quarterly/annual tax projection.
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { getQboClient } = require('../qbo');
const { parseReport } = require('../reportParser');
const { fmtCurrency, fmtPct, formatDate } = require('./helpers');

const FEDERAL_RATE = 0.21; // C-Corp flat rate

async function handleTaxEstimate({ year, method }) {
  const taxYear = year || new Date().getFullYear();
  const estimateMethod = (method || 'annualized').toLowerCase();
  const supabase = getSupabaseClient();
  const stateRate = parseFloat(process.env.STATE_TAX_RATE || '0');

  const now = new Date();
  const isCurrentYear = taxYear === now.getFullYear();
  const ytdEnd = isCurrentYear ? formatDate(now) : `${taxYear}-12-31`;

  // Get YTD P&L
  let summary;
  const { data } = await supabase
    .from('qbo_report_snapshots')
    .select('summary')
    .eq('report_type', 'ProfitAndLoss')
    .eq('period_start', `${taxYear}-01-01`)
    .eq('period_end', ytdEnd)
    .single();

  if (data?.summary) {
    summary = data.summary;
  } else {
    const qbo = getQboClient();
    const raw = await qbo.getProfitAndLoss(`${taxYear}-01-01`, ytdEnd);
    summary = parseReport(raw).summary;
  }

  const netIncome = summary?.netIncome || 0;

  // Calculate taxable income estimate
  let annualEstimate;
  if (estimateMethod === 'annualized' && isCurrentYear) {
    const dayOfYear = Math.floor((now - new Date(taxYear, 0, 1)) / 86400000) + 1;
    const annualizationFactor = 365 / dayOfYear;
    annualEstimate = netIncome * annualizationFactor;
  } else {
    annualEstimate = netIncome;
  }

  const federalTax = Math.max(0, annualEstimate * FEDERAL_RATE);
  const stateTax = Math.max(0, annualEstimate * stateRate);
  const totalTax = federalTax + stateTax;
  const effectiveRate = annualEstimate > 0 ? totalTax / annualEstimate : 0;

  // Quarterly payment schedule (C-Corp: Apr 15, Jun 15, Sep 15, Dec 15)
  const quarterlyPayment = totalTax / 4;
  const quarterDates = [
    { q: 'Q1', due: `${taxYear}-04-15`, label: 'Apr 15' },
    { q: 'Q2', due: `${taxYear}-06-15`, label: 'Jun 15' },
    { q: 'Q3', due: `${taxYear}-09-15`, label: 'Sep 15' },
    { q: 'Q4', due: `${taxYear}-12-15`, label: 'Dec 15' },
  ];

  let md = `## Tax Estimate: ${taxYear}\n\n`;

  md += '| Metric | Amount |\n';
  md += '|--------|--------|\n';
  md += `| Net Income (YTD through ${ytdEnd}) | ${fmtCurrency(netIncome)} |\n`;

  if (estimateMethod === 'annualized' && isCurrentYear) {
    md += `| Annualized Estimate | ${fmtCurrency(annualEstimate)} |\n`;
    md += `| Method | Annualized (YTD extrapolated to full year) |\n`;
  } else {
    md += `| Method | Actual (${isCurrentYear ? 'YTD' : 'full year'}) |\n`;
  }

  md += `| Federal Tax (${fmtPct(FEDERAL_RATE)}) | ${fmtCurrency(federalTax)} |\n`;
  if (stateRate > 0) {
    md += `| State Tax (${fmtPct(stateRate)}) | ${fmtCurrency(stateTax)} |\n`;
  }
  md += `| **Total Estimated Tax** | **${fmtCurrency(totalTax)}** |\n`;
  md += `| Effective Rate | ${fmtPct(effectiveRate)} |\n`;

  md += '\n### Quarterly Payment Schedule (Form 1120)\n\n';
  md += '| Quarter | Due Date | Payment | Status |\n';
  md += '|---------|----------|---------|--------|\n';

  for (const qd of quarterDates) {
    const isPast = new Date(qd.due) < now;
    const status = isPast ? 'Due' : 'Upcoming';
    md += `| ${qd.q} | ${qd.label} | ${fmtCurrency(quarterlyPayment)} | ${status} |\n`;
  }

  // Prior year comparison
  if (isCurrentYear) {
    const prevYear = taxYear - 1;
    const { data: prevData } = await supabase
      .from('qbo_report_snapshots')
      .select('summary')
      .eq('report_type', 'ProfitAndLoss')
      .eq('period_start', `${prevYear}-01-01`)
      .eq('period_end', `${prevYear}-12-31`)
      .single();

    if (prevData?.summary?.netIncome != null) {
      const prevNet = prevData.summary.netIncome;
      const prevTax = Math.max(0, prevNet * FEDERAL_RATE) + Math.max(0, prevNet * stateRate);
      md += `\n### Prior Year Comparison (${prevYear})\n\n`;
      md += `| Metric | ${prevYear} | ${taxYear} Est. |\n`;
      md += `|--------|------|------|\n`;
      md += `| Net Income | ${fmtCurrency(prevNet)} | ${fmtCurrency(annualEstimate)} |\n`;
      md += `| Total Tax | ${fmtCurrency(prevTax)} | ${fmtCurrency(totalTax)} |\n`;
    }
  }

  md += '\n*This is an estimate only, not tax advice. Consult your tax professional for actual filing. Does not account for credits, deductions, NOL carryforwards, or AMT.*';

  return { content: [{ type: 'text', text: md }] };
}

const tools = [
  {
    name: 'tax_estimate',
    description: 'Estimate C-Corp federal (and optionally state) tax liability for a given year. Shows quarterly payment schedule, annualized projections, and prior year comparison. Set STATE_TAX_RATE in .env for state taxes.',
    inputSchema: {
      type: 'object',
      properties: {
        year: {
          type: 'number',
          description: 'Tax year (default: current year)',
        },
        method: {
          type: 'string',
          description: '"annualized" (extrapolate YTD to full year, default) or "actual" (use YTD as-is)',
        },
      },
      required: [],
    },
    handler: handleTaxEstimate,
  },
];

module.exports = tools;
