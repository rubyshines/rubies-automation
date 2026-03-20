/**
 * Klaviyo API Client — singleton pattern (like sendgridClient.js)
 *
 * Uses Node built-in fetch. Returns null if no API key configured.
 */

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
    return res.json();
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

  async function getCampaigns({ status = 'sent', limit = 20, maxPages = MAX_PAGES } = {}) {
    const filter = `equals(messages.channel,'email')`;
    let url = `/api/campaigns?filter=${encodeURIComponent(filter)}&sort=-updated_at&include=campaign-messages`;
    const campaigns = [];
    let pages = 0;

    while (url && pages < maxPages) {
      const data = await apiFetch(url);
      const pageCampaigns = data.data || [];
      // Attach message data (subject, preview) to each campaign
      const included = data.included || [];
      for (const c of pageCampaigns) {
        const msgRel = c.relationships?.['campaign-messages']?.data?.[0];
        if (msgRel) {
          const msg = included.find(m => m.id === msgRel.id);
          if (msg) c._message = msg;
        }
      }
      campaigns.push(...pageCampaigns);
      if (campaigns.length >= limit) break;
      url = data.links?.next || null;
      pages++;
    }

    return campaigns.slice(0, limit);
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

  // ── lists & segments ─────────────────────────────────────────────────

  async function getLists() {
    return fetchAll('/api/lists');
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

  // ── profiles ───────────────────────────────────────────────────────

  /**
   * Look up a Klaviyo profile by email address.
   * Returns the profile object or null if not found.
   */
  async function getProfileByEmail(email) {
    const filter = `equals(email,"${email.toLowerCase().trim()}")`;
    const data = await apiFetch(`/api/profiles?filter=${encodeURIComponent(filter)}`);
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
   * Get subscription status for a profile across all lists.
   * Returns { status, lists: [{ id, name }], lastOpen, lastClick }
   */
  async function getProfileSubscriptionData(email) {
    const profile = await getProfileByEmail(email);
    if (!profile) return null;

    const attrs = profile.attributes || {};
    const lists = await getProfileLists(profile.id);

    return {
      profileId: profile.id,
      subscriptionStatus: attrs.subscriptions?.email?.marketing?.consent || 'unknown',
      lists: lists.map(l => ({ id: l.id, name: l.attributes?.name })),
      lastOpen: attrs.predictive_analytics?.last_email_open || null,
      lastClick: attrs.predictive_analytics?.last_email_click || null,
      properties: attrs.properties || {},
    };
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
    getLists,
    getSegments,
    queryMetricAggregates,
    getProfileByEmail,
    getProfileLists,
    getProfiles,
    getProfileSubscriptionData,
    stripHtml,
  };

  return client;
}

module.exports = { getKlaviyoClient };
