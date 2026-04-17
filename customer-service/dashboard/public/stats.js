// Stats page — CS Advisor performance analytics

let currentStatsTab = 'today';
let currentRange = 30;
let qualityChart = null;
let volumeChart = null;
let categoriesChart = null;
let todayTickets = [];
let sortCol = null;
let sortAsc = true;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function formatDateET(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
}

function formatFocusTime(seconds) {
  if (seconds == null || seconds === 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function scoreColor(s) {
  if (s >= 8) return 'var(--green)';
  if (s >= 6) return 'var(--yellow)';
  return 'var(--red)';
}

function formatScore(score, postSteerScore) {
  const main = `<span style="color:${scoreColor(score)}">${score}</span>`;
  if (postSteerScore != null) {
    return `${main} <span style="color:var(--text-tertiary)">→</span> <span style="color:${scoreColor(postSteerScore)}">${postSteerScore}</span>`;
  }
  return main;
}

function parsePct(pctStr) {
  if (!pctStr || pctStr === 'N/A') return null;
  return parseFloat(pctStr);
}

function dateRange(days) {
  const end = todayET();
  const start = new Date();
  start.setDate(start.getDate() - days);
  return {
    start: start.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    end,
  };
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function switchTab(tab) {
  currentStatsTab = tab;
  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-content').forEach(el => {
    el.classList.toggle('active', el.id === `tab-${tab}`);
  });
  if (tab === 'trends' && !qualityChart) loadTrends();
}

// ---------------------------------------------------------------------------
// Today tab
// ---------------------------------------------------------------------------

async function loadToday() {
  const date = todayET();
  document.getElementById('header-date').textContent = formatDateET(date);

  try {
    const [daily, tickets] = await Promise.all([
      api(`/api/stats/daily?date=${date}`),
      api(`/api/stats/tickets?date=${date}`),
    ]);
    renderKPIs(daily);
    todayTickets = tickets.tickets || [];
    renderTicketsTable();
  } catch (err) {
    console.error('Failed to load today stats:', err);
    document.getElementById('today-empty').textContent = 'Failed to load stats';
  }
}

function renderKPIs(data) {
  // Tickets handled (+ filtered note if any)
  const handledStr = data.filtered_count
    ? `${data.tickets_handled || 0} <span class="kpi-note">+${data.filtered_count} filtered</span>`
    : `${data.tickets_handled || 0}`;
  document.getElementById('kpi-handled-val').innerHTML = handledStr;

  // Quality score
  const scoreEl = document.getElementById('kpi-score');
  const scoreVal = document.getElementById('kpi-score-val');
  const scoreSub = document.getElementById('kpi-score-sub');
  scoreEl.className = 'kpi-card';
  if (data.avg_quality_score != null) {
    scoreVal.textContent = data.avg_quality_score.toFixed(1);
    scoreSub.textContent = 'out of 10';
    if (data.avg_quality_score >= 8) scoreEl.classList.add('kpi-green');
    else if (data.avg_quality_score >= 6) scoreEl.classList.add('kpi-yellow');
    else scoreEl.classList.add('kpi-red');
  } else {
    scoreVal.textContent = '—';
    scoreSub.textContent = '';
  }

  // No-edit rate
  const noEditPct = parsePct(data.no_edit_rate);
  const noEditEl = document.getElementById('kpi-noedit');
  const noEditVal = document.getElementById('kpi-noedit-val');
  noEditVal.textContent = data.no_edit_rate || '—';
  noEditEl.className = 'kpi-card';
  if (noEditPct != null) {
    if (noEditPct > 80) noEditEl.classList.add('kpi-green');
    else if (noEditPct >= 60) noEditEl.classList.add('kpi-yellow');
    else noEditEl.classList.add('kpi-red');
  }

  // Redirect rate
  const redirectPct = parsePct(data.redirect_rate);
  const redirectEl = document.getElementById('kpi-redirect');
  const redirectVal = document.getElementById('kpi-redirect-val');
  redirectVal.textContent = data.redirect_rate || '—';
  redirectEl.className = 'kpi-card';
  if (redirectPct != null) {
    if (redirectPct < 10) redirectEl.classList.add('kpi-green');
    else if (redirectPct <= 20) redirectEl.classList.add('kpi-yellow');
    else redirectEl.classList.add('kpi-red');
  }

  // Focus time
  document.getElementById('kpi-focus-val').textContent = formatFocusTime(data.avg_focus_time_seconds);
}

function renderTicketsTable() {
  const wrap = document.getElementById('tickets-table-wrap');

  if (todayTickets.length === 0) {
    wrap.innerHTML = '<div class="empty-state">No tickets handled today yet</div>';
    return;
  }

  // Sort
  let rows = [...todayTickets];
  if (sortCol) {
    rows.sort((a, b) => {
      let va = a[sortCol] ?? '';
      let vb = b[sortCol] ?? '';
      if (typeof va === 'number' && typeof vb === 'number') return sortAsc ? va - vb : vb - va;
      va = String(va).toLowerCase();
      vb = String(vb).toLowerCase();
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
  }

  const outcomeBadge = (o) => {
    const map = {
      no_edit: ['No Edit', 'badge-noedit'],
      edited: ['Edited', 'badge-edited'],
      redirected: ['Redirected', 'badge-redirected'],
      released: ['Released', 'badge-released'],
      closed_no_reply: ['Closed', 'badge-closed'],
      spam: ['Spam', 'badge-closed'],
      deleted: ['Deleted', 'badge-closed'],
    };
    const [label, cls] = map[o] || [o, 'badge-released'];
    return `<span class="badge ${cls}">${label}</span>`;
  };

  const sortArrow = (col) => {
    if (sortCol !== col) return '';
    return `<span class="sort-arrow">${sortAsc ? '▲' : '▼'}</span>`;
  };

  const thClass = (col) => sortCol === col ? 'sorted' : '';

  wrap.innerHTML = `
    <table class="stats-table">
      <thead>
        <tr>
          <th class="${thClass('gorgias_ticket_id')}" onclick="sortTable('gorgias_ticket_id')">Ticket ${sortArrow('gorgias_ticket_id')}</th>
          <th class="${thClass('message_type')}" onclick="sortTable('message_type')">Type ${sortArrow('message_type')}</th>
          <th class="${thClass('outcome')}" onclick="sortTable('outcome')">Outcome ${sortArrow('outcome')}</th>
          <th class="${thClass('haiku_score')}" onclick="sortTable('haiku_score')">Score ${sortArrow('haiku_score')}</th>
          <th class="${thClass('focus_time_seconds')}" onclick="sortTable('focus_time_seconds')">Focus Time ${sortArrow('focus_time_seconds')}</th>
          <th class="${thClass('haiku_category')}" onclick="sortTable('haiku_category')">Category ${sortArrow('haiku_category')}</th>
          <th>Summary</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(t => `
          <tr>
            <td><a class="ticket-link" href="https://rubies.gorgias.com/app/ticket/${t.gorgias_ticket_id}" target="_blank" rel="noopener">#${t.gorgias_ticket_id}</a></td>
            <td class="type-cell">${(t.message_type || '—').replace(/_/g, ' ')}</td>
            <td>${outcomeBadge(t.redirect_count > 0 ? 'redirected' : t.outcome)}</td>
            <td class="score-cell">${t.outcome === 'no_edit' ? '<span style="color:var(--green)">10</span>' : t.haiku_score != null ? formatScore(t.haiku_score, t.haiku_score_post_steer) : '—'}</td>
            <td class="focus-cell">${formatFocusTime(t.focus_time_seconds)}</td>
            <td>${t.haiku_category ? `<span class="cat-badge">${t.haiku_category.replace(/_/g, ' ')}</span>` : '—'}</td>
            <td class="summary-cell">${t.haiku_summary || '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function sortTable(col) {
  if (sortCol === col) {
    sortAsc = !sortAsc;
  } else {
    sortCol = col;
    sortAsc = true;
  }
  renderTicketsTable();
}

// ---------------------------------------------------------------------------
// Trends tab
// ---------------------------------------------------------------------------

function setRange(days) {
  currentRange = days;
  document.querySelectorAll('.range-btn').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.days) === days);
  });
  loadTrends();
}

async function loadTrends() {
  const { start, end } = dateRange(currentRange);

  try {
    const [range, categories] = await Promise.all([
      api(`/api/stats/range?start=${start}&end=${end}`),
      api(`/api/stats/categories?start=${start}&end=${end}`),
    ]);
    renderQualityChart(range.daily_breakdown || []);
    renderVolumeChart(range.daily_breakdown || []);
    renderCategoriesChart(categories);
  } catch (err) {
    console.error('Failed to load trends:', err);
  }
}

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          font: { family: "'DM Sans', sans-serif", size: 11, weight: 500 },
          color: '#78716c',
          boxWidth: 12,
          boxHeight: 12,
          borderRadius: 3,
          useBorderRadius: true,
          padding: 16,
        },
      },
      tooltip: {
        backgroundColor: '#1c1917',
        titleFont: { family: "'DM Sans', sans-serif", size: 12, weight: 600 },
        bodyFont: { family: "'DM Sans', sans-serif", size: 12 },
        cornerRadius: 8,
        padding: 10,
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          font: { family: "'DM Sans', sans-serif", size: 10 },
          color: '#a8a29e',
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 10,
        },
        border: { display: false },
      },
    },
  };
}

function renderQualityChart(days) {
  const ctx = document.getElementById('chart-quality').getContext('2d');
  if (qualityChart) qualityChart.destroy();

  const labels = days.map(d => formatDateET(d.date));
  const noEditData = days.map(d => parsePct(d.no_edit_rate));
  const redirectData = days.map(d => parsePct(d.redirect_rate));

  const defaults = chartDefaults();
  qualityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'No-Edit %',
          data: noEditData,
          borderColor: '#15803d',
          backgroundColor: 'rgba(21, 128, 61, 0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 5,
          borderWidth: 2,
        },
        {
          label: 'Redirect %',
          data: redirectData,
          borderColor: '#b91c1c',
          backgroundColor: 'rgba(185, 28, 28, 0.06)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 5,
          borderWidth: 2,
        },
      ],
    },
    options: {
      ...defaults,
      scales: {
        ...defaults.scales,
        y: {
          min: 0,
          max: 100,
          grid: { color: 'rgba(231, 229, 228, 0.6)' },
          ticks: {
            font: { family: "'DM Sans', sans-serif", size: 10 },
            color: '#a8a29e',
            callback: v => v + '%',
          },
          border: { display: false },
        },
      },
    },
  });
}

function renderVolumeChart(days) {
  const ctx = document.getElementById('chart-volume').getContext('2d');
  if (volumeChart) volumeChart.destroy();

  const labels = days.map(d => formatDateET(d.date));
  const data = days.map(d => d.tickets_handled || 0);

  const defaults = chartDefaults();
  volumeChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Tickets',
        data,
        backgroundColor: 'rgba(26, 143, 125, 0.7)',
        hoverBackgroundColor: '#1a8f7d',
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      ...defaults,
      plugins: {
        ...defaults.plugins,
        legend: { display: false },
      },
      scales: {
        ...defaults.scales,
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(231, 229, 228, 0.6)' },
          ticks: {
            font: { family: "'DM Sans', sans-serif", size: 10 },
            color: '#a8a29e',
            stepSize: 1,
          },
          border: { display: false },
        },
      },
    },
  });
}

const CATEGORY_COLORS = {
  wrong_action: '#b91c1c',
  wrong_tone: '#a16207',
  missing_info: '#2563eb',
  wrong_product: '#7c3aed',
  overcomplicated: '#0891b2',
  other: '#a8a29e',
};

function renderCategoriesChart(catData) {
  const card = document.getElementById('categories-card');
  if (!catData || !catData.categories || catData.categories.length === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  const ctx = document.getElementById('chart-categories').getContext('2d');
  if (categoriesChart) categoriesChart.destroy();

  const cats = catData.categories;
  const labels = cats.map(c => c.category.replace(/_/g, ' '));
  const data = cats.map(c => c.count);
  const colors = cats.map(c => CATEGORY_COLORS[c.category] || '#a8a29e');

  categoriesChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderWidth: 0,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '60%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c1917',
          titleFont: { family: "'DM Sans', sans-serif", size: 12, weight: 600 },
          bodyFont: { family: "'DM Sans', sans-serif", size: 12 },
          cornerRadius: 8,
          padding: 10,
        },
      },
    },
  });

  // Custom legend
  const legendEl = document.getElementById('donut-legend');
  legendEl.innerHTML = cats.map((c, i) => `
    <div class="legend-item">
      <div class="legend-dot" style="background: ${colors[i]}"></div>
      <span class="legend-label">${labels[i]}</span>
      <span class="legend-count">${c.count}</span>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadToday();
