/**
 * autosendConfig.js — dashboard view of the auto-send allowlist (#4).
 *
 * Assembles the "what auto-sends?" config panel from three sources:
 *   1. The hardcoded NEVER list (autosendGate) — shown but never toggleable.
 *   2. The canonical message_type taxonomy (messageTypes).
 *   3. Any `autosend_cat_*` flags already in system_flags (covers categories
 *      that have since left the canonical set but still have a flag row).
 *
 * Per-category quality comes from the closeness judge (cs_draft_judgments):
 * clean = identical + cosmetic verdicts over the trailing 90 days — the same
 * qualification evidence used to promote a category out of shadow.
 *
 * Pure helpers here are unit-tested; the only IO is fetchAutosendConfig.
 */
const { NEVER_TYPES, MASTER_FLAG, CATEGORY_FLAG_PREFIX } = require('./autosendGate');
const { CANONICAL_MESSAGE_TYPES } = require('./messageTypes');

const JUDGMENT_WINDOW_DAYS = 90;

// Judge verdicts that count as "the draft was fine as-is".
const CLEAN_CATEGORIES = new Set(['identical', 'cosmetic']);

/**
 * Union of all category names the panel should show: canonical taxonomy +
 * never-list + anything that already has an autosend_cat_* flag. Sorted with
 * toggleable categories first (alphabetical), never-list last — the panel
 * reads top-down as "what could auto-send".
 * @param {string[]} flagKeys — system_flags keys (non-category keys ignored)
 * @returns {string[]}
 */
function categoryUnion(flagKeys = []) {
  const types = new Set([...CANONICAL_MESSAGE_TYPES, ...NEVER_TYPES]);
  for (const key of flagKeys) {
    if (typeof key === 'string' && key.startsWith(CATEGORY_FLAG_PREFIX)) {
      const mt = key.slice(CATEGORY_FLAG_PREFIX.length);
      if (mt) types.add(mt);
    }
  }
  return [...types].sort((a, b) => {
    const aNever = NEVER_TYPES.has(a);
    const bNever = NEVER_TYPES.has(b);
    if (aNever !== bNever) return aNever ? 1 : -1;
    return a.localeCompare(b);
  });
}

/**
 * Aggregate judge rows into per-category counts.
 * @param {Array<{message_type?: string, category: string}>} rows
 * @returns {Object<string, {judged: number, clean: number}>}
 */
function judgmentStats(rows = []) {
  const stats = {};
  for (const r of rows) {
    const mt = r.message_type || 'unknown';
    const s = stats[mt] || (stats[mt] = { judged: 0, clean: 0 });
    s.judged++;
    if (CLEAN_CATEGORIES.has(r.category)) s.clean++;
  }
  return stats;
}

/**
 * Pure assembly of the GET /api/autosend-config response.
 * @param {object} p
 * @param {boolean} p.shadowEnabled — master `autosend_shadow` flag value
 * @param {Array<{key: string, enabled: boolean}>} p.flagRows — system_flags rows
 * @param {Array<{message_type?: string, category: string}>} p.judgmentRows
 */
function buildAutosendConfig({ shadowEnabled = false, flagRows = [], judgmentRows = [] } = {}) {
  const catFlags = new Map();
  for (const f of flagRows) {
    const key = f?.key || '';
    if (key.startsWith(CATEGORY_FLAG_PREFIX)) {
      catFlags.set(key.slice(CATEGORY_FLAG_PREFIX.length), !!f.enabled);
    }
  }
  const stats = judgmentStats(judgmentRows);

  const categories = categoryUnion(flagRows.map(f => f?.key)).map(mt => {
    const never = NEVER_TYPES.has(mt);
    const s = stats[mt] || { judged: 0, clean: 0 };
    return {
      message_type: mt,
      enabled: never ? false : (catFlags.get(mt) || false),
      never_listed: never,
      judged: s.judged,
      clean_pct: s.judged ? Math.round((s.clean / s.judged) * 100) : null,
    };
  });

  return { shadow_enabled: !!shadowEnabled, categories };
}

/**
 * Validate a flag key for POST /api/autosend-config. Only the master flag and
 * non-never-listed category flags may be flipped from the dashboard.
 * @param {string} key
 * @returns {{ok: boolean, error?: string}}
 */
function validateAutosendFlagKey(key) {
  if (typeof key !== 'string' || !key) return { ok: false, error: 'key is required' };
  if (key === MASTER_FLAG) return { ok: true };
  if (!key.startsWith(CATEGORY_FLAG_PREFIX)) {
    return { ok: false, error: `key must be '${MASTER_FLAG}' or start with '${CATEGORY_FLAG_PREFIX}'` };
  }
  const mt = key.slice(CATEGORY_FLAG_PREFIX.length);
  if (!mt) return { ok: false, error: 'category flag key is missing the message_type' };
  if (NEVER_TYPES.has(mt)) {
    return { ok: false, error: `'${mt}' is on the never-list and can never auto-send` };
  }
  return { ok: true };
}

/**
 * Paginate past Supabase's 1000-row default limit. buildQuery must return a
 * fresh ordered query each call (same shape as lib/autosendShadow.js).
 */
async function fetchAll(buildQuery, pageSize = 1000) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

/**
 * Fetch flags + trailing-window judgments and assemble the config response.
 * @param {object} sb — Supabase client
 */
async function fetchAutosendConfig(sb) {
  const since = new Date(Date.now() - JUDGMENT_WINDOW_DAYS * 86400000).toISOString();

  const flagRows = await fetchAll(() =>
    sb.from('system_flags')
      .select('key, enabled')
      .like('key', 'autosend%')
      .order('key', { ascending: true })
  );

  const judgmentRows = await fetchAll(() =>
    sb.from('cs_draft_judgments')
      .select('message_type, category')
      .gte('created_at', since)
      .order('id', { ascending: true })
  );

  const master = flagRows.find(f => f.key === MASTER_FLAG);
  return buildAutosendConfig({ shadowEnabled: !!master?.enabled, flagRows, judgmentRows });
}

module.exports = {
  categoryUnion,
  judgmentStats,
  buildAutosendConfig,
  validateAutosendFlagKey,
  fetchAll,
  fetchAutosendConfig,
  JUDGMENT_WINDOW_DAYS,
};
