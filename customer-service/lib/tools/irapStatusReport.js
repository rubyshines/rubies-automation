/**
 * MCP Tool: irap_status_report
 *
 * Generates the NRC-IRAP monthly status report from the month's actual git
 * history. Thin wrapper over finance/lib/irapStatusReport.js — all logic
 * (period resolution, git scan, Opus synthesis, prior-report continuity,
 * claim derivation, PDF render, archive) lives there.
 *
 * Note: scans local repo checkouts and writes the PDF to a local path, so
 * this tool is only meaningful on a machine with the RUBIES repos present
 * (Jamie's workstation), not on the Railway deployment.
 */
const { generateStatusReport } = require('../../../finance/lib/irapStatusReport');

async function handleIrapStatusReport(args) {
  const { month, claim, notes, delayed, variations, out_path } = args || {};
  if (!month) {
    return { content: [{ type: 'text', text: 'month is required (e.g. "July", "2026-07").' }] };
  }
  const result = await generateStatusReport({
    period: month,
    claimNumber: claim,
    notes: notes || null,
    delayExplanation: delayed,
    variations,
    outPath: out_path,
  });

  const lines = [
    `## IRAP Status Report — ${result.period.label}`,
    '',
    `**Claim:** ${result.claimNumber} | **Period:** ${result.period.fromStr} to ${result.period.toStr}`,
    `**Evidence:** ${result.commitCount} commits scanned; ${result.priorCount} prior report(s) fed in for continuity`,
    `**PDF:** ${result.outPath}`,
    `**Archive:** ${result.archivePath}`,
    '',
    ...result.sections.map((s) => `- ${s.heading} (${s.bullets.length} bullets)`),
    '',
    'Review the PDF before submitting to NRC, especially any specific figures.',
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

module.exports = [
  {
    name: 'irap_status_report',
    description: 'Generate the NRC-IRAP monthly status report PDF from the month\'s actual repo history (project 1044596). Auto-derives the claim number from the report archive and keeps continuity with prior reports. Use when Jamie asks for the IRAP report for a month. Pass measured metrics via notes when available — the report cites provided figures only.',
    inputSchema: {
      type: 'object',
      properties: {
        month: {
          type: 'string',
          description: 'Reporting month: "June", "July 2026", or "2026-07"',
        },
        claim: {
          type: 'string',
          description: 'Claim number override. Omit to auto-derive (reuses the month\'s archived claim on regenerate, else max prior claim + 1).',
        },
        notes: {
          type: 'string',
          description: 'Operator notes for the period: measured metrics, calls with the ITA, work git cannot see. Metrics given here are cited exactly in the report.',
        },
        delayed: {
          type: 'string',
          description: 'If the project is off-schedule this period, the explanation for the delay. Omit when on schedule.',
        },
        variations: {
          type: 'string',
          description: 'Variations from objectives/work plan/budget. Defaults to "There have been no variations."',
        },
        out_path: {
          type: 'string',
          description: 'Output path. Defaults to ~/Downloads/IRAP Status Report - <period>.pdf; a .html path writes Google-Docs-pastable HTML instead.',
        },
      },
      required: ['month'],
    },
    handler: handleIrapStatusReport,
  },
];
