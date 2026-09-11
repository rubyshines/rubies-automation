const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolvePeriod,
  shouldIncludeBaseline,
  extractJson,
  renderReportHtml,
  wrapHtmlDoc,
  formatActivityForPrompt,
  loadPriorReports,
  saveReportArchive,
  deriveClaimNumber,
  buildSynthesisPrompt,
} = require('../lib/irapStatusReport');

const JULY_2026 = new Date('2026-07-22T12:00:00');

test('resolvePeriod: bare month resolves to most recent occurrence', () => {
  const p = resolvePeriod('June', JULY_2026);
  assert.equal(p.label, 'June 2026');
  assert.equal(p.fromStr, 'June 1, 2026');
  assert.equal(p.toStr, 'June 30, 2026');
  // A month later in the calendar than "now" belongs to the previous year
  assert.equal(resolvePeriod('December', JULY_2026).label, 'December 2025');
});

test('resolvePeriod: explicit forms', () => {
  assert.equal(resolvePeriod('june 2026', JULY_2026).label, 'June 2026');
  assert.equal(resolvePeriod('2026-06', JULY_2026).label, 'June 2026');
  assert.equal(resolvePeriod('2027-02', JULY_2026).toStr, 'February 28, 2027');
  assert.throws(() => resolvePeriod('notamonth', JULY_2026), /Cannot parse/);
});

test('resolvePeriod: multi-month ranges', () => {
  const sept = new Date('2026-09-02T12:00:00');
  const r = resolvePeriod('July-August', sept);
  assert.equal(r.label, 'July-August 2026');
  assert.equal(r.fromStr, 'July 1, 2026');
  assert.equal(r.toStr, 'August 31, 2026');
  assert.equal(r.sinceIso, '2026-07-01T00:00:00');
  assert.equal(r.untilIso, '2026-08-31T23:59:59');
  assert.equal(r.month, 7);
  assert.equal(r.endMonth, 8);

  assert.equal(resolvePeriod('july-august 2026', JULY_2026).label, 'July-August 2026');
  assert.equal(resolvePeriod('2026-07..2026-08', JULY_2026).toStr, 'August 31, 2026');
  // cross-year: iso form carries a year per end; bare names roll the end forward
  assert.equal(resolvePeriod('2026-12..2027-01', JULY_2026).label, 'December 2026 - January 2027');
  const wrapped = resolvePeriod('december-january', new Date('2027-02-10T12:00:00'));
  assert.equal(wrapped.label, 'December 2026 - January 2027');
  assert.equal(wrapped.untilIso, '2027-01-31T23:59:59');

  assert.throws(() => resolvePeriod('2026-08..2026-07', JULY_2026), /ends before it starts/);
  assert.throws(() => resolvePeriod('july-notamonth', JULY_2026), /Cannot parse/);
  // single months are unchanged by the range support
  assert.equal(resolvePeriod('2026-07', JULY_2026).endMonth, 7);
});

test('shouldIncludeBaseline: only the project start month', () => {
  const july = resolvePeriod('2026-07', JULY_2026);
  const august = resolvePeriod('2026-08', JULY_2026);
  assert.equal(shouldIncludeBaseline(july, '2026-07-01'), true);
  assert.equal(shouldIncludeBaseline(august, '2026-07-01'), false);
  assert.equal(shouldIncludeBaseline(july, null), false);
});

test('renderReportHtml: baseline section renders when present, omitted when null', () => {
  const fields = {
    baseline: { heading: 'Starting point at project commencement', intro: 'The starting point was:', bullets: ['CS: supervised drafts only'] },
    claimNumber: '1', projectNumber: '1044596', firmName: 'Rubies Apparel Inc.',
    periodFrom: 'July 1, 2026', periodTo: 'July 31, 2026',
    onSchedule: true, completionDate: 'February 28, 2027',
    addressChanged: false, nameChanged: false, variations: 'None.',
    preparedBy: 'Jamie Alexander', preparedByTitle: 'Founder', preparedDate: 'August 1, 2026',
  };
  const sections = [{ heading: 'H', bullets: ['b'] }];
  const withBaseline = renderReportHtml({ fields, sections });
  assert.match(withBaseline, /Starting point at project commencement \(capabilities already in place before July 1, 2026\)/);
  assert.match(withBaseline, /Key Developments during this reporting period \(July 1, 2026 to July 31, 2026\)/);
  assert.match(withBaseline, /CS: supervised drafts only/);
  // baseline must precede Key Developments
  assert.ok(withBaseline.indexOf('Starting point') < withBaseline.indexOf('Key Developments'));
  const without = renderReportHtml({ fields: { ...fields, baseline: null }, sections });
  assert.doesNotMatch(without, /Starting point at project commencement/);
});

test('report archive: save + load prior months only, in order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irap-archive-'));
  const june = resolvePeriod('2026-06', JULY_2026);
  const july = resolvePeriod('2026-07', JULY_2026);
  const august = resolvePeriod('2026-08', JULY_2026);
  saveReportArchive({ period: july, claimNumber: '2', sections: [{ heading: 'J', bullets: ['x'] }] }, dir);
  saveReportArchive({ period: june, claimNumber: '1', sections: [{ heading: 'Older', bullets: ['y'] }] }, dir);

  assert.equal(loadPriorReports(june, dir).length, 0); // nothing before June
  const beforeAugust = loadPriorReports(august, dir);
  assert.deepEqual(beforeAugust.map((r) => r.period.label), ['June 2026', 'July 2026']);
  assert.equal(loadPriorReports(july, dir)[0].sections[0].heading, 'Older');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('report archive: range periods file under start_end and count as prior for later months', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irap-range-'));
  const june = resolvePeriod('2026-06', JULY_2026);
  const julAug = resolvePeriod('2026-07..2026-08', JULY_2026);
  const sept = resolvePeriod('2026-09', new Date('2026-10-02T12:00:00'));

  saveReportArchive({ period: june, claimNumber: '1', sections: [{ heading: 'J', bullets: ['x'] }] }, dir);
  const file = saveReportArchive({ period: julAug, claimNumber: '2', sections: [{ heading: 'R', bullets: ['y'] }] }, dir);
  assert.equal(path.basename(file), '2026-07_2026-08.json');

  // June precedes the range; the range precedes September
  assert.deepEqual(loadPriorReports(julAug, dir).map((r) => r.period.label), ['June 2026']);
  assert.deepEqual(loadPriorReports(sept, dir).map((r) => r.period.label), ['June 2026', 'July-August 2026']);

  // claim derivation: regenerate reuses the range's own claim; next period increments past it
  assert.equal(deriveClaimNumber(julAug, dir), '2');
  assert.equal(deriveClaimNumber(sept, dir), '3');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deriveClaimNumber: reuse on regenerate, increment for new month, 1 when empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irap-claims-'));
  const june = resolvePeriod('2026-06', JULY_2026);
  const july = resolvePeriod('2026-07', JULY_2026);
  const sept = resolvePeriod('2026-09', JULY_2026);

  assert.equal(deriveClaimNumber(june, dir), '1'); // empty archive
  saveReportArchive({ period: june, claimNumber: '1', sections: [{ heading: 'H', bullets: ['b'] }] }, dir);
  assert.equal(deriveClaimNumber(june, dir), '1'); // regenerate reuses own
  assert.equal(deriveClaimNumber(july, dir), '2'); // next month increments
  saveReportArchive({ period: july, claimNumber: '2', sections: [{ heading: 'H', bullets: ['b'] }] }, dir);
  assert.equal(deriveClaimNumber(sept, dir), '3'); // skipped month still max+1
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP tool module: registers irap_status_report with required month', () => {
  const tools = require('../../customer-service/lib/tools/irapStatusReport');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'irap_status_report');
  assert.deepEqual(tools[0].inputSchema.required, ['month']);
  assert.equal(typeof tools[0].handler, 'function');
});

test('buildSynthesisPrompt: prior reports appear as already-reported context', () => {
  const config = {
    objectivesAppendix: [{ heading: 'O', text: 't' }],
    baseline: { bullets: ['base'] },
    technicalUncertainties: ['whether agents can reach 80%+ autonomy'],
  };
  const period = resolvePeriod('2026-07', JULY_2026);
  const prior = [{ period: { label: 'June 2026' }, sections: [{ heading: 'KB Rebuild', bullets: ['We rebuilt the KB.'] }] }];
  const { system } = buildSynthesisPrompt({ config, period, activityText: 'x', notes: null, prior });
  assert.match(system, /ALREADY REPORTED IN EARLIER STATUS REPORTS/);
  assert.match(system, /whether agents can reach 80%\+ autonomy/);
  assert.match(system, /NEVER invent, round, or extrapolate/);
  assert.match(system, /June 2026 status report/);
  assert.match(system, /We rebuilt the KB\./);
  const { system: noPrior } = buildSynthesisPrompt({ config, period, activityText: 'x', notes: null, prior: [] });
  assert.doesNotMatch(noPrior, /ALREADY REPORTED/);
});

test('extractJson: tolerates prose and code fences around the object', () => {
  const obj = extractJson('Here you go:\n```json\n{"sections":[{"heading":"H","bullets":["b"]}]}\n```');
  assert.equal(obj.sections[0].heading, 'H');
  assert.throws(() => extractJson('no json here'), /No JSON/);
});

test('formatActivityForPrompt: one block per repo with counts', () => {
  const text = formatActivityForPrompt([
    { repo: 'rubies-automations', commits: ['2026-06-01 fix(cs): a', '2026-06-02 feat(b2b): b'] },
  ]);
  assert.match(text, /rubies-automations \(2 commits\)/);
  assert.match(text, /feat\(b2b\): b/);
});

test('renderReportHtml: fills template fields and escapes content', () => {
  const fields = {
    claimNumber: '2', projectNumber: '9999999', firmName: 'Rubies Apparel Inc.',
    periodFrom: 'June 1, 2026', periodTo: 'June 30, 2026',
    onSchedule: false, delayExplanation: 'Supplier <delay>', completionDate: 'February 28, 2027',
    addressChanged: false, nameChanged: false,
    variations: 'There have been no variations.',
    preparedBy: 'Jamie Alexander', preparedByTitle: 'Founder', preparedDate: 'July 22, 2026',
  };
  const sections = [{ heading: 'CS Agent', bullets: ['We improved <things>.'] }];
  const html = renderReportHtml({ fields, sections });

  assert.match(html, /Status Report/);
  assert.match(html, /From&nbsp;&nbsp;&nbsp;June 1, 2026 To June 30, 2026/);
  // off-schedule checks "no"; the unanswered ownership question stays blank
  assert.match(html, /&#9744;&nbsp;&nbsp;yes<\/span><span class="at" style="left:3.52in">X&nbsp;&nbsp;no/);
  assert.match(html, /&#9744;&nbsp;&nbsp;yes<span class="at" style="left:1.05in">&#9744;&nbsp;&nbsp;no/);
  assert.match(html, /Supplier &lt;delay&gt;/); // escaped
  assert.match(html, /We improved &lt;things&gt;\./);
  assert.match(html, /There have been no variations\./);
});

test('renderReportHtml: keeps every line of the template the client must not delete', () => {
  const fields = {
    claimNumber: '2', projectNumber: '1044596', firmName: 'Rubies Apparel Inc.',
    periodFrom: 'July 1, 2026', periodTo: 'August 31, 2026',
    onSchedule: true, completionDate: 'February 28, 2027',
    addressChanged: false, nameChanged: false, variations: 'There have been no variations.',
    preparedBy: 'Jamie Alexander', preparedByTitle: 'Founder', preparedDate: 'September 2, 2026',
  };
  const html = renderReportHtml({ fields, sections: [{ heading: 'H', bullets: ['b'] }] });

  // NRC bounced the September 2026 report for not using the template. These are
  // the template's own words and furniture; none of them may be dropped again.
  for (const line of [
    'Use the tab button to move to the next field',
    'If you answered &ldquo;No&rdquo;, provide a brief explanation for delays',
    'If you answered &ldquo;No&rdquo;, provide a forecasted project completion date:',
    'Has the Firm&rsquo;s address changed since the last status report?',
    'If yes, please update the address in the NRC IRAP Innovation Portal',
    'If yes, provide new name',
    'If the Firm name has been changed, does this result in a change of ownership?',
    'Provide a brief description of activities related as per the Contribution Agreement',
    'Briefly explain new challenges found during the work completed in this reporting period',
    'In cases where the Firm receives Government support',
    'To determine attribution of Government funding toward NRC IRAP supported Project Costs',
    'Additional information on Stacking is available on the NRC IRAP Innovation Portal',
    'Complete the following table to identify Government support received',
    'Note: Your claim will be adjusted by NRC IRAP based on the information provided',
    'The Status Report must be prepared by the client.',
    'The Status Report must be attached to your claim and submitted by the dates specified',
  ]) {
    assert.ok(html.includes(line), `template line missing: ${line}`);
  }

  // The stacking table keeps the template's 15 claim rows.
  assert.equal((html.match(/>From<span/g) || []).length, 15);
  // Both NRC banners are embedded (first page and continuation).
  assert.equal((html.match(/data:image\/jpeg;base64,/g) || []).length, 2);
  // The objectives appendix is NOT part of the template and must not come back.
  assert.doesNotMatch(html, /OBJECTIVES &amp; ACTIVITIES FROM CONTRIBUTION AGREEMENT/);
});

test('wrapHtmlDoc: the blue rule sits above each heading, never below', () => {
  const doc = wrapHtmlDoc('<p>x</p>', 'T');
  assert.match(doc, /h2 \{[^}]*border-top: 2\.25pt solid #2E74B5/);
  assert.doesNotMatch(doc, /h2 \{[^}]*border-bottom/);
  assert.match(doc, /@page \{ size: Letter; margin: 0 0 0\.9in 0; \}/);
});
