/**
 * Unit tests for freeSwimwearSheet.findSheetRow — locating a sheet row by the
 * stable (timestamp, email) identity rather than a volatile row number.
 *
 * Run: node --test customer-service/test/freeSwimwearSheet.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { findSheetRow } = require('../lib/freeSwimwearSheet');

const HEADER = ['Timestamp', 'Email Address'];

describe('findSheetRow', () => {
  it('finds the 1-indexed row by timestamp + email', () => {
    const ab = [
      HEADER,
      ['2026-06-21T19:35:44Z', 'a@x.com'],          // row 2
      ['2020-03-16T02:56:23Z', 'b@x.com'],          // row 3
      ['2026-06-26T21:13:08.032Z', 'mary@x.com'],   // row 4
    ];
    assert.deepEqual(findSheetRow(ab, { email: 'mary@x.com', submitted_at: '2026-06-26T21:13:08.032Z' }), { row: 4 });
  });

  it('matches when the DB submitted_at uses +00:00 instead of Z (same instant)', () => {
    const ab = [HEADER, ['6/28/2026 22:00:56', 'jamie@bridgecard.app']];
    // parseTimestamp(cell) → "2026-06-29T02:00:56.000Z"; DB returns "+00:00" form
    assert.deepEqual(findSheetRow(ab, { email: 'jamie@bridgecard.app', submitted_at: '2026-06-29T02:00:56+00:00' }), { row: 2 });
  });

  it('is robust to re-sorting (finds by identity, not position)', () => {
    const reordered = [
      HEADER,
      ['2026-06-26T21:13:08.032Z', 'mary@x.com'],   // mary moved to the top
      ['2026-06-21T19:35:44Z', 'a@x.com'],
      ['2020-03-16T02:56:23Z', 'b@x.com'],
    ];
    assert.deepEqual(findSheetRow(reordered, { email: 'mary@x.com', submitted_at: '2026-06-26T21:13:08.032Z' }), { row: 2 });
  });

  it('matches email case-insensitively', () => {
    const ab = [HEADER, ['2026-06-26T21:13:08.032Z', 'Mary@X.com']];
    assert.deepEqual(findSheetRow(ab, { email: 'mary@x.com', submitted_at: '2026-06-26T21:13:08.032Z' }), { row: 2 });
  });

  it('errors (never guesses) when no row matches', () => {
    const ab = [HEADER, ['2026-06-21T19:35:44Z', 'a@x.com']];
    assert.ok(findSheetRow(ab, { email: 'nobody@x.com', submitted_at: '2026-06-26T21:13:08.032Z' }).error);
  });

  it('errors when more than one row matches (ambiguous)', () => {
    const ab = [
      HEADER,
      ['2026-06-26T21:13:08.032Z', 'dup@x.com'],
      ['2026-06-26T21:13:08.032Z', 'dup@x.com'],
    ];
    const r = findSheetRow(ab, { email: 'dup@x.com', submitted_at: '2026-06-26T21:13:08.032Z' });
    assert.ok(r.error);
    assert.match(r.error, /2 sheet rows/);
  });
});
