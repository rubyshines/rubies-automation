'use strict';
const { db, must, logEvent } = require('./db');
const { SIZES } = require('./catalog');

const PUBLIC_STATUSES = new Set(['active']);

function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'centre';
}

async function uniqueSlug(name) {
  const base = slugify(name);
  const rows = must(await db().from('vc_centres').select('slug').like('slug', `${base}%`), 'slug lookup');
  const taken = new Set(rows.map(r => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

async function getBySlug(slug) {
  return must(await db().from('vc_centres').select('*').eq('slug', slug).maybeSingle(), 'centre by slug');
}

async function getById(id) {
  return must(await db().from('vc_centres').select('*').eq('id', id).maybeSingle(), 'centre by id');
}

/** Sign-up step 1: the centre row, pending until the operator approves. */
async function createFromSignup({ name, website, programmes, sizes, kids_sizes }) {
  const slug = await uniqueSlug(name);
  const row = {
    slug,
    name: String(name).trim(),
    website: website ? String(website).trim() : null,
    programmes: { closet: !!programmes?.closet, pass_it_on: !!programmes?.pass_it_on },
    sizes: (sizes || []).filter(s => SIZES.includes(s)),
    kids_sizes: !!kids_sizes,
    status: 'pending',
  };
  if (!row.sizes.length) row.sizes = SIZES;
  const centre = must(await db().from('vc_centres').insert(row).select('*').single(), 'create centre');
  await logEvent(centre.id, 'system', 'centre.signed_up', { programmes: row.programmes });
  return centre;
}

const CENTRE_EDITABLE = new Set([
  'name', 'website', 'logo_url', 'address', 'sizes', 'kids_sizes', 'items_per_request', 'requests_per_year',
  'goal_cents', 'approval_mode', 'ship_to_door', 'requests_paused_at', 'map_listed', 'map_pin_to_closet',
  'pass_it_on_paused_at', 'statements_email', 'pickup_note', 'delivery_note', 'programmes',
]);

async function update(id, patch, actor) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) if (CENTRE_EDITABLE.has(k)) clean[k] = v;
  if ('goal_cents' in clean) clean.goal_cents = Math.max(30000, parseInt(clean.goal_cents, 10) || 30000);
  if ('sizes' in clean) clean.sizes = (clean.sizes || []).filter(s => SIZES.includes(s));
  clean.updated_at = new Date().toISOString();
  const centre = must(await db().from('vc_centres').update(clean).eq('id', id).select('*').single(), 'update centre');
  await logEvent(id, actor || 'system', 'centre.updated', { fields: Object.keys(clean).filter(k => k !== 'updated_at') });
  return centre;
}

async function setStatus(id, status, actor, extra = {}) {
  const patch = { status, updated_at: new Date().toISOString(), ...extra };
  const centre = must(await db().from('vc_centres').update(patch).eq('id', id).select('*').single(), 'centre status');
  await logEvent(id, actor || 'system', `centre.${status}`, extra);
  return centre;
}

async function list({ status } = {}) {
  let q = db().from('vc_centres').select('*').order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  return must(await q, 'list centres');
}

function isPublic(centre) { return !!centre && PUBLIC_STATUSES.has(centre.status); }

/** The minimal cut: one page, a balance, a digest. No accounts, requests or boxes. */
function isLink(centre) { return !!centre && centre.mode === 'link'; }

/**
 * Enrol a link-mode centre (the operator does this by tool; there is no
 * sign-up). Active at once, no approval step, no box. Sends nothing: the
 * tool sends the welcome so it can preview first.
 */
async function enrol({ name, slug, notify_email, website, logo_url, city, region, country, donation_partner_id, goal_cents, actor }) {
  if (!name || !String(name).trim()) throw new Error('A centre needs a name.');
  if (!notify_email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(notify_email))) throw new Error('A centre needs a notification email.');
  const clean = slug ? slugify(slug) : null;
  if (clean && (await getBySlug(clean))) throw new Error(`The slug "${clean}" is taken.`);
  const money = require('./money');
  const countryCode = String(country || 'US').trim().toUpperCase() === 'UK' ? 'GB' : String(country || 'US').trim().toUpperCase();
  const row = {
    slug: clean || (await uniqueSlug(name)),
    name: String(name).trim(),
    mode: 'link',
    website: website ? String(website).trim() : null,
    logo_url: logo_url || null,
    address: { city: city || null, region: region || null, country: countryCode },
    // The centre's currency follows its country and is never edited (Jamie, 2026-09-22).
    currency: money.currencyForCountry(countryCode),
    programmes: { closet: true, pass_it_on: !!donation_partner_id },
    donation_partner_id: donation_partner_id || null,
    statements_email: String(notify_email).trim().toLowerCase(),
    // 1,000 in the centre's currency unless the centre says otherwise.
    goal_cents: Math.max(30000, Math.round(goal_cents || 0) || money.LINK_DEFAULT_GOAL_CENTS),
    status: 'active',
    approved_at: new Date().toISOString(),
    approved_by: actor || 'operator',
    map_listed: !!donation_partner_id,
  };
  const centre = must(await db().from('vc_centres').insert(row).select('*').single(), 'enrol centre');
  await logEvent(centre.id, actor || 'operator', 'centre.enrolled', { mode: 'link', donation_partner_id: row.donation_partner_id });
  return centre;
}

function displaySizes(centre) {
  const s = (centre.sizes || []).slice();
  if (!s.length) return '';
  const range = s.length === SIZES.length ? `${s[0]} to ${s[s.length - 1]}` : s.join(', ');
  return centre.kids_sizes ? `${range}, kids` : range;
}

module.exports = { slugify, uniqueSlug, getBySlug, getById, createFromSignup, enrol, update, setStatus, list, isPublic, isLink, displaySizes };
