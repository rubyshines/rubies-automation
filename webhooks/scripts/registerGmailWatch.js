#!/usr/bin/env node

/**
 * Register / renew / check Gmail push notification watch.
 *
 * Gmail watch expires every 7 days — must be renewed daily.
 *
 * Usage:
 *   node webhooks/scripts/registerGmailWatch.js            # register/renew
 *   node webhooks/scripts/registerGmailWatch.js --status    # check current watch
 *
 * Env vars:
 *   GMAIL_PUSH_TOPIC — full Pub/Sub topic name (projects/xxx/topics/yyy)
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getGmail } = require('../../email-intelligence/lib/gmailClient');

async function renew() {
  const topicName = process.env.GMAIL_PUSH_TOPIC;
  if (!topicName) {
    console.error('[gmail-watch] GMAIL_PUSH_TOPIC env var not set');
    return { success: false, error: 'GMAIL_PUSH_TOPIC not set' };
  }

  const gmail = await getGmail();

  try {
    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName,
        labelIds: ['INBOX'],
      },
    });

    const expiration = new Date(parseInt(res.data.expiration)).toISOString();
    console.log(`[gmail-watch] Watch registered — historyId: ${res.data.historyId}, expires: ${expiration}`);
    return { success: true, historyId: res.data.historyId, expiration };
  } catch (err) {
    console.error(`[gmail-watch] Failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function status() {
  // Gmail doesn't have a "get watch" endpoint — the only way to check
  // is to call watch() again (which renews it). So --status just renews.
  console.log('[gmail-watch] Checking status (this also renews the watch)');
  return renew();
}

if (require.main === module) {
  const cmd = process.argv.includes('--status') ? status : renew;
  cmd()
    .then(result => {
      if (!result.success) process.exit(1);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { renew };
