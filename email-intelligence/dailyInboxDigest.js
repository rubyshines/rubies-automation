#!/usr/bin/env node

/**
 * RUBIES Daily Inbox Digest — "What should I work on today?"
 *
 * Queries summarized email threads and surfaces:
 *   1. Overdue action items (you dropped the ball)
 *   2. Due today (do these now)
 *   3. Due this week (plan for these)
 *   4. Awaiting them (nothing to do, but track)
 *   5. New threads since yesterday (what came in)
 *
 * Usage:
 *   node email-intelligence/dailyInboxDigest.js          # prints to console
 *   node email-intelligence/dailyInboxDigest.js --send    # sends email via SendGrid
 *   npm run inbox-digest
 *   npm run inbox-digest -- --send
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
}

const { getSupabaseClient } = require('../shared/supabaseClient');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AREA_LABELS = {
  customer_support: 'Customer Support',
  wholesale: 'Wholesale',
  lgbtq_org: 'LGBTQ+ Orgs',
  product_rd: 'Product R&D',
  production_orders: 'Production',
  email_marketing: 'Marketing',
  '3pl_fulfillment': '3PL / Shipping',
  finance_legal: 'Finance / Legal',
};

const AREA_ORDER = [
  'finance_legal',
  'production_orders',
  'wholesale',
  'lgbtq_org',
  '3pl_fulfillment',
  'customer_support',
  'product_rd',
  'email_marketing',
];

// ---------------------------------------------------------------------------
// Build digest
// ---------------------------------------------------------------------------

async function buildDigest() {
  const supabase = getSupabaseClient();
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const weekEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Fetch all active threads with actions
  const { data: threads } = await supabase
    .from('email_threads')
    .select('subject, classification, next_action, next_action_due, next_action_owner, awaiting_response_from, last_message_at, summary')
    .eq('is_active', true)
    .not('next_action', 'is', null)
    .order('next_action_due', { ascending: true });

  // Fetch new threads from yesterday
  const { data: newThreads } = await supabase
    .from('email_threads')
    .select('subject, classification, summary, last_message_at, awaiting_response_from')
    .gte('last_message_at', yesterday + 'T00:00:00Z')
    .not('classification', 'in', '(skip,internal,spam)')
    .order('last_message_at', { ascending: false });

  // Categorize
  const overdue = [];
  const dueToday = [];
  const dueThisWeek = [];
  const awaitingThem = [];

  for (const t of (threads || [])) {
    if (t.next_action_owner === 'them') {
      awaitingThem.push(t);
      continue;
    }

    const due = t.next_action_due;
    if (!due) continue;

    if (due < today) {
      overdue.push(t);
    } else if (due === today) {
      dueToday.push(t);
    } else if (due <= weekEnd) {
      dueThisWeek.push(t);
    }
  }

  return { overdue, dueToday, dueThisWeek, awaitingThem, newThreads: newThreads || [], today };
}

// ---------------------------------------------------------------------------
// Format digest
// ---------------------------------------------------------------------------

function formatSection(title, items, showDue = true) {
  if (!items.length) return '';

  // Group by area
  const byArea = new Map();
  for (const t of items) {
    const area = t.classification || 'other';
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(t);
  }

  const lines = [`\n--- ${title} (${items.length}) ---\n`];

  for (const area of AREA_ORDER) {
    const areaItems = byArea.get(area);
    if (!areaItems) continue;
    byArea.delete(area);

    const label = AREA_LABELS[area] || area;
    lines.push(`  ${label}:`);
    for (const t of areaItems) {
      const subj = (t.subject || '(no subject)').substring(0, 50);
      const duePart = showDue && t.next_action_due ? ` [due ${t.next_action_due}]` : '';
      lines.push(`    - ${subj}${duePart}`);
      lines.push(`      ${t.next_action.substring(0, 100)}`);
    }
    lines.push('');
  }

  // Any remaining areas not in AREA_ORDER
  for (const [area, areaItems] of byArea) {
    const label = AREA_LABELS[area] || area;
    lines.push(`  ${label}:`);
    for (const t of areaItems) {
      const subj = (t.subject || '(no subject)').substring(0, 50);
      const duePart = showDue && t.next_action_due ? ` [due ${t.next_action_due}]` : '';
      lines.push(`    - ${subj}${duePart}`);
      lines.push(`      ${t.next_action.substring(0, 100)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatDigest(digest) {
  const { overdue, dueToday, dueThisWeek, awaitingThem, newThreads, today } = digest;

  const totalOnYou = overdue.length + dueToday.length;

  const lines = [
    `========================================`,
    `  RUBIES Inbox Digest -- ${today}`,
    `========================================`,
    '',
    `  Action items on you: ${totalOnYou} (${overdue.length} overdue, ${dueToday.length} due today)`,
    `  Coming this week: ${dueThisWeek.length}`,
    `  Awaiting others: ${awaitingThem.length}`,
    `  New activity (24h): ${newThreads.length} threads`,
  ];

  if (overdue.length > 0) {
    lines.push(formatSection('OVERDUE -- needs immediate attention', overdue));
  }

  if (dueToday.length > 0) {
    lines.push(formatSection('DUE TODAY', dueToday, false));
  }

  if (dueThisWeek.length > 0) {
    lines.push(formatSection('THIS WEEK', dueThisWeek));
  }

  if (newThreads.length > 0) {
    lines.push(`\n--- NEW ACTIVITY (24h) ---\n`);
    for (const t of newThreads.slice(0, 15)) {
      const label = AREA_LABELS[t.classification] || t.classification;
      const subj = (t.subject || '(no subject)').substring(0, 55);
      const who = t.awaiting_response_from === 'us' ? 'YOU' : 'them';
      lines.push(`  [${label}] ${subj}`);
      if (t.summary) lines.push(`    ${t.summary.substring(0, 120)}`);
      lines.push(`    Ball in: ${who}`);
      lines.push('');
    }
    if (newThreads.length > 15) {
      lines.push(`  ... and ${newThreads.length - 15} more`);
    }
  }

  if (awaitingThem.length > 0) {
    lines.push(`\n--- AWAITING OTHERS (${awaitingThem.length}) ---\n`);
    for (const t of awaitingThem.slice(0, 10)) {
      const label = AREA_LABELS[t.classification] || t.classification;
      const subj = (t.subject || '(no subject)').substring(0, 55);
      lines.push(`  [${label}] ${subj}`);
      lines.push(`    ${t.next_action.substring(0, 100)}`);
      lines.push('');
    }
    if (awaitingThem.length > 10) {
      lines.push(`  ... and ${awaitingThem.length - 10} more`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Send email
// ---------------------------------------------------------------------------

async function sendDigestEmail(text, digest) {
  const { getSendgridClient } = require('../shared/sendgridClient');
  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.log('No SendGrid client — skipping email.');
    return;
  }

  const { overdue, dueToday, today } = digest;
  const totalUrgent = overdue.length + dueToday.length;
  const icon = overdue.length > 0 ? '\u26A0\uFE0F' : '\u2705';
  const subject = `${icon} RUBIES Inbox Digest -- ${today} -- ${totalUrgent} action items`;

  await sgMail.send({
    to: 'jamie@rubyshines.com',
    from: 'pipeline@rubyshines.com',
    subject,
    text,
  });

  console.log('Digest email sent.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const digest = await buildDigest();
  const text = formatDigest(digest);

  console.log(text);

  if (process.argv.includes('--send')) {
    await sendDigestEmail(text, digest);
  }
}

// Exported run() for potential integration with daily runner
async function run() {
  const digest = await buildDigest();
  const text = formatDigest(digest);
  console.log(text);

  if (process.env.SEND_DIGEST_EMAIL === 'true') {
    await sendDigestEmail(text, digest);
  }

  return {
    sources: {
      digest: {
        success: true,
        rowsWritten: digest.overdue.length + digest.dueToday.length + digest.dueThisWeek.length,
      },
    },
    status: 'ok',
  };
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

module.exports = { run, buildDigest, formatDigest };
