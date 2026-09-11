const test = require('node:test');
const assert = require('node:assert');

const {
  PROGRAM_TYPES, isProgramType, evidenceThrough, isStale, programLine, MAX_LINE_CHARS,
} = require('../../b2b-outreach/lib/programProfile');

// The five shapes exist because the real data has five. Collapsing by_request
// into standing_closet would describe an appointment-only gear room as somewhere
// with an open door, which is exactly the distinction the line exists to make.
test('the type vocabulary is closed', () => {
  assert.deepEqual(Object.keys(PROGRAM_TYPES),
    ['standing_closet', 'by_request', 'events', 'no_program', 'unknown']);
  assert.ok(isProgramType('standing_closet'));
  assert.ok(!isProgramType('closet'));
  assert.ok(!isProgramType(undefined));
  // Inherited properties are not types.
  assert.ok(!isProgramType('constructor'));
});

test('the watermark is the newest piece of evidence, whatever order it arrives in', () => {
  const evidence = [
    { kind: 'email', at: '2024-05-01T00:00:00Z' },
    { kind: 'survey', at: '2026-03-20T00:00:00Z' },
    { kind: 'call', at: '2025-11-02T00:00:00Z' },
  ];
  assert.equal(evidenceThrough(evidence), '2026-03-20T00:00:00Z');
  assert.equal(evidenceThrough([]), null);
  assert.equal(evidenceThrough(undefined), null);
  // A piece with no timestamp must not become the answer.
  assert.equal(evidenceThrough([{ kind: 'email', at: null }]), null);
});

// Staleness is what stops a line written off a 2022 email from reading as
// current after a call last night says something different.
test('evidence landing after the reading marks the profile stale', () => {
  const evidence = [{ kind: 'call', at: '2026-09-10T00:00:00Z' }];
  const fresh = { type: 'events', line: 'x', evidence_through: '2026-09-10T00:00:00Z' };
  const old = { type: 'events', line: 'x', evidence_through: '2026-03-20T00:00:00Z' };
  assert.equal(isStale(fresh, evidence), false);
  assert.equal(isStale(old, evidence), true);
});

test('a profile with no watermark is stale the moment any evidence exists', () => {
  // It predates the watermark, so there is no way to know what it read. Treating
  // it as current would hide every pre-watermark row from the needs list forever.
  assert.equal(isStale({ type: 'events', line: 'x' }, [{ kind: 'call', at: '2026-09-10T00:00:00Z' }]), true);
  assert.equal(isStale(null, [{ kind: 'call', at: '2026-09-10T00:00:00Z' }]), true);
});

test('an org with no evidence is not stale — there is nothing to re-read', () => {
  assert.equal(isStale(null, []), false);
  assert.equal(isStale({ type: 'unknown' }, []), false);
});

test('the rendered line leads with the type and keeps the detail', () => {
  assert.equal(
    programLine({ type: 'standing_closet', line: 'Free closet, walk-ins welcome.' }),
    'standing closet · Free closet, walk-ins welcome.',
  );
  // A type with no detail still says the type: it is the orienting half.
  assert.equal(programLine({ type: 'events', line: null }), 'events');
});

test('unknown and absent both render as no line', () => {
  // The panel says "not on record" in its own words for these; a line saying
  // "programme unclear" would be one more thing to read that means nothing.
  assert.equal(programLine({ type: 'unknown', line: null }), null);
  assert.equal(programLine(null), null);
  assert.equal(programLine({ type: 'made_up', line: 'x' }), null);
});

// ---------------------------------------------------------------------------
// The backfill's own data, checked as data. A line too long for the panel or a
// type that does not exist would fail at write time, one row into a run of 83.
// ---------------------------------------------------------------------------
test('every classification in the backfill file is writable', () => {
  const { profiles } = require('../../b2b-outreach/data/program-profiles.json');
  assert.ok(profiles.length > 0);
  const seen = new Set();
  for (const p of profiles) {
    assert.ok(isProgramType(p.type), `${p.id}: unknown type ${p.type}`);
    assert.ok(!seen.has(p.id), `${p.id}: listed twice`);
    seen.add(p.id);
    if (p.line) {
      assert.ok(p.line.length <= MAX_LINE_CHARS, `${p.id}: line is ${p.line.length} characters`);
      assert.notEqual(p.type, 'unknown', `${p.id}: unknown must carry no line`);
    }
    for (const s of p.sources || []) {
      assert.ok(['survey', 'call', 'email'].includes(s.kind), `${p.id}: bad source kind ${s.kind}`);
      assert.match(String(s.at), /^\d{4}-\d{2}-\d{2}/, `${p.id}: source needs a date`);
    }
    assert.ok((p.sources || []).length > 0, `${p.id}: a reading with no source is a guess`);
  }
});

// The house rule for customer-facing copy. These lines are not customer-facing,
// but they feed the advisor's context, and an em dash there comes back out in a
// draft.
test('no em dashes in any programme line', () => {
  const { profiles } = require('../../b2b-outreach/data/program-profiles.json');
  for (const p of profiles) {
    if (p.line) assert.ok(!p.line.includes('—'), `${p.id}: em dash in the line`);
  }
});

// ---------------------------------------------------------------------------
// Joining a company to its donation_partners row
// ---------------------------------------------------------------------------
const { matchPartnerRow } = require('../../b2b-outreach/lib/programProfile');

test('domain wins whenever the company has one', () => {
  const partners = [
    { name: 'Same Name Org', website_url: 'https://wrong.org', description: 'wrong' },
    { name: 'Different Name', website_url: 'https://right.org', description: 'right' },
  ];
  const m = matchPartnerRow({ name: 'Same Name Org', website: 'https://www.right.org/x' }, partners);
  assert.equal(m.via, 'domain');
  assert.equal(m.row.description, 'right');
});

test('a company with a domain and no domain match gets nothing, never a name match', () => {
  // Name matching across these two stores has fused unrelated orgs before. A
  // company that HAS a domain and does not match on it is simply not a partner.
  const partners = [{ name: 'Some Org', website_url: 'https://other.org', description: 'x' }];
  assert.equal(matchPartnerRow({ name: 'Some Org', website: 'https://someorg.org' }, partners), null);
});

test('a company with no domain at all may match one partner on name', () => {
  // Some real partners have no website: McMinnville Trans Network's only
  // published link is a Bitly bio page pointing at Instagram. Without this,
  // their survey write-up — the best description of their programme we hold —
  // is unreachable.
  const partners = [{ name: 'McMinnville Trans Network', website_url: 'https://bit.ly/m/mactrans', description: 'closet' }];
  const m = matchPartnerRow({ name: 'McMinnville Trans Network', website: null }, partners);
  assert.equal(m.via, 'name');
  assert.equal(m.row.description, 'closet');
});

test('name matching normalises punctuation but not two different orgs', () => {
  const partners = [{ name: 'Trans* Open Wardrobe', website_url: null, description: 'x' }];
  assert.equal(matchPartnerRow({ name: 'Trans Open Wardrobe', website: null }, partners).via, 'name');
  assert.equal(matchPartnerRow({ name: 'Trans Open Closet', website: null }, partners), null);
});

test('two partners sharing a name match neither', () => {
  // The hazard of name matching is confidently picking the wrong org, so an
  // ambiguous name is an answer of "no", not "the first one".
  const partners = [
    { name: 'Pride Center', website_url: null, description: 'a' },
    { name: 'Pride Center', website_url: null, description: 'b' },
  ];
  assert.equal(matchPartnerRow({ name: 'Pride Center', website: null }, partners), null);
});

test('a company with neither domain nor name matches nothing', () => {
  assert.equal(matchPartnerRow({ name: '', website: null }, [{ name: '', website_url: null }]), null);
});
