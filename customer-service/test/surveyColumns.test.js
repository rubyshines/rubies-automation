const test = require('node:test');
const assert = require('node:assert');

const { resolveSurveyColumns, normalizeHeader } = require('../lib/surveyColumns');
const { FIELDS, programTypeFromDistribution } = require('../lib/donationPartnerSurvey');

// The live sheet, 2026-09-11. Pinned so a rewording that this resolver CANNOT
// follow fails here at build rather than silently at ingest — the existing house
// rule for anything parsed out of a Google Form.
const LIVE_HEADERS = [
  'Timestamp',
  'Email Address',
  'What is the name of your organization',
  'What is the website of you organization',
  'What is the name and title of the primary point of contact for this program',
  'What is the email address of the primary contact person if people want to inquire about your program',
  'Describe the programs you have in place to distribute gender affirming clothing in a way you would be comfortable with us including verbatim on our website.  ',
  'If available include a link to the program on your website that describes your gender affirming clothing program that we can include on our website.',
  'What address info can we provide to our customers making returns to ensure packages can be received at your organization.',
  'Pick which size ranges you would like us to send',
  'How do people get gender affirming items from you? ',
  'Do you make occasional purchases for gender affirming gear?',
  'Would you be interested in joining an affiliate program where you could receive a credit towards future purchases at RUBIES when someone from your community orders using your code?\n',
];

const LIVE_ROW = [
  '3/22/2024 16:41:32', 'kori@lgbtcenterofraleigh.com', 'LGBT Center of Raleigh',
  'www.lgbtcenterofraleigh.com', 'Helicia Chiang - Operations Manager',
  'info@lgbtcenterofraleigh.com', 'The LGBT Center of Raleigh has a free closet.',
  'https://www.lgbtcenterofraleigh.com/trans', '3109 Poplarwood Court, Raleigh, NC 27604',
  'Youth sizes 4-8, Adult sizes XS - 4X', '', '', '',
];

test('every field on the live sheet resolves', () => {
  const { index, unmapped } = resolveSurveyColumns(LIVE_HEADERS, FIELDS, [LIVE_ROW]);
  assert.deepEqual(index, {
    timestamp: 0, submitter_email: 1, name: 2, website: 3, contact_name: 4,
    contact_email: 5, description: 6, program_url: 7, raw_address: 8,
    size_range: 9, distribution: 10, makes_purchases: 11, affiliate_interest: 12,
  });
  assert.deepEqual(unmapped, []);
});

// The failure this whole module exists to prevent: a question inserted in the
// middle used to shift every index after it, and the reader carried on parsing
// the address as the size range without throwing.
test('a question inserted in the middle changes nothing', () => {
  const headers = [...LIVE_HEADERS];
  const row = [...LIVE_ROW];
  headers.splice(4, 0, 'What is your organization phone number');
  row.splice(4, 0, '919-555-0100');
  const { index, unmapped } = resolveSurveyColumns(headers, FIELDS, [row]);
  assert.equal(index.raw_address, 9, 'the address moved with its header');
  assert.equal(index.size_range, 10);
  assert.deepEqual(unmapped.map(u => u.header), ['What is your organization phone number'],
    'a question nobody reads is reported, not silently dropped');
});

test('rewording, re-punctuating and fixing the typo all still resolve', () => {
  const reworded = [...LIVE_HEADERS];
  reworded[3] = "What's the website of your organization? (please include https://)";
  reworded[8] = 'What address info should we give customers making returns?';
  reworded[10] = 'How do people get gender affirming items from you these days?';
  const { index } = resolveSurveyColumns(reworded, FIELDS, []);
  assert.equal(index.website, 3);
  assert.equal(index.raw_address, 8);
  assert.equal(index.distribution, 10);
});

// Matching alone can drift onto the wrong column. Verification is the second
// signal, and the two have to agree.
test('a header that matches a column holding the wrong shape is refused', () => {
  const headers = [...LIVE_HEADERS];
  const rows = [
    ['not a date at all', 'kori@x.org', 'Org', 'www.x.org', 'A B', 'a@x.org', 'desc', '', 'addr', 'Youth', '', '', ''],
    ['also not a date', 'b@x.org', 'Org2', 'www.y.org', 'C D', 'c@x.org', 'desc', '', 'addr', 'Youth', '', '', ''],
    ['nor this', 'c@x.org', 'Org3', 'www.z.org', 'E F', 'd@x.org', 'desc', '', 'addr', 'Youth', '', '', ''],
  ];
  assert.throws(() => resolveSurveyColumns(headers, FIELDS, rows), /timestamp: matched .* wrong shape/);
});

test('a required question that no longer exists fails loudly, naming the headers', () => {
  const headers = LIVE_HEADERS.filter(h => !/address info/.test(h));
  assert.throws(() => resolveSurveyColumns(headers, FIELDS, []), (e) => {
    assert.match(e.message, /raw_address: no column matched/);
    assert.match(e.message, /Headers on the sheet:/, 'the error has to show what IS there');
    return true;
  });
});

test('a duplicated question is refused rather than resolved to the first', () => {
  const headers = [...LIVE_HEADERS, 'Pick which size ranges you would like us to send (updated)'];
  assert.throws(() => resolveSurveyColumns(headers, FIELDS, []), /size_range: 2 columns matched/);
});

test('a question added today, with no answers yet, verifies vacuously', () => {
  // Every partner on file predates these three questions. An empty column must
  // read as "not answered", never as a failed match.
  const { index } = resolveSurveyColumns(LIVE_HEADERS, FIELDS, [LIVE_ROW]);
  assert.equal(index.affiliate_interest, 12);
});

test('one malformed answer among many does not condemn the column', () => {
  const rows = Array.from({ length: 6 }, () => [...LIVE_ROW]);
  rows[0][1] = 'no email given';
  const { index } = resolveSurveyColumns(LIVE_HEADERS, FIELDS, rows);
  assert.equal(index.submitter_email, 1);
});

test('normalizeHeader strips case, punctuation and trailing newlines', () => {
  assert.equal(normalizeHeader("What's the WEBSITE of you organization?  \n"), 'what s the website of you organization');
});

// ---------------------------------------------------------------------------
// The multi-select → type mapping
// ---------------------------------------------------------------------------

test('the distribution answer maps on meaning, not on the option strings', () => {
  // The options are operator text and will be reworded; "Other" lets an org
  // type its own sentence entirely.
  assert.equal(programTypeFromDistribution('They visit us during our open hours'), 'standing_closet');
  assert.equal(programTypeFromDistribution('They ask us, and we hand it over or post it'), 'by_request');
  assert.equal(programTypeFromDistribution('Our staff pass items on privately'), 'by_request');
  assert.equal(programTypeFromDistribution('We take items to events'), 'events');
  assert.equal(programTypeFromDistribution('folks drop in whenever we are open'), 'standing_closet');
  assert.equal(programTypeFromDistribution('we bring them to Pride every June'), 'events');
});

test('several ticks collapse to the most open door they have', () => {
  // Orgs routinely do two: hands gear out on request AND runs a closet event
  // each October. A type is one value, so it reports the widest access.
  assert.equal(
    programTypeFromDistribution('They ask us and we post it, We take items to events'),
    'by_request',
  );
  assert.equal(
    programTypeFromDistribution('We take items to events, They visit us during our open hours'),
    'standing_closet',
  );
});

test('an unrecognised answer is unknown, never a guess', () => {
  assert.equal(programTypeFromDistribution('it varies a lot honestly'), 'unknown');
  assert.equal(programTypeFromDistribution(null), null, 'unanswered is not the same as unrecognised');
  assert.equal(programTypeFromDistribution(''), null);
});
