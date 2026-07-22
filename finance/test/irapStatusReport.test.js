const { test } = require('node:test');
const assert = require('node:assert');
const {
  resolvePeriod,
  extractJson,
  renderReportHtml,
  formatActivityForPrompt,
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
