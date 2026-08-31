/**
 * Klaviyo API Client — singleton pattern (like sendgridClient.js)
 *
 * Uses Node built-in fetch. Returns null if no API key configured.
 */

require('dotenv').config();

const BASE_URL = 'https://a.klaviyo.com';
const REVISION = '2024-10-15';
const MAX_PAGES = 10;

let client = null;
let metricCache = null; // name → id map, lazy-loaded

function getKlaviyoClient() {
  if (client) return client;

  const apiKey = process.env.KLAVIYO_API_KEY;
  if (!apiKey) return null;

  const headers = {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: REVISION,
    accept: 'application/json',
    'content-type': 'application/json',
  };

  // ── helpers ──────────────────────────────────────────────────────────

  async function apiFetch(path, options = {}) {
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Klaviyo ${res.status}: ${body.slice(0, 300)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async function fetchAll(path, maxPages = MAX_PAGES) {
    const results = [];
    let url = path;
    let pages = 0;
    while (url && pages < maxPages) {
      const data = await apiFetch(url);
      if (data.data) results.push(...data.data);
      url = data.links?.next || null;
      pages++;
    }
    return results;
  }

  // Reporting endpoints throttle hard (~1/s). Retry on 429, honoring the
  // "Expected available in N seconds" hint, with exponential fallback.
  // ONE implementation — this loop was copy-pasted in three call sites and
  // had already diverged on backoff caps and error swallowing.
  async function fetchWithRetry(path, options = {}, { maxAttempts = 6, maxBackoffMs = 30000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await apiFetch(path, options);
      } catch (err) {
        const is429 = /Klaviyo 429/.test(err.message);
        if (!is429 || attempt >= maxAttempts) throw err;
        const hint = /available in (\d+) second/.exec(err.message);
        const waitMs = hint ? (Number(hint[1]) + 1) * 1000 : Math.min(2 ** attempt * 1000, maxBackoffMs);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  // ── metric ID cache ──────────────────────────────────────────────────

  async function getMetricIdMap() {
    if (metricCache) return metricCache;
    const metrics = await fetchAll('/api/metrics');
    metricCache = {};
    for (const m of metrics) {
      metricCache[m.attributes.name] = m.id;
    }
    return metricCache;
  }

  // ── campaigns ────────────────────────────────────────────────────────

  // Fetch sent email campaigns ordered by recency.
  // Provide `updatedSince` (ISO date) to stop pagination at a cutoff — best for daily syncs.
  // Provide `limit` to cap the absolute number returned (used by callers wanting a small recent window).
  async function getCampaigns({ status = 'sent', limit = null, updatedSince = null, maxPages = 50 } = {}) {
    const filter = `equals(messages.channel,'email')`;
    let url = `/api/campaigns?filter=${encodeURIComponent(filter)}&sort=-updated_at&include=campaign-messages`;
    const campaigns = [];
    let pages = 0;
    let stopped = false;

    while (url && pages < maxPages && !stopped) {
      const data = await apiFetch(url);
      const pageCampaigns = data.data || [];
      const included = data.included || [];
      for (const c of pageCampaigns) {
        const msgRel = c.relationships?.['campaign-messages']?.data?.[0];
        if (msgRel) {
          const msg = included.find(m => m.id === msgRel.id);
          if (msg) c._message = msg;
        }
        // Stop if we've crossed the updatedSince cutoff (campaigns are sorted by -updated_at).
        if (updatedSince) {
          const upd = c.attributes?.updated_at || c.attributes?.send_time || c.attributes?.created_at;
          if (upd && upd < updatedSince) { stopped = true; break; }
        }
        // Apply the documented status filter — it was accepted but never
        // applied, so drafts/scheduled campaigns leaked into "sent" syncs.
        // Case-insensitive (Klaviyo reports 'Sent'/'Draft'/'Scheduled');
        // pass status: null to fetch all statuses.
        if (status && String(c.attributes?.status || '').toLowerCase() !== String(status).toLowerCase()) continue;
        campaigns.push(c);
        if (limit && campaigns.length >= limit) { stopped = true; break; }
      }
      url = data.links?.next || null;
      pages++;
    }

    return limit ? campaigns.slice(0, limit) : campaigns;
  }

  async function getCampaignMessage(campaignId) {
    // Get campaign with messages included
    const campaign = await apiFetch(`/api/campaigns/${campaignId}?include=campaign-messages`);
    const included = campaign.included || [];
    const messageData = included.find(i => i.type === 'campaign-message');
    if (!messageData) return null;

    // Get the message with template included (template has the HTML body)
    const msgFull = await apiFetch(`/api/campaign-messages/${messageData.id}?include=template`);
    const template = (msgFull.included || []).find(i => i.type === 'template');

    // Merge: subject/preview from message content, html from template
    const result = msgFull.data;
    if (template) {
      result._templateHtml = template.attributes.html || '';
      result._templateText = template.attributes.text || '';
    }
    return result;
  }

  // ── flows ────────────────────────────────────────────────────────────

  async function getFlows() {
    const data = await apiFetch('/api/flows?sort=name');
    return data.data || [];
  }

  async function getFlowMessages(flowId) {
    const data = await apiFetch(`/api/flows/${flowId}/flow-actions`);
    return data.data || [];
  }

  // Flow performance for a custom window, aggregated to flow level.
  // Klaviyo returns one row per flow-message; we sum across messages per flow
  // and recompute rates so the result matches the flow-level view in Klaviyo.
  // `start`/`end` are ISO date strings (end is exclusive at midnight).
  async function getFlowValuesReport({ start, end, channel = 'email', conversionMetricId } = {}) {
    const body = {
      data: {
        type: 'flow-values-report',
        attributes: {
          timeframe: { start: `${start}T00:00:00`, end: `${end}T00:00:00` },
          conversion_metric_id: conversionMetricId,
          filter: `equals(send_channel,'${channel}')`,
          statistics: [
            'recipients', 'delivered', 'opens', 'clicks',
            'open_rate', 'click_rate', 'conversions', 'conversion_value',
            'conversion_rate', 'unsubscribe_rate',
          ],
        },
      },
    };
    const data = await fetchWithRetry('/api/flow-values-reports', {
      method: 'POST', body: JSON.stringify(body),
    });
    const results = data.data?.attributes?.results || [];

    // Aggregate flow-message rows into flow-level totals.
    const byFlow = {};
    for (const r of results) {
      const id = r.groupings?.flow_id;
      if (!id) continue;
      const s = r.statistics || {};
      const f = (byFlow[id] ||= {
        flow_id: id, channel,
        recipients: 0, delivered: 0, opens: 0, clicks: 0,
        conversions: 0, conversion_value: 0, unsubscribes: 0,
      });
      f.recipients += s.recipients || 0;
      f.delivered += s.delivered || 0;
      f.opens += s.opens || 0;
      f.clicks += s.clicks || 0;
      f.conversions += s.conversions || 0;
      f.conversion_value += s.conversion_value || 0;
      // unsubscribe_rate is per-message; reconstruct a count to re-derive a flow rate.
      f.unsubscribes += (s.unsubscribe_rate || 0) * (s.recipients || 0);
    }
    return Object.values(byFlow).map((f) => ({
      ...f,
      conversion_value: Math.round(f.conversion_value * 100) / 100,
      open_rate: f.delivered ? f.opens / f.delivered : 0,
      click_rate: f.delivered ? f.clicks / f.delivered : 0,
      conversion_rate: f.recipients ? f.conversions / f.recipients : 0,
      unsubscribe_rate: f.recipients ? f.unsubscribes / f.recipients : 0,
    }));
  }

  // ── lists & segments ─────────────────────────────────────────────────

  async function getLists() {
    return fetchAll('/api/lists');
  }

  // Current profile count for a list (the live subscriber total). Retries on
  // 429; fail-soft to null (deliberately — list size is a nice-to-have on the
  // daily snapshot, not worth failing the sync over).
  async function getListSize(listId) {
    try {
      const d = await fetchWithRetry(`/api/lists/${listId}?additional-fields[list]=profile_count`, {}, { maxBackoffMs: 20000 });
      return d.data?.attributes?.profile_count ?? null;
    } catch (err) {
      console.warn(`[klaviyo] getListSize(${listId}) failed: ${err.message}`);
      return null;
    }
  }

  async function getSegments() {
    return fetchAll('/api/segments');
  }

  // ── metric aggregates ────────────────────────────────────────────────

  async function queryMetricAggregates({ metricId, startDate, endDate, measurements = ['count'] }) {
    const body = {
      data: {
        type: 'metric-aggregate',
        attributes: {
          metric_id: metricId,
          measurements,
          interval: 'day',
          page_size: 500,
          timezone: 'UTC',
          filter: [
            `greater-or-equal(datetime,${startDate}T00:00:00+00:00)`,
            `less-than(datetime,${endDate}T23:59:59+00:00)`,
          ],
        },
      },
    };
    const data = await apiFetch('/api/metric-aggregates', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    // Sum up daily counts into a single total
    const counts = data.data?.attributes?.data?.[0]?.measurements?.count || [];
    return counts.reduce((a, b) => a + b, 0);
  }

  // Counts for any metric over a window (subscribes, form views, etc).
  // Returns { 'YYYY-MM': count } for interval=month, { 'YYYY-MM-DD': count } for day.
  async function getMonthlyMetricCounts({ metricId, start, endExcl, measurement = 'count', interval = 'month' }) {
    const body = { data: { type: 'metric-aggregate', attributes: {
      metric_id: metricId, measurements: [measurement], interval,
      page_size: 500, timezone: 'UTC',
      filter: [`greater-or-equal(datetime,${start}T00:00:00+00:00)`, `less-than(datetime,${endExcl}T00:00:00+00:00)`],
    } } };
    const d = await fetchWithRetry('/api/metric-aggregates', { method: 'POST', body: JSON.stringify(body) });
    const dates = d.data?.attributes?.dates || [];
    const vals = d.data?.attributes?.data?.[0]?.measurements?.[measurement] || [];
    const out = {};
    const klen = interval === 'day' ? 10 : 7;
    for (let i = 0; i < dates.length; i++) out[dates[i].slice(0, klen)] = vals[i] || 0;
    return out;
  }

  // ── profiles ───────────────────────────────────────────────────────

  /**
   * Look up a Klaviyo profile by email address.
   * Returns the profile object or null if not found.
   */
  async function getProfileByEmail(email) {
    const filter = `equals(email,"${email.toLowerCase().trim()}")`;
    const data = await apiFetch(`/api/profiles?filter=${encodeURIComponent(filter)}&additional-fields[profile]=subscriptions,predictive_analytics`);
    return data.data?.[0] || null;
  }

  /**
   * Fetch all lists a profile belongs to.
   * @param {string} profileId — Klaviyo profile ID
   */
  async function getProfileLists(profileId) {
    const data = await apiFetch(`/api/profiles/${profileId}/lists`);
    return data.data || [];
  }

  /**
   * Fetch profiles in bulk with pagination.
   * Optional filter (e.g., by list membership, date, etc.)
   * Returns array of profile objects.
   */
  async function getProfiles({ filter, pageSize = 100, maxPages = 50 } = {}) {
    let url = `/api/profiles?page[size]=${pageSize}`;
    if (filter) url += `&filter=${encodeURIComponent(filter)}`;

    const results = [];
    let pages = 0;
    while (url && pages < maxPages) {
      const data = await apiFetch(url);
      if (data.data) results.push(...data.data);
      url = data.links?.next || null;
      pages++;
    }
    return results;
  }

  /**
   * Get subscription status for a profile across all lists (email + SMS).
   */
  async function getProfileSubscriptionData(email) {
    const profile = await getProfileByEmail(email);
    if (!profile) return null;

    const attrs = profile.attributes || {};
    const lists = await getProfileLists(profile.id);

    return {
      profileId: profile.id,
      phoneNumber: attrs.phone_number || null,
      emailSubscription: attrs.subscriptions?.email?.marketing?.consent || 'NEVER_SUBSCRIBED',
      smsSubscription: attrs.subscriptions?.sms?.marketing?.consent || 'NEVER_SUBSCRIBED',
      lists: lists.map(l => ({ id: l.id, name: l.attributes?.name })),
      lastOpen: attrs.predictive_analytics?.last_email_open || null,
      lastClick: attrs.predictive_analytics?.last_email_click || null,
    };
  }

  /**
   * Change a profile's email address in place. Returns { ok: true } on success.
   * If the new email already belongs to ANOTHER profile, Klaviyo rejects the
   * PATCH with a duplicate_profile error carrying the conflicting profile's id —
   * returned here as { ok: false, duplicate_profile_id } so the caller can
   * merge instead. Any other failure throws.
   */
  async function updateProfileEmail(profileId, email) {
    const body = {
      data: { type: 'profile', id: profileId, attributes: { email: email.toLowerCase().trim() } },
    };
    try {
      await apiFetch(`/api/profiles/${profileId}`, { method: 'PATCH', body: JSON.stringify(body) });
      return { ok: true };
    } catch (err) {
      const dup = /duplicate_profile/.test(err.message)
        && /"duplicate_profile_id"\s*:\s*"([^"]+)"/.exec(err.message);
      if (dup) return { ok: false, duplicate_profile_id: dup[1] };
      throw err;
    }
  }

  /**
   * Merge one profile into another. The SOURCE profile's data folds into the
   * DESTINATION and the source is deleted (async on Klaviyo's side). The
   * destination's identity (email) and subscription consent survive — merging
   * never grants consent the destination didn't already have.
   */
  async function mergeProfiles(destinationProfileId, sourceProfileId) {
    const body = {
      data: {
        type: 'profile-merge',
        id: destinationProfileId,
        relationships: {
          profiles: { data: [{ type: 'profile', id: sourceProfileId }] },
        },
      },
    };
    await apiFetch('/api/profile-merge', { method: 'POST', body: JSON.stringify(body) });
    return { ok: true, destinationProfileId };
  }

  /**
   * Subscribe or unsubscribe a profile from email/SMS marketing.
   *
   * action: 'subscribe' | 'unsubscribe'
   * channels: array containing 'email', 'sms', or both
   * listId: required for subscribe (auto-picked from 'Newsletter' list if omitted)
   * phoneNumber: required for SMS subscribe if profile has no stored number
   */
  async function updateSubscription(email, { action, channels = ['email'], listId, phoneNumber } = {}) {
    const isSubscribe = action === 'subscribe';
    const endpoint = isSubscribe
      ? '/api/profile-subscription-bulk-create-jobs'
      : '/api/profile-unsubscription-bulk-create-jobs';
    const jobType = isSubscribe
      ? 'profile-subscription-bulk-create-job'
      : 'profile-unsubscription-bulk-create-job';

    // For subscribe, resolve listId if not provided
    if (isSubscribe && !listId) {
      const lists = await getLists();
      if (!lists.length) throw new Error('No Klaviyo lists found. Provide a list_id.');
      const newsletter = lists.find(l => /newsletter/i.test(l.attributes?.name || ''));
      listId = newsletter ? newsletter.id : lists[0].id;
    }

    const subscriptions = {};
    if (channels.includes('email')) {
      subscriptions.email = { marketing: isSubscribe ? { consent: 'SUBSCRIBED' } : {} };
    }
    if (channels.includes('sms')) {
      subscriptions.sms = { marketing: isSubscribe ? { consent: 'SUBSCRIBED' } : {} };
    }

    const profileAttribs = { email, subscriptions };
    if (phoneNumber) profileAttribs.phone_number = phoneNumber;

    const body = {
      data: {
        type: jobType,
        attributes: {
          profiles: { data: [{ type: 'profile', attributes: profileAttribs }] },
        },
        // list_id goes under relationships per Klaviyo's JSON:API format
        ...(isSubscribe && listId ? {
          relationships: {
            list: { data: { type: 'list', id: listId } },
          },
        } : {}),
      },
    };

    await apiFetch(endpoint, { method: 'POST', body: JSON.stringify(body) });
    return { success: true, listId: listId || null };
  }

  // ── html stripping ───────────────────────────────────────────────────

  function stripHtml(html) {
    if (!html) return '';
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  client = {
    apiFetch,
    fetchAll,
    getMetricIdMap,
    getCampaigns,
    getCampaignMessage,
    getFlows,
    getFlowMessages,
    getFlowValuesReport,
    getMonthlyMetricCounts,
    getLists,
    getListSize,
    getSegments,
    queryMetricAggregates,
    getProfileByEmail,
    getProfileLists,
    getProfiles,
    getProfileSubscriptionData,
    updateProfileEmail,
    mergeProfiles,
    updateSubscription,
    stripHtml,
  };

  return client;
}

module.exports = { getKlaviyoClient };
