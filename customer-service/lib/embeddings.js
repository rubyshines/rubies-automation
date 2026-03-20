/**
 * Voyage AI embedding utility for semantic search.
 *
 * Shared by both the import pipeline (bulk embedding) and MCP tools (query-time embedding).
 * Uses Voyage AI REST API with built-in fetch — no SDK needed.
 *
 * Models:
 *   - voyage-3-lite (512 dims, fast, cheap) — default
 *   - voyage-3 (1024 dims, higher quality)
 *
 * Free tier: 200M tokens/month.
 */

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const DEFAULT_MODEL = 'voyage-3-lite'; // 512 dimensions

// Simple LRU cache to avoid re-embedding repeated queries
const cache = new Map();
const CACHE_MAX = 100;

function getApiKey() {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY not configured. Sign up at voyageai.com and add the key to .env');
  return key;
}

/**
 * Generate an embedding for a single text string.
 * Returns an array of 512 dimensions (voyage-3-lite).
 */
async function embed(text, { model = DEFAULT_MODEL } = {}) {
  if (!text || !text.trim()) throw new Error('Cannot embed empty text');

  // Check cache
  const cacheKey = `${model}:${text.slice(0, 200)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const response = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: [text],
      model,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Voyage API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const vector = data.data[0].embedding;

  // Cache it
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(cacheKey, vector);

  return vector;
}

/**
 * Generate embeddings for multiple texts in a single API call.
 * Voyage supports up to 128 texts per batch.
 * Returns an array of vectors (same order as input).
 */
async function embedBatch(texts, { model = DEFAULT_MODEL, batchSize = 128 } = {}) {
  if (!texts.length) return [];

  const allVectors = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const response = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: batch,
        model,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Voyage API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const vectors = data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);

    allVectors.push(...vectors);

    // Rate limit: small delay between batches
    if (i + batchSize < texts.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return allVectors;
}

/**
 * Format a vector for Supabase pgvector insertion.
 * Supabase accepts vectors as JSON arrays: [0.1, -0.2, ...]
 */
function formatForSupabase(vector) {
  return JSON.stringify(vector);
}

module.exports = { embed, embedBatch, formatForSupabase };
