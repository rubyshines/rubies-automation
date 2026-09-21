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
 *   node virtual-closet/scripts/smoke.js          # the full closet-mode flow, then the link-mode pass
 *   node virtual-closet/scripts/smoke.js --link   # the link-mode pass only (the minimal cut, 2026-09-21)
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
  const res = await fetch(`${BASE}${path}`, { method, redirect: 'manual', headers: { cookie: cookieHeader(), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? encodeForm(form) : undefined });
  storeCookies(res);
  const text = await res.text();
  return { status: res.status, location: res.headers.get('location'), text };
}
function encodeForm(form) { const p = new URLSearchParams(); for (const [k, v] of Object.entries(form)) { if (Array.isArray(v)) v.forEach(x => p.append(k, x)); else p.append(k, v); } return p.toString(); }
function ok(cond, label) { if (!cond) { console.error(`✗ ${label}`); process.exit(1); } console.log(`✓ ${label}`); }
async function latestToken(purpose) {
  const rows = must(await db().from('vc_tokens').select('*').eq('purpose', purpose).is('used_at', null).order('created_at', { ascending: false }).limit(1), 'token');
  return rows[0];
}

// ---- link mode: enrol, page, shop, a fake order and a fake sponsorship, digest, redeem ----
async function linkPass() {
  const stamp = Date.now().toString(36);
  const centres = require('../lib/centres');
  const ledger = require('../lib/ledger');
  const emails = require('../lib/emails');
  const daily = require('../jobs/daily');
  const centre = await centres.enrol({ name: `Smoke Link ${stamp}`, notify_email: `smoke-link-${stamp}@example.org`, city: 'Philadelphia', region: 'PA', actor: 'smoke' });
  ok(centre.mode === 'link' && centre.status === 'active', 'enrol creates an active link-mode centre');
  const w = await emails.welcome({ centre, to: centre.statements_email });
  ok(w.ok, 'welcome email composes (console mode) with the QR attached');
  let r = await call(`/${centre.slug}`);
  ok(r.status === 200 && r.text.includes(`${centre.name} Virtual Closet`) && r.text.includes('Nothing raised yet') && !/undefined|NaN/.test(r.text), 'link page renders empty');
  ok(!/\/request|Shipment #|Free pair terms/.test(r.text), 'no request door, shipment or terms on the link page');
  r = await call(`/${centre.slug}?lead=request`);
  ok(r.status === 200 && !r.text.includes('Request a pair'), '?lead is ignored in link mode');
  r = await call(`/${centre.slug}/request`);
  ok(r.status === 404, 'the request form is gone for a link-mode centre');
  r = await call(`/${centre.slug}/qr.png`);
  ok(r.status === 200, 'the QR is served');
  r = await call(`/${centre.slug}/shop`);
  ok(r.status === 302 && /rubyshines\.com/.test(r.location), `shop redirects to the store (${r.location})`);
  // A fake paid order carrying one of the centre's codes, and a fake sponsorship line.
  must(await db().from('vc_discount_codes').insert({ centre_id: centre.id, code: `VC-SMOKE-${stamp.toUpperCase()}` }), 'code');
  let res = await ledger.recordOrder({ id: `smoke-${stamp}-1`, order_number: `S${stamp}`, email: 'buyer@example.com', financial_status: 'paid', discount_codes: [{ code: `VC-SMOKE-${stamp.toUpperCase()}` }], subtotal_price: '25.60', line_items: [] });
  ok(res.credited.length === 1 && res.credited[0].amount_cents === 640 && !res.credited[0].box_id, 'an order through the link credits a quarter of what was paid, with no box');
  const sponsorship = require('../lib/sponsorship');
  const s = await sponsorship.settings();
  if (s?.variants?.unit) {
    res = await ledger.recordOrder({ id: `smoke-${stamp}-2`, order_number: `S${stamp}b`, email: 'sponsor@example.com', financial_status: 'paid', discount_codes: [], line_items: [{ id: `smoke-li-${stamp}`, variant_id: sponsorship.numericId(s.variants.unit.id), quantity: 10, price: '1.00', properties: [{ name: 'Closet', value: centre.slug }, { name: 'Kind', value: 'sponsor' }] }] });
    ok(res.credited.length === 1 && res.credited[0].kind === 'sponsor' && res.credited[0].amount_cents === 1000, 'a $10 sponsorship credits $10 and thanks the sponsor');
  } else console.log('· sponsorship product not set up on this database; skipping the sponsor order');
  r = await call(`/${centre.slug}`);
  ok(r.text.includes('raised so far') && r.text.includes('RUBIES matches it'), 'the total line shows what was raised');
  const dry = await daily.run({ live: false });
  ok(dry.digests >= 1, 'a dry daily run counts the digest without sending');
  const live = await daily.run({ live: true });
  ok(live.digests >= 1, 'a live daily run sends the digest (console)');
  const after = await centres.getById(centre.id);
  ok(!!after.digest_through, 'the digest watermark moved');
  const again = await daily.run({ live: true });
  const mine = must(await db().from('vc_events').select('id').eq('centre_id', centre.id).eq('kind', 'digest.sent'), 'digest events');
  ok(mine.length === 1 && again.digests === 0, 'a second run sends nothing new');
  const bal = await ledger.redeem({ centre, amountCents: 500, orderNumber: `W-${stamp}`, note: 'smoke', actor: 'smoke' });
  ok(bal.balanceCents === (await ledger.balance(centre)).balanceCents && bal.redeemedCents === 500, 'a redemption debits the balance');
  const dup = await ledger.redeem({ centre, amountCents: 500, orderNumber: `W-${stamp}`, actor: 'smoke' });
  ok(dup.duplicate === true, 'the same order number is a no-op');
  console.log(`link-mode smoke done: ${BASE}/${centre.slug}`);
}

if (process.argv.includes('--link')) {
  linkPass().then(() => process.exit(0)).catch(err => { console.error('✗ crashed:', err); process.exit(1); });
} else (async () => {
  const stamp = Date.now().toString(36);
  const name = `Smoke Centre ${stamp}`;
  const adminEmail = `smoke-admin-${stamp}@example.org`;

  // 1. sign-up step 1
  let r = await call('/signup', { method: 'POST', form: { name, website: 'https://example.org', closet: '1', pass_it_on: '', sizes: ['S', 'M', 'L', '1X'], kids_sizes: '' } });
  if (r.status !== 302) console.error(r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400));
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
  if (!(r.status === 200 && r.text.includes('Box #1 is on its way to RUBIES'))) console.error(r.status, r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').match(/Something went wrong|error[^.]*\./i)?.[0] || r.text.slice(0, 300));
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
  await linkPass();
  process.exit(0);
})().catch(err => { console.error('✗ crashed:', err); process.exit(1); });
