'use strict';
// The minimal cut (2026-09-21): a link-mode centre has a page, a balance and a
// digest, and nothing else. Pure functions are tested directly; the ledger,
// the daily job and the enrol path run against an in-memory stand-in for
// Supabase so idempotency and the digest watermark are exercised for real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ---- an in-memory Supabase: enough of the query builder for these modules ----
function fakeSupabase() {
  const tables = { vc_centres: [], vc_ledger: [], vc_events: [], vc_visits: [], vc_config: [], vc_discount_codes: [], vc_requests: [], vc_memberships: [], vc_boxes: [] };
  let nextId = 1;
  const uniq = new Set(); // vc_ledger (kind, source_type, source_id)
  function query(table) {
    const q = { filters: [], _order: null, _limit: null, _single: null, _op: 'select', _payload: null, _returning: false };
    const chain = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (res, rej) => run().then(res, rej);
        if (prop === 'select') return () => { if (q._op !== 'select') q._returning = true; return chain; };
        if (prop === 'insert') return payload => { q._op = 'insert'; q._payload = payload; return chain; };
        if (prop === 'update') return payload => { q._op = 'update'; q._payload = payload; return chain; };
        if (prop === 'upsert') return payload => { q._op = 'upsert'; q._payload = payload; return chain; };
        if (prop === 'delete') return () => { q._op = 'delete'; return chain; };
        if (prop === 'order') return (col, o = {}) => { q._order = { col, asc: o.ascending !== false }; return chain; };
        if (prop === 'limit') return n => { q._limit = n; return chain; };
        if (prop === 'maybeSingle') return () => { q._single = 'maybe'; return chain; };
        if (prop === 'single') return () => { q._single = 'strict'; return chain; };
        const ops = { eq: (a, b) => a === b, neq: (a, b) => a !== b, gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b, in: (a, b) => b.includes(a), like: (a, b) => new RegExp('^' + String(b).replace(/%/g, '.*') + '$').test(a), is: (a, b) => a == b };
        if (ops[prop]) return (col, val) => { q.filters.push(r => ops[prop](r[col], val)); return chain; };
        if (prop === 'not') return (col, op, val) => { q.filters.push(r => !(op === 'is' ? r[col] == val : r[col] === val)); return chain; };
        throw new Error(`fake supabase: ${String(prop)} not supported`);
      },
    });
    async function run() {
      const rows = tables[table] || (tables[table] = []);
      const match = r => q.filters.every(f => f(r));
      const finish = out => {
        if (q._single === 'strict') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: `expected one row, got ${out.length}` } };
        if (q._single === 'maybe') return { data: out[0] || null, error: null };
        return { data: out, error: null };
      };
      if (q._op === 'insert' || q._op === 'upsert') {
        const list = Array.isArray(q._payload) ? q._payload : [q._payload];
        const out = [];
        for (const p of list) {
          if (table === 'vc_ledger' && p.source_id != null) {
            const k = `${p.kind}|${p.source_type}|${p.source_id}`;
            if (uniq.has(k)) return { data: null, error: { message: 'duplicate key value violates unique constraint "vc_ledger_source_uniq"' } };
            uniq.add(k);
          }
          const row = { id: nextId++, created_at: new Date(Date.now() + nextId).toISOString(), ...p };
          rows.push(row); out.push(row);
        }
        return finish(out);
      }
      if (q._op === 'update') { const out = rows.filter(match).map(r => Object.assign(r, q._payload)); return finish(out); }
      if (q._op === 'delete') { const keep = rows.filter(r => !match(r)); rows.length = 0; rows.push(...keep); return { data: [], error: null }; }
      let out = rows.filter(match);
      if (q._order) out = out.slice().sort((a, b) => (a[q._order.col] > b[q._order.col] ? 1 : a[q._order.col] < b[q._order.col] ? -1 : 0) * (q._order.asc ? 1 : -1));
      if (q._limit != null) out = out.slice(0, q._limit);
      return finish(out);
    }
    return chain;
  }
  return { tables, client: { from: query } };
}

const fake = fakeSupabase();
const dbPath = require.resolve('../../virtual-closet/lib/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  db: () => fake.client,
  must: ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; },
  fetchAllPaginated: async () => [],
  logEvent: async (centreId, actor, kind, detail = {}) => { fake.tables.vc_events.push({ centre_id: centreId, actor, kind, detail }); },
} };
process.env.VC_EMAIL_MODE = 'console';

const ledger = require('../../virtual-closet/lib/ledger');
const centres = require('../../virtual-closet/lib/centres');
const sponsorship = require('../../virtual-closet/lib/sponsorship');
const { SPONSOR_TILES, MENU } = require('../../virtual-closet/lib/catalog');
const closetView = require('../../virtual-closet/views/closet');
const emails = require('../../virtual-closet/lib/emails');
const daily = require('../../virtual-closet/jobs/daily');

const quiet = async fn => { const log = console.log; const out = []; console.log = (...a) => out.push(a.join(' ')); try { await fn(); } finally { console.log = log; } return out.join('\n'); };

test('balance: raised is money in, redeemed is money spent, and a redemption never changes raised', () => {
  const rows = [
    { kind: 'order_credit', amount_cents: 640, created_at: '2026-09-20T10:00:00Z' },
    { kind: 'order_credit', amount_cents: 800, created_at: '2026-09-21T10:00:00Z' },
    { kind: 'sponsor', amount_cents: 2500, created_at: '2026-09-21T11:00:00Z' },
    { kind: 'redemption', amount_cents: -2000, created_at: '2026-09-22T10:00:00Z' },
    { kind: 'adjustment', amount_cents: -100, created_at: '2026-09-22T11:00:00Z' },
    { kind: 'adjustment', amount_cents: 300, created_at: '2026-09-22T12:00:00Z' },
  ];
  const b = ledger.balanceFromRows(rows);
  assert.equal(b.raisedCents, 640 + 800 + 2500 + 300);
  assert.equal(b.redeemedCents, 2100);
  assert.equal(b.balanceCents, b.raisedCents - 2100);
  assert.equal(b.orders, 2);
  assert.equal(b.sponsors, 1);
  assert.equal(b.lastActivityAt, '2026-09-21T11:00:00Z', 'last activity is the newest order or sponsor, not the redemption');
  assert.deepEqual(ledger.balanceFromRows([]), { raisedCents: 0, redeemedCents: 0, balanceCents: 0, orders: 0, sponsors: 0, lastActivityAt: null });
});

test('digest groups only order credits and sponsors and carries the newest timestamp', () => {
  const d = ledger.digestFromRows([
    { kind: 'order_credit', amount_cents: 640, created_at: '2026-09-21T10:00:00Z' },
    { kind: 'sponsor', amount_cents: 2500, created_at: '2026-09-21T12:00:00Z' },
    { kind: 'redemption', amount_cents: -500, created_at: '2026-09-21T13:00:00Z' },
    { kind: 'order_credit', amount_cents: 1000, created_at: '2026-09-21T11:00:00Z' },
  ]);
  assert.deepEqual(d, { any: true, orders: 2, orderCents: 1640, sponsors: 1, sponsorCents: 2500, maxCreatedAt: '2026-09-21T12:00:00Z' });
  assert.equal(ledger.digestFromRows([]).any, false);
});

test('sponsor tiles are even dollars on the $1 unit variant, with the centre attached and no box in link mode', async () => {
  assert.deepEqual(SPONSOR_TILES.map(t => t.cents), [1000, 2500, 5000, 10000]);
  fake.tables.vc_config.push({ key: 'sponsorship', value: { variants: { unit: { id: 'gid://shopify/ProductVariant/222', cents: 100 } } } });
  require('../../virtual-closet/lib/config').clear();
  const url = await sponsorship.checkoutUrl({ centre: { slug: 'attic', mode: 'link' }, box: null, tile: SPONSOR_TILES[1] });
  assert.ok(url.startsWith('https://rubyshines.com/cart/222:25?'), url);
  assert.ok(url.includes('attributes%5BCloset%5D=attic'));
  assert.ok(url.includes('attributes%5BKind%5D=sponsor'));
  assert.ok(!url.includes('Box'), 'no Box attribute for a link-mode centre');
  const closet = await sponsorship.checkoutUrl({ centre: { slug: 'demo' }, box: { number: 2 }, tile: SPONSOR_TILES[0] });
  assert.ok(closet.includes('attributes%5BBox%5D=2'), 'closet mode still carries the box');
});

test('the link-only page has one door, four tiles, the total line and none of the closet-mode words', () => {
  const centre = { id: 1, slug: 'attic', name: 'The Attic', mode: 'link', logo_url: 'https://cdn.shopify.com/s/files/1/0255/9636/2837/files/attic.png', address: { city: 'Philadelphia' } };
  const empty = closetView.render({ centre, products: MENU, lead: 'request', balance: { raisedCents: 0, orders: 0, sponsors: 0 } });
  assert.ok(empty.includes('The Attic Virtual Closet'), 'title is "[Centre] Virtual Closet"');
  assert.ok(empty.includes('hd-clogo'), 'RUBIES × centre logo in the header');
  assert.ok(empty.includes('Nothing raised yet.'));
  assert.ok(!/undefined|NaN|\[object/.test(empty));
  const html = closetView.render({ centre, products: MENU, lead: 'sponsor', balance: { raisedCents: 8800, orders: 9, sponsors: 3 } });
  assert.ok(html.includes('$88 <small>raised so far</small>'));
  assert.ok(html.includes('RUBIES matches it: <b>$176</b> of underwear and swimwear for the closet.'));
  assert.ok(html.includes('From 9 orders and 3 sponsors.'));
  assert.ok(html.includes("A quarter of your order goes to The Attic's Virtual Closet, and RUBIES matches it."));
  assert.equal((html.match(/\/attic\/sponsor\//g) || []).length, 4, 'four sponsor tiles');
  assert.ok(html.includes('href="/attic/shop"'));
  assert.ok(!/\/attic\/request|Request a pair|Free pair terms|Offer details|Shipment #|goal|\bbox\b/i.test(html), 'no request door, no box, no goal, no terms links');
  assert.ok(!/20% comes off at checkout\. One order per customer|Size guide<\/a>\s*<\/p>\s*<\/div>\s*<div class="hero-art"/.test(html), 'nothing under the button');
  assert.ok(!html.includes('—'), 'no em dashes');
});

test('enrol creates an active link-mode centre from a partner-shaped seed, and refuses a taken slug', async () => {
  const c = await centres.enrol({ name: 'The Attic Youth Center', notify_email: 'Closet@Attic.org', website: 'https://atticyouthcenter.org', logo_url: 'https://cdn.shopify.com/x/attic.png', city: 'Philadelphia', region: 'PA', country: 'US', donation_partner_id: 42, actor: 'operator:test' });
  assert.equal(c.mode, 'link');
  assert.equal(c.status, 'active');
  assert.equal(c.slug, 'the-attic-youth-center');
  assert.equal(c.statements_email, 'closet@attic.org');
  assert.deepEqual(c.programmes, { closet: true, pass_it_on: true });
  assert.equal(c.donation_partner_id, 42);
  assert.ok(centres.isLink(c));
  await assert.rejects(centres.enrol({ name: 'Other', slug: 'the-attic-youth-center', notify_email: 'a@b.co' }), /taken/);
  await assert.rejects(centres.enrol({ name: 'No Email' }), /notification email/);
  const second = await centres.enrol({ name: 'The Attic Youth Center', notify_email: 'x@y.org' });
  assert.equal(second.slug, 'the-attic-youth-center-2', 'a second centre with the same name gets a numbered slug');
  assert.deepEqual(second.programmes, { closet: true, pass_it_on: false });
});

test('recordOrder credits a link-mode centre without a box, once per order, and only the sponsor hears back live', async () => {
  const centre = fake.tables.vc_centres[0];
  fake.tables.vc_discount_codes.push({ centre_id: centre.id, code: 'VC-THEATTIC-ABC123', order_id: null });
  const order = { id: 5001, order_number: 'R1001', email: 'buyer@example.com', financial_status: 'paid', discount_codes: [{ code: 'VC-THEATTIC-ABC123' }], subtotal_price: '25.60', line_items: [] };
  let out = await quiet(async () => { const r = await ledger.recordOrder(order); assert.equal(r.credited.length, 1); assert.equal(r.credited[0].amount_cents, 640); assert.equal(r.credited[0].box_id, null); });
  assert.ok(!out.includes('[vc email'), 'an order credit emails nobody live');
  const again = await ledger.recordOrder(order);
  assert.equal(again.credited.length, 0, 'the same order is not credited twice');
  const sponsorOrder = { id: 5002, order_number: 'R1002', email: 'sponsor@example.com', financial_status: 'paid', discount_codes: [], line_items: [{ id: 77, variant_id: 222, quantity: 25, price: '1.00', properties: [{ name: 'Closet', value: centre.slug }, { name: 'Kind', value: 'sponsor' }] }] };
  out = await quiet(async () => { const r = await ledger.recordOrder(sponsorOrder); assert.equal(r.credited.length, 1); assert.equal(r.credited[0].kind, 'sponsor'); assert.equal(r.credited[0].amount_cents, 2500); });
  assert.ok(out.includes('[vc email → sponsor@example.com]'), 'the sponsor gets the thank-you');
  assert.ok(out.includes("Your $25 went to The Attic Youth Center's Virtual Closet. Thanks for your support."));
  assert.ok(!out.includes(`[vc email → ${centre.statements_email}]`), 'the centre does not hear live; the digest covers it');
  const b = await ledger.balance(centre);
  assert.deepEqual([b.raisedCents, b.orders, b.sponsors, b.balanceCents], [3140, 1, 1, 3140]);
});

test('the daily digest sends once per centre for a day with activity, advances the watermark only when live, and never repeats', async () => {
  const centre = fake.tables.vc_centres[0];
  const dry = await quiet(async () => { const r = await daily.run({ live: false }); assert.equal(r.digests, 1); });
  assert.ok(!dry.includes('[vc email'), 'a dry run sends nothing');
  assert.equal(fake.tables.vc_centres[0].digest_through, undefined, 'a dry run moves no watermark');
  const live = await quiet(async () => { const r = await daily.run({ live: true }); assert.equal(r.digests, 1, JSON.stringify(r)); });
  assert.ok(live.includes(`[vc email → ${centre.statements_email}] The Attic Youth Center's Virtual Closet activity today`));
  assert.ok(live.includes('activity today (from care@rubyshines.com)'), 'the digest comes from care@');
  assert.ok(fake.tables.vc_centres[0].digest_through, 'the watermark moved');
  const again = await quiet(async () => { const r = await daily.run({ live: true }); assert.equal(r.digests, 0); });
  assert.ok(!again.includes('activity today'), 'nothing new, nothing sent');
});

test('redeem debits the balance, refuses over-balance and zero, and is idempotent on the order number', async () => {
  const centre = fake.tables.vc_centres[0];
  await assert.rejects(ledger.redeem({ centre, amountCents: 999999, orderNumber: 'W-1' }), /more than the balance/);
  await assert.rejects(ledger.redeem({ centre, amountCents: 0, orderNumber: 'W-1' }), /more than zero/);
  await assert.rejects(ledger.redeem({ centre, amountCents: 100 }), /order number/);
  const after = await ledger.redeem({ centre, amountCents: 2000, orderNumber: 'W-1', note: 'first order', actor: 'operator:test' });
  assert.equal(after.balanceCents, 1140);
  assert.equal(after.raisedCents, 3140, 'raised is untouched by a redemption');
  assert.equal(after.duplicate, false);
  const dup = await ledger.redeem({ centre, amountCents: 2000, orderNumber: 'W-1' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.balanceCents, 1140, 'the same order number changes nothing');
  await assert.rejects(ledger.redeem({ centre, amountCents: -500, kind: 'adjustment' }), /note/);
  const adj = await ledger.redeem({ centre, amountCents: -500, kind: 'adjustment', note: 'order R1001 refunded' });
  assert.equal(adj.balanceCents, 640);
  const digestAfter = await ledger.digestActivity(centre, { since: centre.digest_through });
  assert.equal(digestAfter.any, false, 'a redemption is not activity for the digest');
});

test('the link-mode emails compose from the right sender with the locked sentences, and the welcome carries the QR', async () => {
  const centre = { id: 9, slug: 'attic', name: 'The Attic', mode: 'link', statements_email: 'closet@attic.org' };
  const out = await quiet(async () => {
    await emails.welcome({ centre, to: 'closet@attic.org' });
    await emails.activity({ centre, to: 'closet@attic.org', orders: 3, orderCents: 2460, sponsors: 1, sponsorCents: 2500, balanceCents: 11240, raisedCents: 18800 });
    await emails.sponsorThanks({ centre, to: 'x@example.com', amountCents: 2500, raised: 8800 });
  });
  assert.ok(!/undefined|NaN/.test(out), out);
  assert.ok(out.includes('Your RUBIES Virtual Closet is ready. (from jamie@rubyshines.com)'));
  assert.ok(out.includes('attachments: closet-qr.png'));
  assert.ok(out.includes("The Attic's Virtual Closet activity today (from care@rubyshines.com)"));
  assert.ok(out.includes("Thank you from The Attic's Virtual Closet (from care@rubyshines.com)"));
  assert.ok(out.includes('3 orders through your link put $24.60 in.'));
  assert.ok(out.includes('Your balance is $112.40.'));
  assert.ok(out.includes('50% off any order where the retail value before the discount is $600 or more'));
  assert.ok(!/printable|fact sheet/i.test(out), 'no printable promise');
  assert.ok(!/\bmatch/i.test(out.split('activity today')[1].split('Thank you from')[0]), 'the digest does not use the word match');
  assert.ok(!out.includes('—'), 'no em dashes');
});

test('the QR encodes the centre page URL', async () => {
  const QRCode = require('qrcode');
  const svg = await QRCode.toString('http://localhost:3850/attic', { type: 'svg' });
  assert.ok(svg.startsWith('<svg'));
  const png = await QRCode.toBuffer('http://localhost:3850/attic', { type: 'png', width: 720 });
  assert.equal(png.slice(1, 4).toString(), 'PNG');
  assert.ok(png.length > 1000);
});
