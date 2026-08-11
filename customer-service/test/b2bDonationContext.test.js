const test = require('node:test');
const assert = require('node:assert');

const {
  renderDonationFacts, renderContext, fetchDonationRouting,
} = require('../../b2b-outreach/lib/outreachAdvisor');

const QUEUE_ENTRY = { tier: 3, reason: 'back_to_school window', message_type: 'community_checkin' };

function baseCtx(overrides = {}) {
  return {
    company: { name: 'Test Org', relationship_type: 'lgbtq_org', country: 'United States' },
    contacts: [],
    messages: [],
    donation: null,
    ...overrides,
  };
}

test('renderDonationFacts is empty when the org is not a matched partner', () => {
  assert.deepStrictEqual(renderDonationFacts(null), []);
});

test('renderDonationFacts states the count, item total and both dates', () => {
  const out = renderDonationFacts({
    shipments: 13, items: 36,
    firstAt: '2026-05-03T10:00:00Z', lastAt: '2026-08-04T10:00:00Z',
  }).join('\n');
  assert.match(out, /13 packages routed, 36 items in total/);
  assert.match(out, /First on 2026-05-03, most recently on 2026-08-04/);
});

test('renderDonationFacts singularises a single package', () => {
  const out = renderDonationFacts({
    shipments: 1, items: 1, firstAt: '2026-07-02T00:00:00Z', lastAt: '2026-07-02T00:00:00Z',
  }).join('\n');
  assert.match(out, /1 package routed, 1 item in total/);
  assert.doesNotMatch(out, /1 packages|1 items/);
});

test('renderDonationFacts never lets the advisor assert receipt', () => {
  const out = renderDonationFacts({
    shipments: 5, items: 9, firstAt: '2026-05-01T00:00:00Z', lastAt: '2026-08-01T00:00:00Z',
  }).join('\n');
  assert.match(out, /not confirmation they arrived/);
});

test('renderDonationFacts flags a zero-shipment partner instead of staying silent', () => {
  const out = renderDonationFacts({ shipments: 0, items: 0, firstAt: null, lastAt: null }).join('\n');
  assert.match(out, /No donation packages have been routed/);
  assert.match(out, /Do NOT imply packages have been arriving/);
});

test('renderDonationFacts calls out low volume so the advisor acknowledges it', () => {
  const low = renderDonationFacts({
    shipments: 2, items: 5, firstAt: '2026-05-26T00:00:00Z', lastAt: '2026-07-11T00:00:00Z',
  }).join('\n');
  assert.match(low, /low volume\. Acknowledge it directly/);

  const high = renderDonationFacts({
    shipments: 12, items: 27, firstAt: '2026-05-01T00:00:00Z', lastAt: '2026-07-29T00:00:00Z',
  }).join('\n');
  assert.doesNotMatch(high, /low volume/);
});

test('renderContext states 50% for US and Australian orgs', () => {
  for (const country of ['United States', 'Australia']) {
    const out = renderContext(baseCtx({
      company: { name: 'O', relationship_type: 'lgbtq_org', country },
    }), QUEUE_ENTRY);
    assert.match(out, /Partner purchase discount: 50% off retail/, country);
  }
});

test('renderContext states 30% everywhere else, including unknown countries', () => {
  for (const country of ['Canada', 'Germany', 'Switzerland', 'United Kingdom', null]) {
    const out = renderContext(baseCtx({
      company: { name: 'O', relationship_type: 'lgbtq_org', country },
    }), QUEUE_ENTRY);
    assert.match(out, /Partner purchase discount: 30% off retail/, String(country));
  }
});

// BAGLY (Boston) rendered as 30% because its company row carries no country,
// silently under-quoting a US partner. The registry knows where they are.
test('renderContext falls back to the partner registry country when the company row is bare', () => {
  const out = renderContext(baseCtx({
    company: { name: 'BAGLY', relationship_type: 'lgbtq_org', country: null },
    donation: {
      partner: { country_code: 'US' },
      shipments: 13, items: 36, firstAt: '2026-05-03T00:00:00Z', lastAt: '2026-08-04T00:00:00Z',
    },
  }), QUEUE_ENTRY);
  assert.match(out, /Partner purchase discount: 50% off retail/);
});

test('renderContext prefers the company country over the registry when both exist', () => {
  const out = renderContext(baseCtx({
    company: { name: 'O', relationship_type: 'lgbtq_org', country: 'Canada' },
    donation: { partner: { country_code: 'US' }, shipments: 0, items: 0, firstAt: null, lastAt: null },
  }), QUEUE_ENTRY);
  assert.match(out, /Partner purchase discount: 30% off retail/);
});

test('renderContext lets a signed agreement override the country rate', () => {
  const out = renderContext(baseCtx(), QUEUE_ENTRY);
  assert.match(out, /signed agreement at a different rate, that agreement wins/);
});

test('renderContext folds donation facts into the company block', () => {
  const out = renderContext(baseCtx({
    donation: { shipments: 7, items: 22, firstAt: '2026-05-21T00:00:00Z', lastAt: '2026-08-05T00:00:00Z' },
  }), QUEUE_ENTRY);
  assert.match(out, /## Donation closet: what we have actually shipped them/);
  assert.match(out, /7 packages routed, 22 items/);
});

test('renderContext omits the donation block entirely for a non-partner', () => {
  const out = renderContext(baseCtx(), QUEUE_ENTRY);
  assert.doesNotMatch(out, /Donation closet: what we have actually shipped/);
});

// The name fallback that fused Trans Healthkit Projekt (Hagen) onto Transhealth
// (Northampton MA) is exactly how one org's shipment counts end up in another
// org's email. Domain match only, and no match means no facts.
test('fetchDonationRouting matches on domain and ignores similar names', async () => {
  const partners = [
    { id: 20, name: 'Trans Healthkit Projekt', website_url: 'https://thprojekt.wordpress.com/thp-en/', country_code: 'DE' },
    { id: 99, name: 'Transhealth', website_url: 'https://transhealth.org', country_code: 'US' },
  ];
  const sb = {
    from(table) {
      if (table === 'donation_partners') {
        return { select: () => ({ eq: async () => ({ data: partners, error: null }) }) };
      }
      if (table === 'donation_routings') {
        // fetchAllPaginated closes with .range(), so the stub must terminate:
        // rows on the first page, empty on every page after it.
        return { select: () => ({ eq: (_c, id) => ({ order: () => ({
          range: async (from) => ({
            data: (id === 20 && from === 0) ? [{ items_count: 3, created_at: '2026-07-02T00:00:00Z' }] : [],
            error: null,
          }),
        }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  const matched = await fetchDonationRouting(sb, { website: 'https://thprojekt.wordpress.com/thp-en/' });
  assert.strictEqual(matched.partner.id, 20);
  assert.strictEqual(matched.shipments, 1);
  assert.strictEqual(matched.items, 3);

  // A name-similar org on a different domain must not inherit those shipments.
  const unrelated = await fetchDonationRouting(sb, { website: 'https://transhealthkit-projekt.de' });
  assert.strictEqual(unrelated, null);
});

test('fetchDonationRouting returns null when the company has no website', async () => {
  const sb = { from() { throw new Error('should not query'); } };
  assert.strictEqual(await fetchDonationRouting(sb, { website: null }), null);
});
