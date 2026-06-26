/**
 * Unit tests for lib/freeSwimwearSurvey.js — deterministic eligibility gate
 * and the header-based row normalizer (both form-tab shapes).
 *
 * Run: node --test customer-service/test/freeSwimwearSurvey.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { computeEligibility, buildColumnMap, normalizeRow } = require('../lib/freeSwimwearSurvey');

describe('computeEligibility', () => {
  it('rejects Brazil regions silently (case/diacritic-insensitive)', () => {
    assert.equal(computeEligibility({ region: 'São Paulo, Brasil', is_trans_nonbinary: true }).status, 'rejected');
    assert.match(computeEligibility({ region: 'I live in Brazil', is_trans_nonbinary: true }).eligibility_reason, /excluded region/);
  });

  it('rejects applicants who do not identify as trans/non-binary', () => {
    const r = computeEligibility({ region: 'Texas, USA', is_trans_nonbinary: false });
    assert.equal(r.status, 'rejected');
    assert.equal(r.eligibility_reason, 'not trans/non-binary');
  });

  it('accepts eligible applicants', () => {
    const r = computeEligibility({ region: 'Ohio, USA', is_trans_nonbinary: true });
    assert.equal(r.status, 'new');
    assert.equal(r.eligibility_reason, 'eligible');
  });

  it('treats unknown identity (legacy form) as eligible when region is fine', () => {
    assert.equal(computeEligibility({ region: 'Ontario, Canada', is_trans_nonbinary: null }).status, 'new');
  });
});

describe('buildColumnMap + normalizeRow (current form shape)', () => {
  const HEADERS = [
    'Timestamp', 'Email Address', 'What is your name',
    'What is the age of the person who will be receiving the bottoms?',
    'Does the person who will be receiving the bottoms identify as trans or non-binary?',
    'status', 'resend status', 'discount code', 'Shopify customer id', 'registration date',
    'order numbers', 'order dates', 'expiry date', 'last acceptance send date', 'number of send attempts',
    'What state/province and country do you live in?',
    'Tell us about your situation and how this swimsuit can help.',
    'Why would you like RUBIES to send your family a swimsuit?',
    'Where did you find out about RUBIES?', 'What was your first reaction when you heard about RUBIES',
    'What product would your kid want RUBIES to make the most?',
    'If your child could pick any colour and pattern for a one piece or bikini bottom, which would they choose?',
    'Do you have any suggestions for what RUBIES could be doing better?', 'spam note', '', 'Size', 'Final response',
  ];

  it('maps every operational + question column', () => {
    const map = buildColumnMap(HEADERS);
    assert.equal(map.submitted_at, 0);
    assert.equal(map.email, 1);
    assert.equal(map.applicant_name, 2);
    assert.equal(map.recipient_age, 3);
    assert.equal(map.is_trans_nonbinary, 4);
    assert.equal(map.status, 5);
    assert.equal(map.discount_code, 7);
    assert.equal(map.size, 25);
    assert.equal(map.final_response, 26);
  });

  it('normalizes a fulfilled (ordered) row, splitting " | " lists', () => {
    const map = buildColumnMap(HEADERS);
    const row = [
      '6/3/2020 7:32:20', 'fam@example.com', 'Sarah Everly', '10', 'yes',
      'ordered', '', 'SARAH-ABC123', '3265004273749', '2020-06-03T07:32:20Z',
      '1186 | 1187', '2020-06-03T07:33:52Z | 2020-06-05T00:00:00Z', '2020-09-04T00:00:00Z', '2020-06-05T09:03:15Z', '1',
      'Massachusetts, USA', 'situation text', 'why text', 'instagram', 'warm', 'one piece', 'unicorn', 'none', '', '', 'M', 'thanks',
    ];
    const n = normalizeRow(row, map, { tab: 'Form Responses 1', sheetRow: 5, isLegacy: false });
    assert.equal(n.source, 'form');
    assert.equal(n.status, 'ordered'); // existing status preserved, no eligibility override
    assert.equal(n.is_trans_nonbinary, true);
    assert.deepEqual(n.order_numbers, ['1186', '1187']);
    assert.equal(n.order_dates.length, 2);
    assert.equal(n.send_attempts, 1);
    assert.equal(n.discount_code, 'SARAH-ABC123');
    assert.equal(n.region, 'Massachusetts, USA');
  });

  it('runs the eligibility gate only on blank-status (new) rows', () => {
    const map = buildColumnMap(HEADERS);
    const base = ['6/3/2026 7:32:20', 'b@example.com', 'B', '9', 'no', '', '', '', '', '', '', '', '', '', '', 'Texas', 's', 'w', '', '', '', '', '', '', '', '', ''];
    const n = normalizeRow(base, map, { tab: 'Form Responses 1', sheetRow: 9, isLegacy: false });
    assert.equal(n.status, 'rejected');
    assert.equal(n.eligibility_reason, 'not trans/non-binary');
  });

  it('skips rows with no email', () => {
    const map = buildColumnMap(HEADERS);
    const row = new Array(HEADERS.length).fill('');
    assert.equal(normalizeRow(row, map, { tab: 'Form Responses 1', sheetRow: 2, isLegacy: false }), null);
  });
});

describe('legacy form shape (Sheet5, no trans column)', () => {
  const LEGACY = [
    'Timestamp', 'Email Address', 'What is your name', 'What is the age ',
    'status', 'resend status', 'discount code', 'Shopify customer id', 'registration date',
    'order numbers', 'order dates', 'expiry date', 'last acceptance send date', 'number of send attempts',
    'Where do you live? (optional)', 'Tell us about your situation.',
    'Why would you like RUBIES to send your family a swimsuit?', 'Where did you find out about RUBIES?',
    'What was your first reaction when you heard about RUBIES', 'What product would your kid want RUBIES to make the most?',
    'If your child could pick any colour and pattern for a one piece or bikini bottom, which would they choose?',
    'Do you have any suggestions for what RUBIES could be doing better?',
    'What size bottoms does your kid usually wear', 'Size', 'Final response',
  ];

  it('maps legacy columns and leaves identity unknown', () => {
    const map = buildColumnMap(LEGACY);
    assert.equal(map.is_trans_nonbinary, undefined);
    assert.equal(map.region, 14); // "Where do you live?"
    assert.equal(map.size, 23);
    const row = ['1/1/2021', 'l@example.com', 'Legacy Kid', '8', 'ordered', '', 'LEGACY-X', '999', '', '500', '2021-01-02', '', '', '1', 'Spain', 'sit', 'why', '', '', '', '', '', '', 'M', 'ty'];
    const n = normalizeRow(row, map, { tab: 'Sheet5', sheetRow: 3, isLegacy: true });
    assert.equal(n.source, 'legacy');
    assert.equal(n.is_trans_nonbinary, null);
    assert.equal(n.region, 'Spain');
    assert.equal(n.status, 'ordered');
  });
});
