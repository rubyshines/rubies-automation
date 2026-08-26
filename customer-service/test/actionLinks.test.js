/**
 * Unit tests for the dashboard's extractActionLinks — the buttons rendered
 * under each completed action in the ticket timeline.
 *
 * The case that motivated these: a tool result that touches TWO orders emits
 * both admin URLs in one text. The label was read with a single
 * `text.match(/#(\d{4,6})/)`, i.e. the FIRST order number anywhere in the
 * result, so on ticket #3331 a split shipment rendered two buttons both reading
 * "Order #33328" — the second one linking to the newly created #33332 under the
 * wrong name, which is worse than no button because nothing invites the
 * operator to click it.
 *
 * Run: node --test customer-service/test/actionLinks.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// server.js reaches for Supabase/Gorgias/autoLinker at require time.
const supabaseClientPath = require.resolve('../../shared/supabaseClient');
const gorgiasPath = require.resolve('../import/gorgiasClient');
const autoLinkerPath = require.resolve('../lib/autoLinker');

require.cache[supabaseClientPath] = {
  id: supabaseClientPath, filename: supabaseClientPath, loaded: true,
  exports: { getSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }) },
};
require.cache[gorgiasPath] = {
  id: gorgiasPath, filename: gorgiasPath, loaded: true, exports: {},
};
require.cache[autoLinkerPath] = {
  id: autoLinkerPath, filename: autoLinkerPath, loaded: true,
  exports: { autoLinkProducts: (html) => html },
};

const { extractActionLinks } = require('../dashboard/server');

const url = n => `https://admin.shopify.com/store/rubies-active-wear/orders/${n}`;
const one = text => extractActionLinks([{ result: text }]);

describe('extractActionLinks — one label per URL', () => {
  it('labels each order link with its own order number, not the first in the text', () => {
    // Verbatim shape of the split_shipment phase-2 result.
    const links = one([
      '**Order split for pre-order**',
      '',
      `**Original order:** #33328 — ${url('7487738118422')}`,
      '  - Held items marked fulfilled (placeholder): 1x RUBY-BLK-L',
      '  - Tag added: `pre-order-pending`',
      '',
      `**New pre-order:** #33332 — ${url('7488157581590')}`,
      '  - Total: $0 (already paid via original)',
    ].join('\n'));

    assert.equal(links.length, 2);
    assert.deepEqual(links.map(l => l.label), ['Order #33328', 'Order #33332']);
    assert.equal(links[0].url, url('7487738118422'));
    assert.equal(links[1].url, url('7488157581590'));
  });

  it('handles the merge-mode shape, where the destination number appears before its own URL', () => {
    const links = one([
      '**Shipment merged into existing order**',
      '',
      `**Original order:** #33328 — ${url('111')}`,
      '  - Items marked fulfilled (placeholder, ship via #33332): 1x AJ-BLK-L',
      '  - Tag added: `ships-with-33332`',
      '',
      `**Destination order:** #33332 — ${url('222')}`,
    ].join('\n'));

    assert.deepEqual(links.map(l => l.label), ['Order #33328', 'Order #33332']);
  });

  it('falls back to the first number in the text when the URL precedes its number', () => {
    const links = one(`Warehouse hold placed. ${url('333')} — this is order #33340.`);
    assert.deepEqual(links.map(l => l.label), ['Order #33340']);
  });

  it('single-order results are unchanged', () => {
    const links = one(`**Warehouse hold placed** on order #33328\n\nAdmin: ${url('7487738118422')}`);
    assert.deepEqual(links, [{ type: 'order', label: 'Order #33328', url: url('7487738118422') }]);
  });

  it('dedupes repeated URLs but keeps distinct ones', () => {
    const links = one(`#33328 ${url('111')} and again ${url('111')} then #33332 ${url('222')}`);
    assert.equal(links.length, 2);
    assert.deepEqual(links.map(l => l.label), ['Order #33328', 'Order #33332']);
  });

  it('labels draft links per URL too, and never confuses a draft for an order', () => {
    const draft = n => `https://admin.shopify.com/store/rubies-active-wear/draft_orders/${n}`;
    const links = one([
      `**Draft created:** #D6720 — ${draft('900')}`,
      `**Second draft:** #D6721 — ${draft('901')}`,
    ].join('\n'));

    assert.deepEqual(links.map(l => l.type), ['draft', 'draft']);
    assert.deepEqual(links.map(l => l.label), ['Draft #D6720', 'Draft #D6721']);
  });

  it('a draft number never leaks into an order label', () => {
    const draft = 'https://admin.shopify.com/store/rubies-active-wear/draft_orders/900';
    const links = one(`Draft #D6720 — ${draft}\nCompleted into order #33332 — ${url('222')}`);
    const order = links.find(l => l.type === 'order');
    assert.equal(order.label, 'Order #33332');
  });

  it('discount links keep their code label', () => {
    const disc = 'https://admin.shopify.com/store/rubies-active-wear/discounts/12345';
    const links = one(`Code \`A1B2C3D4E5\` created — ${disc}`);
    assert.deepEqual(links, [{ type: 'discount', label: 'Code A1B2C3D4E5', url: disc }]);
  });

  it('tolerates a result with no identifier at all', () => {
    const links = one(`Something happened — ${url('444')}`);
    assert.deepEqual(links.map(l => l.label), ['Order ']);
  });
});
