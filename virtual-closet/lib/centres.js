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

function displaySizes(centre) {
  const s = (centre.sizes || []).slice();
  if (!s.length) return '';
  const range = s.length === SIZES.length ? `${s[0]} to ${s[s.length - 1]}` : s.join(', ');
  return centre.kids_sizes ? `${range}, kids` : range;
}

module.exports = { slugify, uniqueSlug, getBySlug, getById, createFromSignup, update, setStatus, list, isPublic, displaySizes };
