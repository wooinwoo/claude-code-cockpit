// ─── Dashboard Charts: Chart.js charts, usage dashboard, cost rendering ───
import { app } from './state.js';
import { esc, fmtTok, timeUntil, row, fetchJson, showToast } from './utils.js';

// ─── Charts ───
export function setChartPeriod(days) {
  app.chartPeriod = days;
  localStorage.setItem('dl-chart-period', days);
  document.querySelectorAll('.chart-period button').forEach(b => b.classList.toggle('active', parseInt(b.textContent) === days));
  const lbl = document.getElementById('chart-period-label');
  if (lbl) lbl.textContent = `(${days}d)`;
  renderCosts();
}

let _chartLoading = false;
let _chartLoaded = typeof Chart !== 'undefined';

function ensureChartJS() {
  if (_chartLoaded) return Promise.resolve();
  if (_chartLoading) return _chartLoading;
  _chartLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/chart.min.js';
    s.onload = () => { _chartLoaded = true; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _chartLoading;
}

export function renderCosts() {
  const u = app.state.usage;
  if (!u?.daily) return;
  if (!_chartLoaded) { ensureChartJS().then(() => renderCosts()); return; }
  const allDaily = u.daily;
  const daily = allDaily.slice(-app.chartPeriod);
  const labels = daily.map(d => d.date?.slice(5) || '');
  const tokens = daily.map(d => d.outputTokens || 0);
  const chartColors = { line: '#818cf8', fill: 'rgba(129,140,248,.08)', grid: 'rgba(255,255,255,.03)', tick: '#565868' };
  if (app.dailyChart) {
    app.dailyChart.data.labels = labels;
    app.dailyChart.data.datasets[0].data = tokens;
    app.dailyChart.update('none');
  } else {
    app.dailyChart = new Chart(document.getElementById('daily-chart'), {
      type: 'line',
      data: { labels, datasets: [{ data: tokens, borderColor: chartColors.line, backgroundColor: chartColors.fill, fill: true, tension: 0.3, borderWidth: 2, pointRadius: 1.5, pointHoverRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: chartColors.tick, font: { size: 9 } }, grid: { color: chartColors.grid } }, y: { ticks: { color: chartColors.tick, callback: v => fmtTok(v), font: { size: 9 } }, grid: { color: chartColors.grid } } } },
    });
  }
  const mm = {};
  daily.forEach(d => (d.modelBreakdowns || []).forEach(m => { const n = m.modelName || '?'; mm[n] = (mm[n] || 0) + (m.outputTokens || 0); }));
  if (app.modelChart) {
    app.modelChart.data.labels = Object.keys(mm);
    app.modelChart.data.datasets[0].data = Object.values(mm);
    app.modelChart.update('none');
  } else {
    app.modelChart = new Chart(document.getElementById('model-chart'), {
      type: 'doughnut',
      data: { labels: Object.keys(mm), datasets: [{ data: Object.values(mm), backgroundColor: ['#818cf8', '#34d399', '#fbbf24', '#f87171', '#60a5fa'], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { color: '#9395a5', font: { size: 10 }, padding: 8 } } }, tooltip: { callbacks: { label: ctx => fmtTok(ctx.raw) + ' tok' } } },
    });
  }
}

// ─── Usage Dashboard ───
export function fetchUsage() {
  fetchJson('/api/usage').then(data => {
    app.state.usage = data;
    app._usageLastUpdated = Date.now();
    app._usageRetryCount = 0;
    renderUsage();
    renderCosts();
    updateUsageTimestamp();
  }).catch(err => {
    app._usageRetryCount++;
    if (app._usageRetryCount <= 3) {
      console.warn(`[Usage] Retry ${app._usageRetryCount}/3: ${err.message}`);
      setTimeout(fetchUsage, 5000 * app._usageRetryCount);
    }
    updateUsageTimestamp();
  });
}

export function renderUsage() {
  const u = app.state.usage;
  if (!u) return;
  const t = u.today || {};
  const w = u.week || {};
  const $ = id => document.getElementById(id);
  const set = (id, val) => { const e = $(id); if (e) e.textContent = val; };
  const setHtml = (id, val) => { const e = $(id); if (e) e.innerHTML = val; };
  set('today-output', fmtTok(t.outputTokens || 0));
  set('today-msgs', t.messages || 0);
  set('stat-today', fmtTok(t.outputTokens || 0));
  set('uc-today-date', t.date || '');
  set('uc-today-output', fmtTok(t.outputTokens || 0) + ' tok');
  setHtml('uc-today-stats', [row('Messages', t.messages || 0), row('Sessions', t.sessions || 0), row('Tool Calls', t.toolCalls || 0)].join(''));
  const todayModels = t.models || {};
  const totalOut = t.outputTokens || 1;
  const mEntries = Object.entries(todayModels).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0));
  setHtml('uc-today-models', mEntries.length ? mEntries.map(([name, m]) => { const pct = ((m.outputTokens || 0) / totalOut * 100).toFixed(1); return `<div class="uc-model-row"><span class="name">${esc(name)}</span><span class="val">${fmtTok(m.outputTokens || 0)}<span class="pct">(${pct}%)</span></span></div>`; }).join('') : '');
  set('uc-today-cost', `API Equiv. ~$${(t.apiEquivCost || 0).toFixed(2)}`);
  set('uc-week-output', fmtTok(w.outputTokens || 0) + ' tok');
  if (w.resetAt) set('uc-week-reset', `resets ${timeUntil(w.resetAt)}`);
  setHtml('uc-week-stats', [row('Messages', w.messages || 0)].join(''));
  const weekModels = w.models || {};
  const wmEntries = Object.entries(weekModels).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0));
  setHtml('uc-week-models', wmEntries.length ? wmEntries.map(([name, m]) => `<div class="uc-model-row"><span class="name">${esc(name)}</span><span class="val">${fmtTok(m.outputTokens || 0)}</span></div>`).join('') : '');
  set('uc-week-cost', `API Equiv. ~$${(w.apiEquivCost || 0).toFixed(2)}`);
  setHtml('uc-overview-stats', [row('Total Sessions', t.sessions || 0), row('Cache Read', fmtTok(t.cacheReadTokens || 0) + ' tok'), row('Cache Write', fmtTok(t.cacheCreationTokens || 0) + ' tok'), row('Input Tokens', fmtTok(t.inputTokens || 0))].join(''));
  const daily = u.daily || [];
  const allTimeCost = daily.reduce((s, d) => s + (d.totalCost || 0), 0);
  set('uc-plan-info', `30-day API equiv: ~$${allTimeCost.toFixed(2)}`);
}

export function updateUsageTimestamp() {
  let el = document.getElementById('usage-last-updated');
  if (!el) {
    const container = document.querySelector('.usage-section .section-header') || document.querySelector('.usage-grid');
    if (container) {
      el = document.createElement('span');
      el.id = 'usage-last-updated';
      el.style.cssText = 'font-size:.7rem;color:var(--text-3);margin-left:auto;cursor:pointer';
      el.title = 'Click to refresh';
      el.addEventListener('click', () => fetchUsage());
      container.appendChild(el);
    }
  }
  if (el) {
    if (app._usageLastUpdated) {
      const ago = Math.round((Date.now() - app._usageLastUpdated) / 1000);
      el.textContent = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
      el.style.color = ago > 300 ? 'var(--yellow)' : 'var(--text-3)';
    } else if (app._usageRetryCount > 0) {
      el.textContent = `error (retry ${app._usageRetryCount})`;
      el.style.color = 'var(--red)';
    }
  }
}
