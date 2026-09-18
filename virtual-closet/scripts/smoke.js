#!/usr/bin/env node
'use strict';
/**
 * End-to-end smoke test against a running service (emails in console mode):
 * sign up a centre, verify, approve as the operator, request a pair, confirm
 * it, sponsor by writing a fake order through the ledger, fund and send the
 * box, ship and deliver it. Prints each step; exits non-zero on the first
 * failure. Leaves the rows in place (slug smoke-<timestamp>) for a look.
 *
 *   PORT=3850 VC_EMAIL_MODE=console node virtual-closet/server.js &
 *   node virtual-closet/scripts/smoke.js
 */
require('dotenv').config();
const BASE = process.env.VC_BASE_URL || `http://localhost:${process.env.PORT || 3850}`;
const { db, must } = require('../lib/db');
const auth = require('../lib/auth');

const jar = new Map();
function cookieHeader() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
function storeCookies(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of set) { const [kv] = c.split(';'); const [k, ...v] = kv.split('='); if (v.join('=') === '') jar.delete(k); else jar.set(k, v.join('=')); }
}
async function call(path, { method = 'GET', form = null } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, redirect: 'manual', headers: { cookie: cookieHeader(), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
  storeCookies(res);
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}
function ok(cond, label) { if (!cond) { console.error(`✗ ${label}`); process.exit(1); } console.log(`✓ ${label}`); }
async function latestToken(purpose) {
  const rows = must(await db().from('vc_tokens').select('*').eq('purpose', purpose).is('used_at', null).order('created_at', { ascending: false }).limit(1), 'token');
  return rows[0];
}

(async () => {
  const stamp = Date.now().toString(36);
  const name = `Smoke Centre ${stamp}`;
  const adminEmail = `smoke-admin-${stamp}@example.org`;

  // 1. sign-up step 1
  let r = await call('/signup', { method: 'POST', form: { name, website: 'https://example.org', closet: '1', pass_it_on: '', sizes: ['S', 'M', 'L', '1X'], kids_sizes: '' } });
  ok(r.status === 302 && r.location.endsWith('/signup/account'), 'step 1 creates a pending centre');
  // 2. step 2 account
  r = await call('/signup/account', { method: 'POST', form: { name: 'Sam Smoke', role_title: 'Coordinator', email: adminEmail, password: 'correct horse battery' } });
  ok(r.status === 302 && r.location.endsWith('/verify'), 'step 2 creates the admin and asks to verify');
  // 3. verify via the token the email carried (we read it from the table; raw token is not stored, so mint one)
  const user = await auth.getUserByEmail(adminEmail);
  const centreRow = must(await db().from('vc_memberships').select('centre_id').eq('user_id', user.id).single(), 'membership');
  const raw = await auth.issueToken('verify_email', { userId: user.id, email: adminEmail, payload: { centre_id: centreRow.centre_id } });
  r = await call(`/verify/${raw}`);
  ok(r.status === 302 && r.location.endsWith('/welcome'), 'verify link lands on the waiting-for-approval page');
  r = await call('/welcome');
  ok(r.status === 200 && r.text.includes("You're in the queue"), 'welcome page renders');
  // 4. operator approves
  const operator = require('../lib/operator');
  const centre = await operator.approveCentre(centreRow.centre_id, 'smoke@rubyshines.com');
  ok(centre.status === 'active', 'operator approval activates the centre');
  // 5. public page and arrangements
  for (const lead of ['', '?lead=shop', '?lead=request', '?lead=sponsor']) {
    r = await call(`/${centre.slug}${lead}`);
    ok(r.status === 200 && r.text.includes(`${name}'s closet`) && !/undefined|NaN/.test(r.text), `closet page ${lead || 'default'} renders clean`);
  }
  // 6. home
  r = await call('/home');
  ok(r.status === 200 && r.text.includes('Box #1'), 'centre Home shows box #1');
  // 7. a request, unverified email → confirm link
  jar.delete('vc_session');
  r = await call(`/${centre.slug}/request`, { method: 'POST', form: { 'items[0][style]': 'aj', 'items[0][colour]': 'Black', 'items[0][size]': '1X', delivery: 'pickup', words: 'Summer camp is soon.', share: '1', name: 'Rosa', email: `rosa-${stamp}@example.com`, newsletter: '' } });
  ok(r.status === 200 && r.text.includes('One more step'), 'request from a new email asks for confirmation');
  const reqRow = must(await db().from('vc_requests').select('*').eq('centre_id', centre.id).order('created_at', { ascending: false }).limit(1).single(), 'request');
  const rawReq = await auth.issueToken('request_verify', { email: reqRow.email, payload: { request_id: reqRow.id, centre_id: centre.id } });
  r = await call(`/${centre.slug}/request/confirm/${rawReq}`);
  ok(r.status === 200 && r.text.includes('Got it, Rosa'), 'confirm link approves the request automatically');
  const placed = must(await db().from('vc_requests').select('status, box_id').eq('id', reqRow.id).single(), 'placed');
  ok(placed.status === 'approved' && placed.box_id, 'request is approved into box #1');
  // 8. a second request from the same, now verified, email goes straight in; a third hits the yearly limit
  r = await call(`/${centre.slug}/request`, { method: 'POST', form: { 'items[0][style]': 'ruby', 'items[0][colour]': 'Black', 'items[0][size]': 'M', delivery: 'ship', street: '9 Elm', city: 'Urbana', region: 'IL', postal: '61801', name: 'Rosa', email: `rosa-${stamp}@example.com` } });
  ok(r.status === 200 && r.text.includes('Got it, Rosa'), 'verified email skips confirmation');
  r = await call(`/${centre.slug}/request`, { method: 'POST', form: { 'items[0][style]': 'aj', 'items[0][colour]': 'Black', 'items[0][size]': 'S', delivery: 'pickup', name: 'Rosa', email: `rosa-${stamp}@example.com` } });
  ok(r.status === 400 && r.text.includes('you can request again from'), 'third request in a year is refused inline');
  // 9. sponsor: a fake paid order through the ledger (webhook shape), enough to fund the box
  const ledger = require('../lib/ledger');
  const config = require('../lib/config');
  const s = (await config.get('sponsorship')) || { variants: { full: { id: 'gid://shopify/ProductVariant/1', cents: 30000 } } };
  const variant = s.variants.full;
  const { credited } = await ledger.recordOrder({ id: `smoke-${stamp}`, order_number: 90001, email: `sponsor-${stamp}@example.com`, financial_status: 'paid', subtotal_price: '300.00', discount_codes: [], line_items: [{ id: `li-${stamp}`, variant_id: String(variant.id).split('/').pop(), quantity: 1, price: '300.00', properties: [{ name: 'Closet', value: centre.slug }, { name: 'Box', value: '1' }, { name: 'Kind', value: 'sponsor' }] }] }, { lineItems: null, emit: true });
  ok(credited.length === 1 && credited[0].amount_cents === 30000, 'a $300 sponsorship credits the box');
  const again = await ledger.recordOrder({ id: `smoke-${stamp}`, financial_status: 'paid', subtotal_price: '300.00', line_items: [{ id: `li-${stamp}`, variant_id: String(variant.id).split('/').pop(), quantity: 1, price: '300.00', properties: [{ name: 'Closet', value: centre.slug }] }] });
  ok(again.credited.length === 0, 'the same order again credits nothing');
  // 10. shop code
  try {
    const discounts = require('../lib/discounts');
    if (await config.get('discount')) { r = await call(`/${centre.slug}/shop`); ok(r.status === 302 && /\/discount\/VC-/.test(r.location), 'shop issues a VC- code and redirects to the store'); }
    else console.log('· shop code skipped (discount not set up; run setupShopify.js --create)');
    void discounts;
  } catch (err) { console.log(`· shop code skipped: ${err.message}`); }
  // 11. send the box as the admin
  const sid = await auth.createSession(user.id); jar.set('vc_session', `${sid}.${require('crypto').createHmac('sha256', process.env.VC_SESSION_SECRET || process.env.SESSION_SECRET || 'dev-only-secret').update(sid).digest('base64url')}`);
  r = await call('/send');
  ok(r.status === 200 && r.text.includes('Send box #1') && r.text.includes('Rosa'), 'send page lists the requested items');
  r = await call('/send', { method: 'POST', form: { fill_mode: 'auto', pickup_note: 'Front desk, ask for the closet.', delivery_note: 'Coming from RUBIES.', remember: '1', action: 'send' } });
  ok(r.status === 200 && r.text.includes('Box #1 is on its way to RUBIES'), 'box #1 sends and box #2 opens');
  const boxes = require('../lib/boxes');
  const b1 = await boxes.getBoxByNumber(centre.id, 1);
  const b2 = await boxes.getOpenBox(centre.id);
  ok(b1.status === 'sent' && b2 && b2.number === 2, 'box states are right after send');
  // 12. operator ships and delivers
  await operator.markShipped(b1.id, { carrier: 'UPS', tracking: '1Z-SMOKE', operatorEmail: 'smoke@rubyshines.com' });
  await operator.markDelivered(b1.id, { operatorEmail: 'smoke@rubyshines.com' });
  const after = must(await db().from('vc_requests').select('status, delivery').eq('box_id', b1.id), 'after');
  ok(after.every(q => (q.delivery === 'pickup' ? q.status === 'ready' : q.status === 'shipped')), 'pickups are ready, shipped items are shipped');
  // 13. needs attention and packing list do not throw
  const a = await operator.needsAttention();
  ok(a && a.week, 'needs attention computes');
  const p = await operator.packingList(b1.id);
  ok(p && p.requests.length === 2, 'packing list shows both requests');
  console.log(`\nAll good. Centre ${centre.slug}: ${BASE}/${centre.slug}`);
  process.exit(0);
})().catch(err => { console.error('✗ crashed:', err); process.exit(1); });
