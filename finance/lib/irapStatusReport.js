/**
 * NRC-IRAP monthly status report generator.
 *
 * Given a reporting month, collects the actual git activity across the RUBIES
 * repos for that period, has Opus group the project-relevant work into
 * "Key Developments" sections in the style of past submitted reports, and
 * renders a Google-Docs-pastable HTML document matching the NRC status report
 * template (header fields, timeline, firm info, activities and outcomes,
 * variations, stacking, prepared-by, objectives appendix).
 *
 * The report describes work performed IN the reporting period — the AI is
 * instructed to use only commit evidence and operator notes from that window.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');

// Archive of every generated report (sections JSON, one file per month).
// Committed to the repo: these are the firm's own submitted business records,
// and each month's synthesis reads the prior months so reports form a
// continuous narrative instead of re-reporting earlier work.
const REPORTS_DIR = path.join(__dirname, '..', 'irap-reports');

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Resolve "June", "June 2026", or "2026-06" to a reporting period.
 * A bare month name resolves to the most recent occurrence of that month
 * that has already started (June asked in July 2026 → June 2026).
 */
function resolvePeriod(input, now = new Date()) {
  const raw = String(input || '').trim().toLowerCase();
  let year;
  let monthIdx;

  const iso = raw.match(/^(\d{4})-(\d{1,2})$/);
  const named = raw.match(/^([a-z]+)(?:\s+(\d{4}))?$/);
  if (iso) {
    year = Number(iso[1]);
    monthIdx = Number(iso[2]) - 1;
  } else if (named && MONTHS.includes(named[1])) {
    monthIdx = MONTHS.indexOf(named[1]);
    year = named[2] ? Number(named[2]) : now.getFullYear();
    if (!named[2] && monthIdx > now.getMonth()) year -= 1;
  } else {
    throw new Error(`Cannot parse reporting period "${input}" — use "June", "June 2026", or "2026-06"`);
  }
  if (monthIdx < 0 || monthIdx > 11) throw new Error(`Invalid month in "${input}"`);

  const monthName = MONTHS[monthIdx][0].toUpperCase() + MONTHS[monthIdx].slice(1);
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  return {
    year,
    month: monthIdx + 1,
    label: `${monthName} ${year}`,
    fromStr: `${monthName} 1, ${year}`,
    toStr: `${monthName} ${lastDay}, ${year}`,
    sinceIso: `${year}-${String(monthIdx + 1).padStart(2, '0')}-01T00:00:00`,
    untilIso: `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}T23:59:59`,
  };
}

/** Collect non-merge commit subjects from each repo for the period. */
function collectGitActivity(repoPaths, period) {
  const results = [];
  for (const repoPath of repoPaths) {
    const dir = expandHome(repoPath);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    let out = '';
    try {
      out = execFileSync('git', [
        '-C', dir, 'log', '--no-merges',
        `--since=${period.sinceIso}`, `--until=${period.untilIso}`,
        '--date=short', '--pretty=format:%ad %s',
      ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    } catch {
      continue; // unreadable repo — skip rather than fail the report
    }
    const commits = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (commits.length) results.push({ repo: path.basename(dir), commits });
  }
  return results;
}

function formatActivityForPrompt(activity) {
  return activity
    .map((r) => `Repository: ${r.repo} (${r.commits.length} commits)\n${r.commits.join('\n')}`)
    .join('\n\n');
}

/** The baseline section belongs in the first report of the project. */
function shouldIncludeBaseline(period, projectStartIso) {
  if (!projectStartIso) return false;
  const [y, m] = projectStartIso.split('-').map(Number);
  return period.year === y && period.month === m;
}

function periodYm(period) {
  return `${period.year}-${String(period.month).padStart(2, '0')}`;
}

/** Load archived reports for months strictly before the given period. */
function loadPriorReports(period, dir = REPORTS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const ym = periodYm(period);
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f) && f.slice(0, 7) < ym)
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function saveReportArchive({ period, claimNumber, sections }, dir = REPORTS_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${periodYm(period)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    period: { label: period.label, from: period.fromStr, to: period.toStr },
    claimNumber: claimNumber || null,
    sections,
    generatedAt: new Date().toISOString(),
  }, null, 2));
  return file;
}

/**
 * Derive the claim number when the caller doesn't pass one: reuse this
 * month's archived claim on a regenerate, otherwise max prior claim + 1.
 */
function deriveClaimNumber(period, dir = REPORTS_DIR) {
  if (!fs.existsSync(dir)) return '1';
  const ym = periodYm(period);
  const own = path.join(dir, `${ym}.json`);
  if (fs.existsSync(own)) {
    const archived = JSON.parse(fs.readFileSync(own, 'utf8')).claimNumber;
    if (archived) return String(archived);
  }
  const priorClaims = loadPriorReports(period, dir)
    .map((r) => Number(r.claimNumber))
    .filter((n) => Number.isFinite(n));
  return priorClaims.length ? String(Math.max(...priorClaims) + 1) : '1';
}

function formatPriorReportsForPrompt(prior) {
  if (!prior.length) return '';
  return prior.map((r) => {
    const body = r.sections.map((s) => `${s.heading}\n${s.bullets.map((b) => `- ${b}`).join('\n')}`).join('\n');
    return `--- ${r.period.label} status report ---\n${body}`;
  }).join('\n\n');
}

/** Pull the first balanced JSON object out of a model response. */
function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in model response');
  return JSON.parse(text.slice(start, end + 1));
}

function buildSynthesisPrompt({ config, period, activityText, notes, prior = [] }) {
  const objectives = config.objectivesAppendix
    .map((o) => `${o.heading}\n${o.text}`)
    .join('\n\n');

  const system = `You write the "Activities and outcomes" section of NRC-IRAP monthly status reports for Rubies Apparel Inc. (RUBIES), based strictly on evidence of work actually performed during the reporting period.

Style, matching the firm's previously submitted reports:
- SUCCINCT: 3-4 thematic sub-headings, 2-3 bullets each, ONE sentence per bullet (about 30 words max). Whole section under roughly 300 words. Merge related commits into one bullet; drop minor work entirely rather than compressing everything in.
- Bullets are first-person plural, plain and factual: "We developed...", "We began...", "We are testing...".
- AUDIENCE: an NRC industrial technology advisor. Technically literate (understands AI models, databases, integrations at a concept level) but does NOT know this firm's internal systems or deep engineering vocabulary. Write at that middle level:
  - Name the mechanism by what it does, not by its engineering term. "an automatic fallback that switches to a simpler output format when the AI provider is overloaded", not "a load-shed circuit breaker that degrades to legacy output mode". "a retry system that recovers tickets that failed to import", not "intake dead-letter replay".
  - No internal component names, table names, or acronym strings. One named concept per bullet at most, and only if it earns its place.
  - Each bullet is concrete: what we built or tested, in plain words, and what it lets the system do. Avoid abstract phrases like "hardened workflows", "seeded relationship state", "laying groundwork".
  - Test: a reader who has never seen our codebase should understand every bullet on first read without slowing down.
- Mention remaining work and challenges honestly — reports routinely note what is unfinished or slower than expected.
- Never use em dashes. Use commas, parentheses, or short sentences.
- Every bullet must clearly read as work performed DURING the reporting period. When work extends a capability that existed at project start, name the pre-existing capability briefly so a reviewer can tell the starting point from this period's progress.

R&D framing (IRAP funds experimentation on technically uncertain outcomes):
- Each section should connect its work to the technical uncertainty it probes: what was unknown, what experiment or iteration ran this period, what was measured or learned. The report reads as R&D progress against uncertain outcomes, not a feature changelog.
- The open technical uncertainties for this project:
${(config.technicalUncertainties || []).map((u) => `  - ${u}`).join('\n')}
- When the operator notes include measured metrics, cite them exactly and relate them to the Contribution Agreement targets. NEVER invent, round, or extrapolate figures beyond what is provided.

Grounding rules (strict):
- Use ONLY the commit log and operator notes provided. Do not invent work, metrics, or outcomes that are not evidenced there.
- Include only work relevant to the project scope below (the three objectives and their shared platform infrastructure). Ignore unrelated commits (routine store operations, content edits, unrelated fixes).
- It is fine to describe several related commits as one activity, and to explain WHY a piece of work matters to an objective.

PROJECT SCOPE (from the Contribution Agreement):
${objectives}

CAPABILITIES THAT EXISTED BEFORE THE PROJECT STARTED (the project's starting point — never describe these as work performed this period; in-period work may be described as extending or hardening them):
${(config.baseline && config.baseline.bullets || []).map((b) => `- ${b}`).join('\n')}
${prior.length ? `
ALREADY REPORTED IN EARLIER STATUS REPORTS (do not re-report this work as new; where this period continues it, use continuity language such as "We continued..." or "Building on last period's...", and reference prior progress only briefly):
${formatPriorReportsForPrompt(prior)}` : ''}

Return ONLY a JSON object: {"sections": [{"heading": "...", "bullets": ["...", "..."]}]}`;

  const user = `Reporting period: ${period.fromStr} to ${period.toStr}

Commit log for the period:
${activityText || '(no commits found in this period)'}

${notes ? `Operator notes for the period (additional context from the founder):\n${notes}` : '(no operator notes provided)'}

Write the Key Developments sections for this reporting period.`;

  return { system, user };
}

async function synthesizeSections({ config, period, activity, notes, prior }) {
  const activityText = formatActivityForPrompt(activity);
  const { system, user } = buildSynthesisPrompt({ config, period, activityText, notes, prior });
  // Opus: final text a federal funder reads — customer-facing quality bar.
  const res = await callClaude({
    component: 'irap_status_report',
    model: MODELS.OPUS,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const parsed = extractJson(res.text);
  if (!Array.isArray(parsed.sections) || !parsed.sections.length) {
    throw new Error('Model returned no sections');
  }
  return parsed.sections;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const H2_STYLE = 'color:#00808b;font-size:16pt;margin:24px 0 6px;border-bottom:2px solid #1f6fb2;padding-bottom:4px;';

function renderAppendix(objectivesAppendix) {
  return objectivesAppendix.map((o) => {
    const lines = o.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const body = lines.map((l) => (
      l.startsWith('- ')
        ? `<li style="margin:2px 0;">${esc(l.slice(2))}</li>`
        : `<p style="margin:6px 0;">${esc(l)}</p>`
    ));
    // wrap consecutive <li> runs in a <ul>
    const html = [];
    let list = [];
    for (const piece of body) {
      if (piece.startsWith('<li')) { list.push(piece); continue; }
      if (list.length) { html.push(`<ul style="margin:4px 0 8px;">${list.join('')}</ul>`); list = []; }
      html.push(piece);
    }
    if (list.length) html.push(`<ul style="margin:4px 0 8px;">${list.join('')}</ul>`);
    return `<h3 style="font-size:11pt;margin:14px 0 4px;">${esc(o.heading)}</h3>${html.join('')}`;
  }).join('');
}

function renderReportHtml({ config, fields, sections }) {
  const check = (v) => (v ? 'X yes &nbsp;&nbsp; &#9744; no' : '&#9744; yes &nbsp;&nbsp; X no');
  const sectionsHtml = sections.map((s) => `
    <h3 style="font-size:11pt;margin:14px 0 4px;">${esc(s.heading)}</h3>
    <ul style="margin:4px 0 10px;">
      ${s.bullets.map((b) => `<li style="margin:3px 0;">${esc(b)}</li>`).join('\n      ')}
    </ul>`).join('\n');

  const stackingRows = Array.from({ length: 4 }, () =>
    '<tr>' + '<td style="border:1px solid #999;padding:4px;">&nbsp;</td>'.repeat(5) + '</tr>').join('');

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#111;max-width:7.5in;">
  <h1 style="color:#00808b;font-size:20pt;margin:0 0 2px;">Status Report</h1>
  <p style="font-style:italic;margin:0 0 16px;">Document for Clients</p>

  <table style="border-collapse:collapse;margin-bottom:12px;">
    <tr><td style="padding:2px 24px 2px 0;">Claim Number</td><td style="padding:2px 40px 2px 0;"><b>${esc(fields.claimNumber || '')}</b></td>
        <td style="padding:2px 24px 2px 0;">NRC IRAP Project Number</td><td><b>${esc(fields.projectNumber)}</b></td></tr>
    <tr><td style="padding:2px 24px 2px 0;">Firm name</td><td colspan="3"><b>${esc(fields.firmName)}</b></td></tr>
    <tr><td style="padding:2px 24px 2px 0;">Reporting period</td><td colspan="3"><b>From ${esc(fields.periodFrom)} To ${esc(fields.periodTo)}</b></td></tr>
  </table>

  <h2 style="${H2_STYLE}">Project timeline</h2>
  <p style="margin:6px 0;">Is the project on schedule? &nbsp;&nbsp; ${check(fields.onSchedule)}</p>
  ${fields.onSchedule ? '' : `<p style="margin:6px 0;">Explanation for delays: ${esc(fields.delayExplanation || '')}</p>`}
  <p style="margin:6px 0;">Provide a forecasted project completion date: &nbsp;${esc(fields.completionDate)}</p>

  <h2 style="${H2_STYLE}">Information on the Firm</h2>
  <p style="margin:6px 0;">Has your Firm&rsquo;s address changed since the last status report? &nbsp;&nbsp; ${check(fields.addressChanged)}</p>
  <p style="margin:6px 0;">Has your Firm&rsquo;s name changed since the last status report? &nbsp;&nbsp; ${check(fields.nameChanged)}</p>

  <h2 style="${H2_STYLE}">Activities and outcomes (minimum 2 paragraphs)</h2>
  ${fields.baseline ? `<h3 style="font-size:11pt;margin:14px 0 4px;">${esc(fields.baseline.heading)} (capabilities already in place before ${esc(fields.periodFrom)})</h3>
  <p style="margin:6px 0;">${esc(fields.baseline.intro)}</p>
  <ul style="margin:4px 0 10px;">
    ${fields.baseline.bullets.map((b) => `<li style="margin:3px 0;">${esc(b)}</li>`).join('\n    ')}
  </ul>` : ''}
  <p style="margin:6px 0;"><b>Key Developments during this reporting period (${esc(fields.periodFrom)} to ${esc(fields.periodTo)}):</b></p>
  ${sectionsHtml}

  <h2 style="${H2_STYLE}">Variations from the original objectives, work plan or budget</h2>
  <p style="margin:6px 0;">${esc(fields.variations)}</p>

  <h2 style="${H2_STYLE}">Stacking of Government Funding</h2>
  <p style="margin:6px 0;font-size:10pt;">As stipulated in the Contribution Agreement, a Firm must declare any funding received from federal, provincial, territorial and municipal government sources for costs associated with the project as incurred by the Firm, which would constitute Stacking of Government Assistance.</p>
  <table style="border-collapse:collapse;width:100%;font-size:9pt;margin:8px 0;">
    <tr>
      <th style="border:1px solid #999;padding:4px;">Claim No.</th>
      <th style="border:1px solid #999;padding:4px;">Period of claimed amounts</th>
      <th style="border:1px solid #999;padding:4px;">Cost Category</th>
      <th style="border:1px solid #999;padding:4px;">Government Program Name</th>
      <th style="border:1px solid #999;padding:4px;">Government Funding that intersects with NRC IRAP Project Costs ($)</th>
    </tr>
    ${stackingRows}
  </table>

  <p style="margin:18px 0 4px;">Prepared by &nbsp;&nbsp; <b>${esc(fields.preparedBy)}</b> &nbsp;&nbsp;&nbsp;&nbsp; Title: &nbsp; <b>${esc(fields.preparedByTitle)}</b></p>
  <p style="margin:4px 0 24px;">Date &nbsp;&nbsp; <b>${esc(fields.preparedDate)}</b></p>

  <h2 style="${H2_STYLE}">OBJECTIVES &amp; ACTIVITIES FROM CONTRIBUTION AGREEMENT</h2>
  ${renderAppendix(config.objectivesAppendix)}
</div>`;
}

/** Wrap the report body in a printable HTML document. */
function wrapHtmlDoc(bodyHtml, title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>@page { size: Letter; } body { margin: 0; } h2, h3 { page-break-after: avoid; } ul, table { page-break-inside: avoid; }</style>
</head><body>${bodyHtml}</body></html>`;
}

async function htmlToPdf(html, pdfPath) {
  // Lazy-require so unit tests of the pure functions never load puppeteer.
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: pdfPath,
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.6in', bottom: '0.6in', left: '0.7in', right: '0.7in' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="font-size:8px;color:#666;width:100%;padding:0 0.7in;display:flex;justify-content:space-between;"><span>Status Report — Protected B / Confidential Business Information</span><span>PAGE <span class="pageNumber"></span></span></div>',
    });
  } finally {
    await browser.close();
  }
}

async function generateStatusReport(opts) {
  const config = opts.config
    || JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'irap-project.json'), 'utf8'));
  const period = resolvePeriod(opts.period, opts.now);
  const activity = collectGitActivity(config.repos, period);
  const commitCount = activity.reduce((n, r) => n + r.commits.length, 0);
  if (!commitCount && !opts.notes) {
    throw new Error(`No commits found for ${period.label} and no --notes provided — nothing to report from.`);
  }

  const prior = loadPriorReports(period);
  const claimNumber = opts.claimNumber ? String(opts.claimNumber) : deriveClaimNumber(period);
  const sections = await synthesizeSections({ config, period, activity, notes: opts.notes, prior });
  const archivePath = saveReportArchive({ period, claimNumber, sections });

  const includeBaseline = opts.baseline === true
    || shouldIncludeBaseline(period, config.projectStart);
  const fields = {
    baseline: (includeBaseline && config.baseline) || null,
    claimNumber,
    projectNumber: config.nrcProjectNumber,
    firmName: config.firmName,
    periodFrom: period.fromStr,
    periodTo: period.toStr,
    onSchedule: !opts.delayExplanation,
    delayExplanation: opts.delayExplanation || '',
    completionDate: opts.completionDate || config.forecastedCompletionDate,
    addressChanged: false,
    nameChanged: false,
    variations: opts.variations || 'There have been no variations.',
    preparedBy: config.preparedBy,
    preparedByTitle: config.preparedByTitle,
    preparedDate: opts.preparedDate || new Date().toLocaleDateString('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric',
    }),
  };

  const html = renderReportHtml({ config, fields, sections });
  const outPath = expandHome(opts.outPath || `~/Downloads/IRAP Status Report - ${period.label}.pdf`);
  if (outPath.endsWith('.html')) {
    fs.writeFileSync(outPath, html); // Google-Docs-pastable variant
  } else {
    await htmlToPdf(wrapHtmlDoc(html, `Status Report - ${period.label}`), outPath);
  }
  return { outPath, archivePath, period, claimNumber, commitCount, priorCount: prior.length, sections };
}

module.exports = {
  resolvePeriod,
  shouldIncludeBaseline,
  collectGitActivity,
  formatActivityForPrompt,
  loadPriorReports,
  saveReportArchive,
  deriveClaimNumber,
  formatPriorReportsForPrompt,
  extractJson,
  buildSynthesisPrompt,
  renderReportHtml,
  wrapHtmlDoc,
  htmlToPdf,
  generateStatusReport,
};
