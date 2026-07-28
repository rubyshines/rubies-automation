/**
 * MCP Tools: Donation Partners CRUD + publish + survey ingest
 *
 * rubies-automations is the single source of truth for the partner list. CS
 * routing reads donation_partners from Supabase at runtime; the website
 * (rubies-ecom-v4) reads a static JSON asset published from this same table.
 *
 * Tools:
 *   donation_partner_list                 — list partners (filter by country / active)
 *   donation_partner_create               — insert a partner; auto-geocodes + auto-extracts logo when fields missing
 *   donation_partner_update               — patch fields on an existing partner
 *   donation_partner_delete               — soft delete (active=false). hard=true to remove.
 *   donation_partner_publish              — write rubies-ecom-v4/assets/donation-partners.json
 *   donation_partner_list_pending_survey  — list orgs in the survey sheet not yet in DB
 *   donation_partner_create_from_survey   — ingest one survey row by org name (or sheet_row)
 */

const { getSupabaseClient } = require('../../../shared/supabaseClient');
const { publishDonationPartners } = require('../donationPartnersPublish');
const { geocodeMailingAddress } = require('../geocoder');
const { extractLogoUrl } = require('../logoExtractor');
const { generateShortDescription } = require('../donationDescriptionShort');
const fs = require('fs');
const { readSurveyRows, findSurveyRowByName, ensureRubiesReturnsPrefix } = require('../donationPartnerSurvey');
const { rehostImageOnShopify, rehostImageFromFile, isShopifyCdnUrl } = require('../shopifyFileUpload');

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

const SELECT_COLS = 'id, name, country_code, region, city, address, mailing_address, description, description_short, size_range, logo_url, website_url, latitude, longitude, active, donations_routed, updated_at';

/**
 * Normalize a website URL down to its bare apex-ish domain so we can compare
 * survey submissions to DB rows even when the org name drifts. Strips
 * protocol, leading `www.`, trailing slashes, and any path/query/hash.
 * Returns '' if no domain can be extracted.
 */
function normalizeDomain(url) {
  if (!url) return '';
  let s = String(url).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//, '');           // strip protocol
  s = s.split('/')[0].split('?')[0].split('#')[0]; // host only
  s = s.replace(/^www\./, '');                  // drop leading www.
  return s;
}

function fmtPartner(p) {
  return `**${p.name}** (#${p.id}) ${p.active ? '' : '[inactive]'} — ${p.city || '?'}, ${p.country_code}
  lat/lng: ${p.latitude ?? '—'}, ${p.longitude ?? '—'}
  size_range: ${p.size_range || '—'}
  donations_routed: ${p.donations_routed || 0}
  website: ${p.website_url || '—'}
  logo: ${p.logo_url || '—'}`;
}

function deriveLegacyAddress(mailingAddress, orgName) {
  if (!mailingAddress) return null;
  const lines = mailingAddress.split('\n').map(l => l.trim()).filter(Boolean);
  const filtered = lines.filter((l, i) => {
    if (i === 0 && /^rubies returns/i.test(l)) return false;
    if (/^c\/o\s/i.test(l)) return false;
    if (orgName && l.toLowerCase() === orgName.toLowerCase()) return false;
    return true;
  });
  return filtered.join(', ');
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function handleList({ country_code, include_inactive }) {
  const supabase = getSupabaseClient();
  let q = supabase.from('donation_partners').select(SELECT_COLS).order('country_code').order('name');
  if (country_code) q = q.eq('country_code', country_code);
  if (!include_inactive) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };

  const lines = [`## Donation Partners (${data.length})\n`];
  for (const p of data) lines.push(fmtPartner(p), '');
  return { content: [{ type: 'text', text: lines.join('\n') }], _structured: { partners: data } };
}

// ---------------------------------------------------------------------------
// create — auto-derives missing fields
// ---------------------------------------------------------------------------

/**
 * Build the row to insert. Auto-fills:
 *   - country_code / region / city / lat / lng     via Google geocoding of mailing_address
 *   - logo_url                                      via Haiku extraction from website_url
 *   - address (legacy comma-joined)                 derived from mailing_address
 * Caller-provided values always win.
 */
async function deriveCreatePayload(params, { logs }) {
  if (!params.name) throw new Error('Missing required field: name');
  if (!params.mailing_address) throw new Error('Missing required field: mailing_address');

  // Normalize first — every partner's mailing block must lead with "RUBIES
  // Returns" so the donation page renders consistently. Idempotent.
  const mailing_address = ensureRubiesReturnsPrefix(params.mailing_address);
  if (mailing_address !== params.mailing_address) {
    logs.push('Prepended "RUBIES Returns" to mailing_address (canonical first line).');
  }
  params = { ...params, mailing_address };

  let lat = params.latitude;
  let lng = params.longitude;
  let country_code = params.country_code || null;
  let region = params.region || null;
  let city = params.city || null;

  const needsGeo = !Number.isFinite(lat) || !Number.isFinite(lng) || !country_code;
  if (needsGeo) {
    logs.push('Geocoding mailing_address via Google Maps...');
    const geo = await geocodeMailingAddress(params.mailing_address);
    if (!geo) {
      throw new Error('Geocoding returned no results for the supplied mailing_address.');
    }
    if (!Number.isFinite(lat)) lat = geo.lat;
    if (!Number.isFinite(lng)) lng = geo.lng;
    if (!country_code) country_code = geo.country_code;
    if (!region) region = geo.region;
    if (!city) city = geo.city;
    logs.push(`  → lat=${lat}, lng=${lng}, country=${country_code}, region=${region}, city=${city}`);
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('Could not determine latitude/longitude. Geocoding failed and none were provided.');
  }
  if (!country_code) {
    throw new Error('Could not determine country_code. Provide it explicitly.');
  }

  // Logo extraction was previously auto-attempted via Haiku, but in practice
  // org sites often serve white-on-transparent variants, hotlink-block, or
  // 404 — too unreliable to trust silently. Operator now always pastes a
  // logo URL (or a local file path) on the confirm call.
  const logo_url = params.logo_url || null;

  // CS advisor emails use a 1-2 sentence description; the full org-written
  // text stays on the website. Auto-generate the short version (Opus — it's
  // customer-facing) unless the operator supplied one. Fail-soft: routing
  // falls back to the full description while description_short is null.
  let description_short = params.description_short || null;
  if (!description_short && params.description) {
    try {
      logs.push('Generating short description for CS emails (Opus)...');
      description_short = await generateShortDescription({ name: params.name, description: params.description });
      if (description_short) logs.push(`  → "${description_short}"`);
      else logs.push('  → generation returned nothing; CS emails will fall back to the full description.');
    } catch (e) {
      logs.push(`  → generation failed (${e.message}); CS emails will fall back to the full description.`);
    }
  }

  return {
    name: params.name,
    country_code,
    region,
    city,
    address: params.address || deriveLegacyAddress(params.mailing_address, params.name),
    mailing_address: params.mailing_address,
    description: params.description || null,
    description_short,
    size_range: params.size_range || null,
    logo_url,
    website_url: params.website_url || null,
    latitude: lat,
    longitude: lng,
    active: params.active !== false,
    donations_routed: 0,
  };
}

function renderPreview(row, logs, opts = {}) {
  const lines = [];
  lines.push(opts.heading || '## Preview — donation partner (NOT YET SAVED)');
  lines.push('');
  if (logs.length) {
    lines.push('### Auto-derivation log');
    for (const l of logs) lines.push(l);
    lines.push('');
  }
  lines.push('### Fields');
  lines.push(`- **Name:** ${row.name}`);
  lines.push(`- **Country / Region / City:** ${row.country_code || '—'} / ${row.region || '—'} / ${row.city || '—'}`);
  lines.push(`- **Lat / Lng:** ${row.latitude}, ${row.longitude}`);
  lines.push(`- **Size range:** ${row.size_range || '—'}`);
  lines.push(`- **Website:** ${row.website_url || '—'}`);
  lines.push('');
  lines.push(`**Mailing address:**\n\`\`\`\n${row.mailing_address}\n\`\`\``);
  lines.push('');
  lines.push(`**Description (website):**\n> ${(row.description || '—').replace(/\n/g, '\n> ')}`);
  lines.push('');
  lines.push(`**Short description (CS emails):**\n> ${(row.description_short || '— none; CS emails will use the full description').replace(/\n/g, '\n> ')}`);
  lines.push('');
  if (row.logo_url) {
    lines.push(`**Logo:** ${row.logo_url}`);
    lines.push('');
    lines.push(`![logo preview](${row.logo_url})`);
    if (opts.rehostNote) {
      lines.push('');
      lines.push('_(On save, this logo will be re-hosted on the Shopify CDN so the partner record doesn\'t depend on the external URL.)_');
    }
  } else {
    lines.push(`**Logo:** — needed before save.`);
    lines.push('');
    lines.push(`Open the org website to find one, then re-run this tool with a \`logo_url\`:`);
    if (row.website_url) lines.push(`  • Website: ${row.website_url}`);
    lines.push(`  • \`logo_url\` accepts a public URL (Shopify will fetch + host) OR a local file path like \`/Users/you/Downloads/logo.png\` (we upload the bytes).`);
  }
  lines.push('');
  lines.push('---');
  lines.push(opts.confirmHint || 'To save, call this tool again with `confirmed: true`.');
  return lines.join('\n');
}

async function handleCreate(params) {
  const logs = [];
  let row;
  try {
    row = await deriveCreatePayload(params, { logs });
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}\n\n${logs.join('\n')}` }], isError: true };
  }

  if (!params.confirmed) {
    return {
      content: [{ type: 'text', text: renderPreview(row, logs, {
        heading: params._previewHeading || '## Preview — donation partner (NOT YET SAVED)',
        confirmHint: params._confirmHint || 'To save, call `donation_partner_create` again with the same fields plus `confirmed: true`.',
        rehostNote: row.logo_url && !isShopifyCdnUrl(row.logo_url),
      }) }],
      _structured: { preview: row, logs, confirmed: false },
    };
  }

  // Re-host the logo on Shopify CDN at save-time so we never depend on
  // third-party hosts. Logo can be a URL (Shopify fetches it) or a local
  // file path (we upload bytes via staged uploads).
  if (!row.logo_url) {
    return { content: [{ type: 'text', text: `Cannot save without a logo. Re-run with \`logo_url: "<URL or local file path>"\`.\n\n${logs.join('\n')}` }], isError: true };
  }
  try {
    if (looksLikeLocalPath(row.logo_url)) {
      const localPath = expandHome(row.logo_url);
      logs.push(`Uploading local logo file to Shopify CDN: ${localPath}`);
      const result = await rehostImageFromFile(localPath, { alt: `${row.name} logo` });
      logs.push(`  → ${result.cdnUrl}`);
      row.logo_url = result.cdnUrl;
    } else if (isShopifyCdnUrl(row.logo_url)) {
      logs.push(`Logo already on Shopify CDN — no re-host needed.`);
    } else {
      logs.push(`Re-hosting logo on Shopify CDN: ${row.logo_url}`);
      const result = await rehostImageOnShopify(row.logo_url, { alt: `${row.name} logo` });
      if (result.source === 'shopify') {
        logs.push(`  → ${result.cdnUrl}`);
        row.logo_url = result.cdnUrl;
      }
    }
  } catch (e) {
    return { content: [{ type: 'text', text: `Logo upload failed: ${e.message}\n\nRe-run with a different \`logo_url\`.\n\n${logs.join('\n')}` }], isError: true };
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('donation_partners')
    .insert(row)
    .select(SELECT_COLS)
    .single();
  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}\n\n${logs.join('\n')}` }], isError: true };

  const lines = [];
  if (logs.length) lines.push(...logs, '');
  lines.push(`Created donation partner:`, '', fmtPartner(data), '', 'Run donation_partner_publish to push to the website.');
  return { content: [{ type: 'text', text: lines.join('\n') }], _structured: { partner: data, logs } };
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function handleUpdate(params) {
  if (!params.id && !params.name) {
    return { content: [{ type: 'text', text: 'Pass either id or name to identify the partner' }], isError: true };
  }
  const supabase = getSupabaseClient();

  const allowed = ['name', 'country_code', 'region', 'city', 'address', 'mailing_address',
    'description', 'description_short', 'size_range', 'logo_url', 'website_url', 'latitude', 'longitude', 'active'];
  const patch = { updated_at: new Date().toISOString() };
  for (const k of allowed) {
    if (params[k] !== undefined) patch[k] = params[k];
  }
  if (Object.keys(patch).length === 1) {
    return { content: [{ type: 'text', text: 'No fields to update.' }], isError: true };
  }

  // Normalize the mailing block if it's being set/changed.
  if (patch.mailing_address) {
    patch.mailing_address = ensureRubiesReturnsPrefix(patch.mailing_address);
  }

  // If the operator is setting a new logo_url and it's external, re-host it
  // on Shopify CDN. Skip if already on cdn.shopify.com or if the operator
  // passes _skip_rehost: true (escape hatch).
  const rehostLogs = [];
  if (patch.logo_url && !isShopifyCdnUrl(patch.logo_url) && !params._skip_rehost) {
    try {
      rehostLogs.push(`Re-hosting logo on Shopify CDN: ${patch.logo_url}`);
      const result = await rehostImageOnShopify(patch.logo_url, { alt: `${params.name || 'donation partner'} logo` });
      if (result.source === 'shopify') {
        rehostLogs.push(`  → ${result.cdnUrl}`);
        patch.logo_url = result.cdnUrl;
      }
    } catch (e) {
      rehostLogs.push(`  Re-host failed (${e.message}). Storing external URL instead.`);
    }
  }

  let q = supabase.from('donation_partners').update(patch);
  if (params.id) q = q.eq('id', params.id);
  else q = q.eq('name', params.name);

  const { data, error } = await q.select(SELECT_COLS);
  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  if (!data || data.length === 0) return { content: [{ type: 'text', text: 'No row matched.' }], isError: true };

  const header = rehostLogs.length ? rehostLogs.join('\n') + '\n\n' : '';
  // Changing the full description does NOT regenerate the short one (an
  // operator-tuned short version must never be silently overwritten).
  const staleShortNote = patch.description && patch.description_short === undefined
    ? '\n\nNote: `description` changed but `description_short` was not — review whether the short version (used in CS emails) is still accurate. Regenerate via scripts/backfillDonationShortDescriptions.js or pass description_short explicitly.'
    : '';
  return { content: [{ type: 'text', text: `${header}Updated ${data.length} partner(s):\n\n${data.map(fmtPartner).join('\n\n')}\n\nRun donation_partner_publish to push to the website.${staleShortNote}` }], _structured: { partners: data } };
}

// ---------------------------------------------------------------------------
// delete (soft by default)
// ---------------------------------------------------------------------------

async function handleDelete({ id, name, hard }) {
  if (!id && !name) {
    return { content: [{ type: 'text', text: 'Pass either id or name to identify the partner' }], isError: true };
  }
  const supabase = getSupabaseClient();

  if (hard) {
    let q = supabase.from('donation_partners').delete();
    if (id) q = q.eq('id', id); else q = q.eq('name', name);
    const { error } = await q;
    if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    return { content: [{ type: 'text', text: `Hard-deleted partner ${id || name}.\n\nRun donation_partner_publish to push to the website.` }] };
  }

  let q = supabase.from('donation_partners').update({ active: false, updated_at: new Date().toISOString() });
  if (id) q = q.eq('id', id); else q = q.eq('name', name);
  const { data, error } = await q.select(SELECT_COLS);
  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  if (!data || data.length === 0) return { content: [{ type: 'text', text: 'No row matched.' }], isError: true };

  return { content: [{ type: 'text', text: `Soft-deleted (active=false) ${data.length} partner(s):\n\n${data.map(fmtPartner).join('\n\n')}\n\nRun donation_partner_publish to push to the website.` }] };
}

// ---------------------------------------------------------------------------
// mark_out — flag a submission as decided=out without ingesting
// ---------------------------------------------------------------------------

async function handleMarkOut({ name, reason }) {
  if (!name) {
    return { content: [{ type: 'text', text: 'Provide name to mark a submission out.' }], isError: true };
  }
  const supabase = getSupabaseClient();
  const reasonNote = reason ? `Out: ${reason}` : 'Marked out';

  // If a row with this name already exists, just flip it to inactive and tag the reason.
  const { data: existing, error: lookupErr } = await supabase
    .from('donation_partners')
    .select('id, description, active')
    .eq('name', name)
    .limit(1);
  if (lookupErr) return { content: [{ type: 'text', text: `Error: ${lookupErr.message}` }], isError: true };

  if (existing && existing.length) {
    const cur = existing[0];
    const patch = { active: false, updated_at: new Date().toISOString() };
    if (reason) {
      const stamp = `[${new Date().toISOString().slice(0, 10)}] ${reasonNote}`;
      patch.description = cur.description ? `${cur.description}\n\n${stamp}` : stamp;
    }
    const { error } = await supabase.from('donation_partners').update(patch).eq('id', cur.id);
    if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    return { content: [{ type: 'text', text: `Marked "${name}" out (existing row #${cur.id} set active=false${reason ? ` with reason: ${reason}` : ''}).` }] };
  }

  // Insert stub.
  const stub = {
    name,
    active: false,
    description: reasonNote,
    donations_routed: 0,
  };
  const { data, error } = await supabase
    .from('donation_partners')
    .insert(stub)
    .select('id')
    .single();
  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };

  return { content: [{ type: 'text', text: `Marked "${name}" out as a new stub row (#${data.id}, active=false${reason ? `, reason: ${reason}` : ''}). It won't be published to the website and won't appear in CS routing.` }] };
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

async function handlePublish({ dry_run, merge } = {}) {
  const result = await publishDonationPartners({
    dry_run: dry_run === true,
    merge: merge !== false,
  });
  const lines = [`Wrote ${result.count} partners to ${result.path}`];

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
    // merge:false explicit branch-only path
    const prCompareUrl = result.remoteUrl
      ? result.remoteUrl.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '') + `/compare/${result.baseBranch}...${result.branch}?expand=1`
      : null;
    lines.push('', `Pushed branch **${result.branch}** (merge skipped because merge:false).`);
    if (prCompareUrl) lines.push(`Open PR: ${prCompareUrl}`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }], _structured: result };
}

// ---------------------------------------------------------------------------
// list_submissions — every survey row with status (in / out / blank)
// ---------------------------------------------------------------------------

async function handleListSubmissions({ status } = {}) {
  const survey = await readSurveyRows();
  const supabase = getSupabaseClient();
  const { data: existing, error } = await supabase
    .from('donation_partners')
    .select('id, name, website_url, active');
  if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };

  // Match primarily on website domain (org names drift; domains stay stable).
  // Fall back to normalized name when one side has no website_url.
  const normName = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const statusByDomain = new Map();
  const statusByName = new Map();
  const matchById = new Map();
  for (const r of (existing || [])) {
    const st = r.active ? 'in' : 'out';
    const dom = normalizeDomain(r.website_url);
    if (dom) statusByDomain.set(dom, { status: st, id: r.id, name: r.name });
    statusByName.set(normName(r.name), { status: st, id: r.id, name: r.name });
  }

  const tagged = survey.map(r => {
    const dom = normalizeDomain(r.website);
    const hit = (dom && statusByDomain.get(dom)) || statusByName.get(normName(r.name)) || null;
    return {
      ...r,
      status: hit ? hit.status : '',
      matched_via: hit ? (dom && statusByDomain.has(dom) ? 'domain' : 'name') : null,
      matched_partner_id: hit ? hit.id : null,
      matched_partner_name: hit && hit.name !== r.name ? hit.name : null,
    };
  });

  const filtered = status
    ? tagged.filter(r => r.status === (status === 'blank' ? '' : status))
    : tagged;

  // Sort: blank (actionable) first, then in, then out. Within each group, newest first.
  const order = { '': 0, in: 1, out: 2 };
  filtered.sort((a, b) => {
    const cmp = (order[a.status] ?? 3) - (order[b.status] ?? 3);
    if (cmp !== 0) return cmp;
    return (b.timestamp || '').localeCompare(a.timestamp || '');
  });

  const counts = {
    blank: tagged.filter(r => r.status === '').length,
    in: tagged.filter(r => r.status === 'in').length,
    out: tagged.filter(r => r.status === 'out').length,
  };

  const lines = [`## Donation Partner Submissions (${tagged.length} total — ${counts.blank} not reviewed, ${counts.in} in, ${counts.out} out)\n`];
  lines.push(`Source: Form Responses 1 tab. Status: **in** = active partner, **out** = soft-deleted partner, **blank** = not yet reviewed.\n`);
  for (const r of filtered) {
    const tag = r.status ? `[${r.status}]` : '[ ]';
    lines.push(`${tag} **${r.name}** (row ${r.sheet_row}, submitted ${r.timestamp || '?'})`);
    lines.push(`    website: ${r.website || '—'}`);
    lines.push(`    sizes: ${r.size_range || '—'}`);
    lines.push(`    contact: ${r.contact_name || '—'} <${r.contact_email || '—'}>`);
    if (r.matched_partner_name) {
      lines.push(`    matched DB partner #${r.matched_partner_id} "${r.matched_partner_name}" via ${r.matched_via}`);
    }
    lines.push('');
  }
  lines.push('Preview an ingest with: `donation_partner_create_from_survey({ name: "<org>" })`');
  lines.push('Mark a submission decided=out (no ingest) with: `donation_partner_mark_out({ name: "<org>", reason: "..." })`');
  lines.push('Soft-delete an existing partner with: `donation_partner_delete({ name: "<org>" })`');
  return { content: [{ type: 'text', text: lines.join('\n') }], _structured: { submissions: filtered, counts } };
}

// ---------------------------------------------------------------------------
// create_from_survey
// ---------------------------------------------------------------------------

async function handleCreateFromSurvey({ name, sheet_row, confirmed, logo_url, mailing_address, description, description_short, size_range }) {
  if (!name && !sheet_row) {
    return { content: [{ type: 'text', text: 'Provide either name or sheet_row to pick a row from the survey.' }], isError: true };
  }

  let row;
  if (sheet_row) {
    const all = await readSurveyRows();
    row = all.find(r => r.sheet_row === Number(sheet_row));
    if (!row) return { content: [{ type: 'text', text: `No survey row with sheet_row=${sheet_row}.` }], isError: true };
  } else {
    row = await findSurveyRowByName(name);
    if (!row) return { content: [{ type: 'text', text: `No survey row matched name "${name}". Try donation_partner_list_pending_survey first.` }], isError: true };
  }

  // Dedupe by website domain first (org names drift; domains stay stable),
  // then by exact name. If we find a match, bail before doing expensive
  // geocoding + logo extraction.
  const supabase = getSupabaseClient();
  const submissionDomain = normalizeDomain(row.website);
  const { data: allPartners } = await supabase
    .from('donation_partners')
    .select('id, name, website_url, active');
  const dupByDomain = submissionDomain
    ? (allPartners || []).find(p => normalizeDomain(p.website_url) === submissionDomain)
    : null;
  const dupByName = (allPartners || []).find(p => p.name === row.name);
  const dup = dupByDomain || dupByName;
  if (dup) {
    const via = dupByDomain ? `domain (${submissionDomain})` : 'name';
    const activeNote = dup.active ? '' : ' [currently active=false]';
    return { content: [{ type: 'text', text: `"${row.name}" appears to already exist in donation_partners as **${dup.name}** (#${dup.id}, matched by ${via})${activeNote}. Use donation_partner_update to change existing fields, or pass a different name explicitly via donation_partner_create if this is truly a different org.` }], isError: true };
  }

  // Operator overrides win over survey + auto-derivation. Useful when Haiku
  // picks a bad logo (white-on-white, favicon, etc.) — operator pastes a
  // better URL in the same call. Same for tweaks to the mailing block or
  // description before the row hits the DB.
  return handleCreate({
    name: row.name,
    mailing_address: mailing_address || row.mailing_address,
    description: description || row.description,
    description_short: description_short || undefined, // undefined → create() auto-generates via Opus
    size_range: size_range || row.size_range,
    website_url: row.website,
    logo_url: logo_url || undefined, // undefined → create() falls back to Haiku
    confirmed: confirmed === true,
    _previewHeading: `## Preview — ingest from survey row ${row.sheet_row} (NOT YET SAVED)`,
    _confirmHint: `To save, call \`donation_partner_create_from_survey\` again with \`{ name: "${row.name}", confirmed: true }\` (include \`logo_url\` / \`mailing_address\` / \`description_short\` overrides if you want to change anything in this preview — the short description regenerates on confirm unless you pass the previewed text explicitly).`,
  });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const partnerFieldsSchema = {
  name: { type: 'string', description: 'Partner organization name' },
  country_code: { type: 'string', description: 'ISO alpha-2 country code (auto-derived from mailing_address via Google if omitted on create)' },
  region: { type: 'string', description: 'State/province/canton (auto-derived from mailing_address if omitted)' },
  city: { type: 'string', description: 'City (auto-derived from mailing_address if omitted)' },
  address: { type: 'string', description: 'Legacy single-line street address. Optional; donation_partner_publish uses mailing_address.' },
  mailing_address: { type: 'string', description: 'Multi-line mailing block as shown on the donation page (e.g. "RUBIES Returns\\nc/o ORG\\nstreet\\ncity, state\\nzip").' },
  description: { type: 'string', description: 'Full public-facing description of the org (shown on the website donation page)' },
  description_short: { type: 'string', description: '1-2 sentence version used in CS advisor emails. Auto-generated from description (Opus) when omitted on create; pass explicitly to override.' },
  size_range: { type: 'string', description: 'Sizes accepted, e.g. "Youth sizes 4-8, Adult XS - 4X"' },
  logo_url: { type: 'string', description: 'Public CDN URL of the org logo. If omitted and website_url is set, auto-extracted via Haiku.' },
  website_url: { type: 'string', description: 'Org\'s external website (used as the source for auto logo extraction).' },
  latitude: { type: 'number', description: 'Latitude. Auto-derived from mailing_address via Google if omitted.' },
  longitude: { type: 'number', description: 'Longitude. Auto-derived from mailing_address via Google if omitted.' },
  active: { type: 'boolean', description: 'Whether the partner is currently accepting donations' },
};

module.exports = [
  {
    name: 'donation_partner_list',
    description: 'List donation partners. Filter by country_code or include_inactive. Returns the full registry shape (lat/lng, logo, mailing address, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        country_code: { type: 'string', description: 'Filter to a single country (ISO alpha-2)' },
        include_inactive: { type: 'boolean', description: 'Include inactive partners (default: false)' },
      },
    },
    handler: handleList,
  },
  {
    name: 'donation_partner_create',
    description: 'Add a new donation partner. Requires name + mailing_address. Auto-geocodes lat/lng/country/region/city via Google Maps when not provided, and auto-extracts logo_url via Haiku from website_url when not provided. Caller-supplied values always win. TWO-STEP: defaults to a preview (no DB write) showing the derived fields and an inline logo preview; pass `confirmed: true` to actually save.',
    inputSchema: {
      type: 'object',
      properties: {
        ...partnerFieldsSchema,
        confirmed: { type: 'boolean', description: 'Set true to actually save the record. Default false → returns a preview only with the auto-derived fields and an inline logo preview, so the operator can verify before saving.' },
      },
      required: ['name', 'mailing_address'],
    },
    handler: handleCreate,
  },
  {
    name: 'donation_partner_update',
    description: 'Patch fields on an existing donation partner. Identify by id (preferred) or name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Partner id (preferred)' },
        ...partnerFieldsSchema,
      },
    },
    handler: handleUpdate,
  },
  {
    name: 'donation_partner_delete',
    description: 'Soft-delete (active=false) a donation partner. Pass hard=true to actually remove the row (rare — soft delete preserves historical donations_routed counts).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Partner id' },
        name: { type: 'string', description: 'Partner name (alternative to id)' },
        hard: { type: 'boolean', description: 'If true, actually DELETE the row instead of setting active=false. Default false.' },
      },
    },
    handler: handleDelete,
  },
  {
    name: 'donation_partner_mark_out',
    description: 'Mark a donation partner submission as decided=out (rejected) without ingesting it. If a row with this name already exists, sets active=false. If not, creates a minimal stub (name + active=false + reason in description). Use this for submissions you reviewed and decided not to add — they\'ll show as **out** in donation_partner_list_submissions instead of staying blank.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Org name (exact match to the submission you want to mark out)' },
        reason: { type: 'string', description: 'Optional short reason (e.g. "Program no longer running", "Out of scope"). Stamped into the description.' },
      },
      required: ['name'],
    },
    handler: handleMarkOut,
  },
  {
    name: 'donation_partner_publish',
    description: 'Publish donation_partners → assets/donation-partners.json on the rubies-ecom-v4 theme repo, AND auto-merge to main so Shopify deploys it (~30s). Uses an isolated git worktree so any in-progress branch in the theme checkout is untouched. Returns the live page URL. Pass `dry_run: true` to only update the working tree (no commit / push / merge). Pass `merge: false` to commit + push but skip the auto-merge (leaves the PR open for manual review).',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'If true, only write the JSON to the theme working tree — no commit, no push, no deploy.' },
        merge: { type: 'boolean', description: 'If false, commit + push to a branch but do not merge (leaves the PR open). Default true → auto-merge → auto-deploy.' },
      },
    },
    handler: handlePublish,
  },
  {
    name: 'donation_partner_list_submissions',
    description: 'List every org that has submitted the RUBIES donation onboarding survey (Form Responses 1 tab), tagged with its program status: **in** (active partner), **out** (soft-deleted), or **blank** (not yet reviewed). Sorted with blank rows first so unreviewed submissions surface to the top. Use this to walk through submissions and decide which to ingest.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter to a single status: "in", "out", or "blank". Omit for all.' },
      },
    },
    handler: handleListSubmissions,
  },
  {
    name: 'donation_partner_create_from_survey',
    description: 'Ingest a single org from the donation onboarding survey (Form Responses 1) into donation_partners. Identifies the survey row by name (preferred) or sheet_row. Auto-geocodes the bare address and auto-extracts a logo from the org website via Haiku. Skips if the org domain/name already exists. TWO-STEP: defaults to a preview (no DB write) showing the derived fields and an inline logo preview; pass `confirmed: true` to actually save. Operator can override any field (logo_url, mailing_address, description, size_range) in the same call — overrides win over survey data and auto-derivation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Org name as it appears in the survey (case-insensitive, partial match OK).' },
        sheet_row: { type: 'number', description: 'Sheet row number (1-indexed, header is row 1). Alternative to name.' },
        confirmed: { type: 'boolean', description: 'Set true to actually save the record. Default false → returns a preview only.' },
        logo_url: { type: 'string', description: 'Optional manual logo URL override. Use this when Haiku\'s extracted logo is wrong (e.g. white-on-white, a favicon, or a partner logo).' },
        mailing_address: { type: 'string', description: 'Optional override for the multi-line "RUBIES Returns / c/o ORG / ..." block. Use this when the org\'s submitted address needs cleanup.' },
        description: { type: 'string', description: 'Optional override for the full public-facing description (website).' },
        description_short: { type: 'string', description: 'Optional override for the short 1-2 sentence description used in CS advisor emails. Omit to auto-generate from the description.' },
        size_range: { type: 'string', description: 'Optional override for the size range string.' },
      },
    },
    handler: handleCreateFromSurvey,
  },
];
