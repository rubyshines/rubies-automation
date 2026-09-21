'use strict';
/**
 * Virtual Closet daily job, run as a daily-sync-all sub-pipeline:
 *   1. ledger reconcile over the order mirror (anything the webhook missed)
 *   1b. link-mode centres: the activity digest, one email on a day with activity
 *   2. by-hand reminders at 7 days; 14-day escalation shows in Needs attention
 *   3. pickup reminders 14 days after a box arrived
 *   4. monthly statements on the 1st, only when something happened
 *   5. the operator's "needs attention" digest, only when there is something
 * Every step is idempotent; a re-run sends nothing twice.
 */
const { db, must, logEvent } = require('../lib/db');
const ledger = require('../lib/ledger');
const centres = require('../lib/centres');
const boxes = require('../lib/boxes');
const requestsLib = require('../lib/requests');
const emails = require('../lib/emails');
const operator = require('../lib/operator');
const { dollars } = require('../lib/money');

async function run({ live = true, today = new Date() } = {}) {
  const out = { reconcile: null, digests: 0, byHandReminders: 0, pickupReminders: 0, statements: 0, attention: 0, warnings: [] };
  try { out.reconcile = await ledger.reconcile(); } catch (err) { out.warnings.push(`reconcile: ${err.message}`); }

  // 1b. link-mode digests. The watermark moves only after a send that
  // succeeded, so a failed send is retried next run and a re-run never
  // repeats a row. A dry run counts what would go out and moves nothing.
  try {
    for (const centre of (await centres.list({ status: 'active' })).filter(centres.isLink)) {
      const d = await ledger.digestActivity(centre, { since: centre.digest_through });
      if (!d.any) continue;
      const to = centre.statements_email;
      if (!to) { out.warnings.push(`digest: ${centre.name} has no notification email`); continue; }
      if (live) {
        const bal = await ledger.balance(centre);
        const r = await emails.activity({ centre, to, orders: d.orders, orderCents: d.orderCents, sponsors: d.sponsors, sponsorCents: d.sponsorCents, balanceCents: bal.balanceCents, raisedCents: bal.raisedCents });
        if (!r?.ok) { out.warnings.push(`digest: ${centre.name} send failed`); continue; }
        must(await db().from('vc_centres').update({ digest_through: d.maxCreatedAt, updated_at: today.toISOString() }).eq('id', centre.id), 'digest watermark');
        await logEvent(centre.id, 'system', 'digest.sent', { orders: d.orders, sponsors: d.sponsors, through: d.maxCreatedAt });
      }
      out.digests++;
    }
  } catch (err) { out.warnings.push(`digest: ${err.message}`); }

  const day = 86400000;
  // 2. by-hand reminders
  const stale = must(await db().from('vc_requests').select('centre_id').eq('status', 'needs_answer').lt('created_at', new Date(today - 7 * day).toISOString()).is('reminded_at', null), 'stale');
  const byCentre = new Map();
  for (const s of stale) byCentre.set(s.centre_id, (byCentre.get(s.centre_id) || 0) + 1);
  for (const [centreId, count] of byCentre) {
    const centre = await centres.getById(centreId);
    const to = centre.statements_email || (await adminEmail(centreId));
    if (live && to) await emails.byHandReminder({ centre, to, count });
    must(await db().from('vc_requests').update({ reminded_at: today.toISOString() }).eq('centre_id', centreId).eq('status', 'needs_answer').is('reminded_at', null), 'mark reminded');
    out.byHandReminders += count;
  }

  // 3. pickup reminders
  const ready = must(await db().from('vc_requests').select('*, vc_boxes!inner(delivered_at, pickup_note)').eq('status', 'ready').is('reminded_at', null).lt('vc_boxes.delivered_at', new Date(today - 14 * day).toISOString()), 'ready');
  for (const r of ready) {
    const centre = await centres.getById(r.centre_id);
    if (live) await emails.requestReady({ centre, request: r, items: requestsLib.describeItems(r.items), note: r.vc_boxes?.pickup_note || centre.pickup_note, reminder: true });
    must(await db().from('vc_requests').update({ reminded_at: today.toISOString() }).eq('id', r.id), 'mark reminded');
    out.pickupReminders++;
  }

  // 4. statements on the 1st for the previous month
  if (today.getUTCDate() === 1 || process.env.VC_FORCE_STATEMENTS === '1') {
    const prev = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const month = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
    const label = prev.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const from = prev.toISOString(), to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString();
    for (const centre of (await centres.list({ status: 'active' })).filter(c => !centres.isLink(c))) {
      const exists = must(await db().from('vc_statements').select('id').eq('centre_id', centre.id).eq('month', month).maybeSingle(), 'statement?');
      if (exists) continue;
      const [visits, led, reqs, routed] = await Promise.all([
        must(await db().from('vc_visits').select('id').eq('centre_id', centre.id).gte('visited_at', from).lt('visited_at', to), 'v'),
        must(await db().from('vc_ledger').select('kind, amount_cents').eq('centre_id', centre.id).gte('created_at', from).lt('created_at', to).in('kind', ['order_credit', 'sponsor', 'centre_add']), 'l'),
        must(await db().from('vc_requests').select('id').eq('centre_id', centre.id).gte('created_at', from).lt('created_at', to).neq('status', 'unverified'), 'r'),
        centre.donation_partner_id ? must(await db().from('donation_routings').select('id').eq('partner_id', centre.donation_partner_id).gte('created_at', from).lt('created_at', to), 'd') : [],
      ]);
      const intoBox = led.reduce((s, l) => s + l.amount_cents, 0);
      if (!visits.length && !led.length && !reqs.length && !routed.length) continue; // only when something happened
      const box = await boxes.getOpenBox(centre.id);
      const sum = box ? await boxes.summary(centre, box) : null;
      const stats = { 'Link visits': visits.length, 'Orders from your link': led.filter(l => l.kind === 'order_credit').length, 'Into the box': dollars(intoBox), 'Requests': reqs.length };
      if (sum) stats[`Box #${sum.number}`] = `${dollars(sum.raised)} of ${dollars(sum.goal)}`;
      if (centre.programmes?.pass_it_on) stats['Pass It On'] = `${routed.length} customer${routed.length === 1 ? '' : 's'} sent items`;
      const to = centre.statements_email || (await adminEmail(centre.id));
      if (live && to) await emails.statement({ centre, to, month: label, stats });
      must(await db().from('vc_statements').insert({ centre_id: centre.id, month, payload: stats, sent_at: live ? today.toISOString() : null }), 'statement');
      out.statements++;
    }
  }

  // 5. needs attention digest
  try {
    const items = await operator.attentionEmailItems();
    out.attention = items.length;
    if (live && items.length) await emails.operatorNeedsAttention({ items });
  } catch (err) { out.warnings.push(`attention: ${err.message}`); }

  await logEvent(null, 'system', 'job.daily', out).catch(() => {});
  return out;
}

async function adminEmail(centreId) {
  const rows = must(await db().from('vc_memberships').select('vc_users(email)').eq('centre_id', centreId).eq('role', 'admin').limit(1), 'admin');
  return rows[0]?.vc_users?.email || null;
}

if (require.main === module) {
  require('dotenv').config();
  run({ live: process.argv.includes('--live') }).then(r => { console.log(JSON.stringify(r, null, 1)); }).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run };
