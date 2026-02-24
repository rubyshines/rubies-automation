/**
 * utils.js
 * Helper functions for date formatting and duplicate run detection.
 */

/**
 * Format any Date object as a YYYY-MM-DD string.
 * Uses local timezone (not UTC) so the date matches what you'd see on your calendar.
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get today's date as a YYYY-MM-DD string.
 */
function getTodayDate() {
  return formatDate(new Date());
}

/**
 * Get tomorrow's date as a YYYY-MM-DD string.
 */
function getTomorrowDate() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return formatDate(tomorrow);
}

/**
 * Get yesterday's date as a YYYY-MM-DD string.
 * Used as the default "report date" so a run at 5 AM captures the previous full day.
 */
function getYesterdayDate() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return formatDate(yesterday);
}

/**
 * Compare two YYYY-MM-DD strings and return true if they represent the same day.
 */
function isSameDate(dateString1, dateString2) {
  if (!dateString1 || !dateString2) return false;
  // Simple string comparison works perfectly for YYYY-MM-DD format
  return dateString1.trim() === dateString2.trim();
}

/**
 * Get a YYYY-MM-DD date string for N days ago.
 * Used when building date ranges for API requests.
 */
function getDaysAgoDate(daysAgo) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return formatDate(date);
}

/**
 * Add N days to a YYYY-MM-DD date string; returns YYYY-MM-DD.
 * Used for backfill: iterate from (lastRunDate + 1) through yesterday.
 */
function addDays(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

/**
 * Return the last 365 days as a date range (inclusive).
 * endDate = yesterday; startDate = 364 days before that (365 days total).
 * Used by the 365-day summary script.
 * @returns {{ startDate: string, endDate: string }} YYYY-MM-DD
 */
function getDateRangeLast365() {
  const endDate = getYesterdayDate();
  const startDate = addDays(endDate, -364);
  return { startDate, endDate };
}

module.exports = {
  formatDate,
  getTodayDate,
  getTomorrowDate,
  getYesterdayDate,
  isSameDate,
  getDaysAgoDate,
  addDays,
  getDateRangeLast365,
};
