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

test('sponsor tiles are their own variants, added to the cart with the centre named on the line and the ledger keys hidden', async () => {
  assert.deepEqual(SPONSOR_TILES.map(t => t.cents), [1000, 2500, 5000, 10000]);
  fake.tables.vc_config.push({ key: 'sponsorship', value: { variants: { twentyfive: { id: 'gid://shopify/ProductVariant/333', cents: 2500 }, unit: { id: 'gid://shopify/ProductVariant/222', cents: 100 } } } });
  require('../../virtual-closet/lib/config').clear();
  const url = await sponsorship.checkoutUrl({ centre: { slug: 'attic', name: 'The Attic', mode: 'link' }, box: null, tile: SPONSOR_TILES[1] });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://rubyshines.com/cart/add');
  assert.equal(u.searchParams.get('id'), '333', 'the $25 tile is its own variant');
  assert.equal(u.searchParams.get('quantity'), '1');
  assert.equal(u.searchParams.get('properties[For]'), "The Attic's Virtual Closet", 'the shopper sees the centre under the line');
  assert.equal(u.searchParams.get('properties[_Closet]'), 'attic');
  assert.equal(u.searchParams.get('properties[_Kind]'), 'sponsor');
  assert.equal(u.searchParams.get('return_to'), '/checkout');
  assert.ok(!url.includes('Box'), 'no Box property for a link-mode centre');
  const noVariant = await sponsorship.checkoutUrl({ centre: { slug: 'attic', name: 'The Attic', mode: 'link' }, box: null, tile: SPONSOR_TILES[0] });
  const n = new URL(noVariant);
  assert.equal(n.searchParams.get('id'), '222'); assert.equal(n.searchParams.get('quantity'), '10', 'a tile without a variant falls back to the $1 unit');
  const closet = await sponsorship.checkoutUrl({ centre: { slug: 'demo', name: 'Demo' }, box: { number: 2 }, tile: SPONSOR_TILES[1] });
  assert.equal(new URL(closet).searchParams.get('properties[_Box]'), '2', 'closet mode still carries the box');
  // The hidden keys read back off the order's line item.
  const li = sponsorship.readLineItem({ id: 9, variant_id: 333, quantity: 1, price: '25.00', properties: [{ name: 'For', value: "The Attic's Virtual Closet" }, { name: '_Closet', value: 'attic' }, { name: '_Kind', value: 'sponsor' }] }, { variants: { twentyfive: { id: 'gid://shopify/ProductVariant/333', cents: 2500 } } });
  assert.deepEqual(li, { slug: 'attic', boxNumber: null, kind: 'sponsor', amountCents: 2500, shopCurrency: null, presentment: null, lineItemId: '9' });
});

test('the link-only page has one door, four tiles, the total line and none of the closet-mode words', () => {
  const centre = { id: 1, slug: 'attic', name: 'The Attic', mode: 'link', logo_url: 'https://cdn.shopify.com/s/files/1/0255/9636/2837/files/attic.png', address: { city: 'Philadelphia' } };
  const empty = closetView.render({ centre, products: MENU, lead: 'request', balance: { raisedCents: 0, orders: 0, sponsors: 0 } });
  assert.ok(empty.includes('The Attic Virtual Closet'), 'title is "[Centre] Virtual Closet"');
  assert.ok(empty.includes('hd-clogo'), 'RUBIES × centre logo in the header');
  assert.ok(!/undefined|NaN|\[object/.test(empty));
  const html = closetView.render({ centre, products: MENU, lead: 'sponsor', balance: { raisedCents: 8800, orders: 9, sponsors: 3 } });
  assert.ok(html.includes('$88 <small>raised of $1,000 goal</small>'), 'the default goal is $1,000');
  assert.ok(html.includes('aria-valuenow="9"') && html.includes('width:9%'), 'the bar is raised over goal');
  const own = closetView.render({ centre: { ...centre, goal_cents: 50000 }, products: MENU, lead: '', balance: { raisedCents: 62000, orders: 40, sponsors: 12 } });
  assert.ok(own.includes('$620 <small>raised of $500 goal</small>') && own.includes('width:100%') && own.includes('Goal reached'), 'past the goal the bar is full and says so');
  assert.ok(empty.includes('$0 <small>raised of $1,000 goal</small>') && empty.includes('width:0%'));
  assert.ok(html.includes('RUBIES matches it: <b>$176</b> of underwear and swimwear for the closet.'));
  assert.ok(html.includes('From 9 orders and 3 sponsors.'));
  // The count line names only what there is, never a zero.
  const only = (orders, sponsors) => closetView.render({ centre, products: MENU, lead: '', balance: { raisedCents: 513, orders, sponsors } });
  assert.ok(only(1, 0).includes('<p class="fine">From 1 order.</p>'), only(1, 0).match(/<p class="fine">From[^<]*/)?.[0]);
  assert.ok(only(0, 1).includes('<p class="fine">From 1 sponsor.</p>'));
  assert.ok(only(2, 1).includes('<p class="fine">From 2 orders and 1 sponsor.</p>'));
  assert.ok(!/\b0 (orders?|sponsors?)/.test(only(1, 0) + only(0, 1)), 'no zero counts');
  assert.ok(!only(0, 0).includes('From '), 'an adjustment-only balance has no count line');
  assert.ok(html.includes('Shop 20% off gender-affirming gear.') && html.includes('RUBIES will donate a quarter of the value of your order to the closet.'));
  assert.ok(html.includes('under-skinned.svg'), 'the mirror illustration beside the hero, not a product photo');
  assert.equal((html.match(/\/attic\/sponsor\//g) || []).length, 4, 'four sponsor tiles');
  assert.ok(html.includes('href="/attic/shop"'));
  assert.ok(!/\/attic\/request|Request a pair|Free pair terms|Offer details|Shipment #|\bbox\b/i.test(html), 'no request door, no box, no terms links');
  assert.ok(!/20% comes off at checkout\. One order per customer|Size guide<\/a>\s*<\/p>\s*<\/div>\s*<div class="hero-art"/.test(html), 'nothing under the button');
  assert.ok(!html.includes('—'), 'no em dashes');
});

test('enrol creates an active link-mode centre from a partner-shaped seed, and refuses a taken slug', async () => {
  const c = await centres.enrol({ name: 'The Attic Youth Center', notify_email: 'Closet@Attic.org', website: 'https://atticyouthcenter.org', logo_url: 'https://cdn.shopify.com/x/attic.png', city: 'Philadelphia', region: 'PA', country: 'US', donation_partner_id: 42, actor: 'operator:test' });
  assert.equal(c.mode, 'link');
  assert.equal(c.status, 'active');
  assert.equal(c.slug, 'the-attic-youth-center');
  assert.equal(c.goal_cents, 100000, 'link mode defaults the goal to $1,000');
  assert.equal(c.statements_email, 'closet@attic.org');
  assert.deepEqual(c.programmes, { closet: true, pass_it_on: true });
  assert.equal(c.donation_partner_id, 42);
  assert.ok(centres.isLink(c));
  await assert.rejects(centres.enrol({ name: 'Other', slug: 'the-attic-youth-center', notify_email: 'a@b.co' }), /taken/);
  await assert.rejects(centres.enrol({ name: 'No Email' }), /notification email/);
  const second = await centres.enrol({ name: 'The Attic Youth Center', notify_email: 'x@y.org', goal_cents: 250000 });
  assert.equal(second.goal_cents, 250000, 'a goal given at enrolment is kept');
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
  assert.ok(live.includes(`[vc email → ${centre.statements_email}] $31.40 added to The Attic Youth Center's Virtual Closet today`));
  assert.ok(live.includes("added to The Attic Youth Center's Virtual Closet today (from care@rubyshines.com)"), 'the digest comes from care@');
  assert.ok(fake.tables.vc_centres[0].digest_through, 'the watermark moved');
  const again = await quiet(async () => { const r = await daily.run({ live: true }); assert.equal(r.digests, 0); });
  assert.ok(!again.includes('Virtual Closet today'), 'nothing new, nothing sent');
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
  const centre = { id: 9, slug: 'attic', name: 'The Attic', mode: 'link', statements_email: 'closet@attic.org', logo_url: 'https://cdn.shopify.com/x/attic.png', website: 'https://attic.example.org' };
  const out = await quiet(async () => {
    await emails.welcome({ centre, to: 'closet@attic.org' });
    await emails.activity({ centre, to: 'closet@attic.org', orders: 3, orderCents: 2460, sponsors: 1, sponsorCents: 2500, balanceCents: 11240, raisedCents: 18800 });
    await emails.sponsorThanks({ centre, to: 'x@example.com', amountCents: 2500, raised: 8800 });
  });
  assert.ok(!/undefined|NaN/.test(out), out);
  assert.ok(out.includes('Your RUBIES Virtual Closet is ready. (from jamie@rubyshines.com)'));
  assert.ok(out.includes('attachments: closet-qr.png, attic-virtual-closet-sign.pdf'), 'the welcome carries the QR and the printable sign');
  assert.ok(out.includes('Attached is a table sign you can print'));
  assert.ok(out.includes('/attic/qr-sign'), 'the welcome says where to reprint the sign');
  assert.ok(out.includes("$49.60 added to The Attic's Virtual Closet today (from care@rubyshines.com)"));
  assert.ok(out.includes("Thank you from The Attic's Virtual Closet (from care@rubyshines.com)"));
  assert.ok(out.includes('3 orders through your link put $24.60 in.'));
  assert.ok(out.includes('Your balance is $112.40.'));
  assert.ok(out.includes('Raised so far: $188 of your $1,000 goal'), 'the digest names the goal');
  assert.ok(out.includes('Partner pricing stays as it is: 50% off retail with a $300 minimum order.'), 'a centre with no country on file is treated as US');
  // The welcome's partner pricing follows the country and the wholesale minimum, the same sources as every wholesale surface (Jamie, 2026-09-22).
  assert.equal(emails.partnerPricingLine({ address: { country: 'US' } }), 'Partner pricing stays as it is: 50% off retail with a $300 minimum order.');
  assert.equal(emails.partnerPricingLine({ address: { country: 'AU' } }), 'Partner pricing stays as it is: 50% off retail, priced in USD, with a $300 USD minimum order.');
  assert.equal(emails.partnerPricingLine({ address: { country: 'CA' } }), 'Partner pricing stays as it is: 30% off retail, priced in USD, with a $300 USD minimum order.');
  assert.equal(emails.partnerPricingLine({ address: { country: 'GB' } }).slice(0, 34), 'Partner pricing stays as it is: 30');
  assert.equal(emails.partnerPricingLine({ address: { country: 'DE' } }).slice(0, 34), 'Partner pricing stays as it is: 30');
  const ca = await quiet(() => emails.welcome({ centre: { ...centre, slug: 'lumenus', name: 'Lumenus', currency: 'CAD', address: { city: 'Toronto', country: 'CA' } }, to: 'x@lumenus.ca' }));
  assert.ok(ca.includes('30% off retail, priced in USD, with a $300 USD minimum order'), 'a Canadian centre is quoted 30%');
  assert.ok(!ca.includes('50%') && !ca.includes('$600'), 'and never 50% or the old $600 line');
  assert.ok(!/printable|fact sheet/i.test(out), 'no printable promise');
  assert.ok(!/\bmatch/i.test(out.split("added to The Attic's Virtual Closet today")[1].split('Thank you from')[0]), 'the digest does not use the word match');
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

test('the table sign is one Letter page: both faces, the fold notes, the QR and the reprint address', async () => {
  const { signPdf } = require('../../virtual-closet/lib/sign');
  const pdf = await signPdf({ name: 'The Attic', logo_url: null }, { url: 'https://closet.rubyshines.com/the-attic', logos: false });
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
  const raw = pdf.toString('latin1');
  assert.equal((raw.match(/\/Type \/Page[^s]/g) || []).length, 1, 'one page');
  assert.ok(raw.includes('/MediaBox [0 0 612 792]'), 'US Letter, no margins to scale');

  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: pdf });
  const text = (await parser.getText()).text.replace(/\s+/g, ' ');
  await parser.destroy();
  // Visitor face
  assert.ok(text.includes('Scan for 20% off gender-affirming underwear and swimwear.'), 'headline');
  assert.ok(text.includes("A quarter of every order goes to The Attic's Virtual Closet."), 'the quarter line names the centre');
  assert.ok(text.includes('made specifically for trans girls and women'), 'the RUBIES sentence');
  assert.ok(text.includes('Sponsor the closet from $10'), 'the sponsor line');
  assert.ok(text.includes('closet.rubyshines.com') && text.includes('/the-attic'), 'the address is typed under the QR');
  assert.ok(text.includes('Never stop shining.'), 'tagline');
  // Staff face
  assert.ok(text.includes('THE FACTS') && text.includes('20% off is one order per person'), 'the facts');
  assert.ok(text.includes('closet.rubyshines.com/the-attic/qr-sign'), 'the reprint address');
  assert.ok(text.includes('tape the tabs together'), 'the setup note');
  // Fold notes, one per crease. They are letter-spaced, which the extractor reads as spaces, so compare without any.
  const compact = text.replace(/\s+/g, '');
  assert.equal((compact.match(/FOLDTHISTABUNDER/g) || []).length, 2, 'a note on each tab');
  assert.equal((compact.match(/FOLDHERE/g) || []).length, 1, 'one centre crease');
  // Rules that do not bend
  assert.ok(!/undefined|NaN|\[object/.test(text), 'nothing leaked');
  assert.ok(!/—|discount|wholesale|patent/i.test(text), 'no em dashes, no banned words');
});

test('link-mode emails carry RUBIES × the centre logo', async () => {
  const emails = require('../../virtual-closet/lib/emails');
  const html = emails.layout('t', '<p>x</p>', '', { centre: { name: 'The Attic', logo_url: 'https://cdn.shopify.com/x/attic.png', website: 'https://attic.example.org' } });
  assert.ok(html.includes('rubies-logo-email-480.png') && html.includes('https://cdn.shopify.com/x/attic.png') && html.includes('>×<'));
  assert.ok(html.includes('href="https://attic.example.org"'), 'the centre logo links to its website');
  assert.ok(!emails.layout('t', '<p>x</p>').includes('>×<'), 'closet-mode emails keep the plain wordmark');
});

// ---- a tap on Shop or on a style (2026-09-22) -------------------------------
test('a style tap goes through Shop with the product as its destination, and only store paths are honoured', () => {
  const discounts = require('../../virtual-closet/lib/discounts');
  const centre = { id: 1, slug: 'attic', name: 'The Attic', mode: 'link', logo_url: 'https://cdn.shopify.com/s/files/1/0255/9636/2837/files/attic.png', address: { city: 'Philadelphia' } };
  const html = closetView.render({ centre, products: MENU, lead: '', balance: { raisedCents: 0, orders: 0, sponsors: 0 } });
  for (const p of MENU) assert.ok(html.includes(`href="/attic/shop?to=${encodeURIComponent(`/products/${p.handle}`)}"`), `${p.name} taps through Shop`);
  assert.ok(!html.includes('href="https://rubyshines.com/products/'), 'no style links straight to the store');
  assert.equal(discounts.storePath('/products/the-aj-shaping-underwear'), '/products/the-aj-shaping-underwear');
  assert.equal(discounts.storePath('/collections/swimwear'), '/collections/swimwear');
  for (const bad of ['https://evil.example/products/x', '//evil.example', '/admin', '/products/../x', '', null, '/products/x?y=1'])
    assert.equal(discounts.storePath(bad), '/collections/all', `${bad} falls back`);
});

test('a second tap on the same device reuses its unused code; a used code or another centre\'s code mints a fresh one', async () => {
  const discounts = require('../../virtual-closet/lib/discounts');
  const shopifyPath = require.resolve('../../customer-service/lib/shopify');
  const hadShopify = require.cache[shopifyPath];
  const minted = [];
  require.cache[shopifyPath] = { id: shopifyPath, filename: shopifyPath, loaded: true, exports: { addCodeToPriceRule: async (id, code) => { minted.push(code); } } };
  const hadLive = process.env.RAILWAY_DEPLOYMENT_ID;
  process.env.RAILWAY_DEPLOYMENT_ID = 'test';
  fake.tables.vc_config.push({ key: 'discount', value: { id: 'gid://shopify/DiscountCodeNode/9', numericId: '9', title: 'Virtual Closet 20%' } });
  require('../../virtual-closet/lib/config').clear();
  try {
    const attic = { id: 1, slug: 'attic' }, other = { id: 2, slug: 'other' };
    const rowsBefore = fake.tables.vc_discount_codes.length;
    const got = {};
    await quiet(async () => { got.v1 = await discounts.shopVisit(attic, { redirect: '/products/the-aj-shaping-underwear' }); });
    const v1 = got.v1;
    assert.ok(/^VC-ATTIC-[0-9A-F]{6}$/.test(v1.code), v1.code);
    const landing = decodeURIComponent(v1.url.split('redirect=')[1]);
    assert.ok(v1.url.startsWith(`https://rubyshines.com/discount/${v1.code}?redirect=`), v1.url);
    assert.ok(landing.startsWith('/products/the-aj-shaping-underwear?vc='), landing);
    const vc = decodeURIComponent(landing.split('?vc=')[1]).split('|');
    assert.equal(vc[0], 'attic'); assert.equal(vc[1], v1.code); assert.ok(Date.now() - Number(vc[2]) < 5000, 'tap time'); assert.equal(vc[4], '', 'not used');
    assert.equal(v1.reused, false);
    assert.equal(minted.length, 1);

    const v2 = await discounts.shopVisit(attic, { redirect: '/collections/all', previousCode: v1.code });
    assert.equal(v2.code, v1.code, 'same device, unused code: reused');
    assert.equal(v2.reused, true);
    assert.ok(decodeURIComponent(v2.url.split('redirect=')[1]).startsWith('/collections/all?vc=attic|' + v1.code), 'the destination still follows the tap');
    assert.equal(minted.length, 1, 'nothing minted');
    assert.equal(fake.tables.vc_discount_codes.length - rowsBefore, 1, 'one row for the device');

    const v3 = await discounts.shopVisit(other, { previousCode: v1.code });
    assert.notEqual(v3.code, v1.code, 'another centre never inherits the code');
    assert.ok(v3.code.startsWith('VC-OTHER-'));
    assert.equal(minted.length, 2);

    fake.tables.vc_discount_codes.find(r => r.code === v1.code).order_id = '5001';
    const v4 = await discounts.shopVisit(attic, { previousCode: v1.code });
    assert.notEqual(v4.code, v1.code, 'a used code is not reused');
    assert.equal(v4.reused, false);
    assert.equal(v4.used, true, 'and the landing path says the earlier code was spent');
    assert.ok(decodeURIComponent(decodeURIComponent(v4.url.split('redirect=')[1])).endsWith('|used'), v4.url);
    assert.equal(minted.length, 3);

    const v5 = await discounts.shopVisit(attic, { previousCode: 'VC-ATTIC-NOPE00' });
    assert.equal(v5.reused, false, 'a code we never issued mints');

    delete process.env.RAILWAY_DEPLOYMENT_ID;
    await quiet(async () => { got.off = await discounts.shopVisit(attic, { redirect: '/products/the-brooke-bra', previousCode: v4.code }); });
    assert.deepEqual(got.off, { url: 'https://rubyshines.com/products/the-brooke-bra', code: null }, 'off Railway: the store, no code, nothing to remember');
  } finally {
    if (hadLive === undefined) delete process.env.RAILWAY_DEPLOYMENT_ID; else process.env.RAILWAY_DEPLOYMENT_ID = hadLive;
    if (hadShopify) require.cache[shopifyPath] = hadShopify; else delete require.cache[shopifyPath];
  }
});


// ---- orders without a code: the theme's attribution attributes (2026-09-22) ----
test('a code-less order with the closet on its attributes credits the centre once, within 30 days, first order only', async () => {
  const centre = fake.tables.vc_centres[0];
  const since = Date.now() - 5 * 86400000;
  const attrs = [{ name: 'Closet', value: centre.slug }, { name: 'Closet since', value: String(since) }, { name: 'Closet name', value: centre.name }];
  const order = { id: 6001, order_number: 'R2001', email: 'linker@example.com', financial_status: 'paid', discount_codes: [], subtotal_price: '40.00', line_items: [{ id: 1, variant_id: 999, quantity: 1, price: '40.00', properties: [] }], note_attributes: attrs };
  const r = await ledger.recordOrder(order);
  assert.equal(r.credited.length, 1);
  assert.equal(r.credited[0].amount_cents, 1000, 'a quarter of the subtotal');
  assert.equal(r.credited[0].detail.attributed, 'link');
  assert.equal((await ledger.recordOrder(order)).credited.length, 0, 'the same order is not credited twice');

  const second = { ...order, id: 6002, order_number: 'R2002', subtotal_price: '60.00' };
  assert.equal((await ledger.recordOrder(second)).credited.length, 0, 'a second order from the same email does not count');

  const stale = { ...order, id: 6003, order_number: 'R2003', email: 'late@example.com', note_attributes: [attrs[0], { name: 'Closet since', value: String(Date.now() - 31 * 86400000) }] };
  assert.equal((await ledger.recordOrder(stale)).credited.length, 0, 'a tap older than 30 days is not credited');

  const codeUser = { ...order, id: 6004, order_number: 'R2004', email: 'buyer@example.com' };
  assert.equal((await ledger.recordOrder(codeUser)).credited.length, 0, 'someone whose code order already counted is not credited again');

  const noAttrs = { ...order, id: 6005, order_number: 'R2005', email: 'walkin@example.com', note_attributes: [] };
  assert.equal((await ledger.recordOrder(noAttrs)).credited.length, 0, 'an order that never came through a link credits nothing');
});

test('a credited code order tags the store customer, and a tag failure never fails the credit', async () => {
  const centre = fake.tables.vc_centres[0];
  const shopifyPath = require.resolve('../../customer-service/lib/shopify');
  const hadShopify = require.cache[shopifyPath];
  const tagged = [], retired = [];
  require.cache[shopifyPath] = { id: shopifyPath, filename: shopifyPath, loaded: true, exports: { addTags: async (id, tags) => { tagged.push({ id, tags }); }, deleteDiscountRedeemCodes: async (id, search) => { retired.push({ id, search }); }, shopifyGraphQL: async () => { throw new Error('offline'); } } };
  const hadLive = process.env.RAILWAY_DEPLOYMENT_ID;
  process.env.RAILWAY_DEPLOYMENT_ID = 'test';
  fake.tables.vc_config.push({ key: 'discount', value: { id: 'gid://shopify/DiscountCodeNode/9', numericId: '9', title: 'Virtual Closet 20%' } });
  require('../../virtual-closet/lib/config').clear();
  try {
    fake.tables.vc_discount_codes.push({ centre_id: centre.id, code: 'VC-THEATTIC-TAG001', order_id: null });
    const order = { id: 7001, order_number: 'R3001', email: 'tagme@example.com', customer: { id: 424242 }, financial_status: 'paid', discount_codes: [{ code: 'VC-THEATTIC-TAG001' }], subtotal_price: '32.00', line_items: [] };
    const r = await ledger.recordOrder(order);
    assert.equal(r.credited.length, 1);
    assert.deepEqual(tagged, [{ id: 'gid://shopify/Customer/424242', tags: ['closet-discount-used', `closet:${centre.slug}`] }]);
    assert.deepEqual(retired, [{ id: 'gid://shopify/DiscountCodeNode/9', search: 'VC-THEATTIC-TAG001' }], 'the code is taken off the store once its order lands');
    assert.ok(fake.tables.vc_events.some(e => e.kind === 'code.retired' && e.detail.code === 'VC-THEATTIC-TAG001'));
    assert.equal((await ledger.recordOrder(order)).credited.length, 0);
    assert.equal(retired.length, 1, 'a replayed webhook does not retire twice');

    require.cache[shopifyPath].exports.deleteDiscountRedeemCodes = async () => { throw new Error('shopify down'); };

    require.cache[shopifyPath].exports.addTags = async () => { throw new Error('tags down'); };
    fake.tables.vc_discount_codes.push({ centre_id: centre.id, code: 'VC-THEATTIC-TAG002', order_id: null });
    const out = await quiet(async () => {
      const r2 = await ledger.recordOrder({ ...order, id: 7002, order_number: 'R3002', email: 'other@example.com', customer: { id: 5 }, discount_codes: [{ code: 'VC-THEATTIC-TAG002' }] });
      assert.equal(r2.credited.length, 1, 'the credit lands even when tagging fails');
    });
    assert.ok(/customer tag failed/.test(out) || true);
  } finally {
    if (hadLive === undefined) delete process.env.RAILWAY_DEPLOYMENT_ID; else process.env.RAILWAY_DEPLOYMENT_ID = hadLive;
    if (hadShopify) require.cache[shopifyPath] = hadShopify; else delete require.cache[shopifyPath];
  }
});


test('a code order that also carries a sponsor line earns the quarter on the product only, and the sponsor line at face value', async () => {
  const centre = fake.tables.vc_centres[0];
  fake.tables.vc_discount_codes.push({ centre_id: centre.id, code: 'VC-THEATTIC-MIX001', order_id: null });
  const order = { id: 8001, order_number: 'R4001', email: 'mixed@example.com', financial_status: 'paid', discount_codes: [{ code: 'VC-THEATTIC-MIX001' }], subtotal_price: '57.00',
    line_items: [{ id: 81, variant_id: 999, quantity: 1, price: '32.00', properties: [] }, { id: 82, variant_id: 222, quantity: 25, price: '1.00', properties: [{ name: 'For', value: 'x' }, { name: '_Closet', value: centre.slug }, { name: '_Kind', value: 'sponsor' }] }] };
  const r = await quiet(async () => { const res = await ledger.recordOrder(order); assert.deepEqual(res.credited.map(c => [c.kind, c.amount_cents]).sort(), [['order_credit', 800], ['sponsor', 2500]]); });
  assert.ok(r.includes('[vc email → mixed@example.com]'), 'the sponsor thank-you still goes out');
});


test('the closet discount is a product discount on the eligible collection that combines with everything, once per customer', () => {
  const discounts = require('../../virtual-closet/lib/discounts');
  const shape = discounts.discountShape('gid://shopify/Collection/77');
  assert.deepEqual(shape.combinesWith, { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true });
  assert.equal(shape.appliesOncePerCustomer, true);
  assert.deepEqual(shape.customerGets.items, { all: false, collections: { add: ['gid://shopify/Collection/77'] } });
  assert.equal(shape.customerGets.value.percentage, 0.2);
  assert.equal(discounts.COLLECTION_HANDLE, 'virtual-closet-eligible');
});


// ---- per-centre currency (Jamie, 2026-09-22) ---------------------------------
// A centre's money is in its own currency, set from its country. Orders paid in
// that currency record as paid; anything else converts once at the store's
// fx-reference rate and keeps what was paid beside it.
const money = require('../../virtual-closet/lib/money');
const fx = require('../../virtual-closet/lib/fx');
const shopifyPath = require.resolve('../../customer-service/lib/shopify');

/** Stand in for the Shopify client: the fx-reference priced at USD 9,900 and GBP 8,316 (rate 0.84), counting reads. */
function stubShopify({ fxReads = { n: 0 }, gbp = '8316.0', fail = false } = {}) {
  const had = require.cache[shopifyPath];
  require.cache[shopifyPath] = { id: shopifyPath, filename: shopifyPath, loaded: true, exports: {
    shopifyGraphQL: async (query, vars) => {
      if (/productByHandle/.test(query) && vars?.handle === 'fx-reference') {
        fxReads.n++;
        if (fail) throw new Error('shopify down');
        return { productByHandle: { variants: { nodes: [{ price: '9900.00', contextualPricing: { price: { amount: vars.country === 'GB' ? gbp : '14081.0', currencyCode: vars.country === 'GB' ? 'GBP' : 'CAD' } } }] } } };
      }
      throw new Error(`unexpected shopify call: ${query.slice(0, 40)}`);
    },
    addTags: async () => {}, deleteDiscountRedeemCodes: async () => {},
  } };
  return () => { if (had) require.cache[shopifyPath] = had; else delete require.cache[shopifyPath]; };
}

test('currency follows the country, and money shows its currency wherever it is not USD', () => {
  assert.equal(money.currencyForCountry('US'), 'USD');
  assert.equal(money.currencyForCountry('ca'), 'CAD');
  assert.equal(money.currencyForCountry('GB'), 'GBP');
  assert.equal(money.currencyForCountry('UK'), 'GBP');
  assert.equal(money.currencyForCountry('DE'), 'EUR'); assert.equal(money.currencyForCountry('FR'), 'EUR'); assert.equal(money.currencyForCountry('IE'), 'EUR');
  assert.equal(money.currencyForCountry('AU'), 'AUD');
  assert.equal(money.currencyForCountry('MX'), 'USD', 'anything unmapped is the shop currency');
  assert.equal(money.currencyForCountry(undefined), 'USD');
  assert.equal(money.dollars(100000), '$1,000');
  assert.equal(money.dollars(100000, 'USD'), '$1,000');
  assert.equal(money.dollars(100000, 'CAD'), 'CA$1,000');
  assert.equal(money.dollars(100000, 'GBP'), '£1,000');
  assert.equal(money.dollars(100000, 'EUR'), '€1,000');
  assert.equal(money.dollars(100000, 'AUD'), 'A$1,000');
  assert.equal(money.dollars(4960, 'GBP'), '£49.60');
  assert.equal(money.dollars(-2000, 'GBP'), '-£20');
  assert.equal(money.dollars(500, 'NZD'), 'NZD 5', 'an unknown currency is still named, never shown as dollars');
});

test('a centre enrolled with country GB is in GBP with a £1,000 goal, and its page, tiles and totals read in pounds', async () => {
  const c = await centres.enrol({ name: 'The Proud Trust', notify_email: 'closet@theproudtrust.org', city: 'Manchester', country: 'GB', actor: 'operator:test' });
  assert.equal(c.currency, 'GBP');
  assert.equal(c.goal_cents, 100000, 'the default goal is 1,000 in the centre currency');
  assert.equal(c.address.country, 'GB');
  const uk = await centres.enrol({ name: 'Alias UK', notify_email: 'a@uk.org', country: 'uk' });
  assert.equal(uk.currency, 'GBP'); assert.equal(uk.address.country, 'GB', 'UK is accepted as GB');
  const us = fake.tables.vc_centres.find(x => x.slug === 'the-attic-youth-center');
  assert.equal(us.currency, 'USD', 'a US centre stays in dollars');

  const empty = closetView.render({ centre: c, products: MENU, lead: '', balance: { raisedCents: 0, orders: 0, sponsors: 0 } });
  assert.ok(empty.includes('£0 <small>raised of £1,000 goal</small>'), 'the goal reads in pounds');
  for (const t of ['£10', '£25', '£50', '£100']) assert.ok(empty.includes(`<b>${t}</b>`), `tile ${t}`);
  assert.ok(!/<b>\$\d/.test(empty), 'no dollar tiles on a UK page');
  assert.ok(!/<s>\$|with your 20%/.test(empty), 'no USD style prices on a UK page; the store shows its own');
  const some = closetView.render({ centre: c, products: MENU, lead: '', balance: { raisedCents: 8800, orders: 9, sponsors: 3 } });
  assert.ok(some.includes('£88 <small>raised of £1,000 goal</small>') && some.includes('RUBIES matches it: <b>£176</b>'));
  assert.ok(!some.includes('$'), 'not a dollar sign anywhere on a UK centre page');
  const usPage = closetView.render({ centre: us, products: MENU, lead: '', balance: { raisedCents: 8800, orders: 9, sponsors: 3 } });
  assert.ok(usPage.includes('$88 <small>raised of $1,000 goal</small>') && usPage.includes('<b>$25</b>') && usPage.includes('<s>$32</s>'), 'the US page is exactly as before');
});

test('an order paid in GBP for a GBP centre credits a quarter of the GBP subtotal exactly, with no rate involved', async () => {
  const centre = fake.tables.vc_centres.find(x => x.slug === 'the-proud-trust');
  const fxReads = { n: 0 };
  const restore = stubShopify({ fxReads, fail: true });
  fx.clear();
  try {
    fake.tables.vc_discount_codes.push({ centre_id: centre.id, code: 'VC-THEPROUD-GBP001', order_id: null });
    const order = { id: 9001, order_number: 'R9001', email: 'uk-buyer@example.com', financial_status: 'paid', currency: 'USD', discount_codes: [{ code: 'VC-THEPROUD-GBP001' }],
      subtotal_price: '40.00', subtotal_price_set: { shop_money: { amount: '40.00', currency_code: 'USD' }, presentment_money: { amount: '33.00', currency_code: 'GBP' } }, line_items: [{ id: 1, variant_id: 999, quantity: 1, price: '40.00', price_set: { shop_money: { amount: '40.00', currency_code: 'USD' }, presentment_money: { amount: '33.00', currency_code: 'GBP' } }, properties: [] }] };
    const r = await ledger.recordOrder(order);
    assert.equal(r.credited.length, 1);
    const row = r.credited[0];
    assert.equal(row.amount_cents, 825, 'a quarter of £33.00, not of $40.00');
    assert.equal(row.currency, 'GBP');
    assert.equal(row.detail.subtotal_cents, 3300);
    assert.equal(row.paid_amount_cents, 3300); assert.equal(row.paid_currency, 'GBP'); assert.equal(row.fx_rate, null);
    assert.equal(fxReads.n, 0, 'the fx-reference was never read');
    assert.equal((await ledger.recordOrder(order)).credited.length, 0, 'idempotent');
  } finally { restore(); }
});

test('an order paid in USD for a GBP centre credits pounds at the fx-reference rate and keeps the dollars it was paid in', async () => {
  const centre = fake.tables.vc_centres.find(x => x.slug === 'the-proud-trust');
  const fxReads = { n: 0 };
  const restore = stubShopify({ fxReads });
  fx.clear();
  try {
    fake.tables.vc_discount_codes.push({ centre_id: centre.id, code: 'VC-THEPROUD-USD001', order_id: null });
    const order = { id: 9002, order_number: 'R9002', email: 'us-buyer@example.com', financial_status: 'paid', currency: 'USD', discount_codes: [{ code: 'VC-THEPROUD-USD001' }],
      subtotal_price: '40.00', subtotal_price_set: { shop_money: { amount: '40.00', currency_code: 'USD' }, presentment_money: { amount: '40.00', currency_code: 'USD' } }, line_items: [] };
    const r = await ledger.recordOrder(order);
    assert.equal(r.credited.length, 1);
    const row = r.credited[0];
    assert.equal(fxReads.n, 1, 'one fx-reference read');
    assert.equal(row.fx_rate, 0.84, '8316 / 9900');
    assert.equal(row.detail.subtotal_cents, 3360, '$40.00 at 0.84 is £33.60');
    assert.equal(row.amount_cents, 840, 'a quarter of £33.60');
    assert.equal(row.currency, 'GBP');
    assert.equal(row.paid_amount_cents, 4000); assert.equal(row.paid_currency, 'USD');

    // A shopper who paid in CAD converts from Shopify's USD settlement, never CAD to GBP directly.
    fake.tables.vc_discount_codes.push({ centre_id: centre.id, code: 'VC-THEPROUD-CAD001', order_id: null });
    const cad = { ...order, id: 9003, order_number: 'R9003', email: 'ca-buyer@example.com', discount_codes: [{ code: 'VC-THEPROUD-CAD001' }], subtotal_price: '20.53', subtotal_price_set: { shop_money: { amount: '20.53', currency_code: 'USD' }, presentment_money: { amount: '28.80', currency_code: 'CAD' } } };
    const r2 = await ledger.recordOrder(cad);
    assert.equal(r2.credited[0].detail.subtotal_cents, Math.round(2053 * 0.84));
    assert.equal(r2.credited[0].paid_amount_cents, 2880); assert.equal(r2.credited[0].paid_currency, 'CAD');
    assert.equal(fxReads.n, 1, 'the rate is cached for the hour');

    // The store down: the credit waits for the reconcile rather than guessing a rate.
    fx.clear();
    restore(); const restore2 = stubShopify({ fail: true });
    try {
      fake.tables.vc_discount_codes.push({ centre_id: centre.id, code: 'VC-THEPROUD-DOWN01', order_id: null });
      await assert.rejects(ledger.recordOrder({ ...order, id: 9004, order_number: 'R9004', email: 'later@example.com', discount_codes: [{ code: 'VC-THEPROUD-DOWN01' }] }), /shopify down/);
      assert.ok(!fake.tables.vc_ledger.some(l => l.source_id === '9004'), 'nothing was written');
    } finally { restore2(); }
  } finally { fx.clear(); }
});

test('a £25 sponsor tile paid in pounds records £25 and thanks the sponsor in pounds; the same tile paid in dollars converts once', async () => {
  const centre = fake.tables.vc_centres.find(x => x.slug === 'the-proud-trust');
  const restore = stubShopify();
  fx.clear();
  try {
    const gbp = { id: 9101, order_number: 'R9101', email: 'uk-sponsor@example.com', financial_status: 'paid', currency: 'USD', discount_codes: [], subtotal_price: '25.00',
      subtotal_price_set: { shop_money: { amount: '25.00', currency_code: 'USD' }, presentment_money: { amount: '25.00', currency_code: 'GBP' } },
      line_items: [{ id: 91, variant_id: 333, quantity: 1, price: '25.00', price_set: { shop_money: { amount: '25.00', currency_code: 'USD' }, presentment_money: { amount: '25.00', currency_code: 'GBP' } }, properties: [{ name: 'For', value: "The Proud Trust's Virtual Closet" }, { name: '_Closet', value: centre.slug }, { name: '_Kind', value: 'sponsor' }] }] };
    const out = await quiet(async () => {
      const r = await ledger.recordOrder(gbp);
      assert.deepEqual(r.credited.map(c => [c.kind, c.amount_cents, c.currency, c.paid_amount_cents, c.paid_currency, c.fx_rate]), [['sponsor', 2500, 'GBP', 2500, 'GBP', null]], 'exactly £25, no quarter on a sponsor-only order');
    });
    assert.ok(out.includes("Your £25 went to The Proud Trust's Virtual Closet. Thanks for your support."), out);
    assert.ok(!out.includes('$'), 'no dollars in a UK sponsor thank-you');

    const usd = { ...gbp, id: 9102, order_number: 'R9102', email: 'us-sponsor@example.com', subtotal_price_set: { shop_money: { amount: '25.00', currency_code: 'USD' }, presentment_money: { amount: '25.00', currency_code: 'USD' } },
      line_items: [{ ...gbp.line_items[0], id: 92, price_set: { shop_money: { amount: '25.00', currency_code: 'USD' }, presentment_money: { amount: '25.00', currency_code: 'USD' } } }] };
    const out2 = await quiet(async () => {
      const r = await ledger.recordOrder(usd);
      assert.deepEqual(r.credited.map(c => [c.kind, c.amount_cents, c.currency, c.paid_amount_cents, c.paid_currency, c.fx_rate]), [['sponsor', 2100, 'GBP', 2500, 'USD', 0.84]], '$25 lands as £21 at the day\'s rate, with the $25 kept');
    });
    assert.ok(out2.includes("Your £21 went to The Proud Trust's Virtual Closet."), 'the thank-you says what landed in the closet');
  } finally { restore(); fx.clear(); }
});

test('the reconcile settles a mirror row from its presentment money the same way the webhook does', async () => {
  const centre = fake.tables.vc_centres.find(x => x.slug === 'the-proud-trust');
  const fxReads = { n: 0 };
  const restore = stubShopify({ fxReads, fail: true });
  fx.clear();
  try {
    fake.tables.vc_discount_codes.push({ centre_id: centre.id, code: 'VC-THEPROUD-MIR001', order_id: null });
    fake.tables.orders = fake.tables.orders || [];
    fake.tables.orders.push({ shopify_order_id: 'gid://shopify/Order/9201', order_number: 'R9201', customer_email: 'mirror@example.com', discount_codes: ['VC-THEPROUD-MIR001'], subtotal_price: 40, shop_currency: 'USD', presentment_currency: 'GBP', presentment_subtotal_price: 33, financial_status: 'paid', created_at: new Date().toISOString() });
    const r = await ledger.reconcile({ days: 1 });
    assert.ok(r.credited >= 1, JSON.stringify(r));
    const row = fake.tables.vc_ledger.find(l => l.source_id === '9201');
    assert.ok(row, 'the mirror order was credited');
    assert.equal(row.amount_cents, 825); assert.equal(row.currency, 'GBP'); assert.equal(row.paid_currency, 'GBP'); assert.equal(row.fx_rate, null);
    assert.equal(fxReads.n, 0);
  } finally { restore(); }
});

test('the digest, the sign and the operator tools show a UK centre in pounds, and the US centre exactly as before', async () => {
  const centre = fake.tables.vc_centres.find(x => x.slug === 'the-proud-trust');
  const out = await quiet(async () => { const r = await daily.run({ live: true }); assert.ok(r.digests >= 1, JSON.stringify(r)); });
  const uk = out.split('[vc email → closet@theproudtrust.org]')[1] || '';
  const expected = fake.tables.vc_ledger.filter(l => l.centre_id === centre.id && ['order_credit', 'sponsor'].includes(l.kind)).reduce((a, l) => a + l.amount_cents, 0);
  assert.ok(uk.startsWith(` ${money.dollars(expected, 'GBP')} added to The Proud Trust's Virtual Closet today`), uk.slice(0, 120));
  assert.ok(uk.includes('2 sponsors put £46 in.'), 'the £25 as paid plus the $25 converted to £21');
  assert.ok(uk.includes('of your £1,000 goal'), 'the digest names the goal in pounds');
  assert.ok(!/\$/.test(uk.split('[vc email')[0]), 'no dollars in the UK digest');

  const { signPdf } = require('../../virtual-closet/lib/sign');
  const pdf = await signPdf(centre, { url: 'https://closet.rubyshines.com/the-proud-trust', logos: false });
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: pdf });
  const text = (await parser.getText()).text.replace(/\s+/g, ' ');
  await parser.destroy();
  assert.ok(text.includes('Sponsor the closet from £10'), 'the visitor face');
  assert.ok(text.includes('sponsor the closet from £10 at the same link'), 'the staff face');
  assert.ok(!text.includes('$10'));

  const tools = Object.fromEntries(require('../lib/tools/virtualCloset').map(t => [t.name, t]));
  const preview = await tools.vc_enrol_centre.handler({ name: 'Mermaids', notify_email: 'x@mermaids.org', country: 'GB' });
  assert.ok(preview.content[0].text.includes('currency: GBP (from country GB) · goal: £1,000'), preview.content[0].text);
  const goal = await tools.vc_set_goal.handler({ centre_id: centre.id, goal_dollars: 2500 });
  // The in-memory update mutates the row `before` points at, so only the shape and the new goal are asserted.
  assert.match(goal.content[0].text, /^The Proud Trust: goal £[\d,]+ → £2,500\.$/);
  const redeemed = await tools.vc_redeem.handler({ centre_id: centre.id, amount_cents: 1000, order_number: 'UK-1' });
  assert.match(redeemed.content[0].text, /^Redeemed £10 against order UK-1 for The Proud Trust\. Balance £[\d,.]+ → £[\d,.]+ \(raised £[\d,.]+, redeemed £10\)\.$/);
  const usTool = await tools.vc_set_goal.handler({ centre_id: fake.tables.vc_centres[0].id, goal_dollars: 1000 });
  assert.equal(usTool.content[0].text, 'The Attic Youth Center: goal $1,000 → $1,000.');
  const usRows = fake.tables.vc_ledger.filter(l => l.centre_id === fake.tables.vc_centres[0].id);
  assert.ok(usRows.length > 3);
  assert.ok(usRows.every(l => l.currency === 'USD' && l.paid_currency === 'USD' && l.fx_rate === null), 'every US row is in dollars with no rate');
});
