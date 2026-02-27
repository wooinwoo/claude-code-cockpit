// ─── System Monitor Module ───
import { app } from './state.js';
import { esc } from './utils.js';

// ─── Init ───
export function initMonitor() {
  if (app._monitorInitialized) {
    if (app.monitorStats) renderMonitor();
    return;
  }
  app._monitorInitialized = true;
  loadMonitorStats();
  app._monitorTimer = setInterval(loadMonitorStats, 3000);
}

export function destroyMonitor() {
  if (app._monitorTimer) { clearInterval(app._monitorTimer); app._monitorTimer = null; }
}

export function toggleMonitorPause() {
  app._monitorPaused = !app._monitorPaused;
  const btn = document.getElementById('monitor-pause-btn');
  if (btn) {
    btn.title = app._monitorPaused ? 'Resume' : 'Pause';
    btn.classList.toggle('monitor-paused', app._monitorPaused);
    btn.innerHTML = app._monitorPaused
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  }
}

// ─── Load Stats ───
async function loadMonitorStats() {
  if (app._monitorPaused) return;
  try {
    const stats = await fetch('/api/monitor/stats').then(r => r.json());
    if (stats.error) return;
    app.monitorStats = stats;
    renderMonitor();
  } catch { /* silent */ }
}

export function refreshMonitor() { loadMonitorStats(); }

// ─── Render ───
function renderMonitor() {
  const s = app.monitorStats;
  if (!s) return;
  const el = document.getElementById('monitor-content');
  if (!el) return;

  const mem = s.memory;
  const sys = s.system;

  const pauseIcon = app._monitorPaused
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';

  el.innerHTML = `
    <div class="mon-header-bar">
      <div class="mon-system-info">
        <span class="mon-info-item"><strong>${esc(sys.hostname)}</strong></span>
        <span class="mon-info-item">${esc(sys.cpuModel)}</span>
        <span class="mon-info-item">${sys.cpuCores} cores</span>
        <span class="mon-info-item">Node ${esc(sys.nodeVersion)}</span>
        <span class="mon-info-item">Up ${formatUptime(sys.uptime)}</span>
      </div>
      <div class="mon-actions">
        <button class="dt-icon-btn ${app._monitorPaused ? 'monitor-paused' : ''}" id="monitor-pause-btn" data-action="toggle-pause" title="${app._monitorPaused ? 'Resume' : 'Pause'}">${pauseIcon}</button>
        <button class="dt-icon-btn" data-action="refresh" title="Refresh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-8.36L1 10"/></svg></button>
      </div>
    </div>
    <div class="mon-gauges">
      ${renderGauge('CPU', s.cpu, '%', cpuColor(s.cpu))}
      ${renderGauge('Memory', mem.percent, '%', memColor(mem.percent))}
      ${renderGaugeText('RAM', formatBytes(mem.used) + ' / ' + formatBytes(mem.total))}
    </div>
    <div class="mon-section">
      <h3 class="mon-section-title">Disks</h3>
      <div class="mon-disks">${s.disk.map(d => renderDisk(d)).join('')}</div>
    </div>
    <div class="mon-section">
      <h3 class="mon-section-title">Top Processes</h3>
      <table class="mon-proc-table">
        <thead><tr>
          <th>PID</th>
          <th>Name</th>
          <th class="mon-sortable" data-action="sort-proc" data-col="cpu" title="Sort by CPU">CPU (s) ${_monSortCol === 'cpu' ? (_monSortAsc ? '▲' : '▼') : ''}</th>
          <th class="mon-sortable" data-action="sort-proc" data-col="mem" title="Sort by Memory">Memory ${_monSortCol === 'mem' ? (_monSortAsc ? '▲' : '▼') : ''}</th>
        </tr></thead>
        <tbody>${sortProcesses(s.processes).map(p => `<tr>
          <td class="mon-pid">${p.Id}</td>
          <td class="mon-pname">${esc(p.ProcessName)}</td>
          <td class="mon-pcpu">${p.Cpu ?? '-'}</td>
          <td class="mon-pmem">${p.MemMB} MB</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
  `;
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'toggle-pause') toggleMonitorPause();
      else if (btn.dataset.action === 'refresh') refreshMonitor();
      else if (btn.dataset.action === 'sort-proc') sortMonitorProc(btn.dataset.col);
    });
  }
}

// ─── Gauge Components ───
function renderGauge(label, value, unit, color) {
  const pct = Math.min(100, Math.max(0, value));
  const r = 54, circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);
  return `<div class="mon-gauge">
    <svg viewBox="0 0 120 120" class="mon-gauge-svg">
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--bg-3)" stroke-width="8"/>
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="8"
        stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
        stroke-linecap="round" transform="rotate(-90 60 60)"
        style="transition: stroke-dashoffset 0.5s ease"/>
    </svg>
    <div class="mon-gauge-label">
      <span class="mon-gauge-val" style="color:${color}">${pct}${unit}</span>
      <span class="mon-gauge-name">${label}</span>
    </div>
  </div>`;
}

function renderGaugeText(label, text) {
  return `<div class="mon-gauge mon-gauge-text">
    <div class="mon-gauge-big">${text}</div>
    <div class="mon-gauge-name">${label}</div>
  </div>`;
}

function renderDisk(d) {
  const color = d.percent > 90 ? 'var(--red)' : d.percent > 70 ? 'var(--yellow)' : 'var(--green)';
  return `<div class="mon-disk">
    <div class="mon-disk-head"><span class="mon-disk-drive">${esc(d.drive)}</span><span class="mon-disk-pct" style="color:${color}">${d.percent}%</span></div>
    <div class="mon-disk-bar"><div class="mon-disk-fill" style="width:${d.percent}%;background:${color}"></div></div>
    <div class="mon-disk-info">${formatBytes(d.used)} / ${formatBytes(d.total)}</div>
  </div>`;
}

// ─── Process Sorting ───
let _monSortCol = 'mem';
let _monSortAsc = false;

export function sortMonitorProc(col) {
  if (_monSortCol === col) _monSortAsc = !_monSortAsc;
  else { _monSortCol = col; _monSortAsc = false; }
  renderMonitor();
}

function sortProcesses(procs) {
  return [...procs].sort((a, b) => {
    const va = _monSortCol === 'cpu' ? (a.Cpu ?? 0) : (a.MemMB ?? 0);
    const vb = _monSortCol === 'cpu' ? (b.Cpu ?? 0) : (b.MemMB ?? 0);
    return _monSortAsc ? va - vb : vb - va;
  });
}

// ─── Helpers ───
function cpuColor(pct) { return pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow)' : 'var(--green)'; }
function memColor(pct) { return pct > 85 ? 'var(--red)' : pct > 60 ? 'var(--yellow)' : 'var(--blue)'; }

function formatBytes(b) {
  if (b >= 1e12) return (b / 1e12).toFixed(1) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
