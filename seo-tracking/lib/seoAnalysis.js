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

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
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
    // Compare current period to all data before the baseline date
    // Use the same number of days so metrics are comparable
    compareEnd = addDays(baseline, -1);
    compareStart = addDays(compareEnd, -(periodDays - 1));
  } else {
    // previous_period: the N days right before the current period
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

  let currentQuery = supabase.from('gsc_keywords').select('*').gte('date', current.start).lte('date', current.end);
  let compareQuery = supabase.from('gsc_keywords').select('*').gte('date', compare.start).lte('date', compare.end);

  if (keywordType !== 'all') {
    currentQuery = currentQuery.eq('keyword_type', keywordType);
    compareQuery = compareQuery.eq('keyword_type', keywordType);
  }

  const [kwCurrent, kwCompare] = await Promise.all([currentQuery, compareQuery]);

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

  const nowAgg = aggregate(kwCurrent.data);
  const prevAgg = aggregate(kwCompare.data);
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
  const config = loadConfig();
  const { current, compare } = ranges;

  const [pagesCurrent, pagesCompare] = await Promise.all([
    supabase.from('gsc_pages').select('*').gte('date', current.start).lte('date', current.end),
    supabase.from('gsc_pages').select('*').gte('date', compare.start).lte('date', compare.end),
  ]);

  const prioritySet = new Set([
    ...(config.priority_product_urls || []),
    ...(config.priority_page_urls || []),
  ]);

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

  const nowAgg = aggregate(pagesCurrent.data);
  const prevAgg = aggregate(pagesCompare.data);
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
      severity: posChange < 0 ? 'positive' : 'negative', // lower position = better
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

function generateRecommendations(overviewData, keywordData, pageData) {
  const config = loadConfig();
  const progress = config.strategy_progress || {};
  const tasks = progress.tasks || {};
  const blogPosts = progress.blog_posts || {};
  const recommendations = [];

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
  const roadmap = Object.entries(tasks).map(([id, t]) => ({
    id,
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
  const blogEntries = Object.entries(blogPosts);
  const notStartedBlogs = blogEntries.filter(([, b]) => b.status === 'not_started');
  if (notStartedBlogs.length > 0 && keywordData) {
    // Rank blog posts by how their target keywords are performing
    const kwMap = new Map(keywordData.gainers.concat(keywordData.losers).map(k => [k.keyword, k]));
    const scored = notStartedBlogs.map(([id, blog]) => {
      const totalImpressions = (blog.target_keywords || []).reduce((sum, kw) => {
        const match = kwMap.get(kw);
        return sum + (match ? match.impressions : 0);
      }, 0);
      return { id, name: id.replace(/_/g, ' '), keywords: blog.target_keywords, totalImpressions };
    }).sort((a, b) => b.totalImpressions - a.totalImpressions);

    if (scored.length > 0 && scored[0].totalImpressions > 0) {
      nextActions.push(`Prioritize blog post "${scored[0].name}" — its target keywords have ${fmtNum(scored[0].totalImpressions)} impressions`);
    }
  }

  // 5. Stale progress reminder
  const lastUpdated = progress.last_updated;
  if (lastUpdated) {
    const daysSinceUpdate = Math.floor((new Date() - new Date(lastUpdated)) / (1000 * 60 * 60 * 24));
    if (daysSinceUpdate > 14) {
      nextActions.push(`Strategy progress hasn't been updated in ${daysSinceUpdate} days — consider updating status`);
    }
  }

  // In-progress tasks for a long time
  if (currentTask) {
    const inProgressTasks = roadmap.filter(t => t.status === 'in_progress');
    for (const t of inProgressTasks) {
      // We don't have start dates for in_progress, but flag if last_updated is stale
      if (lastUpdated) {
        const days = Math.floor((new Date() - new Date(lastUpdated)) / (1000 * 60 * 60 * 24));
        if (days > 21) {
          nextActions.push(`"${t.name}" has been in progress for a while — is it still active?`);
        }
      }
    }
  }

  return { working, attention, roadmap, nextActions, blogPosts: Object.entries(blogPosts).map(([id, b]) => ({ id, ...b })) };
}

// ---------------------------------------------------------------------------
// Strategy progress update
// ---------------------------------------------------------------------------

function updateStrategyProgress(task, status, notes) {
  const config = loadConfig();
  if (!config.strategy_progress) {
    throw new Error('No strategy_progress section in config.json');
  }

  const tasks = config.strategy_progress.tasks || {};
  if (!tasks[task]) {
    // Check blog_posts too
    const blogs = config.strategy_progress.blog_posts || {};
    if (blogs[task]) {
      blogs[task].status = status;
      if (notes) blogs[task].notes = notes;
      config.strategy_progress.last_updated = formatDate(new Date());
      saveConfig(config);

      const allBlogs = Object.entries(blogs);
      const nextBlog = allBlogs.find(([id, b]) => b.status === 'not_started' && id !== task);
      return {
        updated: task,
        status,
        nextRecommendation: nextBlog ? `Next blog post: ${nextBlog[0].replace(/_/g, ' ')}` : 'All blog posts addressed!',
      };
    }
    throw new Error(`Unknown task: ${task}. Valid tasks: ${Object.keys(tasks).join(', ')}, ${Object.keys(blogs).join(', ')}`);
  }

  tasks[task].status = status;
  if (notes) tasks[task].notes = notes;
  if (status === 'completed') {
    tasks[task].completed_date = formatDate(new Date());
  }
  config.strategy_progress.last_updated = formatDate(new Date());
  saveConfig(config);

  // Find next recommended task
  const allTasks = Object.entries(tasks);
  const nextTask = allTasks.find(([id, t]) => t.status === 'not_started' && id !== task);

  return {
    updated: task,
    name: tasks[task].name,
    status,
    nextRecommendation: nextTask ? `Next task: ${nextTask[1].name} (${nextTask[0]})` : 'All strategy tasks completed or in progress!',
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
