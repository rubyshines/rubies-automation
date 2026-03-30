#!/usr/bin/env node

/**
 * RUBIES — Weekly Delivery Times Digest
 *
 * Sends a SendGrid email showing delivery time stats by country/region
 * for the last 7 days and last 30 days.
 *
 * Usage:
 *   node customer-service/alerts/weeklyDeliveryDigest.js
 *   npm run cs-delivery-digest
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient } = require('../../shared/supabaseClient');
const { getSendgridClient } = require('../../shared/sendgridClient');

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pad(str, len) {
  return String(str).padEnd(len);
}

function rpad(str, len) {
  return String(str).padStart(len);
}

async function fetchStats(supabase, since) {
  const { data, error } = await supabase.rpc('get_delivery_time_stats', {
    p_since: since,
  });
  if (error) throw new Error(`RPC failed: ${error.message}`);
  return data || [];
}

async function fetchPassportLegs(supabase, since) {
  const { data, error } = await supabase.rpc('get_passport_leg_stats', {
    p_since: since,
  });
  if (error) throw new Error(`Passport leg stats failed: ${error.message}`);
  return data || [];
}

function formatStatsTable(stats) {
  if (!stats.length) return '  No delivery data for this period.\n';

  // Group by zone, then by country/region
  const byZone = {};
  for (const row of stats) {
    const zone = row.shipping_zone || 'unknown';
    if (!byZone[zone]) byZone[zone] = [];
    byZone[zone].push(row);
  }

  const lines = [];
  const header = `${pad('Destination', 28)} ${rpad('Orders', 6)}  ${rpad('Median', 6)}  ${rpad('P75', 5)}  ${rpad('P90', 5)}`;
  lines.push(header);
  lines.push('\u2500'.repeat(header.length));

  const zoneOrder = ['us', 'canada', 'ddp', 'ddu'];
  const zoneLabels = { us: 'US', canada: 'Canada', ddp: 'DDP (Intl)', ddu: 'DDU (Intl)' };

  for (const zone of zoneOrder) {
    const rows = byZone[zone];
    if (!rows) continue;

    lines.push(`\n  ${zoneLabels[zone] || zone}`);

    // Sort by order count desc
    rows.sort((a, b) => b.order_count - a.order_count);

    for (const row of rows) {
      const label = row.region_label || row.region || row.country_code || '?';
      const dest = `    ${label}`.slice(0, 28);
      lines.push(
        `${pad(dest, 28)} ${rpad(row.order_count, 6)}  ${rpad(Math.round(row.median_days) + 'd', 6)}  ${rpad(Math.round(row.p75_days) + 'd', 5)}  ${rpad(Math.round(row.p90_days) + 'd', 5)}`
      );
    }
  }

  return lines.join('\n');
}

function formatPassportLegs(legs) {
  if (!legs.length) return '';

  const lines = [
    '',
    'Passport Transit Breakdown (Nitro -> Passport -> Delivery):',
    `${pad('Country', 20)} ${rpad('Orders', 6)}  ${rpad('Leg1', 5)}  ${rpad('Leg2', 5)}  ${pad('Local Carrier', 18)}`,
    '\u2500'.repeat(60),
  ];

  legs.sort((a, b) => b.order_count - a.order_count);

  for (const leg of legs) {
    if (leg.order_count < 3) continue;
    lines.push(
      `${pad(leg.country_code || '?', 20)} ${rpad(leg.order_count, 6)}  ${rpad(Math.round(leg.median_leg1) + 'd', 5)}  ${rpad(Math.round(leg.median_leg2) + 'd', 5)}  ${pad(leg.local_carrier || '-', 18)}`
    );
  }

  return lines.length > 4 ? lines.join('\n') : '';
}

async function run() {
  console.log('RUBIES Weekly Delivery Digest — starting');
  const supabase = getSupabaseClient();

  const since7 = daysAgo(7);
  const since30 = daysAgo(30);

  const [stats7, stats30, legs30] = await Promise.all([
    fetchStats(supabase, since7),
    fetchStats(supabase, since30),
    fetchPassportLegs(supabase, since30),
  ]);

  // Build email body
  const sections = [
    `RUBIES Delivery Times Digest — ${todayDate()}`,
    '='.repeat(50),
    '',
    'LAST 7 DAYS',
    '-'.repeat(50),
    formatStatsTable(stats7),
    '',
    'LAST 30 DAYS',
    '-'.repeat(50),
    formatStatsTable(stats30),
  ];

  const passportSection = formatPassportLegs(legs30);
  if (passportSection) {
    sections.push('', passportSection);
  }

  // Totals
  const total7 = stats7.reduce((s, r) => s + r.order_count, 0);
  const total30 = stats30.reduce((s, r) => s + r.order_count, 0);
  sections.push('', `Total delivered: ${total7} (7d) / ${total30} (30d)`);

  const text = sections.join('\n');
  console.log(text);

  // Send email
  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.log('Skipping email (no SendGrid client).');
    return { sent: false, total7, total30 };
  }

  try {
    await sgMail.send({
      to: 'jamie@rubyshines.com',
      from: 'pipeline@rubyshines.com',
      subject: `\uD83D\uDCE6 RUBIES Delivery Times — Week of ${todayDate()}`,
      text,
    });
    console.log('Digest email sent.');
  } catch (err) {
    console.error('Failed to send email:', err.message);
  }

  return { sent: true, total7, total30 };
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(e => { console.error('Error:', e.message); process.exit(1); });
}

module.exports = { run };
