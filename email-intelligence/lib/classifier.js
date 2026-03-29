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
const { getSupabaseClient } = require('../../shared/supabaseClient');
const {
  OUR_ADDRESS,
  OUR_DOMAIN,
  SKIP_DOMAINS,
  KNOWN_DOMAINS,
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

// In-memory domain cache (populated from Supabase on first use)
let domainCache = null;

async function loadDomainCache() {
  if (domainCache) return domainCache;
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('email_classification_cache')
    .select('sender_domain, classification, confidence');
  if (error) throw error;
  domainCache = new Map((data || []).map(r => [r.sender_domain, r]));
  return domainCache;
}

async function saveDomainCache(domain, classification, confidence) {
  const supabase = getSupabaseClient();
  await supabase.from('email_classification_cache').upsert({
    sender_domain: domain,
    classification,
    confidence,
    sample_count: 1,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'sender_domain' });
  if (domainCache) {
    domainCache.set(domain, { sender_domain: domain, classification, confidence });
  }
}

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
// Tier 2: Domain cache lookup
// ---------------------------------------------------------------------------

async function classifyTier2(fromAddress) {
  const domain = extractDomain(fromAddress);
  if (!domain) return null;

  const cache = await loadDomainCache();
  const cached = cache.get(domain);
  if (cached) {
    return { classification: cached.classification, confidence: cached.confidence, tier: 2 };
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

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Classify each email into exactly ONE business area for a small gender-affirming underwear brand called RUBIES (rubyshines.com).

Categories:
- customer_support: End-customer (B2C consumer) emails about orders, sizing, returns, exchanges, product questions
- wholesale: B2B retailer/shop communications — sales outreach, reorders, wholesale account management
- lgbtq_org: LGBTQ+ community organizations — donation programs, partnership outreach, community centers
- product_rd: Product design, fit testing, sampling, development with suppliers/designers
- production_orders: Active manufacturing orders, factory production, PO tracking
- email_marketing: Email campaigns, marketing strategy, Klaviyo, content planning
- 3pl_fulfillment: 3PL warehouse, logistics, shipping operations, inventory management
- finance_legal: Accounting, tax, banking, legal, corporate, trust matters
- internal: Team communications, internal operations
- spam: Unsolicited sales pitches, cold outreach FROM other companies trying to sell TO us, newsletters we didn't sign up for

Return a JSON array with one object per email: [{"index": 0, "classification": "...", "confidence": 0.0-1.0}]
Only return the JSON array, nothing else.

Emails:
${emailSummaries}`,
    }],
  });

  try {
    const text = response.content[0].text.trim();
    // Extract JSON from potential markdown code blocks
    const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const results = JSON.parse(jsonStr);
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

    // Tier 2: Domain cache
    const t2 = await classifyTier2(msg.from_address);
    if (t2) {
      msg.classification = t2.classification;
      msg.classification_confidence = t2.confidence;
      msg.classified_at = new Date().toISOString();
      results.push(msg);
      continue;
    }

    // Needs Tier 3
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

        // Cache the domain for future lookups — but NOT personal email providers
        // (gmail.com, yahoo.com, etc. have diverse senders)
        const domain = extractDomain(msg.from_address);
        if (domain && result.confidence >= 0.7 && !PERSONAL_EMAIL_DOMAINS.has(domain)) {
          await saveDomainCache(domain, result.classification, result.confidence);
        }
      }

      results.push(...batch);
    }
  }

  return results;
}

module.exports = { classifyMessages, classifyTier1, extractDomain, loadDomainCache };
