/**
 * Unit tests for finance/lib/passportImportFreshness.js
 *
 * The fixture dates mirror the real gap found on 2026-08-11: the table's newest
 * invoice was 82006 (2026-06-24) while Nitro had since issued five more, the
 * latest dated 2026-07-29. At that point the import was 48 days behind and
 * nothing said so.
 *
 * Run: node --test finance/test/passportImportFreshness.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFreshnessItem,
  collectPassportFreshnessItems,
  STALE_DAYS,
  URGENT_DAYS,
} = require('../lib/passportImportFreshness');

const at = iso => Date.parse(`${iso}T00:00:00Z`);
const latest = (invoice_date, invoice_number = '82006') => ({ invoice_number, invoice_date });

describe('buildFreshnessItem', () => {
  it('stays silent while the newest invoice is inside the window', () => {
    assert.equal(buildFreshnessItem(latest('2026-08-01'), at('2026-08-11')), null);
  });

  it('stays silent on the master file\'s own normal lag', () => {
    // The 2026-08-11 pull was fully current with Nitro yet topped out at the
    // 2026-07-29 invoice. Being up to date must never raise an item.
    assert.equal(buildFreshnessItem(latest('2026-07-29', '83856'), at('2026-08-11')), null);
  });

  it('stays silent on the day before the threshold', () => {
    const now = at('2026-06-24') + (STALE_DAYS - 1) * 86400000;
    assert.equal(buildFreshnessItem(latest('2026-06-24'), now), null);
  });

  it('raises a non-urgent item exactly at the threshold', () => {
    const now = at('2026-06-24') + STALE_DAYS * 86400000;
    const item = buildFreshnessItem(latest('2026-06-24'), now);
    assert.ok(item, 'expected an item at the stale threshold');
    assert.equal(item.kind, 'passport_import_stale');
    assert.equal(item.urgent, false);
    assert.match(item.text, new RegExp(`${STALE_DAYS}d behind`));
  });

  it('escalates to urgent once a month has passed', () => {
    const now = at('2026-06-24') + URGENT_DAYS * 86400000;
    const item = buildFreshnessItem(latest('2026-06-24'), now);
    assert.equal(item.urgent, true);
  });

  it('reproduces the Aug 2026 gap: 48 days behind, urgent, names the invoice', () => {
    const item = buildFreshnessItem(latest('2026-06-24', '82006'), at('2026-08-11'));
    assert.ok(item);
    assert.equal(item.urgent, true);
    assert.match(item.text, /48d behind/);
    assert.match(item.text, /82006/);
    assert.match(item.text, /2026-06-24/);
  });

  it('points at the importer and steers away from --force', () => {
    const item = buildFreshnessItem(latest('2026-06-24'), at('2026-08-11'));
    assert.match(item.action, /importPassportInvoices\.js/);
    assert.match(item.action, /passport-audit-acknowledged\.json/);
    assert.match(item.action, /rather than reaching for --force/);
  });

  it('returns null when the table is empty or the date is missing', () => {
    assert.equal(buildFreshnessItem(null, at('2026-08-11')), null);
    assert.equal(buildFreshnessItem({ invoice_number: '1' }, at('2026-08-11')), null);
  });

  it('keys on invoice_date, so re-importing an old file does not reset the clock', () => {
    // Same stale invoice_date, evaluated later — the item must persist and age.
    const first = buildFreshnessItem(latest('2026-06-24'), at('2026-08-11'));
    const later = buildFreshnessItem(latest('2026-06-24'), at('2026-08-21'));
    assert.match(first.text, /48d behind/);
    assert.match(later.text, /58d behind/);
  });
});

describe('collectPassportFreshnessItems', () => {
  /** Minimal PostgREST-shaped stub: every builder method returns `this`. */
  const stubClient = result => {
    const chain = {
      select: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => Promise.resolve(result),
    };
    return { from: () => chain };
  };

  it('returns no items when the query errors', async () => {
    const items = await collectPassportFreshnessItems(stubClient({ data: null, error: { message: 'boom' } }));
    assert.deepEqual(items, []);
  });

  it('returns no items when the table is empty', async () => {
    const items = await collectPassportFreshnessItems(stubClient({ data: [], error: null }));
    assert.deepEqual(items, []);
  });

  it('returns no items when the newest invoice is recent', async () => {
    const recent = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const items = await collectPassportFreshnessItems(
      stubClient({ data: [{ invoice_number: '83856', invoice_date: recent }], error: null }));
    assert.deepEqual(items, []);
  });

  it('returns one item when the newest invoice is stale', async () => {
    const old = new Date(Date.now() - (URGENT_DAYS + 5) * 86400000).toISOString().slice(0, 10);
    const items = await collectPassportFreshnessItems(
      stubClient({ data: [{ invoice_number: '82006', invoice_date: old }], error: null }));
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'passport_import_stale');
    assert.equal(items[0].urgent, true);
  });
});
