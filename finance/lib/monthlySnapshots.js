/**
 * Shared helper for the P&L trend readers (runway, margin, trend).
 *
 * `qbo_report_snapshots` holds more than one snapshot shape under
 * report_type='ProfitAndLoss':
 *   - full calendar months (period_start = day 1, period_end = last day of the
 *     SAME month) — the real monthly series
 *   - rolling YTD / quarter spans (period_start..period_end cover many months)
 *   - the in-progress current month, which the daily sync re-writes with a new
 *     period_end (= today) every run, so the table accumulates one partial row
 *     per day for the current month
 *
 * Trend/burn calculations must run over ONE row per calendar month, so:
 *   1. keep only rows whose start and end fall in the same YYYY-MM (drops YTD,
 *      quarterly, annual spans),
 *   2. dedupe to the latest period_end per month (drops the daily duplicates of
 *      the in-progress month, keeping the most complete one).
 *
 * The month test compares the "YYYY-MM" string prefixes rather than parsing to
 * Date + getMonth(), which is timezone-proof (a date-only string parsed as UTC
 * shifts a day in negative-offset zones and can land in the wrong month).
 *
 * Callers must select `period_start` AND `period_end`.
 *
 * @param {Array<{period_start: string, period_end: string}>} snapshots
 * @returns {Array} one row per calendar month, ascending by period_start
 */
function filterMonthlySnapshots(snapshots) {
  const byMonth = new Map();
  for (const s of snapshots || []) {
    if (!s || !s.period_start || !s.period_end) continue;
    const startMonth = s.period_start.slice(0, 7);
    const endMonth = s.period_end.slice(0, 7);
    if (startMonth !== endMonth) continue; // spans more than one month → not a monthly snapshot
    const prev = byMonth.get(startMonth);
    if (!prev || s.period_end > prev.period_end) byMonth.set(startMonth, s);
  }
  return [...byMonth.values()].sort((a, b) =>
    a.period_start < b.period_start ? -1 : a.period_start > b.period_start ? 1 : 0
  );
}

module.exports = { filterMonthlySnapshots };
