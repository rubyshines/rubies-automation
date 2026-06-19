#!/usr/bin/env node
/**
 * email-report.js — email-marketing report generator.
 *
 * Builds a RUBIES-branded HTML report for a month, quarter, or custom range,
 * reading entirely from Supabase feeds: campaigns (klaviyo_campaigns), flows
 * (klaviyo_flow_metrics), audience/list growth + forms (klaviyo_audience_daily),
 * store sessions (shopify_sessions_daily), revenue (orders), and the recency-
 * weighted Playbook (marketing_playbook). Opus writes the holistic Takeaways.
 * The only live call is the optional creative-gallery email HTML.
 *
 * Usage:
 *   node reports/email-report.js 2025-10            # one month
 *   node reports/email-report.js Q4-2025            # a quarter (also 2025-Q4)
 *   node reports/email-report.js 2026-03..2026-05   # a custom range
 *
 * Output: reports/output/email-report-<period>.html (+ how-it-works.html)
 */

const fs = require('fs');
const path = require('path');
const { getSupabaseClient } = require('../shared/supabaseClient');
const { getKlaviyoClient } = require('../shared/klaviyoClient');
const { callClaude } = require('../shared/aiClient');
const { MODELS } = require('../shared/aiPricing');
const { CAMPAIGN_OBJECTIVES } = require('../shared/marketingContext');
const { writeMethodology } = require('./methodology');
const { loadPlaybook, playbookContext } = require('../customer-service/lib/playbook');

// Extract one "## Header" section's body from a markdown doc.
function extractSection(md, headerRe) {
  const lines = (md || '').split('\n');
  let cap = false; const out = [];
  for (const l of lines) {
    if (/^##\s/.test(l)) {
      if (cap) break;            // reached the next section
      cap = headerRe.test(l);
      continue;
    }
    if (cap) out.push(l);
  }
  return out.join('\n').trim();
}

// Extract a "### Sub-header" block (e.g. one domain of Strategic Priorities).
function extractH3(md, re) {
  const lines = (md || '').split('\n');
  let cap = false; const out = [];
  for (const l of lines) {
    if (/^##\s/.test(l)) { if (cap) break; cap = false; continue; }
    if (/^###\s/.test(l)) { if (cap) break; cap = re.test(l); continue; }
    if (cap) out.push(l);
  }
  return out.join('\n').trim();
}

// Minimal markdown -> HTML for the playbook narrative (headers, bold, bullets).
function mdToHtml(md) {
  const esc2 = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const lines = (md || '').split('\n');
  let html = '', inList = false;
  const flush = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (let raw of lines) {
    const line = raw.trimEnd();
    // bold, and tidy stray em dashes that occasionally slip into AI text.
    const b = (t) => esc2(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\s*—\s*/g, ', ');
    if (/^#\s/.test(line)) { flush(); continue; } // skip the redundant top-level title
    if (/^#{2,3}\s/.test(line)) { flush(); const lvl = line.startsWith('###') ? 4 : 3; html += `<h${lvl} class="gt-h">${b(line.replace(/^#+\s/, ''))}</h${lvl}>`; }
    else if (/^[-*]\s/.test(line)) { if (!inList) { html += '<ul class="gt-ul">'; inList = true; } html += `<li>${b(line.replace(/^[-*]\s/, ''))}</li>`; }
    else if (line === '') { flush(); }
    else { flush(); html += `<p class="gt-p">${b(line)}</p>`; }
  }
  flush();
  return html;
}

const PLACED_ORDER_METRIC_ID = 'WTakqp';
// Klaviyo metric IDs (from the account) for list growth + signup forms.
const METRICS = {
  emailSub: 'U7zuwx',   // Subscribed to Email Marketing
  emailUnsub: 'TSPEpU', // Unsubscribed from Email Marketing
  smsSub: 'T2y5cf',     // Subscribed to SMS Marketing
  smsUnsub: 'XeqSPQ',   // Unsubscribed from SMS Marketing
  formViewed: 'USVJX3', // Viewed Form
  formSubmitted: 'YtMvXZ', // Submitted Form
};
// Klaviyo lists used as the live subscriber-count anchor for absolute list size.
const LISTS = { email: 'SNx3j5' /* Newsletter */, sms: 'W523VY' /* SMS Subscribers */ };

const BRAND = {
  orange: '#EE5A24',
  navy: '#1B2541',
  magenta: '#E6007E',
  ink: '#241a16',     // warm near-black
  muted: '#8a7d74',   // warm gray
  line: '#ece3d8',    // warm hairline
  cream: '#FBF6EF',   // canvas
  card: '#ffffff',
  pos: '#1f9d63',
  neg: '#d6492f',
};
const moneyK = (n) => {
  const v = n || 0;
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(v)}`;
};
// Delta badge: percent change with up/down arrow, colored.
// `minBase` guards against a tiny/absent prior value (e.g. a metric that only
// started tracking recently) producing a misleading huge percentage.
function delta(cur, base, { minBase = 0 } = {}) {
  if (base === null || base === undefined || base === 0 || Math.abs(base) < minBase) {
    return { txt: 'n/a', color: '#8a7d74', arrow: '' };
  }
  const pct = ((cur - base) / Math.abs(base)) * 100;
  const up = pct >= 0;
  // Past ~10x, show "Nx" instead of an absurd percentage.
  const txt = Math.abs(pct) >= 1000 ? `${up ? '+' : '-'}${(Math.abs(pct) / 100).toFixed(0)}x` : `${up ? '+' : ''}${pct.toFixed(0)}%`;
  return { txt, color: up ? '#1f9d63' : '#d6492f', arrow: up ? '▲' : '▼' };
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------------------
// Period parsing — month (YYYY-MM) or quarter (Q4-2025 / 2025-Q4)
// ---------------------------------------------------------------------------
function monthMeta(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(year, month, 0).getDate();
  const endIncl = `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const endExcl = `${ny}-${String(nm).padStart(2, '0')}-01`;
  return { year, month, start, endIncl, endExcl, label: `${MONTHS[month - 1]} ${year}` };
}

function parsePeriod(arg) {
  const a = (arg || 'Q4-2025').trim().toUpperCase();
  const qm = /^Q([1-4])-(\d{4})$/.exec(a) || /^(\d{4})-Q([1-4])$/.exec(a);
  if (qm) {
    const [q, year] = /^Q/.test(a) ? [+qm[1], +qm[2]] : [+qm[2], +qm[1]];
    const firstMonth = (q - 1) * 3 + 1;
    const months = [0, 1, 2].map((i) => monthMeta(year, firstMonth + i));
    return {
      kind: 'quarter', slug: `Q${q}-${year}`,
      label: `Q${q} ${year}`, sublabel: `${months[0].label} to ${months[2].label}`,
      months, start: months[0].start, endIncl: months[2].endIncl, endExcl: months[2].endExcl,
    };
  }
  // Custom range: YYYY-MM..YYYY-MM (also : or _ as the separator).
  const rng = /^(\d{4})-(\d{2})(?:\.\.|:|_)(\d{4})-(\d{2})$/.exec(a);
  if (rng) {
    const [sY, sM, eY, eM] = [+rng[1], +rng[2], +rng[3], +rng[4]];
    const months = [];
    let y = sY, m = sM;
    while (y < eY || (y === eY && m <= eM)) { months.push(monthMeta(y, m)); m++; if (m > 12) { m = 1; y++; } }
    if (!months.length) { console.error(`Empty range "${arg}".`); process.exit(1); }
    const last = months[months.length - 1];
    const label = sY === eY ? `${MONTHS[sM - 1]} to ${MONTHS[eM - 1]} ${eY}` : `${months[0].label} to ${last.label}`;
    return {
      kind: 'range', slug: `${rng[1]}-${rng[2]}_${rng[3]}-${rng[4]}`,
      label, sublabel: '', months, start: months[0].start, endIncl: last.endIncl, endExcl: last.endExcl,
    };
  }
  const mm = /^(\d{4})-(\d{2})$/.exec(a);
  if (mm) {
    const m = monthMeta(+mm[1], +mm[2]);
    return {
      kind: 'month', slug: `${mm[1]}-${mm[2]}`,
      label: m.label, sublabel: '', months: [m],
      start: m.start, endIncl: m.endIncl, endExcl: m.endExcl,
    };
  }
  console.error(`Bad period "${arg}". Use YYYY-MM, Q4-2025, or 2026-03..2026-05.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Data: campaigns (Supabase)
// ---------------------------------------------------------------------------
async function fetchCampaigns(period) {
  const supabase = getSupabaseClient();
  const cols = 'campaign_id,send_date,campaign_name,subject,recipients,opens,clicks,open_rate,click_rate,' +
    'unsubscribe_rate,bounce_rate,conversions,conversion_value';
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('klaviyo_campaigns').select(cols)
      .gte('send_date', period.start).lte('send_date', period.endIncl)
      .order('send_date', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`Supabase campaigns: ${error.message}`);
    all.push(...data);
    if (data.length < 1000) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Data: flows (Supabase klaviyo_flow_metrics, summed across months in range;
// live Klaviyo fallback if the period isn't synced).
// ---------------------------------------------------------------------------
async function fetchFlows(period) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('klaviyo_flow_metrics')
    .select('flow_id,flow_name,channel,recipients,delivered,opens,clicks,conversions,conversion_value')
    .gte('period_start', period.start).lte('period_end', period.endExcl);
  let rows = error ? [] : data;

  if (!rows.length) {
    // Live fallback: pull each month and aggregate.
    const client = getKlaviyoClient();
    if (!client) return { flows: [], source: 'none' };
    const flowsMeta = await client.getFlows();
    const nameById = {};
    for (const f of flowsMeta) nameById[f.id] = f.attributes?.name || f.id;
    rows = [];
    for (const m of period.months) {
      for (const channel of ['email', 'sms']) {
        const r = await client.getFlowValuesReport({
          start: m.start, end: m.endExcl, channel, conversionMetricId: PLACED_ORDER_METRIC_ID,
        });
        for (const f of r) rows.push({ ...f, flow_name: nameById[f.flow_id] || f.flow_id });
      }
    }
    return { flows: aggregateFlows(rows), source: 'live' };
  }
  return { flows: aggregateFlows(rows), source: 'supabase' };
}

function aggregateFlows(rows) {
  const by = {};
  for (const r of rows) {
    const key = `${r.flow_id}|${r.channel}`;
    const f = (by[key] ||= {
      flow_id: r.flow_id, flow_name: r.flow_name, channel: r.channel,
      recipients: 0, delivered: 0, opens: 0, clicks: 0, conversions: 0, conversion_value: 0,
    });
    f.recipients += r.recipients || 0;
    f.delivered += r.delivered || 0;
    f.opens += r.opens || 0;
    f.clicks += r.clicks || 0;
    f.conversions += r.conversions || 0;
    f.conversion_value += r.conversion_value || 0;
  }
  return Object.values(by)
    .map((f) => ({
      ...f,
      conversion_value: Math.round(f.conversion_value * 100) / 100,
      open_rate: f.delivered ? (f.opens / f.delivered) * 100 : 0,
      click_rate: f.delivered ? (f.clicks / f.delivered) * 100 : 0,
      rev_per_recipient: f.recipients ? f.conversion_value / f.recipients : 0,
    }))
    .sort((a, b) => b.conversion_value - a.conversion_value);
}

// ---------------------------------------------------------------------------
// Data: monthly revenue series (trailing window) for the over-time chart.
// Campaigns + flows come from Supabase; "store total" is Klaviyo's Placed-Order
// value (one metric-aggregate call) — the same denominator the deck used, and
// more complete than our orders table for high-volume months like BFCM.
// ---------------------------------------------------------------------------
async function sumByMonth(table, dateCol, start, endIncl) {
  const sb = getSupabaseClient();
  const out = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(`${dateCol},conversion_value`)
      .gte(dateCol, start).lte(dateCol, endIncl).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of data) {
      const ym = r[dateCol].slice(0, 7);
      out[ym] = (out[ym] || 0) + (r.conversion_value || 0);
    }
    if (data.length < 1000) break;
  }
  return out;
}

// Store revenue comes from the Shopify `orders` table in Supabase (not a live
// Klaviyo call) — fast, no rate limits, and it is the real order revenue.
async function fetchOrdersInWindow(startIncl, endExcl) {
  const sb = getSupabaseClient();
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('orders').select('created_at,total_price')
      .gte('created_at', startIncl).lt('created_at', endExcl).range(from, from + 999);
    if (error) throw new Error(`orders: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
async function fetchStoreRevenueByMonth(start, endExcl) {
  try {
    const orders = await fetchOrdersInWindow(start, endExcl);
    const out = {};
    for (const o of orders) {
      const ym = (o.created_at || '').slice(0, 7);
      if (ym) out[ym] = (out[ym] || 0) + (o.total_price || 0);
    }
    return out;
  } catch (_) { return {}; }
}

async function fetchMonthlySeries(period, trailing = 15) {
  // Fetch trailing + 12 extra months so each displayed month has a year-ago value.
  const fetchN = trailing + 12;
  let y = +period.endIncl.slice(0, 4), m = +period.endIncl.slice(5, 7);
  const allMonths = [];
  for (let i = 0; i < fetchN; i++) { allMonths.unshift(`${y}-${String(m).padStart(2, '0')}`); m--; if (m < 1) { m = 12; y--; } }
  const start = `${allMonths[0]}-01`;
  const ey = +period.endIncl.slice(0, 4), em = +period.endIncl.slice(5, 7);
  const endExcl = em === 12 ? `${ey + 1}-01-01` : `${ey}-${String(em + 1).padStart(2, '0')}-01`;
  const [camp, flow, store] = await Promise.all([
    sumByMonth('klaviyo_campaigns', 'send_date', start, period.endIncl),
    sumByMonth('klaviyo_flow_metrics', 'period_start', start, period.endIncl),
    fetchStoreRevenueByMonth(start, endExcl),
  ]);
  const periodSet = new Set(period.months.map((mm) => mm.start.slice(0, 7)));
  const display = allMonths.slice(12); // last `trailing` months
  const ya = (ym) => { const s = shiftMonthsISO(`${ym}-01`, -12).slice(0, 7); return s; };
  return display.map((ym) => {
    const p = ya(ym);
    return {
      ym, campaign: camp[ym] || 0, flow: flow[ym] || 0, store: store[ym] || 0,
      yoyCampaign: camp[p] || 0, yoyFlow: flow[p] || 0, yoyStore: store[p] || 0,
      yoyEmail: (camp[p] || 0) + (flow[p] || 0),
      inPeriod: periodSet.has(ym),
    };
  });
}

// Build the trailing month list + window bounds for a period.
function trailingMonths(period, trailing) {
  let y = +period.endIncl.slice(0, 4), m = +period.endIncl.slice(5, 7);
  const months = [];
  for (let i = 0; i < trailing; i++) { months.unshift(`${y}-${String(m).padStart(2, '0')}`); m--; if (m < 1) { m = 12; y--; } }
  const ey = +period.endIncl.slice(0, 4), em = +period.endIncl.slice(5, 7);
  const endExcl = em === 12 ? `${ey + 1}-01-01` : `${ey}-${String(em + 1).padStart(2, '0')}-01`;
  return { months, start: `${months[0]}-01`, endExcl };
}

// ---------------------------------------------------------------------------
// Data: audience layer — read entirely from klaviyo_audience_daily (the feed),
// aggregated to months. No live Klaviyo calls. Returns monthly sub/unsub/form
// counts plus the latest list-size snapshot.
// ---------------------------------------------------------------------------
async function loadAudienceMonthly(startMonthFirst, endExcl) {
  const sb = getSupabaseClient();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('klaviyo_audience_daily')
      .select('date,email_subscribed,email_unsubscribed,sms_subscribed,sms_unsubscribed,form_viewed,form_submitted,email_list_size,sms_list_size')
      .gte('date', startMonthFirst).lt('date', endExcl).order('date', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`klaviyo_audience_daily: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const byMonth = {}; let emailNow = null, smsNow = null;
  for (const r of rows) {
    const ym = r.date.slice(0, 7);
    const m = (byMonth[ym] ||= { emailSub: 0, emailUnsub: 0, smsSub: 0, smsUnsub: 0, formViewed: 0, formSubmitted: 0 });
    m.emailSub += r.email_subscribed || 0; m.emailUnsub += r.email_unsubscribed || 0;
    m.smsSub += r.sms_subscribed || 0; m.smsUnsub += r.sms_unsubscribed || 0;
    m.formViewed += r.form_viewed || 0; m.formSubmitted += r.form_submitted || 0;
    if (r.email_list_size != null) emailNow = r.email_list_size;
    if (r.sms_list_size != null) smsNow = r.sms_list_size;
  }
  return { byMonth, emailNow, smsNow };
}

// Most recent list-size snapshot (independent of the report window).
async function latestListSnapshot() {
  const sb = getSupabaseClient();
  const { data } = await sb.from('klaviyo_audience_daily')
    .select('email_list_size,sms_list_size,date').not('email_list_size', 'is', null)
    .order('date', { ascending: false }).limit(1);
  return data && data[0] ? { emailNow: data[0].email_list_size, smsNow: data[0].sms_list_size } : { emailNow: null, smsNow: null };
}

async function fetchSubscriberGrowth(period, trailing = 12) {
  const { months, endExcl } = trailingMonths(period, trailing);
  const pStartMonth = shiftMonthsISO(`${months[0]}-01`, -12);
  const [{ byMonth }, { emailNow, smsNow }] = await Promise.all([
    loadAudienceMonthly(pStartMonth, endExcl).catch(() => ({ byMonth: {} })),
    latestListSnapshot().catch(() => ({ emailNow: null, smsNow: null })),
  ]);
  if (!Object.keys(byMonth).length) return [];
  const g = (ym, k) => (byMonth[ym] || {})[k] || 0;
  const periodSet = new Set(period.months.map((mm) => mm.start.slice(0, 7)));
  const rows = months.map((ym) => {
    const p = shiftMonthsISO(`${ym}-01`, -12).slice(0, 7);
    return {
      ym,
      emailSub: g(ym, 'emailSub'), emailUnsub: g(ym, 'emailUnsub'),
      smsSub: g(ym, 'smsSub'), smsUnsub: g(ym, 'smsUnsub'),
      yoyEmailNet: g(p, 'emailSub') - g(p, 'emailUnsub'),
      yoySmsNet: g(p, 'smsSub') - g(p, 'smsUnsub'),
      inPeriod: periodSet.has(ym),
    };
  });
  // Absolute size: anchor to the latest snapshot, walk backward by net change.
  if (emailNow != null) { let t = emailNow; for (let i = rows.length - 1; i >= 0; i--) { rows[i].emailTotal = Math.round(t); t -= (rows[i].emailSub - rows[i].emailUnsub); } }
  if (smsNow != null) { let t = smsNow; for (let i = rows.length - 1; i >= 0; i--) { rows[i].smsTotal = Math.round(t); t -= (rows[i].smsSub - rows[i].smsUnsub); } }
  rows._emailNow = emailNow; rows._smsNow = smsNow;
  return rows;
}

// ---------------------------------------------------------------------------
// Data: signup form (pop-up) — viewed + submitted by month.
// ---------------------------------------------------------------------------
async function fetchFormMetrics(period, trailing = 12) {
  const { months, endExcl } = trailingMonths(period, trailing);
  const pStartMonth = shiftMonthsISO(`${months[0]}-01`, -12);
  const { byMonth } = await loadAudienceMonthly(pStartMonth, endExcl).catch(() => ({ byMonth: {} }));
  if (!Object.keys(byMonth).length) return null;
  const fv = (ym) => (byMonth[ym] || {}).formViewed || 0;
  const fs = (ym) => (byMonth[ym] || {}).formSubmitted || 0;
  const periodMonths = period.months.map((mm) => mm.start.slice(0, 7));
  const yoyMonths = periodMonths.map((ym) => shiftMonthsISO(`${ym}-01`, -12).slice(0, 7));
  const pv = periodMonths.reduce((s, ym) => s + fv(ym), 0);
  const ps = periodMonths.reduce((s, ym) => s + fs(ym), 0);
  const yps = yoyMonths.reduce((s, ym) => s + fs(ym), 0);
  const ypv = yoyMonths.reduce((s, ym) => s + fv(ym), 0);
  return {
    viewed: pv, submitted: ps, rate: pv ? (ps / pv) * 100 : 0,
    yoySubmitted: yps, yoyViewed: ypv,
    series: months.map((ym) => {
      const p = shiftMonthsISO(`${ym}-01`, -12).slice(0, 7);
      return { ym, viewed: fv(ym), submitted: fs(ym), yoySubmitted: fs(p), inPeriod: periodMonths.includes(ym) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Data: email creative previews — fetch real template HTML for top campaigns.
// ---------------------------------------------------------------------------
async function fetchEmailPreviews(campaigns, n = 6) {
  const client = getKlaviyoClient();
  if (!client) return [];
  const top = [...campaigns]
    .filter((c) => c.campaign_id)
    .sort((a, b) => (b.conversion_value || 0) - (a.conversion_value || 0))
    .slice(0, n);
  const out = [];
  for (const c of top) {
    try {
      const msg = await client.getCampaignMessage(c.campaign_id);
      const html = msg?._templateHtml || '';
      if (html) out.push({ name: c.campaign_name, subject: c.subject, revenue: c.conversion_value || 0, html });
      await new Promise((r) => setTimeout(r, 400));
    } catch (_) { /* skip ones we can't fetch */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparisons: this period vs previous period vs same period last year,
// plus trailing 30 / 90 day momentum. Month-aligned windows are exact.
// ---------------------------------------------------------------------------
function addDaysISO(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function shiftMonthsISO(ym01, delta) { // ym01 = 'YYYY-MM-01'
  let y = +ym01.slice(0, 4), m = +ym01.slice(5, 7) + delta;
  while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

async function aggCampaignWindow(startIncl, endIncl) {
  const sb = getSupabaseClient();
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('klaviyo_campaigns')
      .select('recipients,opens,clicks,conversions,conversion_value')
      .gte('send_date', startIncl).lte('send_date', endIncl).range(from, from + 999);
    if (error) throw new Error(`klaviyo_campaigns: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const recipients = rows.reduce((s, r) => s + (r.recipients || 0), 0);
  return {
    sends: rows.length, recipients,
    campaignRev: rows.reduce((s, r) => s + (r.conversion_value || 0), 0),
    opens: rows.reduce((s, r) => s + (r.opens || 0), 0),
    clicks: rows.reduce((s, r) => s + (r.clicks || 0), 0),
  };
}
async function aggFlowWindow(startMonth, endMonthIncl) {
  const sb = getSupabaseClient();
  const { data } = await sb.from('klaviyo_flow_metrics').select('conversion_value,period_start')
    .gte('period_start', startMonth).lte('period_start', endMonthIncl);
  return (data || []).reduce((s, r) => s + (r.conversion_value || 0), 0);
}
async function storeRevenueWindow(startIncl, endExcl) {
  try {
    const orders = await fetchOrdersInWindow(startIncl, endExcl);
    return orders.reduce((s, o) => s + (o.total_price || 0), 0);
  } catch (_) { return 0; }
}

async function computeWindowMetrics(startIncl, endIncl, endExcl) {
  const [c, flowRev, store] = await Promise.all([
    aggCampaignWindow(startIncl, endIncl),
    aggFlowWindow(startIncl.slice(0, 7) + '-01', endIncl),
    storeRevenueWindow(startIncl, endExcl),
  ]);
  return {
    sends: c.sends, recipients: c.recipients,
    campaignRev: c.campaignRev, flowRev, store,
    emailRev: c.campaignRev + flowRev,
    openRate: c.recipients ? (c.opens / c.recipients) * 100 : 0,
    clickRate: c.recipients ? (c.clicks / c.recipients) * 100 : 0,
    emailShare: store ? ((c.campaignRev + flowRev) / store) * 100 : 0,
  };
}

async function fetchComparisons(period) {
  const nMonths = period.months.length;
  const curStart = period.start, curEndIncl = period.endIncl, curEndExcl = period.endExcl;
  const prevStart = shiftMonthsISO(period.start, -nMonths);
  const prevEndExcl = period.start;
  const prevEndIncl = addDaysISO(prevEndExcl, -1);
  const yoyStart = shiftMonthsISO(period.start, -12);
  const yoyEndExcl = shiftMonthsISO(period.endExcl, -12);
  const yoyEndIncl = addDaysISO(yoyEndExcl, -1);
  const [current, prev, yoy] = await Promise.all([
    computeWindowMetrics(curStart, curEndIncl, curEndExcl),
    computeWindowMetrics(prevStart, prevEndIncl, prevEndExcl),
    computeWindowMetrics(yoyStart, yoyEndIncl, yoyEndExcl),
  ]);
  return { current, prev, yoy, labels: { prev: `Prev ${nMonths}mo`, yoy: 'Year ago' } };
}

// Trailing 30 / 90 day store + campaign revenue, each with a year-ago delta.
async function fetchMomentum(period) {
  const anchor = period.endExcl; // exclusive end of the report window
  const out = {};
  for (const days of [30, 90]) {
    const start = addDaysISO(anchor, -days);
    const yStart = addDaysISO(start, -365), yEnd = addDaysISO(anchor, -365);
    const [store, camp, yStoreV, yCamp] = await Promise.all([
      storeRevenueWindow(start, anchor, 'day'),
      aggCampaignWindow(start, addDaysISO(anchor, -1)),
      storeRevenueWindow(yStart, yEnd, 'day'),
      aggCampaignWindow(yStart, addDaysISO(yEnd, -1)),
    ]);
    out[days] = { store, campaignRev: camp.campaignRev, sends: camp.sends, recipients: camp.recipients,
      yoyStore: yStoreV, yoyCampaignRev: yCamp.campaignRev, yoySends: yCamp.sends };
  }
  return out;
}

// Total store sessions (traffic) for the period — read from shopify_sessions_daily
// (the feed). Used for the signup conversion rate.
async function fetchSessions(startIncl, endIncl) {
  try {
    const sb = getSupabaseClient();
    const { data, error } = await sb.from('shopify_sessions_daily').select('sessions')
      .gte('date', startIncl).lte('date', endIncl);
    if (error || !data || !data.length) return null;
    return data.reduce((s, r) => s + (r.sessions || 0), 0);
  } catch (_) { return null; }
}

// Year-ago flow revenue keyed by flow name (same calendar months, prior year).
async function fetchFlowYoY(period) {
  const sb = getSupabaseClient();
  const yStart = shiftMonthsISO(period.start, -12);
  const yEnd = shiftMonthsISO(period.endExcl, -12);
  const { data } = await sb.from('klaviyo_flow_metrics').select('flow_name,channel,conversion_value,period_start')
    .gte('period_start', yStart).lt('period_start', yEnd);
  const map = {};
  for (const r of data || []) map[`${r.flow_name}|${r.channel}`] = (map[`${r.flow_name}|${r.channel}`] || 0) + (r.conversion_value || 0);
  return map;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------
function summarizeCampaigns(rows) {
  const recipients = rows.reduce((s, r) => s + (r.recipients || 0), 0);
  const revenue = rows.reduce((s, r) => s + (r.conversion_value || 0), 0);
  const wOpen = recipients ? rows.reduce((s, r) => s + (r.open_rate || 0) * (r.recipients || 0), 0) / recipients : 0;
  const wClick = recipients ? rows.reduce((s, r) => s + (r.click_rate || 0) * (r.recipients || 0), 0) / recipients : 0;
  return { sends: rows.length, recipients, revenue, wOpen, wClick };
}

// ---------------------------------------------------------------------------
// AI takeaways
// ---------------------------------------------------------------------------
async function writeTakeaways(campaigns, flows, period, playbook, audienceCtx) {
  const campTable = campaigns.map((r) =>
    `${r.send_date} | ${r.campaign_name} | recipients ${r.recipients} | open ${r.open_rate}% | ` +
    `CTR ${r.click_rate}% | unsub ${r.unsubscribe_rate}% | revenue $${(r.conversion_value || 0).toFixed(2)} | ` +
    `subject: ${r.subject}`).join('\n');
  const flowTable = flows.slice(0, 14).map((f) =>
    `${f.flow_name} (${f.channel}) | recipients ${f.recipients} | open ${f.open_rate.toFixed(1)}% | ` +
    `revenue $${f.conversion_value.toFixed(2)} | $${f.rev_per_recipient.toFixed(2)}/recipient`).join('\n');

  const system =
    'You are RUBIES\' email marketing analyst. RUBIES makes gender-affirming ' +
    'underwear and swimwear for trans girls and women. You write the holistic ' +
    '"Takeaways" for the founder, covering the WHOLE program.\n\n' +
    CAMPAIGN_OBJECTIVES + '\n\n' +
    'You are also given a PLAYBOOK of durable, recency-weighted ground truths. ' +
    'Use it to frame this period against what is normally true.\n\n' +
    'COVER ALL THREE AREAS, not just campaigns. Roughly balance attention across:\n' +
    '1. LISTS / AUDIENCE — list growth rate, churn, signup conversion, the pop-up ' +
    'capture rate, SMS vs email scale. This is the biggest revenue lever, so it ' +
    'must appear in the takeaways. Explicitly assess whether the signup form / ' +
    'pop-up is pulling its weight.\n' +
    '2. CAMPAIGNS — subject and content patterns, send timing.\n' +
    '3. FLOWS — automation revenue and per-recipient efficiency.\n\n' +
    'Organize into exactly three groups, each on its own header line:\n' +
    'HIGHLIGHTS: what clearly worked, drawn from across lists, campaigns, and flows.\n' +
    'UNDERPERFORMERS: what fell short or needs fixing (judged by the right objective).\n' +
    'OPPORTUNITIES: surprising or early signals and clear openings worth acting on next.\n' +
    'Under each header, 2 to 4 punchy bullets starting with "- ", grounded in the ' +
    'numbers. Each group should touch more than one area where the data supports ' +
    'it. Do not over-index on campaigns. When a campaign had low revenue, judge it ' +
    'by its real objective before calling it an underperformer.\n\n' +
    'Voice: confident, plain, supportive. Never political or righteous. Do not ' +
    'use em dashes anywhere; use commas, parentheses, or short sentences.\n\n' +
    'Output ONLY the three header lines and their bullets, nothing else.';

  const pbBlock = playbook ? `\n\n${playbookContext(playbook)}` : '';
  const audBlock = audienceCtx ? `\n\nLISTS / AUDIENCE:\n${audienceCtx}` : '';
  const res = await callClaude({
    component: 'email_report',
    model: MODELS.OPUS,
    max_tokens: 1700,
    system,
    messages: [{
      role: 'user',
      content: `Period: ${period.label}${audBlock}\n\nCAMPAIGNS:\n${campTable}\n\nFLOWS:\n${flowTable}${pbBlock}\n\nWrite the holistic Takeaways.`,
    }],
  });
  return parseCategorizedTakeaways(res.text);
}

// Parse the model's WINS / WATCH-OUTS / WORTH WATCHING output into groups.
function parseCategorizedTakeaways(out) {
  const groups = { highlights: [], underperformers: [], opportunities: [] };
  let cur = null;
  for (const raw of (out || '').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const h = l.replace(/[:#*_>\-\s]/g, '').toLowerCase();
    if (h.startsWith('highlight')) { cur = 'highlights'; continue; }
    if (h.startsWith('underperform')) { cur = 'underperformers'; continue; }
    if (h.startsWith('opportunit')) { cur = 'opportunities'; continue; }
    const bullet = l.replace(/^[-*•]\s*/, '').trim();
    if (cur && bullet) groups[cur].push(bullet);
  }
  // Fallback: if parsing failed, dump everything into highlights so nothing is lost.
  if (!groups.highlights.length && !groups.underperformers.length && !groups.opportunities.length) {
    groups.highlights = (out || '').split('\n').map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (n) => `${(n ?? 0).toFixed(2)}%`;
const money = (n) => `$${(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (n) => `$${Math.round(n ?? 0).toLocaleString('en-US')}`; // no cents, for summary cards
const num = (n) => (n ?? 0).toLocaleString('en-US');

function columnColorer(values, { invert = false } = {}) {
  const nums = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  const min = Math.min(...nums), max = Math.max(...nums);
  return (v) => {
    if (typeof v !== 'number' || Number.isNaN(v) || max === min) return 'transparent';
    let t = (v - min) / (max - min);
    if (invert) t = 1 - t;
    return `hsl(${t * 120}, 72%, 86%)`;
  };
}

function renderCampaignTable(rows) {
  const openC = columnColorer(rows.map((r) => r.open_rate));
  const clickC = columnColorer(rows.map((r) => r.click_rate));
  const unsubC = columnColorer(rows.map((r) => r.unsubscribe_rate), { invert: true });
  const revC = columnColorer(rows.map((r) => r.conversion_value || 0));
  const cell = (v, bg, al = 'right') =>
    `<td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};text-align:${al};background:${bg};">${v}</td>`;
  const body = rows.map((r) => `<tr>
      <td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};white-space:nowrap;color:${BRAND.muted};">${esc(r.send_date)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};">
        <div style="font-weight:600;color:${BRAND.ink};">${esc(r.campaign_name)}</div>
        <div style="font-size:12px;color:${BRAND.muted};">${esc(r.subject)}</div></td>
      ${cell(num(r.recipients), 'transparent')}
      ${cell(pct(r.open_rate), openC(r.open_rate))}
      ${cell(pct(r.click_rate), clickC(r.click_rate))}
      ${cell(pct(r.unsubscribe_rate), unsubC(r.unsubscribe_rate))}
      ${cell(money(r.conversion_value), revC(r.conversion_value || 0))}
    </tr>`).join('');
  const th = (l, al = 'right') =>
    `<th style="padding:9px 10px;text-align:${al};font-weight:700;color:#fff;background:${BRAND.navy};font-size:12px;">${l}</th>`;
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr>${th('Date', 'left')}${th('Campaign', 'left')}${th('Recipients')}${th('Open')}${th('CTR')}${th('Unsub')}${th('Revenue')}</tr></thead>
    <tbody>${body}</tbody></table>`;
}

function renderFlowTable(flows) {
  const revC = columnColorer(flows.map((f) => f.conversion_value));
  const rprC = columnColorer(flows.map((f) => f.rev_per_recipient));
  const cell = (v, bg, al = 'right') =>
    `<td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};text-align:${al};background:${bg};">${v}</td>`;
  const body = flows.map((f) => `<tr>
      <td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};font-weight:600;color:${BRAND.ink};">${esc(f.flow_name)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};color:${BRAND.muted};font-size:12px;">${esc(f.channel)}</td>
      ${cell(num(f.recipients), 'transparent')}
      ${cell(pct(f.open_rate), 'transparent')}
      ${cell(money(f.conversion_value), revC(f.conversion_value))}
      ${cell(money(f.rev_per_recipient), rprC(f.rev_per_recipient))}
    </tr>`).join('');
  const th = (l, al = 'right') =>
    `<th style="padding:9px 10px;text-align:${al};font-weight:700;color:#fff;background:${BRAND.navy};font-size:12px;">${l}</th>`;
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr>${th('Flow', 'left')}${th('Channel', 'left')}${th('Recipients')}${th('Open')}${th('Revenue')}${th('Rev / recipient')}</tr></thead>
    <tbody>${body}</tbody></table>`;
}

function kpiCard(value, label, accent = BRAND.navy, deltaBadge = null) {
  const badge = deltaBadge
    ? `<div style="margin-top:6px;font-size:12px;font-weight:700;color:${deltaBadge.color};">${deltaBadge.arrow} ${deltaBadge.txt} <span style="color:${BRAND.muted};font-weight:500;">vs last year</span></div>`
    : '';
  return `<div style="flex:1;min-width:150px;background:${BRAND.card};border:1px solid ${BRAND.line};border-radius:14px;padding:18px 20px;">
    <div style="font-family:'Fraunces',serif;font-size:27px;font-weight:600;color:${accent};line-height:1;">${value}</div>
    <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:${BRAND.muted};margin-top:8px;font-weight:600;">${label}</div>${badge}</div>`;
}

function splitBar(campaignRev, flowRev) {
  const total = campaignRev + flowRev || 1;
  const cPct = (campaignRev / total) * 100, fPct = 100 - cPct;
  return `<div style="margin:6px 0 0;">
    <div style="display:flex;height:30px;border-radius:8px;overflow:hidden;">
      <div style="width:${cPct}%;background:${BRAND.orange};"></div>
      <div style="width:${fPct}%;background:${BRAND.navy};"></div></div>
    <div style="display:flex;justify-content:space-between;font-size:13px;color:${BRAND.muted};margin-top:8px;">
      <span><b style="color:${BRAND.orange};">Campaigns</b> ${money(campaignRev)} (${cPct.toFixed(0)}%)</span>
      <span><b style="color:${BRAND.navy};">Flows</b> ${money(flowRev)} (${fPct.toFixed(0)}%)</span></div></div>`;
}

function panel(title, inner, pad = '14px', anchor = null) {
  const link = anchor ? `<a class="method" href="how-it-works.html#${anchor}" title="How this is calculated">Methodology &#8599;</a>` : '';
  return `<div class="panel"><div class="panel-h"><h2><span class="bar"></span>${title}</h2>${link}</div>
    <div style="padding:${pad};">${inner}</div></div>`;
}

// Revenue-over-time: each bar is total store revenue, split into campaign +
// flow + non-email, with the total value labelled on top. Period and year-ago
// months are highlighted; Pride (June) and BFCM (Nov) are annotated.
function renderRevenueChart(series) {
  const W = 1000, H = 352, padL = 50, padR = 14, padB = 54, padT = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const useStore = series.some((s) => s.store > 0);
  const top = (s) => (useStore ? Math.max(s.store, s.campaign + s.flow) : s.campaign + s.flow);
  const maxY = Math.max(...series.map(top), 1);
  const n = series.length, gW = plotW / n, barW = Math.min(40, gW * 0.62);
  const x = (i) => padL + gW * i + gW / 2;
  const y = (v) => padT + plotH - (v / maxY) * plotH;

  // Year-ago months that line up with the reported period.
  const yearAgo = new Set();
  series.forEach((s) => { if (s.inPeriod) yearAgo.add(shiftMonthsISO(`${s.ym}-01`, -12).slice(0, 7)); });

  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const val = (maxY / 4) * g, yy = y(val);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${BRAND.line}"/>
      <text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="10" fill="${BRAND.muted}">${moneyK(val)}</text>`;
  }

  const bars = series.map((s, i) => {
    const cx = x(i), left = cx - barW / 2;
    const yaMatch = yearAgo.has(s.ym);
    const band = s.inPeriod ? `<rect x="${cx - gW / 2}" y="${padT}" width="${gW}" height="${plotH}" fill="${BRAND.orange}" opacity="0.07"/>`
      : yaMatch ? `<rect x="${cx - gW / 2}" y="${padT}" width="${gW}" height="${plotH}" fill="${BRAND.navy}" opacity="0.05"/>` : '';
    const camp = s.campaign, flow = s.flow, total = top(s);
    const nonEmail = Math.max(useStore ? s.store - camp - flow : 0, 0);
    const hC = (camp / maxY) * plotH, hF = (flow / maxY) * plotH, hN = (nonEmail / maxY) * plotH;
    let yb = padT + plotH;
    // Each segment carries its value and % share, shown only where it fits.
    const seg = (h, fill, val, textColor, name) => {
      yb -= h;
      const rect = `<rect x="${left}" y="${yb}" width="${barW}" height="${h}" fill="${fill}"><title>${s.ym} ${name} ${moneyK(val)}</title></rect>`;
      if (h < 13) return rect;
      const cy = yb + h / 2, pct = total ? Math.round((val / total) * 100) : 0;
      const valTxt = `<text x="${cx}" y="${cy + (h >= 26 ? -2 : 3)}" text-anchor="middle" font-size="8" font-weight="700" fill="${textColor}">${moneyK(val)}</text>`;
      const pctTxt = h >= 26 ? `<text x="${cx}" y="${cy + 9}" text-anchor="middle" font-size="7.5" fill="${textColor}" opacity="0.8">${pct}%</text>` : '';
      return rect + valTxt + pctTxt;
    };
    const segs = seg(hC, BRAND.orange, camp, '#fff', 'campaigns') + seg(hF, BRAND.navy, flow, '#fff', 'flows') + (useStore ? seg(hN, '#e7ddd0', nonEmail, BRAND.muted, 'other sales') : '');
    const yaVal = useStore ? s.yoyStore : s.yoyEmail;
    const d = delta(total, yaVal);
    const dLbl = yaVal ? `<text x="${cx}" y="${y(total) - 17}" text-anchor="middle" font-size="8" font-weight="700" fill="${d.color}">${d.arrow}${d.txt}</text>` : '';
    const lbl = `<text x="${cx}" y="${y(total) - 6}" text-anchor="middle" font-size="10" font-weight="700" fill="${BRAND.ink}">${moneyK(total)}</text>`;
    return band + segs + dLbl + lbl;
  }).join('');

  const labels = series.map((s, i) => {
    const mm = +s.ym.slice(5);
    const ann = mm === 6 ? `<text x="${x(i)}" y="${padT - 18}" text-anchor="middle" font-size="9" fill="${BRAND.magenta}" font-weight="700">Pride</text>`
      : mm === 11 ? `<text x="${x(i)}" y="${padT - 18}" text-anchor="middle" font-size="9" fill="${BRAND.orange}" font-weight="700">BFCM</text>` : '';
    return `${ann}<text x="${x(i)}" y="${H - padB + 16}" text-anchor="middle" font-size="9" fill="${s.inPeriod ? BRAND.orange : BRAND.muted}" ${s.inPeriod ? 'font-weight="700"' : ''}>${MONTHS[mm - 1].slice(0, 3)}</text>
      ${mm === 1 || i === 0 ? `<text x="${x(i)}" y="${H - padB + 28}" text-anchor="middle" font-size="9" fill="${BRAND.muted}">${s.ym.slice(0, 4)}</text>` : ''}`;
  }).join('');

  const lg = (cx, fill, t) => `<rect x="${cx}" y="2" width="10" height="10" fill="${fill}"/><text x="${cx + 15}" y="11">${t}</text>`;
  const legend = `<g font-size="11" fill="${BRAND.ink}">${lg(padL, BRAND.orange, 'Campaigns')}${lg(padL + 92, BRAND.navy, 'Flows')}${useStore ? lg(padL + 152, '#e7ddd0', 'Other store revenue') : ''}</g>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" font-family="'Hanken Grotesk',sans-serif" style="font-variant-numeric:tabular-nums;">${legend}${grid}${bars}${labels}</svg>`;
}

// Comparison panel: this period vs previous period vs same period last year.
function renderComparison(period, cmp) {
  if (!cmp) return '';
  const rows = [
    ['Email revenue', (m) => money(m.emailRev), (m) => m.emailRev],
    ['Campaign revenue', (m) => money(m.campaignRev), (m) => m.campaignRev],
    ['Flow revenue', (m) => money(m.flowRev), (m) => m.flowRev],
    ['Store revenue', (m) => (m.store ? money(m.store) : 'n/a'), (m) => m.store],
    ['Email % Revenue', (m) => (m.store ? m.emailShare.toFixed(0) + '%' : 'n/a'), (m) => m.emailShare],
    ['Campaigns sent', (m) => num(m.sends), (m) => m.sends],
    ['Avg open rate', (m) => m.openRate.toFixed(1) + '%', (m) => m.openRate],
    ['Avg click rate', (m) => m.clickRate.toFixed(2) + '%', (m) => m.clickRate],
  ];
  const th = (l, al = 'right') => `<th style="padding:9px 12px;text-align:${al};font-weight:700;color:#fff;background:${BRAND.navy};font-size:12px;">${l}</th>`;
  const dcell = (cur, base) => {
    const d = delta(cur, base);
    return `<td style="padding:8px 12px;border-bottom:1px solid ${BRAND.line};text-align:right;color:${d.color};font-weight:700;font-size:12px;">${d.arrow} ${d.txt}</td>`;
  };
  const body = rows.map(([label, fmt, val]) => `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.line};font-weight:600;">${label}</td>
    <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.line};text-align:right;font-weight:700;color:${BRAND.ink};">${fmt(cmp.current)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.line};text-align:right;color:${BRAND.muted};">${fmt(cmp.prev)}</td>
    ${dcell(val(cmp.current), val(cmp.prev))}
    <td style="padding:8px 12px;border-bottom:1px solid ${BRAND.line};text-align:right;color:${BRAND.muted};">${fmt(cmp.yoy)}</td>
    ${dcell(val(cmp.current), val(cmp.yoy))}
  </tr>`).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;">
    <thead><tr>${th('Metric', 'left')}${th('This period')}${th(cmp.labels.prev)}${th('Change')}${th(cmp.labels.yoy)}${th('Change')}</tr></thead>
    <tbody>${body}</tbody></table>
    <div class="ai-note">Green ${'▲'} means up versus that column, red ${'▼'} means down. "${cmp.labels.prev}" is the ${period.months.length} months just before this period; "Year ago" is the same calendar months one year earlier.</div>`;
}

// Momentum strip: trailing 30 / 90 day store + campaign revenue with YoY.
function renderMomentum(mom) {
  if (!mom) return '';
  const metric = (label, value, color, d) =>
    `<div><div style="font-family:'Fraunces',serif;font-size:23px;font-weight:600;color:${color};line-height:1;">${value}</div>
      <div style="font-size:12px;color:${BRAND.muted};margin-top:4px;">${label}${d ? ` <span style="color:${d.color};font-weight:700;">${d.arrow} ${d.txt}</span>` : ''}</div></div>`;
  const block = (days, m) => `<div style="flex:1;min-width:300px;background:${BRAND.card};border:1px solid ${BRAND.line};border-radius:16px;padding:20px 22px;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${BRAND.ink};font-weight:800;margin-bottom:14px;">Last ${days} days <span style="color:${BRAND.muted};font-weight:600;text-transform:none;letter-spacing:0;">vs same window last year</span></div>
      <div style="display:flex;gap:28px;flex-wrap:wrap;">
        ${metric('Store revenue', money0(m.store), BRAND.navy, delta(m.store, m.yoyStore))}
        ${metric('Campaign revenue', money0(m.campaignRev), BRAND.orange, delta(m.campaignRev, m.yoyCampaignRev))}
        ${metric('Campaigns sent', num(m.sends), BRAND.ink, delta(m.sends, m.yoySends))}
        ${metric('Store % from email', m.store ? ((m.campaignRev / m.store) * 100).toFixed(0) + '%' : 'n/a', BRAND.magenta, null)}
      </div></div>`;
  return `<div style="display:flex;gap:14px;flex-wrap:wrap;">${block(30, mom[30])}${block(90, mom[90])}</div>`;
}

// Horizontal bar chart of top flows by revenue.
function renderFlowBars(flows) {
  const top = flows.slice(0, 10);
  const max = Math.max(...top.map((f) => f.conversion_value), 1);
  const rowH = 32, W = 940, labelW = 220, barMax = W - labelW - 200;
  const rows = top.map((f, i) => {
    const w = (f.conversion_value / max) * barMax;
    const y = i * rowH;
    const d = f.yoy ? delta(f.conversion_value, f.yoy) : null;
    const yoyTxt = d ? `<tspan fill="${d.color}" font-weight="700"> ${d.arrow}${d.txt} YoY</tspan>` : '';
    return `<text x="0" y="${y + 20}" font-size="12" fill="${BRAND.ink}">${esc(f.flow_name.slice(0, 30))}</text>
      <rect x="${labelW}" y="${y + 8}" width="${w}" height="16" rx="3" fill="${f.channel === 'sms' ? BRAND.magenta : BRAND.navy}"/>
      <text x="${labelW + w + 6}" y="${y + 20}" font-size="11" fill="${BRAND.muted}">$${f.conversion_value.toFixed(0)} · $${f.rev_per_recipient.toFixed(2)}/r${yoyTxt}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${top.length * rowH + 6}" width="100%" font-family="'Hanken Grotesk',sans-serif" style="font-variant-numeric:tabular-nums;">${rows}</svg>`;
}

// Monthly mix table: flows, campaigns, email total, store total, email share.
function renderMixTable(series) {
  const recent = series.slice(-6);
  const th = (l, al = 'right') => `<th style="padding:8px 10px;text-align:${al};font-weight:700;color:#fff;background:${BRAND.navy};font-size:12px;">${l}</th>`;
  const body = recent.map((s) => {
    const email = s.campaign + s.flow;
    const share = s.store ? (email / s.store) * 100 : 0;
    const [yy, mm] = s.ym.split('-');
    return `<tr ${s.inPeriod ? `style="background:#fff7f3;"` : ''}>
      <td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};font-weight:${s.inPeriod ? 700 : 600};">${MONTHS[+mm - 1]} ${yy}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};text-align:right;">${money(s.flow)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};text-align:right;">${money(s.campaign)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};text-align:right;font-weight:600;">${money(email)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};text-align:right;color:${BRAND.muted};">${s.store ? money(s.store) : 'n/a'}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${BRAND.line};text-align:right;font-weight:700;color:${BRAND.orange};">${s.store ? share.toFixed(0) + '%' : 'n/a'}</td>
    </tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr>${th('Month', 'left')}${th('Flows')}${th('Campaigns')}${th('Email attr.')}${th('Store revenue')}${th('Attr. %')}</tr></thead>
    <tbody>${body}</tbody></table>
    <div class="ai-note">Attribution rule: each order is credited to the single campaign or flow the buyer last engaged with (Klaviyo last-touch), so no order is counted twice. Flows + Campaigns + Other = Store revenue.</div>`;
}

// Growth rates + churn for a list, from the reconstructed monthly totals.
function listGrowthRates(series, ch) {
  const totK = ch === 'email' ? 'emailTotal' : 'smsTotal';
  const subK = ch + 'Sub', unsubK = ch + 'Unsub';
  const has = series.some((s) => typeof s[totK] === 'number');
  const n = series.length, now = has ? series[n - 1][totK] : null;
  const at = (back) => series[Math.max(0, n - 1 - back)][totK];
  const rate = (past) => (past && now ? ((now - past) / past) * 100 : null);
  const newSubs = series.reduce((a, s) => a + s[subK], 0);
  const lost = series.reduce((a, s) => a + s[unsubK], 0);
  return {
    has, now, newSubs, lost, net: newSubs - lost,
    y1: has ? rate(at(n - 1)) : null, d90: has ? rate(at(3)) : null, d30: has ? rate(at(1)) : null,
    churn: now ? (lost / now) * 100 : null, // approx annual unsub rate
  };
}

// Percentage growth of the total list over 1yr / 90d / 30d, as a small strip.
function growthRateStrip(series, ch) {
  const r = listGrowthRates(series, ch);
  if (!r.has) return '';
  const windows = [['1 year', r.y1], ['90 days', r.d90], ['30 days', r.d30]];
  const pill = (label, pct) => {
    if (pct === null) return '';
    const up = pct >= 0;
    return `<div style="background:${BRAND.cream};border:1px solid ${BRAND.line};border-radius:10px;padding:8px 14px;">
      <span style="font-size:18px;font-weight:800;color:${up ? BRAND.pos : BRAND.neg};font-family:'Fraunces',serif;">${up ? '+' : ''}${pct.toFixed(1)}%</span>
      <span style="font-size:12px;color:${BRAND.muted};margin-left:6px;">${label}</span></div>`;
  };
  return `<div style="display:flex;gap:12px;flex-wrap:wrap;margin:2px 0 14px;">
    <div style="font-size:12px;color:${BRAND.muted};align-self:center;text-transform:uppercase;letter-spacing:.06em;font-weight:700;">List growth</div>
    ${windows.map(([l, p]) => pill(l, p)).join('')}</div>`;
}

// List growth: a rising TOTAL-SUBSCRIBERS area (the absolute number) with the
// monthly NEW (green) / LOST (red) flow as small bars along the bottom.
function renderGrowthChart(series, ch) {
  const subK = ch + 'Sub', unsubK = ch + 'Unsub', totK = ch === 'email' ? 'emailTotal' : 'smsTotal';
  const hasTotal = series.some((s) => typeof s[totK] === 'number');
  const W = 1000, H = 300, padL = 56, padR = 18, padT = 40, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const areaH = plotH * 0.66;            // top: total-subscribers area
  const baseY = padT + plotH * 0.86;     // baseline for the new/lost flow bars
  const flowH = plotH * 0.14;            // half-height of the flow band
  const n = series.length, gW = plotW / n, bW = Math.min(20, gW * 0.46);
  const x = (i) => padL + gW * i + gW / 2;

  // Total-subscribers area scale.
  const totals = series.map((s) => s[totK] || 0);
  const tMin = Math.min(...totals) * 0.96, tMax = Math.max(...totals, 1);
  const yT = (v) => padT + areaH - ((v - tMin) / (tMax - tMin || 1)) * areaH;

  let areaSvg = '', totLabels = '', gridSvg = '';
  if (hasTotal) {
    // y gridlines for the count axis
    for (let g = 0; g <= 3; g++) {
      const v = tMin + ((tMax - tMin) / 3) * g, yy = yT(v);
      gridSvg += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${BRAND.line}"/><text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="10" fill="${BRAND.muted}">${Math.round(v).toLocaleString()}</text>`;
    }
    const pts = series.map((s, i) => `${x(i)},${yT(s[totK] || 0)}`).join(' ');
    areaSvg = `<polygon points="${padL},${padT + areaH} ${pts} ${W - padR},${padT + areaH}" fill="${BRAND.orange}" opacity="0.12"/>
      <polyline points="${pts}" fill="none" stroke="${BRAND.orange}" stroke-width="2.5"/>`;
    // label first + last totals
    const first = series[0], last = series[n - 1];
    totLabels = `<circle cx="${x(0)}" cy="${yT(first[totK])}" r="3" fill="${BRAND.orange}"/><text x="${x(0) + 6}" y="${yT(first[totK]) - 6}" font-size="10" font-weight="700" fill="${BRAND.ink}">${first[totK].toLocaleString()}</text>
      <circle cx="${x(n - 1)}" cy="${yT(last[totK])}" r="3.5" fill="${BRAND.orange}"/><text x="${x(n - 1)}" y="${yT(last[totK]) - 8}" text-anchor="end" font-size="12" font-weight="800" fill="${BRAND.orange}">${last[totK].toLocaleString()}</text>`;
  }

  // New/lost flow bars along the bottom.
  const fMax = Math.max(...series.map((s) => Math.max(s[subK], s[unsubK])), 1);
  const fh = (v) => (v / fMax) * flowH;
  const bars = series.map((s, i) => {
    const cx = x(i), up = fh(s[subK]), dn = fh(s[unsubK]), op = s.inPeriod ? 1 : 0.7;
    const subLbl = s[subK] ? `<text x="${cx}" y="${baseY - up - 3}" text-anchor="middle" font-size="8" fill="${BRAND.pos}" font-weight="700">+${s[subK]}</text>` : '';
    return `<rect x="${cx - bW / 2}" y="${baseY - up}" width="${bW}" height="${up}" fill="${BRAND.pos}" opacity="${op}"><title>${s.ym} +${s[subK]} new</title></rect>
      <rect x="${cx - bW / 2}" y="${baseY}" width="${bW}" height="${dn}" fill="${BRAND.neg}" opacity="${op}"><title>${s.ym} -${s[unsubK]} lost</title></rect>${subLbl}`;
  }).join('');
  const labels = series.map((s, i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="${s.inPeriod ? BRAND.orange : BRAND.muted}" ${s.inPeriod ? 'font-weight="700"' : ''}>${MONTHS[+s.ym.slice(5) - 1].slice(0, 3)}</text>`).join('');

  const totSub = series.reduce((a, s) => a + s[subK], 0), totUnsub = series.reduce((a, s) => a + s[unsubK], 0);
  const net = totSub - totUnsub;
  const cur = hasTotal ? series[n - 1][totK] : null;
  const lg = (cx, fill, t) => `<rect x="${cx}" y="2" width="10" height="10" fill="${fill}"/><text x="${cx + 15}" y="11">${t}</text>`;
  const legend = `<g font-size="11" fill="${BRAND.ink}">
    ${hasTotal ? `<line x1="${padL}" y1="7" x2="${padL + 14}" y2="7" stroke="${BRAND.orange}" stroke-width="2.5"/><text x="${padL + 20}" y="11" font-weight="700">Total subscribers${cur ? ` (now ${cur.toLocaleString()})` : ''}</text>` : ''}
    ${lg(padL + (hasTotal ? 230 : 0), BRAND.pos, `New +${totSub.toLocaleString()}`)}${lg(padL + (hasTotal ? 350 : 120), BRAND.neg, `Lost -${totUnsub.toLocaleString()}`)}
    <text x="${padL + (hasTotal ? 470 : 240)}" y="11" font-weight="700">Net +${net.toLocaleString()} over ${n} mo</text></g>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" font-family="'Hanken Grotesk',sans-serif" style="font-variant-numeric:tabular-nums;">${legend}${gridSvg}${areaSvg}${totLabels}<line x1="${padL}" y1="${baseY}" x2="${W - padR}" y2="${baseY}" stroke="${BRAND.line}"/>${bars}${labels}</svg>`;
}

// Engagement funnel: delivered → opened → clicked → converted, with both the
// absolute count, % of delivered, and step-to-step conversion from the prior stage.
function renderFunnel(stages) {
  const max = stages[0].value || 1, W = 940, rowH = 52, barMax = W - 360, x0 = 140;
  const rows = stages.map((st, i) => {
    const w = Math.max((st.value / max) * barMax, 2);
    const pct = max ? (st.value / max) * 100 : 0;
    const prev = i > 0 ? stages[i - 1].value : null;
    const step = prev ? (st.value / prev) * 100 : null;
    const y = i * rowH;
    const stepTxt = step !== null ? `<tspan fill="${BRAND.orange}" font-weight="700">${step.toFixed(0)}% from ${stages[i - 1].label.toLowerCase()}</tspan>` : `<tspan fill="${BRAND.muted}">baseline</tspan>`;
    return `<text x="0" y="${y + 30}" font-size="13" font-weight="700" fill="${BRAND.ink}" font-family="'Fraunces',serif">${st.label}</text>
      <rect x="${x0}" y="${y + 8}" width="${w}" height="30" rx="5" fill="${BRAND.orange}" opacity="${1 - i * 0.18}"/>
      <text x="${x0 + w + 10}" y="${y + 21}" font-size="14" font-weight="800" fill="${BRAND.ink}">${st.value.toLocaleString()}</text>
      <text x="${x0 + w + 10}" y="${y + 35}" font-size="11" fill="${BRAND.muted}">${pct.toFixed(1)}% of delivered · ${stepTxt}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${stages.length * rowH + 6}" width="100%" font-family="'Hanken Grotesk',sans-serif" style="font-variant-numeric:tabular-nums;">${rows}</svg>`;
}

// Signup form (pop-up): KPI cards + monthly submitted bars.
function renderFormPanel(form) {
  const cards = `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px;">
    ${kpiCard(num(form.viewed), 'Form views', BRAND.navy, delta(form.viewed, form.yoyViewed, { minBase: 1500 }))}
    ${kpiCard(num(form.submitted), 'Submissions', BRAND.orange, delta(form.submitted, form.yoySubmitted, { minBase: 80 }))}
    ${kpiCard(form.rate.toFixed(2) + '%', 'Submit rate')}</div>`;
  const W = 1000, top = 116, h0 = 92, max = Math.max(...form.series.map((s) => Math.max(s.submitted, s.yoySubmitted)), 1);
  const gW = W / form.series.length, bW = Math.min(24, gW * 0.42);
  const bars = form.series.map((s, i) => {
    const hh = (s.submitted / max) * h0, cx = gW * i + gW / 2;
    const yh = (s.yoySubmitted / max) * h0;
    const ya = s.yoySubmitted ? `<rect x="${cx + 1}" y="${top - yh}" width="${bW * 0.5}" height="${yh}" fill="${BRAND.muted}" opacity="0.4"><title>${s.ym} last yr: ${s.yoySubmitted}</title></rect>` : '';
    const lbl = s.submitted ? `<text x="${cx - bW * 0.25}" y="${top - hh - 3}" text-anchor="middle" font-size="8" font-weight="700" fill="${BRAND.ink}">${s.submitted}</text>` : '';
    return `<rect x="${cx - bW * 0.75}" y="${top - hh}" width="${bW * 0.6}" height="${hh}" fill="${s.inPeriod ? BRAND.orange : BRAND.navy}" opacity="${s.inPeriod ? 1 : 0.75}"><title>${s.ym}: ${s.submitted} submits</title></rect>${ya}${lbl}
      <text x="${cx}" y="${top + 14}" text-anchor="middle" font-size="9" fill="${BRAND.muted}">${MONTHS[+s.ym.slice(5) - 1].slice(0, 3)}</text>`;
  }).join('');
  const legend = `<g font-size="11" fill="${BRAND.ink}"><rect x="0" y="0" width="10" height="10" fill="${BRAND.orange}"/><text x="15" y="9">Submissions</text><rect x="110" y="0" width="10" height="10" fill="${BRAND.muted}" opacity="0.4"/><text x="125" y="9" fill="${BRAND.muted}">Last year</text></g>`;
  return `${cards}<div style="font-size:12px;color:${BRAND.muted};margin:8px 0 2px;">Monthly form submissions (vs last year)</div>
    <svg viewBox="0 0 ${W} 134" width="100%" font-family="'Hanken Grotesk',sans-serif" style="font-variant-numeric:tabular-nums;">${legend}${bars}</svg>`;
}

// Creative gallery: full live renders of the real email HTML. Each iframe is
// measured on load and its card sized to the full email height (no clipping).
const EP_RENDER_W = 680, EP_COL_W = 300, EP_SCALE = EP_COL_W / EP_RENDER_W;
function renderCreativeGallery(previews) {
  const cards = previews.map((p) => {
    const safe = (p.html || '').replace(/"/g, '&quot;');
    return `<div style="width:${EP_COL_W}px;border:1px solid ${BRAND.line};border-radius:10px;overflow:hidden;background:#fff;">
      <div class="ep-wrap" style="position:relative;width:${EP_COL_W}px;height:520px;overflow:hidden;background:#fff;">
        <iframe class="ep" sandbox="allow-same-origin" scrolling="no" srcdoc="${safe}" onload="sizeEp(this)"
          style="width:${EP_RENDER_W}px;height:2400px;border:0;transform:scale(${EP_SCALE.toFixed(4)});transform-origin:top left;pointer-events:none;position:absolute;top:0;left:0;"></iframe></div>
      <div style="padding:10px 12px;border-top:1px solid ${BRAND.line};">
        <div style="font-size:12px;font-weight:700;color:${BRAND.ink};">${esc(p.subject || p.name)}</div>
        <div style="font-size:12px;color:${BRAND.orange};font-weight:700;margin-top:3px;">${money(p.revenue)}</div></div></div>`;
  }).join('');
  return `<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;">${cards}</div>
    <div class="ai-note">Full live renders of the actual email HTML (top campaigns by revenue). External images load from Klaviyo/Shopify CDN.</div>`;
}

// A recommendations callout (markdown -> styled block). Used by each domain
// section to show its slice of the Playbook's Strategic Priorities.
function recsBlock(md) {
  if (!md) return '';
  return `<div style="background:#fff7f3;border:1px solid ${BRAND.line};border-left:4px solid ${BRAND.orange};border-radius:0 10px 10px 0;padding:14px 18px;margin-top:8px;"><div class="gt">${mdToHtml(md)}</div>
    <div style="font-size:12px;color:${BRAND.muted};margin-top:6px;font-style:italic;">Standing roadmap from the Playbook. Refresh it ("refresh the playbook") after a launch or new season.</div></div>`;
}

// Audience Growth: the dedicated "biggest lever" section. Scorecard (size,
// growth rates, churn, health grade) + value-of-a-subscriber + the growth
// charts + the capture funnel, all in one.
function renderAudienceGrowth(growth, series, form, playbook, audience) {
  const er = listGrowthRates(growth, 'email');
  const sr = listGrowthRates(growth, 'sms');
  const last12 = series.slice(-12);
  const annualRev = last12.reduce((s, m) => s + (m.campaign || 0) + (m.flow || 0), 0);
  const valPerSub = er.now ? annualRev / er.now : null;
  // Signup conversion: new email subscribers in the period / total store sessions.
  const sessions = audience && audience.sessions;
  const periodNewSubs = audience && audience.periodNewSubs;
  const signupRate = sessions && periodNewSubs != null ? (periodNewSubs / sessions) * 100 : null;
  const pctTxt = (p) => (p === null ? 'n/a' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`);
  const pctCol = (p) => (p === null ? BRAND.muted : p >= 0 ? BRAND.pos : BRAND.neg);
  const grade = (r, opts = {}) => {
    if (r.y1 === null) return { t: '—', c: BRAND.muted };
    if (opts.scaleFlag && r.now < 2000) return { t: 'Under-scaled', c: BRAND.orange };
    if (r.y1 >= 20) return { t: 'Strong', c: BRAND.pos };
    if (r.y1 >= 10) return { t: 'On track', c: BRAND.pos };
    return { t: 'Below target', c: BRAND.neg };
  };

  const value = valPerSub ? `<div style="background:linear-gradient(100deg,${BRAND.navy},#2a3a5c);color:#fff;border-radius:16px;padding:22px 26px;margin:0 0 16px;">
    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.8;font-weight:700;">Why this is the biggest lever</div>
    <div style="font-family:'Fraunces',serif;font-size:22px;font-weight:600;margin:8px 0 0;line-height:1.4;">
      Each email subscriber is worth about <span style="color:#ffd9c9;">$${valPerSub.toFixed(0)}/year</span>.
      Growing the list <b>+1,000</b> is roughly <span style="color:#ffd9c9;">+$${(valPerSub * 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })}/year</span>, and it compounds.</div>
    <div style="font-size:13px;opacity:.85;margin-top:10px;">Based on ${money0(annualRev)} email-attributed revenue over the last 12 months across ${er.now ? er.now.toLocaleString() : '—'} subscribers. SMS subscribers are worth even more per head.</div>
  </div>` : '';

  const card = (label, r, g, sub) => `<div style="flex:1;min-width:250px;background:${BRAND.cream};border:1px solid ${BRAND.line};border-radius:14px;padding:18px 20px;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;">
      <div style="font-family:'Fraunces',serif;font-size:16px;font-weight:700;color:${BRAND.ink};">${label}</div>
      <div style="font-size:12px;font-weight:800;color:${g.c};">${g.t}</div></div>
    <div style="font-family:'Fraunces',serif;font-size:30px;font-weight:600;color:${BRAND.navy};margin:8px 0 0;line-height:1;">${r.now != null ? r.now.toLocaleString() : '—'}</div>
    <div style="font-size:12px;color:${BRAND.muted};">subscribers · net ${r.net >= 0 ? '+' : ''}${r.net.toLocaleString()} / yr</div>
    <div style="display:flex;gap:20px;margin-top:14px;font-size:12px;">
      <div><b style="color:${pctCol(r.y1)};font-size:14px;">${pctTxt(r.y1)}</b><br><span style="color:${BRAND.muted};">1 year</span></div>
      <div><b style="color:${pctCol(r.d90)};font-size:14px;">${pctTxt(r.d90)}</b><br><span style="color:${BRAND.muted};">90 days</span></div>
      <div><b style="color:${pctCol(r.d30)};font-size:14px;">${pctTxt(r.d30)}</b><br><span style="color:${BRAND.muted};">30 days</span></div>
      <div><b style="font-size:14px;color:${BRAND.ink};">${r.churn != null ? r.churn.toFixed(0) + '%' : '—'}</b><br><span style="color:${BRAND.muted};">annual churn</span></div>
    </div>${sub || ''}</div>`;

  const subh = (t) => `<div style="font-family:'Fraunces',serif;font-size:15px;font-weight:700;color:${BRAND.navy};margin:22px 0 8px;border-top:1px solid ${BRAND.line};padding-top:16px;">${t}</div>`;

  const sp = playbook ? extractH3(playbook.narrative, /audience|list growth/i) : '';
  const priorities = sp ? `${subh('List growth strategies — what to do about it')}${recsBlock(sp)}` : '';

  const signupLine = signupRate != null
    ? `<div style="margin:0 0 10px;font-size:13px;color:${BRAND.ink};"><b style="color:${BRAND.orange};">${signupRate.toFixed(2)}%</b> signup conversion: ${periodNewSubs.toLocaleString()} new email subscribers from ${sessions.toLocaleString()} store sessions this period.</div>`
    : '';

  return `${value}
    <div style="display:flex;gap:14px;flex-wrap:wrap;">
      ${card('Email list', er, grade(er))}
      ${card('SMS list', sr, grade(sr, { scaleFlag: true }))}
    </div>
    ${priorities}
    ${subh('Email subscribers over time')}${growthRateStrip(growth, 'email')}${renderGrowthChart(growth, 'email')}
    ${subh('SMS subscribers over time')}${growthRateStrip(growth, 'sms')}${renderGrowthChart(growth, 'sms')}
    ${form ? `${subh('Capture funnel (website pop-up)')}${signupLine}${renderFormPanel(form)}` : ''}`;
}

// Categorized takeaways: Wins / Watch-outs / Worth Watching.
function renderTakeaways(t) {
  const group = (title, items, color) => (items && items.length) ? `
    <div style="margin:0 0 18px;">
      <div style="font-family:'Fraunces',serif;font-weight:700;font-size:16px;color:${color};margin:0 0 10px;">
        <span style="display:inline-block;width:9px;height:9px;background:${color};border-radius:2px;transform:rotate(45deg);margin-right:9px;"></span>${title}</div>
      <ul style="margin:0;padding-left:20px;list-style:none;">
        ${items.map((i) => `<li style="position:relative;padding-left:20px;margin:0 0 9px;line-height:1.55;color:${BRAND.ink};font-size:15px;"><span style="position:absolute;left:0;top:8px;width:7px;height:7px;background:${color};opacity:.5;border-radius:2px;transform:rotate(45deg);"></span>${esc(i)}</li>`).join('')}
      </ul></div>` : '';
  return group('Highlights', t.highlights, BRAND.pos) + group('Underperformers', t.underperformers, BRAND.neg) + group('Opportunities', t.opportunities, BRAND.magenta);
}

// Ground Truths: the recency-weighted playbook that informed the takeaways.
function renderGroundTruths(playbook) {
  if (!playbook) return '';
  const when = (playbook.generated_at || '').slice(0, 10);
  return `<div style="font-size:13px;color:${BRAND.muted};margin:0 0 14px;">The durable, recency-weighted patterns from RUBIES' full email history (through ${playbook.through_date || 'recent'}, refreshed ${when}). These are the ground truths the analysis above is measured against.</div>
    <div class="gt">${mdToHtml(playbook.narrative)}</div>`;
}

function renderHTML({ period, campaigns, campSummary, flows, flowRev, takeaways, flowSource, series, growth, funnel, form, previews, comparisons, momentum, playbook, audience }) {
  const yoy = comparisons?.yoy;
  const cards = [
    kpiCard(money0(campSummary.revenue), 'Campaign revenue', BRAND.orange, yoy ? delta(campSummary.revenue, yoy.campaignRev) : null),
    kpiCard(money0(flowRev), 'Flow revenue', BRAND.navy, yoy ? delta(flowRev, yoy.flowRev) : null),
    kpiCard(money0(campSummary.revenue + flowRev), 'Email revenue', BRAND.magenta, yoy ? delta(campSummary.revenue + flowRev, yoy.emailRev) : null),
    kpiCard(num(campSummary.sends), 'Campaigns sent', BRAND.navy, yoy ? delta(campSummary.sends, yoy.sends) : null),
    kpiCard(pct(campSummary.wOpen), 'Avg open rate', BRAND.navy, yoy ? delta(campSummary.wOpen, yoy.openRate) : null),
    kpiCard(pct(campSummary.wClick), 'Avg click rate', BRAND.navy, yoy ? delta(campSummary.wClick, yoy.clickRate) : null),
  ].join('');

  // Campaign table: group by month for quarters.
  let campSection = '';
  if (period.months.length > 1) {
    for (const m of period.months) {
      const inMonth = campaigns.filter((r) => r.send_date >= m.start && r.send_date <= m.endIncl);
      if (!inMonth.length) continue;
      campSection += `<div style="padding:6px 12px 2px;font-weight:700;color:${BRAND.navy};font-size:14px;">${m.label}</div>
        <div style="overflow-x:auto;padding:0 4px 14px;">${renderCampaignTable(inMonth)}</div>`;
    }
  } else {
    campSection = `<div style="overflow-x:auto;">${renderCampaignTable(campaigns)}</div>`;
  }

  const flowNote = flowSource === 'live'
    ? 'Flows pulled live from Klaviyo (period not yet synced to Supabase).'
    : 'Flows from klaviyo_flow_metrics (Supabase).';

  let sec = 0;
  const P = (title, inner, pad, anchor) => { sec += 1; return panel(`${String(sec).padStart(2, '0')} · ${title}`, inner, pad, anchor); };
  const cap = (t) => `<div class="ai-note" style="padding-top:12px;">${t}</div>`;
  const sw = (c) => `<span style="display:inline-block;width:9px;height:9px;background:${c};border-radius:2px;vertical-align:baseline;margin:0 2px 0 6px;"></span>`;
  // Part dividers group the sections into the things you manage.
  const part = (label, sub) => `<div style="margin:38px 44px 2px;padding:16px 26px;background:${BRAND.navy};color:${BRAND.cream};border-radius:16px;">
    <div style="font-family:'Fraunces',serif;font-size:22px;font-weight:600;letter-spacing:.01em;">${label}</div>
    <div style="font-size:13px;opacity:.78;margin-top:2px;">${sub}</div></div>`;
  const secSubh = (t) => `<div style="font-family:'Fraunces',serif;font-size:15px;font-weight:700;color:${BRAND.navy};margin:20px 0 8px;border-top:1px solid ${BRAND.line};padding-top:16px;">${t}</div>`;
  // Per-domain recommendations, pulled from the Playbook's Strategic Priorities.
  const campaignRecs = playbook ? extractH3(playbook.narrative, /campaign/i) : '';
  const flowRecs = playbook ? extractH3(playbook.narrative, /flow/i) : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RUBIES Email Performance · ${esc(period.label)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Hanken+Grotesk:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:${BRAND.cream};color:${BRAND.ink};
    font-family:'Hanken Grotesk',-apple-system,sans-serif;font-variant-numeric:tabular-nums;
    background-image:radial-gradient(${BRAND.line} 0.5px,transparent 0.5px);background-size:22px 22px;}
  .wrap{max-width:1120px;margin:0 auto;padding:0 0 64px;}
  .mast{padding:54px 44px 30px;border-bottom:2px solid ${BRAND.ink};margin:0 0 8px;}
  .mast .eyebrow{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:${BRAND.orange};font-weight:700;}
  .mast h1{font-family:'Fraunces',serif;font-weight:600;font-size:58px;line-height:.98;margin:14px 0 0;letter-spacing:-.01em;color:${BRAND.ink};}
  .mast h1 em{font-style:italic;color:${BRAND.orange};}
  .mast .sub{margin:14px 0 0;font-size:15px;color:${BRAND.muted};display:flex;gap:14px;flex-wrap:wrap;align-items:center;}
  .mast .pill{background:${BRAND.ink};color:${BRAND.cream};padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.02em;}
  .kpis{display:flex;flex-wrap:wrap;gap:14px;padding:26px 44px 0;}
  .panel{background:${BRAND.card};margin:22px 44px 0;border:1px solid ${BRAND.line};border-radius:18px;box-shadow:0 1px 2px rgba(36,26,22,.04);overflow:hidden;}
  .panel-h{padding:20px 26px 0;display:flex;align-items:baseline;justify-content:space-between;gap:12px;}
  .panel-h h2{margin:0;font-family:'Fraunces',serif;font-size:19px;font-weight:600;color:${BRAND.ink};letter-spacing:-.01em;}
  .panel-h h2 .bar{display:none;}
  .method{font-size:12px;font-weight:700;color:${BRAND.orange};text-decoration:none;white-space:nowrap;}
  .method:hover{text-decoration:underline;}
  .mast .howto{color:${BRAND.orange};font-weight:700;text-decoration:none;}
  .mast .howto:hover{text-decoration:underline;}
  .takeaways ul{margin:8px 0 0;padding-left:0;list-style:none;font-size:15px;}
  .takeaways li{padding-left:22px;position:relative;}
  .takeaways li:before{content:"";position:absolute;left:2px;top:9px;width:8px;height:8px;background:${BRAND.orange};border-radius:2px;transform:rotate(45deg);}
  .ai-note{font-size:12px;color:${BRAND.muted};padding:10px 26px 0;font-style:italic;}
  .foot{padding:30px 44px 0;font-size:12px;color:${BRAND.muted};}
  .lead{padding:2px 26px 14px;font-size:13px;color:${BRAND.muted};}
  .gt .gt-h{font-family:'Fraunces',serif;font-weight:600;font-size:16px;color:${BRAND.navy};margin:16px 0 6px;}
  .gt .gt-p{font-size:14px;margin:0 0 8px;color:${BRAND.ink};}
  .gt .gt-ul{margin:0 0 10px;padding-left:20px;font-size:14px;}
  .gt .gt-ul li{margin:0 0 5px;}
  .gt strong{color:${BRAND.navy};}
</style></head>
<body><div class="wrap">
  <div class="mast">
    <div class="eyebrow">RUBIES · Email Marketing Report</div>
    <h1>Email <em>Performance</em></h1>
    <div class="sub"><span class="pill">${esc(period.label)}</span>${period.sublabel ? `<span>${esc(period.sublabel)}</span>` : ''}<a class="howto" href="how-it-works.html">How this report works &#8599;</a></div>
  </div>
  <div class="kpis">${cards}</div>

  ${part('Overview', 'The whole program at a glance')}
  ${comparisons ? P('Period Comparison', `<div class="lead">How this period stacks up against the run just before it and the same time last year.</div>${renderComparison(period, comparisons)}`, '6px 24px 18px', 'comparison') : ''}
  ${momentum ? P('Momentum (trailing windows)', `${renderMomentum(momentum)}${cap(`Recent performance over the last 30 and 90 days. Each ${'▲'}/${'▼'} compares to the same length window exactly one year earlier (green = up, red = down).`)}`, '18px 24px', 'momentum') : ''}
  ${series && series.length ? P('Revenue Over Time', `${renderRevenueChart(series)}${cap(`Each bar is total store revenue, split into the part attributed to campaigns${sw(BRAND.orange)}, flows${sw(BRAND.navy)}, and other sales${sw('#e7ddd0')}. Attribution is last-touch (each order credited to one campaign or flow), so the three add up to the store total with nothing double-counted. Number on top = month total; small colored % = change vs the same month a year earlier. Shaded column = this report's period, faint column = that period last year.`)}<div style="margin-top:18px;overflow-x:auto;">${renderMixTable(series)}</div>`, '18px 24px', 'revenue') : ''}
  ${funnel ? P('Engagement Funnel', `${renderFunnel(funnel)}${cap('Each stage shows the count, its share of everyone who was delivered the email, and the conversion from the stage directly above it.')}`, '18px 24px', 'funnel') : ''}

  ${part('Lists', 'Your audience: the biggest revenue lever')}
  ${growth && growth.length ? P('Audience Growth', `${renderAudienceGrowth(growth, series, form, playbook, audience)}${cap(`Total lines are anchored to the live Newsletter / SMS Subscribers list sizes and walked back by each month's net change, so older months are estimates. Signup conversion uses total Shopify store sessions (excl. China). Form-view tracking began recording properly in late 2025.`)}`, '18px 26px', 'growth') : ''}

  ${part('Campaigns', 'One-off sends: what you broadcast')}
  ${P('Campaign Performance', `${campSection}${campaignRecs ? `${secSubh('Campaign strategies')}${recsBlock(campaignRecs)}` : ''}`, '14px', 'campaigns')}
  ${previews && previews.length ? P('Creative Gallery', renderCreativeGallery(previews), '18px 24px') : ''}

  ${part('Flows', 'Automations: always-on revenue')}
  ${P('Top Flows by Revenue', `${renderFlowBars(flows)}<div style="margin-top:16px;overflow-x:auto;">${renderFlowTable(flows.slice(0, 12))}</div>${cap(`Bar color = channel: email${sw(BRAND.navy)} and SMS${sw(BRAND.magenta)}. "$/r" is revenue per recipient. The colored % is the change vs the same period last year. ${flowNote}`)}${flowRecs ? `${secSubh('Flow strategies')}${recsBlock(flowRecs)}` : ''}`, '14px', 'flows')}

  ${part('Strategy', 'Takeaways and durable ground truths')}
  <div class="panel"><div class="panel-h"><h2>${String(sec += 1).padStart(2, '0')} · Takeaways</h2><a class="method" href="how-it-works.html#takeaways" title="How this is calculated">Methodology &#8599;</a></div>
    <div class="takeaways" style="padding:14px 26px 14px;">${renderTakeaways(takeaways)}</div>
    <div class="ai-note" style="padding-bottom:20px;">Drafted by Opus from this period's list, campaign, and flow data plus the Playbook ground truths, judged by each send's real objective. Review before sharing.</div></div>
  ${playbook ? P('Ground Truths (Playbook)', renderGroundTruths(playbook), '18px 26px', 'playbook') : ''}
  <div class="foot">All data from Supabase feeds (klaviyo_campaigns, klaviyo_flow_metrics, klaviyo_audience_daily, shopify_sessions_daily, orders, marketing_playbook). ${num(campSummary.sends)} campaigns, ${flows.length} flows · ${esc(period.label)}.</div>
</div>
<script>
  var EP_SCALE = ${EP_SCALE.toFixed(4)};
  // Size each email preview card to the full rendered email height (no clipping).
  function sizeEp(f) {
    try {
      var doc = f.contentDocument;
      var h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
      f.style.height = h + 'px';
      f.parentElement.style.height = Math.ceil(h * EP_SCALE) + 'px';
    } catch (e) { /* leave default height if measurement is blocked */ }
  }
  // Re-measure once images have loaded (email height grows as images arrive).
  window.addEventListener('load', function () {
    document.querySelectorAll('iframe.ep').forEach(function (f) { setTimeout(function () { sizeEp(f); }, 600); });
  });
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// generateReport — reusable entry point (used by the CLI and the MCP tool).
// Returns { outPath, period, campSummary, flowRev, flowCount, takeaways }.
// ---------------------------------------------------------------------------
async function generateReport(periodArg, { log = () => {} } = {}) {
  const period = parsePeriod(periodArg);
  log(`Building ${period.kind} report for ${period.label} (${period.start} → ${period.endIncl})…`);

  const campaigns = await fetchCampaigns(period);
  if (!campaigns.length) throw new Error(`No campaigns found in ${period.label}.`);
  log(`  ${campaigns.length} campaigns.`);

  const campSummary = summarizeCampaigns(campaigns);
  const { flows, source } = await fetchFlows(period);
  const flowRev = flows.reduce((s, f) => s + f.conversion_value, 0);
  log(`  ${flows.length} flows (${source}), flow revenue ${money(flowRev)}.`);

  const [series, growth, form, previews, comparisons, momentum, flowYoY, playbook, sessions] = await Promise.all([
    fetchMonthlySeries(period).catch(() => []),
    fetchSubscriberGrowth(period).catch(() => []),
    fetchFormMetrics(period).catch(() => null),
    fetchEmailPreviews(campaigns).catch(() => []),
    fetchComparisons(period).catch(() => null),
    fetchMomentum(period).catch(() => null),
    fetchFlowYoY(period).catch(() => ({})),
    loadPlaybook().catch(() => null),
    fetchSessions(period.start, period.endIncl).catch(() => null),
  ]);
  for (const f of flows) f.yoy = flowYoY[`${f.flow_name}|${f.channel}`] || 0;
  const periodNewSubs = (growth || []).filter((g) => g.inPeriod).reduce((a, g) => a + (g.emailSub || 0), 0);
  const audience = { sessions, periodNewSubs };
  log(`  ${series.length} months revenue, ${growth.length} months growth, ${previews.length} email previews, comparisons ${comparisons ? 'ok' : 'n/a'}.`);

  // Engagement funnel from campaigns + flows in the period.
  const cOpens = campaigns.reduce((s, r) => s + (r.opens || 0), 0);
  const cClicks = campaigns.reduce((s, r) => s + (r.clicks || 0), 0);
  const cConv = campaigns.reduce((s, r) => s + (r.conversions || 0), 0);
  const fSum = flows.reduce((a, f) => ({
    delivered: a.delivered + (f.delivered || 0), opens: a.opens + (f.opens || 0),
    clicks: a.clicks + (f.clicks || 0), conv: a.conv + (f.conversions || 0),
  }), { delivered: 0, opens: 0, clicks: 0, conv: 0 });
  const funnel = [
    { label: 'Delivered', value: campSummary.recipients + fSum.delivered },
    { label: 'Opened', value: cOpens + fSum.opens },
    { label: 'Clicked', value: cClicks + fSum.clicks },
    { label: 'Converted', value: cConv + fSum.conv },
  ];

  // Audience context so the takeaways cover lists/capture, not just campaigns.
  const erT = growth.length ? listGrowthRates(growth, 'email') : null;
  const srT = growth.length ? listGrowthRates(growth, 'sms') : null;
  const signupRateT = sessions && periodNewSubs != null ? (periodNewSubs / sessions) * 100 : null;
  const audienceCtx = erT ? [
    `Email list: ${erT.now} subscribers, growth ${erT.y1?.toFixed(1)}%/yr (${erT.d90?.toFixed(1)}% 90d, ${erT.d30?.toFixed(1)}% 30d), ~${erT.churn?.toFixed(0)}% annual churn, net ${erT.net >= 0 ? '+' : ''}${erT.net} over 12mo.`,
    srT ? `SMS list: ${srT.now} subscribers, growth ${srT.y1?.toFixed(1)}%/yr, net ${srT.net >= 0 ? '+' : ''}${srT.net}. (SMS converts far better per recipient but is much smaller.)` : '',
    signupRateT != null ? `Signup conversion: ${signupRateT.toFixed(2)}% (${periodNewSubs} new email subs from ${sessions.toLocaleString()} store sessions).` : '',
    form ? `Pop-up: ${form.viewed} views, ${form.submitted} submissions, ${form.rate.toFixed(2)}% submit rate.` : '',
  ].filter(Boolean).join('\n') : null;

  let takeaways;
  try {
    takeaways = await writeTakeaways(campaigns, flows, period, playbook, audienceCtx);
  } catch (err) {
    log(`  Takeaways failed: ${err.message}`);
    takeaways = ['(Takeaways could not be generated. Check ANTHROPIC_API_KEY / network.)'];
  }

  const html = renderHTML({ period, campaigns, campSummary, flows, flowRev, takeaways, flowSource: source, series, growth, funnel, form, previews, comparisons, momentum, playbook, audience });
  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `email-report-${period.slug}.html`);
  fs.writeFileSync(outPath, html);
  writeMethodology(outDir); // companion "how-it-works.html" the report links to
  return { outPath, period, campSummary, flowRev, flowCount: flows.length, takeaways };
}

module.exports = { generateReport, parsePeriod };

// CLI entry point.
if (require.main === module) {
  generateReport(process.argv[2], { log: (m) => console.log(m) })
    .then((r) => console.log(`\nReport ready: ${r.outPath}`))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
