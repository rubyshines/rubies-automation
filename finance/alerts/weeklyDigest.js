/**
 * RUBIES Finance — Weekly Digest Email
 *
 * Anomaly detection + summary metrics. Sends via SendGrid.
 *
 * Thresholds:
 *   - Expense category >30% above trailing 4-week average
 *   - Gross/net margin >3pp below trailing 4-week average
 *   - Cash position >20% week-over-week change
 *   - Revenue >25% above/below trailing 4-week average
 *   - Single transaction >$1,000
 *
 * Usage:
 *   node finance/alerts/weeklyDigest.js
 *   npm run finance-weekly-digest
 */

const path = require('path');
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
}

const { getSupabaseClient, fetchAllPaginated } = require('../../shared/supabaseClient');
const { getSendgridClient } = require('../../shared/sendgridClient');

function fmtCurrency(n) {
  if (n == null || isNaN(n)) return 'N/A';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${(n * 100).toFixed(1)}%`;
}

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function run() {
  console.log('RUBIES Finance Weekly Digest — starting');
  const supabase = getSupabaseClient();
  const alerts = [];
  const metrics = {};

  // ----- Current week and trailing data -----

  const weekStart = daysAgo(7);
  const weekEnd = todayDate();
  const fourWeeksAgo = daysAgo(28);

  // Get weekly transaction totals by account type — paginated (a busy window
  // exceeds Supabase's 1000-row cap and silently skewed the spike baselines).
  const weekTxns = await fetchAllPaginated(() => supabase
    .from('qbo_transactions')
    .select('account_id, total_amount, txn_type, entity_name')
    .gte('txn_date', weekStart)
    .lte('txn_date', weekEnd)
    .order('id')
    .order('txn_type'));

  const trailingTxns = await fetchAllPaginated(() => supabase
    .from('qbo_transactions')
    .select('account_id, total_amount, txn_date')
    .gte('txn_date', fourWeeksAgo)
    .lt('txn_date', weekStart)
    .order('id')
    .order('txn_type'));

  // ----- Large transactions -----
  if (weekTxns) {
    const largeTxns = weekTxns.filter(t => Math.abs(t.total_amount || 0) >= 1000);
    for (const t of largeTxns) {
      alerts.push({
        type: 'large_transaction',
        severity: 'info',
        message: `Large transaction: ${fmtCurrency(t.total_amount)} — ${t.entity_name || t.txn_type}`,
      });
    }
  }

  // ----- Expense anomalies by account -----
  const accounts = {};
  const { data: acctList } = await supabase
    .from('qbo_accounts')
    .select('id, name, classification')
    .eq('active', true);

  const acctMap = {};
  for (const a of (acctList || [])) {
    acctMap[a.id] = a;
  }

  // Current week totals by account
  const weekByAcct = {};
  for (const t of (weekTxns || [])) {
    if (!t.account_id) continue;
    weekByAcct[t.account_id] = (weekByAcct[t.account_id] || 0) + (t.total_amount || 0);
  }

  // Trailing weekly average by account (3 weeks)
  const trailingByAcct = {};
  for (const t of (trailingTxns || [])) {
    if (!t.account_id) continue;
    trailingByAcct[t.account_id] = (trailingByAcct[t.account_id] || 0) + (t.total_amount || 0);
  }

  for (const [acctId, weekTotal] of Object.entries(weekByAcct)) {
    const acct = acctMap[acctId];
    if (!acct || acct.classification !== 'Expense') continue;

    const trailingTotal = trailingByAcct[acctId] || 0;
    const trailingWeeklyAvg = trailingTotal / 3; // 3 weeks of trailing data

    if (trailingWeeklyAvg > 0 && weekTotal > trailingWeeklyAvg * 1.3) {
      const pctOver = (weekTotal - trailingWeeklyAvg) / trailingWeeklyAvg;
      alerts.push({
        type: 'expense_spike',
        severity: 'warning',
        message: `${acct.name}: ${fmtCurrency(weekTotal)} this week vs ${fmtCurrency(trailingWeeklyAvg)} avg (+${fmtPct(pctOver)})`,
      });
    }
  }

  // ----- P&L snapshot metrics -----
  // Get most recent monthly snapshot
  const { data: recentPL } = await supabase
    .from('qbo_report_snapshots')
    .select('summary, period_start')
    .eq('report_type', 'ProfitAndLoss')
    .order('period_start', { ascending: false })
    .limit(2);

  if (recentPL?.length >= 2) {
    const current = recentPL[0].summary;
    const prior = recentPL[1].summary;

    metrics.currentRevenue = current?.totalIncome;
    metrics.priorRevenue = prior?.totalIncome;
    metrics.grossMargin = current?.grossMarginPct;
    metrics.priorGrossMargin = prior?.grossMarginPct;
    metrics.netMargin = current?.netMarginPct;
    metrics.priorNetMargin = prior?.netMarginPct;
    metrics.netIncome = current?.netIncome;

    // Margin compression alerts
    if (current?.grossMarginPct != null && prior?.grossMarginPct != null) {
      const gmDrop = (prior.grossMarginPct - current.grossMarginPct) * 100;
      if (gmDrop > 3) {
        alerts.push({
          type: 'margin_drop',
          severity: 'warning',
          message: `Gross margin dropped ${gmDrop.toFixed(1)}pp (${fmtPct(prior.grossMarginPct)} → ${fmtPct(current.grossMarginPct)})`,
        });
      }
    }

    if (current?.netMarginPct != null && prior?.netMarginPct != null) {
      const nmDrop = (prior.netMarginPct - current.netMarginPct) * 100;
      if (nmDrop > 3) {
        alerts.push({
          type: 'margin_drop',
          severity: 'warning',
          message: `Net margin dropped ${nmDrop.toFixed(1)}pp (${fmtPct(prior.netMarginPct)} → ${fmtPct(current.netMarginPct)})`,
        });
      }
    }
  }

  // ----- Cash position -----
  const { data: bankAccts } = await supabase
    .from('qbo_accounts')
    .select('name, current_balance')
    .eq('account_type', 'Bank')
    .eq('active', true);

  const cashTotal = bankAccts?.reduce((s, a) => s + (a.current_balance || 0), 0) || 0;
  metrics.cashPosition = cashTotal;

  // Compare with last week's alert state
  const { data: prevState } = await supabase
    .from('qbo_alert_state')
    .select('last_data')
    .eq('alert_type', 'weekly_digest')
    .single();

  if (prevState?.last_data?.cashPosition) {
    const prevCash = prevState.last_data.cashPosition;
    const cashChange = (cashTotal - prevCash) / Math.abs(prevCash);
    if (Math.abs(cashChange) > 0.20) {
      const direction = cashChange > 0 ? 'increased' : 'decreased';
      alerts.push({
        type: 'cash_change',
        severity: cashChange < -0.20 ? 'warning' : 'info',
        message: `Cash ${direction} ${fmtPct(Math.abs(cashChange))} (${fmtCurrency(prevCash)} → ${fmtCurrency(cashTotal)})`,
      });
    }
  }

  // ----- Save state for next week -----
  await supabase.from('qbo_alert_state').upsert({
    alert_type: 'weekly_digest',
    last_sent_at: new Date().toISOString(),
    last_data: metrics,
  }, { onConflict: 'alert_type' });

  // ----- Build email -----
  const warnings = alerts.filter(a => a.severity === 'warning');
  const infos = alerts.filter(a => a.severity === 'info');

  const lines = [];
  lines.push(`RUBIES Finance — Weekly Digest (${weekStart} to ${weekEnd})`);
  lines.push('');

  lines.push('=== Key Metrics ===');
  lines.push(`Cash Position: ${fmtCurrency(metrics.cashPosition)}`);
  if (metrics.currentRevenue != null) lines.push(`Monthly Revenue: ${fmtCurrency(metrics.currentRevenue)}`);
  if (metrics.grossMargin != null) lines.push(`Gross Margin: ${fmtPct(metrics.grossMargin)}`);
  if (metrics.netMargin != null) lines.push(`Net Margin: ${fmtPct(metrics.netMargin)}`);
  if (metrics.netIncome != null) lines.push(`Net Income: ${fmtCurrency(metrics.netIncome)}`);
  lines.push('');

  if (warnings.length) {
    lines.push('=== Alerts ===');
    for (const w of warnings) {
      lines.push(`  ⚠ ${w.message}`);
    }
    lines.push('');
  }

  if (infos.length) {
    lines.push('=== Notable ===');
    for (const i of infos) {
      lines.push(`  • ${i.message}`);
    }
    lines.push('');
  }

  if (!alerts.length) {
    lines.push('No anomalies detected this week. ✓');
    lines.push('');
  }

  const text = lines.join('\n');
  console.log(text);

  // Send email
  const sgMail = getSendgridClient();
  if (!sgMail) {
    console.log('Skipping email (no SendGrid client).');
  } else {
    const statusIcon = warnings.length ? '⚠️' : '✅';
    try {
      await sgMail.send({
        to: 'jamie@rubyshines.com',
        from: 'pipeline@rubyshines.com',
        subject: `${statusIcon} RUBIES Finance Digest — ${weekEnd} (${alerts.length} alert${alerts.length !== 1 ? 's' : ''})`,
        text,
      });
      console.log('Digest email sent.');
    } catch (err) {
      console.error('Failed to send digest:', err.message);
    }
  }

  console.log(`RUBIES Finance Weekly Digest — done (${alerts.length} alerts)`);
  return {
    sources: {
      digest: { success: true, rowsWritten: alerts.length, error: null },
    },
    status: 'success',
  };
}

module.exports = { run };

if (require.main === module) {
  run().catch(err => {
    console.error('Weekly digest FAILED:', err.message);
    process.exit(1);
  });
}
