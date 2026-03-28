/**
 * Shared helpers for finance MCP tools
 */

// ---------------------------------------------------------------------------
// Period parsing — natural language → { startDate, endDate, label }
// ---------------------------------------------------------------------------

function parsePeriod(periodStr) {
  const now = new Date();
  const input = (periodStr || '').trim().toLowerCase();

  // Full year: "2025"
  const yearMatch = input.match(/^(\d{4})$/);
  if (yearMatch) {
    const y = yearMatch[1];
    return { startDate: `${y}-01-01`, endDate: `${y}-12-31`, label: y };
  }

  // Quarter: "Q1 2025", "q3 2025"
  const qMatch = input.match(/^q([1-4])\s*(\d{4})$/);
  if (qMatch) {
    const q = parseInt(qMatch[1], 10);
    const y = qMatch[2];
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const endDay = new Date(parseInt(y, 10), endMonth, 0).getDate();
    return {
      startDate: `${y}-${pad(startMonth)}-01`,
      endDate: `${y}-${pad(endMonth)}-${pad(endDay)}`,
      label: `Q${q} ${y}`,
    };
  }

  // Month + year: "March 2025", "jan 2026", "2025-03"
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];
  const shortMonths = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
    'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  const monthYearMatch = input.match(/^(\w+)\s+(\d{4})$/);
  if (monthYearMatch) {
    const monthName = monthYearMatch[1];
    const y = parseInt(monthYearMatch[2], 10);
    let m = monthNames.indexOf(monthName);
    if (m === -1) m = shortMonths.indexOf(monthName);
    if (m !== -1) {
      const endDay = new Date(y, m + 1, 0).getDate();
      return {
        startDate: `${y}-${pad(m + 1)}-01`,
        endDate: `${y}-${pad(m + 1)}-${pad(endDay)}`,
        label: `${monthNames[m].charAt(0).toUpperCase() + monthNames[m].slice(1)} ${y}`,
      };
    }
  }

  // YYYY-MM format
  const ymMatch = input.match(/^(\d{4})-(\d{2})$/);
  if (ymMatch) {
    const y = parseInt(ymMatch[1], 10);
    const m = parseInt(ymMatch[2], 10);
    const endDay = new Date(y, m, 0).getDate();
    return {
      startDate: `${ymMatch[1]}-${ymMatch[2]}-01`,
      endDate: `${ymMatch[1]}-${ymMatch[2]}-${pad(endDay)}`,
      label: `${monthNames[m - 1].charAt(0).toUpperCase() + monthNames[m - 1].slice(1)} ${y}`,
    };
  }

  // "last N days/months"
  const lastMatch = input.match(/^last\s+(\d+)\s+(day|days|month|months|week|weeks)$/);
  if (lastMatch) {
    const n = parseInt(lastMatch[1], 10);
    const unit = lastMatch[2].replace(/s$/, '');
    const end = new Date(now);
    const start = new Date(now);
    if (unit === 'day') start.setDate(start.getDate() - n);
    else if (unit === 'week') start.setDate(start.getDate() - n * 7);
    else if (unit === 'month') start.setMonth(start.getMonth() - n);
    return {
      startDate: formatDate(start),
      endDate: formatDate(end),
      label: `Last ${n} ${lastMatch[2]}`,
    };
  }

  // "last quarter"
  if (input === 'last quarter') {
    const curQ = Math.floor(now.getMonth() / 3);
    const prevQ = curQ === 0 ? 3 : curQ - 1;
    const y = curQ === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const startMonth = prevQ * 3 + 1;
    const endMonth = startMonth + 2;
    const endDay = new Date(y, endMonth, 0).getDate();
    return {
      startDate: `${y}-${pad(startMonth)}-01`,
      endDate: `${y}-${pad(endMonth)}-${pad(endDay)}`,
      label: `Q${prevQ + 1} ${y}`,
    };
  }

  // "last year"
  if (input === 'last year') {
    const y = now.getFullYear() - 1;
    return { startDate: `${y}-01-01`, endDate: `${y}-12-31`, label: String(y) };
  }

  // "this year" / "YTD" / "year to date"
  if (input === 'this year' || input === 'ytd' || input === 'year to date') {
    const y = now.getFullYear();
    return { startDate: `${y}-01-01`, endDate: formatDate(now), label: `${y} YTD` };
  }

  // "this quarter"
  if (input === 'this quarter') {
    const q = Math.floor(now.getMonth() / 3) + 1;
    const y = now.getFullYear();
    const startMonth = (q - 1) * 3 + 1;
    return {
      startDate: `${y}-${pad(startMonth)}-01`,
      endDate: formatDate(now),
      label: `Q${q} ${y}`,
    };
  }

  // "this month"
  if (input === 'this month') {
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    return {
      startDate: `${y}-${pad(m)}-01`,
      endDate: formatDate(now),
      label: `${monthNames[m - 1].charAt(0).toUpperCase() + monthNames[m - 1].slice(1)} ${y}`,
    };
  }

  // Date range: "2025-01-01 to 2025-06-30"
  const rangeMatch = input.match(/^(\d{4}-\d{2}-\d{2})\s*(?:to|—|-|–)\s*(\d{4}-\d{2}-\d{2})$/);
  if (rangeMatch) {
    return {
      startDate: rangeMatch[1],
      endDate: rangeMatch[2],
      label: `${rangeMatch[1]} to ${rangeMatch[2]}`,
    };
  }

  // Fallback: assume it's a year or passthrough
  return {
    startDate: `${now.getFullYear()}-01-01`,
    endDate: formatDate(now),
    label: periodStr || `${now.getFullYear()} YTD`,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtCurrency(n) {
  if (n == null || isNaN(n)) return 'N/A';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1000) {
    return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return 'N/A';
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDelta(current, previous) {
  if (current == null || previous == null) return { dollar: 'N/A', pct: 'N/A' };
  const delta = current - previous;
  const pct = previous !== 0 ? delta / Math.abs(previous) : null;
  return {
    dollar: fmtCurrency(delta),
    pct: pct != null ? fmtPct(pct) : 'N/A',
    isIncrease: delta > 0,
  };
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Simple sparkline from array of numbers
function sparkline(values) {
  if (!values || values.length < 2) return '';
  const chars = '▁▂▃▄▅▆▇█';
  const min = Math.min(...values.filter(v => v != null));
  const max = Math.max(...values.filter(v => v != null));
  const range = max - min || 1;
  return values
    .map(v => v == null ? ' ' : chars[Math.round(((v - min) / range) * (chars.length - 1))])
    .join('');
}

module.exports = {
  parsePeriod,
  fmtCurrency,
  fmtPct,
  fmtDelta,
  formatDate,
  sparkline,
};
