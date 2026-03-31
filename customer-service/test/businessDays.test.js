/**
 * Unit tests for shared/businessDays.js — US holidays + business day math.
 *
 * Run: node --test customer-service/test/businessDays.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isBusinessDay, businessDaysBetween, addBusinessDays, getUSHolidays } = require('../../shared/businessDays');

// Helper: create local-timezone date to avoid UTC midnight → wrong day issues
function localDate(y, m, d) { return new Date(y, m - 1, d); }
function dateStr(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

describe('US Holiday detection', () => {
  const holidays2026 = getUSHolidays(2026);

  it('includes New Year\'s Day', () => {
    assert.ok(holidays2026.has('2026-01-01'));
  });

  it('includes MLK Day (3rd Monday of Jan)', () => {
    assert.ok(holidays2026.has('2026-01-19'));
  });

  it('includes Presidents\' Day (3rd Monday of Feb)', () => {
    assert.ok(holidays2026.has('2026-02-16'));
  });

  it('includes Memorial Day (last Monday of May)', () => {
    assert.ok(holidays2026.has('2026-05-25'));
  });

  it('includes Juneteenth', () => {
    assert.ok(holidays2026.has('2026-06-19'));
  });

  it('includes Independence Day (observed — Jul 4 is Saturday → Jul 3 Friday)', () => {
    assert.ok(holidays2026.has('2026-07-03'));
  });

  it('includes Labor Day (1st Monday of Sep)', () => {
    assert.ok(holidays2026.has('2026-09-07'));
  });

  it('includes Thanksgiving (4th Thursday of Nov)', () => {
    assert.ok(holidays2026.has('2026-11-26'));
  });

  it('includes day after Thanksgiving', () => {
    assert.ok(holidays2026.has('2026-11-27'));
  });

  it('includes Christmas (observed — Dec 25 is Friday)', () => {
    assert.ok(holidays2026.has('2026-12-25'));
  });

  it('does not include a random Tuesday', () => {
    assert.ok(!holidays2026.has('2026-03-17'));
  });
});

describe('isBusinessDay', () => {
  it('returns true for a normal weekday', () => {
    assert.ok(isBusinessDay(localDate(2026, 3, 17))); // Tuesday
  });

  it('returns false for Saturday', () => {
    assert.ok(!isBusinessDay(localDate(2026, 3, 21))); // Saturday
  });

  it('returns false for Sunday', () => {
    assert.ok(!isBusinessDay(localDate(2026, 3, 22))); // Sunday
  });

  it('returns false for Christmas', () => {
    assert.ok(!isBusinessDay(localDate(2026, 12, 25))); // Friday
  });

  it('returns false for Thanksgiving', () => {
    assert.ok(!isBusinessDay(localDate(2026, 11, 26))); // Thursday
  });
});

describe('businessDaysBetween', () => {
  it('counts weekdays correctly (Mon to Fri = 4)', () => {
    assert.equal(businessDaysBetween('2026-03-16', '2026-03-20'), 4);
  });

  it('skips weekends (Mon to next Mon = 5)', () => {
    assert.equal(businessDaysBetween('2026-03-16', '2026-03-23'), 5);
  });

  it('skips holidays (week with Thanksgiving)', () => {
    // Mon Nov 23 to Mon Nov 30 = 5 weekdays minus Thu+Fri (Thanksgiving) = 3
    assert.equal(businessDaysBetween('2026-11-23', '2026-11-30'), 3);
  });

  it('returns 0 for same day', () => {
    assert.equal(businessDaysBetween('2026-03-16', '2026-03-16'), 0);
  });
});

describe('addBusinessDays', () => {
  it('adds 1 business day (Mon → Tue)', () => {
    const result = addBusinessDays(localDate(2026, 3, 16), 1);
    assert.equal(dateStr(result), '2026-03-17');
  });

  it('skips weekend (Fri + 1 → Mon)', () => {
    const result = addBusinessDays(localDate(2026, 3, 20), 1);
    assert.equal(dateStr(result), '2026-03-23');
  });

  it('skips holiday (day before Thanksgiving + 1 → Mon after)', () => {
    // Wed Nov 25 + 1 biz day → skips Thu (Thanksgiving) + Fri (day after) + Sat + Sun → Mon Nov 30
    const result = addBusinessDays(localDate(2026, 11, 25), 1);
    assert.equal(dateStr(result), '2026-11-30');
  });

  it('adds 5 business days across a week (Mon → Mon)', () => {
    const result = addBusinessDays(localDate(2026, 3, 16), 5);
    assert.equal(dateStr(result), '2026-03-23');
  });
});
