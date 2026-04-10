/**
 * Email Intelligence — Configuration
 *
 * Tier 1 classification rules, business area definitions, and stage configs.
 * Edit this file to tune classification without spending AI tokens.
 */

const OUR_ADDRESS = 'jamie@rubyshines.com';
const OUR_DOMAIN = 'rubyshines.com';

// ---------------------------------------------------------------------------
// Tier 1: Domain-based rules (zero tokens)
// ---------------------------------------------------------------------------

// Domains whose emails should be skipped entirely (notifications, DMARC, SaaS)
// Only pure SaaS/notification domains where a human will never email.
// Do NOT add domains here as a hack for spam, newsletters, or auto-replies —
// let the classifier handle those so we don't accidentally block real people.
const SKIP_DOMAINS = new Set([
  // E-commerce platforms
  'shopify.com', 'myshopify.com', 'shopifyemail.com',
  // CS platforms (handled by Gorgias sync)
  'gorgias.io', 'gorgias.com',
  // Dev / CI
  'github.com', 'gitlab.com', 'vercel.com', 'netlify.com', 'heroku.com',
  'railway.app', 'news.railway.app',
  // Google / Microsoft / Apple (system notifications only)
  'google.com', 'accounts.google.com', 'microsoft.com',
  'apple.com', 'office365.com',
  // Social
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com',
  // Messaging / Productivity
  'slack.com', 'notion.so', 'trello.com', 'asana.com', 'zoom.us', 'calendly.com',
  'figma.com', 'canva.com',
  // Payments
  'stripe.com', 'paypal.com',
  // Email services
  'mailchimp.com', 'sendgrid.net', 'sendgrid.com',
  // Cloud / DB
  'supabase.io', 'supabase.com', 'amazonses.com', 'amazon.com', 'aws.amazon.com',
  // Shipping carrier notifications
  'fedex.com', 'ups.com', 'usps.com', 'canadapost-postescanada.ca',
  // Website builders
  'squarespace.com', 'wix.com',
  // Cloud storage
  'dropbox.com', 'box.com',
  // Accounting platform notifications (not the accountant themselves)
  'intuit.com', 'quickbooks.intuit.com',
  // DMARC / DKIM report senders
  'fastmaildmarc.com', 'corp.mail.com', 'corp.mail.ru',
  'mimecastreport.com', 'au-1.mimecastreport.com', 'us-4.mimecastreport.com',
  'alerts.comcast.net', 'alln-inbound-h.cisco.com',
  'soverin.net', 'secureserver.net', 'lolipop.jp',
  'bell.ca', 'reports.emailsrvr.com',
  // Review platforms
  'judge.me',
  // Payroll platform notifications
  'wagepoint.com',
  // Travel
  'booking.com',
]);

// Known domains → specific business area classification
const KNOWN_DOMAINS = {
  // Email marketing
  'klaviyo.com': 'email_marketing',
  // Finance / Legal
  'logankatz.com': 'finance_legal',
  'azaccounting.com': 'finance_legal',
  // 3PL / Fulfillment
  'passportglobal.com': '3pl_fulfillment',
  'nitrologistics.co': '3pl_fulfillment',
  'warehance.com': '3pl_fulfillment',
  // Production / Suppliers (add more as discovered)
  'qq.com': 'production_orders',
};

// Sender patterns that should be skipped regardless of domain
const SKIP_SENDER_PATTERNS = [
  /^noreply@/i,
  /^no-reply@/i,
  /^donotreply@/i,
  /^notifications?@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^bounce/i,
];

// ---------------------------------------------------------------------------
// Business area definitions
// ---------------------------------------------------------------------------

const BUSINESS_AREAS = {
  customer_support: {
    label: 'Customer Support',
    description: 'End-customer (B2C) emails about orders, sizing, returns, exchanges',
  },
  wholesale: {
    label: 'Wholesale',
    description: 'B2B retailer/shop communications — sales outreach, reorders, account management',
    stages: ['Lead', 'Outreach', 'Negotiation', 'Terms Agreed', 'First Order', 'Ongoing'],
  },
  lgbtq_org: {
    label: 'LGBTQ+ Organizations',
    description: 'Community organizations — donation programs, partnerships, outreach',
    stages: ['Lead', 'Outreach', 'Agreement', 'Active Partner', 'Ongoing'],
  },
  product_rd: {
    label: 'Product R&D',
    description: 'Design, fit testing, sampling, production development',
    stages: ['Design', 'Fit Testing', 'Sampling', 'Pre-Production', 'Production Ready'],
  },
  production_orders: {
    label: 'Production Orders',
    description: 'Active manufacturing orders, factory communications',
    stages: ['PO Issued', 'In Production', 'QC', 'Shipped', 'Received'],
  },
  email_marketing: {
    label: 'Email Marketing',
    description: 'Klaviyo, campaigns, marketing coordination',
    stages: ['Planning', 'Content', 'Scheduled', 'Sent', 'Analyzed'],
  },
  '3pl_fulfillment': {
    label: '3PL / Fulfillment',
    description: '3PL provider communications, shipping, inventory, warehouse ops',
  },
  finance_legal: {
    label: 'Finance / Legal',
    description: 'Accountant, banking, CRA, legal, corporate matters',
  },
  internal: {
    label: 'Internal',
    description: 'Team communications, internal ops',
  },
  newsletter: {
    label: 'Newsletter',
    description: 'Recurring newsletters, digests, or updates — subscribed content, not direct communications',
  },
  auto_reply: {
    label: 'Auto-Reply',
    description: 'Out-of-office replies, vacation auto-responders, automatic replies to marketing emails',
  },
};

// Classification taxonomy for AI prompts
const CLASSIFICATION_LABELS = Object.keys(BUSINESS_AREAS);

// ---------------------------------------------------------------------------
// Follow-up cadence (ported from update-sales-leads.js, generalized)
// ---------------------------------------------------------------------------

// Base days to wait based on consecutive messages without response
const FOLLOW_UP_CADENCE = {
  0: 1,   // They just replied — respond within a day
  1: 5,   // We sent 1, no response — wait 5 days
  2: 10,  // 2 no-responses — 10 days
  3: 21,  // 3 no-responses — 3 weeks
  4: 45,  // 4 no-responses — 6 weeks
  5: 90,  // 5+ — quarterly check-in
};

// Area-specific multipliers for follow-up urgency
const AREA_URGENCY = {
  customer_support: 0.3,   // CS is urgent — respond same day
  wholesale: 1.0,          // Standard sales cadence
  lgbtq_org: 1.0,          // Similar to wholesale
  product_rd: 0.8,         // Slightly faster — projects have momentum
  production_orders: 0.5,  // Factory timelines are tight
  email_marketing: 1.5,    // Less time-sensitive
  '3pl_fulfillment': 0.7,  // Logistics matters are time-sensitive
  finance_legal: 1.2,      // Important but not daily
  internal: 1.0,
};

module.exports = {
  OUR_ADDRESS,
  OUR_DOMAIN,
  SKIP_DOMAINS,
  KNOWN_DOMAINS,
  SKIP_SENDER_PATTERNS,
  BUSINESS_AREAS,
  CLASSIFICATION_LABELS,
  FOLLOW_UP_CADENCE,
  AREA_URGENCY,
};
