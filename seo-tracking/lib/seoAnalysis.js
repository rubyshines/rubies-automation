/**
 * SEO Analysis Engine — shared by MCP tool and weekly email digest.
 *
 * All heavy lifting lives here: date ranges, Supabase queries,
 * aggregation, anomaly detection, and recommendation generation.
 */

const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pctChange(current, previous) {
  if (!previous || previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function fmtPct(n) {
  if (n == null) return '—';
  return `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`;
}

function fmtCurrency(n) {
  if (n == null) return '—';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortenUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url.replace(/^https?:\/\/[^/]+/, '');
  }
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return formatDate(dt);
}

function arrow(pct) {
  if (pct > 2) return '\u2191'; // up
  if (pct < -2) return '\u2193'; // down
  return '\u2192'; // flat
}

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

function computeDateRanges(periodDays = 30, compareTo = 'previous_period', baselineDate = null) {
  const config = loadConfig();
  const baseline = baselineDate || config.baseline_date || '2026-02-18';

  const today = formatDate(new Date());
  const endDate = addDays(today, -1); // yesterday
  const startDate = addDays(endDate, -(periodDays - 1));

  let compareStart, compareEnd;
  if (compareTo === 'baseline') {
    compareEnd = addDays(baseline, -1);
    compareStart = addDays(compareEnd, -(periodDays - 1));
  } else if (compareTo === 'year_ago') {
    compareEnd = addDays(endDate, -365);
    compareStart = addDays(startDate, -365);
  } else {
    compareEnd = addDays(startDate, -1);
    compareStart = addDays(compareEnd, -(periodDays - 1));
  }

  return {
    current: { start: startDate, end: endDate },
    compare: { start: compareStart, end: compareEnd },
    baseline,
    periodDays,
    compareTo,
  };
}

// ---------------------------------------------------------------------------
// Supabase helper — lazy-loaded to avoid requiring dotenv at import time
// ---------------------------------------------------------------------------

let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    const { getSupabaseClient } = require('../../shared/supabaseClient');
    _supabase = getSupabaseClient();
  }
  return _supabase;
}

function fetchAllPaginated(buildQuery) {
  return require('../../shared/supabaseClient').fetchAllPaginated(buildQuery);
}

// ---------------------------------------------------------------------------
// Supabase state fetchers (replaces config.json for dynamic state)
// ---------------------------------------------------------------------------

async function fetchStrategyItems() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('seo_strategy_items')
    .select('*')
    .order('sort_order', { ascending: true });
  if (error) throw new Error(`fetchStrategyItems: ${error.message}`);
  return data || [];
}

async function fetchTrackedUrls(categories) {
  const supabase = getSupabase();
  let query = supabase.from('seo_tracked_urls').select('url, category');
  if (categories) {
    query = query.in('category', categories);
  }
  const { data, error } = await query;
  if (error) throw new Error(`fetchTrackedUrls: ${error.message}`);
  return data || [];
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchOverview(ranges) {
  const supabase = getSupabase();
  const { current, compare } = ranges;

  // GSC summary
  const [gscCurrent, gscCompare] = await Promise.all([
    supabase.from('gsc_daily_summary').select('*').gte('date', current.start).lte('date', current.end),
    supabase.from('gsc_daily_summary').select('*').gte('date', compare.start).lte('date', compare.end),
  ]);

  const sumGsc = (rows) => {
    if (!rows || !rows.length) return { clicks: 0, impressions: 0, ctr: 0, position: 0, days: 0 };
    const total = rows.reduce((acc, r) => {
      acc.clicks += r.clicks || 0;
      acc.impressions += r.impressions || 0;
      acc.ctrSum += r.ctr || 0;
      acc.positionSum += r.position || 0;
      acc.count++;
      return acc;
    }, { clicks: 0, impressions: 0, ctrSum: 0, positionSum: 0, count: 0 });
    return {
      clicks: total.clicks,
      impressions: total.impressions,
      ctr: total.count ? Math.round((total.ctrSum / total.count) * 100) / 100 : 0,
      position: total.count ? Math.round((total.positionSum / total.count) * 10) / 10 : 0,
      days: total.count,
    };
  };

  const gscNow = sumGsc(gscCurrent.data);
  const gscPrev = sumGsc(gscCompare.data);

  // GA4 organic sessions
  const [ga4Current, ga4Compare] = await Promise.all([
    supabase.from('ga4_daily').select('*').gte('date', current.start).lte('date', current.end),
    supabase.from('ga4_daily').select('*').gte('date', compare.start).lte('date', compare.end),
  ]);

  const sumGa4 = (rows) => {
    if (!rows || !rows.length) return { sessions: 0, users: 0, engagementRate: 0, bounceRate: 0, days: 0 };
    const total = rows.reduce((acc, r) => {
      acc.sessions += r.sessions || 0;
      acc.users += r.users || 0;
      acc.engagementRateSum += r.engagement_rate || 0;
      acc.bounceRateSum += r.bounce_rate || 0;
      acc.count++;
      return acc;
    }, { sessions: 0, users: 0, engagementRateSum: 0, bounceRateSum: 0, count: 0 });
    return {
      sessions: total.sessions,
      users: total.users,
      engagementRate: total.count ? Math.round((total.engagementRateSum / total.count) * 100) / 100 : 0,
      bounceRate: total.count ? Math.round((total.bounceRateSum / total.count) * 100) / 100 : 0,
      days: total.count,
    };
  };

  const ga4Now = sumGa4(ga4Current.data);
  const ga4Prev = sumGa4(ga4Compare.data);

  // Shopify organic revenue
  const [shopCurrent, shopCompare] = await Promise.all([
    supabase.from('shopify_daily_channels').select('*').eq('channel', 'Search').gte('date', current.start).lte('date', current.end),
    supabase.from('shopify_daily_channels').select('*').eq('channel', 'Search').gte('date', compare.start).lte('date', compare.end),
  ]);

  const sumShop = (rows) => {
    if (!rows || !rows.length) return { sessions: 0, orders: 0, revenue: 0, conversionRate: 0, days: 0 };
    const total = rows.reduce((acc, r) => {
      acc.sessions += r.sessions || 0;
      acc.orders += r.orders || 0;
      acc.revenue += parseFloat(r.revenue) || 0;
      acc.conversionRateSum += parseFloat(r.conversion_rate) || 0;
      acc.count++;
      return acc;
    }, { sessions: 0, orders: 0, revenue: 0, conversionRateSum: 0, count: 0 });
    return {
      sessions: total.sessions,
      orders: total.orders,
      revenue: total.revenue,
      conversionRate: total.count ? Math.round((total.conversionRateSum / total.count) * 100) / 100 : 0,
      days: total.count,
    };
  };

  const shopNow = sumShop(shopCurrent.data);
  const shopPrev = sumShop(shopCompare.data);

  return {
    gsc: { current: gscNow, compare: gscPrev },
    ga4: { current: ga4Now, compare: ga4Prev },
    shopify: { current: shopNow, compare: shopPrev },
  };
}

async function fetchKeywords(ranges, keywordType = 'all', limit = 10) {
  const supabase = getSupabase();
  const { current, compare } = ranges;

  // Paginated: keyword × day rows exceed Supabase's 1000-row cap on longer windows.
  const buildKwQuery = (range) => () => {
    let q = supabase.from('gsc_keywords').select('*')
      .gte('date', range.start).lte('date', range.end)
      .order('date').order('keyword');
    if (keywordType !== 'all') q = q.eq('keyword_type', keywordType);
    return q;
  };

  const [kwCurrentData, kwCompareData] = await Promise.all([
    fetchAllPaginated(buildKwQuery(current)),
    fetchAllPaginated(buildKwQuery(compare)),
  ]);

  const aggregate = (rows) => {
    const agg = {};
    for (const r of rows || []) {
      if (!agg[r.keyword]) {
        agg[r.keyword] = { keyword: r.keyword, type: r.keyword_type, clicks: 0, impressions: 0, positionSum: 0, ctrSum: 0, count: 0 };
      }
      const a = agg[r.keyword];
      a.clicks += r.clicks || 0;
      a.impressions += r.impressions || 0;
      a.positionSum += r.position || 0;
      a.ctrSum += r.ctr || 0;
      a.count++;
    }
    return Object.values(agg).map(a => ({
      keyword: a.keyword,
      type: a.type,
      clicks: a.clicks,
      impressions: a.impressions,
      position: a.count ? Math.round((a.positionSum / a.count) * 10) / 10 : 0,
      ctr: a.count ? Math.round((a.ctrSum / a.count) * 100) / 100 : 0,
    }));
  };

  const nowAgg = aggregate(kwCurrentData);
  const prevAgg = aggregate(kwCompareData);
  const prevMap = new Map(prevAgg.map(k => [k.keyword, k]));

  const withChange = nowAgg.map(k => {
    const prev = prevMap.get(k.keyword);
    return {
      ...k,
      clicksChange: prev ? k.clicks - prev.clicks : k.clicks,
      clicksPct: prev ? pctChange(k.clicks, prev.clicks) : 100,
      positionChange: prev ? k.position - prev.position : 0,
      prevClicks: prev ? prev.clicks : 0,
      prevPosition: prev ? prev.position : 0,
      isNew: !prev,
    };
  });

  // Check for keywords that dropped off (were in compare but not in current)
  const nowSet = new Set(nowAgg.map(k => k.keyword));
  const dropped = prevAgg.filter(k => !nowSet.has(k.keyword)).map(k => ({
    ...k,
    clicksChange: -k.clicks,
    clicksPct: -100,
    positionChange: 0,
    prevClicks: k.clicks,
    prevPosition: k.position,
    isDropped: true,
  }));

  const gainers = [...withChange].sort((a, b) => b.clicksChange - a.clicksChange).slice(0, limit);
  const losers = [...withChange, ...dropped].sort((a, b) => a.clicksChange - b.clicksChange).slice(0, limit);

  return { gainers, losers, totalCurrent: nowAgg.length, totalCompare: prevAgg.length, dropped: dropped.length };
}

async function fetchPages(ranges, limit = 10) {
  const supabase = getSupabase();
  const { current, compare } = ranges;

  // Paginated: gsc_pages holds one row per (date, page_url) and a 30-day
  // window routinely exceeds Supabase's 1000-row cap.
  const buildPagesQuery = (range) => () => supabase.from('gsc_pages').select('*')
    .gte('date', range.start).lte('date', range.end)
    .order('date').order('page_url');

  const [pagesCurrentData, pagesCompareData, trackedUrls] = await Promise.all([
    fetchAllPaginated(buildPagesQuery(current)),
    fetchAllPaginated(buildPagesQuery(compare)),
    fetchTrackedUrls(['priority_product', 'priority_page']),
  ]);

  const prioritySet = new Set(trackedUrls.map(r => r.url));

  const aggregate = (rows) => {
    const agg = {};
    for (const r of rows || []) {
      const url = shortenUrl(r.page_url);
      if (!agg[url]) {
        agg[url] = { url, clicks: 0, impressions: 0, positionSum: 0, ctrSum: 0, count: 0 };
      }
      const a = agg[url];
      a.clicks += r.clicks || 0;
      a.impressions += r.impressions || 0;
      a.positionSum += r.position || 0;
      a.ctrSum += r.ctr || 0;
      a.count++;
    }
    return Object.values(agg).map(a => ({
      url: a.url,
      clicks: a.clicks,
      impressions: a.impressions,
      position: a.count ? Math.round((a.positionSum / a.count) * 10) / 10 : 0,
      ctr: a.count ? Math.round((a.ctrSum / a.count) * 100) / 100 : 0,
      isPriority: prioritySet.has(a.url),
    }));
  };

  const nowAgg = aggregate(pagesCurrentData);
  const prevAgg = aggregate(pagesCompareData);
  const prevMap = new Map(prevAgg.map(p => [p.url, p]));

  const withChange = nowAgg.map(p => {
    const prev = prevMap.get(p.url);
    return {
      ...p,
      clicksChange: prev ? p.clicks - prev.clicks : p.clicks,
      clicksPct: prev ? pctChange(p.clicks, prev.clicks) : 100,
      positionChange: prev ? p.position - prev.position : 0,
      prevClicks: prev ? prev.clicks : 0,
      isNew: !prev,
    };
  });

  const gainers = [...withChange].sort((a, b) => b.clicksChange - a.clicksChange).slice(0, limit);
  const losers = [...withChange].sort((a, b) => a.clicksChange - b.clicksChange).slice(0, limit);

  return { gainers, losers, prioritySet };
}

async function fetchChannels(ranges) {
  const supabase = getSupabase();
  const { current, compare } = ranges;

  const [chanCurrent, chanCompare] = await Promise.all([
    supabase.from('shopify_daily_channels').select('*').gte('date', current.start).lte('date', current.end),
    supabase.from('shopify_daily_channels').select('*').gte('date', compare.start).lte('date', compare.end),
  ]);

  const aggregate = (rows) => {
    const agg = {};
    for (const r of rows || []) {
      if (!agg[r.channel]) {
        agg[r.channel] = { channel: r.channel, sessions: 0, orders: 0, revenue: 0, conversionRateSum: 0, count: 0 };
      }
      const a = agg[r.channel];
      a.sessions += r.sessions || 0;
      a.orders += r.orders || 0;
      a.revenue += parseFloat(r.revenue) || 0;
      a.conversionRateSum += parseFloat(r.conversion_rate) || 0;
      a.count++;
    }
    return Object.values(agg).map(a => ({
      channel: a.channel,
      sessions: a.sessions,
      orders: a.orders,
      revenue: a.revenue,
      conversionRate: a.count ? Math.round((a.conversionRateSum / a.count) * 100) / 100 : 0,
    }));
  };

  const nowAgg = aggregate(chanCurrent.data);
  const prevAgg = aggregate(chanCompare.data);
  const prevMap = new Map(prevAgg.map(c => [c.channel, c]));

  const withChange = nowAgg.map(c => {
    const prev = prevMap.get(c.channel);
    return {
      ...c,
      sessionsChange: prev ? pctChange(c.sessions, prev.sessions) : 100,
      ordersChange: prev ? pctChange(c.orders, prev.orders) : 100,
      revenueChange: prev ? pctChange(c.revenue, prev.revenue) : 100,
      prevSessions: prev ? prev.sessions : 0,
      prevOrders: prev ? prev.orders : 0,
      prevRevenue: prev ? prev.revenue : 0,
    };
  }).sort((a, b) => b.revenue - a.revenue);

  return withChange;
}

async function fetchGeography(ranges, limit = 10) {
  const supabase = getSupabase();
  const { current, compare } = ranges;

  const [geoCurrent, geoCompare] = await Promise.all([
    supabase.from('shopify_geography').select('*').gte('date', current.start).lte('date', current.end),
    supabase.from('shopify_geography').select('*').gte('date', compare.start).lte('date', compare.end),
  ]);

  const aggregate = (rows) => {
    const agg = {};
    for (const r of rows || []) {
      if (!agg[r.country]) {
        agg[r.country] = { country: r.country, sessions: 0, orders: 0, revenue: 0, count: 0 };
      }
      const a = agg[r.country];
      a.sessions += r.sessions || 0;
      a.orders += r.orders || 0;
      a.revenue += parseFloat(r.revenue) || 0;
      a.count++;
    }
    return Object.values(agg).map(a => ({
      country: a.country,
      sessions: a.sessions,
      orders: a.orders,
      revenue: a.revenue,
    }));
  };

  const nowAgg = aggregate(geoCurrent.data);
  const prevAgg = aggregate(geoCompare.data);
  const prevMap = new Map(prevAgg.map(g => [g.country, g]));

  const withChange = nowAgg.map(g => {
    const prev = prevMap.get(g.country);
    return {
      ...g,
      revenueChange: prev ? pctChange(g.revenue, prev.revenue) : 100,
      prevRevenue: prev ? prev.revenue : 0,
    };
  }).sort((a, b) => b.revenue - a.revenue).slice(0, limit);

  return withChange;
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

function detectAnomalies(overviewData, keywordData, pageData) {
  const config = loadConfig();
  const thresholds = config.alert_thresholds || {};
  const anomalies = [];

  // GSC anomalies
  const gsc = overviewData.gsc;
  const clicksPct = pctChange(gsc.current.clicks, gsc.compare.clicks);
  if (Math.abs(clicksPct) > (thresholds.clicks_change_percent || 20)) {
    anomalies.push({
      severity: clicksPct > 0 ? 'positive' : 'negative',
      message: `Organic clicks ${clicksPct > 0 ? 'up' : 'down'} ${Math.abs(clicksPct).toFixed(1)}% (${fmtNum(gsc.compare.clicks)} -> ${fmtNum(gsc.current.clicks)})`,
    });
  }

  const ctrPct = pctChange(gsc.current.ctr, gsc.compare.ctr);
  if (Math.abs(ctrPct) > (thresholds.ctr_change_percent || 20)) {
    anomalies.push({
      severity: ctrPct > 0 ? 'positive' : 'negative',
      message: `Average CTR ${ctrPct > 0 ? 'up' : 'down'} ${Math.abs(ctrPct).toFixed(1)}% (${gsc.compare.ctr}% -> ${gsc.current.ctr}%)`,
    });
  }

  const posChange = gsc.current.position - gsc.compare.position;
  if (Math.abs(posChange) > (thresholds.keyword_position_change || 3)) {
    anomalies.push({
      severity: posChange < 0 ? 'positive' : 'negative',
      message: `Average position ${posChange < 0 ? 'improved' : 'worsened'} by ${Math.abs(posChange).toFixed(1)} spots (${gsc.compare.position} -> ${gsc.current.position})`,
    });
  }

  // Revenue shift
  const shop = overviewData.shopify;
  const revPct = pctChange(shop.current.revenue, shop.compare.revenue);
  if (Math.abs(revPct) > 15) {
    anomalies.push({
      severity: revPct > 0 ? 'positive' : 'negative',
      message: `Organic revenue ${revPct > 0 ? 'up' : 'down'} ${Math.abs(revPct).toFixed(1)}% (${fmtCurrency(shop.compare.revenue)} -> ${fmtCurrency(shop.current.revenue)})`,
    });
  }

  // New keywords appearing
  if (keywordData) {
    const newKws = keywordData.gainers.filter(k => k.isNew);
    if (newKws.length > 0) {
      anomalies.push({
        severity: 'positive',
        message: `${newKws.length} new keyword${newKws.length > 1 ? 's' : ''} ranking: ${newKws.slice(0, 3).map(k => k.keyword).join(', ')}`,
      });
    }
    if (keywordData.dropped > 0) {
      anomalies.push({
        severity: 'negative',
        message: `${keywordData.dropped} keyword${keywordData.dropped > 1 ? 's' : ''} dropped out of rankings`,
      });
    }
  }

  // Sort: negative first (needs attention), then positive
  anomalies.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === 'negative' ? -1 : 1;
  });

  return anomalies;
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

async function generateRecommendations(overviewData, keywordData, pageData) {
  const items = await fetchStrategyItems();
  const tasks = items.filter(i => i.type === 'task');
  const blogPosts = items.filter(i => i.type === 'blog_post');

  // 1. What's working
  const working = [];
  const gsc = overviewData.gsc;
  if (gsc.current.clicks > gsc.compare.clicks) {
    working.push(`Organic clicks up ${pctChange(gsc.current.clicks, gsc.compare.clicks).toFixed(1)}%`);
  }
  if (gsc.current.position < gsc.compare.position) {
    working.push(`Average position improved from ${gsc.compare.position} to ${gsc.current.position}`);
  }
  if (gsc.current.ctr > gsc.compare.ctr) {
    working.push(`CTR improved from ${gsc.compare.ctr}% to ${gsc.current.ctr}%`);
  }
  const shop = overviewData.shopify;
  if (shop.current.revenue > shop.compare.revenue) {
    working.push(`Organic revenue up ${pctChange(shop.current.revenue, shop.compare.revenue).toFixed(1)}%`);
  }

  // 2. What needs attention
  const attention = [];
  if (gsc.current.position > gsc.compare.position) {
    attention.push('Average ranking position has worsened — review recent content changes');
  }
  if (gsc.current.ctr < gsc.compare.ctr && gsc.current.ctr < 3) {
    attention.push('CTR remains low — consider improving meta descriptions for key pages');
  }
  if (keywordData) {
    const bigLosers = keywordData.losers.filter(k => k.clicksChange < -5);
    if (bigLosers.length > 0) {
      attention.push(`${bigLosers.length} keywords losing significant clicks: ${bigLosers.slice(0, 3).map(k => k.keyword).join(', ')}`);
    }
  }
  if (pageData) {
    const priorityLosers = pageData.losers.filter(p => p.isPriority && p.clicksChange < 0);
    if (priorityLosers.length > 0) {
      attention.push(`Priority pages losing traffic: ${priorityLosers.slice(0, 3).map(p => p.url).join(', ')}`);
    }
  }

  // 3. Roadmap status
  const roadmap = tasks.map(t => ({
    id: t.id,
    name: t.name,
    status: t.status,
    completedDate: t.completed_date,
    notes: t.notes,
  }));

  const currentTask = roadmap.find(t => t.status === 'in_progress');
  const nextTask = roadmap.find(t => t.status === 'not_started');

  // 4. Next actions
  const nextActions = [];
  if (currentTask) {
    nextActions.push(`Continue: ${currentTask.name}${currentTask.notes ? ` (${currentTask.notes})` : ''}`);
  }
  if (nextTask && !currentTask) {
    nextActions.push(`Start next task: ${nextTask.name}`);
  }

  // Blog-specific recommendations based on keyword data
  const notStartedBlogs = blogPosts.filter(b => b.status === 'not_started');
  if (notStartedBlogs.length > 0 && keywordData) {
    const kwMap = new Map(keywordData.gainers.concat(keywordData.losers).map(k => [k.keyword, k]));
    const scored = notStartedBlogs.map(blog => {
      const totalImpressions = (blog.target_keywords || []).reduce((sum, kw) => {
        const match = kwMap.get(kw);
        return sum + (match ? match.impressions : 0);
      }, 0);
      return { id: blog.id, name: blog.name, keywords: blog.target_keywords, totalImpressions };
    }).sort((a, b) => b.totalImpressions - a.totalImpressions);

    if (scored.length > 0 && scored[0].totalImpressions > 0) {
      nextActions.push(`Prioritize blog post "${scored[0].name}" — its target keywords have ${fmtNum(scored[0].totalImpressions)} impressions`);
    }
  }

  // 5. Stale progress reminder — use most recent updated_at from any strategy item
  const lastUpdated = items.reduce((latest, i) => {
    const d = i.updated_at ? new Date(i.updated_at) : null;
    return d && (!latest || d > latest) ? d : latest;
  }, null);

  if (lastUpdated) {
    const daysSinceUpdate = Math.floor((new Date() - lastUpdated) / (1000 * 60 * 60 * 24));
    if (daysSinceUpdate > 14) {
      nextActions.push(`Strategy progress hasn't been updated in ${daysSinceUpdate} days — consider updating status`);
    }
  }

  // In-progress tasks for a long time
  if (currentTask && lastUpdated) {
    const inProgressTasks = roadmap.filter(t => t.status === 'in_progress');
    const days = Math.floor((new Date() - lastUpdated) / (1000 * 60 * 60 * 24));
    for (const t of inProgressTasks) {
      if (days > 21) {
        nextActions.push(`"${t.name}" has been in progress for a while — is it still active?`);
      }
    }
  }

  return {
    working,
    attention,
    roadmap,
    nextActions,
    blogPosts: blogPosts.map(b => ({
      id: b.id,
      status: b.status,
      target_keywords: b.target_keywords,
      published_url: b.published_url,
      published_date: b.published_date,
    })),
  };
}

// ---------------------------------------------------------------------------
// Strategy progress update
// ---------------------------------------------------------------------------

async function updateStrategyProgress(task, status, notes) {
  const supabase = getSupabase();

  // Fetch the item to verify it exists
  const { data: existing, error: fetchErr } = await supabase
    .from('seo_strategy_items')
    .select('*')
    .eq('id', task)
    .single();

  if (fetchErr || !existing) {
    // List valid items for error message
    const { data: all } = await supabase
      .from('seo_strategy_items')
      .select('id')
      .order('sort_order');
    const validIds = (all || []).map(r => r.id).join(', ');
    throw new Error(`Unknown task: ${task}. Valid items: ${validIds}`);
  }

  const updates = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (notes) updates.notes = notes;
  if (status === 'completed') updates.completed_date = formatDate(new Date());

  const { error: updateErr } = await supabase
    .from('seo_strategy_items')
    .update(updates)
    .eq('id', task);

  if (updateErr) throw new Error(`Update failed: ${updateErr.message}`);

  // Find next recommended item of the same type
  const { data: remaining } = await supabase
    .from('seo_strategy_items')
    .select('id, name, type')
    .eq('type', existing.type)
    .eq('status', 'not_started')
    .neq('id', task)
    .order('sort_order')
    .limit(1);

  const next = remaining?.[0];
  const label = existing.type === 'blog_post' ? 'blog post' : 'task';
  const nextRec = next
    ? `Next ${label}: ${next.name} (${next.id})`
    : `All ${label}s completed or in progress!`;

  return {
    updated: task,
    name: existing.name,
    status,
    nextRecommendation: nextRec,
  };
}

module.exports = {
  // Helpers
  pctChange,
  fmtNum,
  fmtPct,
  fmtCurrency,
  shortenUrl,
  arrow,
  formatDate,
  addDays,
  loadConfig,

  // Supabase state
  fetchStrategyItems,
  fetchTrackedUrls,

  // Core
  computeDateRanges,
  fetchOverview,
  fetchKeywords,
  fetchPages,
  fetchChannels,
  fetchGeography,
  detectAnomalies,
  generateRecommendations,
  updateStrategyProgress,
};
