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
