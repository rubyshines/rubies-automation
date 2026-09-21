'use strict';
/**
 * Virtual Closet MCP tools: the same operator functions the CS dashboard
 * uses, so any advisor can read a centre, approve one, or see a packing list.
 */
const operator = require('../../../virtual-closet/lib/operator');
const centresLib = require('../../../virtual-closet/lib/centres');
const boxes = require('../../../virtual-closet/lib/boxes');
const { dollars } = require('../../../virtual-closet/lib/money');

const text = t => ({ content: [{ type: 'text', text: t }] });
const BASE = () => process.env.VC_BASE_URL || 'http://localhost:3850';

/** A link-mode centre's line for vc_centres and vc_centre. */
function linkSummary(c) {
  const b = c.balance || {};
  return `balance ${dollars(b.balanceCents || 0)} · raised ${dollars(b.raisedCents || 0)} · redeemed ${dollars(b.redeemedCents || 0)} · ${b.orders || 0} orders, ${b.sponsors || 0} sponsors`;
}

module.exports = [
  {
    name: 'vc_enrol_centre',
    description: 'Virtual Closet: enrol a centre in link mode (the minimal cut). Active at once: a page at /[slug] with the shop button, sponsor tiles and running total; a balance that accrues; a digest email on days with activity. Seeds name, website, logo, city, region and country from a donation partner row when donation_partner_id is given; explicit inputs override. A logo not on the Shopify CDN is re-hosted there. Preview by default; confirmed=true creates the centre and sends the welcome email (from Jamie, with the QR attached) to notify_email.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, notify_email: { type: 'string', description: 'Where the welcome and the activity digests go' }, slug: { type: 'string' },
        website: { type: 'string' }, logo_url: { type: 'string' }, city: { type: 'string' }, region: { type: 'string' }, country: { type: 'string', description: 'ISO alpha-2, default US' },
        donation_partner_id: { type: 'number' }, goal_dollars: { type: 'number', description: 'The goal the running total is drawn against; default $1,000' },
        confirmed: { type: 'boolean' }, operator_email: { type: 'string' },
      },
      required: ['notify_email'],
    },
    handler: async (params = {}) => {
      const { getSupabaseClient } = require('../../../shared/supabaseClient');
      let seed = {};
      if (params.donation_partner_id) {
        const { data: partner, error } = await getSupabaseClient().from('donation_partners').select('id, name, website_url, logo_url, city, region, country_code').eq('id', params.donation_partner_id).maybeSingle();
        if (error) throw new Error(`partner lookup: ${error.message}`);
        if (!partner) return { content: [{ type: 'text', text: `No donation partner #${params.donation_partner_id}.` }], isError: true };
        seed = { name: partner.name, website: partner.website_url, logo_url: partner.logo_url, city: partner.city, region: partner.region, country: partner.country_code };
      }
      const row = {
        name: params.name || seed.name, notify_email: params.notify_email, slug: params.slug || null,
        website: params.website || seed.website || null, logo_url: params.logo_url || seed.logo_url || null,
        city: params.city || seed.city || null, region: params.region || seed.region || null, country: params.country || seed.country || 'US',
        donation_partner_id: params.donation_partner_id || null,
        goal_cents: params.goal_dollars ? Math.round(params.goal_dollars * 100) : require('../../../virtual-closet/lib/money').LINK_DEFAULT_GOAL_CENTS,
      };
      if (!row.name) return { content: [{ type: 'text', text: 'A centre needs a name (or a donation_partner_id to take it from).' }], isError: true };
      const slug = row.slug ? centresLib.slugify(row.slug) : await centresLib.uniqueSlug(row.name);
      const { isShopifyCdnUrl } = require('../shopifyFileUpload');
      const rehost = row.logo_url && !isShopifyCdnUrl(row.logo_url);
      const preview = [
        `${params.confirmed ? 'Enrolling' : 'Would enrol'} ${row.name} in link mode`,
        `  page: ${BASE()}/${slug}`,
        `  welcome + digests to: ${row.notify_email} (from ${process.env.VC_OPERATOR_EMAIL || process.env.ALLOWED_EMAIL || 'jamie@rubyshines.com'})`,
        `  website: ${row.website || '(none)'} · logo: ${row.logo_url || '(none)'}${rehost ? ' (will be re-hosted on the Shopify CDN)' : ''}`,
        `  where: ${[row.city, row.region, row.country].filter(Boolean).join(', ')}${row.donation_partner_id ? ` · Pass It On partner #${row.donation_partner_id}` : ''}`,
        `  goal: ${dollars(row.goal_cents)}`,
      ];
      if (!params.confirmed) return { content: [{ type: 'text', text: preview.concat('', 'Call again with confirmed=true to create the centre and send the welcome.').join('\n') }], _structured: { preview: { ...row, slug } } };
      if (rehost) {
        const { rehostImageOnShopify } = require('../shopifyFileUpload');
        const r = await rehostImageOnShopify(row.logo_url, { alt: `${row.name} logo` });
        row.logo_url = r.cdnUrl;
        preview.push(`  logo re-hosted: ${row.logo_url}`);
      }
      const actor = `operator:${params.operator_email || process.env.ALLOWED_EMAIL || 'operator'}`;
      const centre = await centresLib.enrol({ ...row, slug, actor });
      const sent = await require('../../../virtual-closet/lib/emails').welcome({ centre, to: centre.statements_email });
      preview.push(`Enrolled #${centre.id} ${centre.name} (${centre.slug}). Welcome email ${sent?.ok ? 'sent' : `NOT sent: ${sent?.error || 'unknown'}`}.`);
      return { content: [{ type: 'text', text: preview.join('\n') }], _structured: { centre, welcome: sent } };
    },
  },
  {
    name: 'vc_set_goal',
    description: "Virtual Closet: set a centre's goal, the amount its running total is drawn against on the page and in the digest (default $1,000; the centre tells Jamie, Jamie sets it here). Minimum $300.",
    inputSchema: { type: 'object', properties: { centre_id: { type: 'number' }, goal_dollars: { type: 'number' }, operator_email: { type: 'string' } }, required: ['centre_id', 'goal_dollars'] },
    handler: async ({ centre_id, goal_dollars, operator_email } = {}) => {
      const before = await centresLib.getById(centre_id);
      if (!before) return { content: [{ type: 'text', text: 'No such centre.' }], isError: true };
      const c = await centresLib.update(centre_id, { goal_cents: Math.round(goal_dollars * 100) }, `operator:${operator_email || process.env.ALLOWED_EMAIL || 'operator'}`);
      return text(`${c.name}: goal ${dollars(before.goal_cents)} → ${dollars(c.goal_cents)}.`);
    },
  },
  {
    name: 'vc_redeem',
    description: "Virtual Closet: deduct a link-mode centre's balance for a partner order it placed (kind redemption: amount_cents, order_number; idempotent on the order number; refuses more than the balance), or correct the ledger by hand (kind adjustment: signed amount_cents, note required, no balance check; use for a refunded order). Prints the balance before and after.",
    inputSchema: {
      type: 'object',
      properties: { centre_id: { type: 'number' }, amount_cents: { type: 'number' }, order_number: { type: 'string' }, note: { type: 'string' }, kind: { type: 'string', enum: ['redemption', 'adjustment'] }, operator_email: { type: 'string' } },
      required: ['centre_id', 'amount_cents'],
    },
    handler: async ({ centre_id, amount_cents, order_number, note, kind = 'redemption', operator_email } = {}) => {
      const ledger = require('../../../virtual-closet/lib/ledger');
      const centre = await centresLib.getById(centre_id);
      if (!centre) return { content: [{ type: 'text', text: 'No such centre.' }], isError: true };
      const before = await ledger.balance(centre);
      let after;
      try {
        after = await ledger.redeem({ centre, amountCents: amount_cents, orderNumber: order_number, note, kind, actor: `operator:${operator_email || process.env.ALLOWED_EMAIL || 'operator'}` });
      } catch (err) { return { content: [{ type: 'text', text: `${err.message} Balance: ${dollars(before.balanceCents)}.` }], isError: true }; }
      const what = kind === 'redemption' ? `Redeemed ${dollars(amount_cents)} against order ${order_number}` : `Adjusted by ${dollars(amount_cents)} (${note})`;
      return { content: [{ type: 'text', text: `${after.duplicate ? `Order ${order_number} was already recorded; nothing changed` : what} for ${centre.name}. Balance ${dollars(before.balanceCents)} → ${dollars(after.balanceCents)} (raised ${dollars(after.raisedCents)}, redeemed ${dollars(after.redeemedCents)}).` }], _structured: { before, after } };
    },
  },
  {
    name: 'vc_needs_attention',
    description: 'Virtual Closet: what needs a human right now (centres to approve, boxes to pack, centres waiting on, reported words, this week\'s counts).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const a = await operator.needsAttention();
      const lines = [];
      lines.push(`New centres to review: ${a.newCentres.length}`);
      for (const c of a.newCentres) lines.push(`  - #${c.id} ${c.name}${c.address?.city ? `, ${c.address.city}` : ''} · ${[c.programmes?.closet && 'Closet', c.programmes?.pass_it_on && 'Pass It On'].filter(Boolean).join(' + ')} · signed up ${c.ageDays}d ago · admin ${c.admin?.email || '?'} ${c.verified ? '✓' : '(not verified)'}`);
      lines.push(`Boxes to pack: ${a.boxesToPack.length}`);
      for (const b of a.boxesToPack) lines.push(`  - ${b.centre?.name} box #${b.number} (id ${b.id}) · ${b.items_count || '?'} items`);
      if (a.waitingOn.length) { lines.push('Waiting on a centre:'); for (const w of a.waitingOn) lines.push(`  - ${w.text}`); }
      if (a.reports.length) { lines.push(`Reported words: ${a.reports.length}`); }
      const w = a.week;
      lines.push(`This week: ${w.activeCentres} active centres · ${w.orders} orders from closet links · ${dollars(w.sponsoredCents)} sponsored · ${w.requests} requests · ${w.boxesShipped} boxes shipped · match owed on open boxes ${dollars(w.matchOwedCents)}`);
      if (a.unusual.length) { lines.push('Unusual:'); for (const u of a.unusual) lines.push(`  - ${u}`); }
      return { content: [{ type: 'text', text: lines.join('\n') }], _structured: a };
    },
  },
  {
    name: 'vc_centres',
    description: 'Virtual Closet: list centres with mode (link|closet), programme, status, balance or current box, orders in 30 days. Filter by status (pending|active|paused|left).',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
    handler: async ({ status } = {}) => {
      const rows = await operator.listCentres({ status });
      const lines = rows.map(c => `#${c.id} ${c.name} (${c.slug}) · ${c.status} · ${c.mode === 'link' ? 'link' : 'closet'} · ${[c.programmes?.closet && 'Closet', c.programmes?.pass_it_on && 'Pass It On'].filter(Boolean).join(' + ')}${c.mode === 'link' ? ` · ${linkSummary(c)}` : ''}${c.box ? ` · box #${c.box.number} ${dollars(c.box.raised)}/${dollars(c.box.goal)}${c.box.funded ? ' funded' : ''} · ${c.box.approved} requests${c.box.waiting ? ` +${c.box.waiting} waiting` : ''}` : ''}${c.unanswered ? ` · ${c.unanswered} unanswered` : ''} · ${c.orders30d} orders/30d`);
      return { content: [{ type: 'text', text: lines.join('\n') || 'No centres.' }], _structured: { centres: rows } };
    },
  },
  {
    name: 'vc_centre',
    description: 'Virtual Closet: everything about one centre by id. Link mode: balance, raised, redeemed, codes, visits and every ledger line. Closet mode: team, boxes with ledger, requests, recent log.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: async ({ id }) => {
      const d = await operator.centreDetail(id);
      if (!d) return { content: [{ type: 'text', text: 'No such centre.' }], isError: true };
      const c = d.centre;
      if (c.mode === 'link') {
        const lines = [`${c.name} (${c.slug}) · ${c.status} · link mode · goal ${dollars(c.goal_cents)} · page ${BASE()}/${c.slug} · notifications to ${c.statements_email || '(none)'}${c.digest_through ? ` · digest through ${c.digest_through}` : ''}`];
        lines.push(linkSummary(d) + ` · codes issued ${d.codes.issued}, used ${d.codes.used} · visits (90d) ${d.visits}${d.balance?.lastActivityAt ? ` · last activity ${d.balance.lastActivityAt}` : ''}`);
        lines.push('Ledger:');
        for (const l of d.ledgerLines || []) lines.push(`  ${l.created_at.slice(0, 10)} · ${l.kind} · ${dollars(l.amount_cents)}${l.source_id ? ` · ${l.source_type} ${l.source_id}` : ''}${l.detail?.note ? ` · ${l.detail.note}` : ''}${l.detail?.order_number ? ` · store order ${l.detail.order_number}` : ''}`);
        if (!(d.ledgerLines || []).length) lines.push('  (nothing yet)');
        return { content: [{ type: 'text', text: lines.join('\n') }], _structured: d };
      }
      const lines = [`${c.name} (${c.slug}) · ${c.status} · goal ${dollars(c.goal_cents)} · ${c.approval_mode} approval · sizes ${(c.sizes || []).join(', ')}${c.kids_sizes ? ', kids' : ''}`];
      lines.push(`Team: ${d.team.members.map(m => `${m.name || m.email} (${m.role})`).join(', ')}${d.team.invites.length ? ` · ${d.team.invites.length} invited` : ''}`);
      for (const b of d.boxes) lines.push(`Box #${b.number} · ${b.status} · ${dollars(b.raised)} of ${dollars(b.goal)} · orders ${dollars(b.sources.orders)}, sponsors ${dollars(b.sources.sponsors)}, centre ${dollars(b.sources.centre)} · ${b.requests} requests`);
      lines.push(`Requests: ${d.requests.length} · codes issued ${d.codes.issued}, used ${d.codes.used} · visits (90d) ${d.visits} · words published ${d.published}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], _structured: d };
    },
  },
  {
    name: 'vc_approve_centre',
    description: 'Virtual Closet: approve a pending centre. Creates the donation partner row when Pass It On was ticked, opens box #1, sends the welcome email. Requires the admin\'s email to be verified.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, operator_email: { type: 'string' } }, required: ['id'] },
    handler: async ({ id, operator_email }) => {
      const c = await operator.approveCentre(id, operator_email || process.env.ALLOWED_EMAIL);
      return text(`Approved ${c.name}. Page: ${process.env.VC_BASE_URL || 'http://localhost:3850'}/${c.slug}`);
    },
  },
  {
    name: 'vc_packing_list',
    description: 'Virtual Closet: the packing list for a sent box (requested items per person, the fill grid, totals, ship-to).',
    inputSchema: { type: 'object', properties: { box_id: { type: 'number' } }, required: ['box_id'] },
    handler: async ({ box_id }) => {
      const p = await operator.packingList(box_id);
      if (!p) return { content: [{ type: 'text', text: 'No such box.' }], isError: true };
      const lines = [`${p.centre.name} box #${p.box.number} · ship to ${p.centre.name}, ${[p.centre.address?.street, p.centre.address?.city, p.centre.address?.region, p.centre.address?.postal].filter(Boolean).join(', ')}${p.admin ? ` · attn ${p.admin.name || p.admin.email}` : ''}`];
      lines.push(`Requested items, ${p.requests.length} people:`);
      for (const r of p.requests) lines.push(`  - ${r.name}: ${r.items.map(i => `${i.styleName} · ${i.colour} · ${i.size}`).join(', ')} · ${r.delivery === 'ship' ? `separate parcel to ${[r.address?.street, r.address?.city, r.address?.region, r.address?.postal].filter(Boolean).join(', ')}` : 'in box'}`);
      lines.push(`Fill (${p.box.fill_mode || 'auto'}):`);
      for (const l of p.plan) lines.push(`  - ${l.styleName} ${l.size} × ${l.qty}`);
      lines.push(`Totals: raised ${dollars(p.totals.raised)} + match ${dollars(p.totals.match)} − door shipping ${dollars(p.totals.doorShipping)} = ${dollars(p.totals.productBudget)} · placed ${dollars(p.totals.placedProductCents)} · carries ${dollars(p.totals.carryOut)}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], _structured: p };
    },
  },
  {
    name: 'vc_box_shipped',
    description: 'Virtual Closet: mark a box shipped (carrier + tracking) or delivered. Sends the centre and requester emails.',
    inputSchema: { type: 'object', properties: { box_id: { type: 'number' }, status: { type: 'string', enum: ['shipped', 'delivered'] }, carrier: { type: 'string' }, tracking: { type: 'string' }, operator_email: { type: 'string' } }, required: ['box_id', 'status'] },
    handler: async ({ box_id, status, carrier, tracking, operator_email }) => {
      const op = operator_email || process.env.ALLOWED_EMAIL;
      const b = status === 'delivered' ? await operator.markDelivered(box_id, { operatorEmail: op }) : await operator.markShipped(box_id, { carrier, tracking, operatorEmail: op });
      return text(`Box #${b.number} is ${b.status}.`);
    },
  },
  {
    name: 'vc_requests',
    description: 'Virtual Closet: list requests across centres. status: open|needs_answer|shipped|declined|ended|cancelled; q filters by email or name.',
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, q: { type: 'string' } } },
    handler: async ({ status, q } = {}) => {
      const rows = await operator.listRequests({ status, q });
      return { content: [{ type: 'text', text: rows.map(r => `#${r.id} ${r.centre?.name} · ${r.name} <${r.email}> · ${r.items_text} · ${r.delivery} · ${r.status_label}`).join('\n') || 'No requests.' }], _structured: { requests: rows } };
    },
  },
  {
    name: 'vc_reconcile_ledger',
    description: 'Virtual Closet: walk recent store orders and credit any closet order or sponsorship the webhook missed. Idempotent.',
    inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
    handler: async ({ days } = {}) => {
      const r = await require('../../../virtual-closet/lib/ledger').reconcile({ days: days || 45 });
      return text(`Checked ${r.checked} orders, credited ${r.credited} new ledger rows.`);
    },
  },
];

module.exports.centresLib = centresLib;
module.exports.boxes = boxes;
