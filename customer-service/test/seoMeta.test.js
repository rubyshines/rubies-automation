/**
 * Tests for the seo_meta_update / seo_meta_draft MCP tools.
 *
 * Covers validation rules in validateMeta() and the update handler's
 * Shopify mutation routing. Drafting (Anthropic call) is not unit-tested —
 * its output is reviewed by hand for the four collections in Phase 3.
 *
 * Run: node --test customer-service/test/seoMeta.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const shopifyPath = require.resolve('../lib/shopify');
const supabasePath = require.resolve('../../shared/supabaseClient');

let collectionUpdateCalls = [];
let productUpdateCalls = [];
let supabaseUpdateCalls = [];
let mockSyncedRow = null;

require.cache[shopifyPath] = {
  id: shopifyPath, filename: shopifyPath, loaded: true,
  exports: {
    updateCollectionSeo: async (input) => {
      collectionUpdateCalls.push(input);
      return {
        id: input.id,
        handle: input.handle ?? 'adults-bottoms',
        title: 'Adults Bottoms',
        descriptionHtml: input.descriptionHtml ?? null,
        seo: {
          title: input.seoTitle ?? null,
          description: input.seoDescription ?? null,
        },
      };
    },
    updateProductSeo: async (input) => {
      productUpdateCalls.push(input);
      return {
        id: input.id,
        handle: input.handle ?? 'the-aj-shaping-underwear',
        title: 'AJ',
        descriptionHtml: input.descriptionHtml ?? null,
        seo: {
          title: input.seoTitle ?? null,
          description: input.seoDescription ?? null,
        },
      };
    },
    getAdminUrl: (gid) => {
      const numericId = gid.split('/').pop();
      if (gid.includes('/Collection/')) return `https://admin.shopify.com/store/test/collections/${numericId}`;
      if (gid.includes('/Product/')) return `https://admin.shopify.com/store/test/products/${numericId}`;
      return `https://admin.shopify.com/store/test/orders/${numericId}`;
    },
  },
};

require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: {
    getSupabaseClient: () => ({
      from(table) {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => mockSyncedRow
                    ? { data: mockSyncedRow, error: null }
                    : { data: null, error: null },
                };
              },
            };
          },
          update(patch) {
            supabaseUpdateCalls.push({ table, patch });
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      },
    }),
    fetchAllPaginated: async (buildQuery) => {
      const { data, error } = await buildQuery().range(0, 999);
      if (error) throw new Error(`fetchAllPaginated: ${error.message}`);
      return data || [];
    },
  },
};

const { validateMeta, handleUpdate, pageUrlMatchesPath } = require('../lib/tools/seoMeta');

beforeEach(() => {
  collectionUpdateCalls = [];
  productUpdateCalls = [];
  supabaseUpdateCalls = [];
  mockSyncedRow = null;
});

describe('validateMeta', () => {
  it('rejects unknown type', () => {
    const errs = validateMeta({ type: 'page', title: 'foo' });
    assert.ok(errs.some(e => e.includes('type must be')));
  });

  it('rejects all-empty update', () => {
    const errs = validateMeta({ type: 'collection' });
    assert.ok(errs.some(e => e.includes('At least one of')));
  });

  it('rejects em dash in title', () => {
    const errs = validateMeta({ type: 'collection', title: 'Trans Underwear — RUBIES' });
    assert.ok(errs.some(e => e.includes('em dash')));
  });

  it('rejects em dash in description', () => {
    const errs = validateMeta({ type: 'collection', description: 'Soft and supportive — sizes XS-4XL.' });
    assert.ok(errs.some(e => e.includes('em dash')));
  });

  it('rejects title over 80 chars', () => {
    const long = 'A'.repeat(81);
    const errs = validateMeta({ type: 'collection', title: long });
    assert.ok(errs.some(e => /title is 81 chars/.test(e)));
  });

  it('rejects description over 165 chars', () => {
    const long = 'A'.repeat(166);
    const errs = validateMeta({ type: 'collection', description: long });
    assert.ok(errs.some(e => /description is 166 chars/.test(e)));
  });

  it('rejects bad handle characters', () => {
    const errs = validateMeta({ type: 'collection', newHandle: 'Adults Bottoms!' });
    assert.ok(errs.some(e => e.includes('lowercase alphanumeric')));
  });

  it('rejects handle starting with hyphen', () => {
    const errs = validateMeta({ type: 'collection', newHandle: '-adults-bottoms' });
    assert.ok(errs.some(e => e.includes('lowercase alphanumeric')));
  });

  it('accepts valid handle', () => {
    const errs = validateMeta({ type: 'collection', newHandle: 'adults-bottoms' });
    assert.deepEqual(errs, []);
  });

  it('accepts en dash in title (used for size ranges)', () => {
    const errs = validateMeta({
      type: 'collection',
      title: 'No-Tuck Bottoms for Trans Women | RUBIES',
      description: 'Bottoms for trans women and teens. Sizes XS–4XL. 60-day guarantee.',
    });
    assert.deepEqual(errs, []);
  });

  it('accepts boundary-length title and description', () => {
    const errs = validateMeta({
      type: 'collection',
      title: 'A'.repeat(80),
      description: 'A'.repeat(165),
    });
    assert.deepEqual(errs, []);
  });
});

describe('handleUpdate', () => {
  it('returns validation error when target not found in synced table', async () => {
    mockSyncedRow = null;
    let threw = false;
    try {
      await handleUpdate({ type: 'collection', handle: 'does-not-exist', title: 'Foo' });
    } catch (e) {
      threw = true;
      assert.ok(/not found in synced/.test(e.message));
    }
    assert.ok(threw, 'expected handleUpdate to throw when handle not found');
  });

  it('routes collection update through updateCollectionSeo', async () => {
    mockSyncedRow = {
      shopify_collection_id: 'gid://shopify/Collection/123',
      handle: 'adults-bottoms',
      title: 'Adults Bottoms',
      seo_title: null,
      seo_description: null,
    };
    const result = await handleUpdate({
      type: 'collection',
      handle: 'adults-bottoms',
      title: 'No-Tuck Bottoms for Trans Women | RUBIES',
      description: 'Bottoms for trans women and teens. Sizes XS–4XL. 60-day guarantee.',
    });
    assert.equal(collectionUpdateCalls.length, 1);
    assert.equal(productUpdateCalls.length, 0);
    assert.equal(collectionUpdateCalls[0].id, 'gid://shopify/Collection/123');
    assert.equal(collectionUpdateCalls[0].seoTitle, 'No-Tuck Bottoms for Trans Women | RUBIES');
    assert.ok(result.content[0].text.includes('Updated collection'));
  });

  it('routes product update through updateProductSeo', async () => {
    mockSyncedRow = {
      shopify_product_id: 'gid://shopify/Product/999',
      handle: 'the-aj-shaping-underwear',
      title: 'AJ',
      seo_title: null,
      seo_description: null,
    };
    await handleUpdate({
      type: 'product',
      handle: 'the-aj-shaping-underwear',
      description: 'Best-selling no-tuck for trans women and trans girls.',
    });
    assert.equal(productUpdateCalls.length, 1);
    assert.equal(collectionUpdateCalls.length, 0);
  });

  it('mirrors update to Supabase synced row', async () => {
    mockSyncedRow = {
      shopify_collection_id: 'gid://shopify/Collection/123',
      handle: 'adults-bottoms',
      title: 'Adults Bottoms',
      seo_title: null,
      seo_description: null,
    };
    await handleUpdate({
      type: 'collection',
      handle: 'adults-bottoms',
      title: 'New Title | RUBIES',
    });
    assert.equal(supabaseUpdateCalls.length, 1);
    assert.equal(supabaseUpdateCalls[0].table, 'collections');
    assert.equal(supabaseUpdateCalls[0].patch.seo_title, 'New Title | RUBIES');
  });

  it('includes storefront and admin URLs in result', async () => {
    mockSyncedRow = {
      shopify_collection_id: 'gid://shopify/Collection/123',
      handle: 'adults-bottoms',
      title: 'Adults Bottoms',
      seo_title: null,
      seo_description: null,
    };
    const result = await handleUpdate({
      type: 'collection',
      handle: 'adults-bottoms',
      title: 'New Title | RUBIES',
    });
    const text = result.content[0].text;
    assert.ok(text.includes('https://rubyshines.com/collections/adults-bottoms'));
    assert.ok(text.includes('admin.shopify.com/store/test/collections/123'));
  });

  it('reports handle change in result text', async () => {
    mockSyncedRow = {
      shopify_collection_id: 'gid://shopify/Collection/123',
      handle: 'new-arrivals-for-adults-copy',
      title: 'Tops For Adults',
      seo_title: null,
      seo_description: null,
    };
    const result = await handleUpdate({
      type: 'collection',
      handle: 'new-arrivals-for-adults-copy',
      new_handle: 'adults-tops',
      title: 'Gender-Affirming Tops for Trans Women | RUBIES',
    });
    const text = result.content[0].text;
    assert.ok(text.includes('301 redirect'));
    assert.ok(text.includes('new-arrivals-for-adults-copy → adults-tops'));
  });

  it('returns isError=true on validation failure', async () => {
    const result = await handleUpdate({
      type: 'collection',
      handle: 'adults-bottoms',
      title: 'Has em dash — bad',
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('em dash'));
  });
});

// ─── pageUrlMatchesPath — keyword anchors must come from THIS page only ───────

describe('pageUrlMatchesPath', () => {
  it('matches the exact path with host, trailing slash, or query', () => {
    const path = '/collections/tops';
    assert.equal(pageUrlMatchesPath('https://rubyshines.com/collections/tops', path), true);
    assert.equal(pageUrlMatchesPath('https://rubyshines.com/collections/tops/', path), true);
    assert.equal(pageUrlMatchesPath('https://rubyshines.com/collections/tops?page=2', path), true);
    assert.equal(pageUrlMatchesPath('/collections/tops', path), true);
  });

  it('rejects sibling pages whose handle extends the target', () => {
    const path = '/collections/tops';
    assert.equal(pageUrlMatchesPath('https://rubyshines.com/collections/tops-for-adults', path), false);
    assert.equal(pageUrlMatchesPath('https://rubyshines.com/collections/tops-for-kids/', path), false);
  });

  it('rejects sub-paths and unrelated pages', () => {
    const path = '/products/ava';
    assert.equal(pageUrlMatchesPath('https://rubyshines.com/products/ava-bra', path), false);
    assert.equal(pageUrlMatchesPath('https://rubyshines.com/collections/all/products/ava', path), false);
    assert.equal(pageUrlMatchesPath(null, path), false);
  });
});
