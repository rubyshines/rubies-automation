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
  formatActivityForPrompt,
  loadPriorReports,
  saveReportArchive,
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

test('shouldIncludeBaseline: only the project start month', () => {
  const july = resolvePeriod('2026-07', JULY_2026);
  const august = resolvePeriod('2026-08', JULY_2026);
  assert.equal(shouldIncludeBaseline(july, '2026-07-01'), true);
  assert.equal(shouldIncludeBaseline(august, '2026-07-01'), false);
  assert.equal(shouldIncludeBaseline(july, null), false);
});

test('renderReportHtml: baseline section renders when present, omitted when null', () => {
  const config = { objectivesAppendix: [] };
  const fields = {
    baseline: { heading: 'Starting point at project commencement', intro: 'The starting point was:', bullets: ['CS: supervised drafts only'] },
    claimNumber: '1', projectNumber: '1044596', firmName: 'Rubies Apparel Inc.',
    periodFrom: 'July 1, 2026', periodTo: 'July 31, 2026',
    onSchedule: true, completionDate: 'February 28, 2027',
    addressChanged: false, nameChanged: false, variations: 'None.',
    preparedBy: 'Jamie Alexander', preparedByTitle: 'Founder', preparedDate: 'August 1, 2026',
  };
  const sections = [{ heading: 'H', bullets: ['b'] }];
  const withBaseline = renderReportHtml({ config, fields, sections });
  assert.match(withBaseline, /Starting point at project commencement/);
  assert.match(withBaseline, /CS: supervised drafts only/);
  // baseline must precede Key Developments
  assert.ok(withBaseline.indexOf('Starting point') < withBaseline.indexOf('Key Developments'));
  const without = renderReportHtml({ config, fields: { ...fields, baseline: null }, sections });
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

test('buildSynthesisPrompt: prior reports appear as already-reported context', () => {
  const config = { objectivesAppendix: [{ heading: 'O', text: 't' }], baseline: { bullets: ['base'] } };
  const period = resolvePeriod('2026-07', JULY_2026);
  const prior = [{ period: { label: 'June 2026' }, sections: [{ heading: 'KB Rebuild', bullets: ['We rebuilt the KB.'] }] }];
  const { system } = buildSynthesisPrompt({ config, period, activityText: 'x', notes: null, prior });
  assert.match(system, /ALREADY REPORTED IN EARLIER STATUS REPORTS/);
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
  const config = { objectivesAppendix: [{ heading: 'Objectives:', text: 'Line one\n- bullet a\n- bullet b' }] };
  const fields = {
    claimNumber: '2', projectNumber: '9999999', firmName: 'Rubies Apparel Inc.',
    periodFrom: 'June 1, 2026', periodTo: 'June 30, 2026',
    onSchedule: false, delayExplanation: 'Supplier <delay>', completionDate: 'February 28, 2027',
    addressChanged: false, nameChanged: false,
    variations: 'There have been no variations.',
    preparedBy: 'Jamie Alexander', preparedByTitle: 'Founder', preparedDate: 'July 22, 2026',
  };
  const sections = [{ heading: 'CS Agent', bullets: ['We improved <things>.'] }];
  const html = renderReportHtml({ config, fields, sections });

  assert.match(html, /Status Report/);
  assert.match(html, /From June 1, 2026 To June 30, 2026/);
  assert.match(html, /&#9744; yes &nbsp;&nbsp; X no/); // off-schedule renders "no" checked
  assert.match(html, /Supplier &lt;delay&gt;/); // escaped
  assert.match(html, /We improved &lt;things&gt;\./);
  assert.match(html, /OBJECTIVES &amp; ACTIVITIES FROM CONTRIBUTION AGREEMENT/);
  assert.match(html, /<li[^>]*>bullet a<\/li>/);
  assert.match(html, /There have been no variations\./);
});
