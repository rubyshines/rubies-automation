#!/usr/bin/env node
'use strict';
/**
 * Seed a demo centre so the closet page can be looked at before any sign-up.
 *   node virtual-closet/scripts/seedDemo.js            # creates or refreshes "Demo Pride Centre"
 *   node virtual-closet/scripts/seedDemo.js --reset    # wipes its boxes, ledger and requests first
 */
require('dotenv').config();
const { db, must } = require('../lib/db');
const centres = require('../lib/centres');
const boxes = require('../lib/boxes');

const SLUG = 'demo-pride-centre';

async function main() {
  const reset = process.argv.includes('--reset');
  let centre = await centres.getBySlug(SLUG);
  if (!centre) {
    centre = must(await db().from('vc_centres').insert({
      slug: SLUG, name: 'Demo Pride Centre', website: 'https://example.org',
      address: { street: '123 Main St', city: 'Champaign', region: 'IL', postal: '61820', country: 'US', hours: 'Mon to Fri, 10 to 6' },
      programmes: { closet: true, pass_it_on: true }, status: 'active', approved_at: new Date().toISOString(), approved_by: 'seed',
      statements_email: 'closet@example.org',
    }).select('*').single(), 'seed centre');
    console.log('created', centre.slug);
  }
  if (reset) {
    must(await db().from('vc_requests').delete().eq('centre_id', centre.id), 'reset requests');
    must(await db().from('vc_ledger').delete().eq('centre_id', centre.id), 'reset ledger');
    must(await db().from('vc_boxes').delete().eq('centre_id', centre.id), 'reset boxes');
  }
  let box = await boxes.getOpenBox(centre.id);
  if (!box) {
    // A delivered box #1 for the "arrived on" line, then an open box #2 with something in it.
    const b1 = await boxes.openNextBox(centre.id, { goalCents: 30000 });
    must(await db().from('vc_boxes').update({ status: 'delivered', sent_at: daysAgo(30), shipped_at: daysAgo(27), delivered_at: daysAgo(21), items_count: 38, carrier: 'UPS', tracking_number: '1Z999' }).eq('id', b1.id), 'b1');
    must(await db().from('vc_ledger').insert([
      { centre_id: centre.id, box_id: b1.id, kind: 'sponsor', amount_cents: 31200, source_type: 'seed', source_id: 'b1-sponsor', detail: { seed: true } },
      { centre_id: centre.id, box_id: b1.id, kind: 'match', amount_cents: 31200, source_type: 'box', source_id: `match-${b1.id}`, detail: {} },
    ]), 'b1 ledger');
    box = await boxes.openNextBox(centre.id, { goalCents: 30000 });
    must(await db().from('vc_ledger').insert([
      { centre_id: centre.id, box_id: box.id, kind: 'order_credit', amount_cents: 4800, source_type: 'seed', source_id: 'b2-orders', detail: { orders: 6 } },
      { centre_id: centre.id, box_id: box.id, kind: 'sponsor', amount_cents: 5000, source_type: 'seed', source_id: 'b2-s1', detail: {} },
      { centre_id: centre.id, box_id: box.id, kind: 'sponsor', amount_cents: 1600, source_type: 'seed', source_id: 'b2-s2', detail: {} },
      { centre_id: centre.id, box_id: box.id, kind: 'sponsor', amount_cents: 1000, source_type: 'seed', source_id: 'b2-s3', detail: {} },
      { centre_id: centre.id, box_id: box.id, kind: 'centre_add', amount_cents: 1600, source_type: 'seed', source_id: 'b2-c1', detail: {} },
    ]), 'b2 ledger');
    must(await db().from('vc_requests').insert([
      { centre_id: centre.id, box_id: box.id, email: 'rosa@example.com', name: 'Rosa', items: [{ style: 'aj', colour: 'Black', size: '1X' }, { style: 'brooke', colour: 'Pink', size: '1X' }], delivery: 'pickup', words: 'I have never owned a pair that fit like me.', words_shareable: true, words_published_at: new Date().toISOString(), status: 'approved', verified_at: daysAgo(3), decided_by: 'system', decided_at: daysAgo(3), created_at: daysAgo(3) },
      { centre_id: centre.id, box_id: box.id, email: 'mel@example.com', name: 'Mel', items: [{ style: 'sassy', colour: 'Mint', size: 'M' }], delivery: 'ship', address: { street: '9 Elm St', city: 'Urbana', region: 'IL', postal: '61801' }, words_shareable: false, status: 'approved', verified_at: daysAgo(5), decided_by: 'system', decided_at: daysAgo(5), created_at: daysAgo(5) },
      { centre_id: centre.id, box_id: box.id, email: 'dee@example.com', name: 'Dee', items: [{ style: 'charlie', colour: 'Black', size: '3X' }], delivery: 'pickup', words: 'Summer camp is in three weeks.', words_shareable: true, status: 'approved', verified_at: daysAgo(6), decided_by: 'system', decided_at: daysAgo(6), created_at: daysAgo(6) },
    ]), 'requests');
    console.log('seeded boxes, ledger, requests');
  }
  const sum = await boxes.summary(centre, box);
  console.log(`${centre.name}: box #${sum.number} ${sum.raised / 100} of ${sum.goal / 100}, state ${sum.state}, ${sum.approvedCount} approved`);
  console.log(`open http://localhost:${process.env.PORT || 3850}/${centre.slug}`);
}

function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }

main().catch(err => { console.error(err); process.exit(1); });
