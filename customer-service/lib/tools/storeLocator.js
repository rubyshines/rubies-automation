/**
 * MCP Tools: Store Locator CRUD + publish
 *
 * Manages retail partner entries on the rubyshines.com store locator. Data
 * lives in b2b_companies (on_store_locator + locator_* columns). The website
 * reads a static JSON asset published from these rows; rubies-automations is
 * the SSOT.
 *
 * Tools:
 *   store_locator_list     — list stores on the locator (+ optionally inactive)
 *   store_locator_create   — add a b2b_companies row to the locator
 *   store_locator_update   — patch locator fields on an existing row
 *   store_locator_delete   — soft-remove from locator (on_store_locator=false). hard=true clears all locator fields.
 *   store_locator_publish  — write rubies-ecom-v4/assets/store-locators.json + auto-merge
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { publishStoreLocators } = require('../storeLocatorPublish');
const { extractStoreDescription } = require('../storeLocatorDescription');
const { rehostImageOnShopify, rehostImageFromFile, isShopifyCdnUrl } = require('../shopifyFileUpload');
const { geocode } = require('../geocoder');

function normalizeDomain(url) {
  if (!url) return '';
  let s = String(url).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/^www\./, '');
  return s;
}

function looksLikeLocalPath(s) {
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return false;
  if (s.startsWith('/') || s.startsWith('~') || s.startsWith('./') || s.startsWith('../')) return true;
  return false;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return require('path').join(require('os').homedir(), p.slice(2));
  return p;
}

const SELECT_COLS = 'id, name, website, status, on_store_locator, locator_display_name, locator_description, locator_hours, locator_products, locator_display_address, locator_logo_url, latitude, longitude, updated_at';

function fmtStore(row) {
  const displayName = row.locator_display_name || row.name;
  return `**${displayName}** (id: ${row.id}) ${row.on_store_locator ? '' : '[off locator]'}
  website: ${row.website || '—'}
  lat/lng: ${row.latitude ?? '—'}, ${row.longitude ?? '—'}
  address: ${row.locator_display_address || '—'}
  hours: ${row.locator_hours || '—'}
  products: ${(row.locator_products || []).join(', ') || '—'}
  logo: ${row.locator_logo_url || '—'}`;
}

function renderPreview(row, logs, opts = {}) {
  const lines = [];
  lines.push(opts.heading || '## Preview — store locator entry (NOT YET SAVED)');
  lines.push('');
  if (logs.length) {
    lines.push('### Auto-derivation log');
    for (const l of logs) lines.push(l);
    lines.push('');
  }
  lines.push('### Fields');
  const displayName = row.locator_display_name || row.name;
  lines.push(`- **Display name:** ${displayName}`);
  lines.push(`- **Internal name (b2b_companies.name):** ${row.name}`);
  lines.push(`- **Website / storeUrl:** ${row.website || '—'}`);
  lines.push(`- **Lat / Lng:** ${row.latitude ?? '—'}, ${row.longitude ?? '—'}`);
  lines.push(`- **Products:** ${(row.locator_products || []).join(', ') || '—'}`);
  lines.push(`- **Hours:** ${row.locator_hours || '—'}`);
  lines.push('');
  lines.push(`**Display address:**\n\`\`\`\n${row.locator_display_address || '—'}\n\`\`\``);
  lines.push('');
  lines.push(`**Description:**\n> ${(row.locator_description || '—').replace(/\n/g, '\n> ')}`);
  lines.push('');
  if (row.locator_logo_url) {
    lines.push(`**Logo:** ${row.locator_logo_url}`);
    lines.push('');
    lines.push(`![logo preview](${row.locator_logo_url})`);
    if (opts.rehostNote) {
      lines.push('');
      lines.push('_(On save, this logo will be re-hosted on the Shopify CDN.)_');
    }
  } else {
    lines.push(`**Logo:** — none (optional; pass \`logo_url\` to add one)`);
  }
  lines.push('');
  lines.push('---');
  lines.push(opts.confirmHint || 'To save, call this tool again with `confirmed: true`.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function handleList({ include_inactive }) {
  const supabase = getSupabaseClient();
  let q = supabase.from('b2b_companies').select(SELECT_COLS).order('id');

  if (include_inactive) {
    // Show rows on the locator OR rows that have locator data but are currently off.
    q = q.or('on_store_locator.eq.true,and(on_store_locator.eq.false,locator_description.not.is.null),and(on_store_locator.eq.false,locator_display_name.not.is.null),and(on_store_locator.eq.false,locator_display_address.not.is.null)');
  } else {
    q = q.eq('on_store_locator', true);
  }

  const { data, error } = await q;
  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };

  const active = (data || []).filter(r => r.on_store_locator);
  const inactive = (data || []).filter(r => !r.on_store_locator);

  const lines = [`## Store Locator Entries (${active.length} active${inactive.length ? `, ${inactive.length} inactive` : ''})\n`];
  for (const s of active) lines.push(fmtStore(s), '');
  if (inactive.length) {
    lines.push('### Off locator (on_store_locator=false)');
    for (const s of inactive) lines.push(fmtStore(s), '');
  }
  return { content: [{ type: 'text', text: lines.join('\n') }], _structured: { stores: data } };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function deriveCreatePayload(params, { logs }) {
  if (!params.store_url) throw new Error('Missing required field: store_url');

  const supabase = getSupabaseClient();

  // Find the b2b_companies row by domain match on store_url, then by name.
  const targetDomain = normalizeDomain(params.store_url);
  const { data: allRows, error: fetchErr } = await supabase
    .from('b2b_companies')
    .select('id, name, website')
    .limit(2000);
  if (fetchErr) throw new Error(`b2b_companies lookup failed: ${fetchErr.message}`);

  let row = targetDomain
    ? (allRows || []).find(r => normalizeDomain(r.website) === targetDomain)
    : null;

  if (!row && params.name) {
    row = (allRows || []).find(r => r.name.toLowerCase() === params.name.toLowerCase());
    if (row) logs.push(`Matched b2b_companies row "${row.name}" (${row.id}) by name (domain match not found).`);
  }

  if (!row) {
    const hint = params.name ? ` or name "${params.name}"` : '';
    throw new Error(`No b2b_companies row found matching domain "${targetDomain}"${hint}. The store must exist in b2b_companies first.`);
  }

  logs.push(`Matched b2b_companies row: "${row.name}" (${row.id})`);

  // Resolve lat/lng from pin_address if not supplied directly.
  let lat = params.latitude;
  let lng = params.longitude;
  if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && params.pin_address) {
    logs.push(`Geocoding pin_address: "${params.pin_address}"`);
    const geo = await geocode(params.pin_address);
    if (!geo) throw new Error(`Geocoding returned no results for pin_address "${params.pin_address}".`);
    lat = geo.lat;
    lng = geo.lng;
    logs.push(`  → lat=${lat}, lng=${lng}`);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('lat/lng required. Provide latitude+longitude or pin_address for geocoding.');
  }

  if (!params.locator_display_address) {
    throw new Error('Missing required field: locator_display_address');
  }

  // Auto-extract description via Haiku if not provided.
  let description = params.description || null;
  if (!description) {
    logs.push(`Auto-extracting description from ${params.store_url} via Haiku...`);
    try {
      description = await extractStoreDescription(params.store_url);
      if (description) {
        logs.push(`  → extracted ${description.length} chars`);
      } else {
        logs.push('  → extraction returned null (no description set)');
      }
    } catch (e) {
      logs.push(`  → extraction failed: ${e.message}`);
    }
  }

  const products = params.products && params.products.length
    ? params.products
    : ['swimwear', 'underwear'];

  return {
    _rowId: row.id,
    _rowName: row.name,
    name: row.name,
    website: row.website,
    on_store_locator: true,
    locator_display_name: params.locator_display_name || null,
    locator_description: description,
    locator_hours: params.hours || null,
    locator_products: products,
    locator_display_address: params.locator_display_address,
    locator_logo_url: params.logo_url || null,
    latitude: lat,
    longitude: lng,
  };
}

async function handleCreate(params) {
  const logs = [];
  let derived;
  try {
    derived = await deriveCreatePayload(params, { logs });
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}\n\n${logs.join('\n')}` }], isError: true };
  }

  if (!params.confirmed) {
    return {
      content: [{ type: 'text', text: renderPreview(derived, logs, {
        confirmHint: 'To save, call `store_locator_create` again with the same fields plus `confirmed: true`.',
        rehostNote: derived.locator_logo_url && !isShopifyCdnUrl(derived.locator_logo_url),
      }) }],
      _structured: { preview: derived, logs, confirmed: false },
    };
  }

  // Re-host logo on Shopify CDN at save time (if provided and not already there).
  if (derived.locator_logo_url) {
    try {
      if (looksLikeLocalPath(derived.locator_logo_url)) {
        const localPath = expandHome(derived.locator_logo_url);
        logs.push(`Uploading local logo to Shopify CDN: ${localPath}`);
        const result = await rehostImageFromFile(localPath, { alt: `${derived.locator_display_name || derived.name} logo` });
        logs.push(`  → ${result.cdnUrl}`);
        derived.locator_logo_url = result.cdnUrl;
      } else if (!isShopifyCdnUrl(derived.locator_logo_url)) {
        logs.push(`Re-hosting logo on Shopify CDN: ${derived.locator_logo_url}`);
        const result = await rehostImageOnShopify(derived.locator_logo_url, { alt: `${derived.locator_display_name || derived.name} logo` });
        if (result.source === 'shopify') {
          logs.push(`  → ${result.cdnUrl}`);
          derived.locator_logo_url = result.cdnUrl;
        }
      } else {
        logs.push('Logo already on Shopify CDN — no re-host needed.');
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `Logo upload failed: ${e.message}\n\nRe-run with a different \`logo_url\`.\n\n${logs.join('\n')}` }], isError: true };
    }
  }

  const rowId = derived._rowId;
  const patch = {
    on_store_locator: true,
    locator_display_name: derived.locator_display_name,
    locator_description: derived.locator_description,
    locator_hours: derived.locator_hours,
    locator_products: derived.locator_products,
    locator_display_address: derived.locator_display_address,
    locator_logo_url: derived.locator_logo_url,
    latitude: derived.latitude,
    longitude: derived.longitude,
    updated_at: new Date().toISOString(),
  };

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('b2b_companies')
    .update(patch)
    .eq('id', rowId)
    .select(SELECT_COLS)
    .single();
  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}\n\n${logs.join('\n')}` }], isError: true };

  const lines = [];
  if (logs.length) lines.push(...logs, '');
  lines.push('Added to store locator:', '', fmtStore(data), '', 'Run store_locator_publish to push to the website.');
  return { content: [{ type: 'text', text: lines.join('\n') }], _structured: { store: data, logs } };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function handleUpdate(params) {
  if (!params.id && !params.name) {
    return { content: [{ type: 'text', text: 'Pass either id or name to identify the store.' }], isError: true };
  }
  const supabase = getSupabaseClient();

  const allowed = ['locator_display_name', 'locator_description', 'locator_hours', 'locator_products',
    'locator_display_address', 'locator_logo_url', 'latitude', 'longitude', 'on_store_locator'];
  const patch = { updated_at: new Date().toISOString() };
  for (const k of allowed) {
    if (params[k] !== undefined) patch[k] = params[k];
  }
  if (Object.keys(patch).length === 1) {
    return { content: [{ type: 'text', text: 'No fields to update.' }], isError: true };
  }

  const rehostLogs = [];
  if (patch.locator_logo_url && !isShopifyCdnUrl(patch.locator_logo_url) && !params._skip_rehost) {
    try {
      if (looksLikeLocalPath(patch.locator_logo_url)) {
        const localPath = expandHome(patch.locator_logo_url);
        rehostLogs.push(`Uploading local logo to Shopify CDN: ${localPath}`);
        const result = await rehostImageFromFile(localPath, { alt: `${params.name || 'store'} logo` });
        rehostLogs.push(`  → ${result.cdnUrl}`);
        patch.locator_logo_url = result.cdnUrl;
      } else {
        rehostLogs.push(`Re-hosting logo on Shopify CDN: ${patch.locator_logo_url}`);
        const result = await rehostImageOnShopify(patch.locator_logo_url, { alt: `${params.name || 'store'} logo` });
        if (result.source === 'shopify') {
          rehostLogs.push(`  → ${result.cdnUrl}`);
          patch.locator_logo_url = result.cdnUrl;
        }
      }
    } catch (e) {
      rehostLogs.push(`  Re-host failed (${e.message}). Storing external URL instead.`);
    }
  }

  let q = supabase.from('b2b_companies').update(patch);
  if (params.id) q = q.eq('id', params.id);
  else q = q.eq('name', params.name);

  const { data, error } = await q.select(SELECT_COLS);
  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  if (!data || data.length === 0) return { content: [{ type: 'text', text: 'No row matched.' }], isError: true };

  const header = rehostLogs.length ? rehostLogs.join('\n') + '\n\n' : '';
  return { content: [{ type: 'text', text: `${header}Updated ${data.length} store(s):\n\n${data.map(fmtStore).join('\n\n')}\n\nRun store_locator_publish to push to the website.` }], _structured: { stores: data } };
}

// ---------------------------------------------------------------------------
// delete (soft by default — just sets on_store_locator=false)
// ---------------------------------------------------------------------------

async function handleDelete({ id, name, hard }) {
  if (!id && !name) {
    return { content: [{ type: 'text', text: 'Pass either id or name to identify the store.' }], isError: true };
  }
  const supabase = getSupabaseClient();

  if (hard) {
    // Hard delete clears all locator fields rather than deleting the b2b row
    // (the b2b relationship still exists; we just remove the locator data).
    const patch = {
      on_store_locator: false,
      locator_display_name: null,
      locator_description: null,
      locator_hours: null,
      locator_products: null,
      locator_display_address: null,
      locator_logo_url: null,
      updated_at: new Date().toISOString(),
    };
    let q = supabase.from('b2b_companies').update(patch);
    if (id) q = q.eq('id', id); else q = q.eq('name', name);
    const { error } = await q;
    if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    return { content: [{ type: 'text', text: `Hard-removed ${id || name} from store locator (locator fields cleared).\n\nRun store_locator_publish to push to the website.` }] };
  }

  const patch = { on_store_locator: false, updated_at: new Date().toISOString() };
  let q = supabase.from('b2b_companies').update(patch);
  if (id) q = q.eq('id', id); else q = q.eq('name', name);
  const { data, error } = await q.select(SELECT_COLS);
  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  if (!data || data.length === 0) return { content: [{ type: 'text', text: 'No row matched.' }], isError: true };

  return { content: [{ type: 'text', text: `Removed from store locator (on_store_locator=false) — locator data preserved:\n\n${data.map(fmtStore).join('\n\n')}\n\nRun store_locator_publish to push to the website.` }] };
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

async function handlePublish({ dry_run, merge } = {}) {
  const result = await publishStoreLocators({
    dry_run: dry_run === true,
    merge: merge !== false,
  });
  const lines = [`Wrote ${result.count} stores to ${result.path}`];

  if (result.dryRun) {
    lines.push('', '_(dry_run)_ — working tree only. No commit, no push, no deploy.');
  } else if (result.noOp) {
    lines.push('', 'No content change vs origin/main — nothing to commit or deploy.');
  } else if (result.merged) {
    lines.push('', `**Merged + deploying** — Shopify auto-pulls main within ~30s.`);
    if (result.prUrl) lines.push(`PR (merged): ${result.prUrl}`);
    if (result.liveUrl) lines.push('', `Live page: ${result.liveUrl}`);
    if (result.mergeWarning) lines.push('', `_(${result.mergeWarning})_`);
  } else if (result.mergeError) {
    const prCompareUrl = result.remoteUrl
      ? result.remoteUrl.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '') + `/compare/${result.baseBranch}...${result.branch}?expand=1`
      : null;
    lines.push('', `Pushed branch **${result.branch}** but auto-merge failed: ${result.mergeError}`);
    if (prCompareUrl) lines.push(`Open PR manually: ${prCompareUrl}`);
  } else {
    const prCompareUrl = result.remoteUrl
      ? result.remoteUrl.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '') + `/compare/${result.baseBranch}...${result.branch}?expand=1`
      : null;
    lines.push('', `Pushed branch **${result.branch}** (merge skipped because merge:false).`);
    if (prCompareUrl) lines.push(`Open PR: ${prCompareUrl}`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }], _structured: result };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

module.exports = [
  {
    name: 'store_locator_list',
    description: 'List retail stores on the rubyshines.com store locator. Returns all stores with on_store_locator=true. Pass include_inactive=true to also see stores that have locator data but are currently hidden.',
    inputSchema: {
      type: 'object',
      properties: {
        include_inactive: { type: 'boolean', description: 'Include stores that are off the locator (on_store_locator=false) but have locator data. Default: false.' },
      },
    },
    handler: handleList,
  },
  {
    name: 'store_locator_create',
    description: 'Add a b2b_companies row to the store locator. Finds the row by domain match on store_url (falls back to name). Auto-extracts a description from the store website via Haiku if not provided. Geocodes pin_address to lat/lng if coordinates not supplied directly. TWO-STEP: defaults to a preview (no DB write); pass confirmed: true to save.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'b2b_companies row name — used as fallback lookup if domain match on store_url fails.' },
        store_url: { type: 'string', description: 'The store\'s public website URL. Used to find the b2b_companies row by domain match AND to auto-extract the description.' },
        locator_display_name: { type: 'string', description: 'Public-facing name override (e.g. "Illusions Lingerie" vs internal "Tuck and Bind"). Leave null to use the b2b_companies name.' },
        locator_display_address: { type: 'string', description: 'Multi-line display address shown on the locator (e.g. "22 Puckle Street\\nMoonee Ponds VIC 3039\\nAustralia"). May be a status message like "Currently closed in transition".' },
        description: { type: 'string', description: 'Public-facing 1–3 sentence description. Auto-extracted from store_url via Haiku if not provided.' },
        hours: { type: 'string', description: 'Opening hours freeform string. Empty string is fine.' },
        products: { type: 'array', items: { type: 'string' }, description: 'Product types carried: subset of ["swimwear","underwear"]. Defaults to both.' },
        pin_address: { type: 'string', description: 'Free-form address to geocode to lat/lng for the map pin. Ignored if latitude+longitude are supplied directly.' },
        latitude: { type: 'number', description: 'Map pin latitude. Required (or derive via pin_address).' },
        longitude: { type: 'number', description: 'Map pin longitude. Required (or derive via pin_address).' },
        logo_url: { type: 'string', description: 'Public URL or local file path of the store logo. Re-hosted to Shopify CDN on confirm.' },
        confirmed: { type: 'boolean', description: 'Set true to save the record. Default false → preview only.' },
      },
      required: ['store_url', 'locator_display_address'],
    },
    handler: handleCreate,
  },
  {
    name: 'store_locator_update',
    description: 'Patch locator fields on an existing b2b_companies row. Identify by id (slug) or name. Any external logo_url is automatically re-hosted on the Shopify CDN.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'b2b_companies id slug (preferred).' },
        name: { type: 'string', description: 'b2b_companies name (alternative to id).' },
        locator_display_name: { type: 'string', description: 'Public-facing name override.' },
        locator_description: { type: 'string', description: 'Public-facing description.' },
        locator_hours: { type: 'string', description: 'Opening hours.' },
        locator_products: { type: 'array', items: { type: 'string' }, description: 'Product types: ["swimwear","underwear"].' },
        locator_display_address: { type: 'string', description: 'Display address shown on the locator.' },
        locator_logo_url: { type: 'string', description: 'Logo URL or local file path. Re-hosted to Shopify CDN automatically.' },
        latitude: { type: 'number', description: 'Map pin latitude.' },
        longitude: { type: 'number', description: 'Map pin longitude.' },
        on_store_locator: { type: 'boolean', description: 'Set true to re-enable a hidden store, false to hide it.' },
      },
    },
    handler: handleUpdate,
  },
  {
    name: 'store_locator_delete',
    description: 'Remove a store from the locator. Soft delete (default): sets on_store_locator=false, locator data preserved. Hard delete: also clears all locator_* fields (the b2b_companies row itself is never deleted).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'b2b_companies id slug.' },
        name: { type: 'string', description: 'b2b_companies name (alternative to id).' },
        hard: { type: 'boolean', description: 'If true, also clears all locator_* fields. Default false (soft).' },
      },
    },
    handler: handleDelete,
  },
  {
    name: 'store_locator_publish',
    description: 'Publish active store locator entries → assets/store-locators.json on the rubies-ecom-v4 theme repo, AND auto-merge to main so Shopify deploys it (~30s). Uses an isolated git worktree so any in-progress theme branch is untouched. Returns the live page URL. Pass dry_run: true to only update the working tree (no commit/push/merge). Pass merge: false to commit+push but skip the auto-merge.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'If true, only write the JSON to the theme working tree — no commit, no push, no deploy.' },
        merge: { type: 'boolean', description: 'If false, commit+push to a branch but do not merge. Default true → auto-merge → auto-deploy.' },
      },
    },
    handler: handlePublish,
  },
];
