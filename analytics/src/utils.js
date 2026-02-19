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

module.exports = {
  formatDate,
  getTodayDate,
  getTomorrowDate,
  isSameDate,
  getDaysAgoDate,
};
