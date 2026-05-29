/**
 * Email Classifier — 3-tier classification
 *
 * Tier 1: Domain/sender rules (zero tokens)
 * Tier 2: Domain cache from Supabase (amortized tokens)
 * Tier 3: Claude Sonnet batch on headers (only for unknowns)
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const Anthropic = require('@anthropic-ai/sdk');
const { callClaude } = require('../../shared/aiClient');
const { MODELS } = require('../../shared/aiPricing');
const { getSupabaseClient } = require('../../shared/supabaseClient');
const {
  OUR_ADDRESS,
  OUR_DOMAIN,
  SKIP_DOMAINS,
  KNOWN_DOMAINS,
  KNOWN_SENDERS,
  SKIP_SENDER_PATTERNS,
  CLASSIFICATION_LABELS,
} = require('../config');

const anthropic = new Anthropic();

// Personal email domains — don't cache classification by domain
// (each sender is a different person with a different context)
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'yahoo.ca', 'hotmail.com', 'outlook.com',
  'live.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'fastmail.com', 'tutanota.com',
  'mail.com', 'zoho.com', 'yandex.com',
]);

// In-memory B2B contact lookup (populated from Supabase on first use)
let b2bContactCache = null;

async function loadB2bContacts() {
  if (b2bContactCache) return b2bContactCache;
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('b2b_contacts')
    .select('email, company_id, is_active, b2b_companies(relationship_type)')
    .eq('is_active', true);
  if (error) throw error;
  b2bContactCache = new Map();
  for (const row of (data || [])) {
    const type = row.b2b_companies?.relationship_type;
    if (type) {
      b2bContactCache.set(row.email, type); // 'wholesale' or 'lgbtq_org'
    }
  }
  return b2bContactCache;
}

// Domain cache (Tier 2) removed — it freezes a one-time AI classification into
// a deterministic rule, which goes against AI-first principles. At ~$1.50/month
// for Sonnet calls, the cost savings aren't worth the misclassification risk.
// The email_classification_cache table still exists but is no longer read.

// ---------------------------------------------------------------------------
// Tier 1: Rule-based classification
// ---------------------------------------------------------------------------

function extractDomain(email) {
  if (!email) return '';
  const atIndex = email.lastIndexOf('@');
  return atIndex >= 0 ? email.substring(atIndex + 1).toLowerCase() : '';
}

function classifyTier1(fromAddress) {
  if (!fromAddress) return null;
  const email = fromAddress.toLowerCase().trim();

  // Known senders (before domain rules — more specific wins)
  if (KNOWN_SENDERS[email]) {
    return { classification: KNOWN_SENDERS[email], confidence: 1.0, tier: 1 };
  }

  // Skip patterns (noreply, mailer-daemon, etc.)
  for (const pattern of SKIP_SENDER_PATTERNS) {
    if (pattern.test(email)) return { classification: 'skip', confidence: 1.0, tier: 1 };
  }

  const domain = extractDomain(email);
  if (!domain) return null;

  // Our own domain — internal
  if (domain === OUR_DOMAIN) return { classification: 'internal', confidence: 0.9, tier: 1 };

  // Skip domains
  if (SKIP_DOMAINS.has(domain)) return { classification: 'skip', confidence: 1.0, tier: 1 };

  // Check parent domain (e.g., mail.google.com → google.com)
  const parts = domain.split('.');
  if (parts.length > 2) {
    const parent = parts.slice(-2).join('.');
    if (SKIP_DOMAINS.has(parent)) return { classification: 'skip', confidence: 1.0, tier: 1 };
  }

  // Known business domains
  if (KNOWN_DOMAINS[domain]) {
    return { classification: KNOWN_DOMAINS[domain], confidence: 0.95, tier: 1 };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tier 3: Claude Sonnet batch classification
// ---------------------------------------------------------------------------

async function classifyBatchTier3(messages) {
  if (!messages.length) return [];

  // Build the prompt with headers only
  const emailSummaries = messages.map((msg, i) => {
    const bodyPreview = (msg.body_text || '').substring(0, 200).replace(/\n/g, ' ');
    return `[${i}] From: ${msg.from_address} (${msg.from_name || 'unknown'})
  To: ${(msg.to_addresses || []).join(', ')}
  Subject: ${msg.subject || '(no subject)'}
  Date: ${msg.date}
  Preview: ${bodyPreview}`;
  }).join('\n\n');

  const validLabels = CLASSIFICATION_LABELS.concat(['spam']).join(', ');

  const PRIMARY_MODEL = MODELS.SONNET;
  const FALLBACK_MODEL = MODELS.HAIKU;

  let response;
  let modelUsed = PRIMARY_MODEL;
  try {
    response = await callClaude({
      component: 'gmail_email_classifier',
      metadata: { batch_size: messages.length, tier: 'primary' },
      model: PRIMARY_MODEL,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Classify each email into exactly ONE business area for a small gender-affirming underwear brand called RUBIES (rubyshines.com).

Categories:
- customer_support: End-customer (B2C consumer) emails about orders, sizing, returns, exchanges, product questions
- wholesale: B2B retailer/shop communications — sales outreach, reorders, wholesale account management
- lgbtq_org: LGBTQ+ community organizations — donation programs, partnership outreach, community centers, pride events, gender-affirming programs
- product_rd: Product design, fit testing, sampling, development with suppliers/designers
- production_orders: Active manufacturing orders, factory production, PO tracking
- email_marketing: Email campaigns, marketing strategy, Klaviyo, content planning — specifically OUR campaigns and our marketing team (e.g. Hope Team Marketing)
- 3pl_fulfillment: 3PL warehouse, logistics, shipping operations, inventory management
- finance_legal: Accounting, tax, banking, legal, corporate, trust matters
- internal: Team communications, internal operations
- newsletter: Recurring newsletters, digests, or updates we subscribed to — not direct communications. Fashion roundups, industry news, SaaS product updates, alumni newsletters. NOT spam (opted-in at some point). NOT email_marketing (that's OUR campaigns).
- auto_reply: Out-of-office replies, vacation auto-responders, automatic replies to OUR marketing emails. The sender is not writing to us — their email client is auto-responding. Look for "Automatic reply:", "Out of Office", "I am currently out", "I will be away".
- spam: Unsolicited sales pitches, cold outreach FROM other companies trying to sell TO us

IMPORTANT: LGBTQ+ organizations reaching out for the first time are NEVER spam, even if unsolicited. Classify as lgbtq_org. Signs: mentions LGBTQ+, pride, trans, gender-affirming, community program, non-profit, donation partnership, queer youth, community center. Compare to spam signs: mentions ROI, "scale your business", "boost sales", offers marketing/ad/SEO services, agency domain. Some spammers use trans/gender keywords as bait to sell ad services — that's still spam.

Return a JSON array with one object per email: [{"index": 0, "classification": "...", "confidence": 0.0-1.0}]
Only return the JSON array, nothing else.

Emails:
${emailSummaries}`,
    }],
  });
  } catch (err) {
    if (err.status === 529) {
      console.warn(`[classifier] Sonnet overloaded — falling back to Haiku for ${messages.length} emails`);
      modelUsed = FALLBACK_MODEL;
      response = await callClaude({
        component: 'gmail_email_classifier',
        metadata: { batch_size: messages.length, tier: 'fallback' },
        model: FALLBACK_MODEL,
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Classify each email into exactly ONE business area for a small gender-affirming underwear brand called RUBIES (rubyshines.com).

Categories:
- customer_support: End-customer (B2C consumer) emails about orders, sizing, returns, exchanges, product questions
- wholesale: B2B retailer/shop communications — sales outreach, reorders, wholesale account management
- lgbtq_org: LGBTQ+ community organizations — donation programs, partnership outreach, community centers, pride events, gender-affirming programs
- product_rd: Product design, fit testing, sampling, development with suppliers/designers
- production_orders: Active manufacturing orders, factory production, PO tracking
- email_marketing: Email campaigns, marketing strategy, Klaviyo, content planning — specifically OUR campaigns and our marketing team (e.g. Hope Team Marketing)
- 3pl_fulfillment: 3PL warehouse, logistics, shipping operations, inventory management
- finance_legal: Accounting, tax, banking, legal, corporate, trust matters
- internal: Team communications, internal operations
- newsletter: Recurring newsletters, digests, or updates we subscribed to — not direct communications
- auto_reply: Out-of-office replies, vacation auto-responders, automatic replies
- spam: Unsolicited sales pitches, cold outreach FROM other companies trying to sell TO us

IMPORTANT: LGBTQ+ organizations reaching out for the first time are NEVER spam, even if unsolicited. Classify as lgbtq_org.

Return a JSON array with one object per email: [{"index": 0, "classification": "...", "confidence": 0.0-1.0}]
Only return the JSON array, nothing else.

Emails:
${emailSummaries}`,
        }],
      });
    } else {
      throw err;
    }
  }

  try {
    const text = response.content[0].text.trim();
    // Extract JSON from potential markdown code blocks
    const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const results = JSON.parse(jsonStr);
    if (modelUsed === FALLBACK_MODEL) {
      console.warn(`[classifier] Haiku classified ${results.length} emails (Sonnet was unavailable)`);
    }
    return results;
  } catch (e) {
    console.error('Failed to parse classifier response:', e.message);
    console.error('Raw response:', response.content[0].text.substring(0, 500));
    return messages.map((_, i) => ({ index: i, classification: 'internal', confidence: 0.1 }));
  }
}

// ---------------------------------------------------------------------------
// Main classify function — runs all 3 tiers
// ---------------------------------------------------------------------------

/**
 * Classify an array of email messages.
 * Each message should have: { gmail_message_id, from_address, from_name, to_addresses, subject, date, body_text }
 *
 * Returns the same array with classification, classification_confidence, classified_at added.
 * Messages classified as 'skip' will have classification set to 'skip'.
 */
async function classifyMessages(messages) {
  const results = [];
  const needsTier3 = [];

  for (const msg of messages) {
    // Already classified? Skip.
    if (msg.classification) {
      results.push(msg);
      continue;
    }

    // Sent by us? Don't classify — we classify by the thread's primary classification
    if (msg.is_sent) {
      msg.classification = 'sent';
      msg.classification_confidence = 1.0;
      msg.classified_at = new Date().toISOString();
      results.push(msg);
      continue;
    }

    // Tier 1: Rule-based
    const t1 = classifyTier1(msg.from_address);
    if (t1) {
      msg.classification = t1.classification;
      msg.classification_confidence = t1.confidence;
      msg.classified_at = new Date().toISOString();
      results.push(msg);
      continue;
    }

    // Tier 1.5: B2B contact lookup (check if sender is a known wholesale/LGBTQ+ contact)
    const b2bContacts = await loadB2bContacts();
    const b2bType = b2bContacts.get(msg.from_address?.toLowerCase());
    if (b2bType) {
      msg.classification = b2bType; // 'wholesale' or 'lgbtq_org'
      msg.classification_confidence = 0.95;
      msg.classified_at = new Date().toISOString();
      results.push(msg);
      continue;
    }

    // Needs Sonnet
    needsTier3.push(msg);
  }

  // Tier 3: batch classify unknowns
  if (needsTier3.length > 0) {
    const BATCH_SIZE = 20;
    for (let i = 0; i < needsTier3.length; i += BATCH_SIZE) {
      const batch = needsTier3.slice(i, i + BATCH_SIZE);
      const aiResults = await classifyBatchTier3(batch);

      for (const result of aiResults) {
        const msg = batch[result.index];
        if (!msg) continue;
        msg.classification = result.classification;
        msg.classification_confidence = result.confidence;
        msg.classified_at = new Date().toISOString();
      }

      results.push(...batch);
    }
  }

  return results;
}

module.exports = { classifyMessages, classifyTier1, extractDomain };
