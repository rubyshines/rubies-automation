const test = require('node:test');
const assert = require('node:assert');

const { lineFromDistribution, isYes, findCompanyForSubmission } = require('../../b2b-outreach/lib/surveyAnswers');
const { PROGRAMME_FLAGS } = require('../../b2b-outreach/sync/syncB2bCompanyState');

// A minimal Supabase stub: only the reads findCompanyForSubmission makes.
function stubSb(companies) {
  return {
    from: () => ({
      select: () => ({ eq: async () => ({ data: companies, error: null }) }),
    }),
  };
}

test('yes / no / unanswered are three different answers', () => {
  assert.equal(isYes('Yes, get in touch'), true);
  assert.equal(isYes('Maybe, but not right now'), true, 'maybe is interest, not a refusal');
  assert.equal(isYes('No thanks'), false);
  // Unanswered must never read as "no": every partner on file predates the
  // question, and a blank is silence, not a decline.
  assert.equal(isYes(null), null);
  assert.equal(isYes(''), null);
});

test('their ticks become the line, in their own words', () => {
  assert.equal(
    lineFromDistribution('They visit us during our open hours'),
    'They visit us during our open hours',
  );
  assert.equal(
    lineFromDistribution('They visit us during our open hours, We take items to events'),
    'They visit us during our open hours and we take items to events',
  );
  assert.equal(lineFromDistribution(null), null);
});

test('a long Other answer is truncated, never dropped', () => {
  // Refusing to record a real answer is worse than shortening it.
  const long = `x${'y'.repeat(300)}`;
  const line = lineFromDistribution(long);
  assert.ok(line.length <= 155);
  assert.ok(line.endsWith('...'));
});

test('the submission joins its company on domain', async () => {
  const sb = stubSb([
    { id: 'right', name: 'Somewhere Else', website: 'https://www.theorg.org/x' },
    { id: 'wrong', name: 'The Org', website: 'https://other.org' },
  ]);
  const hit = await findCompanyForSubmission(sb, { name: 'The Org', website: 'theorg.org' });
  assert.equal(hit.id, 'right', 'domain wins over a name that matches the other row');
});

test('a submission with no domain may match one company on name, never two', async () => {
  const one = stubSb([{ id: 'a', name: 'Trans Closet', website: null }]);
  assert.equal((await findCompanyForSubmission(one, { name: 'Trans Closet', website: null })).id, 'a');

  const two = stubSb([
    { id: 'a', name: 'Pride Center', website: null },
    { id: 'b', name: 'Pride Center', website: null },
  ]);
  assert.equal(await findCompanyForSubmission(two, { name: 'Pride Center', website: null }), null);
});

test('a submission whose org is not in the outreach book matches nothing', async () => {
  // Orgs routinely fill in the donation form before the outreach book has ever
  // heard of them. That is a note, not a failed ingest.
  const sb = stubSb([{ id: 'a', name: 'Someone', website: 'https://someone.org' }]);
  assert.equal(await findCompanyForSubmission(sb, { name: 'Newcomer', website: 'newcomer.org' }), null);
});

// ---------------------------------------------------------------------------
// The placement rules, asserted so they cannot be quietly undone
// ---------------------------------------------------------------------------

test('affiliate is a relationship-promoting flag, so interest must never be written to program_flags', () => {
  // PROGRAMME_FLAGS is read by computeCompanyState to promote relationship_state
  // to 'active', a promotion it never reverses. Someone ticking "I'd be
  // interested" is not a member of a programme that does not exist.
  assert.ok(PROGRAMME_FLAGS.includes('affiliate'),
    'if affiliate ever leaves PROGRAMME_FLAGS, revisit where interest is stored');
  const src = require('fs').readFileSync(require.resolve('../../b2b-outreach/lib/surveyAnswers.js'), 'utf8');
  assert.ok(!/program_flags/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
    'survey answers must not touch program_flags outside the comment explaining why');
});

test('the advisor is never given the affiliate answer', () => {
  // The affiliate programme does not exist and must never be offered
  // (2026-08-13, after the prompts described it as live for months). There is
  // nothing a draft can do with this answer except promise what we cannot give.
  const src = require('fs').readFileSync(require.resolve('../../b2b-outreach/lib/outreachAdvisor.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/affiliate_yes|affiliate_interest/.test(code),
    'affiliate interest is operator-only and must stay out of the advisor context');
});

test('the purchases answer does reach the advisor, both ways round', () => {
  const { renderContext } = require('../../b2b-outreach/lib/outreachAdvisor');
  const base = { contacts: [], messages: [], donation: null };
  const entry = { tier: 3, reason: 'October check-in', message_type: 'community_checkin' };
  const now = new Date('2026-09-11T12:00:00Z');

  const buys = renderContext({
    ...base,
    company: { name: 'O', relationship_type: 'lgbtq_org', metadata: { onboarding: { buys_gear: true, answered_at: '2026-09-12' } } },
  }, entry, null, now);
  assert.match(buys, /make occasional purchases/);
  assert.match(buys, /a real option to raise/);

  const doesNot = renderContext({
    ...base,
    company: { name: 'O', relationship_type: 'lgbtq_org', metadata: { onboarding: { buys_gear: false } } },
  }, entry, null, now);
  assert.match(doesNot, /do not pitch them a paid order/);

  // Unanswered says nothing at all, rather than implying they do not buy.
  const silent = renderContext({ ...base, company: { name: 'O', relationship_type: 'lgbtq_org' } }, entry, null, now);
  assert.doesNotMatch(silent, /occasional purchases/);
});
