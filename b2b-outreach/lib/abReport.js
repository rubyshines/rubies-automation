/**
 * abReport.js — reply rate by subject variant, per initiating message type.
 *
 * The A/B test is only an operating layer if there is a report; until now the
 * read was a hand-written query (plan D6). Every initiating send under test
 * carries `variant_id` on its `b2b_messages` row (assigned in
 * queueService.assignVariant, rendered byte-identical from fixedSubjects), so
 * the report is a fold over messages, no model anywhere.
 *
 * Definitions, deliberately simple and stated once:
 *   sent      every engine send (source='send_tool') carrying a variant
 *   bounced   `undelivered_at` set — excluded from every rate, since nobody read it
 *   replied   a HUMAN inbound (message_type null; machine mail carries a type)
 *             from the same company inside WINDOW_DAYS after the send
 *   matured   a delivered send whose window has closed, or that was answered
 *   pending   delivered, window still open — the "reads on" date is when the
 *             last of them closes
 *   rate      replied / delivered, cumulative across rounds (n≈20-30 per
 *             round, so a single round is directional; the design is to
 *             accumulate). INTERIM while anything is pending: an early reply
 *             matures its own send, so replied / matured would read 100% the
 *             day after a round went out.
 *
 * One send per company per type: a retry after a departure or bounce delivers
 * the same intro again, and counting it twice would let one company vote twice.
 * The bounced first attempt still counts as a bounce.
 */
const WINDOW_DAYS = 14;
const DAY_MS = 86400000;
const PAGE = 1000;

/** Pure. See the header for the definitions. */
function computeAbReport({ outbound = [], inbound = [], now = new Date(), windowDays = WINDOW_DAYS } = {}) {
  const nowMs = now.getTime();
  const win = windowDays * DAY_MS;

  const repliesBy = new Map();
  for (const m of inbound) {
    if (m.direction !== 'inbound' || m.message_type) continue;
    const t = Date.parse(m.sent_at);
    if (!t) continue;
    if (!repliesBy.has(m.company_id)) repliesBy.set(m.company_id, []);
    repliesBy.get(m.company_id).push(t);
  }

  const sends = outbound
    .filter(m => m.direction === 'outbound' && m.variant_id && m.source === 'send_tool' && Date.parse(m.sent_at))
    .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));

  const groups = new Map();
  const deliveredOnce = new Set(); // `${company}|${type}` already counted as a delivered send
  for (const m of sends) {
    const key = `${m.message_type}|${m.variant_id}`;
    if (!groups.has(key)) {
      groups.set(key, { message_type: m.message_type, variant_id: m.variant_id, sent: 0, bounced: 0, matured: 0, replied: 0, pending: 0, reads_on: null });
    }
    const g = groups.get(key);
    if (m.undelivered_at) { g.sent++; g.bounced++; continue; }
    const once = `${m.company_id}|${m.message_type}`;
    if (deliveredOnce.has(once)) continue;
    deliveredOnce.add(once);
    g.sent++;
    const sentMs = Date.parse(m.sent_at);
    const closes = sentMs + win;
    const replied = (repliesBy.get(m.company_id) || []).some(t => t > sentMs && t <= closes);
    if (replied) { g.replied++; g.matured++; }
    else if (closes <= nowMs) g.matured++;
    else { g.pending++; if (!g.reads_on || closes > g.reads_on) g.reads_on = closes; }
  }

  const rows = [...groups.values()].map(g => ({
    ...g,
    delivered: g.sent - g.bounced,
    reply_rate: (g.sent - g.bounced) ? g.replied / (g.sent - g.bounced) : null,
    final: g.pending === 0,
    reads_on: g.reads_on ? new Date(g.reads_on).toISOString().slice(0, 10) : null,
  }));
  rows.sort((a, b) => a.message_type.localeCompare(b.message_type) || a.variant_id.localeCompare(b.variant_id));
  return { window_days: windowDays, as_of: now.toISOString().slice(0, 10), rows };
}

async function pageThrough(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
}

/** Gather every send under test and the human replies that could answer one. */
async function fetchAbReport(sb, { now = new Date(), windowDays = WINDOW_DAYS } = {}) {
  const outbound = await pageThrough(() => sb.from('b2b_messages')
    .select('company_id, direction, message_type, variant_id, sent_at, source, undelivered_at')
    .eq('direction', 'outbound').eq('source', 'send_tool').not('variant_id', 'is', null)
    .order('sent_at', { ascending: true }));
  const companyIds = [...new Set(outbound.map(m => m.company_id))];
  const inbound = companyIds.length
    ? await pageThrough(() => sb.from('b2b_messages')
      .select('company_id, direction, message_type, sent_at')
      .eq('direction', 'inbound').is('message_type', null).in('company_id', companyIds)
      .order('sent_at', { ascending: true }))
    : [];
  return computeAbReport({ outbound, inbound, now, windowDays });
}

const pct = (r) => (r === null ? '—' : `${Math.round(r * 100)}%`);

/** Markdown, one table per message type. Pure. */
function renderAbReport(report, { subjects = null } = {}) {
  if (!report.rows.length) return `**A/B report** (as of ${report.as_of}) — no sends carry a variant yet.`;
  const lines = [`**A/B report** — reply within ${report.window_days} days, bounces excluded, cumulative across rounds. As of ${report.as_of}.`];
  const byType = new Map();
  for (const r of report.rows) {
    if (!byType.has(r.message_type)) byType.set(r.message_type, []);
    byType.get(r.message_type).push(r);
  }
  for (const [type, rows] of byType) {
    lines.push('', `**${type}**`, '', '| Variant | Sent | Bounced | Replied | Matured | Reply rate | Still open |', '|---|---:|---:|---:|---:|---:|---|');
    for (const r of rows) {
      const open = r.pending ? `${r.pending} (reads on ${r.reads_on})` : '—';
      lines.push(`| ${r.variant_id} | ${r.sent} | ${r.bounced} | ${r.replied} | ${r.matured} | ${pct(r.reply_rate)}${r.final || r.reply_rate === null ? '' : ' (interim)'} | ${open} |`);
    }
    const subj = subjects?.[type];
    if (subj) {
      for (const r of rows) {
        const s = subj[r.variant_id];
        if (s) lines.push(`- ${r.variant_id}: "${s}"`);
      }
    }
    const total = rows.reduce((n, r) => n + r.matured, 0);
    if (total && total < 40) lines.push(`_${total} matured sends: directional only, keep accumulating before calling a winner._`);
  }
  return lines.join('\n');
}

module.exports = { computeAbReport, fetchAbReport, renderAbReport, WINDOW_DAYS };
