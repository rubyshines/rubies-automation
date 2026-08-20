/**
 * Timezone inference tests.
 *
 * The load-bearing case is the NEGATIVE one: a multi-zone country with no
 * region must return null rather than a plausible zone. A wrong answer here is
 * not caught by anything downstream — it goes straight into "…, 1pm your time".
 */
const test = require('node:test');
const assert = require('node:assert');

const { timezoneFromLocation, normalizeCountry, normalizeRegion, isValidTimeZone } =
  require('../../b2b-outreach/lib/meetingTimezone');
const { renderConfirmationLine, meetingTitle } = require('../../b2b-outreach/lib/scheduleMeeting');

test('US states resolve, by code or by name', () => {
  assert.strictEqual(timezoneFromLocation({ region: 'MA', country: 'US' }).timeZone, 'America/New_York');
  assert.strictEqual(timezoneFromLocation({ region: 'Massachusetts', country: 'United States' }).timeZone, 'America/New_York');
  assert.strictEqual(timezoneFromLocation({ region: 'OR', country: 'USA' }).timeZone, 'America/Los_Angeles');
  assert.strictEqual(timezoneFromLocation({ region: 'Arizona', country: 'US' }).timeZone, 'America/Phoenix');
});

test('a multi-zone state answers, but says it is worth confirming', () => {
  const fl = timezoneFromLocation({ region: 'FL', country: 'US' });
  assert.strictEqual(fl.timeZone, 'America/New_York');
  assert.strictEqual(fl.split, true);
  assert.match(fl.reason, /more than one timezone/);

  const ma = timezoneFromLocation({ region: 'MA', country: 'US' });
  assert.strictEqual(ma.split, false);
  assert.strictEqual(ma.reason, null);
});

test('a multi-zone country with no region returns NO ANSWER, never a guess', () => {
  const us = timezoneFromLocation({ country: 'United States' });
  assert.strictEqual(us.timeZone, null);
  assert.strictEqual(us.source, 'unknown');
  assert.match(us.reason, /several timezones/);

  assert.strictEqual(timezoneFromLocation({ country: 'Canada' }).timeZone, null);
  assert.strictEqual(timezoneFromLocation({ country: 'Australia' }).timeZone, null);
  assert.strictEqual(timezoneFromLocation({ country: 'Brazil' }).timeZone, null);
});

test('single-zone countries resolve from the country alone', () => {
  assert.strictEqual(timezoneFromLocation({ country: 'Germany' }).timeZone, 'Europe/Berlin');
  assert.strictEqual(timezoneFromLocation({ country: 'DE' }).timeZone, 'Europe/Berlin');
  assert.strictEqual(timezoneFromLocation({ country: 'United Kingdom' }).timeZone, 'Europe/London');
  assert.strictEqual(timezoneFromLocation({ country: 'New Zealand' }).timeZone, 'Pacific/Auckland');
});

test('Canadian provinces and Australian states resolve', () => {
  assert.strictEqual(timezoneFromLocation({ region: 'NS', country: 'Canada' }).timeZone, 'America/Halifax');
  assert.strictEqual(timezoneFromLocation({ region: 'British Columbia', country: 'CA' }).timeZone, 'America/Vancouver');
  assert.strictEqual(timezoneFromLocation({ region: 'VIC', country: 'Australia' }).timeZone, 'Australia/Melbourne');
  assert.strictEqual(timezoneFromLocation({ region: 'Queensland', country: 'AU' }).timeZone, 'Australia/Brisbane');
});

test('a readable region rescues a row with no country', () => {
  // The imports left plenty of half-filled rows.
  const r = timezoneFromLocation({ region: 'Ontario' });
  assert.strictEqual(r.timeZone, 'America/Toronto');
  assert.match(r.source, /inferred from Ontario/);
});

test('nothing usable resolves to nothing, with a reason a human can act on', () => {
  const r = timezoneFromLocation({});
  assert.strictEqual(r.timeZone, null);
  assert.ok(r.reason);
  const junk = timezoneFromLocation({ region: 'Anywhere', country: 'Neverland' });
  assert.strictEqual(junk.timeZone, null);
});

test('an unmatched region in a multi-zone country does not fall back to the country', () => {
  // "Texas Panhandle" is not in the table; answering "America/Chicago" anyway
  // would be the guess this whole module exists to avoid.
  const r = timezoneFromLocation({ region: 'Somewhere Else', country: 'US' });
  assert.strictEqual(r.timeZone, null);
});

test('normalizers', () => {
  assert.strictEqual(normalizeCountry('U.S.A.'), 'US');
  assert.strictEqual(normalizeCountry('de'), 'DE');
  assert.strictEqual(normalizeCountry('Narnia'), null);
  assert.strictEqual(normalizeRegion('california', 'US'), 'CA');
  assert.strictEqual(normalizeRegion('CA', 'US'), 'CA');
  assert.strictEqual(normalizeRegion('nova scotia', 'CA'), 'NS');
  assert.strictEqual(isValidTimeZone('America/Toronto'), true);
  assert.strictEqual(isValidTimeZone('Mars/Olympus'), false);
  assert.strictEqual(isValidTimeZone(''), false);
});

test('the confirmation line states both zones, and stops', () => {
  const start = new Date('2026-08-25T18:00:00.000Z'); // 2pm ET, 11am Pacific
  const line = renderConfirmationLine({ start, theirTimeZone: 'America/Los_Angeles' });
  assert.match(line, /Tue 25 Aug/);
  assert.match(line, /2:00 PM Eastern/);
  assert.match(line, /11:00 AM your time/);
  // No narration of the mechanics — the rule that killed the old bloated
  // scheduling paragraph. It states a completed fact and ends.
  assert.ok(!/will send|going to|confirm back|Google Meet/i.test(line));
  assert.ok(line.length < 120);
});

test('the confirmation line drops the second zone when theirs is unknown', () => {
  const start = new Date('2026-08-25T18:00:00.000Z');
  const line = renderConfirmationLine({ start, theirTimeZone: null });
  assert.match(line, /2:00 PM Eastern/);
  assert.ok(!line.includes('your time'));
  // An invalid zone is treated as unknown rather than crashing the render.
  assert.ok(!renderConfirmationLine({ start, theirTimeZone: 'Mars/Olympus' }).includes('your time'));
});

test('meeting title', () => {
  assert.strictEqual(meetingTitle('Uniting Pride'), 'RUBIES x Uniting Pride');
  assert.strictEqual(meetingTitle('  Spectrum  '), 'RUBIES x Spectrum');
});
