/**
 * companyLocation — the one answer to "their timezone", and the update that
 * keeps the stored column in step with the location without ever touching an
 * operator's override. Pure where it can be; the write path runs against a
 * tiny in-memory stand-in for the Supabase client.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  resolveCompanyTimeZone, timezonePatchFor, placeLine, updateCompanyLocation, isMissingTimezoneColumn,
} = require('../../b2b-outreach/lib/companyLocation');

/** A stand-in Supabase client over one row. Records what was written. */
function fakeSb(row, { failTimezoneColumn = false } = {}) {
  const state = { row: { ...row }, writes: [] };
  const chain = (result) => ({
    eq: () => chain(result), select: () => chain(result), maybeSingle: async () => result(),
  });
  state.sb = {
    from: () => ({
      select: () => chain(() => ({ data: { ...state.row }, error: null })),
      update: (patch) => chain(() => {
        if (failTimezoneColumn && ('timezone' in patch || 'timezone_source' in patch)) {
          return { data: null, error: { message: "Could not find the 'timezone' column of 'b2b_companies' in the schema cache" } };
        }
        state.writes.push(patch);
        state.row = { ...state.row, ...patch };
        return { data: { ...state.row }, error: null };
      }),
    }),
  };
  return state;
}

test('resolve: an operator-set zone wins over the location', () => {
  const r = resolveCompanyTimeZone({ region: 'TX', country: 'US', timezone: 'America/Los_Angeles', timezone_source: 'operator' });
  assert.deepStrictEqual([r.timeZone, r.source, r.stored], ['America/Los_Angeles', 'set by you', true]);
});

test('resolve: the location decides when nothing was set by hand, and a stored inferred zone does not override it', () => {
  const r = resolveCompanyTimeZone({ region: 'TX', country: 'US', timezone: 'America/New_York', timezone_source: 'inferred' });
  assert.strictEqual(r.timeZone, 'America/Chicago');
  assert.match(r.source, /inferred from/);
});

test('resolve: a stored inferred zone survives a blanked location; nothing at all is honestly unknown', () => {
  assert.strictEqual(resolveCompanyTimeZone({ country: 'US', timezone: 'America/Chicago', timezone_source: 'inferred' }).timeZone, 'America/Chicago');
  const none = resolveCompanyTimeZone({ country: 'US' });
  assert.strictEqual(none.timeZone, null);
  assert.match(none.reason, /spans several timezones/);
});

test('timezonePatchFor: what the column should hold, or null when it already does', () => {
  assert.deepStrictEqual(timezonePatchFor({ region: 'ON', country: 'CA' }), { timezone: 'America/Toronto', timezone_source: 'inferred' });
  assert.strictEqual(timezonePatchFor({ region: 'ON', country: 'CA', timezone: 'America/Toronto', timezone_source: 'inferred' }), null);
  assert.strictEqual(timezonePatchFor({ region: 'ON', country: 'CA', timezone: 'Europe/London', timezone_source: 'operator' }), null);
  // Location gone: the stale inferred zone is cleared.
  assert.deepStrictEqual(timezonePatchFor({ country: 'US', timezone: 'America/Chicago', timezone_source: 'inferred' }), { timezone: null, timezone_source: null });
});

test('placeLine joins what is known', () => {
  assert.strictEqual(placeLine({ city: 'Waco', region: 'TX', country: 'US' }), 'Waco, TX, US');
  assert.strictEqual(placeLine({ country: 'US' }), 'US');
  assert.strictEqual(placeLine({}), null);
});

test('update: setting the region stores the inferred zone alongside it', async () => {
  const st = fakeSb({ id: 'x', name: 'X', country: 'US', city: null, region: null, timezone: null, timezone_source: null });
  const r = await updateCompanyLocation(st.sb, { company_id: 'x', region: 'TX', city: 'Waco' });
  assert.deepStrictEqual(st.writes[0], { city: 'Waco', region: 'TX', timezone: 'America/Chicago', timezone_source: 'inferred', updated_at: st.writes[0].updated_at });
  assert.strictEqual(r.resolved.timeZone, 'America/Chicago');
  assert.strictEqual(r.warning, null);
});

test('update: an operator timezone is stored as such, and a later region change does not touch it', async () => {
  const st = fakeSb({ id: 'x', name: 'X', country: 'US', region: null, timezone: null, timezone_source: null });
  await updateCompanyLocation(st.sb, { company_id: 'x', timezone: 'America/Los_Angeles' });
  assert.deepStrictEqual([st.row.timezone, st.row.timezone_source], ['America/Los_Angeles', 'operator']);
  await updateCompanyLocation(st.sb, { company_id: 'x', region: 'TX' });
  assert.deepStrictEqual([st.row.region, st.row.timezone, st.row.timezone_source], ['TX', 'America/Los_Angeles', 'operator']);
  // Blank clears the override and the location decides again.
  const r = await updateCompanyLocation(st.sb, { company_id: 'x', timezone: '' });
  assert.deepStrictEqual([st.row.timezone, st.row.timezone_source], ['America/Chicago', 'inferred']);
  assert.match(r.resolved.source, /inferred from/);
});

test('update: an unrecognised zone is refused before anything is written', async () => {
  const st = fakeSb({ id: 'x', name: 'X', country: 'US' });
  await assert.rejects(() => updateCompanyLocation(st.sb, { company_id: 'x', timezone: 'Central' }), /not a timezone Intl recognises/);
  assert.strictEqual(st.writes.length, 0);
});

test('update: nothing changed writes nothing', async () => {
  const st = fakeSb({ id: 'x', name: 'X', country: 'US', region: 'TX', timezone: 'America/Chicago', timezone_source: 'inferred' });
  const r = await updateCompanyLocation(st.sb, { company_id: 'x', region: 'TX' });
  assert.deepStrictEqual(r.changed, []);
  assert.strictEqual(st.writes.length, 0);
});

test('update: before the migration, the location still saves and the result says what did not', async () => {
  const st = fakeSb({ id: 'x', name: 'X', country: 'US', region: null }, { failTimezoneColumn: true });
  const r = await updateCompanyLocation(st.sb, { company_id: 'x', region: 'TX' });
  assert.deepStrictEqual(st.writes.map(w => Object.keys(w).filter(k => k !== 'updated_at')), [['region']]);
  assert.match(r.warning, /migrations-2026-09-09-b2b-company-timezone\.sql/);
  // Only a timezone to save, and no column: that is an error, not a silent no-op.
  await assert.rejects(() => updateCompanyLocation(st.sb, { company_id: 'x', timezone: 'America/Chicago' }), /no timezone column/);
  assert.strictEqual(isMissingTimezoneColumn({ message: 'column b2b_companies.timezone does not exist' }), true);
  assert.strictEqual(isMissingTimezoneColumn({ message: 'permission denied' }), false);
});
