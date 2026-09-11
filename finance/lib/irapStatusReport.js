/**
 * NRC-IRAP monthly status report generator.
 *
 * Given a reporting month, collects the actual git activity across the RUBIES
 * repos for that period, has Opus group the project-relevant work into
 * "Key Developments" sections in the style of past submitted reports, and
 * renders it onto the NRC status report template itself (NRC banners, running
 * footer, and every line of the template's own instruction text, answered or
 * not) as a PDF, or as the same document in HTML.
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

/** Resolve one month token ("june", "june 2026", "2026-06") to {year, monthIdx}. */
function resolveMonthToken(raw, now) {
  const iso = raw.match(/^(\d{4})-(\d{1,2})$/);
  const named = raw.match(/^([a-z]+)(?:\s+(\d{4}))?$/);
  let year;
  let monthIdx;
  if (iso) {
    year = Number(iso[1]);
    monthIdx = Number(iso[2]) - 1;
  } else if (named && MONTHS.includes(named[1])) {
    monthIdx = MONTHS.indexOf(named[1]);
    year = named[2] ? Number(named[2]) : now.getFullYear();
    if (!named[2] && monthIdx > now.getMonth()) year -= 1;
  } else {
    return null;
  }
  if (monthIdx < 0 || monthIdx > 11) return null;
  return { year, monthIdx };
}

function monthName(idx) {
  return MONTHS[idx][0].toUpperCase() + MONTHS[idx].slice(1);
}

/**
 * Resolve "June", "June 2026", or "2026-06" to a reporting period.
 * A bare month name resolves to the most recent occurrence of that month
 * that has already started (June asked in July 2026 → June 2026).
 *
 * A multi-month claim period is written as a range: "July-August",
 * "July-August 2026", or "2026-07..2026-08" — the period then runs from the
 * first day of the start month to the last day of the end month.
 */
function resolvePeriod(input, now = new Date()) {
  const raw = String(input || '').trim().toLowerCase();

  // Range forms: "2026-07..2026-08" and "july-august [year]". A trailing year
  // on the named form applies to both ends; cross-year named ranges need the
  // iso form so each end carries its own year.
  let startTok = null;
  let endTok = null;
  const isoRange = raw.match(/^(\d{4}-\d{1,2})\.\.(\d{4}-\d{1,2})$/);
  const namedRange = raw.match(/^([a-z]+)-([a-z]+)(?:\s+(\d{4}))?$/);
  if (isoRange) {
    startTok = resolveMonthToken(isoRange[1], now);
    endTok = resolveMonthToken(isoRange[2], now);
  } else if (namedRange && MONTHS.includes(namedRange[1]) && MONTHS.includes(namedRange[2])) {
    const yearSuffix = namedRange[3] ? ` ${namedRange[3]}` : '';
    startTok = resolveMonthToken(`${namedRange[1]}${yearSuffix}`, now);
    endTok = resolveMonthToken(`${namedRange[2]}${yearSuffix}`, now);
    // "december-january" with bare names would resolve both to past months
    // independently; keep the range contiguous by rolling the end forward.
    if (startTok && endTok && !namedRange[3]
      && endTok.year * 12 + endTok.monthIdx < startTok.year * 12 + startTok.monthIdx) {
      endTok = { year: endTok.year + 1, monthIdx: endTok.monthIdx };
    }
  } else {
    startTok = resolveMonthToken(raw, now);
    endTok = startTok;
  }

  if (!startTok || !endTok) {
    throw new Error(`Cannot parse reporting period "${input}" — use "June", "June 2026", "2026-06", or a range like "July-August" / "2026-07..2026-08"`);
  }
  if (endTok.year * 12 + endTok.monthIdx < startTok.year * 12 + startTok.monthIdx) {
    throw new Error(`Reporting period "${input}" ends before it starts`);
  }

  const { year, monthIdx } = startTok;
  const startName = monthName(monthIdx);
  const endName = monthName(endTok.monthIdx);
  const lastDay = new Date(endTok.year, endTok.monthIdx + 1, 0).getDate();
  const isRange = endTok.year !== year || endTok.monthIdx !== monthIdx;
  const label = !isRange
    ? `${startName} ${year}`
    : endTok.year === year
      ? `${startName}-${endName} ${year}`
      : `${startName} ${year} - ${endName} ${endTok.year}`;
  return {
    year,
    month: monthIdx + 1,
    endYear: endTok.year,
    endMonth: endTok.monthIdx + 1,
    label,
    fromStr: `${startName} 1, ${year}`,
    toStr: `${endName} ${lastDay}, ${endTok.year}`,
    sinceIso: `${year}-${String(monthIdx + 1).padStart(2, '0')}-01T00:00:00`,
    untilIso: `${endTok.year}-${String(endTok.monthIdx + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}T23:59:59`,
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
  const start = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const end = `${period.endYear || period.year}-${String(period.endMonth || period.month).padStart(2, '0')}`;
  return end === start ? start : `${start}_${end}`;
}

/** Load archived reports for periods strictly before the given period. */
function loadPriorReports(period, dir = REPORTS_DIR) {
  if (!fs.existsSync(dir)) return [];
  const ymStart = periodYm(period).slice(0, 7);
  // Archive names are "<start ym>.json" or "<start ym>_<end ym>.json"; a
  // period is prior when its start month precedes this period's start month.
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}(?:_\d{4}-\d{2})?\.json$/.test(f) && f.slice(0, 7) < ymStart)
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
 * period's archived claim on a regenerate, otherwise max prior claim + 1.
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
- AUDIENCE: an NRC advisor reading many firms' reports. Comfortable with business technology (knows what an AI assistant, a database, or an integration is) but not a software practitioner, and does NOT know this firm's internal systems. Write plainly at that level:
  - Name the mechanism by what it does for the business, not by its engineering term. "an automatic fallback that keeps drafts flowing when the AI provider is overloaded", not "a load-shed circuit breaker that degrades to legacy output mode". "a retry system that recovers customer emails that failed to import", not "intake dead-letter replay".
  - No internal component names, table names, or acronym strings. One named concept per bullet at most, and only if it earns its place.
  - Each bullet says in plain words what we built or tested and what it lets the business do. Stay at the level of the outcome; leave out how it works inside unless the mechanism IS the news. Avoid abstract phrases like "hardened workflows", "seeded relationship state", "laying groundwork".
  - NUMBERS: use them only for headline outcomes, a measured rate or figure that speaks to a Contribution Agreement target, or the size of a customer or partner result. Internal implementation counts (how many articles, rules, tickets, or files something contains) stay qualitative: "a curated knowledge base built from past resolved tickets", not "292 curated articles".
  - Test: a reader who has never seen our codebase should understand every bullet on first read without slowing down, and nothing should read like it was written for our own engineers.
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
  // The model occasionally emits malformed JSON (observed 2/3 runs on a large
  // two-month commit log), so one parse failure gets one fresh attempt.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Opus: final text a federal funder reads — customer-facing quality bar.
    const res = await callClaude({
      component: 'irap_status_report',
      model: MODELS.OPUS,
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: user }],
    });
    try {
      const parsed = extractJson(res.text);
      if (!Array.isArray(parsed.sections) || !parsed.sections.length) {
        throw new Error('Model returned no sections');
      }
      return parsed.sections;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Colours, tab stops and banner geometry are measured off the NRC template
// ("Status Report - Document for Clients", rev. February 2023) and off a
// previously accepted completed report, so the output IS the template, filled
// in — not a lookalike. NRC rejected a lookalike in September 2026.
const TEAL = '#007799';   // section headings
const RULE = '#2E74B5';   // the rule that sits ABOVE each heading
const HINT = '#5B9BD5';   // the template's own italic instruction text
const TEMPLATE_REV = 'Last Modified: February 2023';

// Banners and the Government of Canada signature, extracted from the template.
const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'irap');
const assetCache = new Map();
function asset(file) {
  if (!assetCache.has(file)) {
    const buf = fs.readFileSync(path.join(ASSETS_DIR, file));
    assetCache.set(file, `data:image/jpeg;base64,${buf.toString('base64')}`);
  }
  return assetCache.get(file);
}

const BOX = '&#9744;';
// Word form checkboxes print as a literal X beside the chosen option.
const tick = (on) => (on ? 'X' : BOX);

/** Place a run at one of the template's tab stops, in inches from the margin. */
const at = (inches, html) => `<span class="at" style="left:${inches}in">${html}</span>`;
const yesNo = (on, yesAt, noAt) =>
  at(yesAt, `${tick(on)}&nbsp;&nbsp;yes`) + at(noAt, `${tick(!on)}&nbsp;&nbsp;no`);

/** The stacking table: header plus the template's 15 empty claim rows. */
function renderStackingTable() {
  const head = `<tr>
    <th class="c1">Claim No.</th>
    <th class="c2">Period of claimed amounts</th>
    <th class="c3">Cost Category</th>
    <th class="c4">Government Program Name</th>
    <th class="c5">Government Funding that intersects with NRC IRAP Project Costs ($)</th>
  </tr>`;
  const row = `<tr>
    <td>&nbsp;</td>
    <td>From<span style="display:inline-block;width:0.55in;"></span>To</td>
    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
  </tr>`;
  return `<table class="stacking">${head}${row.repeat(15)}</table>`;
}

function renderReportHtml({ fields, sections }) {
  const sectionsHtml = sections.map((s) => `
    <p class="sub"><b>${esc(s.heading)}</b></p>
    <ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`).join('');

  const baseline = fields.baseline ? `
    <p class="sub"><b>${esc(fields.baseline.heading)} (capabilities already in place before ${esc(fields.periodFrom)})</b></p>
    <p>${esc(fields.baseline.intro)}</p>
    <ul>${fields.baseline.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '';

  // Every line of instruction text below is the template's own wording and must
  // stay, answered or not: deleting it is what got the September 2026 report
  // bounced as "not the template".
  return `
<table class="sheet"><thead><tr><td>
  <div class="banner"><img src="${asset('banner-cont.jpg')}"></div>
</td></tr></thead><tbody><tr><td class="body">

<div class="banner first-banner">
  <img src="${asset('banner-first.jpg')}">
  <div class="banner-title">Status Report</div>
  <div class="banner-sub">Document for Clients</div>
  <div class="banner-rev">${TEMPLATE_REV}</div>
</div>

<p class="hint">Use the tab button to move to the next field</p>

<p class="row">Claim Number${at(1.51, esc(fields.claimNumber || ''))}${at(2.51, 'NRC IRAP Project Number')}${at(4.51, esc(fields.projectNumber))}</p>
<p class="row">Firm name${at(1.51, esc(fields.firmName))}</p>
<p class="row">Reporting period${at(1.51, `From&nbsp;&nbsp;&nbsp;${esc(fields.periodFrom)} To ${esc(fields.periodTo)}`)}</p>

<h2>Project timeline</h2>
<p class="row">Is the project on schedule?${yesNo(fields.onSchedule, 2.5, 3.52)}</p>
<p>If you answered &ldquo;No&rdquo;, provide a brief explanation for delays</p>
<p>${esc(fields.delayExplanation || '')}&nbsp;</p>
<p>If you answered &ldquo;No&rdquo;, provide a forecasted project completion date:&nbsp;&nbsp;${esc(fields.completionDate)}</p>

<h2>Information on the Firm</h2>
<p class="row">Has the Firm&rsquo;s address changed since the last status report?${yesNo(fields.addressChanged, 4.51, 5.51)}</p>
<p>If yes, please update the address in the NRC IRAP Innovation Portal by clicking on the firm name hyperlink. Note that only the designated signing authority can update the address.</p>
<p>&nbsp;</p>
<p class="row">Has the Firm&rsquo;s name changed since the last status report?${yesNo(fields.nameChanged, 4.51, 5.51)}</p>
<p>If yes, provide new name</p>
<p>&nbsp;</p>
<p>If the Firm name has been changed, does this result in a change of ownership?</p>
<p class="row">${BOX}&nbsp;&nbsp;yes${at(1.05, `${BOX}&nbsp;&nbsp;no`)}</p>

<h2>Activities and outcomes (minimum 2 paragraphs)</h2>
<p>Provide a brief description of activities related as per the Contribution Agreement. Include objectives met or progressed during the reporting period.</p>
${baseline}
<p class="sub"><b>Key Developments during this reporting period (${esc(fields.periodFrom)} to ${esc(fields.periodTo)}):</b></p>
${sectionsHtml}

<h2>Variations from the original objectives, work plan or budget</h2>
<p>Briefly explain new challenges found during the work completed in this reporting period. Describe any budget variation including changes to project related resources.</p>
<p>&nbsp;</p>
<p>${esc(fields.variations)}</p>

<h2>Stacking of Government Funding</h2>
<p>As stipulated in the Contribution Agreement, a Firm must declare any funding received from federal, provincial, territorial and municipal government sources for costs associated with the project as incurred by the Firm, which would constitute Stacking of Government Assistance.</p>
<ul class="tbullets">
  <li>In cases where the Firm receives Government support, the Firm must determine which portion of Government funding intersects with NRC IRAP supported Project Costs.</li>
  <li>To determine attribution of Government funding toward NRC IRAP supported Project Costs, the Firm should apply a pro-rated approach for each supported cost category.</li>
  <li>Additional information on Stacking is available on the NRC IRAP Innovation Portal in the Info Centre, under the claims instruction section.</li>
</ul>
<p class="hint">Complete the following table to identify Government support received which intersect with the NRC IRAP Project claimed amounts, which have not been previously reported.</p>
${renderStackingTable()}
<p class="hint">Note: Your claim will be adjusted by NRC IRAP based on the information provided. All adjustments will be available on the processed claim.&nbsp; It is recommended to save a copy of all completed claim for your Firm&rsquo;s records. It is the Firm&rsquo;s obligation to keep adequate financial records with the ability to segregate NRC IRAP Project Costs from the Firm&rsquo;s normal operating expenses as stipulated in the Contribution Agreement.</p>

<p class="hint ruled"><b>Notes:</b></p>
<ul class="tbullets hint">
  <li>The Status Report must be prepared by the client.</li>
  <li>The Status Report must be attached to your claim and submitted by the dates specified in the Contribution Agreement whether progress made or not.</li>
</ul>
<div class="signoff">
<p class="row prepared">Prepared by${at(1.0, esc(fields.preparedBy))}${at(4.0, 'Title:')}${at(5.01, esc(fields.preparedByTitle))}</p>
<p class="row">Date${at(1.51, esc(fields.preparedDate))}</p>
</div>
</td></tr></tbody></table>
`;
}

// Bottom margin reserved for the running footer, sized so its rule lands where
// the template's does (10.1in down a Letter page).
const FOOTER_IN = 0.9;

/** Wrap the report body in a printable, self-contained HTML document. */
function wrapHtmlDoc(bodyHtml, title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  @page { size: Letter; margin: 0 0 ${FOOTER_IN}in 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; line-height: 1.2; color: #000; }

  /* The banner rides in a repeating <thead>: headless Chrome drops
     position:fixed after page one, and page.pdf's headerTemplate cannot differ
     between the first page and the rest. */
  .sheet { width: 8.5in; border-collapse: collapse; table-layout: fixed; }
  .sheet > thead > tr > td, .sheet > tbody > tr > td { padding: 0; border: 0; }
  .sheet > tbody > tr > td.body { padding: 0.1in 0.5in 0.04in; position: relative; }
  .banner { width: 8.5in; height: 1.5in; }
  .banner img { display: block; width: 8.5in; }
  /* Page one only: the NRC-CNRC banner painted over the running one. */
  .first-banner { position: absolute; top: -1.5in; left: 0; z-index: 5; }
  .banner-title { position: absolute; top: 0.555in; left: 0; width: 8.5in; text-align: center;
                  color: #fff; font-size: 16pt; font-weight: bold; letter-spacing: -0.4px; line-height: 1; }
  .banner-sub   { position: absolute; top: 0.845in; left: 0; width: 8.5in; text-align: center;
                  color: #fff; font-size: 11pt; font-weight: bold; font-style: italic; letter-spacing: 0.6px; line-height: 1; }
  .banner-rev   { position: absolute; top: 1.155in; right: 0.39in; color: #fff; font-size: 8pt; line-height: 1; }

  p { margin: 0 0 6pt; }
  .row { position: relative; }
  .at { position: absolute; top: 0; white-space: nowrap; }
  h2 { color: ${TEAL}; font-size: 16pt; font-weight: bold; margin: 6pt 0 4pt;
       border-top: 2.25pt solid ${RULE}; padding-top: 4pt; page-break-after: avoid; }
  .hint { color: ${HINT}; font-style: italic; }
  .hint b { color: ${HINT}; }
  .ruled { border-top: 2.25pt solid ${RULE}; padding-top: 5pt; margin-top: 2pt; }
  .prepared { margin-top: 4pt; }
  .signoff { page-break-inside: avoid; }
  .sub { margin: 8pt 0 3pt; page-break-after: avoid; }
  ul { margin: 3pt 0 7pt; padding-left: 0.33in; }
  li { margin: 0 0 3pt; }
  .tbullets { padding-left: 0.36in; margin-bottom: 4pt; }
  .tbullets li { margin: 0 0 1pt; }

  .stacking { border-collapse: collapse; width: 7.5in; font-size: 10pt; margin: 4pt 0 2pt;
              table-layout: fixed; page-break-inside: auto; }
  .stacking th, .stacking td { border: 1px solid #BFBFBF; padding: 1px 4px; }
  .stacking th { text-align: center; font-weight: bold; vertical-align: middle; height: 0.5in; }
  .stacking td { height: 0.145in; line-height: 1; }
  .stacking .c1 { width: 0.55in; } .stacking .c2 { width: 2.00in; }
  .stacking .c3 { width: 1.17in; } .stacking .c4 { width: 1.80in; }
</style></head><body>${bodyHtml}</body></html>`;
}

/** The template's running footer. page.pdf renders this into the bottom margin. */
function footerTemplate() {
  return `<div style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:9pt;color:#000;padding:0 0.5in;margin:0;">
      <div style="border-top:2.25pt solid ${RULE};padding-top:3pt;">
        <div style="font-weight:bold;">Status Report</div>
        <div style="display:flex;justify-content:space-between;">
          <span>Protected B / Confidential Business Information (when completed)</span>
          <span style="font-weight:bold;">PAGE <span class="pageNumber"></span></span>
        </div>
      </div></div>`;
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
      // Left/right/top margins are zero so the banner can bleed to the
      // template's own edges; text insets come from .body's padding.
      margin: { top: '0in', bottom: `${FOOTER_IN}in`, left: '0in', right: '0in' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: footerTemplate(),
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
    addressChanged: opts.addressChanged === true,
    nameChanged: false,
    variations: opts.variations || 'There have been no variations.',
    preparedBy: config.preparedBy,
    preparedByTitle: config.preparedByTitle,
    preparedDate: opts.preparedDate || new Date().toLocaleDateString('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric',
    }),
  };

  const body = renderReportHtml({ fields, sections });
  const html = wrapHtmlDoc(body, `Status Report - ${period.label}`);
  const outPath = expandHome(opts.outPath || `~/Downloads/IRAP Status Report - ${period.label}.pdf`);
  if (outPath.endsWith('.html')) {
    fs.writeFileSync(outPath, html); // same document, for the browser
  } else {
    await htmlToPdf(html, outPath);
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
