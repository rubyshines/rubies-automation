const test = require('node:test');
const assert = require('node:assert');

const { renderContext } = require('../../b2b-outreach/lib/outreachAdvisor');

const QUEUE_ENTRY = { tier: 3, reason: 'October check-in', message_type: 'community_checkin' };
const NOW = new Date('2026-09-11T12:00:00Z');

function ctx(company = {}) {
  return {
    company: { name: 'Test Org', relationship_type: 'lgbtq_org', country: 'United States', ...company },
    contacts: [],
    messages: [],
    donation: null,
  };
}

// An org with an open door and an org that hands gear over by appointment need
// different emails; the advisor was asking them both the same question because
// the answer was only ever inside a call recording.
test('a standing closet reaches the advisor as a sentence, not a slug', () => {
  const out = renderContext(ctx({
    program_profile: {
      type: 'standing_closet',
      line: 'Free closet, walk-ins welcome.',
      sources: [{ kind: 'survey', at: '2026-03-20' }],
    },
  }), QUEUE_ENTRY, null, NOW);
  assert.match(out, /Their own programme: they run a standing closet/);
  assert.match(out, /Free closet, walk-ins welcome\./);
  assert.doesNotMatch(out, /standing_closet/, 'the slug is ours, not something to write to a partner');
});

test('by_request says explicitly that there is no open door', () => {
  const out = renderContext(ctx({
    program_profile: { type: 'by_request', line: 'Counsellors hand out codes privately.', sources: [{ kind: 'call', at: '2026-09-10' }] },
  }), QUEUE_ENTRY, null, NOW);
  assert.match(out, /no open door/);
});

// The 2026-09-08 rule: any context that reasons about elapsed time must say what
// today is AND date the facts inside it, or an old status reads as current.
test('the programme line is dated and told not to assert it still holds', () => {
  const out = renderContext(ctx({
    program_profile: { type: 'events', line: 'Pop-ups twice a year.', sources: [{ kind: 'email', at: '2022-10-21' }] },
  }), QUEUE_ENTRY, null, NOW);
  assert.match(out, /as of 2022-10-21/);
  assert.match(out, /not as if it still holds/);
});

// The 2026-08-28 rule: an absent fact is not neutral — say which kind of nothing
// it is. Silence here would read to the advisor as "they run nothing", which is
// a different and wrong thing to write to an org that runs a closet.
test('an org with no profile is told the profile is missing, not that it has none', () => {
  const out = renderContext(ctx(), QUEUE_ENTRY, null, NOW);
  assert.match(out, /Their own programme: not on record/);
  assert.match(out, /NOT the same as them running nothing/);
});

test('unknown is the same answer as absent', () => {
  const out = renderContext(ctx({ program_profile: { type: 'unknown', line: null, sources: [] } }), QUEUE_ENTRY, null, NOW);
  assert.match(out, /Their own programme: not on record/);
});

// Retailers have a shop, not a programme. The missing-profile line would be
// noise on every wholesale draft.
test('a retailer gets no programme line at all', () => {
  const out = renderContext({
    company: { name: 'Test Shop', relationship_type: 'wholesale', country: 'United States' },
    contacts: [], messages: [], donation: null,
  }, { tier: 3, reason: 'reorder nudge', message_type: 'reorder_nudge' }, null, NOW);
  assert.doesNotMatch(out, /Their own programme/);
});

// program_flags says which RUBIES programme they are IN; program_profile says
// what THEY run. Fusing them would let a first touch open as though a stranger
// were already a partner - the same failure enrich_facts was split out for.
test('their programme and our programmes stay separate lines', () => {
  const out = renderContext(ctx({
    program_flags: { donation_closet: true },
    program_profile: { type: 'no_program', line: 'Refers people on.', sources: [{ kind: 'call', at: '2026-09-10' }] },
  }), QUEUE_ENTRY, null, NOW);
  assert.match(out, /Programs: \{"donation_closet":true\}/);
  assert.match(out, /Their own programme: they hold and distribute nothing themselves/);
});
