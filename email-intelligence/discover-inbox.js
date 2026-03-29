#!/usr/bin/env node

/**
 * Gmail Inbox Discovery Script
 *
 * Connects to Gmail, samples the inbox, and outputs a report showing:
 *   - Total message count
 *   - Date distribution (messages per year/quarter)
 *   - Top sender domains + how many would be auto-classified by Tier 1 rules
 *   - Average message size (for token cost estimation)
 *   - Unique thread count
 *   - Estimated AI token costs for backfill at various time horizons
 *
 * Usage:
 *   node email-intelligence/discover-inbox.js
 *   node email-intelligence/discover-inbox.js --re-auth   # Force Gmail re-authorization
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Gmail OAuth (reuse creds from rubies-utilities)
// ---------------------------------------------------------------------------

const UTILITIES_ROOT = path.join(__dirname, '..', '..', 'rubies-utilities');
const GMAIL_CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH
  || path.join(UTILITIES_ROOT, 'creds', 'gmail-credentials.json');
const GMAIL_TOKEN_PATH = process.env.GMAIL_TOKEN_PATH
  || path.join(UTILITIES_ROOT, 'creds', 'gmail-token.json');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const OUR_ADDRESS = 'jamie@rubyshines.com';

// ---------------------------------------------------------------------------
// Tier 1 domain rules (zero-token classification)
// ---------------------------------------------------------------------------

const TIER1_SKIP_DOMAINS = new Set([
  'shopify.com', 'myshopify.com', 'shopifyemail.com',
  'gorgias.io', 'gorgias.com',
  'github.com', 'gitlab.com',
  'google.com', 'accounts.google.com',
  'notion.so', 'slack.com', 'trello.com', 'asana.com',
  'zoom.us', 'calendly.com',
  'stripe.com', 'paypal.com',
  'mailchimp.com', 'sendgrid.net', 'sendgrid.com',
  'figma.com', 'canva.com',
  'vercel.com', 'netlify.com', 'heroku.com',
  'supabase.io', 'supabase.com',
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com',
  'dropbox.com', 'box.com',
  'intuit.com', 'quickbooks.intuit.com',
  'apple.com', 'icloud.com',
  'microsoft.com', 'office365.com', 'outlook.com',
  'amazonses.com', 'amazon.com', 'aws.amazon.com',
  'fedex.com', 'ups.com', 'usps.com', 'canadapost-postescanada.ca',
  'squarespace.com', 'wix.com',
  // DMARC/DKIM report senders
  'fastmaildmarc.com', 'corp.mail.com', 'corp.mail.ru',
  'mimecastreport.com', 'au-1.mimecastreport.com', 'us-4.mimecastreport.com',
  'alerts.comcast.net', 'alln-inbound-h.cisco.com',
  'soverin.net', 'secureserver.net', 'lolipop.jp',
  // Review/notification platforms
  'judge.me',
  // SaaS newsletters
  'news.railway.app', 'booking.com',
]);

const TIER1_KNOWN_DOMAINS = {
  'klaviyo.com': 'email_marketing',
  'logankatz.com': 'finance_legal',
  'azaccounting.com': 'finance_legal',
  'passportglobal.com': '3pl_fulfillment',
  'nitrologistics.co': '3pl_fulfillment',
  'warehance.com': '3pl_fulfillment',
  'qq.com': 'production_orders',
};

// Patterns for noreply/notification senders
const SKIP_SENDER_PATTERNS = [
  /^noreply@/i,
  /^no-reply@/i,
  /^donotreply@/i,
  /^notifications?@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^bounce/i,
  /^updates?@/i,
  /^alerts?@/i,
  /^info@shopify\.com$/i,
];

function classifyByTier1(fromAddress) {
  if (!fromAddress) return null;
  const email = fromAddress.toLowerCase().trim();

  // Check skip patterns
  for (const pattern of SKIP_SENDER_PATTERNS) {
    if (pattern.test(email)) return 'skip';
  }

  // Extract domain
  const atIndex = email.lastIndexOf('@');
  if (atIndex < 0) return null;
  const domain = email.substring(atIndex + 1);

  // Check skip domains
  if (TIER1_SKIP_DOMAINS.has(domain)) return 'skip';
  // Check parent domain (e.g., mail.google.com → google.com)
  const parts = domain.split('.');
  if (parts.length > 2) {
    const parentDomain = parts.slice(-2).join('.');
    if (TIER1_SKIP_DOMAINS.has(parentDomain)) return 'skip';
  }

  // Check known domains
  if (TIER1_KNOWN_DOMAINS[domain]) return TIER1_KNOWN_DOMAINS[domain];

  return null; // needs AI classification
}

// ---------------------------------------------------------------------------
// Gmail Auth
// ---------------------------------------------------------------------------

async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('\nAuthorize Gmail access by visiting this URL:\n');
  console.log(authUrl);
  console.log('\nAfter authorization, copy the code and paste it below:\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    rl.question('Enter the code: ', (code) => {
      rl.close();
      oAuth2Client.getToken(code, (err, token) => {
        if (err) return reject(err);
        oAuth2Client.setCredentials(token);
        fs.writeFileSync(GMAIL_TOKEN_PATH, JSON.stringify(token));
        console.log('Token stored to', GMAIL_TOKEN_PATH);
        resolve(oAuth2Client);
      });
    });
  });
}

async function authorizeGmail(forceReAuth = false) {
  if (!fs.existsSync(GMAIL_CREDENTIALS_PATH)) {
    throw new Error(
      `Gmail credentials not found at ${GMAIL_CREDENTIALS_PATH}\n` +
      'Set GMAIL_CREDENTIALS_PATH env var or place gmail-credentials.json in rubies-utilities/creds/'
    );
  }
  const credentials = JSON.parse(fs.readFileSync(GMAIL_CREDENTIALS_PATH));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (!forceReAuth && fs.existsSync(GMAIL_TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(GMAIL_TOKEN_PATH));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }
  return getNewToken(oAuth2Client);
}

// ---------------------------------------------------------------------------
// Gmail API helpers
// ---------------------------------------------------------------------------

function extractAddress(headerValue) {
  if (!headerValue) return '';
  const match = headerValue.match(/<([^>]+)>/);
  return (match ? match[1] : headerValue).toLowerCase().trim();
}

function extractDomain(email) {
  const atIndex = email.lastIndexOf('@');
  return atIndex >= 0 ? email.substring(atIndex + 1) : email;
}

function getHeader(headers, name) {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function estimateBodySize(payload) {
  // Estimate body size from the payload without fetching full content
  if (payload.body && payload.body.size) return payload.body.size;
  let total = 0;
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.body && part.body.size) total += part.body.size;
      if (part.parts) total += estimateBodySize(part);
    }
  }
  return total;
}

function hasAttachments(payload) {
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.filename && part.filename.length > 0) return true;
      if (part.parts && hasAttachments(part)) return true;
    }
  }
  return false;
}

function getAttachmentInfo(payload) {
  const attachments = [];
  function walk(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.filename && part.filename.length > 0) {
        attachments.push({
          filename: part.filename,
          mimeType: part.mimeType,
          size: part.body ? part.body.size : 0,
        });
      }
      if (part.parts) walk(part.parts);
    }
  }
  walk(payload.parts);
  return attachments;
}

// ---------------------------------------------------------------------------
// Output helper — writes to both console and file
// ---------------------------------------------------------------------------

const OUTPUT_PATH = path.join(__dirname, 'discovery-report.txt');
const outputLines = [];
function log(line = '') {
  const text = line.replace(/\r$/, '');
  outputLines.push(text);
  process.stdout.write(text + '\n');
}
function saveReport() {
  fs.writeFileSync(OUTPUT_PATH, outputLines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function discoverInbox() {
  const forceReAuth = process.argv.includes('--re-auth');
  const auth = await authorizeGmail(forceReAuth);
  const gmail = google.gmail({ version: 'v1', auth });

  log('\n========================================');
  log('  RUBIES Gmail Inbox Discovery');
  log('========================================\n');

  // Step 1: Get total message count from profile
  const profile = await gmail.users.getProfile({ userId: 'me' });
  log(`Account: ${profile.data.emailAddress}`);
  log(`Total messages: ${profile.data.messagesTotal.toLocaleString()}`);
  log(`Total threads:  ${profile.data.threadsTotal.toLocaleString()}`);
  log(`History ID:     ${profile.data.historyId}`);
  log('');

  // Step 2: Sample messages across time periods to get date distribution + domain stats
  // We'll page through message IDs and fetch metadata for a sample

  const SAMPLE_SIZE = 500; // fetch metadata for this many messages
  const PAGE_SIZE = 500;

  log(`Sampling ${SAMPLE_SIZE} messages for analysis...\n`);

  // Collect message IDs
  const messageIds = [];
  let pageToken = null;
  while (messageIds.length < SAMPLE_SIZE) {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: Math.min(PAGE_SIZE, SAMPLE_SIZE - messageIds.length),
      pageToken,
    });
    if (!listRes.data.messages) break;
    for (const msg of listRes.data.messages) {
      messageIds.push(msg.id);
    }
    pageToken = listRes.data.nextPageToken;
    if (!pageToken) break;
    process.stderr.write(`  Listed ${messageIds.length} message IDs...\r`);
  }
  log(`  Listed ${messageIds.length} message IDs`);

  // Also get oldest messages to understand time range
  // Use a query for older messages
  let oldestMessageDate = null;
  try {
    const oldRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 1,
      q: 'older_than:10y', // get very old messages
    });
    if (!oldRes.data.messages || oldRes.data.messages.length === 0) {
      // Try without the filter — just get the last page
      // We'll estimate from our sample instead
    } else {
      const oldMsg = await gmail.users.messages.get({
        userId: 'me',
        id: oldRes.data.messages[0].id,
        format: 'metadata',
        metadataHeaders: ['Date'],
      });
      const dateStr = getHeader(oldMsg.data.payload.headers, 'Date');
      if (dateStr) oldestMessageDate = new Date(dateStr);
    }
  } catch (e) { /* ignore */ }

  // Fetch metadata for sampled messages (batch of 20 to avoid rate limits)
  const BATCH_SIZE = 20;
  const messages = [];
  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(id =>
        gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date', 'Content-Type'],
        }).catch(() => null)
      )
    );
    for (const res of results) {
      if (!res) continue;
      const headers = res.data.payload.headers;
      const fromRaw = getHeader(headers, 'From');
      const fromAddr = extractAddress(fromRaw);
      const toRaw = getHeader(headers, 'To');
      const dateStr = getHeader(headers, 'Date');
      const subject = getHeader(headers, 'Subject');
      const date = dateStr ? new Date(dateStr) : null;

      messages.push({
        id: res.data.id,
        threadId: res.data.threadId,
        from: fromAddr,
        fromRaw,
        to: toRaw,
        subject,
        date,
        sizeEstimate: res.data.sizeEstimate || 0,
        labelIds: res.data.labelIds || [],
        isSent: fromAddr === OUR_ADDRESS || (res.data.labelIds || []).includes('SENT'),
      });
    }
    process.stderr.write(`  Fetched metadata for ${messages.length}/${messageIds.length}...\r`);
  }
  log(`  Fetched metadata for ${messages.length} messages\n`);

  // Get accurate counts by time period using search queries
  // Gmail's resultSizeEstimate is unreliable, so we page through to count
  log('Counting messages by time period (this takes a moment)...');
  const periods = [
    { label: 'Last 30 days', query: 'newer_than:30d' },
    { label: 'Last 90 days', query: 'newer_than:90d' },
    { label: 'Last 6 months', query: 'newer_than:6m' },
    { label: 'Last 1 year', query: 'newer_than:1y' },
    { label: 'Last 2 years', query: 'newer_than:2y' },
    { label: 'Last 3 years', query: 'newer_than:3y' },
  ];

  const periodCounts = [];
  for (const period of periods) {
    try {
      let count = 0;
      let pt = null;
      do {
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: period.query,
          maxResults: 500,
          pageToken: pt,
        });
        count += (res.data.messages || []).length;
        pt = res.data.nextPageToken;
      } while (pt);
      periodCounts.push({ label: period.label, count });
      process.stderr.write(`  ${period.label}: ${count}\n`);
    } catch (e) {
      periodCounts.push({ label: period.label, count: '?' });
    }
  }

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------

  // Date distribution from sample
  const yearQuarters = {};
  for (const msg of messages) {
    if (!msg.date) continue;
    const y = msg.date.getFullYear();
    const q = Math.ceil((msg.date.getMonth() + 1) / 3);
    const key = `${y} Q${q}`;
    yearQuarters[key] = (yearQuarters[key] || 0) + 1;
  }

  // Domain analysis
  const domainCounts = {};
  const domainExamples = {};
  let tier1SkipCount = 0;
  let tier1ClassifiedCount = 0;
  let needsAiCount = 0;
  let sentCount = 0;

  for (const msg of messages) {
    if (msg.isSent) {
      sentCount++;
      continue; // sent messages don't need classification
    }
    const domain = extractDomain(msg.from);
    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    if (!domainExamples[domain]) {
      domainExamples[domain] = { from: msg.fromRaw, subject: msg.subject };
    }

    const tier1Result = classifyByTier1(msg.from);
    if (tier1Result === 'skip') {
      tier1SkipCount++;
    } else if (tier1Result) {
      tier1ClassifiedCount++;
    } else {
      needsAiCount++;
    }
  }

  // Thread analysis
  const threadIds = new Set(messages.map(m => m.threadId));

  // Size analysis
  const sizes = messages.map(m => m.sizeEstimate).filter(s => s > 0);
  const avgSize = sizes.length > 0 ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
  const medianSize = sizes.length > 0 ? sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] : 0;

  // Top domains (excluding sent)
  const sortedDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  log('\n========================================');
  log('  MESSAGE VOLUME BY TIME PERIOD');
  log('========================================\n');

  for (const pc of periodCounts) {
    log(`  ${pc.label.padEnd(18)} ${String(pc.count).padStart(8)} messages`);
  }
  log(`  ${'All time'.padEnd(18)} ${String(profile.data.messagesTotal).padStart(8)} messages`);

  if (oldestMessageDate) {
    log(`\n  Oldest message: ${oldestMessageDate.toISOString().split('T')[0]}`);
  }

  log('\n========================================');
  log('  SAMPLE ANALYSIS (most recent ' + messages.length + ')');
  log('========================================\n');

  log(`  Sent by you:     ${sentCount} (${((sentCount / messages.length) * 100).toFixed(0)}%)`);
  log(`  Received:        ${messages.length - sentCount} (${(((messages.length - sentCount) / messages.length) * 100).toFixed(0)}%)`);
  log(`  Unique threads:  ${threadIds.size}`);
  log(`  Avg message size: ${(avgSize / 1024).toFixed(1)} KB`);
  log(`  Median msg size:  ${(medianSize / 1024).toFixed(1)} KB`);

  log('\n  Date range of sample:');
  const sortedQuarters = Object.entries(yearQuarters).sort();
  for (const [quarter, count] of sortedQuarters) {
    const bar = '#'.repeat(Math.ceil(count / 2));
    log(`    ${quarter.padEnd(10)} ${String(count).padStart(4)} ${bar}`);
  }

  log('\n========================================');
  log('  TIER 1 CLASSIFICATION (sample)');
  log('========================================\n');

  const receivedCount = messages.length - sentCount;
  log(`  Auto-skip (notifications/SaaS): ${tier1SkipCount} (${((tier1SkipCount / receivedCount) * 100).toFixed(0)}% of received)`);
  log(`  Auto-classified (known domains): ${tier1ClassifiedCount} (${((tier1ClassifiedCount / receivedCount) * 100).toFixed(0)}% of received)`);
  log(`  Needs AI classification:         ${needsAiCount} (${((needsAiCount / receivedCount) * 100).toFixed(0)}% of received)`);

  log('\n========================================');
  log('  TOP 30 SENDER DOMAINS');
  log('========================================\n');

  for (const [domain, count] of sortedDomains) {
    const tier1 = classifyByTier1(`x@${domain}`);
    const tag = tier1 === 'skip' ? ' [SKIP]'
      : tier1 ? ` [${tier1.toUpperCase()}]`
      : '';
    const example = domainExamples[domain];
    log(`  ${String(count).padStart(4)}  ${domain}${tag}`);
    if (!tier1 && example) {
      log(`        e.g. "${(example.subject || '').substring(0, 60)}"`);
    }
  }

  // ---------------------------------------------------------------------------
  // Cost Estimates
  // ---------------------------------------------------------------------------

  log('\n========================================');
  log('  ESTIMATED BACKFILL COSTS');
  log('========================================\n');

  const totalMessages = profile.data.messagesTotal;
  const totalThreads = profile.data.threadsTotal;
  const sentRatio = sentCount / messages.length;
  const tier1SkipRatio = tier1SkipCount / receivedCount;
  const needsAiRatio = needsAiCount / receivedCount;

  // Tokens per email body — use MEDIAN size (avg is skewed by DMARC XML/HTML emails)
  // ~50% of raw size is actual text content, 1 token ≈ 4 chars
  const typicalBodyTokens = Math.round((medianSize * 0.5) / 4);
  const avgHeaderTokens = 100; // From, To, Subject, Date

  // Sonnet pricing (as of 2026): $3/M input, $15/M output
  const SONNET_INPUT_PER_M = 3;
  const SONNET_OUTPUT_PER_M = 15;

  for (const pc of periodCounts) {
    if (pc.count === '?') continue;
    const msgs = pc.count;
    const received = Math.round(msgs * (1 - sentRatio));
    const aiClassify = Math.round(received * needsAiRatio);

    // Classification cost: headers only, batched 20 per call
    const classifyInputTokens = aiClassify * avgHeaderTokens;
    const classifyOutputTokens = aiClassify * 30; // ~30 tokens per classification response
    const classifyCost =
      (classifyInputTokens / 1_000_000) * SONNET_INPUT_PER_M +
      (classifyOutputTokens / 1_000_000) * SONNET_OUTPUT_PER_M;

    // Thread summarization: ~avg body * messages per thread, for non-skip threads
    const nonSkipMsgs = Math.round(received * (1 - tier1SkipRatio));
    const estThreads = Math.round(nonSkipMsgs / 3); // rough: 3 msgs per thread
    const summaryInputTokens = estThreads * typicalBodyTokens * 3; // 3 messages avg per thread
    const summaryOutputTokens = estThreads * 200; // ~200 tokens per summary
    const summaryCost =
      (summaryInputTokens / 1_000_000) * SONNET_INPUT_PER_M +
      (summaryOutputTokens / 1_000_000) * SONNET_OUTPUT_PER_M;

    // Project clustering: ~1 call per 10 threads
    const projectCalls = Math.ceil(estThreads / 10);
    const projectInputTokens = projectCalls * 2000; // summaries of 10 threads
    const projectOutputTokens = projectCalls * 500;
    const projectCost =
      (projectInputTokens / 1_000_000) * SONNET_INPUT_PER_M +
      (projectOutputTokens / 1_000_000) * SONNET_OUTPUT_PER_M;

    const totalCost = classifyCost + summaryCost + projectCost;

    log(`  ${pc.label}:`);
    log(`    Messages: ${msgs.toLocaleString()} (${received.toLocaleString()} received, ${aiClassify.toLocaleString()} need AI)`);
    log(`    Est. threads to summarize: ~${estThreads.toLocaleString()}`);
    log(`    Classification:  $${classifyCost.toFixed(2)}`);
    log(`    Summarization:   $${summaryCost.toFixed(2)}`);
    log(`    Project cluster: $${projectCost.toFixed(2)}`);
    log(`    TOTAL:           $${totalCost.toFixed(2)}`);
    log('');
  }

  log('  Daily incremental (est. 30 messages/day):');
  const dailyAi = Math.round(30 * (1 - sentRatio) * needsAiRatio);
  const dailyThreads = Math.round(dailyAi / 2);
  const dailyClassifyCost = ((dailyAi * avgHeaderTokens) / 1_000_000) * SONNET_INPUT_PER_M +
    ((dailyAi * 30) / 1_000_000) * SONNET_OUTPUT_PER_M;
  const dailySummaryCost = ((dailyThreads * typicalBodyTokens * 3) / 1_000_000) * SONNET_INPUT_PER_M +
    ((dailyThreads * 200) / 1_000_000) * SONNET_OUTPUT_PER_M;
  const dailyTotal = dailyClassifyCost + dailySummaryCost;
  log(`    AI messages: ~${dailyAi}, threads: ~${dailyThreads}`);
  log(`    Daily cost:  $${dailyTotal.toFixed(4)}`);
  log(`    Monthly est: $${(dailyTotal * 30).toFixed(2)}`);

  log('\n========================================');
  log('  RECOMMENDATION');
  log('========================================\n');

  if (totalMessages > 50000) {
    log('  Your inbox is large (70K+). Consider starting with 2 years of history');
    log('  to keep the backfill manageable and costs reasonable.');
  } else if (totalMessages > 20000) {
    log('  Moderate inbox size. Full backfill is feasible but 2 years');
    log('  would cover all active business relationships.');
  } else {
    log('  Inbox size is manageable. Full backfill should be straightforward.');
  }

  log('\n  Next step: Review the domain list above and identify any domains');
  log('  that should be added to Tier 1 rules (to reduce AI cost).\n');

  // Save report to file
  saveReport();
  log(`  Report saved to: ${OUTPUT_PATH}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

discoverInbox().catch(err => {
  if (err.message?.includes('invalid_grant')) {
    process.stderr.write('\nGmail token expired. Re-run with --re-auth to re-authorize.\n');
  } else {
    process.stderr.write('\nError: ' + (err.message || err) + '\n');
    if (err.stack) process.stderr.write(err.stack + '\n');
  }
  process.exit(1);
});
