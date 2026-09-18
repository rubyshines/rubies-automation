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

module.exports = [
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
      return { ...text(lines.join('\n')), _structured: a };
    },
  },
  {
    name: 'vc_centres',
    description: 'Virtual Closet: list centres with programme, status, current box, requests waiting, orders in 30 days and last sign-in. Filter by status (pending|active|paused|left).',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
    handler: async ({ status } = {}) => {
      const rows = await operator.listCentres({ status });
      const lines = rows.map(c => `#${c.id} ${c.name} (${c.slug}) · ${c.status} · ${[c.programmes?.closet && 'Closet', c.programmes?.pass_it_on && 'Pass It On'].filter(Boolean).join(' + ')}${c.box ? ` · box #${c.box.number} ${dollars(c.box.raised)}/${dollars(c.box.goal)}${c.box.funded ? ' funded' : ''} · ${c.box.approved} requests${c.box.waiting ? ` +${c.box.waiting} waiting` : ''}` : ''}${c.unanswered ? ` · ${c.unanswered} unanswered` : ''} · ${c.orders30d} orders/30d`);
      return { ...text(lines.join('\n') || 'No centres.'), _structured: { centres: rows } };
    },
  },
  {
    name: 'vc_centre',
    description: 'Virtual Closet: everything about one centre by id: team, boxes with ledger, requests, recent log.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: async ({ id }) => {
      const d = await operator.centreDetail(id);
      if (!d) return { ...text('No such centre.'), isError: true };
      const c = d.centre;
      const lines = [`${c.name} (${c.slug}) · ${c.status} · goal ${dollars(c.goal_cents)} · ${c.approval_mode} approval · sizes ${(c.sizes || []).join(', ')}${c.kids_sizes ? ', kids' : ''}`];
      lines.push(`Team: ${d.team.members.map(m => `${m.name || m.email} (${m.role})`).join(', ')}${d.team.invites.length ? ` · ${d.team.invites.length} invited` : ''}`);
      for (const b of d.boxes) lines.push(`Box #${b.number} · ${b.status} · ${dollars(b.raised)} of ${dollars(b.goal)} · orders ${dollars(b.sources.orders)}, sponsors ${dollars(b.sources.sponsors)}, centre ${dollars(b.sources.centre)} · ${b.requests} requests`);
      lines.push(`Requests: ${d.requests.length} · codes issued ${d.codes.issued}, used ${d.codes.used} · visits (90d) ${d.visits} · words published ${d.published}`);
      return { ...text(lines.join('\n')), _structured: d };
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
      if (!p) return { ...text('No such box.'), isError: true };
      const lines = [`${p.centre.name} box #${p.box.number} · ship to ${p.centre.name}, ${[p.centre.address?.street, p.centre.address?.city, p.centre.address?.region, p.centre.address?.postal].filter(Boolean).join(', ')}${p.admin ? ` · attn ${p.admin.name || p.admin.email}` : ''}`];
      lines.push(`Requested items, ${p.requests.length} people:`);
      for (const r of p.requests) lines.push(`  - ${r.name}: ${r.items.map(i => `${i.styleName} · ${i.colour} · ${i.size}`).join(', ')} · ${r.delivery === 'ship' ? `separate parcel to ${[r.address?.street, r.address?.city, r.address?.region, r.address?.postal].filter(Boolean).join(', ')}` : 'in box'}`);
      lines.push(`Fill (${p.box.fill_mode || 'auto'}):`);
      for (const l of p.plan) lines.push(`  - ${l.styleName} ${l.size} × ${l.qty}`);
      lines.push(`Totals: raised ${dollars(p.totals.raised)} + match ${dollars(p.totals.match)} − door shipping ${dollars(p.totals.doorShipping)} = ${dollars(p.totals.productBudget)} · placed ${dollars(p.totals.placedProductCents)} · carries ${dollars(p.totals.carryOut)}`);
      return { ...text(lines.join('\n')), _structured: p };
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
      return { ...text(rows.map(r => `#${r.id} ${r.centre?.name} · ${r.name} <${r.email}> · ${r.items_text} · ${r.delivery} · ${r.status_label}`).join('\n') || 'No requests.'), _structured: { requests: rows } };
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
