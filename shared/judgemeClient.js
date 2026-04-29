/**
 * Judge.me API Client — singleton pattern
 *
 * Uses Node built-in fetch. Returns null if no API token configured.
 * Auth: api_token + shop_domain as query params on every request.
 */

require('dotenv').config();

const BASE_URL = 'https://judge.me/api/v1';

let client = null;

function getJudgemeClient() {
  if (client) return client;

  const apiToken = process.env.JUDGEME_API_TOKEN;
  const shopDomain = process.env.JUDGEME_SHOP_DOMAIN || process.env.SHOPIFY_STORE_URL;
  if (!apiToken || !shopDomain) return null;

  function authParams() {
    return `api_token=${encodeURIComponent(apiToken)}&shop_domain=${encodeURIComponent(shopDomain)}`;
  }

  async function apiFetch(path) {
    const separator = path.includes('?') ? '&' : '?';
    const url = `${BASE_URL}${path}${separator}${authParams()}`;
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Judge.me ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  // ── reviews ──────────────────────────────────────────────────────────

  /**
   * Fetch reviews with pagination.
   * @param {object} opts - { page, perPage, rating, productId }
   */
  async function getReviews({ page = 1, perPage = 100, rating, productId } = {}) {
    let path = `/reviews?page=${page}&per_page=${perPage}`;
    if (rating != null) path += `&rating=${rating}`;
    if (productId != null) path += `&product_id=${productId}`;
    const data = await apiFetch(path);
    return data.reviews || [];
  }

  /**
   * Fetch ALL reviews (paginate until empty).
   * @param {object} opts - { maxPages, perPage, since }
   * `since` is an ISO date string — stop paginating when we hit reviews older than this.
   */
  async function getAllReviews({ maxPages = 100, perPage = 100, since } = {}) {
    const all = [];
    let page = 1;
    let done = false;

    while (!done && page <= maxPages) {
      const reviews = await getReviews({ page, perPage });
      if (!reviews.length) break;

      for (const r of reviews) {
        if (since && r.created_at && r.created_at < since) {
          done = true;
          break;
        }
        all.push(r);
      }
      page++;
    }

    return all;
  }

  // ── counts ───────────────────────────────────────────────────────────

  /**
   * Get review count. Optionally filter by rating or productId.
   */
  async function getReviewCount({ rating, productId } = {}) {
    let path = '/reviews/count';
    const params = [];
    if (rating != null) params.push(`rating=${rating}`);
    if (productId != null) params.push(`product_id=${productId}`);
    if (params.length) path += `?${params.join('&')}`;
    const data = await apiFetch(path);
    return data.count || 0;
  }

  /**
   * Get rating distribution (count per star 1-5) and total.
   */
  async function getRatingDistribution() {
    const [total, r1, r2, r3, r4, r5] = await Promise.all([
      getReviewCount(),
      getReviewCount({ rating: 1 }),
      getReviewCount({ rating: 2 }),
      getReviewCount({ rating: 3 }),
      getReviewCount({ rating: 4 }),
      getReviewCount({ rating: 5 }),
    ]);

    const weightedSum = r1 * 1 + r2 * 2 + r3 * 3 + r4 * 4 + r5 * 5;
    const avgRating = total > 0 ? Math.round((weightedSum / total) * 100) / 100 : 0;

    return {
      total,
      distribution: { 1: r1, 2: r2, 3: r3, 4: r4, 5: r5 },
      avgRating,
    };
  }

  client = {
    apiFetch,
    getReviews,
    getAllReviews,
    getReviewCount,
    getRatingDistribution,
  };

  return client;
}

module.exports = { getJudgemeClient };
