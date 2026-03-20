/**
 * RUBIES Review Tracking — Daily Judge.me Pipeline
 *
 * Runs daily (via GitHub Actions or cron) and:
 * - Syncs new Judge.me reviews into Supabase
 * - Snapshots daily rating distribution and average
 * - Sends a SendGrid notification on failure
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const { getSupabaseClient, upsert } = require('../shared/supabaseClient');
const { getJudgemeClient } = require('../shared/judgemeClient');
const { getSendgridClient } = require('../shared/sendgridClient');

const supabase = getSupabaseClient();

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return formatDate(dt);
}

// ---------------------------------------------------------------------------
// Judge.me: Sync reviews
// ---------------------------------------------------------------------------

async function runReviewSync(results) {
  const sourceKey = 'reviews';
  const client = getJudgemeClient();
  if (!client) {
    results[sourceKey] = { success: false, rowsWritten: 0, error: 'JUDGEME_API_TOKEN not set' };
    return;
  }

  let rowsWritten = 0;

  try {
    // Find the most recent review we have stored
    const { data: latest } = await supabase
      .from('judgeme_reviews')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1);

    const sinceDate = latest?.[0]?.created_at || null;

    // Fetch new reviews (since last stored, or all if first run)
    const reviews = sinceDate
      ? await client.getAllReviews({ since: sinceDate, perPage: 100, maxPages: 50 })
      : await client.getAllReviews({ perPage: 100, maxPages: 200 });

    console.log(`  Fetched ${reviews.length} new reviews from Judge.me`);

    if (reviews.length) {
      const rows = reviews.map(r => ({
        review_id: r.id,
        rating: r.rating,
        title: r.title || '',
        body: r.body || '',
        reviewer_name: r.reviewer?.name || '',
        reviewer_email: r.reviewer?.email || '',
        product_external_id: r.product_external_id ? String(r.product_external_id) : null,
        product_title: r.product_title || '',
        product_handle: r.product_handle || '',
        verified: r.verified || '',
        source: r.source || '',
        curated: r.curated || '',
        has_pictures: r.has_published_pictures || false,
        has_videos: r.has_published_videos || false,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));

      rowsWritten = await upsert('judgeme_reviews', rows, ['review_id']);
    }

    results[sourceKey] = { success: true, rowsWritten, error: null };
  } catch (err) {
    results[sourceKey] = { success: rowsWritten > 0, rowsWritten, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Judge.me: Daily metrics snapshot
// ---------------------------------------------------------------------------

async function runDailyMetrics(results) {
  const sourceKey = 'daily_metrics';
  const client = getJudgemeClient();
  if (!client) {
    results[sourceKey] = { success: false, rowsWritten: 0, error: 'JUDGEME_API_TOKEN not set' };
    return;
  }

  try {
    const dist = await client.getRatingDistribution();
    const today = formatDate(new Date());

    // Count reviews created today from our stored data
    const { data: todayReviews } = await supabase
      .from('judgeme_reviews')
      .select('review_id')
      .gte('created_at', `${today}T00:00:00`)
      .lt('created_at', `${addDays(today, 1)}T00:00:00`);

    const row = {
      date: today,
      total_reviews: dist.total,
      avg_rating: dist.avgRating,
      stars_1: dist.distribution[1],
      stars_2: dist.distribution[2],
      stars_3: dist.distribution[3],
      stars_4: dist.distribution[4],
      stars_5: dist.distribution[5],
      new_reviews_today: todayReviews?.length || 0,
    };

    const rowsWritten = await upsert('judgeme_daily_metrics', [row], ['date']);
    results[sourceKey] = { success: true, rowsWritten, error: null };
  } catch (err) {
    results[sourceKey] = { success: false, rowsWritten: 0, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

async function sendNotification(status, results) {
  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.log('  ℹ Skipping email notification (no SendGrid client).');
    return;
  }

  const to = 'jamie@rubyshines.com';
  const from = 'pipeline@rubyshines.com';
  const today = formatDate(new Date());

  const sources = ['reviews', 'daily_metrics'];
  const lines = sources.map(k => {
    const r = results[k];
    const icon = r?.success ? '✅' : '❌';
    return `${icon} ${k}: ${r?.rowsWritten || 0} rows${r?.error ? ` (${r.error})` : ''}`;
  });

  const subject = status === 'success'
    ? `✅ RUBIES Reviews Pipeline — ${today} OK`
    : `⚠️ RUBIES Reviews Pipeline — ${today} ${status}`;

  const text = [
    `Review tracking pipeline ${status} for ${today}.`,
    '',
    ...lines,
  ].join('\n');

  try {
    await sgMail.send({ to, from, subject, text });
  } catch (err) {
    console.error('  ✗ SendGrid notification failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Exported run() for unified runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('RUBIES Review Pipeline — starting');

  const results = {};

  await runReviewSync(results);
  console.log(`  Reviews synced: ${results.reviews?.rowsWritten || 0} rows`);

  await runDailyMetrics(results);
  console.log(`  Daily metrics: ${results.daily_metrics?.rowsWritten || 0} rows`);

  const allSuccess = Object.values(results).every(r => r.success);
  const anySuccess = Object.values(results).some(r => r.success);
  const status = allSuccess ? 'success' : anySuccess ? 'partial' : 'failure';
  console.log(`  Status: ${status}`);
  console.log('RUBIES Review Pipeline — done');

  return {
    sources: {
      reviews: results.reviews,
      daily_metrics: results.daily_metrics,
    },
    status,
  };
}

module.exports = { run };

// ---------------------------------------------------------------------------
// Standalone mode
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const result = await run();

    if (result.status !== 'success') {
      await sendNotification(result.status, result.sources);
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
