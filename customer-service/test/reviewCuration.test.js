const { test, describe } = require('node:test');
const assert = require('node:assert');

const { partitionReviews } = require('../../scripts/analyseReviewDeclines');
const { parseJsonBlock } = require('../lib/reviewCuration');
const { toReviewRow } = require('../../review-tracking/daily-review-tracking');

// ---------------------------------------------------------------------------
// partitionReviews — the watermark logic that separates "deliberately passed
// over" from "never got to it". This is load-bearing: the tab frames the two
// piles completely differently, and getting it backwards would present a
// decline list as a backlog.
// ---------------------------------------------------------------------------

function r(id, { published = true, hidden = false, created_at, rating = 5 } = {}) {
  return { id, published, hidden, created_at, rating };
}

describe('partitionReviews', () => {
  test('splits unpublished reviews around the newest published one', () => {
    const reviews = [
      r(1, { published: true, created_at: '2026-01-01T00:00:00Z' }),
      r(2, { published: false, created_at: '2026-02-01T00:00:00Z' }), // before watermark → passed over
      r(3, { published: true, created_at: '2026-06-05T00:00:00Z' }), // watermark
      r(4, { published: false, created_at: '2026-07-01T00:00:00Z' }), // after → trailing
      r(5, { published: false, created_at: '2026-08-01T00:00:00Z' }), // after → trailing
    ];

    const p = partitionReviews(reviews);

    assert.equal(p.watermark, '2026-06-05T00:00:00Z');
    assert.deepEqual(p.published.map((x) => x.id), [1, 3]);
    assert.deepEqual(p.passedOver.map((x) => x.id), [2]);
    assert.deepEqual(p.trailing.map((x) => x.id), [4, 5]);
  });

  test('hidden reviews are reported separately, not inside passedOver', () => {
    const reviews = [
      r(1, { published: true, created_at: '2026-06-05T00:00:00Z' }),
      r(2, { published: false, hidden: true, created_at: '2026-01-01T00:00:00Z' }),
      r(3, { published: false, hidden: false, created_at: '2026-01-02T00:00:00Z' }),
    ];

    const p = partitionReviews(reviews);

    // Confidence differs: hidden means a human picked a reason, passed-over is a guess.
    assert.deepEqual(p.hidden.map((x) => x.id), [2]);
    assert.deepEqual(p.passedOver.map((x) => x.id), [3]);
  });

  test('a review created exactly at the watermark counts as trailing, not passed over', () => {
    const reviews = [
      r(1, { published: true, created_at: '2026-06-05T00:00:00Z' }),
      r(2, { published: false, created_at: '2026-06-05T00:00:00Z' }),
    ];

    const p = partitionReviews(reviews);

    assert.deepEqual(p.trailing.map((x) => x.id), [2]);
    assert.deepEqual(p.passedOver, []);
  });

  test('with nothing published yet, everything unpublished is trailing', () => {
    const reviews = [
      r(1, { published: false, created_at: '2026-01-01T00:00:00Z' }),
      r(2, { published: false, hidden: true, created_at: '2026-02-01T00:00:00Z' }),
    ];

    const p = partitionReviews(reviews);

    assert.equal(p.watermark, null);
    assert.equal(p.trailing.length, 2);
    assert.deepEqual(p.passedOver, []);
    assert.deepEqual(p.hidden, []);
  });

  test('treats a missing published flag as unpublished', () => {
    // The API omits nothing today, but a partial payload must never be read as
    // "this is live on the storefront".
    const reviews = [
      r(1, { published: true, created_at: '2026-06-05T00:00:00Z' }),
      { id: 2, created_at: '2026-07-01T00:00:00Z', rating: 5 },
    ];

    const p = partitionReviews(reviews);

    assert.deepEqual(p.published.map((x) => x.id), [1]);
    assert.deepEqual(p.trailing.map((x) => x.id), [2]);
  });

  test('handles an empty corpus without throwing', () => {
    const p = partitionReviews([]);
    assert.equal(p.watermark, null);
    assert.deepEqual(p.trailing, []);
  });
});

// ---------------------------------------------------------------------------
// parseJsonBlock — models wrap JSON in fences or prose often enough that the
// unwrapping is real logic, and a parse failure downgrades a recommendation.
// ---------------------------------------------------------------------------

describe('parseJsonBlock', () => {
  test('parses bare JSON', () => {
    assert.deepEqual(parseJsonBlock('{"recommendation":"hold"}'), { recommendation: 'hold' });
  });

  test('parses a fenced json block', () => {
    const text = 'Here you go:\n```json\n{"recommendation":"publish"}\n```\n';
    assert.deepEqual(parseJsonBlock(text), { recommendation: 'publish' });
  });

  test('parses a fenced block with no language tag', () => {
    assert.deepEqual(parseJsonBlock('```\n[{"n":1}]\n```'), [{ n: 1 }]);
  });

  test('parses an array wrapped in prose', () => {
    const text = 'Sure. [{"n":1,"audience":"kids"}] Let me know if you need more.';
    assert.deepEqual(parseJsonBlock(text), [{ n: 1, audience: 'kids' }]);
  });

  test('throws when there is no JSON at all', () => {
    assert.throws(() => parseJsonBlock('I could not do that.'), /No JSON found/);
  });
});

// ---------------------------------------------------------------------------
// toReviewRow — the mapping that used to silently drop publish state, which is
// how a 48-review backlog went unnoticed. Pin it.
// ---------------------------------------------------------------------------

describe('toReviewRow', () => {
  const apiReview = {
    id: 123,
    rating: 5,
    title: 'Great',
    body: 'Works well',
    reviewer: { name: 'Sam', email: 'sam@example.com' },
    product_external_id: 456,
    product_title: 'THE AJ',
    product_handle: 'the-aj',
    verified: 'verified-purchase',
    source: 'fulfillment',
    curated: 'ok',
    published: true,
    hidden: false,
    featured: false,
    has_published_pictures: true,
    has_published_videos: false,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
  };

  test('carries publish state through', () => {
    const row = toReviewRow(apiReview);
    assert.equal(row.published, true);
    assert.equal(row.hidden, false);
    assert.equal(row.featured, false);
    assert.equal(row.curated, 'ok');
  });

  test('an unpublished review maps to published:false', () => {
    const row = toReviewRow({ ...apiReview, published: false, hidden: true, curated: 'spam' });
    assert.equal(row.published, false);
    assert.equal(row.hidden, true);
  });

  test('missing state fields default to false rather than null', () => {
    // A null here would be read as "unknown" by the queue's .eq('published', false)
    // filter and silently drop the review out of the backlog.
    const { published, hidden, featured, ...withoutState } = apiReview;
    const row = toReviewRow(withoutState);
    assert.equal(row.published, false);
    assert.equal(row.hidden, false);
    assert.equal(row.featured, false);
  });

  test('maps identity and product fields', () => {
    const row = toReviewRow(apiReview);
    assert.equal(row.review_id, 123);
    assert.equal(row.reviewer_name, 'Sam');
    assert.equal(row.product_external_id, '456'); // stringified
    assert.equal(row.has_pictures, true);
  });
});

// ---------------------------------------------------------------------------
// setCurated — the only write we make to Judge.me. A wrong verb or a wrong
// `curated` value here either does nothing or takes a live review DOWN, so the
// request shape is worth pinning even though it's three lines.
// ---------------------------------------------------------------------------

describe('judgemeClient.setCurated', () => {
  function withStubbedFetch(fn) {
    const calls = [];
    const realFetch = global.fetch;
    const realToken = process.env.JUDGEME_API_TOKEN;
    const realShop = process.env.JUDGEME_SHOP_DOMAIN;

    process.env.JUDGEME_API_TOKEN = 'test-token';
    process.env.JUDGEME_SHOP_DOMAIN = 'test-shop.myshopify.com';
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"message":"ok"}' };
    };

    // The client is a module-level singleton, so it must be re-required after
    // the env is in place or it caches a null client from an earlier test file.
    delete require.cache[require.resolve('../../shared/judgemeClient')];
    const { getJudgemeClient } = require('../../shared/judgemeClient');

    return Promise.resolve(fn(getJudgemeClient(), calls)).finally(() => {
      global.fetch = realFetch;
      process.env.JUDGEME_API_TOKEN = realToken;
      if (realShop === undefined) delete process.env.JUDGEME_SHOP_DOMAIN;
      else process.env.JUDGEME_SHOP_DOMAIN = realShop;
      delete require.cache[require.resolve('../../shared/judgemeClient')];
    });
  }

  test('publish sends PUT with curated=ok', () => withStubbedFetch(async (client, calls) => {
    await client.publishReview(999);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'PUT');
    assert.match(calls[0].url, /\/reviews\/999\?/);
    assert.deepEqual(JSON.parse(calls[0].init.body), { curated: 'ok' });
  }));

  test('hide sends PUT with curated=spam', () => withStubbedFetch(async (client, calls) => {
    await client.hideReview(999);
    assert.deepEqual(JSON.parse(calls[0].init.body), { curated: 'spam' });
  }));

  test('rejects any curated value other than ok/spam', () => withStubbedFetch(async (client, calls) => {
    await assert.rejects(() => client.setCurated(1, 'published'), /must be 'ok' or 'spam'/);
    await assert.rejects(() => client.setCurated(1, true), /must be 'ok' or 'spam'/);
    assert.equal(calls.length, 0, 'no request should be sent for an invalid value');
  }));

  test('rejects a missing review id', () => withStubbedFetch(async (client, calls) => {
    await assert.rejects(() => client.setCurated(null, 'ok'), /reviewId is required/);
    assert.equal(calls.length, 0);
  }));

  test('reads still default to GET with no body', () => withStubbedFetch(async (client, calls) => {
    await client.getReviewCount();
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.body, undefined);
  }));

  test('an empty success body is not an error', () => {
    const realFetch = global.fetch;
    const realToken = process.env.JUDGEME_API_TOKEN;
    const realShop = process.env.JUDGEME_SHOP_DOMAIN;
    process.env.JUDGEME_API_TOKEN = 'test-token';
    process.env.JUDGEME_SHOP_DOMAIN = 'test-shop.myshopify.com';
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
    delete require.cache[require.resolve('../../shared/judgemeClient')];
    const { getJudgemeClient } = require('../../shared/judgemeClient');

    return getJudgemeClient().publishReview(1)
      .then((res) => assert.equal(res, null))
      .finally(() => {
        global.fetch = realFetch;
        process.env.JUDGEME_API_TOKEN = realToken;
        if (realShop === undefined) delete process.env.JUDGEME_SHOP_DOMAIN;
        else process.env.JUDGEME_SHOP_DOMAIN = realShop;
        delete require.cache[require.resolve('../../shared/judgemeClient')];
      });
  });
});

// ---------------------------------------------------------------------------
// Size join — resolving `unclear` from what the reviewer actually bought.
//
// The load-bearing rule is `informativeProducts`: a letter size only means
// "adult" on a product that ALSO sells youth numeric sizes. Chest pads are
// S/M/L for every age, and treating those as adult would tag children's
// purchases as adults across a whole product line.
// ---------------------------------------------------------------------------

const {
  buildCatalogueMaps, audienceFromLineItems, bareProductId, sizeTier,
} = require('../lib/reviewCuration');

describe('bareProductId', () => {
  test('strips the Shopify GID wrapper', () => {
    assert.equal(bareProductId('gid://shopify/Product/4831811928149'), '4831811928149');
  });

  test('leaves a bare numeric id alone', () => {
    // Judge.me returns the bare form; product_variants stores the GID. Both
    // must land on the same key or the join silently matches nothing.
    assert.equal(bareProductId(4831811928149), '4831811928149');
  });
});

describe('sizeTier', () => {
  test('numeric sizes are youth', () => {
    ['4', '8', '10', '14', '16'].forEach((s) => assert.equal(sizeTier(s), 'youth'));
  });

  test('letter sizes are adult', () => {
    ['XS', 'S', 'M', 'L', '1X', '3X'].forEach((s) => assert.equal(sizeTier(s), 'adult'));
  });

  test('no size is null, not a guess', () => {
    assert.equal(sizeTier(null), null);
    assert.equal(sizeTier(''), null);
  });
});

describe('buildCatalogueMaps', () => {
  const variants = [
    // Dual-tier garment: youth numerics AND adult letters.
    { shopify_variant_id: 1, shopify_product_id: 'gid://shopify/Product/100', sku: 'RUBY-BLK-8', title: 'Black / 8' },
    { shopify_variant_id: 2, shopify_product_id: 'gid://shopify/Product/100', sku: 'RUBY-BLK-L', title: 'Black / L' },
    // Letter-only accessory (chest pads: S/M/L for every age).
    { shopify_variant_id: 3, shopify_product_id: 'gid://shopify/Product/200', sku: 'PAD-NUD-S', title: 'Nude / S' },
    { shopify_variant_id: 4, shopify_product_id: 'gid://shopify/Product/200', sku: 'PAD-NUD-M', title: 'Nude / M' },
    // Youth-only garment.
    { shopify_variant_id: 5, shopify_product_id: 'gid://shopify/Product/300', sku: 'KID-BLK-6', title: 'Black / 6' },
  ];

  test('a dual-tier product is informative', () => {
    const m = buildCatalogueMaps(variants);
    assert.ok(m.informativeProducts.has('100'));
  });

  test('a letter-only product is NOT informative', () => {
    // This is the chest-pad case. Including it would read "bought size M" as
    // "adult" for a child's purchase.
    const m = buildCatalogueMaps(variants);
    assert.ok(!m.informativeProducts.has('200'));
  });

  test('a youth-only product is informative', () => {
    // Buying a youth-only item at all implies a child wearer.
    const m = buildCatalogueMaps(variants);
    assert.ok(m.informativeProducts.has('300'));
  });

  test('maps variants to their product and tier', () => {
    const m = buildCatalogueMaps(variants);
    assert.equal(m.variantToProduct.get('1'), '100');
    assert.equal(m.variantToTier.get('1'), 'youth');
    assert.equal(m.variantToTier.get('2'), 'adult');
  });
});

describe('audienceFromLineItems', () => {
  const variants = [
    { shopify_variant_id: 1, shopify_product_id: 'gid://shopify/Product/100', sku: 'RUBY-BLK-8', title: 'Black / 8' },
    { shopify_variant_id: 2, shopify_product_id: 'gid://shopify/Product/100', sku: 'RUBY-BLK-L', title: 'Black / L' },
    { shopify_variant_id: 3, shopify_product_id: 'gid://shopify/Product/200', sku: 'PAD-NUD-M', title: 'Nude / M' },
    { shopify_variant_id: 9, shopify_product_id: 'gid://shopify/Product/900', sku: 'OTHER-BLK-M', title: 'Black / M' },
    { shopify_variant_id: 10, shopify_product_id: 'gid://shopify/Product/900', sku: 'OTHER-BLK-8', title: 'Black / 8' },
  ];
  const maps = buildCatalogueMaps(variants);
  const review = { product_external_id: 100 };

  test('a youth size on that product means kids', () => {
    const r = audienceFromLineItems(review, [{ shopify_variant_id: 1, sku: 'RUBY-BLK-8' }], maps);
    assert.equal(r.audience, 'kids');
    assert.match(r.reason, /youth/);
  });

  test('an adult size on that product means adults', () => {
    const r = audienceFromLineItems(review, [{ shopify_variant_id: 2, sku: 'RUBY-BLK-L' }], maps);
    assert.equal(r.audience, 'adults');
  });

  test('both tiers of the SAME product abstains', () => {
    // Almost certainly a parent buying for a child and for themselves.
    // Guessing either way would be worse than leaving it unclear.
    const r = audienceFromLineItems(review, [
      { shopify_variant_id: 1, sku: 'RUBY-BLK-8' },
      { shopify_variant_id: 2, sku: 'RUBY-BLK-L' },
    ], maps);
    assert.equal(r.audience, null);
    assert.match(r.reason, /both youth and adult/);
  });

  test('ignores line items for OTHER products', () => {
    // The reviewer's adult purchase of a different product must not decide
    // the audience of a review about this one.
    const r = audienceFromLineItems(review, [{ shopify_variant_id: 9, sku: 'OTHER-BLK-M' }], maps);
    assert.equal(r.audience, null);
    assert.match(r.reason, /no matching order line/);
  });

  test('abstains entirely on a letter-only product', () => {
    const r = audienceFromLineItems({ product_external_id: 200 }, [{ shopify_variant_id: 3, sku: 'PAD-NUD-M' }], maps);
    assert.equal(r.audience, null);
    assert.match(r.reason, /does not indicate age/);
  });

  test('abstains when the reviewer has no orders at all', () => {
    const r = audienceFromLineItems(review, [], maps);
    assert.equal(r.audience, null);
  });

  test('matches a GID-stored product against a bare review product id', () => {
    // Regression: the first version of this join compared 'gid://...' to
    // '4831811928149' and resolved 0 of 414 while reporting success.
    const r = audienceFromLineItems({ product_external_id: '100' }, [{ shopify_variant_id: 1, sku: 'RUBY-BLK-8' }], maps);
    assert.equal(r.audience, 'kids');
  });
});

// ---------------------------------------------------------------------------
// Audience filtering — an unclassified review must not be invisible.
// ---------------------------------------------------------------------------

const { audienceFilterValues } = require('../lib/tools/reviewCuration');

describe('audienceFilterValues', () => {
  test('kids includes both and unclear', () => {
    assert.deepEqual(audienceFilterValues('kids'), ['kids', 'both', 'unclear']);
  });

  test('adults includes both and unclear', () => {
    assert.deepEqual(audienceFilterValues('adults'), ['adults', 'both', 'unclear']);
  });

  test('every review reachable from at least one of kids/adults', () => {
    // The property that matters: no stored audience value can hide a review
    // from BOTH shopper-facing filters.
    const reachable = new Set([...audienceFilterValues('kids'), ...audienceFilterValues('adults')]);
    ['kids', 'adults', 'both', 'unclear'].forEach((v) => assert.ok(reachable.has(v), `${v} is unreachable`));
  });

  test('unclear and both can still be isolated for moderation', () => {
    assert.deepEqual(audienceFilterValues('unclear'), ['unclear']);
    assert.deepEqual(audienceFilterValues('both'), ['both']);
  });
});
