#!/usr/bin/env node
/**
 * Generate an NRC-IRAP monthly status report from actual repo activity.
 *
 * Usage:
 *   node finance/generate-irap-status-report.js <month> [options]
 *
 *   <month>              "June", "June 2026", or "2026-06"
 *   --claim <n>          claim number for the report header
 *   --notes <file>       operator notes to include alongside git history
 *   --baseline           include the "starting point" section (automatic for
 *                        the project's first month, per config projectStart)
 *   --delayed "<why>"    mark project off-schedule with this explanation
 *   --completion "<date>"  override forecasted completion date
 *   --variations "<txt>" override the variations section (default: none)
 *   --date "<date>"      prepared-by date (default: today, ET)
 *   --out <path>         output path (default: ~/Downloads/IRAP Status Report - <period>.pdf;
 *                        a .html path writes Google-Docs-pastable HTML instead)
 *
 * Output is a PDF matching the NRC status report template. Every generated
 * report is archived to finance/irap-reports/<YYYY-MM>.json and fed into
 * later months' synthesis so the reports form one continuous narrative.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { generateStatusReport } = require('./lib/irapStatusReport');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
      else args[a.slice(2)] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const period = args._.join(' ');
  if (!period) {
    console.error('Usage: node finance/generate-irap-status-report.js <month> [--claim N] [--notes file] [--delayed "why"] [--out path]');
    process.exit(1);
  }
  const notes = args.notes ? require('fs').readFileSync(args.notes, 'utf8') : null;

  const result = await generateStatusReport({
    period,
    claimNumber: args.claim,
    baseline: args.baseline === true,
    notes,
    delayExplanation: args.delayed,
    completionDate: args.completion,
    variations: args.variations,
    preparedDate: args.date,
    outPath: args.out,
  });

  console.log(`Period:   ${result.period.fromStr} to ${result.period.toStr}`);
  console.log(`Commits:  ${result.commitCount} scanned across repos`);
  console.log(`Context:  ${result.priorCount} prior report(s) fed into synthesis`);
  console.log(`Sections: ${result.sections.map((s) => s.heading).join(' | ')}`);
  console.log(`Archive:  ${result.archivePath}`);
  console.log(`Report:   ${result.outPath}`);
})().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
