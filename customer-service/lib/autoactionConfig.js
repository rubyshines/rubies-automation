/**
 * autoactionConfig.js — dashboard view of the auto-action kill-switches +
 * recent auto-action activity (the operator-action analogue of
 * autosendConfig.js).
 *
 * Assembles the "what auto-executes?" panel from:
 *   1. AUTO_CAPABLE (autoactionGate) — toggleable kinds, default-ON.
 *   2. NEVER_AUTO (autoactionGate) — operator-only kinds, shown but never
 *      toggleable.
 *   3. `autoaction_*` flags in system_flags — current on/off state.
 *   4. Recent auto-executed actions filed on cs_ai_drafts.actions[] (tagged with
 *      a `source` starting `auto_`) — per-kind counts + a recent feed.
 *
 * Pure helpers here are unit-tested; the only IO is fetchAutoactionConfig.
 */
const {
  MASTER_FLAG, KIND_FLAG_PREFIX, AUTO_CAPABLE, NEVER_AUTO,
  SOURCE, isAutoSource, kindForSource,
} = require('./autoactionGate');
const { fetchAllPaginated } = require('../../shared/supabaseClient');

const ACTIVITY_WINDOW_DAYS = 30;
const FEED_LIMIT = 40;

// Human labels for the panel rows.
const KIND_LABELS = {
  warehouse_hold: 'Warehouse hold',
  address_change: 'Address change (same-country)',
};

/**
 * Extract auto-executed actions from a set of draft rows into a flat, sorted
 * (newest-first) feed. PURE — unit tested.
 * @param {Array<{id, ticket_id, order_number, actions}>} drafts
 * @returns {Array<{ticket_id, order_number, source, kind, action_type, summary, executed_at}>}
 */
function extractAutoActions(drafts = []) {
  const out = [];
  for (const d of drafts) {
    const actions = Array.isArray(d.actions) ? d.actions : [];
    for (const a of actions) {
      if (!isAutoSource(a?.source)) continue;
      out.push({
        ticket_id: d.ticket_id ?? null,
        order_number: d.order_number ?? null,
        source: a.source,
        kind: kindForSource(a.source),
        action_type: a.action_type ?? null,
        summary: typeof a.summary === 'string' ? a.summary.split('\n')[0].slice(0, 140) : '',
        executed_at: a.executed_at ?? null,
      });
    }
  }
  out.sort((x, y) => String(y.executed_at || '').localeCompare(String(x.executed_at || '')));
  return out;
}

/** Per-kind counts (+ fallback count) from a feed produced by extractAutoActions. */
function activityStats(feed = []) {
  const stats = {};
  for (const kind of AUTO_CAPABLE) stats[kind] = { executed: 0, fallback: 0 };
  for (const f of feed) {
    if (!stats[f.kind]) stats[f.kind] = { executed: 0, fallback: 0 };
    stats[f.kind].executed++;
    if (f.source === SOURCE.ADDRESS_FALLBACK) stats[f.kind].fallback++;
  }
  return stats;
}

/**
 * Pure assembly of the GET /api/autoaction-config response.
 * @param {object} p
 * @param {boolean} p.masterEnabled — master `autoaction_enabled` (default true)
 * @param {Array<{key, enabled}>} p.flagRows — system_flags `autoaction_*` rows
 * @param {object} p.stats — activityStats() output
 * @param {Array} p.feed — extractAutoActions() output (already trimmed)
 */
function buildAutoactionConfig({ masterEnabled = true, flagRows = [], stats = {}, feed = [] } = {}) {
  const flagMap = new Map();
  for (const f of flagRows) {
    const key = f?.key || '';
    if (key.startsWith(KIND_FLAG_PREFIX) && key !== MASTER_FLAG) {
      flagMap.set(key.slice(KIND_FLAG_PREFIX.length), !!f.enabled);
    }
  }

  const capable = AUTO_CAPABLE.map((kind) => {
    const s = stats[kind] || { executed: 0, fallback: 0 };
    return {
      kind,
      label: KIND_LABELS[kind] || kind,
      // Default-ON: a missing flag row means enabled.
      enabled: flagMap.has(kind) ? flagMap.get(kind) : true,
      never_listed: false,
      executed: s.executed,
      fallback: s.fallback,
    };
  });

  const never = NEVER_AUTO.map((kind) => ({
    kind,
    label: kind.replace(/_/g, ' '),
    enabled: false,
    never_listed: true,
    executed: 0,
    fallback: 0,
  }));

  return {
    master_enabled: !!masterEnabled,
    window_days: ACTIVITY_WINDOW_DAYS,
    kinds: [...capable, ...never],
    feed,
  };
}

/**
 * Validate a flag key for POST /api/autoaction-config. Only the master flag and
 * AUTO_CAPABLE kind flags may be flipped from the dashboard.
 * @param {string} key
 * @returns {{ok: boolean, error?: string}}
 */
function validateAutoactionFlagKey(key) {
  if (typeof key !== 'string' || !key) return { ok: false, error: 'key is required' };
  if (key === MASTER_FLAG) return { ok: true };
  if (!key.startsWith(KIND_FLAG_PREFIX)) {
    return { ok: false, error: `key must be '${MASTER_FLAG}' or start with '${KIND_FLAG_PREFIX}'` };
  }
  const kind = key.slice(KIND_FLAG_PREFIX.length);
  if (!AUTO_CAPABLE.includes(kind)) {
    return { ok: false, error: `'${kind}' is operator-only and can never auto-execute` };
  }
  return { ok: true };
}

/**
 * Fetch flags + recent auto-executed actions and assemble the config response.
 * @param {object} sb — Supabase client
 */
async function fetchAutoactionConfig(sb) {
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 86400000).toISOString();

  const flagRows = await fetchAllPaginated(() =>
    sb.from('system_flags')
      .select('key, enabled')
      .like('key', 'autoaction%')
      .order('key', { ascending: true })
  );

  // Drafts with at least one filed action in the window. We over-fetch and
  // filter for auto sources in JS (JSONB array prefix-match isn't expressible in
  // PostgREST); volume is bounded by the 30-day window.
  const draftRows = await fetchAllPaginated(() =>
    sb.from('cs_ai_drafts')
      .select('id, ticket_id, order_number, actions')
      .gte('created_at', since)
      .not('actions', 'eq', '[]')
      .order('id', { ascending: false })
  );

  const fullFeed = extractAutoActions(draftRows);
  const stats = activityStats(fullFeed);
  const master = flagRows.find((f) => f.key === MASTER_FLAG);

  return buildAutoactionConfig({
    masterEnabled: master ? !!master.enabled : true,
    flagRows,
    stats,
    feed: fullFeed.slice(0, FEED_LIMIT),
  });
}

module.exports = {
  extractAutoActions,
  activityStats,
  buildAutoactionConfig,
  validateAutoactionFlagKey,
  fetchAutoactionConfig,
  KIND_LABELS,
  ACTIVITY_WINDOW_DAYS,
  FEED_LIMIT,
};
