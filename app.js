// ─── State ───
const state = {
  projects: new Map(),
  costs: null,
  usage: null,
  connected: false,
};
let projectList = [];
const prevSessionStates = new Map();

// ─── Notifications ───
if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission();
}
function notifySessionChange(projectId, oldState, newState) {
  if (!notifyEnabled || Notification.permission !== "granted") return;
  if (
    typeof isNotifEnabledForProject === "function" &&
    !isNotifEnabledForProject(projectId)
  )
    return;
  const project = projectList.find((p) => p.id === projectId);
  const name = project?.name || projectId;
  const wasActive = oldState === "busy" || oldState === "waiting";
  if (wasActive && newState === "idle") {
    new Notification(`${name} — Session Complete`, {
      body: "Claude session finished.",
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%2334d399"><circle cx="12" cy="12" r="10"/></svg>',
      tag: `session-${projectId}`,
      silent: false,
    });
  } else if (
    wasActive &&
    (newState === "no_data" || newState === "no_sessions")
  ) {
    new Notification(`${name} — Session Ended`, {
      body: "Claude session disconnected.",
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23f87171"><circle cx="12" cy="12" r="10"/></svg>',
      tag: `session-${projectId}`,
      silent: false,
    });
  }
}

// ─── Helpers ───
const _escMap = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function esc(s) {
  return s ? String(s).replace(/[&<>"']/g, (c) => _escMap[c]) : "";
}
function timeAgo(v) {
  const ms = Date.now() - (v instanceof Date ? v : new Date(v)).getTime();
  if (ms < 60000) return "just now";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

// ─── Toast ───
function showToast(message, type = "info", duration = 3000) {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("exiting");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── Clock ───
function updateClock() {
  const now = new Date();
  document.getElementById("header-clock").textContent = now.toLocaleTimeString(
    "ko-KR",
    { hour: "2-digit", minute: "2-digit", second: "2-digit" },
  );
}
let _clockTimer = setInterval(updateClock, 1000);
updateClock();

// ─── Page Visibility: pause timers when tab hidden ───
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(_clockTimer);
    _clockTimer = null;
    if (usageTimer) {
      clearInterval(usageTimer);
      usageTimer = null;
    }
  } else {
    if (!_clockTimer) _clockTimer = setInterval(updateClock, 1000);
    updateClock();
    if (!usageTimer) usageTimer = setInterval(fetchUsage, 60000);
  }
});

// ─── SSE ───
let _sseBackoff = 1000,
  _sseReconnTimer = null,
  _sseConnectedAt = 0;
function connectSSE() {
  if (_sseReconnTimer) {
    clearTimeout(_sseReconnTimer);
    _sseReconnTimer = null;
  }
  const es = new EventSource("/api/events");
  es.addEventListener("init", (e) => {
    _sseBackoff = 1000;
    _sseConnectedAt = Date.now();
    const d = JSON.parse(e.data);
    if (d.sessions)
      Object.entries(d.sessions).forEach(([k, v]) => {
        if (v) {
          upd(k, "session", v);
          prevSessionStates.set(k, v.state);
        }
      });
    if (d.git)
      Object.entries(d.git).forEach(([k, v]) => {
        if (v) upd(k, "git", v);
      });
    if (d.prs)
      Object.entries(d.prs).forEach(([k, v]) => {
        if (v) upd(k, "prs", v);
      });
    if (d.costs) {
      state.usage = d.costs;
      renderCosts();
      renderUsage();
    }
    if (d.devServers) {
      devServerState = d.devServers;
      updateDevBadge();
    }
    // Only render cards that have state data (avoid rendering all 20+ on connect)
    const changedIds = new Set();
    if (d.sessions) Object.keys(d.sessions).forEach((k) => changedIds.add(k));
    if (d.git) Object.keys(d.git).forEach((k) => changedIds.add(k));
    if (d.prs) Object.keys(d.prs).forEach((k) => changedIds.add(k));
    if (changedIds.size > 0) changedIds.forEach((id) => renderCard(id));
    else projectList.forEach((p) => renderCard(p.id));
    updateSummaryStats();
    fetchUsage();
    setConn(true);
  });
  es.addEventListener("session:status", (e) => {
    const d = JSON.parse(e.data);
    const oldState = prevSessionStates.get(d.projectId);
    const newState = d.state;
    if (oldState && oldState !== newState)
      notifySessionChange(d.projectId, oldState, newState);
    prevSessionStates.set(d.projectId, newState);
    upd(d.projectId, "session", d);
    renderCard(d.projectId);
    updateSummaryStats();
    debouncedUpdateTermHeaders();
  });
  es.addEventListener("git:update", (e) => {
    const d = JSON.parse(e.data);
    upd(d.projectId, "git", d);
    renderCard(d.projectId);
    updateSummaryStats();
    debouncedUpdateTermHeaders();
    // Auto-refresh diff if Changes tab is open and showing this project
    if (document.getElementById("diff-view")?.classList.contains("active")) {
      const sel = document.getElementById("diff-project");
      if (sel?.value === d.projectId) debouncedLoadDiff();
    }
  });
  es.addEventListener("pr:update", (e) => {
    const d = JSON.parse(e.data);
    upd(d.projectId, "prs", d);
    renderCard(d.projectId);
    updateSummaryStats();
  });
  es.addEventListener("cost:update", (e) => {
    state.usage = JSON.parse(e.data);
    renderCosts();
    renderUsage();
    updateSummaryStats();
  });
  es.addEventListener("dev:status", (e) => {
    const d = JSON.parse(e.data);
    const newRunning = d.running || [];
    // Clear knownPorts for stopped servers
    const runIds = new Set(newRunning.map((ds) => ds.projectId));
    for (const key of _knownPorts) {
      if (!runIds.has(key.split(":")[0])) _knownPorts.delete(key);
    }
    devServerState = newRunning;
    // Clear start timeouts for servers that now have ports
    for (const ds of newRunning) {
      if (ds.port && _devStartTimeouts.has(ds.projectId)) {
        clearTimeout(_devStartTimeouts.get(ds.projectId));
        _devStartTimeouts.delete(ds.projectId);
      }
    }
    updateDevBadge();
    // re-render affected cards
    devServerState.forEach((ds) => renderCard(ds.projectId));
    projectList.forEach((p) => {
      if (!devServerState.some((ds) => ds.projectId === p.id)) renderCard(p.id);
    });
  });
  es.onerror = () => {
    setConn(false);
    es.close();
    // If connected >30s, it was stable — reset backoff
    if (_sseConnectedAt && Date.now() - _sseConnectedAt > 30000)
      _sseBackoff = 1000;
    const jitter = Math.random() * 500; // add jitter to prevent thundering herd
    _sseBackoff = Math.min(_sseBackoff * 1.5, 10000); // gentler growth, cap 10s
    _sseReconnTimer = setTimeout(connectSSE, _sseBackoff + jitter);
  };
}
function upd(id, k, v) {
  if (!state.projects.has(id)) state.projects.set(id, {});
  state.projects.get(id)[k] = v;
}
function setConn(v) {
  state.connected = v;
  document.getElementById("conn-dot").className =
    "conn-dot" + (v ? "" : " off");
}

// ─── Summary Stats ───
function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}
function updateSummaryStats() {
  let active = 0,
    totalPrs = 0,
    totalUncommitted = 0;
  for (const [, p] of state.projects) {
    if (p.session?.state === "busy" || p.session?.state === "waiting") active++;
    totalPrs += p.prs?.prs?.length || 0;
    totalUncommitted += p.git?.uncommittedCount || 0;
  }
  document.getElementById("stat-active").textContent = active;
  document.getElementById("stat-prs").textContent = totalPrs;
  document.getElementById("stat-uncommitted").textContent = totalUncommitted;
  if (state.usage?.today) {
    document.getElementById("stat-today").textContent = fmtTok(
      state.usage.today.outputTokens || 0,
    );
  }
  // Dynamic tab title
  document.title = active > 0 ? `(${active}) Cockpit` : "Cockpit";
  // Dynamic favicon
  updateFavicon(active);
}

// ─── Recent Conversations ───
window.showConvList = async () => {
  const overlay = document.getElementById("conv-overlay");
  const body = document.getElementById("conv-body");
  body.innerHTML = '<div class="conv-empty">Loading...</div>';
  overlay.classList.remove("hidden");
  try {
    const res = await fetch("/api/activity");
    const data = await res.json();
    if (!data.length) {
      body.innerHTML = '<div class="conv-empty">No recent conversations</div>';
      return;
    }
    let html = "",
      lastDate = "";
    for (const e of data) {
      const d = e.timestamp?.slice(0, 10) || "";
      if (d !== lastDate) {
        const label =
          d === new Date().toISOString().slice(0, 10)
            ? "Today"
            : d === new Date(Date.now() - 86400000).toISOString().slice(0, 10)
              ? "Yesterday"
              : d;
        html += `<div class="conv-group-date">${label}</div>`;
        lastDate = d;
      }
      const msg =
        (e.command || "").replace(/\[Pasted text[^\]]*\]\s*/g, "").trim() ||
        "(no message)";
      const time = e.timestamp
        ? new Date(e.timestamp).toLocaleTimeString("ko-KR", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      const proj = projectList.find(
        (p) =>
          e.projectPath &&
          p.path.replace(/\\/g, "/").toLowerCase() ===
            e.projectPath.toLowerCase(),
      );
      const pid = proj ? proj.id : "";
      html += `<div class="conv-item${pid ? " clickable" : ""}" ${pid ? `onclick="closeConvList();openTermWith('${pid}','claude --continue')" style="cursor:pointer" title="Open terminal with --continue"` : ""}>
        <span class="conv-project" title="${esc(e.projectPath || "")}">${esc(e.project || "?")}</span>
        <div class="conv-info">
          <div class="conv-msg" title="${esc(msg)}">${esc(msg)}</div>
          <div class="conv-time">${time}</div>
        </div>
      </div>`;
    }
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div class="conv-empty">Error: ${err.message}</div>`;
  }
};

window.closeConvList = () => {
  document.getElementById("conv-overlay").classList.add("hidden");
};

// ─── Dynamic Favicon ───
let _faviconLink = null;
function updateFavicon(activeCount) {
  if (!_faviconLink) {
    _faviconLink = document.querySelector('link[rel="icon"]');
    if (!_faviconLink) {
      _faviconLink = document.createElement("link");
      _faviconLink.rel = "icon";
      _faviconLink.type = "image/svg+xml";
      document.head.appendChild(_faviconLink);
    }
  }
  const color = activeCount > 0 ? "%2334d399" : "%23818cf8";
  _faviconLink.href = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="${color}"/>${activeCount > 0 ? `<text x="50" y="68" text-anchor="middle" font-size="50" font-weight="bold" fill="white">${activeCount}</text>` : '<path d="M35 50L45 60L65 40" stroke="white" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'}</svg>`;
}

// ─── View Switching ───
window.switchView = (name) => {
  document
    .querySelectorAll(".view")
    .forEach((v) => v.classList.remove("active"));
  document.getElementById(`${name}-view`).classList.add("active");
  document
    .querySelectorAll(".nav-tab")
    .forEach((t) => t.classList.remove("active"));
  document
    .querySelector(`.nav-tab[onclick*="${name}"]`)
    .classList.add("active");
  if (name === "terminal") renderLayout();
  if (name === "diff") loadDiff();
  try {
    localStorage.setItem("dl-view", name);
  } catch {}
};

// ─── Cards ───
function renderCard(id) {
  const el = document.getElementById(`card-${id}`);
  if (!el) return;
  const p = state.projects.get(id) || {};
  const s = p.session || {},
    g = p.git || {},
    prs = p.prs?.prs || [];
  const st = s.state || "no_data";
  el.querySelector(".status").className = `status ${st}`;
  el.querySelector(".status").innerHTML =
    `<span class="dot"></span>${{ busy: "Busy", waiting: "Waiting", idle: "Idle", no_data: "No Data", no_sessions: "No Sessions" }[st] || st}`;
  const q = (c) => el.querySelector(c);
  if (q(".branch-val")) q(".branch-val").textContent = g.branch || "-";
  if (q(".uncommitted-val")) {
    q(".uncommitted-val").textContent = g.uncommittedCount ?? "-";
    q(".uncommitted-val").classList.toggle(
      "has-changes",
      (g.uncommittedCount || 0) > 0,
    );
  }
  if (q(".model-val")) q(".model-val").textContent = s.model || "-";
  if (q(".last-val"))
    q(".last-val").textContent = s.lastActivity ? timeAgo(s.lastActivity) : "-";
  const cl = q(".commits");
  if (cl && g.recentCommits)
    cl.innerHTML = g.recentCommits
      .slice(0, 3)
      .map(
        (c) =>
          `<li><span style="color:var(--accent-bright)">${c.hash}</span> ${esc(c.message)}</li>`,
      )
      .join("");
  const pl = q(".pr-list");
  if (pl)
    pl.innerHTML = prs.length
      ? prs
          .slice(0, 2)
          .map(
            (pr) =>
              `<div class="pr-item"><span class="pr-num">#${pr.number}</span><span class="pr-title">${esc(pr.title)}</span><span class="pr-review ${pr.reviewDecision}">${pr.reviewDecision === "APPROVED" ? "OK" : pr.reviewDecision === "CHANGES_REQUESTED" ? "Changes" : "Pending"}</span></div>`,
          )
          .join("")
      : "";
  // Resume Last button — show if session exists
  const resumeBtn = document.getElementById(`resume-last-${id}`);
  if (resumeBtn) {
    const hasSession =
      s.sessionId && s.state !== "no_data" && s.state !== "no_sessions";
    resumeBtn.style.display = hasSession ? "" : "none";
    if (hasSession) resumeBtn.title = `Resume session (${s.state})`;
  }
  // Dev server button state
  const devBtn = document.getElementById(`dev-btn-${id}`);
  if (devBtn) {
    const proj = projectList.find((pp) => pp.id === id);
    const hasCmd = !!proj?.devCmd;
    const isRunning = devServerState.some((d) => d.projectId === id);
    if (hasCmd) {
      const dsInfo = devServerState.find((d) => d.projectId === id);
      const hasPort = !!dsInfo?.port;
      const isStarting = isRunning && !hasPort;
      const dotClass = isStarting ? "spin" : isRunning ? "on" : "off";
      const btnClass = isStarting ? " starting" : isRunning ? " running" : "";
      const label = isStarting ? "Starting..." : isRunning ? "Stop" : "Dev";
      const portKey = `${id}:${dsInfo?.port}`;
      const isNewPort = hasPort && !_knownPorts.has(portKey);
      if (isNewPort) _knownPorts.add(portKey);
      const portTag = hasPort
        ? `<span class="dev-port${isNewPort ? " pop" : ""}" onclick="event.stopPropagation();window.open('http://localhost:${dsInfo.port}','_blank')">:${dsInfo.port}</span>`
        : "";
      devBtn.className = "btn dev-btn" + btnClass;
      devBtn.innerHTML = `<span class="dev-dot ${dotClass}"></span>${label}${portTag}`;
      devBtn.setAttribute("onclick", `toggleDevServer('${id}')`);
      devBtn.title =
        proj.devCmd + (hasPort ? ` → localhost:${dsInfo.port}` : "");
    } else {
      devBtn.className = "btn dev-btn";
      devBtn.innerHTML = `<span class="dev-dot none"></span>Dev`;
      devBtn.setAttribute("onclick", `promptDevCmd('${id}')`);
      devBtn.title = "Set dev command";
    }
  }
  // GitHub button: show if project has github field or remoteUrl from git
  const ghBtn = document.getElementById(`github-btn-${id}`);
  if (ghBtn) {
    const proj = projectList.find((pp) => pp.id === id);
    const ghUrl = proj?.github || g.remoteUrl || "";
    ghBtn.style.display = ghUrl ? "" : "none";
  }
}

let _renderedCardIds = [];
function cardHTML(p) {
  const isPinned = pinnedProjects.has(p.id);
  return `<div class="card" id="card-${p.id}">
      <div class="card-accent" style="background:${p.color};--card-color:${p.color}"></div>
      <div class="card-body">
        <div class="card-header" onclick="jumpToChanges('${p.id}')" style="cursor:pointer" title="View changes">
          <div><span class="card-name">${esc(p.name)}</span></div>
          <div class="card-actions">
            <span class="card-stack">${esc(p.stack || "")}</span>
            <button class="card-edit-btn" onclick="event.stopPropagation();editProject('${p.id}')" title="Edit project settings"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
            <button class="card-pin ${isPinned ? "pinned" : ""}" onclick="event.stopPropagation();togglePin('${p.id}')" title="${isPinned ? "Unpin" : "Pin to front"}"><svg viewBox="0 0 24 24" fill="${isPinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></button>
          </div>
        </div>
        <div style="margin-bottom:8px"><span class="status no_data"><span class="dot"></span>Loading</span></div>
        <div class="card-info">
          <div class="info-row"><span class="info-label">Branch</span><span class="info-value branch branch-val">-</span></div>
          <div class="info-row"><span class="info-label">Uncommitted</span><span class="info-value uncommitted-val" onclick="jumpToChanges('${p.id}')" title="View changes">-</span></div>
          <div class="info-row"><span class="info-label">Model</span><span class="info-value model-val">-</span></div>
          <div class="info-row"><span class="info-label">Last</span><span class="info-value last-val">-</span></div>
        </div>
        <ul class="commits"></ul>
        <div class="pr-list"></div>
        <div class="card-foot">
          <div class="card-btn-row">
            <button class="btn primary" onclick="openTermWith('${p.id}','claude')" title="New Claude session">Claude</button>
            <button class="btn" onclick="openTermWith('${p.id}','claude --continue')" title="Resume last conversation">Resume</button>
            <button class="btn resume-last-btn" id="resume-last-${p.id}" onclick="resumeLastSession('${p.id}')" style="display:none" title="Resume last session in external terminal">Last</button>
            <button class="btn" onclick="openTermWith('${p.id}','')" title="Open shell">Shell</button>
            <button class="btn dev-btn" id="dev-btn-${p.id}" onclick="${p.devCmd ? `toggleDevServer('${p.id}')` : `promptDevCmd('${p.id}')`}" title="${p.devCmd ? esc(p.devCmd) : "Set dev command"}"><span class="dev-dot ${p.devCmd ? "off" : "none"}"></span>Dev</button>
          </div>
          <div class="card-btn-row">
            <button class="btn" onclick="openIDE('${p.id}','code')" title="VS Code"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> VS</button>
            <button class="btn" onclick="openIDE('${p.id}','cursor')" title="Cursor">Cursor</button>
            <button class="btn" onclick="openIDE('${p.id}','antigravity')" title="Antigravity">AG</button>
            <button class="btn card-github-btn" id="github-btn-${p.id}" onclick="openGitHub('${p.id}')" style="display:none">GitHub</button>
            <button class="btn" onclick="showSessionHistory('${p.id}')" title="Session history">Sessions</button>
            <button class="btn" onclick="showGitLog('${p.id}')" title="Git log">Log</button>
          </div>
        </div>
      </div>
    </div>`;
}
function renderAllCards(projects) {
  const grid = document.getElementById("project-grid");
  const newIds = projects.map((p) => p.id);
  // Incremental: only rebuild if project list changed (add/remove/reorder)
  if (
    _renderedCardIds.length === newIds.length &&
    _renderedCardIds.every((id, i) => id === newIds[i])
  ) {
    // Same projects — just update data via renderCard
    projects.forEach((p) => renderCard(p.id));
  } else {
    // Project list changed — full rebuild
    grid.innerHTML = projects.map((p) => cardHTML(p)).join("");
    _renderedCardIds = newIds;
  }
  setTimeout(updateScrollIndicators, 50);
}

function renderSkeletons(count) {
  document.getElementById("project-grid").innerHTML = Array(count)
    .fill('<div class="skeleton skeleton-card"></div>')
    .join("");
}

// ─── Charts ───
let dailyChart, modelChart;
let chartPeriod = parseInt(localStorage.getItem("dl-chart-period") || "30");
window.setChartPeriod = (days) => {
  chartPeriod = days;
  localStorage.setItem("dl-chart-period", days);
  document
    .querySelectorAll(".chart-period button")
    .forEach((b) =>
      b.classList.toggle("active", parseInt(b.textContent) === days),
    );
  const lbl = document.getElementById("chart-period-label");
  if (lbl) lbl.textContent = `(${days}d)`;
  renderCosts();
};
function renderCosts() {
  const u = state.usage;
  if (!u?.daily) return;
  const allDaily = u.daily;
  const daily = allDaily.slice(-chartPeriod);
  const labels = daily.map((d) => d.date?.slice(5) || "");
  const tokens = daily.map((d) => d.outputTokens || 0);
  const chartColors = {
    line: "#818cf8",
    fill: "rgba(129,140,248,.08)",
    grid: "rgba(255,255,255,.03)",
    tick: "#565868",
  };
  if (dailyChart) {
    dailyChart.data.labels = labels;
    dailyChart.data.datasets[0].data = tokens;
    dailyChart.update("none");
  } else {
    dailyChart = new Chart(document.getElementById("daily-chart"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            data: tokens,
            borderColor: chartColors.line,
            backgroundColor: chartColors.fill,
            fill: true,
            tension: 0.3,
            borderWidth: 2,
            pointRadius: 1.5,
            pointHoverRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            ticks: { color: chartColors.tick, font: { size: 9 } },
            grid: { color: chartColors.grid },
          },
          y: {
            ticks: {
              color: chartColors.tick,
              callback: (v) => fmtTok(v),
              font: { size: 9 },
            },
            grid: { color: chartColors.grid },
          },
        },
      },
    });
  }
  const mm = {};
  daily.forEach((d) =>
    (d.modelBreakdowns || []).forEach((m) => {
      const n = m.modelName || "?";
      mm[n] = (mm[n] || 0) + (m.outputTokens || 0);
    }),
  );
  if (modelChart) {
    modelChart.data.labels = Object.keys(mm);
    modelChart.data.datasets[0].data = Object.values(mm);
    modelChart.update("none");
  } else {
    modelChart = new Chart(document.getElementById("model-chart"), {
      type: "doughnut",
      data: {
        labels: Object.keys(mm),
        datasets: [
          {
            data: Object.values(mm),
            backgroundColor: [
              "#818cf8",
              "#34d399",
              "#fbbf24",
              "#f87171",
              "#60a5fa",
            ],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "65%",
        plugins: {
          legend: {
            position: "bottom",
            labels: { color: "#9395a5", font: { size: 10 }, padding: 8 },
          },
        },
        tooltip: { callbacks: { label: (ctx) => fmtTok(ctx.raw) + " tok" } },
      },
    });
  }
}

// ─── Usage Dashboard ───
let usageTimer = null;
async function fetchUsage() {
  try {
    const res = await fetch("/api/usage");
    state.usage = await res.json();
    renderUsage();
    renderCosts();
  } catch {}
}
usageTimer = setInterval(fetchUsage, 60000);

function timeUntil(isoStr) {
  const diff = new Date(isoStr) - new Date();
  if (diff <= 0) return "now";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderUsage() {
  const u = state.usage;
  if (!u) return;
  const t = u.today || {};
  const w = u.week || {};

  // Header badges
  document.getElementById("today-output").textContent = fmtTok(
    t.outputTokens || 0,
  );
  document.getElementById("today-msgs").textContent = t.messages || 0;
  document.getElementById("stat-today").textContent = fmtTok(
    t.outputTokens || 0,
  );

  // Today card
  document.getElementById("uc-today-date").textContent = t.date || "";
  document.getElementById("uc-today-output").textContent =
    fmtTok(t.outputTokens || 0) + " tok";
  document.getElementById("uc-today-stats").innerHTML = [
    row("Messages", t.messages || 0),
    row("Sessions", t.sessions || 0),
    row("Tool Calls", t.toolCalls || 0),
  ].join("");
  // Today models
  const todayModels = t.models || {};
  const totalOut = t.outputTokens || 1;
  const modelsEl = document.getElementById("uc-today-models");
  const mEntries = Object.entries(todayModels).sort(
    (a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0),
  );
  modelsEl.innerHTML = mEntries.length
    ? mEntries
        .map(([name, m]) => {
          const pct = (((m.outputTokens || 0) / totalOut) * 100).toFixed(1);
          return `<div class="uc-model-row"><span class="name">${name}</span><span class="val">${fmtTok(m.outputTokens || 0)}<span class="pct">(${pct}%)</span></span></div>`;
        })
        .join("")
    : "";
  document.getElementById("uc-today-cost").textContent =
    `API Equiv. ~$${(t.apiEquivCost || 0).toFixed(2)}`;

  // Week card
  document.getElementById("uc-week-output").textContent =
    fmtTok(w.outputTokens || 0) + " tok";
  if (w.resetAt)
    document.getElementById("uc-week-reset").textContent =
      `resets ${timeUntil(w.resetAt)}`;
  document.getElementById("uc-week-stats").innerHTML = [
    row("Messages", w.messages || 0),
  ].join("");
  const weekModels = w.models || {};
  const wmEl = document.getElementById("uc-week-models");
  const wmEntries = Object.entries(weekModels).sort(
    (a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0),
  );
  wmEl.innerHTML = wmEntries.length
    ? wmEntries
        .map(
          ([name, m]) =>
            `<div class="uc-model-row"><span class="name">${name}</span><span class="val">${fmtTok(m.outputTokens || 0)}</span></div>`,
        )
        .join("")
    : "";
  document.getElementById("uc-week-cost").textContent =
    `API Equiv. ~$${(w.apiEquivCost || 0).toFixed(2)}`;

  // Overview card
  document.getElementById("uc-overview-stats").innerHTML = [
    row("Total Sessions", t.sessions || 0),
    row("Cache Read", fmtTok(t.cacheReadTokens || 0) + " tok"),
    row("Cache Write", fmtTok(t.cacheCreationTokens || 0) + " tok"),
    row("Input Tokens", fmtTok(t.inputTokens || 0)),
  ].join("");

  // Plan info — calculate from daily data
  const daily = u.daily || [];
  const allTimeCost = daily.reduce((s, d) => s + (d.totalCost || 0), 0);
  const planEl = document.getElementById("uc-plan-info");
  if (planEl)
    planEl.textContent = `30-day API equiv: ~$${allTimeCost.toFixed(2)}`;
}

function row(label, val) {
  return `<div class="uc-stat-row"><span class="label">${label}</span><span class="val">${val}</span></div>`;
}

// ─── Settings Panel ───
window.openSettingsPanel = () => {
  renderSettingsProjectList();
  document.getElementById("settings-overlay").classList.add("open");
  document.getElementById("settings-panel").classList.add("open");
};
window.closeSettingsPanel = () => {
  document.getElementById("settings-overlay").classList.remove("open");
  document.getElementById("settings-panel").classList.remove("open");
};
function renderSettingsProjectList() {
  document.getElementById("settings-project-list").innerHTML = projectList
    .map(
      (p) => `
    <div class="spi">
      <div class="spi-color" style="background:${p.color}"></div>
      <div class="spi-info"><div class="spi-name">${esc(p.name)}</div><div class="spi-path">${esc(p.path)}</div></div>
      <div class="spi-actions">
        <button class="btn btn-icon" onclick="editProject('${p.id}')" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn btn-icon" onclick="confirmDeleteProject('${p.id}')" title="Delete" style="color:var(--red)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    </div>
  `,
    )
    .join("");
}

window.openAddProjectModal = () => {
  document.getElementById("pm-edit-id").value = "";
  document.getElementById("pm-title").textContent = "Add Project";
  document.getElementById("pm-name").value = "";
  document.getElementById("pm-path").value = "";
  document.getElementById("pm-stack").value = "react-next";
  document.getElementById("pm-devcmd").value = "";
  document.getElementById("pm-github").value = "";
  document.getElementById("pm-color").value = "#6366f1";
  document.getElementById("pm-scripts-list").style.display = "none";
  closeFolderPicker();
  document.getElementById("project-modal").showModal();
};
window.loadPkgScripts = async () => {
  const pathInput = document.getElementById("pm-path").value.trim();
  const list = document.getElementById("pm-scripts-list");
  if (!pathInput) {
    showToast("Enter project path first", "error");
    return;
  }
  list.style.display = "";
  list.innerHTML =
    '<div style="padding:8px 12px;color:var(--text-3);font-size:.78rem">Loading...</div>';
  try {
    const res = await fetch(
      `/api/scripts-by-path?path=${encodeURIComponent(pathInput)}`,
    );
    const data = await res.json();
    const scripts = data.scripts || {};
    const entries = Object.entries(scripts);
    if (!entries.length) {
      list.innerHTML =
        '<div style="padding:8px 12px;color:var(--text-3);font-size:.78rem">No scripts in package.json</div>';
      return;
    }
    list.innerHTML = entries
      .map(
        ([name, cmd]) =>
          `<div class="pm-script-item" onclick="pickScript(this)" data-cmd="npm run ${name}" style="padding:5px 12px;cursor:pointer;font-size:.78rem;display:flex;justify-content:space-between;gap:8px;transition:background var(--dur)">
        <span style="font-weight:500;color:var(--accent-bright);font-family:var(--mono)">${esc(name)}</span>
        <span style="color:var(--text-3);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cmd)}</span>
      </div>`,
      )
      .join("");
  } catch {
    list.innerHTML =
      '<div style="padding:8px 12px;color:var(--red);font-size:.78rem">Error loading scripts</div>';
  }
};
window.pickScript = (el) => {
  document.getElementById("pm-devcmd").value = el.dataset.cmd;
  document.getElementById("pm-scripts-list").style.display = "none";
};
window.editProject = (id) => {
  const p = projectList.find((x) => x.id === id);
  if (!p) return;
  document.getElementById("pm-edit-id").value = p.id;
  document.getElementById("pm-title").textContent = "Edit Project";
  document.getElementById("pm-name").value = p.name;
  document.getElementById("pm-path").value = p.path;
  document.getElementById("pm-stack").value = p.stack || "other";
  document.getElementById("pm-devcmd").value = p.devCmd || "";
  document.getElementById("pm-github").value = p.github || "";
  document.getElementById("pm-color").value = p.color || "#6366f1";
  document.getElementById("project-modal").showModal();
};
window.saveProject = async () => {
  const editId = document.getElementById("pm-edit-id").value;
  const devCmd = document.getElementById("pm-devcmd").value.trim();
  const github = document.getElementById("pm-github").value.trim();
  const data = {
    name: document.getElementById("pm-name").value.trim(),
    path: document.getElementById("pm-path").value.trim(),
    stack: document.getElementById("pm-stack").value,
    color: document.getElementById("pm-color").value,
    devCmd: devCmd || "",
    github: github || "",
  };
  if (!data.name || !data.path) {
    showToast("Name and path required", "error");
    return;
  }
  if (editId) {
    await fetch(`/api/projects/${editId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    showToast("Project updated", "success");
  } else {
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    showToast("Project added", "success");
  }
  document.getElementById("project-modal").close();
  closeFolderPicker();
  await refreshProjectList();
};

// ── Folder Picker ──
let fpCurrentDir = null;
window.toggleFolderPicker = () => {
  const el = document.getElementById("folder-picker");
  if (el.classList.contains("open")) {
    closeFolderPicker();
    return;
  }
  el.classList.add("open");
  const cur = document
    .getElementById("pm-path")
    .value.trim()
    .replace(/\\/g, "/");
  browseTo(cur || null);
};
function closeFolderPicker() {
  document.getElementById("folder-picker").classList.remove("open");
}
async function browseTo(dir) {
  fpCurrentDir = dir;
  const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
  try {
    const res = await fetch(`/api/browse${qs}`);
    const data = await res.json();
    if (data.error) {
      showToast(data.error, "error");
      return;
    }
    renderBreadcrumb(data.current || null, data.parent);
    const list = document.getElementById("fp-list");
    if (!data.entries.length) {
      list.innerHTML = '<li class="fp-empty">No subfolders</li>';
      return;
    }
    list.innerHTML = data.entries
      .map(
        (e) =>
          `<li class="fp-item" onclick="browseTo('${e.path.replace(/'/g, "\\'")}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>${e.name}</li>`,
      )
      .join("");
  } catch (err) {
    showToast("Browse failed", "error");
  }
}
window.browseTo = browseTo;
function renderBreadcrumb(current, parent) {
  const bc = document.getElementById("fp-breadcrumb");
  if (!current) {
    bc.innerHTML = '<span style="color:var(--text-3)">Drives</span>';
    return;
  }
  const parts = current.replace(/\/$/, "").split("/");
  let html = "";
  let acc = "";
  parts.forEach((p, i) => {
    acc += i === 0 ? p : "/" + p;
    const path = acc + (i === 0 ? "/" : "");
    if (i > 0) html += '<span class="fp-sep">/</span>';
    html += `<span onclick="browseTo('${path.replace(/'/g, "\\'")}')">${p || "/"}</span>`;
  });
  bc.innerHTML = html;
}
window.selectCurrentFolder = () => {
  if (fpCurrentDir) document.getElementById("pm-path").value = fpCurrentDir;
  closeFolderPicker();
};

window.confirmDeleteProject = async (id) => {
  const p = projectList.find((x) => x.id === id);
  if (!confirm(`Delete "${p?.name}"? (Dashboard only, not from disk)`)) return;
  await fetch(`/api/projects/${id}`, { method: "DELETE" });
  showToast(`${p?.name} removed`, "info");
  await refreshProjectList();
};

async function refreshProjectList() {
  const res = await fetch("/api/projects");
  projectList = await res.json();
  renderAllCards(projectList);
  projectList.forEach((p) => {
    if (state.projects.has(p.id)) renderCard(p.id);
  });
  renderSettingsProjectList();
  populateProjectSelects();
  updateSummaryStats();
}

function populateProjectSelects() {
  const opts = projectList
    .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
    .join("");
  document.getElementById("diff-project").innerHTML = opts;
  const ntSel = document.getElementById("nt-project");
  if (ntSel) ntSel.innerHTML = opts;
}

// ─── WebSocket Terminal ───
let ws,
  termMap = new Map(),
  activeTermId = null;
let layoutRoot = null;
let draggedTermId = null;

const writeBuffers = new Map();
function bufferWrite(t, data, id) {
  if (!id) {
    t.xterm.write(data);
    return;
  }
  let buf = writeBuffers.get(id);
  if (!buf) {
    buf = { data: "", timer: null };
    writeBuffers.set(id, buf);
  }
  buf.data += data;
  if (!buf.timer) {
    buf.timer = requestAnimationFrame(() => {
      t.xterm.write(buf.data);
      buf.data = "";
      buf.timer = null;
    });
  }
}

function saveLayout() {
  try {
    localStorage.setItem("dl-tree", JSON.stringify(layoutRoot));
    const labels = {};
    for (const [id, t] of termMap) labels[id] = t.label;
    localStorage.setItem("dl-labels", JSON.stringify(labels));
    if (activeTermId) localStorage.setItem("dl-active", activeTermId);
    const view = document
      .querySelector(".view.active")
      ?.id?.replace("-view", "");
    if (view) localStorage.setItem("dl-view", view);
  } catch {}
}
function restoreSavedLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem("dl-tree"));
    if (!saved) return false;
    function validate(node) {
      if (!node) return false;
      if (node.type === "leaf") return termMap.has(node.termId);
      if (node.type === "split")
        return (
          node.children &&
          validate(node.children[0]) &&
          validate(node.children[1])
        );
      return false;
    }
    if (!validate(saved)) return false;
    layoutRoot = saved;
    try {
      const labels = JSON.parse(localStorage.getItem("dl-labels"));
      if (labels)
        for (const [id, label] of Object.entries(labels)) {
          const t = termMap.get(id);
          if (t) t.label = label;
        }
    } catch {}
    const activeId = localStorage.getItem("dl-active");
    if (activeId && termMap.has(activeId)) activeTermId = activeId;
    return true;
  } catch {
    return false;
  }
}

function remapLayoutIds(idMap) {
  try {
    const tree = JSON.parse(localStorage.getItem("dl-tree"));
    if (tree) {
      (function remap(node) {
        if (!node) return;
        if (node.type === "leaf" && idMap[node.termId])
          node.termId = idMap[node.termId];
        if (node.type === "split") {
          remap(node.children[0]);
          remap(node.children[1]);
        }
      })(tree);
      localStorage.setItem("dl-tree", JSON.stringify(tree));
    }
    const labels = JSON.parse(localStorage.getItem("dl-labels"));
    if (labels) {
      const newLabels = {};
      for (const [oldId, label] of Object.entries(labels))
        newLabels[idMap[oldId] || oldId] = label;
      localStorage.setItem("dl-labels", JSON.stringify(newLabels));
    }
    const active = localStorage.getItem("dl-active");
    if (active && idMap[active])
      localStorage.setItem("dl-active", idMap[active]);
  } catch {}
}

let _wsBackoff = 1000,
  _wsReconnTimer = null,
  _wsConnectedAt = 0;
function connectWS() {
  if (_wsReconnTimer) {
    clearTimeout(_wsReconnTimer);
    _wsReconnTimer = null;
  }
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => {
    console.log("[WS] connected");
    _wsBackoff = 1000;
    _wsConnectedAt = Date.now();
    showDisconnectIndicator(false);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "terminals": {
        if (msg.idMap) remapLayoutIds(msg.idMap);
        let added = false;
        msg.active.forEach((t) => {
          if (!termMap.has(t.termId)) {
            addTerminal(t.termId, t.projectId, false);
            added = true;
            if (t.buffer) {
              const tm = termMap.get(t.termId);
              if (tm) tm.pendingBuffer = t.buffer;
            }
          }
        });
        if (added) {
          if (!restoreSavedLayout()) {
            for (const [id] of termMap) {
              if (!findLeaf(layoutRoot, id)) addToLayoutTree(id);
            }
          }
          renderLayout();
          updateTermHeaders();
          if (msg.idMap)
            showToast(`Restored ${msg.active.length} terminal(s)`, "success");
        }
        break;
      }
      case "created":
        if (!termMap.has(msg.termId))
          addTerminal(msg.termId, msg.projectId, true);
        break;
      case "output": {
        const t = termMap.get(msg.termId);
        if (t) bufferWrite(t, msg.data, msg.termId);
        break;
      }
      case "exit": {
        const t = termMap.get(msg.termId);
        if (t) t.xterm.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
        break;
      }
    }
  };
  ws.onerror = (err) => {
    console.error("[WS] error", err);
  };
  ws.onclose = () => {
    showDisconnectIndicator(true);
    if (_wsConnectedAt && Date.now() - _wsConnectedAt > 30000)
      _wsBackoff = 1000;
    _wsBackoff = Math.min(_wsBackoff * 1.5, 10000);
    _wsReconnTimer = setTimeout(connectWS, _wsBackoff + Math.random() * 500);
  };
}

function addTerminal(termId, projectId, addToView) {
  const project = projectList.find((p) => p.id === projectId);
  const color = project?.color || "#666";
  const name = project?.name || projectId;
  const xterm = new Terminal({
    theme: {
      background: "#08090d",
      foreground: "#e8e9f0",
      cursor: "#818cf8",
      selectionBackground: "rgba(129,140,248,.3)",
      black: "#08090d",
      red: "#f87171",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#e8e9f0",
    },
    fontFamily: "'Cascadia Code','JetBrains Mono',monospace",
    fontSize: typeof termFontSize !== "undefined" ? termFontSize : 13,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    fastScrollModifier: "alt",
    fastScrollSensitivity: 5,
  });
  const fitAddon = new FitAddon.FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon.WebLinksAddon());
  const searchAddon = new SearchAddon.SearchAddon();
  xterm.loadAddon(searchAddon);
  // File path link provider — click to preview, right-click for context menu
  xterm.registerLinkProvider({
    provideLinks(lineNum, cb) {
      const line =
        xterm.buffer.active.getLine(lineNum - 1)?.translateToString() || "";
      const links = [];
      // Windows paths: C:\...\file.ext or C:/...  Unix: /home/...
      const re =
        /(?:[A-Za-z]:[\\\/][^\s"'<>|:]+|\/(?:home|usr|tmp|var|etc|opt|mnt)[^\s"'<>|:]+)/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        const text = m[0];
        const x1 = m.index + 1;
        links.push({
          range: {
            start: { x: x1, y: lineNum },
            end: { x: x1 + text.length, y: lineNum },
          },
          text,
          activate(ev, t) {
            if (ev.button === 0) openFilePreview(t);
          },
        });
      }
      cb(links.length ? links : undefined);
    },
  });
  xterm.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    // Ctrl+C with selection → copy, Ctrl+Shift+C → always copy
    if (
      (ev.ctrlKey && ev.shiftKey && ev.code === "KeyC") ||
      (ev.ctrlKey && !ev.shiftKey && ev.key === "c" && xterm.hasSelection())
    ) {
      const text = xterm.getSelection();
      if (text) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        xterm.clearSelection();
      }
      return false;
    }
    // Ctrl+V / Ctrl+Shift+V → paste with bracketed paste mode for multiline
    if (ev.ctrlKey && (ev.key === "v" || ev.key === "V")) {
      navigator.clipboard
        .readText()
        .then((t) => {
          if (!t || ws?.readyState !== 1) return;
          // Wrap multiline pastes in bracket paste sequences so shells don't execute line-by-line
          const data = t.includes("\n") ? `\x1b[200~${t}\x1b[201~` : t;
          ws.send(JSON.stringify({ type: "input", termId, data }));
        })
        .catch(() => {});
      return false;
    }
    return true;
  });
  const element = document.createElement("div");
  element.className = "xterm-wrap";
  xterm.onData((data) => {
    if (ws?.readyState === 1)
      ws.send(JSON.stringify({ type: "input", termId, data }));
  });
  termMap.set(termId, {
    xterm,
    fitAddon,
    searchAddon,
    projectId,
    element,
    label: name,
    color,
    opened: false,
    pendingBuffer: null,
  });
  if (addToView) {
    if (window._splitTarget) {
      const st = window._splitTarget;
      window._splitTarget = null;
      splitAt(st.termId, termId, st.pos);
    } else {
      addToLayoutTree(termId);
    }
    activeTermId = termId;
    updateTermHeaders();
    renderLayout();
  }
}

// ─── Layout Tree ───
function addToLayoutTree(termId) {
  if (!layoutRoot) {
    layoutRoot = { type: "leaf", termId };
  } else if (activeTermId && findLeaf(layoutRoot, activeTermId)) {
    splitAt(activeTermId, termId, "right");
  } else {
    layoutRoot = {
      type: "split",
      dir: "h",
      ratio: 0.5,
      children: [layoutRoot, { type: "leaf", termId }],
    };
  }
  activeTermId = termId;
}
function findLeaf(node, termId) {
  if (!node) return null;
  if (node.type === "leaf") return node.termId === termId ? node : null;
  return (
    findLeaf(node.children[0], termId) || findLeaf(node.children[1], termId)
  );
}
function splitAt(targetTermId, newTermId, position) {
  const dir = position === "left" || position === "right" ? "h" : "v";
  const newFirst = position === "left" || position === "top";
  function replace(node) {
    if (node.type === "leaf" && node.termId === targetTermId)
      return {
        type: "split",
        dir,
        ratio: 0.5,
        children: newFirst
          ? [
              { type: "leaf", termId: newTermId },
              { type: "leaf", termId: targetTermId },
            ]
          : [
              { type: "leaf", termId: targetTermId },
              { type: "leaf", termId: newTermId },
            ],
      };
    if (node.type === "split")
      return {
        ...node,
        children: [replace(node.children[0]), replace(node.children[1])],
      };
    return node;
  }
  layoutRoot = replace(layoutRoot);
}
function removeFromLayoutTree(termId) {
  if (!layoutRoot) return;
  if (layoutRoot.type === "leaf") {
    if (layoutRoot.termId === termId) layoutRoot = null;
    return;
  }
  function collapse(node) {
    if (node.type !== "split") return node;
    for (let i = 0; i < 2; i++) {
      if (
        node.children[i].type === "leaf" &&
        node.children[i].termId === termId
      )
        return node.children[1 - i];
    }
    return {
      ...node,
      children: [collapse(node.children[0]), collapse(node.children[1])],
    };
  }
  layoutRoot = collapse(layoutRoot);
}

// ─── Layout Rendering ───
function renderLayout() {
  const container = document.getElementById("term-panels");
  for (const [, t] of termMap) {
    if (t.element.parentNode) t.element.parentNode.removeChild(t.element);
  }
  container.innerHTML = "";
  if (!layoutRoot) {
    container.innerHTML =
      '<div class="term-empty"><button class="btn" onclick="openNewTermModal()">+ New Terminal</button></div>';
    return;
  }
  renderNode(layoutRoot, container);
  _headCache.clear(); // DOM was rebuilt — force header re-render
  updateTermHeaders();
  requestAnimationFrame(() => {
    for (const [termId, t] of termMap) {
      if (!t.opened && t.element.parentNode) {
        t.xterm.open(t.element);
        try {
          t.xterm.loadAddon(new WebglAddon.WebglAddon());
        } catch {}
        try {
          t.xterm.loadAddon(new ImageAddon.ImageAddon());
        } catch {}
        t.opened = true;
        if (t.pendingBuffer) {
          t.xterm.write(t.pendingBuffer);
          t.pendingBuffer = null;
        }
      }
    }
    // Single deferred fit after layout stabilizes
    setTimeout(fitAllTerminals, 120);
  });
  saveLayout();
}

// Event delegation: one set of listeners on #term-panels instead of per-node
const _termPanels = document.getElementById("term-panels");
_termPanels.addEventListener("mousedown", (e) => {
  const leaf = e.target.closest(".split-leaf");
  if (leaf) {
    activeTermId = leaf.dataset.termId;
    updateTermHeaders();
  }
});
_termPanels.addEventListener(
  "contextmenu",
  (e) => {
    const leaf = e.target.closest(".split-leaf");
    if (leaf) {
      e.preventDefault();
      e.stopPropagation();
      showTermCtxMenu(e, leaf.dataset.termId);
    }
  },
  true,
);
_termPanels.addEventListener("dblclick", (e) => {
  const name = e.target.closest(".th-name");
  if (!name) return;
  const head = name.closest(".term-head");
  if (!head) return;
  const tid = head.dataset.termId;
  if (tid) startRenameHeader(tid, head);
});
_termPanels.addEventListener("dragstart", (e) => {
  const head = e.target.closest(".term-head");
  if (!head) return;
  const tid = head.dataset.termId;
  draggedTermId = tid;
  head.style.cursor = "grabbing";
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", tid);
  requestAnimationFrame(() => {
    document.querySelectorAll(".split-leaf").forEach((l) => {
      if (l.dataset.termId !== tid) l.classList.add("drag-over");
    });
  });
});
_termPanels.addEventListener("dragend", (e) => {
  const head = e.target.closest(".term-head");
  if (head) head.style.cursor = "grab";
  draggedTermId = null;
  document
    .querySelectorAll(".split-leaf")
    .forEach((l) => l.classList.remove("drag-over"));
  document
    .querySelectorAll(".drop-zone")
    .forEach((z) => z.classList.remove("active"));
});
_termPanels.addEventListener("dragover", (e) => {
  const zone = e.target.closest(".drop-zone");
  if (zone) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    zone.classList.add("active");
  }
});
_termPanels.addEventListener("dragleave", (e) => {
  const zone = e.target.closest(".drop-zone");
  if (zone) zone.classList.remove("active");
});
_termPanels.addEventListener("drop", (e) => {
  const zone = e.target.closest(".drop-zone");
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove("active");
  const leaf = zone.closest(".split-leaf");
  if (leaf) leaf.classList.remove("drag-over");
  const targetId = leaf?.dataset.termId;
  const pos = ["top", "bottom", "left", "right"].find((p) =>
    zone.classList.contains(p),
  );
  if (draggedTermId && targetId && draggedTermId !== targetId && pos) {
    removeFromLayoutTree(draggedTermId);
    splitAt(targetId, draggedTermId, pos);
    activeTermId = draggedTermId;
    renderLayout();
    updateTermHeaders();
  }
});

function renderNode(node, container) {
  if (node.type === "leaf") {
    const t = termMap.get(node.termId);
    if (!t) return;
    const leaf = document.createElement("div");
    leaf.className = "split-leaf";
    leaf.dataset.termId = node.termId;
    leaf.style.display = "flex";
    leaf.style.flexDirection = "column";
    const head = document.createElement("div");
    head.className = "term-head";
    head.draggable = true;
    head.dataset.termId = node.termId;
    head.style.cursor = "grab";
    leaf.appendChild(head);
    leaf.appendChild(t.element);
    const overlay = document.createElement("div");
    overlay.className = "drop-overlay";
    ["top", "bottom", "left", "right"].forEach((pos) => {
      const zone = document.createElement("div");
      zone.className = `drop-zone ${pos}`;
      overlay.appendChild(zone);
    });
    leaf.appendChild(overlay);
    container.appendChild(leaf);
    return;
  }
  const splitEl = document.createElement("div");
  splitEl.className = `split-container ${node.dir === "h" ? "horizontal" : "vertical"}`;
  const prop = node.dir === "h" ? "width" : "height";
  const first = document.createElement("div");
  first.className = "split-child";
  first.style[prop] = `calc(${node.ratio * 100}% - 2px)`;
  first.style[node.dir === "h" ? "height" : "width"] = "100%";
  renderNode(node.children[0], first);
  splitEl.appendChild(first);
  const divider = document.createElement("div");
  divider.className = `split-divider ${node.dir === "h" ? "h" : "v"}`;
  divider.addEventListener("mousedown", (e) =>
    startDividerDrag(e, node, splitEl),
  );
  splitEl.appendChild(divider);
  const second = document.createElement("div");
  second.className = "split-child";
  second.style[prop] = `calc(${(1 - node.ratio) * 100}% - 2px)`;
  second.style[node.dir === "h" ? "height" : "width"] = "100%";
  renderNode(node.children[1], second);
  splitEl.appendChild(second);
  container.appendChild(splitEl);
}

function startDividerDrag(e, node, splitEl) {
  e.preventDefault();
  const isH = node.dir === "h";
  const rect = splitEl.getBoundingClientRect();
  const totalSize = isH ? rect.width : rect.height;
  const firstChild = splitEl.children[0],
    secondChild = splitEl.children[2];
  const prop = isH ? "width" : "height";
  const cover = document.createElement("div");
  cover.style.cssText =
    "position:fixed;inset:0;z-index:9999;cursor:" +
    (isH ? "col-resize" : "row-resize");
  document.body.appendChild(cover);
  document.body.style.cursor = isH ? "col-resize" : "row-resize";
  document.body.style.userSelect = "none";
  const onMove = (e) => {
    const pos = isH ? e.clientX - rect.left : e.clientY - rect.top;
    const ratio = Math.max(0.08, Math.min(0.92, pos / totalSize));
    node.ratio = ratio;
    firstChild.style[prop] = `calc(${ratio * 100}% - 2px)`;
    secondChild.style[prop] = `calc(${(1 - ratio) * 100}% - 2px)`;
    debouncedFit();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    cover.remove();
    fitAllTerminals();
    saveLayout();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// ─── Per-terminal headers ───
const _headCache = new Map();
let _termHeaderTimer = null;
function debouncedUpdateTermHeaders() {
  if (_termHeaderTimer) return;
  _termHeaderTimer = requestAnimationFrame(() => {
    _termHeaderTimer = null;
    updateTermHeaders();
  });
}
function updateTermHeaders() {
  document.querySelectorAll(".split-leaf").forEach((leaf) => {
    const tid = leaf.dataset.termId;
    const t = termMap.get(tid);
    if (!t) return;
    leaf.classList.toggle("active", tid === activeTermId);
    let head = leaf.querySelector(".term-head");
    if (!head) {
      head = document.createElement("div");
      head.className = "term-head";
      leaf.insertBefore(head, leaf.firstChild);
    }
    const g = state.projects.get(t.projectId)?.git || {};
    const s = state.projects.get(t.projectId)?.session || {};
    const model = s.model
      ? s.model.replace("claude-", "").replace(/-\d{8}$/, "")
      : "";
    const wt = (g.worktrees || []).filter((w) => !w.bare);
    // Cache key: skip rebuild if nothing changed
    const bufUsed = t.xterm.buffer.active.length;
    const bufPct = Math.round((bufUsed / 5000) * 100);
    const cacheKey = `${t.label}|${t.color}|${g.branch || ""}|${g.uncommittedCount || 0}|${model}|${wt.length}|${tid === activeTermId}|${bufPct}`;
    if (_headCache.get(tid) === cacheKey) return;
    _headCache.set(tid, cacheKey);
    const p = projectList.find((pp) => pp.id === t.projectId);
    const pPath = (p?.path || "").replace(/\\/g, "/");
    const currentWt = wt.find(
      (w) => w.path === pPath || pPath.endsWith(w.path),
    );
    let wtTag = "";
    if (wt.length > 1) {
      const wtName = currentWt
        ? currentWt.path.split("/").pop()
        : wt[0].path.split("/").pop();
      const popoverItems = wt
        .map((w) => {
          const isCur = w === currentWt;
          return `<div class="wt-popover-item${isCur ? " wt-current" : ""}"><span class="wt-branch">${esc(w.branch || "?")}${isCur ? " \u2190" : ""}</span><span class="wt-path">${esc(w.path)}</span></div>`;
        })
        .join("");
      wtTag = `<span class="th-tag th-worktree">${esc(wtName)} <span style="opacity:.5">+${wt.length - 1}</span><div class="wt-popover">${popoverItems}</div></span>`;
    }
    head.innerHTML =
      `<span class="th-dot" style="background:${t.color}"></span>` +
      `<span class="th-name">${esc(t.label)}</span>` +
      (g.branch ? `<span class="th-tag th-branch">${g.branch}</span>` : "") +
      wtTag +
      (g.uncommittedCount
        ? `<span class="th-tag th-changes" data-pid="${t.projectId}">\u00B1${g.uncommittedCount}</span>`
        : "") +
      (model ? `<span class="th-tag th-model">${model}</span>` : "") +
      (bufPct >= 80
        ? `<span class="th-tag" style="color:${bufPct >= 95 ? "var(--red)" : "var(--yellow)"};font-size:.7rem" title="Buffer: ${bufPct}% (${bufUsed}/5000 lines)">${bufPct}%</span>`
        : "") +
      `<span class="th-spacer"></span>` +
      `<button class="th-close" data-action="close" title="Close">\u00d7</button>`;
    head.onclick = (e) => {
      if (e.target.dataset.action === "close") {
        e.stopPropagation();
        closeTerminal(tid);
        return;
      }
      if (e.target.classList.contains("th-changes")) {
        e.stopPropagation();
        showDiffDialog(e.target.dataset.pid);
        return;
      }
    };
    head.ondblclick = (e) => {
      if (e.target.dataset.action === "close") return;
      e.stopPropagation();
      startRenameHeader(tid, head);
    };
  });
}
function startRenameHeader(termId, headEl) {
  const t = termMap.get(termId);
  if (!t) return;
  const nameSpan = headEl.querySelector(".th-name");
  const input = document.createElement("input");
  input.type = "text";
  input.value = t.label;
  input.style.cssText =
    "font-size:.68rem;padding:1px 4px;background:var(--bg-0);border:1px solid var(--accent);color:var(--text-1);border-radius:3px;width:100px;";
  const finish = () => {
    const val = input.value.trim();
    if (val) t.label = val;
    updateTermHeaders();
    saveLayout();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish();
    if (e.key === "Escape") updateTermHeaders();
    e.stopPropagation();
  });
  input.addEventListener("blur", finish);
  nameSpan.replaceWith(input);
  input.focus();
  input.select();
}
// ─── Context Menu ───
function showTermCtxMenu(e, termId) {
  const menu = document.getElementById("term-ctx-menu");
  const t = termMap.get(termId);
  if (!t) return;
  const g = state.projects.get(t.projectId)?.git || {};
  const hasChanges = g.uncommittedCount > 0;
  const sel = t.xterm.getSelection();

  // Detect file path under cursor
  let filePath = null;
  const wrap = t.element;
  const cellW = t.xterm._core._renderService?.dimensions?.css?.cell?.width || 8;
  const cellH =
    t.xterm._core._renderService?.dimensions?.css?.cell?.height || 16;
  const rect = wrap.querySelector(".xterm-screen")?.getBoundingClientRect();
  if (rect) {
    const col = Math.floor((e.clientX - rect.left) / cellW);
    const row =
      t.xterm.buffer.active.viewportY +
      Math.floor((e.clientY - rect.top) / cellH);
    filePath = getFilePathAtPosition(t.xterm, col, row);
  }

  let html = "";
  // File actions (if path detected)
  if (filePath) {
    html += `<div class="ctx-menu-label">File</div>`;
    html += `<div class="ctx-menu-item" data-act="preview" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">\u{1F441}</span>Preview</div>`;
    html += `<div class="ctx-menu-item" data-act="open-code" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">&lt;/&gt;</span>Open in VS Code</div>`;
    html += `<div class="ctx-menu-item" data-act="open-cursor" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">&lt;/&gt;</span>Open in Cursor</div>`;
    html += `<div class="ctx-menu-item" data-act="open-windsurf" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">&lt;/&gt;</span>Open in Windsurf</div>`;
    html += `<div class="ctx-menu-item" data-act="open-antigravity" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">&lt;/&gt;</span>Open in Antigravity</div>`;
    html += `<div class="ctx-menu-item" data-act="copy-path" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">\u{1F4CB}</span>Copy Path</div>`;
    html += `<div class="ctx-menu-item" data-act="open-folder" data-path="${escapeHtml(filePath)}"><span class="ctx-icon">\u{1F4C2}</span>Open in Explorer</div>`;
    html += `<div class="ctx-sep ctx-menu-sep"></div>`;
  }
  // Clipboard
  if (sel)
    html += `<div class="ctx-menu-item" data-act="copy"><span class="ctx-icon">\u{1F4CB}</span>Copy</div>`;
  html += `<div class="ctx-menu-item" data-act="paste"><span class="ctx-icon">\u{1F4CB}</span>Paste</div>`;
  html += `<div class="ctx-sep ctx-menu-sep"></div>`;
  // Terminal actions
  html += `<div class="ctx-menu-item" data-act="rename"><span class="ctx-icon">A</span>Rename</div>`;
  html += `<div class="ctx-menu-item" data-act="new"><span class="ctx-icon">+</span>New Terminal<span style="margin-left:auto" class="kbd">Ctrl+T</span></div>`;
  html += `<div class="ctx-menu-item" data-act="search"><span class="ctx-icon">\u{1F50D}</span>Search<span style="margin-left:auto" class="kbd">Ctrl+F</span></div>`;
  html += `<div class="ctx-sep ctx-menu-sep"></div>`;
  html += `<div class="ctx-menu-item" data-act="split-h"><span class="ctx-icon">\u2194</span>Split Right</div>`;
  html += `<div class="ctx-menu-item" data-act="split-v"><span class="ctx-icon">\u2195</span>Split Down</div>`;
  html += `<div class="ctx-sep ctx-menu-sep"></div>`;
  if (hasChanges)
    html += `<div class="ctx-menu-item" data-act="diff"><span class="ctx-icon">\u00B1</span>View Changes (${g.uncommittedCount})</div>`;
  html += `<div class="ctx-menu-item" data-act="ide"><span class="ctx-icon">&lt;/&gt;</span>Open Project in IDE</div>`;
  html += `<div class="ctx-menu-item" data-act="clear"><span class="ctx-icon">\u2327</span>Clear Terminal</div>`;
  html += `<div class="ctx-sep ctx-menu-sep"></div>`;
  html += `<div class="ctx-menu-item danger" data-act="close"><span class="ctx-icon">\u00d7</span>Close Terminal<span style="margin-left:auto" class="kbd">Ctrl+W</span></div>`;

  menu.innerHTML = html;
  menu.style.left = Math.min(e.clientX, window.innerWidth - 220) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 350) + "px";
  menu.classList.add("show");
  menu.onclick = (ev) => {
    const item = ev.target.closest("[data-act]");
    if (!item) return;
    menu.classList.remove("show");
    const path = item.dataset.path;
    switch (item.dataset.act) {
      case "preview":
        if (path) openFilePreview(path);
        break;
      case "open-code":
        if (path) openInIde(path, "code");
        break;
      case "open-cursor":
        if (path) openInIde(path, "cursor");
        break;
      case "open-windsurf":
        if (path) openInIde(path, "windsurf");
        break;
      case "open-antigravity":
        if (path) openInIde(path, "antigravity");
        break;
      case "copy-path":
        if (path) {
          navigator.clipboard.writeText(path);
          showToast("Path copied");
        }
        break;
      case "open-folder":
        if (path) openContainingFolder(path);
        break;
      case "copy": {
        const s = t.xterm.getSelection();
        if (s) {
          navigator.clipboard.writeText(s);
          t.xterm.clearSelection();
          showToast("Copied");
        }
        break;
      }
      case "paste":
        navigator.clipboard
          .readText()
          .then((txt) => {
            if (txt && ws?.readyState === 1)
              ws.send(JSON.stringify({ type: "input", termId, data: txt }));
          })
          .catch(() => {});
        break;
      case "rename": {
        const leaf = document.querySelector(
          `.split-leaf[data-term-id="${termId}"]`,
        );
        const head = leaf?.querySelector(".term-head");
        if (head) startRenameHeader(termId, head);
        break;
      }
      case "new":
        openNewTermModal();
        break;
      case "search":
        activeTermId = termId;
        toggleTermSearch();
        break;
      case "split-h":
        openNewTermModalWithSplit(termId, "right");
        break;
      case "split-v":
        openNewTermModalWithSplit(termId, "bottom");
        break;
      case "diff":
        showDiffDialog(t.projectId);
        break;
      case "ide":
        openInIDE(t.projectId);
        break;
      case "clear":
        t.xterm.clear();
        break;
      case "close":
        closeTerminal(termId);
        break;
    }
  };
  const dismiss = () => {
    menu.classList.remove("show");
    document.removeEventListener("click", dismiss);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", dismiss, true);
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") dismiss();
  };
  setTimeout(() => {
    document.addEventListener("click", dismiss);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", dismiss, true);
  }, 0);
}
function openNewTermModalWithSplit(targetTermId, pos) {
  const sel = document.getElementById("nt-project");
  sel.innerHTML = projectList
    .map((p) => `<option value="${p.id}">${p.name}</option>`)
    .join("");
  document.getElementById("new-term-modal").showModal();
  // override createTerminal to split at target
  window._splitTarget = { termId: targetTermId, pos };
}
function openInIDE(projectId) {
  fetch(`/api/projects/${projectId}/open-ide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => {});
}

async function showDiffDialog(projectId) {
  const dlg = document.getElementById("diff-dialog");
  const nav = document.getElementById("diff-file-nav");
  const panels = document.getElementById("diff-dialog-panels");
  const project = projectList.find((p) => p.id === projectId);
  document.getElementById("diff-dialog-title").textContent =
    `Changes \u2014 ${project?.name || projectId}`;
  panels.innerHTML =
    '<div style="padding:30px;text-align:center;color:var(--text-3)">Loading\u2026</div>';
  nav.innerHTML = "";
  dlg.showModal();
  try {
    const res = await fetch(`/api/projects/${projectId}/diff`);
    const data = await res.json();
    const stagedFiles = data.staged?.files || [];
    const unstagedFiles = data.unstaged?.files || [];
    const stagedDiff = data.staged?.diff || "";
    const unstagedDiff = data.unstaged?.diff || "";

    if (!stagedFiles.length && !unstagedFiles.length) {
      panels.innerHTML =
        '<div style="padding:40px;text-align:center;color:var(--text-3)">No changes</div>';
      return;
    }

    renderDiffSummary("diff-dialog-summary", stagedFiles, unstagedFiles);

    // File nav chips
    const allFiles = [
      ...stagedFiles.map((f) => ({ ...f, section: "staged" })),
      ...unstagedFiles.map((f) => ({ ...f, section: "unstaged" })),
    ];
    const statusColor = (s) => {
      const c = fileStatusLetter(s);
      return c === "A"
        ? "var(--green)"
        : c === "D"
          ? "var(--red)"
          : c === "R"
            ? "var(--blue)"
            : "var(--yellow)";
    };
    nav.innerHTML = allFiles
      .map((f) => {
        const pid = `dlg-dp-${f.section}-${f.file.replace(/[^a-zA-Z0-9]/g, "_")}`;
        const name = f.file.includes("/")
          ? f.file.substring(f.file.lastIndexOf("/") + 1)
          : f.file;
        return `<span class="diff-file-chip" data-panel="${pid}"><span class="fc-dot" style="background:${statusColor(f.status)}"></span>${esc(name)}</span>`;
      })
      .join("");

    nav.onclick = (e) => {
      const chip = e.target.closest(".diff-file-chip");
      if (!chip) return;
      const el = document.getElementById(chip.dataset.panel);
      if (el) {
        el.classList.remove("collapsed");
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };

    // Render panels with 'dlg-dp' prefix to avoid ID collision with main view
    renderDiffPanels(
      "diff-dialog-panels",
      stagedFiles,
      unstagedFiles,
      stagedDiff,
      unstagedDiff,
      "dlg-dp",
    );
  } catch {
    panels.innerHTML =
      '<div style="padding:30px;text-align:center;color:var(--red)">Error loading diff</div>';
  }
}
function closeTerminal(id) {
  const t = termMap.get(id);
  if (t) {
    if (ws?.readyState === 1)
      ws.send(JSON.stringify({ type: "kill", termId: id }));
    t.xterm.dispose();
    t.element.remove();
    termMap.delete(id);
  }
  const wb = writeBuffers.get(id);
  if (wb) {
    if (wb.timer) cancelAnimationFrame(wb.timer);
    writeBuffers.delete(id);
  }
  _headCache.delete(id);
  removeFromLayoutTree(id);
  if (activeTermId === id) {
    const first = termMap.keys().next().value;
    activeTermId = first || null;
  }
  renderLayout();
  updateTermHeaders();
}
window.closeTerminal = closeTerminal;
let fitDebounce = null;
function fitAllTerminals() {
  for (const [termId, t] of termMap) {
    if (t.opened && t.element.parentNode) {
      try {
        t.fitAddon.fit();
      } catch {}
      if (ws?.readyState === 1)
        ws.send(
          JSON.stringify({
            type: "resize",
            termId,
            cols: t.xterm.cols,
            rows: t.xterm.rows,
          }),
        );
    }
  }
}
function debouncedFit() {
  clearTimeout(fitDebounce);
  fitDebounce = setTimeout(fitAllTerminals, 80);
}
window.addEventListener("resize", debouncedFit);
// Observe terminal panel resizes
const termPanelsObs = new ResizeObserver(debouncedFit);
termPanelsObs.observe(document.getElementById("term-panels"));

window.openNewTermModal = () => {
  const sel = document.getElementById("nt-project");
  sel.innerHTML = projectList
    .map((p) => `<option value="${p.id}">${p.name}</option>`)
    .join("");
  document.getElementById("new-term-modal").showModal();
  loadBranchesForTerm();
};
window.createTerminal = () => {
  const projectId = document.getElementById("nt-project").value;
  let cmd = document.getElementById("nt-cmd").value;
  document.getElementById("new-term-modal").close();
  const msg = {
    type: "create",
    projectId,
    command: cmd || undefined,
    cols: 120,
    rows: 30,
  };
  if (_selectedBranch) {
    if (_selectedBranch.type === "worktree" && _selectedBranch.cwd) {
      msg.cwd = _selectedBranch.cwd;
    } else if (_selectedBranch.type === "local") {
      const checkout = `git checkout ${_selectedBranch.value}`;
      msg.command = cmd ? `${checkout} && ${cmd}` : checkout;
    } else if (_selectedBranch.type === "remote") {
      const localName = _selectedBranch.value.replace(/^[^/]+\//, "");
      const checkout = `git checkout -b ${localName} ${_selectedBranch.value} 2>/dev/null || git checkout ${localName}`;
      msg.command = cmd ? `${checkout} && ${cmd}` : checkout;
    }
  }
  _selectedBranch = null;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Terminal not connected", "error");
    return;
  }
  ws.send(JSON.stringify(msg));
  switchView("terminal");
};
window.openTermWith = (projectId, cmd) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Terminal not connected", "error");
    return;
  }
  ws.send(
    JSON.stringify({
      type: "create",
      projectId,
      command: cmd || undefined,
      cols: 120,
      rows: 30,
    }),
  );
  switchView("terminal");
};

// ─── IDE ───
window.openIDE = async (projectId, ide) => {
  await fetch(`/api/projects/${projectId}/open-ide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ide }),
  });
};
window.openGitHub = (projectId) => {
  const proj = projectList.find((p) => p.id === projectId);
  const g = state.projects.get(projectId)?.git || {};
  const url = proj?.github || g.remoteUrl || "";
  if (url) window.open(url, "_blank");
};

// ─── Diff Utilities ───
function parseDiffToFiles(diffText) {
  if (!diffText || !diffText.trim()) return [];
  const chunks = diffText.split(/(?=^diff --git )/m);
  return chunks
    .filter((c) => c.startsWith("diff "))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const m = lines[0].match(/b\/(.+)$/);
      return { path: m ? m[1] : "?", lines };
    });
}

const DIFF_LINE_LIMIT = 500;
function renderDiffTable(lines) {
  let oldN = 0,
    newN = 0,
    prevOldEnd = 0,
    prevNewEnd = 0,
    hunkCount = 0;
  const rows = [];
  let rowCount = 0;
  const totalLines = lines.length;
  let truncated = false;
  for (const line of lines) {
    if (line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (rowCount >= DIFF_LINE_LIMIT) {
      truncated = true;
      break;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)/);
    if (hunkMatch) {
      const hunkOldStart = parseInt(hunkMatch[1], 10);
      const hunkNewStart = parseInt(hunkMatch[3], 10);
      if (hunkCount > 0) {
        const skippedOld = hunkOldStart - prevOldEnd;
        const skippedNew = hunkNewStart - prevNewEnd;
        const skipped = Math.max(skippedOld, skippedNew);
        if (skipped > 0) {
          rows.push(
            `<tr class="dl-fold"><td class="dl-gutter" colspan="2"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg></td><td class="dl-code" style="color:var(--text-3);font-style:italic;font-size:.75rem">... ${skipped} lines hidden ...</td></tr>`,
          );
        }
      }
      oldN = hunkOldStart;
      newN = hunkNewStart;
      rows.push(
        `<tr class="dl-hunk"><td class="dl-gutter" colspan="2"></td><td class="dl-code">${esc(line)}</td></tr>`,
      );
      hunkCount++;
      continue;
    }
    if (line.startsWith("+")) {
      rows.push(
        `<tr class="dl-add"><td class="dl-gutter"></td><td class="dl-gutter dl-gutter-new">${newN}</td><td class="dl-code">${esc(line)}</td></tr>`,
      );
      newN++;
      prevNewEnd = newN;
    } else if (line.startsWith("-")) {
      rows.push(
        `<tr class="dl-del"><td class="dl-gutter">${oldN}</td><td class="dl-gutter dl-gutter-new"></td><td class="dl-code">${esc(line)}</td></tr>`,
      );
      oldN++;
      prevOldEnd = oldN;
    } else if (line !== "") {
      rows.push(
        `<tr class="dl-ctx"><td class="dl-gutter">${oldN}</td><td class="dl-gutter dl-gutter-new">${newN}</td><td class="dl-code">${esc(line)}</td></tr>`,
      );
      oldN++;
      newN++;
      prevOldEnd = oldN;
      prevNewEnd = newN;
    }
    rowCount++;
  }
  if (truncated) {
    const remaining = totalLines - DIFF_LINE_LIMIT;
    rows.push(
      `<tr class="dl-truncated"><td colspan="3" style="padding:8px 12px;text-align:center;color:var(--text-3);font-size:.78rem;background:var(--bg-surface);cursor:pointer" onclick="this.closest('.diff-panel-body').innerHTML=renderDiffTableFull(this.closest('.diff-panel-body').dataset.lines)">Showing ${DIFF_LINE_LIMIT} of ${totalLines} lines \u2014 click to show all</td></tr>`,
    );
  }
  return `<table>${rows.join("")}</table>`;
}
// Full render (no limit) for "show all" click
function renderDiffTableFull(linesJson) {
  const lines = JSON.parse(linesJson);
  let oldN = 0,
    newN = 0,
    prevOldEnd = 0,
    prevNewEnd = 0,
    hunkCount = 0;
  const rows = [];
  for (const line of lines) {
    if (line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)/);
    if (hunkMatch) {
      const hOld = parseInt(hunkMatch[1], 10),
        hNew = parseInt(hunkMatch[3], 10);
      if (hunkCount > 0) {
        const sk = Math.max(hOld - prevOldEnd, hNew - prevNewEnd);
        if (sk > 0)
          rows.push(
            `<tr class="dl-fold"><td class="dl-gutter" colspan="2"></td><td class="dl-code" style="color:var(--text-3);font-style:italic;font-size:.75rem">... ${sk} lines hidden ...</td></tr>`,
          );
      }
      oldN = hOld;
      newN = hNew;
      rows.push(
        `<tr class="dl-hunk"><td class="dl-gutter" colspan="2"></td><td class="dl-code">${esc(line)}</td></tr>`,
      );
      hunkCount++;
      continue;
    }
    if (line.startsWith("+")) {
      rows.push(
        `<tr class="dl-add"><td class="dl-gutter"></td><td class="dl-gutter dl-gutter-new">${newN}</td><td class="dl-code">${esc(line)}</td></tr>`,
      );
      newN++;
      prevNewEnd = newN;
    } else if (line.startsWith("-")) {
      rows.push(
        `<tr class="dl-del"><td class="dl-gutter">${oldN}</td><td class="dl-gutter dl-gutter-new"></td><td class="dl-code">${esc(line)}</td></tr>`,
      );
      oldN++;
      prevOldEnd = oldN;
    } else if (line !== "") {
      rows.push(
        `<tr class="dl-ctx"><td class="dl-gutter">${oldN}</td><td class="dl-gutter dl-gutter-new">${newN}</td><td class="dl-code">${esc(line)}</td></tr>`,
      );
      oldN++;
      newN++;
      prevOldEnd = oldN;
      prevNewEnd = newN;
    }
  }
  return `<table>${rows.join("")}</table>`;
}

function fileStatusLetter(status) {
  if (!status) return "M";
  const s = status.charAt(0).toUpperCase();
  if (s === "A") return "A";
  if (s === "D") return "D";
  if (s === "R") return "R";
  return "M";
}

function buildDiffPanel(filePath, fileInfo, sectionType, panelId) {
  const st = fileStatusLetter(fileInfo?.status);
  const dir = filePath.includes("/")
    ? filePath.substring(0, filePath.lastIndexOf("/") + 1)
    : "";
  const name = filePath.includes("/")
    ? filePath.substring(filePath.lastIndexOf("/") + 1)
    : filePath;
  const add = fileInfo?.additions || 0;
  const del = fileInfo?.deletions || 0;
  const badge =
    sectionType === "staged"
      ? '<span class="dp-badge staged">Staged</span>'
      : '<span class="dp-badge unstaged">Unstaged</span>';
  const efn = esc(filePath).replace(/'/g, "\\'");
  const isStaged = sectionType === "staged";
  let actionsHtml = '<span class="dp-actions">';
  if (!isStaged) {
    actionsHtml += `<button class="dp-action" onclick="event.stopPropagation();diffDiscardFile('${efn}')" title="Discard changes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-8.36L1 10"/></svg></button>`;
    actionsHtml += `<button class="dp-action" onclick="event.stopPropagation();diffStageFile('${efn}')" title="Stage file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button>`;
  } else {
    actionsHtml += `<button class="dp-action" onclick="event.stopPropagation();diffUnstageFile('${efn}')" title="Unstage file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg></button>`;
  }
  actionsHtml += "</span>";
  return `<div class="diff-panel" id="${panelId}" data-file="${esc(filePath)}" data-section="${sectionType}">
    <div class="diff-panel-head" onclick="this.parentElement.classList.toggle('collapsed')">
      <span class="dp-chevron">▼</span>
      <span class="dp-status st-${st}">${st}</span>
      <span class="dp-path"><span class="dp-dir">${esc(dir)}</span>${esc(name)}</span>
      <span class="dp-stat">${add ? `<span class="ps-add">+${add}</span>` : ""}${del ? `<span class="ps-del">-${del}</span>` : ""}</span>
      ${badge}
      ${actionsHtml}
    </div>
    <div class="diff-panel-body"></div>
  </div>`;
}

function renderDiffSummary(targetId, stagedFiles, unstagedFiles) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const total = stagedFiles.length + unstagedFiles.length;
  const totalAdd = [...stagedFiles, ...unstagedFiles].reduce(
    (s, f) => s + (f.additions || 0),
    0,
  );
  const totalDel = [...stagedFiles, ...unstagedFiles].reduce(
    (s, f) => s + (f.deletions || 0),
    0,
  );
  if (!total) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML =
    `<span class="ds-files">${total} file${total > 1 ? "s" : ""}</span>` +
    (totalAdd ? `<span class="ds-add">+${totalAdd}</span>` : "") +
    (totalDel ? `<span class="ds-del">\u2212${totalDel}</span>` : "");
}

function renderDiffSidebar(stagedFiles, unstagedFiles, allParsed) {
  const sb = document.getElementById("diff-sidebar-list");
  if (!sb) return;
  const buildGroup = (label, files, section) => {
    if (!files.length) return "";
    const isStaged = section === "staged";
    const actionIcon = isStaged
      ? `<button class="ds-action" onclick="event.stopPropagation();diffUnstageAll()" title="Unstage All"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg></button>`
      : `<button class="ds-action" onclick="event.stopPropagation();diffStageAll()" title="Stage All"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button>`;
    const discardIcon = !isStaged
      ? `<button class="ds-action" onclick="event.stopPropagation();diffDiscardAll()" title="Discard All"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>`
      : "";
    let html = `<div class="ds-group" data-section="${section}"><div class="ds-group-head"><span class="ds-chevron">▼</span>${label}<span class="ds-count">${files.length}</span><span class="ds-actions">${discardIcon}${actionIcon}</span></div><div class="ds-group-items">`;
    for (const f of files) {
      const st = fileStatusLetter(f.status);
      const name = f.file.includes("/")
        ? f.file.substring(f.file.lastIndexOf("/") + 1)
        : f.file;
      const pid = `dp-${section}-${f.file.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const efn = esc(f.file).replace(/'/g, "\\'");
      const stageBtn = isStaged
        ? `<button class="fi-action fa-unstage" onclick="event.stopPropagation();diffUnstageFile('${efn}')" title="Unstage"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg></button>`
        : `<button class="fi-action fa-stage" onclick="event.stopPropagation();diffStageFile('${efn}')" title="Stage"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></button>`;
      const discardBtn = !isStaged
        ? `<button class="fi-action fa-discard" onclick="event.stopPropagation();diffDiscardFile('${efn}')" title="Discard"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-8.36L1 10"/></svg></button>`
        : "";
      html += `<div class="diff-file-item" data-panel="${pid}" data-file="${esc(f.file)}" onclick="scrollToDiffPanel('${pid}')">
        <span class="fi-status st-${st}">${st}</span>
        <span class="fi-name" title="${esc(f.file)}">${esc(name)}</span>
        <span class="fi-stat">${f.additions ? `<span class="fs-add">+${f.additions}</span>` : ""}${f.deletions ? `<span class="fs-del">-${f.deletions}</span>` : ""}</span>
        <span class="fi-actions">${discardBtn}${stageBtn}</span>
      </div>`;
    }
    html += "</div></div>";
    return html;
  };
  sb.innerHTML =
    buildGroup("Staged", stagedFiles, "staged") +
    buildGroup("Unstaged", unstagedFiles, "unstaged");

  sb.querySelectorAll(".ds-group-head").forEach((h) => {
    h.addEventListener("click", (e) => {
      if (e.target.closest(".ds-action")) return;
      h.parentElement.classList.toggle("collapsed");
    });
  });

  updateCommitBar(stagedFiles.length);
}

function renderDiffPanels(
  targetId,
  stagedFiles,
  unstagedFiles,
  stagedDiff,
  unstagedDiff,
  prefix = "dp",
) {
  const container = document.getElementById(targetId);
  if (!container) return;
  const stagedParsed = parseDiffToFiles(stagedDiff);
  const unstagedParsed = parseDiffToFiles(unstagedDiff);
  let html = "";

  if (stagedFiles.length) {
    html += `<div class="diff-section-label"><span class="dsl-dot" style="background:var(--accent)"></span>Staged</div>`;
    for (const f of stagedFiles) {
      const pid = `${prefix}-staged-${f.file.replace(/[^a-zA-Z0-9]/g, "_")}`;
      html += buildDiffPanel(f.file, f, "staged", pid);
    }
  }
  if (unstagedFiles.length) {
    html += `<div class="diff-section-label"><span class="dsl-dot" style="background:var(--yellow)"></span>Unstaged</div>`;
    for (const f of unstagedFiles) {
      const pid = `${prefix}-unstaged-${f.file.replace(/[^a-zA-Z0-9]/g, "_")}`;
      html += buildDiffPanel(f.file, f, "unstaged", pid);
    }
  }
  container.innerHTML = html;

  // Now render tables into panel bodies
  const renderBodies = (parsed, section) => {
    for (const p of parsed) {
      const f = (section === "staged" ? stagedFiles : unstagedFiles).find(
        (x) => x.file === p.path || p.path.endsWith(x.file),
      );
      const pid = `${prefix}-${section}-${(f?.file || p.path).replace(/[^a-zA-Z0-9]/g, "_")}`;
      const panel = document.getElementById(pid);
      if (panel) {
        const body = panel.querySelector(".diff-panel-body");
        if (p.lines.length > DIFF_LINE_LIMIT)
          body.dataset.lines = JSON.stringify(p.lines);
        body.innerHTML = renderDiffTable(p.lines);
      }
    }
  };
  renderBodies(stagedParsed, "staged");
  renderBodies(unstagedParsed, "unstaged");
}

window.scrollToDiffPanel = (pid) => {
  const el = document.getElementById(pid);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  // highlight in sidebar
  document
    .querySelectorAll(".diff-file-item.active")
    .forEach((x) => x.classList.remove("active"));
  document
    .querySelector(`.diff-file-item[data-panel="${pid}"]`)
    ?.classList.add("active");
  // ensure panel is expanded
  el.classList.remove("collapsed");
};

let _diffAbort = null;
let _diffDebounceTimer = null;
function debouncedLoadDiff() {
  if (_diffDebounceTimer) clearTimeout(_diffDebounceTimer);
  _diffDebounceTimer = setTimeout(() => {
    _diffDebounceTimer = null;
    loadDiff();
  }, 1000);
}
window.loadDiff = async () => {
  const sel = document.getElementById("diff-project");
  const projectId = sel.value;
  if (!projectId) return;
  // Cancel previous in-flight diff request
  if (_diffAbort) {
    _diffAbort.abort();
    _diffAbort = null;
  }
  _diffAbort = new AbortController();
  const signal = _diffAbort.signal;
  const mainEl = document.getElementById("diff-main");
  mainEl.innerHTML =
    '<div style="padding:40px;text-align:center;color:var(--text-3)">Loading...</div>';
  updateDiffBranchInfo();

  try {
    const res = await fetch(`/api/projects/${projectId}/diff`, { signal });
    const data = await res.json();
    const stagedFiles = data.staged?.files || [];
    const unstagedFiles = data.unstaged?.files || [];
    const stagedDiff = data.staged?.diff || "";
    const unstagedDiff = data.unstaged?.diff || "";

    if (!stagedFiles.length && !unstagedFiles.length) {
      mainEl.innerHTML = "";
      mainEl.appendChild(createDiffEmpty());
      document.getElementById("diff-sidebar-list").innerHTML = "";
      renderDiffSummary("diff-summary", [], []);
      updateCommitBar(0);
      return;
    }

    renderDiffSummary("diff-summary", stagedFiles, unstagedFiles);
    renderDiffSidebar(stagedFiles, unstagedFiles);
    mainEl.innerHTML = "";
    const panelsDiv = document.createElement("div");
    panelsDiv.id = "diff-panels-inner";
    panelsDiv.className = "diff-main-inner";
    mainEl.appendChild(panelsDiv);
    renderDiffPanels(
      "diff-panels-inner",
      stagedFiles,
      unstagedFiles,
      stagedDiff,
      unstagedDiff,
    );
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by newer request
    mainEl.innerHTML =
      '<div style="padding:40px;text-align:center;color:var(--red)">Error loading diff</div>';
  } finally {
    if (!signal.aborted) _diffAbort = null;
  }
};

function createDiffEmpty() {
  const d = document.createElement("div");
  d.className = "diff-empty";
  d.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
    <span class="de-title">No changes</span>
    <span class="de-sub">Working tree is clean</span>`;
  return d;
}

// ─── Diff Actions: Stage / Unstage / Discard ───
function _diffProjectId() {
  return document.getElementById("diff-project")?.value;
}

async function _diffGitAction(action, files) {
  const projectId = _diffProjectId();
  if (!projectId) return;
  try {
    const res = await fetch(`/api/projects/${projectId}/git/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error, "error");
      return;
    }
    loadDiff();
  } catch (err) {
    showToast(`${action} failed: ${err.message}`, "error");
  }
}

window.diffStageFile = (file) => _diffGitAction("stage", [file]);
window.diffUnstageFile = (file) => _diffGitAction("unstage", [file]);
window.diffDiscardFile = (file) => {
  if (!confirm(`Discard changes to "${file}"? This cannot be undone.`)) return;
  _diffGitAction("discard", [file]);
};
window.diffStageAll = () => _diffGitAction("stage", ["--all"]);
window.diffUnstageAll = () => _diffGitAction("unstage", ["--all"]);
window.diffDiscardAll = () => {
  if (!confirm("Discard ALL unstaged changes? This cannot be undone.")) return;
  const items = document.querySelectorAll(
    '.ds-group[data-section="unstaged"] .diff-file-item',
  );
  const files = [...items].map((el) => el.dataset.file).filter(Boolean);
  if (files.length) _diffGitAction("discard", files);
};

// ─── Expand / Collapse All ───
window.diffExpandAll = () => {
  document
    .querySelectorAll("#diff-main .diff-panel.collapsed")
    .forEach((p) => p.classList.remove("collapsed"));
};
window.diffCollapseAll = () => {
  document
    .querySelectorAll("#diff-main .diff-panel:not(.collapsed)")
    .forEach((p) => p.classList.add("collapsed"));
};

// ─── Sidebar File Search ───
window.filterDiffFiles = () => {
  const q = (document.getElementById("diff-file-search")?.value || "")
    .toLowerCase()
    .trim();
  document
    .querySelectorAll("#diff-sidebar-list .diff-file-item")
    .forEach((el) => {
      const file = (el.dataset.file || "").toLowerCase();
      el.style.display = !q || file.includes(q) ? "" : "none";
    });
  // Also filter panels in main area
  document.querySelectorAll("#diff-main .diff-panel").forEach((el) => {
    const file = (el.dataset.file || "").toLowerCase();
    el.style.display = !q || file.includes(q) ? "" : "none";
  });
};

// ─── Commit Box (in sidebar) ───
let _diffStagedCount = 0;
function updateCommitBar(stagedCount) {
  _diffStagedCount = stagedCount;
  const info = document.getElementById("dcb-staged-info");
  const btn = document.getElementById("dcb-commit-btn");
  if (!info) return;
  if (stagedCount > 0) {
    info.textContent = `${stagedCount} staged`;
    btn.disabled = false;
  } else {
    info.textContent = "No staged files";
    btn.disabled = true;
  }
}

window.doManualCommit = async () => {
  const msg = document.getElementById("diff-commit-msg")?.value?.trim();
  if (!msg) {
    showToast("Enter a commit message", "info");
    document.getElementById("diff-commit-msg")?.focus();
    return;
  }
  const projectId = _diffProjectId();
  if (!projectId) return;
  const btn = document.getElementById("dcb-commit-btn");
  btn.disabled = true;
  const origHTML = btn.innerHTML;
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:acSpin 1s linear infinite;width:13px;height:13px"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Committing...';
  try {
    const res = await fetch(`/api/projects/${projectId}/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg }),
    });
    const data = await res.json();
    if (data.error) {
      showToast("Commit failed: " + data.error, "error");
    } else {
      showToast("Committed: " + msg, "success");
      document.getElementById("diff-commit-msg").value = "";
    }
    loadDiff();
  } catch (err) {
    showToast("Commit error: " + err.message, "error");
  }
  btn.disabled = false;
  btn.innerHTML = origHTML;
};

// ─── AI Commit Message Generator ───
window.generateCommitMsg = async () => {
  const projectId = _diffProjectId();
  if (!projectId) return;
  const btn = document.getElementById("dcb-ai-btn");
  const textarea = document.getElementById("diff-commit-msg");
  if (!btn || !textarea) return;

  btn.disabled = true;
  btn.classList.add("loading");
  textarea.classList.add("ai-loading");
  textarea.value = "";
  textarea.placeholder = "✦ AI analyzing staged changes...";

  try {
    const res = await fetch(`/api/projects/${projectId}/generate-commit-msg`, {
      method: "POST",
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error, "error");
    } else if (data.message) {
      textarea.value = data.message;
      textarea.focus();
      textarea.style.height = "auto";
      textarea.style.height = textarea.scrollHeight + "px";
      showToast("Commit message generated", "success");
    }
  } catch (err) {
    showToast("AI error: " + err.message, "error");
  }
  btn.disabled = false;
  btn.classList.remove("loading");
  textarea.classList.remove("ai-loading");
  textarea.placeholder = "Commit message (Ctrl+Enter to commit)";
};

// ─── Auto Commit (Haiku AI) ───
let _acPlan = null; // { projectId, commits:[{message,files,reasoning}], pending:[] }
let _acExecuting = false;
let _acDragFile = null; // { file, fromCommit (index|-1 for pending) }
let _acBranchInfo = null; // { branch, worktrees }

// --- Branch / Worktree display in Changes tab toolbar ---
async function updateDiffBranchInfo() {
  const el = document.getElementById("diff-branch-info");
  if (!el) return;
  const sel = document.getElementById("diff-project");
  const projectId = sel?.value;
  if (!projectId) {
    el.innerHTML = "";
    _acBranchInfo = null;
    return;
  }
  try {
    const res = await fetch(`/api/projects/${projectId}/git`);
    const data = await res.json();
    _acBranchInfo = {
      branch: data.branch || "unknown",
      worktrees: data.worktrees || [],
    };
    const branchSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v12"/><path d="M18 9a3 3 0 100-6 3 3 0 000 6z"/><path d="M6 21a3 3 0 100-6 3 3 0 000 6z"/><path d="M18 9c0 6-12 6-12 12"/></svg>`;
    let html = `<span class="dbi-branch" onclick="toggleBranchDropdown(event)">${branchSvg}${esc(data.branch || "unknown")}<span class="dbi-chevron">▼</span></span>`;
    if (data.worktrees?.length > 1) {
      html += `<span class="dbi-wt" onclick="toggleWorktreeDropdown(event)">${data.worktrees.length} worktrees</span>`;
    }
    html += '<div class="branch-dropdown" id="branch-dropdown"></div>';
    el.innerHTML = html;
  } catch {
    el.innerHTML = "";
    _acBranchInfo = null;
  }
}

// ─── Branch Switcher ───
window.toggleBranchDropdown = async (e) => {
  e.stopPropagation();
  const dd = document.getElementById("branch-dropdown");
  if (!dd) return;
  if (dd.classList.contains("open")) {
    dd.classList.remove("open");
    return;
  }
  const projectId = _diffProjectId();
  if (!projectId) return;

  dd.innerHTML =
    '<div style="padding:12px;text-align:center;color:var(--text-3);font-size:.76rem">Loading...</div>';
  dd.classList.add("open");

  try {
    const res = await fetch(`/api/projects/${projectId}/branches`);
    const data = await res.json();
    const current = data.current || _acBranchInfo?.branch || "";
    const locals = data.local || [];
    const remotes = (data.remote || []).filter((r) => {
      const short = r.replace(/^origin\//, "");
      return !locals.includes(short);
    });

    let html =
      '<div class="bd-search"><input type="text" placeholder="Search branches..." oninput="filterBranchDropdown(this.value)" autofocus></div>';

    if (locals.length) {
      html += '<div class="bd-section"><div class="bd-label">Local</div>';
      for (const b of locals) {
        const isCurrent = b === current;
        const canDelete = !isCurrent && !["main", "master"].includes(b);
        html += `<div class="bd-item ${isCurrent ? "current" : ""}" data-branch="${esc(b)}" onclick="switchBranch('${esc(b).replace(/'/g, "\\'")}')"><span class="bd-check">${isCurrent ? "●" : ""}</span><span class="bd-name">${esc(b)}</span>${canDelete ? `<span class="bd-delete" onclick="event.stopPropagation();deleteBranch('${projectId}','${esc(b).replace(/'/g, "\\'")}')" title="Delete branch">&times;</span>` : ""}</div>`;
      }
      html += "</div>";
    }
    if (remotes.length) {
      html += '<div class="bd-section"><div class="bd-label">Remote</div>';
      for (const b of remotes) {
        const short = b.replace(/^origin\//, "");
        html += `<div class="bd-item" data-branch="${esc(short)}" onclick="switchBranch('${esc(short).replace(/'/g, "\\'")}')"><span class="bd-check"></span><span class="bd-name">${esc(b)}</span></div>`;
      }
      html += "</div>";
    }

    // Worktrees section
    const wts = data.worktrees || _acBranchInfo?.worktrees || [];
    if (wts.length > 1) {
      html +=
        '<div class="bd-section" style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><div class="bd-label">Worktrees</div>';
      for (const wt of wts) {
        const wtName = wt.path
          ? wt.path.split(/[/\\]/).pop()
          : wt.branch || "?";
        const isCurrent = wt.branch === current;
        html += `<div class="bd-item ${isCurrent ? "current" : ""}" data-branch="${esc(wt.branch || "")}" onclick="switchBranch('${esc(wt.branch || "").replace(/'/g, "\\'")}')"><span class="bd-check">${isCurrent ? "●" : ""}</span><span class="bd-name">${esc(wtName)} <span style="color:var(--text-3);font-size:.68rem">(${esc(wt.branch || "")})</span></span></div>`;
      }
      html += "</div>";
    }

    html += `<div class="branch-create-row"><input type="text" id="new-branch-input" placeholder="New branch name..." onkeydown="if(event.key==='Enter'){event.stopPropagation();createBranch('${projectId}')}"><button onclick="event.stopPropagation();createBranch('${projectId}')">Create</button></div>`;

    dd.innerHTML = html;
    dd.querySelector(".bd-search input")?.focus();
  } catch (err) {
    dd.innerHTML = `<div style="padding:12px;text-align:center;color:var(--red);font-size:.76rem">Error: ${err.message}</div>`;
  }

  // Close on outside click
  const close = (ev) => {
    if (!dd.contains(ev.target)) {
      dd.classList.remove("open");
      document.removeEventListener("click", close);
    }
  };
  setTimeout(() => document.addEventListener("click", close), 0);
};

window.filterBranchDropdown = (q) => {
  const dd = document.getElementById("branch-dropdown");
  if (!dd) return;
  const query = q.toLowerCase().trim();
  dd.querySelectorAll(".bd-item").forEach((item) => {
    const name = (item.dataset.branch || "").toLowerCase();
    item.style.display = !query || name.includes(query) ? "" : "none";
  });
};

window.switchBranch = async (branch) => {
  const projectId = _diffProjectId();
  if (!projectId) return;
  const dd = document.getElementById("branch-dropdown");
  if (dd) dd.classList.remove("open");

  if (branch === _acBranchInfo?.branch) return; // already on this branch

  showToast(`Switching to ${branch}...`, "info");
  try {
    const res = await fetch(`/api/projects/${projectId}/git/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch }),
    });
    const data = await res.json();
    if (data.error) {
      showToast("Switch failed: " + data.error, "error");
    } else {
      showToast(`Switched to ${branch}`, "success");
      loadDiff();
    }
  } catch (err) {
    showToast("Switch error: " + err.message, "error");
  }
};

window.toggleWorktreeDropdown = (e) => {
  // Reuse branch dropdown but scroll to worktrees section
  toggleBranchDropdown(e);
};

window.startAutoCommit = async () => {
  const sel = document.getElementById("diff-project");
  const projectId = sel.value;
  if (!projectId) return;

  const btn = document.getElementById("ac-btn");
  btn.classList.add("loading");
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Analyzing...`;

  try {
    const res = await fetch(`/api/projects/${projectId}/auto-commit/plan`, {
      method: "POST",
    });
    const data = await res.json();

    if (data.error) {
      showToast(data.error, "error");
      resetAcBtn();
      return;
    }
    if (!data.commits?.length) {
      showToast("No changes to commit", "info");
      resetAcBtn();
      return;
    }

    _acPlan = {
      projectId,
      commits: data.commits,
      pending: [],
      truncated: !!data.truncated,
    };
    renderAutoCommitPlan();
    if (data.truncated)
      showToast(
        "Diff was truncated — some files grouped by directory heuristic",
        "info",
      );
  } catch (err) {
    showToast("Failed to get AI plan: " + err.message, "error");
  }
  resetAcBtn();
};

function resetAcBtn() {
  const btn = document.getElementById("ac-btn");
  btn.classList.remove("loading");
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M5.5 8.5l13 7M18.5 8.5l-13 7"/></svg>AI Commit`;
}

// --- File tag with drag + move arrow ---
function acFileTag(file, commitIdx) {
  const name = file.includes("/")
    ? file.substring(file.lastIndexOf("/") + 1)
    : file;
  const isPending = commitIdx === -1;
  const arrowTitle = isPending ? "Move up to commit" : "Move to pending";
  const tag = document.createElement("span");
  tag.className = "ac-file-tag";
  tag.title = file;
  tag.draggable = true;
  tag.dataset.file = file;
  tag.dataset.from = String(commitIdx);
  tag.innerHTML = `<span class="aft-dot" style="background:var(--yellow)"></span>${esc(name)}<span class="aft-down" title="${arrowTitle}">\u25BC</span>`;

  // Drag start
  tag.addEventListener("dragstart", (e) => {
    _acDragFile = { file, fromCommit: commitIdx };
    tag.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", file);
  });
  tag.addEventListener("dragend", () => {
    tag.classList.remove("dragging");
    _acDragFile = null;
  });

  // Arrow click: move to pending (if in commit) or move to last commit (if in pending)
  tag.querySelector(".aft-down").addEventListener("click", (e) => {
    e.stopPropagation();
    if (isPending) {
      // Move to last commit
      const lastIdx = _acPlan.commits.length - 1;
      if (lastIdx >= 0) acMoveFile(file, -1, lastIdx);
    } else {
      acMoveFile(file, commitIdx, -1);
    }
  });

  return tag;
}

// --- Move file between commits / pending ---
function acMoveFile(file, fromIdx, toIdx) {
  if (!_acPlan || fromIdx === toIdx) return;
  // Remove from source
  if (fromIdx === -1) {
    _acPlan.pending = _acPlan.pending.filter((f) => f !== file);
  } else {
    const c = _acPlan.commits[fromIdx];
    if (c) c.files = c.files.filter((f) => f !== file);
  }
  // Add to target
  if (toIdx === -1) {
    if (!_acPlan.pending.includes(file)) _acPlan.pending.push(file);
  } else {
    const c = _acPlan.commits[toIdx];
    if (c && !c.files.includes(file)) c.files.push(file);
  }
  rerenderAcBody();
}

// --- Add new commit ---
function acAddCommit() {
  if (!_acPlan) return;
  _acPlan.commits.push({
    message: "chore: new commit",
    files: [],
    reasoning: "",
  });
  rerenderAcBody();
}

// --- Delete commit (moves files to pending) ---
function acDeleteCommit(idx) {
  if (!_acPlan || !_acPlan.commits[idx]) return;
  const files = _acPlan.commits[idx].files;
  files.forEach((f) => {
    if (!_acPlan.pending.includes(f)) _acPlan.pending.push(f);
  });
  _acPlan.commits.splice(idx, 1);
  rerenderAcBody();
}

// --- Setup drop zone ---
function acDropZone(el, targetIdx) {
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add(targetIdx === -1 ? "drag-over" : "drag-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (_acDragFile) {
      acMoveFile(_acDragFile.file, _acDragFile.fromCommit, targetIdx);
      _acDragFile = null;
    }
  });
}

// --- Rerender the body (commits + pending) ---
function rerenderAcBody() {
  if (!_acPlan) return;
  const body = document.getElementById("ac-body");
  if (!body) return;
  body.innerHTML = "";

  const plan = _acPlan;

  // Commit cards
  plan.commits.forEach((c, i) => {
    const card = document.createElement("div");
    card.className = "ac-commit-card";
    card.id = `ac-card-${i}`;

    const head = document.createElement("div");
    head.className = "ac-card-head";
    head.innerHTML = `<div class="ac-card-num">${i + 1}</div>
      <div class="ac-card-msg"><input type="text" value="${c.message.replace(/"/g, "&quot;")}" data-idx="${i}"></div>
      <button class="ac-card-delete" title="Delete commit (files go to pending)">&times;</button>`;
    head.querySelector("input").addEventListener("change", (e) => {
      c.message = e.target.value;
    });
    head
      .querySelector(".ac-card-delete")
      .addEventListener("click", () => acDeleteCommit(i));
    card.appendChild(head);

    if (c.reasoning) {
      const reason = document.createElement("div");
      reason.className = "ac-card-reason";
      reason.textContent = c.reasoning;
      card.appendChild(reason);
    }

    const filesDiv = document.createElement("div");
    filesDiv.className = "ac-card-files";
    c.files.forEach((f) => filesDiv.appendChild(acFileTag(f, i)));
    card.appendChild(filesDiv);

    // Drop zone on the card
    acDropZone(card, i);
    body.appendChild(card);
  });

  // Add commit button
  const addBtn = document.createElement("div");
  addBtn.className = "ac-add-commit";
  addBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 5v14M5 12h14"/></svg> Add Commit`;
  addBtn.addEventListener("click", acAddCommit);
  body.appendChild(addBtn);

  // Pending section
  const pending = document.createElement("div");
  pending.className = "ac-pending";
  pending.innerHTML = `<div class="ac-pending-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 2v20M2 12h20"/><circle cx="12" cy="12" r="10" stroke-dasharray="4 2"/></svg>Pending<span class="aph-count">${plan.pending.length}</span></div>`;
  const pFiles = document.createElement("div");
  pFiles.className = "ac-pending-files";
  if (plan.pending.length === 0) {
    pFiles.innerHTML =
      '<span class="ac-pending-empty">Drag files here to exclude from commits</span>';
  } else {
    plan.pending.forEach((f) => pFiles.appendChild(acFileTag(f, -1)));
  }
  pending.appendChild(pFiles);
  acDropZone(pending, -1);
  body.appendChild(pending);

  // Update stats in header
  const totalFiles = plan.commits.reduce((s, c) => s + c.files.length, 0);
  const statsCommits = document.querySelector(".acs-commits");
  const statsFiles = document.querySelector(".acs-files");
  if (statsCommits)
    statsCommits.textContent = `${plan.commits.length} commit${plan.commits.length !== 1 ? "s" : ""}`;
  if (statsFiles)
    statsFiles.textContent = `${totalFiles} file${totalFiles !== 1 ? "s" : ""}`;

  // Update footer button count
  const commitBtn = document.getElementById("ac-commit-btn");
  if (commitBtn && !_acExecuting) {
    const activeCommits = plan.commits.filter((c) => c.files.length > 0).length;
    commitBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Commit All (${activeCommits})`;
  }
}

function renderAutoCommitPlan() {
  const layout = document.querySelector("#diff-view .diff-layout");
  layout.querySelector(".ac-overlay")?.remove();

  const plan = _acPlan;
  if (!plan) return;

  const totalFiles = plan.commits.reduce((s, c) => s + c.files.length, 0);
  const overlay = document.createElement("div");
  overlay.className = "ac-overlay";

  // Header with branch info
  let branchHtml = "";
  if (_acBranchInfo) {
    branchHtml = `<span class="ac-branch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M6 3v12"/><path d="M18 9a3 3 0 100-6 3 3 0 000 6z"/><path d="M6 21a3 3 0 100-6 3 3 0 000 6z"/><path d="M18 9c0 6-12 6-12 12"/></svg>${esc(_acBranchInfo.branch)}</span>`;
  }

  overlay.innerHTML = `
    <div class="ac-header">
      <h3>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M5.5 8.5l13 7M18.5 8.5l-13 7"/></svg>
        Auto Commit Plan
      </h3>
      ${branchHtml}
      <div class="ac-stats">
        <span class="acs-commits">${plan.commits.length} commit${plan.commits.length > 1 ? "s" : ""}</span>
        <span class="acs-files">${totalFiles} file${totalFiles > 1 ? "s" : ""}</span>
      </div>
      <button class="ac-cancel" onclick="cancelAutoCommit()">Cancel</button>
    </div>
    <div class="ac-body" id="ac-body"></div>
    <div class="ac-footer" id="ac-footer">
      <div class="ac-progress" id="ac-progress" style="display:none">
        <div class="ac-progress-bar"><div class="ac-progress-fill" id="ac-progress-fill"></div></div>
        <span class="ac-progress-text" id="ac-progress-text">0/${plan.commits.length}</span>
      </div>
      <button class="ac-commit-btn" id="ac-commit-btn" onclick="executeAutoCommit()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Commit All (${plan.commits.length})
      </button>
    </div>
  `;

  layout.appendChild(overlay);
  rerenderAcBody();
}

window.cancelAutoCommit = () => {
  _acPlan = null;
  _acExecuting = false;
  _acDragFile = null;
  const layout = document.querySelector("#diff-view .diff-layout");
  layout.querySelector(".ac-overlay")?.remove();
};

window.executeAutoCommit = async () => {
  if (!_acPlan || _acExecuting) return;

  // Pre-commit branch validation
  if (_acBranchInfo) {
    const currentBranch = _acBranchInfo.branch;
    if (currentBranch === "main" || currentBranch === "master") {
      if (
        !confirm(`You are about to commit to "${currentBranch}". Are you sure?`)
      )
        return;
    }
  }

  // Filter out empty commits
  const activeCommits = _acPlan.commits.filter((c) => c.files.length > 0);
  if (activeCommits.length === 0) {
    showToast("No files in any commit", "info");
    return;
  }

  _acExecuting = true;
  const { projectId } = _acPlan;
  const commitBtn = document.getElementById("ac-commit-btn");
  const progressEl = document.getElementById("ac-progress");
  const progressFill = document.getElementById("ac-progress-fill");
  const progressText = document.getElementById("ac-progress-text");

  commitBtn.disabled = true;
  commitBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:acSpin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Committing...`;
  progressEl.style.display = "flex";
  progressText.textContent = `0/${activeCommits.length}`;

  let completed = 0;
  let failed = false;

  for (let i = 0; i < _acPlan.commits.length; i++) {
    const c = _acPlan.commits[i];
    if (c.files.length === 0) continue; // skip empty
    const card = document.getElementById(`ac-card-${i}`);
    if (!card) continue;
    card.classList.add("executing");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });

    try {
      const res = await fetch(
        `/api/projects/${projectId}/auto-commit/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: c.message, files: c.files }),
        },
      );
      const data = await res.json();
      card.classList.remove("executing");

      if (data.error) {
        card.classList.add("failed");
        card.querySelector(".ac-card-num").textContent = "!";
        showToast(`Commit ${i + 1} failed: ${data.error}`, "error");
        failed = true;
        break;
      }

      card.classList.add("done");
      card.querySelector(".ac-card-num").innerHTML =
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>`;
      completed++;
      const pct = Math.round((completed / activeCommits.length) * 100);
      progressFill.style.width = pct + "%";
      progressText.textContent = `${completed}/${activeCommits.length}`;
    } catch (err) {
      card.classList.remove("executing");
      card.classList.add("failed");
      showToast(`Network error: ${err.message}`, "error");
      failed = true;
      break;
    }
  }

  _acExecuting = false;

  const footer = document.getElementById("ac-footer");
  if (!failed && completed === activeCommits.length) {
    footer.innerHTML = `
      <div class="ac-done-msg">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
        ${completed} commit${completed > 1 ? "s" : ""} done!
      </div>
      <div style="flex:1"></div>
      <button class="ac-cancel" onclick="cancelAutoCommit();loadDiff();">Close</button>
      <button class="ac-push-btn" onclick="doPush('${projectId}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
        Push
      </button>
    `;
    showToast(`${completed} commits created successfully`, "success");
  } else {
    commitBtn.disabled = false;
    commitBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Retry remaining`;
  }
};

window.doPush = async (projectId) => {
  const pushBtn = document.querySelector(".ac-push-btn");
  if (!pushBtn) return;
  pushBtn.disabled = true;
  pushBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:acSpin 1s linear infinite"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>Pushing...`;

  try {
    const res = await fetch(`/api/projects/${projectId}/push`, {
      method: "POST",
    });
    const data = await res.json();
    if (data.error) {
      showToast("Push failed: " + data.error, "error");
      pushBtn.disabled = false;
      pushBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>Push`;
    } else {
      showToast("Pushed successfully!", "success");
      pushBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Pushed!`;
      pushBtn.style.background = "rgba(16,185,129,.2)";
      pushBtn.style.border = "1px solid rgba(16,185,129,.3)";
    }
  } catch (err) {
    showToast("Push error: " + err.message, "error");
    pushBtn.disabled = false;
    pushBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>Push`;
  }
};

// ─── Branch/Worktree Picker for New Terminal ───
let _branchData = null;
let _selectedBranch = null; // { type:'worktree'|'local'|'remote', value:string, cwd?:string }
window.loadBranchesForTerm = async () => {
  const projectId = document.getElementById("nt-project").value;
  const section = document.getElementById("nt-branch-section");
  const list = document.getElementById("nt-branch-list");
  _selectedBranch = null;
  if (!projectId) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  list.innerHTML =
    '<div style="padding:10px;color:var(--text-3);font-size:.78rem">Loading...</div>';
  try {
    const res = await fetch(`/api/projects/${projectId}/branches`);
    _branchData = await res.json();
    let html = "";
    // Worktrees
    if (_branchData.worktrees?.length > 1) {
      html += `<div class="nt-branch-group"><div class="nt-branch-group-head">Worktrees</div>`;
      for (const wt of _branchData.worktrees) {
        const name = wt.path.split("/").pop();
        const isCurrent = wt.branch === _branchData.current;
        html += `<div class="nt-branch-item" data-type="worktree" data-value="${esc(wt.branch)}" data-cwd="${esc(wt.path)}" onclick="selectBranch(this)">
          <span>${esc(wt.branch)}</span>
          <span class="nb-wt-path">${esc(name)}</span>
          ${isCurrent ? '<span class="nb-current">current</span>' : ""}
        </div>`;
      }
      html += "</div>";
    }
    // Local
    if (_branchData.local?.length) {
      html += `<div class="nt-branch-group"><div class="nt-branch-group-head">Local</div>`;
      for (const b of _branchData.local) {
        const isCurrent = b === _branchData.current;
        html += `<div class="nt-branch-item" data-type="local" data-value="${esc(b)}" onclick="selectBranch(this)">
          <span>${esc(b)}</span>
          ${isCurrent ? '<span class="nb-current">current</span>' : ""}
        </div>`;
      }
      html += "</div>";
    }
    // Remote
    if (_branchData.remote?.length) {
      html += `<div class="nt-branch-group"><div class="nt-branch-group-head">Remote</div>`;
      for (const b of _branchData.remote) {
        html += `<div class="nt-branch-item" data-type="remote" data-value="${esc(b)}" onclick="selectBranch(this)">
          <span style="color:var(--text-2)">${esc(b)}</span>
        </div>`;
      }
      html += "</div>";
    }
    list.innerHTML =
      html ||
      '<div style="padding:10px;color:var(--text-3);font-size:.78rem">No branches found</div>';
  } catch {
    list.innerHTML =
      '<div style="padding:10px;color:var(--text-3);font-size:.78rem">Error loading branches</div>';
  }
};
window.selectBranch = (el) => {
  document
    .querySelectorAll("#nt-branch-list .nt-branch-item.selected")
    .forEach((x) => x.classList.remove("selected"));
  if (
    _selectedBranch &&
    _selectedBranch.value === el.dataset.value &&
    _selectedBranch.type === el.dataset.type
  ) {
    _selectedBranch = null;
    return; // deselect
  }
  el.classList.add("selected");
  _selectedBranch = {
    type: el.dataset.type,
    value: el.dataset.value,
    cwd: el.dataset.cwd || "",
  };
};

// ─── Dev Server Management (Client) ───
let devServerState = []; // [{projectId, command, startedAt, port}]
const _knownPorts = new Set();
const _devStartTimeouts = new Map();

window.promptDevCmd = async (projectId) => {
  const p = projectList.find((x) => x.id === projectId);
  if (!p) return;
  const dlg = document.getElementById("dev-dialog");
  const content = document.getElementById("dev-dialog-content");
  document.querySelector("#dev-dialog .modal-header h2").textContent =
    `Dev Command \u2014 ${p.name}`;
  content.innerHTML =
    '<div style="padding:12px;color:var(--text-3);font-size:.78rem">Loading scripts...</div>';
  dlg.showModal();
  try {
    const res = await fetch(
      `/api/scripts-by-path?path=${encodeURIComponent(p.path)}`,
    );
    const data = await res.json();
    const entries = Object.entries(data.scripts || {});
    let html = "";
    if (entries.length) {
      html +=
        '<div style="padding:8px 14px;font-size:.72rem;color:var(--text-3)">package.json scripts \u2014 click to set</div>';
      html += entries
        .map(
          ([name, cmd]) =>
            `<div class="dev-item" style="cursor:pointer" onclick="setDevCmd('${projectId}','npm run ${name}')">
          <span class="di-name" style="font-family:var(--mono);color:var(--accent-bright)">${esc(name)}</span>
          <span class="di-cmd">${esc(cmd)}</span>
        </div>`,
        )
        .join("");
    } else {
      html +=
        '<div style="padding:12px 14px;color:var(--text-3);font-size:.78rem">No scripts in package.json</div>';
    }
    html += `<div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:6px;align-items:center">
      <input type="text" id="dev-cmd-input" placeholder="Or type custom command..." style="flex:1;padding:5px 10px;font-size:.78rem;background:var(--bg-0);border:1px solid var(--border);border-radius:var(--radius-xs);color:var(--text-1);font-family:var(--mono)">
      <button class="btn primary" onclick="setDevCmd('${projectId}', document.getElementById('dev-cmd-input').value)" style="font-size:.72rem">Save</button>
    </div>`;
    content.innerHTML = html;
  } catch {
    content.innerHTML =
      '<div style="padding:12px;color:var(--red);font-size:.78rem">Error loading scripts</div>';
  }
};
window.setDevCmd = async (projectId, cmd) => {
  if (!cmd?.trim()) {
    showToast("Enter a command", "error");
    return;
  }
  const p = projectList.find((x) => x.id === projectId);
  if (!p) return;
  p.devCmd = cmd.trim();
  await fetch(`/api/projects/${projectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...p, devCmd: p.devCmd }),
  });
  document.getElementById("dev-dialog").close();
  showToast(`Dev command set: ${cmd.trim()}`, "success");
  await refreshProjectList();
};

window.toggleDevServer = async (projectId) => {
  const isRunning = devServerState.some((d) => d.projectId === projectId);
  const endpoint = isRunning ? "stop" : "start";
  try {
    const res = await fetch(
      `/api/projects/${projectId}/dev-server/${endpoint}`,
      { method: "POST" },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "Dev server action failed", "error");
      return;
    }
    // Refresh dev server list from server
    const listRes = await fetch("/api/dev-servers");
    const data = await listRes.json();
    devServerState = data.running || [];
    updateDevBadge();
    renderCard(projectId);
    // Dev server start timeout (30s) — if no port detected, show warning
    if (endpoint === "start") {
      const pName =
        projectList.find((p) => p.id === projectId)?.name || projectId;
      showToast(`Starting ${pName}...`, "info", 2000);
      const tid = setTimeout(() => {
        const still = devServerState.find(
          (d) => d.projectId === projectId && !d.port,
        );
        if (still)
          showToast(
            `${pName}: port not detected (may still be starting)`,
            "error",
            5000,
          );
        _devStartTimeouts.delete(projectId);
      }, 30000);
      _devStartTimeouts.set(projectId, tid);
    }
    if (endpoint === "stop" && _devStartTimeouts.has(projectId)) {
      clearTimeout(_devStartTimeouts.get(projectId));
      _devStartTimeouts.delete(projectId);
    }
    // If dev dialog is open, refresh it
    const dlg = document.getElementById("dev-dialog");
    if (dlg.open) showDevServerDialog();
  } catch {
    showToast("Dev server action failed", "error");
  }
};

window.showDevServerDialog = async () => {
  const dlg = document.getElementById("dev-dialog");
  const content = document.getElementById("dev-dialog-content");
  document.querySelector("#dev-dialog .modal-header h2").textContent =
    "Dev Servers";
  try {
    const res = await fetch("/api/dev-servers");
    const data = await res.json();
    if (!data.running?.length) {
      content.innerHTML =
        '<div style="padding:24px;text-align:center;color:var(--text-3)">No dev servers running</div>';
    } else {
      content.innerHTML = data.running
        .map((d) => {
          const ago = Math.round((Date.now() - d.startedAt) / 60000);
          const portTag = d.port
            ? `<span style="font-family:var(--mono);font-size:.74rem;color:var(--green);cursor:pointer" onclick="window.open('http://localhost:${d.port}','_blank')" title="Open in browser">:${d.port}</span>`
            : "";
          return `<div class="dev-item">
          <span class="dev-dot on"></span>
          <span class="di-name">${esc(d.name)}</span>
          ${portTag}
          <span class="di-cmd">${esc(d.command)}</span>
          <span class="di-time">${ago}m</span>
          <button class="btn" onclick="toggleDevServer('${d.projectId}')" style="font-size:.72rem;padding:2px 8px;color:var(--red)">Stop</button>
        </div>`;
        })
        .join("");
    }
  } catch {
    content.innerHTML =
      '<div style="padding:20px;color:var(--red)">Error</div>';
  }
  dlg.showModal();
};

function updateDevBadge() {
  const el = document.getElementById("dev-count");
  if (el) el.textContent = devServerState.length;
  const badge = document.getElementById("dev-server-badge");
  if (badge) badge.style.display = devServerState.length ? "" : "";
}

// ─── Actions ───
window.openStartModal = (id) => {
  document.getElementById("modal-project-id").value = id;
  document.getElementById("start-modal").showModal();
};
window.doStartSession = async () => {
  const id = document.getElementById("modal-project-id").value;
  const model = document.getElementById("modal-model").value;
  const prompt = document.getElementById("modal-prompt").value;
  document.getElementById("start-modal").close();
  await fetch(`/api/sessions/${id}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || undefined,
      prompt: prompt || undefined,
    }),
  });
};

// ─── Keyboard Shortcuts ───
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  // F5 or Ctrl+R → reload page
  if (e.key === "F5" || (mod && e.key === "r")) {
    e.preventDefault();
    location.reload();
    return;
  }
  // Ctrl+1/2/3 → tab switch
  if (mod && e.key === "1") {
    e.preventDefault();
    switchView("dashboard");
    return;
  }
  if (mod && e.key === "2") {
    e.preventDefault();
    switchView("terminal");
    return;
  }
  if (mod && e.key === "3") {
    e.preventDefault();
    switchView("diff");
    return;
  }
  if (mod && e.key === "4") {
    e.preventDefault();
    switchView("readme");
    return;
  }
  // Ctrl+Tab / Ctrl+Shift+Tab → cycle terminals
  if (mod && e.key === "Tab") {
    if (
      document.getElementById("terminal-view").classList.contains("active") &&
      termMap.size > 1
    ) {
      e.preventDefault();
      const ids = [...termMap.keys()];
      const cur = ids.indexOf(activeTermId);
      const next = e.shiftKey
        ? cur <= 0
          ? ids.length - 1
          : cur - 1
        : cur >= ids.length - 1
          ? 0
          : cur + 1;
      activeTermId = ids[next];
      updateTermHeaders();
      const _t1 = termMap.get(ids[next]);
      if (_t1?.xterm) _t1.xterm.focus();
      return;
    }
  }
  // Ctrl+[ / Ctrl+] → prev/next terminal
  if (mod && (e.key === "[" || e.key === "]")) {
    if (
      document.getElementById("terminal-view").classList.contains("active") &&
      termMap.size > 1
    ) {
      e.preventDefault();
      const ids = [...termMap.keys()];
      const cur = ids.indexOf(activeTermId);
      const next =
        e.key === "["
          ? cur <= 0
            ? ids.length - 1
            : cur - 1
          : cur >= ids.length - 1
            ? 0
            : cur + 1;
      activeTermId = ids[next];
      updateTermHeaders();
      const _t2 = termMap.get(ids[next]);
      if (_t2?.xterm) _t2.xterm.focus();
      return;
    }
  }
  // Ctrl+T → new terminal
  if (mod && e.key === "t" && !e.shiftKey) {
    if (document.getElementById("terminal-view").classList.contains("active")) {
      e.preventDefault();
      openNewTermModal();
      return;
    }
  }
  // Ctrl+W → close active terminal
  if (mod && e.key === "w" && !e.shiftKey) {
    if (
      document.getElementById("terminal-view").classList.contains("active") &&
      activeTermId
    ) {
      e.preventDefault();
      closeTerminal(activeTermId);
      return;
    }
  }
  // Ctrl+K → command palette
  if (mod && e.key === "k") {
    e.preventDefault();
    toggleCommandPalette();
    return;
  }
  // Ctrl+F → terminal search
  if (mod && e.key === "f") {
    if (
      document.getElementById("terminal-view").classList.contains("active") &&
      activeTermId
    ) {
      e.preventDefault();
      toggleTermSearch();
      return;
    }
  }
  // Ctrl+Enter → commit (when in diff view)
  if (mod && e.key === "Enter") {
    if (document.getElementById("diff-view").classList.contains("active")) {
      e.preventDefault();
      const msg = document.getElementById("diff-commit-msg")?.value?.trim();
      if (msg) {
        doManualCommit();
      } else {
        document.getElementById("diff-commit-msg")?.focus();
      }
      return;
    }
  }
  // R → refresh diff (no modifier, not in input)
  if (
    e.key === "r" &&
    !mod &&
    !e.altKey &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)
  ) {
    if (document.getElementById("diff-view").classList.contains("active")) {
      e.preventDefault();
      loadDiff();
      return;
    }
  }
  // E → expand all, C → collapse all (diff view, no modifier)
  if (
    !mod &&
    !e.altKey &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)
  ) {
    if (document.getElementById("diff-view").classList.contains("active")) {
      if (e.key === "e") {
        e.preventDefault();
        diffExpandAll();
        return;
      }
      if (e.key === "c") {
        e.preventDefault();
        diffCollapseAll();
        return;
      }
    }
  }
  // ? → shortcut help (no modifier, not in input)
  if (
    e.key === "?" &&
    !mod &&
    !e.altKey &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)
  ) {
    e.preventDefault();
    showShortcutHelp();
    return;
  }
  // Escape → close overlays
  if (e.key === "Escape") {
    const cp = document.getElementById("cmd-palette");
    if (cp && !cp.classList.contains("hidden")) {
      closeCommandPalette();
      return;
    }
    const cv = document.getElementById("conv-overlay");
    if (cv && !cv.classList.contains("hidden")) {
      closeConvList();
      return;
    }
    const fp = document.getElementById("file-preview-overlay");
    if (fp && !fp.classList.contains("hidden")) {
      closeFilePreview();
      return;
    }
    const so = document.getElementById("shortcut-overlay");
    if (so && !so.classList.contains("hidden")) {
      hideShortcutHelp();
      return;
    }
    const sb = document.getElementById("term-search-bar");
    if (sb?.classList.contains("open")) {
      closeTermSearch();
      return;
    }
  }
});

// ─── Terminal Search ───
function toggleTermSearch() {
  const sb = document.getElementById("term-search-bar");
  if (sb.classList.contains("open")) {
    closeTermSearch();
    return;
  }
  sb.classList.add("open");
  const input = sb.querySelector("input");
  input.value = "";
  input.focus();
}
function closeTermSearch() {
  const sb = document.getElementById("term-search-bar");
  sb.classList.remove("open");
  if (activeTermId) {
    const t = termMap.get(activeTermId);
    if (t?.searchAddon) t.searchAddon.clearDecorations();
  }
}
function doTermSearch(dir) {
  const input = document.querySelector("#term-search-bar input");
  const countEl = document.getElementById("ts-match-count");
  const q = input.value;
  if (!q || !activeTermId) {
    if (countEl) countEl.textContent = "";
    return;
  }
  const t = termMap.get(activeTermId);
  if (!t?.searchAddon) return;
  let found;
  if (dir === "next")
    found = t.searchAddon.findNext(q, {
      regex: false,
      caseSensitive: false,
      incremental: true,
    });
  else
    found = t.searchAddon.findPrevious(q, {
      regex: false,
      caseSensitive: false,
      incremental: true,
    });
  if (countEl) countEl.textContent = found ? "" : "No match";
}

// ─── Notification Toggle ───
let notifyEnabled = localStorage.getItem("dl-notify") !== "false";
function toggleNotifications() {
  notifyEnabled = !notifyEnabled;
  localStorage.setItem("dl-notify", notifyEnabled);
  const btn = document.getElementById("notify-toggle");
  if (btn) {
    btn.textContent = notifyEnabled ? "On" : "Off";
    btn.className = "btn" + (notifyEnabled ? "" : " off-btn");
  }
  showToast(
    notifyEnabled ? "Notifications enabled" : "Notifications disabled",
    "info",
  );
  fetch("/api/notify/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: notifyEnabled }),
  }).catch(() => {});
}

// Expose to inline onclick handlers (module scope)
window.toggleTermSearch = toggleTermSearch;
window.closeTermSearch = closeTermSearch;
window.doTermSearch = doTermSearch;
window.toggleNotifications = toggleNotifications;

// ─── Theme Toggle ───
// Detect OS preference if no saved preference
let _themeManual = !!localStorage.getItem("dl-theme");
let currentTheme = _themeManual
  ? localStorage.getItem("dl-theme")
  : window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
function applyTheme(theme) {
  currentTheme = theme;
  document.body.classList.toggle("light-theme", theme === "light");
  document.getElementById("theme-icon-dark").style.display =
    theme === "dark" ? "" : "none";
  document.getElementById("theme-icon-light").style.display =
    theme === "light" ? "" : "none";
}
window.toggleTheme = () => {
  _themeManual = true;
  applyTheme(currentTheme === "dark" ? "light" : "dark");
  localStorage.setItem("dl-theme", currentTheme);
  showToast(`${currentTheme === "light" ? "Light" : "Dark"} theme`, "info");
};
// Follow OS theme changes when user hasn't manually toggled
window
  .matchMedia("(prefers-color-scheme: light)")
  .addEventListener("change", (e) => {
    if (!_themeManual) applyTheme(e.matches ? "light" : "dark");
  });

// ─── Keyboard Shortcut Help ───
function showShortcutHelp() {
  document.getElementById("shortcut-overlay").classList.remove("hidden");
}
function hideShortcutHelp() {
  document.getElementById("shortcut-overlay").classList.add("hidden");
}
window.showShortcutHelp = showShortcutHelp;
window.hideShortcutHelp = hideShortcutHelp;

// ─── Command Palette ───
let _cmdActiveIdx = 0;
let _cmdFiltered = [];

function buildCommandList() {
  const cmds = [];
  const icon = (d) =>
    `<span class="cpi-icon"><svg viewBox="0 0 24 24">${d}</svg></span>`;
  const navIcon = icon(
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  );
  const termIcon = icon(
    '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  );
  const gitIcon = icon(
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/>',
  );
  const settingsIcon = icon(
    '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
  );
  const themeIcon = icon(
    '<path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/>',
  );

  // Navigation
  cmds.push({
    group: "Navigation",
    label: "Go to Overview",
    hint: "Ctrl+1",
    icon: navIcon,
    action: () => switchView("dashboard"),
  });
  cmds.push({
    group: "Navigation",
    label: "Go to Terminal",
    hint: "Ctrl+2",
    icon: termIcon,
    action: () => switchView("terminal"),
  });
  cmds.push({
    group: "Navigation",
    label: "Go to Changes",
    hint: "Ctrl+3",
    icon: gitIcon,
    action: () => switchView("diff"),
  });
  cmds.push({
    group: "Navigation",
    label: "Go to README",
    hint: "Ctrl+4",
    icon: navIcon,
    action: () => switchView("readme"),
  });

  // Projects
  for (const p of projectList) {
    const pIcon = icon(
      '<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
    );
    cmds.push({
      group: "Projects",
      label: `Switch to ${p.name}`,
      icon: pIcon,
      action: () => {
        switchView("diff");
        document.getElementById("diff-project").value = p.id;
        loadDiff();
      },
    });
  }

  // Terminals
  for (const [tid, t] of termMap) {
    cmds.push({
      group: "Terminals",
      label: `Terminal: ${t.label || tid}`,
      icon: termIcon,
      action: () => {
        switchView("terminal");
        activeTermId = tid;
        renderLayout();
        updateTermHeaders();
      },
    });
  }

  // Actions
  cmds.push({
    group: "Actions",
    label: "Recent Conversations",
    icon: navIcon,
    action: () => showConvList(),
  });
  cmds.push({
    group: "Actions",
    label: "New Terminal",
    hint: "Ctrl+T",
    icon: termIcon,
    action: () => {
      switchView("terminal");
      openNewTermModal();
    },
  });
  cmds.push({
    group: "Actions",
    label: "Toggle Theme",
    icon: themeIcon,
    action: () => toggleTheme(),
  });
  cmds.push({
    group: "Actions",
    label: "Open Settings",
    icon: settingsIcon,
    action: () => openSettingsPanel(),
  });
  cmds.push({
    group: "Actions",
    label: "Keyboard Shortcuts",
    hint: "?",
    icon: settingsIcon,
    action: () => showShortcutHelp(),
  });
  cmds.push({
    group: "Actions",
    label: "Refresh Diff",
    hint: "R",
    icon: gitIcon,
    action: () => {
      switchView("diff");
      loadDiff();
    },
  });
  cmds.push({
    group: "Actions",
    label: "Export Terminal Output",
    icon: termIcon,
    action: () => {
      switchView("terminal");
      exportTerminal();
    },
  });
  cmds.push({
    group: "Actions",
    label: "Fetch All Projects",
    icon: gitIcon,
    action: () => fetchAllProjects(),
  });
  cmds.push({
    group: "Actions",
    label: "Filter: Active Only",
    icon: navIcon,
    action: () => {
      switchView("dashboard");
      setProjectFilter("active");
    },
  });
  cmds.push({
    group: "Actions",
    label: "Filter: Idle Only",
    icon: navIcon,
    action: () => {
      switchView("dashboard");
      setProjectFilter("idle");
    },
  });
  cmds.push({
    group: "Actions",
    label: "Filter: Show All",
    icon: navIcon,
    action: () => {
      switchView("dashboard");
      setProjectFilter("all");
    },
  });

  return cmds;
}

function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function renderCommandList() {
  const list = document.getElementById("cmd-palette-list");
  if (!_cmdFiltered.length) {
    list.innerHTML =
      '<div class="cmd-palette-empty">No matching commands</div>';
    return;
  }
  let html = "",
    lastGroup = "";
  _cmdFiltered.forEach((cmd, i) => {
    if (cmd.group !== lastGroup) {
      html += `<div class="cmd-palette-group">${cmd.group}</div>`;
      lastGroup = cmd.group;
    }
    html += `<div class="cmd-palette-item${i === _cmdActiveIdx ? " active" : ""}" data-idx="${i}" onmouseenter="setCmdActive(${i})" onclick="execCmd(${i})">${cmd.icon}<span class="cpi-label">${cmd.label}</span>${cmd.hint ? `<span class="cpi-hint">${cmd.hint}</span>` : ""}</div>`;
  });
  list.innerHTML = html;
  const active = list.querySelector(".cmd-palette-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

window.setCmdActive = (i) => {
  _cmdActiveIdx = i;
  renderCommandList();
};
window.execCmd = (i) => {
  const cmd = _cmdFiltered[i];
  if (cmd) {
    closeCommandPalette();
    cmd.action();
  }
};

function filterCommands(query) {
  const allCmds = buildCommandList();
  _cmdFiltered = query
    ? allCmds.filter((c) => fuzzyMatch(query, c.label))
    : allCmds;
  _cmdActiveIdx = 0;
  renderCommandList();
}

function toggleCommandPalette() {
  const el = document.getElementById("cmd-palette");
  if (el.classList.contains("hidden")) openCommandPalette();
  else closeCommandPalette();
}

function openCommandPalette() {
  const el = document.getElementById("cmd-palette");
  el.classList.remove("hidden");
  const input = document.getElementById("cmd-palette-input");
  input.value = "";
  filterCommands("");
  input.focus();
}

function closeCommandPalette() {
  document.getElementById("cmd-palette").classList.add("hidden");
}

document.getElementById("cmd-palette-input")?.addEventListener("input", (e) => {
  filterCommands(e.target.value.trim());
});

document
  .getElementById("cmd-palette-input")
  ?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      _cmdActiveIdx = Math.min(_cmdActiveIdx + 1, _cmdFiltered.length - 1);
      renderCommandList();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _cmdActiveIdx = Math.max(_cmdActiveIdx - 1, 0);
      renderCommandList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      execCmd(_cmdActiveIdx);
    } else if (e.key === "Escape") {
      closeCommandPalette();
    }
  });

// ─── Project Pin ───
let pinnedProjects = new Set(
  JSON.parse(localStorage.getItem("dl-pinned") || "[]"),
);

function savePins() {
  localStorage.setItem("dl-pinned", JSON.stringify([...pinnedProjects]));
}

window.togglePin = (id) => {
  if (pinnedProjects.has(id)) pinnedProjects.delete(id);
  else pinnedProjects.add(id);
  savePins();
  sortAndRenderProjects();
};

function sortAndRenderProjects() {
  const sorted = [...projectList].sort((a, b) => {
    const ap = pinnedProjects.has(a.id) ? 0 : 1;
    const bp = pinnedProjects.has(b.id) ? 0 : 1;
    return ap - bp;
  });
  _renderedCardIds = []; // force full rebuild
  renderAllCards(sorted);
  projectList.forEach((p) => {
    const s = state.projects.get(p.id);
    if (s) renderCard(p.id);
  });
}

// ─── Pull / Fetch / Stash ───
function getDiffProjectId() {
  return document.getElementById("diff-project")?.value;
}

// Guard to prevent double-clicks on git action buttons
const _gitActionLocks = new Set();
function withGitActionLock(key, fn) {
  if (_gitActionLocks.has(key)) return;
  _gitActionLocks.add(key);
  fn().finally(() => _gitActionLocks.delete(key));
}

window.doPull = () =>
  withGitActionLock("pull", async () => {
    const pid = getDiffProjectId();
    if (!pid) return showToast("Select a project first", "error");
    const btn = document.getElementById("dt-pull-btn");
    btn.classList.add("loading");
    btn.disabled = true;
    btn.textContent = "Pulling...";
    try {
      const res = await fetch(`/api/projects/${pid}/pull`, { method: "POST" });
      const data = await res.json();
      if (data.error) showToast("Pull failed: " + data.error, "error");
      else {
        showToast("Pull complete", "success");
        loadDiff();
      }
    } catch (err) {
      showToast("Pull error: " + err.message, "error");
    }
    btn.classList.remove("loading");
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>Pull`;
  });

window.doFetch = () =>
  withGitActionLock("fetch", async () => {
    const pid = getDiffProjectId();
    if (!pid) return showToast("Select a project first", "error");
    const btn = document.getElementById("dt-fetch-btn");
    btn.classList.add("loading");
    btn.disabled = true;
    btn.textContent = "Fetching...";
    try {
      const res = await fetch(`/api/projects/${pid}/fetch`, { method: "POST" });
      const data = await res.json();
      if (data.error) showToast("Fetch failed: " + data.error, "error");
      else showToast("Fetch complete", "success");
    } catch (err) {
      showToast("Fetch error: " + err.message, "error");
    }
    btn.classList.remove("loading");
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Fetch`;
  });

window.doStash = () =>
  withGitActionLock("stash", async () => {
    const pid = getDiffProjectId();
    if (!pid) return showToast("Select a project first", "error");
    try {
      const res = await fetch(`/api/projects/${pid}/git/stash`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeUntracked: true }),
      });
      const data = await res.json();
      if (data.error) showToast("Stash failed: " + data.error, "error");
      else {
        showToast("Changes stashed", "success");
        loadDiff();
      }
    } catch (err) {
      showToast("Stash error: " + err.message, "error");
    }
  });

window.doStashPop = () =>
  withGitActionLock("stash-pop", async () => {
    const pid = getDiffProjectId();
    if (!pid) return showToast("Select a project first", "error");
    try {
      const res = await fetch(`/api/projects/${pid}/git/stash-pop`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.error) showToast("Stash pop failed: " + data.error, "error");
      else {
        showToast("Stash popped", "success");
        loadDiff();
      }
    } catch (err) {
      showToast("Stash pop error: " + err.message, "error");
    }
  });

// ─── Branch Create/Delete ───
window.createBranch = async (projectId) => {
  const input = document.getElementById("new-branch-input");
  if (!input) return;
  const name = input.value.trim();
  if (!name) return showToast("Enter a branch name", "error");
  if (!/^[a-zA-Z0-9._\-/]+$/.test(name))
    return showToast("Invalid branch name", "error");
  try {
    const res = await fetch(`/api/projects/${projectId}/git/create-branch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: name }),
    });
    const data = await res.json();
    if (data.error) showToast("Create failed: " + data.error, "error");
    else {
      showToast(`Branch '${name}' created`, "success");
      input.value = "";
      loadDiff();
      updateDiffBranchInfo();
    }
  } catch (err) {
    showToast("Create error: " + err.message, "error");
  }
};

window.deleteBranch = async (projectId, branch) => {
  if (!confirm(`Delete branch '${branch}'?`)) return;
  try {
    const res = await fetch(`/api/projects/${projectId}/git/delete-branch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch }),
    });
    const data = await res.json();
    if (data.error) showToast("Delete failed: " + data.error, "error");
    else {
      showToast(`Branch '${branch}' deleted`, "success");
      updateDiffBranchInfo();
    }
  } catch (err) {
    showToast("Delete error: " + err.message, "error");
  }
};

// ─── README ───
function simpleMarkdown(md) {
  let html = "";
  const lines = md.split("\n");
  let inCode = false,
    codeBlock = "",
    inList = false,
    listType = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (inCode) {
        html += `<pre><code>${codeBlock}</code></pre>`;
        codeBlock = "";
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBlock += esc(line) + "\n";
      continue;
    }
    if (inList && !/^(\s*[-*]|\s*\d+\.)/.test(line) && line.trim()) {
      html += `</${listType}>`;
      inList = false;
    }
    if (/^### (.+)/.test(line)) {
      html += `<h3>${inline(line.slice(4))}</h3>`;
      continue;
    }
    if (/^## (.+)/.test(line)) {
      html += `<h2>${inline(line.slice(3))}</h2>`;
      continue;
    }
    if (/^# (.+)/.test(line)) {
      html += `<h1>${inline(line.slice(2))}</h1>`;
      continue;
    }
    if (/^---\s*$/.test(line)) {
      html += "<hr>";
      continue;
    }
    if (/^>\s?(.*)/.test(line)) {
      html += `<blockquote><p>${inline(line.slice(2))}</p></blockquote>`;
      continue;
    }
    if (/^\|(.+)\|/.test(line)) {
      let tableHtml = "<table>";
      while (i < lines.length && /^\|(.+)\|/.test(lines[i])) {
        const cells = lines[i]
          .split("|")
          .filter(Boolean)
          .map((c) => c.trim());
        if (cells.every((c) => /^[-:]+$/.test(c))) {
          i++;
          continue;
        }
        const tag = tableHtml === "<table>" ? "th" : "td";
        tableHtml +=
          "<tr>" +
          cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join("") +
          "</tr>";
        i++;
      }
      i--;
      html += tableHtml + "</table>";
      continue;
    }
    if (/^\s*[-*] (.+)/.test(line)) {
      if (!inList || listType !== "ul") {
        if (inList) html += `</${listType}>`;
        html += "<ul>";
        inList = true;
        listType = "ul";
      }
      html += `<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`;
      continue;
    }
    if (/^\s*\d+\. (.+)/.test(line)) {
      if (!inList || listType !== "ol") {
        if (inList) html += `</${listType}>`;
        html += "<ol>";
        inList = true;
        listType = "ol";
      }
      html += `<li>${inline(line.replace(/^\s*\d+\. /, ""))}</li>`;
      continue;
    }
    if (!line.trim()) {
      html += "";
      continue;
    }
    html += `<p>${inline(line)}</p>`;
  }
  if (inCode) html += `<pre><code>${codeBlock}</code></pre>`;
  if (inList) html += `</${listType}>`;
  return html;
  function inline(s) {
    return s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank">$1</a>',
      );
  }
}

// ─── Resume Last Session (external terminal) ───
window.resumeLastSession = async (projectId) => {
  const p = state.projects.get(projectId);
  if (!p?.session?.sessionId) return;
  try {
    const res = await fetch(`/api/sessions/${projectId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: p.session.sessionId }),
    });
    const data = await res.json();
    if (data.launched)
      showToast("Session resumed in Windows Terminal", "success");
    else showToast(data.error || "Failed", "error");
  } catch (err) {
    showToast(err.message, "error");
  }
};

// ─── Adaptive Polling (visibility-based) ───
document.addEventListener("visibilitychange", () => {
  const hidden = document.hidden;
  fetch("/api/polling-speed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ multiplier: hidden ? 5 : 1 }),
  }).catch(() => {});
});

// ─── Commit Message Persistence ───
const _commitMsgKey = "cockpit-commit-msg";
function saveCommitMsg() {
  const el = document.getElementById("commit-msg-input");
  if (el && el.value.trim()) localStorage.setItem(_commitMsgKey, el.value);
}
function restoreCommitMsg() {
  const el = document.getElementById("commit-msg-input");
  const saved = localStorage.getItem(_commitMsgKey);
  if (el && saved && !el.value) el.value = saved;
}
function clearCommitMsg() {
  localStorage.removeItem(_commitMsgKey);
  const el = document.getElementById("commit-msg-input");
  if (el) el.value = "";
}
// Hook into commit message input if it exists
const _commitMsgObserver = new MutationObserver(() => {
  const el = document.getElementById("commit-msg-input");
  if (el && !el.dataset.persisted) {
    el.dataset.persisted = "1";
    restoreCommitMsg();
    el.addEventListener("input", saveCommitMsg);
    _commitMsgObserver.disconnect();
  }
});
_commitMsgObserver.observe(document.body, { childList: true, subtree: true });

// ─── Cost Error Handling + Last Updated ───
let _usageLastUpdated = null;
let _usageRetryCount = 0;
const _origFetchUsage = typeof fetchUsage === "function" ? fetchUsage : null;
if (_origFetchUsage) {
  window._fetchUsagePatched = true;
}
// Patch fetchUsage to track errors and last updated time
(function patchFetchUsage() {
  const origFn = window.fetchUsage || (async () => {});
  window.fetchUsage = async function () {
    try {
      const res = await fetch("/api/usage");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.usage = await res.json();
      _usageLastUpdated = Date.now();
      _usageRetryCount = 0;
      renderUsage();
      renderCosts();
      updateUsageTimestamp();
    } catch (err) {
      _usageRetryCount++;
      if (_usageRetryCount <= 3) {
        console.warn(`[Usage] Retry ${_usageRetryCount}/3: ${err.message}`);
        setTimeout(fetchUsage, 5000 * _usageRetryCount);
      }
      updateUsageTimestamp();
    }
  };
})();

function updateUsageTimestamp() {
  let el = document.getElementById("usage-last-updated");
  if (!el) {
    const container =
      document.querySelector(".usage-section .section-header") ||
      document.querySelector(".usage-grid");
    if (container) {
      el = document.createElement("span");
      el.id = "usage-last-updated";
      el.style.cssText =
        "font-size:.7rem;color:var(--text-3);margin-left:auto;cursor:pointer";
      el.title = "Click to refresh";
      el.addEventListener("click", () => fetchUsage());
      container.appendChild(el);
    }
  }
  if (el) {
    if (_usageLastUpdated) {
      const ago = Math.round((Date.now() - _usageLastUpdated) / 1000);
      el.textContent =
        ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
      el.style.color = ago > 300 ? "var(--yellow)" : "var(--text-3)";
    } else if (_usageRetryCount > 0) {
      el.textContent = `error (retry ${_usageRetryCount})`;
      el.style.color = "var(--red)";
    }
  }
}
setInterval(updateUsageTimestamp, 15000);

const README_CONTENT = `# Cockpit

여러 프로젝트의 Claude Code 세션, Git 상태, GitHub PR, 사용량을 한 화면에서 모니터링하고 관리하는 로컬 대시보드.

\`http://localhost:3847\`

---

## Features

### Overview (Dashboard)
- **Project Cards** — 프로젝트별 Claude 세션 상태 (active/idle/none), 현재 브랜치, 모델, uncommitted 파일 수, 최근 커밋, PR 상태를 실시간 표시
- **Project Search** — 이름, 스택, 상태로 필터링
- **Cost & Usage** — 오늘/이번 주/전체 토큰 사용량, 모델별 비용 추정, Chart.js 차트
- **Dev Server** — 프로젝트별 개발 서버 시작/중지, stdout에서 포트 자동 감지, 클릭하면 브라우저에서 열기
- **IDE 연동** — VS Code, Cursor, Windsurf, Antigravity 원클릭 실행
- **GitHub** — 프로젝트별 열린 PR 목록 (리뷰 상태, draft 여부), 원클릭으로 GitHub 열기

### Terminal
- **Multi-terminal** — 여러 프로젝트의 터미널을 탭으로 관리, 분할(가로/세로)
- **Tab Bar** — 빠른 전환, 가운데 클릭으로 닫기, 드래그로 순서 변경
- **Branch/Worktree Picker** — 터미널 생성 시 브랜치나 Git worktree 경로 선택
- **Search** — Ctrl+F로 터미널 출력 내 검색
- **세션 복원** — 서버 재시작 시 터미널 세션 자동 복원

### Changes (Git Diff)
- **2-Column Diff View** — 파일 사이드바 + 파일별 접기/펼치기 가능한 diff 패널
- **Staged/Unstaged** — 컬러 인디케이터로 구분 (인디고=staged, 옐로우=unstaged)
- **Line Numbers** — old/new 라인넘버 거터
- **Stage/Unstage/Discard** — 파일 단위 Git 스테이징 관리
- **수동 커밋** — 메시지 입력 후 직접 커밋 + Push
- **브랜치 표시** — 툴바에 현재 브랜치명과 워크트리 수 표시

### AI Auto Commit
Claude Haiku가 \`git status\` + \`git diff\`를 분석해서 관련 파일을 논리적 커밋으로 자동 그룹핑.

**워크플로우:**
1. "AI Commit" 버튼 → Haiku가 변경사항 분석 (3~5초)
2. 커밋 플랜 표시: 커밋별 메시지 + 파일 목록 + 이유
3. 사용자가 플랜 수정:
   - 커밋 메시지 인라인 편집
   - 파일을 커밋 간 **드래그 앤 드롭**으로 이동
   - 파일을 **대기(Pending)** 영역으로 내려서 커밋에서 제외
   - 대기 파일을 다시 커밋으로 올리기 (화살표 클릭)
   - **새 커밋 추가** / **커밋 삭제** (삭제 시 파일은 대기로 이동)
4. "Commit All" → 순차적으로 커밋 실행 (프로그레스 바)
5. 완료 후 "Push" 버튼으로 원격에 푸시

**안전장치:**
- \`main\`/\`master\` 브랜치에서 커밋 시 확인 다이얼로그
- 파일 없는 빈 커밋은 자동 스킵
- 커밋 실패 시 해당 카드에 에러 표시, 나머지 중단

> AI는 Claude CLI (\`claude -p --model haiku\`)를 통해 호출되므로 별도 API 키 불필요 — 기존 OAuth 인증 그대로 사용

---

## New Features

### Git Operations
- **Pull/Fetch** — Changes 탭 툴바에서 Git Pull/Fetch 원클릭
- **Stash/Pop** — 작업 중 변경사항 임시 저장 및 복원
- **Branch Create** — 드롭다운에서 새 브랜치 직접 생성
- **Branch Delete** — 사용 안하는 로컬 브랜치 삭제 (main/master 보호)

### UX
- **Project Pin** — 카드 별표로 즐겨찾기, 핀된 프로젝트 앞으로 정렬
- **Theme Toggle** — 다크/라이트 테마 전환 (헤더 버튼)
- **Shortcut Help** — ? 키로 단축키 오버레이

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+1 | Overview 탭 |
| Ctrl+2 | Terminal 탭 |
| Ctrl+3 | Changes 탭 |
| Ctrl+4 | README 탭 |
| Ctrl+T | 새 터미널 |
| Ctrl+W | 터미널 닫기 |
| Ctrl+F | 터미널 내 검색 |
| Ctrl+Tab | 다음 터미널 |
| Ctrl+Shift+Tab | 이전 터미널 |
| Ctrl+[ / ] | 이전/다음 터미널 |
| ? | 단축키 도움말 |
| Escape | 오버레이 / 검색 닫기 |

---

## Architecture

\`\`\`
Browser (SPA)          Node.js Server (port 3847)
┌─────────────┐  HTTP  ┌──────────────────────────┐
│ index.html  │◄──────►│ server.js                │
│ (inline     │  SSE   │  ├─ lib/config.js         │
│  CSS + JS)  │◄───────│  ├─ lib/claude-data.js    │
│             │  WS    │  ├─ lib/git-service.js    │
│ xterm.js    │◄──────►│  ├─ lib/github-service.js │
│ Chart.js    │        │  ├─ lib/cost-service.js   │
└─────────────┘        │  ├─ lib/session-control.js│
                       │  └─ lib/poller.js         │
                       └──────────┬────────────────┘
                                  │
                    ┌─────────────┼──────────────┐
                    │             │              │
               ~/.claude/    git CLI      claude CLI
               (세션/비용)  (status/diff)  (AI commit)
\`\`\`

- **Frontend** — 단일 HTML 파일 (CSS + JS 인라인, 빌드 도구 없음)
- **Backend** — 순수 Node.js HTTP 서버 (프레임워크 없음)
- **실시간** — SSE로 폴링 데이터 push, WebSocket으로 터미널 스트리밍
- **터미널** — \`node-pty\`로 PTY 프로세스 생성, \`ws\`로 양방향 연결
- **AI** — \`claude -p --model haiku\` CLI 호출 (OAuth 인증)

### Tech Stack
- \`xterm.js\` (WebGL) — 터미널 렌더링
- \`Chart.js\` — 사용량 차트
- \`node-pty\` — 서버사이드 PTY
- \`ws\` — WebSocket

---

## API Endpoints

### 프로젝트
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/projects | 프로젝트 목록 |
| POST | /api/projects | 프로젝트 추가 |
| PUT | /api/projects/:id | 프로젝트 수정 |
| DELETE | /api/projects/:id | 프로젝트 삭제 |

### 모니터링
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/events | SSE 실시간 스트림 |
| GET | /api/projects/:id/git | Git 상태 |
| GET | /api/projects/:id/prs | PR 목록 |
| GET | /api/projects/:id/branches | 브랜치/워크트리 |
| GET | /api/usage | 사용량 요약 |
| GET | /api/cost/daily | 일별 비용 |
| GET | /api/activity | 최근 활동 |

### Git 작업
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/projects/:id/diff | Staged + Unstaged diff |
| POST | /api/projects/:id/git/stage | 파일 스테이징 |
| POST | /api/projects/:id/git/unstage | 스테이징 해제 |
| POST | /api/projects/:id/git/discard | 변경사항 버리기 |
| POST | /api/projects/:id/git/commit | 수동 커밋 |
| POST | /api/projects/:id/git/checkout | 브랜치 전환 |
| POST | /api/projects/:id/git/create-branch | 새 브랜치 |
| POST | /api/projects/:id/git/delete-branch | 브랜치 삭제 |
| POST | /api/projects/:id/git/stash | 변경사항 스태시 |
| POST | /api/projects/:id/git/stash-pop | 스태시 복원 |
| GET | /api/projects/:id/stash-list | 스태시 목록 |
| POST | /api/projects/:id/push | git push |
| POST | /api/projects/:id/pull | git pull |
| POST | /api/projects/:id/fetch | git fetch --all |

### AI Auto Commit
| Method | Path | 설명 |
|--------|------|------|
| POST | /api/projects/:id/auto-commit/plan | Haiku 커밋 플랜 생성 |
| POST | /api/projects/:id/auto-commit/execute | 단일 커밋 실행 |

### Dev Server
| Method | Path | 설명 |
|--------|------|------|
| GET | /api/dev-servers | 실행 중인 서버 |
| POST | /api/projects/:id/dev-server/start | 서버 시작 |
| POST | /api/projects/:id/dev-server/stop | 서버 중지 |

---

## Project Card Buttons

| Row | Buttons | Purpose |
|-----|---------|---------|
| Term | Claude, Resume, Shell | 터미널에서 Claude 세션 시작/재개/쉘 열기 |
| Open | VS, Cursor, AG, GitHub | IDE 실행 또는 GitHub repo 열기 |
| Etc | Dev, Sessions | 개발 서버 토글, 세션 이력 조회 |

---

## Polling Intervals

| 데이터 | 주기 | 설명 |
|--------|------|------|
| 세션 상태 | 5초 | Claude 프로세스 감지 |
| Git 상태 | 30초 | branch, uncommitted 등 |
| PR 상태 | 2분 | GitHub PR 목록 |
| 비용 데이터 | 1분 | 토큰 사용량/비용 |
| 활동 로그 | 10초 | 최근 세션 활동 |

---

## Setup

\`\`\`bash
cd dashboard
npm install
node server.js
\`\`\`

**요구사항:** Node.js 20+, Git, Claude Code CLI (OAuth 인증 완료)

**Windows 자동 시작:** \`powershell -File .\\setup-autostart.ps1\` (관리자 권한)
`;

function renderReadme() {
  document.getElementById("readme-content").innerHTML =
    simpleMarkdown(README_CONTENT);
}

// ─── Project Search & Scroll Indicators ───
let _projectStatusFilter = "all";
window.setProjectFilter = (filter) => {
  _projectStatusFilter = filter;
  document
    .querySelectorAll(".pf-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.filter === filter));
  filterProjects();
};

window.filterProjects = () => {
  const query = document
    .getElementById("project-search")
    .value.toLowerCase()
    .trim();
  const countEl = document.getElementById("project-search-count");
  let visible = 0;
  projectList.forEach((p) => {
    const card = document.getElementById(`card-${p.id}`);
    if (!card) return;
    const pState = state.projects.get(p.id);
    const status = pState?.session?.state || "no_data";
    const textMatch =
      !query ||
      (p.name || "").toLowerCase().includes(query) ||
      (p.stack || "").toLowerCase().includes(query) ||
      status.toLowerCase().includes(query);
    let statusMatch = true;
    if (_projectStatusFilter === "active")
      statusMatch = status === "busy" || status === "waiting";
    else if (_projectStatusFilter === "idle")
      statusMatch =
        status === "idle" || status === "no_data" || status === "no_sessions";
    card.style.display = textMatch && statusMatch ? "" : "none";
    if (textMatch && statusMatch) visible++;
  });
  countEl.textContent =
    query || _projectStatusFilter !== "all"
      ? `${visible}/${projectList.length}`
      : "";
  updateScrollIndicators();
};

window.fetchAllProjects = async () => {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = "Fetching...";
  let ok = 0,
    fail = 0;
  const promises = projectList.map((p) =>
    fetch(`/api/projects/${p.id}/fetch`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) fail++;
        else ok++;
      })
      .catch(() => fail++),
  );
  await Promise.all(promises);
  btn.disabled = false;
  btn.textContent = "Fetch All";
  showToast(
    `Fetch All: ${ok} ok${fail ? `, ${fail} failed` : ""}`,
    fail ? "error" : "success",
  );
};

function updateScrollIndicators() {
  const grid = document.getElementById("project-grid");
  const left = document.getElementById("scroll-ind-left");
  const right = document.getElementById("scroll-ind-right");
  if (!grid || !left || !right) return;
  left.classList.toggle("hidden", grid.scrollLeft <= 5);
  right.classList.toggle(
    "hidden",
    grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 5,
  );
}

// ─── Project → Changes ───
window.jumpToChanges = (projectId) => {
  switchView("diff");
  const sel = document.getElementById("diff-project");
  if (sel) {
    sel.value = projectId;
    loadDiff();
  }
};

// ─── WS Disconnect Indicator ───
function showDisconnectIndicator(show) {
  document.querySelectorAll(".term-disconnect").forEach((el) => el.remove());
  if (show) {
    document.querySelectorAll(".split-leaf").forEach((leaf) => {
      const ind = document.createElement("div");
      ind.className = "term-disconnect";
      ind.textContent = "Disconnected";
      leaf.appendChild(ind);
    });
  }
}

// ─── Terminal Font Settings ───
let termFontSize = parseInt(localStorage.getItem("dl-term-font-size") || "13");
window.changeTermFontSize = (delta) => {
  termFontSize = Math.max(8, Math.min(24, termFontSize + delta));
  localStorage.setItem("dl-term-font-size", termFontSize);
  const el = document.getElementById("term-font-size");
  if (el) el.textContent = termFontSize;
  for (const [, t] of termMap) {
    t.xterm.options.fontSize = termFontSize;
    t.fitAddon.fit();
  }
};

// ─── Terminal Export ───
window.exportTerminal = () => {
  if (!activeTermId) return showToast("No active terminal", "error");
  const t = termMap.get(activeTermId);
  if (!t) return;
  const buf = t.xterm.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  // Trim trailing empty lines
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const text = lines.join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `terminal-${t.label || activeTermId}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Terminal output exported", "info");
};

// ─── Git History Viewer ───
window.showGitLog = async (projectId) => {
  const dlg = document.getElementById("git-log-dialog");
  const content = document.getElementById("git-log-content");
  const project = projectList.find((p) => p.id === projectId);
  document.getElementById("git-log-title").textContent =
    `Git History \u2014 ${project?.name || projectId}`;
  content.innerHTML =
    '<div style="padding:14px;color:var(--text-3)">Loading\u2026</div>';
  dlg.showModal();
  try {
    const res = await fetch(`/api/projects/${projectId}/git/log?limit=50`);
    const data = await res.json();
    if (!data.commits?.length) {
      content.innerHTML =
        '<div style="padding:14px;color:var(--text-3)">No commits found</div>';
      return;
    }
    content.innerHTML = data.commits
      .map(
        (c) =>
          `<div class="git-log-item">
        <span class="git-log-hash">${esc(c.short)}</span>
        <span class="git-log-msg" title="${esc(c.message)}">${esc(c.message)}</span>
        <span class="git-log-author">${esc(c.author)}</span>
        <span class="git-log-time">${esc(c.ago)}</span>
      </div>`,
      )
      .join("");
  } catch {
    content.innerHTML =
      '<div style="padding:14px;color:var(--red)">Error loading git log</div>';
  }
};

// ─── Session History (enhanced) ───
window.showSessionHistory = async (projectId) => {
  const dlg = document.getElementById("session-dialog");
  const content = document.getElementById("session-dialog-content");
  const project = projectList.find((p) => p.id === projectId);
  document.getElementById("session-dialog-title").textContent =
    `Sessions \u2014 ${project?.name || projectId}`;
  content.innerHTML = '<div style="color:var(--text-3)">Loading\u2026</div>';
  dlg.showModal();
  try {
    const res = await fetch(`/api/projects/${projectId}/sessions`);
    const sessions = await res.json();
    if (!sessions?.length) {
      content.innerHTML =
        '<div style="color:var(--text-3)">No sessions found</div>';
      return;
    }
    content.innerHTML = sessions
      .slice(0, 30)
      .map((s) => {
        const model = (s.model || "?")
          .replace("claude-", "")
          .replace(/-\d{8}$/, "");
        const ago = s.lastModified ? timeAgo(s.lastModified) : "?";
        const size = s.sizeKB ? `${s.sizeKB} KB` : "";
        return `<div class="session-item" style="cursor:pointer" onclick="resumeSessionFromHistory('${esc(projectId)}','${esc(s.sessionId)}')" title="Click to resume">
        <span class="si-status" style="background:var(--text-3)"></span>
        <span class="si-model">${model}</span>
        <span class="si-time">${ago} ago</span>
        <span class="si-tokens">${size}</span>
        <span class="si-id">${(s.sessionId || "").slice(-8)}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="2" style="flex-shrink:0;margin-left:4px"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </div>`;
      })
      .join("");
  } catch {
    content.innerHTML =
      '<div style="color:var(--red)">Error loading sessions</div>';
  }
};

window.resumeSessionFromHistory = async (projectId, sessionId) => {
  document.getElementById("session-dialog").close();
  try {
    await fetch(`/api/sessions/${projectId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    showToast("Resuming session...", "info");
  } catch (err) {
    showToast("Resume failed: " + err.message, "error");
  }
};

// ─── Settings Export/Import ───
window.exportSettings = async () => {
  try {
    const res = await fetch("/api/settings/export");
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cockpit-projects.json";
    a.click();
    URL.revokeObjectURL(url);
    showToast("Settings exported", "success");
  } catch (err) {
    showToast("Export failed: " + err.message, "error");
  }
};

window.importSettings = async (input) => {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await fetch("/api/settings/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (result.error) showToast("Import failed: " + result.error, "error");
    else {
      showToast(`Imported ${result.imported} projects`, "success");
      location.reload();
    }
  } catch (err) {
    showToast("Import failed: " + err.message, "error");
  }
  input.value = "";
};

// ─── Discover Projects ───
let _discoverData = [];
let _discoverSelected = new Set();

window.openDiscoverModal = async () => {
  const dialog = document.getElementById("discover-dialog");
  const body = document.getElementById("discover-body");
  const footer = document.getElementById("discover-footer");
  _discoverData = [];
  _discoverSelected.clear();
  body.innerHTML =
    '<div class="discover-loading">Scanning Claude projects</div>';
  footer.style.display = "none";
  dialog.showModal();

  try {
    const res = await fetch("/api/discover-projects");
    _discoverData = await res.json();
    renderDiscoverList();
  } catch (err) {
    body.innerHTML = `<div class="discover-empty">Failed to scan: ${err.message}</div>`;
  }
};

function renderDiscoverList() {
  const body = document.getElementById("discover-body");
  const footer = document.getElementById("discover-footer");

  if (_discoverData.length === 0) {
    body.innerHTML =
      '<div class="discover-empty">No new projects found.<br><span style="font-size:.78rem;color:var(--text-3)">All Claude Code projects are already added.</span></div>';
    footer.style.display = "none";
    return;
  }

  footer.style.display = "";
  const allSelected = _discoverSelected.size === _discoverData.length;
  let html = `<div class="discover-header">
    <span class="discover-count">${_discoverData.length} project${_discoverData.length > 1 ? "s" : ""} found</span>
    <button class="discover-select-all" onclick="toggleDiscoverSelectAll()">${allSelected ? "Deselect All" : "Select All"}</button>
  </div><div class="discover-list">`;

  for (let i = 0; i < _discoverData.length; i++) {
    const p = _discoverData[i];
    const sel = _discoverSelected.has(i) ? " selected" : "";
    const gitBadge = p.hasGit
      ? '<span class="discover-badge git">git</span>'
      : '<span class="discover-badge no-git">no git</span>';
    const sessions = p.sessionCount
      ? `${p.sessionCount} session${p.sessionCount > 1 ? "s" : ""}`
      : "";
    const activity = p.lastActivity ? timeAgo(p.lastActivity) : "";
    const meta = [sessions, activity].filter(Boolean).join(" · ");

    html += `<div class="discover-item${sel}" onclick="toggleDiscoverItem(${i})">
      <div class="discover-check"></div>
      <div class="discover-info">
        <div class="discover-name">${esc(p.name)} ${gitBadge}</div>
        <div class="discover-path">${esc(p.path)}</div>
        ${meta ? `<div class="discover-meta">${meta}</div>` : ""}
      </div>
    </div>`;
  }

  html += "</div>";
  body.innerHTML = html;
  updateDiscoverBtn();
}

window.toggleDiscoverItem = (idx) => {
  if (_discoverSelected.has(idx)) _discoverSelected.delete(idx);
  else _discoverSelected.add(idx);
  renderDiscoverList();
};

window.toggleDiscoverSelectAll = () => {
  if (_discoverSelected.size === _discoverData.length) {
    _discoverSelected.clear();
  } else {
    for (let i = 0; i < _discoverData.length; i++) _discoverSelected.add(i);
  }
  renderDiscoverList();
};

function updateDiscoverBtn() {
  const btn = document.getElementById("discover-add-btn");
  if (btn) btn.textContent = `Add Selected (${_discoverSelected.size})`;
}

window.addDiscoveredProjects = async () => {
  if (_discoverSelected.size === 0) {
    showToast("Select at least one project", "warn");
    return;
  }
  const projects = [..._discoverSelected]
    .map((i) => _discoverData[i])
    .map((p) => ({ name: p.name, path: p.path }));
  try {
    const res = await fetch("/api/discover-projects/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projects }),
    });
    const result = await res.json();
    if (result.error) {
      showToast("Failed: " + result.error, "error");
      return;
    }
    showToast(
      `Added ${result.added} project${result.added > 1 ? "s" : ""}`,
      "success",
    );
    document.getElementById("discover-dialog").close();
    location.reload();
  } catch (err) {
    showToast("Failed: " + err.message, "error");
  }
};

// ─── Error Log Viewer ───
const _errorLog = [];
const _origConsoleError = console.error;
console.error = (...args) => {
  _origConsoleError.apply(console, args);
  _errorLog.push({
    time: new Date().toISOString(),
    message: args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" "),
  });
  if (_errorLog.length > 200) _errorLog.shift();
  const btn = document.getElementById("error-log-btn");
  if (btn) btn.style.display = "";
};
window.addEventListener("error", (e) => {
  _errorLog.push({
    time: new Date().toISOString(),
    message: `${e.message} at ${e.filename}:${e.lineno}`,
  });
  if (_errorLog.length > 200) _errorLog.shift();
  const btn = document.getElementById("error-log-btn");
  if (btn) btn.style.display = "";
});
window.addEventListener("unhandledrejection", (e) => {
  _errorLog.push({
    time: new Date().toISOString(),
    message: `Unhandled rejection: ${e.reason}`,
  });
  if (_errorLog.length > 200) _errorLog.shift();
  const btn = document.getElementById("error-log-btn");
  if (btn) btn.style.display = "";
});

window.openErrorLog = () => {
  const dlg = document.getElementById("error-log-dialog");
  const content = document.getElementById("error-log-content");
  if (!_errorLog.length) {
    content.innerHTML = '<div class="error-log-empty">No errors logged</div>';
  } else {
    content.innerHTML = [..._errorLog]
      .reverse()
      .map((e) => {
        const t = new Date(e.time).toLocaleTimeString("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        return `<div class="error-log-item"><span class="el-time">${t}</span><span class="el-msg">${esc(e.message)}</span></div>`;
      })
      .join("");
  }
  dlg.showModal();
};

window.clearErrorLog = () => {
  _errorLog.length = 0;
  document.getElementById("error-log-content").innerHTML =
    '<div class="error-log-empty">No errors logged</div>';
  const btn = document.getElementById("error-log-btn");
  if (btn) btn.style.display = "none";
  showToast("Error log cleared", "info");
};

// ─── Notification Filtering (per-project) ───
let _notifFilter = JSON.parse(localStorage.getItem("dl-notif-filter") || "{}");

function isNotifEnabledForProject(projectId) {
  return _notifFilter[projectId] !== false;
}

function saveNotifFilter() {
  localStorage.setItem("dl-notif-filter", JSON.stringify(_notifFilter));
}

window.toggleProjectNotif = (projectId) => {
  _notifFilter[projectId] = !isNotifEnabledForProject(projectId);
  saveNotifFilter();
  renderNotifFilterList();
};

window.openNotifSettings = () => {
  renderNotifFilterList();
  document.getElementById("notif-settings-dialog").showModal();
};

function renderNotifFilterList() {
  const el = document.getElementById("notif-filter-list");
  if (!el) return;
  el.innerHTML = projectList
    .map((p) => {
      const enabled = isNotifEnabledForProject(p.id);
      return `<div class="notif-filter-row">
      <span class="nf-dot" style="background:${p.color}"></span>
      <span class="nf-name">${esc(p.name)}</span>
      <button class="notif-toggle ${enabled ? "on" : ""}" onclick="toggleProjectNotif('${esc(p.id)}')" title="${enabled ? "Disable" : "Enable"} notifications"></button>
    </div>`;
    })
    .join("");
}

// ─── Init ───
async function init() {
  // Apply saved theme
  applyTheme(currentTheme);
  renderSkeletons(6);
  const res = await fetch("/api/projects");
  projectList = await res.json();
  // Sort pinned to front
  if (pinnedProjects.size > 0) {
    projectList.sort((a, b) => {
      const ap = pinnedProjects.has(a.id) ? 0 : 1;
      const bp = pinnedProjects.has(b.id) ? 0 : 1;
      return ap - bp;
    });
  }
  renderAllCards(projectList);
  projectList.forEach((p) => {
    state.projects.set(p.id, { session: p.session, git: p.git, prs: p.prs });
    renderCard(p.id);
  });
  populateProjectSelects();
  updateSummaryStats();
  try {
    await fetch("/api/stats").then((r) => r.json());
  } catch {}
  connectSSE();
  connectWS();
  renderReadme();
  // Scroll indicators
  const pgrid = document.getElementById("project-grid");
  if (pgrid) {
    pgrid.addEventListener("scroll", updateScrollIndicators);
  }
  window.addEventListener("resize", updateScrollIndicators);
  updateScrollIndicators();
  // Restore notify toggle state & sync to server
  const nb = document.getElementById("notify-toggle");
  if (nb) {
    nb.textContent = notifyEnabled ? "On" : "Off";
    nb.className = "btn" + (notifyEnabled ? "" : " off-btn");
  }
  fetch("/api/notify/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: notifyEnabled }),
  }).catch(() => {});
  // Restore chart period
  if (chartPeriod !== 30) setChartPeriod(chartPeriod);
  // Restore terminal font size display
  const fse = document.getElementById("term-font-size");
  if (fse) fse.textContent = termFontSize;
  const savedView = localStorage.getItem("dl-view");
  if (savedView && savedView !== "dashboard") switchView(savedView);
  // Tauri file drop → send path as terminal input
  initFileDrop();
}

function initFileDrop() {
  // Drop overlay
  const overlay = document.createElement("div");
  overlay.id = "drop-overlay";
  overlay.innerHTML = '<div class="drop-msg">Drop file to preview</div>';
  overlay.style.cssText =
    "display:none;position:fixed;inset:0;z-index:9999;background:rgba(99,102,241,.15);backdrop-filter:blur(2px);pointer-events:none;align-items:center;justify-content:center";
  overlay.querySelector(".drop-msg").style.cssText =
    "background:var(--bg-2);border:2px dashed var(--accent);color:var(--text-0);padding:20px 40px;border-radius:12px;font-size:16px;font-weight:600";
  document.body.appendChild(overlay);

  // HTML5 drag-drop (works with dragDropEnabled: false)
  document.addEventListener("dragenter", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      overlay.style.display = "flex";
    }
  });
  document.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });
  document.addEventListener("dragleave", (e) => {
    if (
      e.relatedTarget === null ||
      e.relatedTarget === document.documentElement
    )
      overlay.style.display = "none";
  });
  document.addEventListener("drop", (e) => {
    overlay.style.display = "none";
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    // Only handle external file drops (not internal DnD)
    if (
      !e.dataTransfer.types.includes("Files") ||
      e.dataTransfer.types.includes("text/plain")
    )
      return;
    e.preventDefault();
    const file = files[0];
    openFilePreviewFromFile(file);
  });
}

const IMG_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "svg",
  "ico",
]);

// Preview from HTML5 File object (drag-drop, no full path available)
function openFilePreviewFromFile(file) {
  const name = file.name;
  const ext = name.split(".").pop().toLowerCase();
  ensurePreviewModal();
  const el = document.getElementById("file-preview-overlay");
  el.classList.remove("hidden");
  el.querySelector(".fp-name").textContent = name;
  el.querySelector(".fp-path").textContent = "(Dropped file)";
  el._filePath = name; // only filename available
  el._content = "";
  const sizeStr =
    file.size < 1024 ? file.size + "B" : (file.size / 1024).toFixed(1) + "KB";
  el.querySelector(".fp-size").textContent = sizeStr;
  const body = el.querySelector(".fp-body");
  if (IMG_EXT.has(ext)) {
    const url = URL.createObjectURL(file);
    body.innerHTML = `<img class="fp-img" src="${url}" alt="${name}">`;
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    body.innerHTML =
      '<div style="padding:20px;color:var(--red)">File too large (>2MB)</div>';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    el._content = reader.result;
    const lines = reader.result.split("\n");
    const escaped = lines
      .map((l, i) => `<span class="line-num">${i + 1}</span>${escapeHtml(l)}`)
      .join("\n");
    body.innerHTML = `<pre>${escaped}</pre>`;
  };
  reader.onerror = () => {
    body.innerHTML =
      '<div style="padding:20px;color:var(--red)">Failed to read file</div>';
  };
  reader.readAsText(file);
}

function ensurePreviewModal() {
  if (document.getElementById("file-preview-overlay")) return;
  const el = document.createElement("div");
  el.id = "file-preview-overlay";
  el.className = "file-preview-overlay hidden";
  el.onclick = (e) => {
    if (e.target === el) closeFilePreview();
  };
  el.innerHTML = `<div class="file-preview-card">
    <div class="fp-header">
      <svg class="fp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="fp-name"></span>
      <span class="fp-path"></span>
      <span class="fp-size"></span>
      <button class="fp-close" onclick="closeFilePreview()">&times;</button>
    </div>
    <div class="fp-body"></div>
    <div class="fp-actions">
      <button class="btn" onclick="copyFilePathToClipboard()">Copy Path</button>
      <button class="btn" onclick="copyFileContent()">Copy Content</button>
      <button class="btn" onclick="insertPathToTerminal()">Insert to Terminal</button>
    </div>
  </div>`;
  document.body.appendChild(el);
}

// Preview from full file path (context menu click, terminal link click)
function openFilePreview(filePath) {
  const name = filePath.replace(/\\/g, "/").split("/").pop();
  const ext = name.split(".").pop().toLowerCase();
  ensurePreviewModal();
  const el = document.getElementById("file-preview-overlay");
  el.classList.remove("hidden");
  el.querySelector(".fp-name").textContent = name;
  el.querySelector(".fp-path").textContent = filePath;
  el._filePath = filePath;
  el._content = "";
  const body = el.querySelector(".fp-body");
  body.innerHTML =
    '<div style="padding:20px;color:var(--text-3)">Loading...</div>';
  if (IMG_EXT.has(ext)) {
    // Image preview — use file:// URL via Tauri's asset protocol
    const assetUrl =
      window.__TAURI__?.core?.convertFileSrc?.(filePath) ||
      "file:///" + filePath.replace(/\\/g, "/");
    body.innerHTML = `<img class="fp-img" src="${assetUrl}" alt="${name}">`;
    el.querySelector(".fp-size").textContent = "Image";
    return;
  }
  fetch("/api/file?path=" + encodeURIComponent(filePath))
    .then((r) => r.json())
    .then((data) => {
      if (data.error) {
        body.innerHTML = `<div style="padding:20px;color:var(--red)">${data.error}</div>`;
        return;
      }
      el._content = data.content;
      const sizeStr =
        data.size < 1024
          ? data.size + "B"
          : (data.size / 1024).toFixed(1) + "KB";
      el.querySelector(".fp-size").textContent = sizeStr;
      const lines = data.content.split("\n");
      const escaped = lines
        .map((l, i) => `<span class="line-num">${i + 1}</span>${escapeHtml(l)}`)
        .join("\n");
      body.innerHTML = `<pre>${escaped}</pre>`;
    })
    .catch(() => {
      body.innerHTML =
        '<div style="padding:20px;color:var(--red)">Failed to read file</div>';
    });
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function closeFilePreview() {
  const el = document.getElementById("file-preview-overlay");
  if (el) el.classList.add("hidden");
}
window.copyFilePathToClipboard = () => {
  const el = document.getElementById("file-preview-overlay");
  if (el?._filePath) {
    navigator.clipboard
      .writeText(el._filePath)
      .then(() => showToast("Path copied"))
      .catch(() => {});
  }
};
window.copyFileContent = () => {
  const el = document.getElementById("file-preview-overlay");
  if (el?._content) {
    navigator.clipboard
      .writeText(el._content)
      .then(() => showToast("Content copied"))
      .catch(() => {});
  }
};
window.insertPathToTerminal = () => {
  const el = document.getElementById("file-preview-overlay");
  if (!el?._filePath || !activeTermId || !ws || ws.readyState !== 1) return;
  const p = el._filePath;
  ws.send(
    JSON.stringify({
      type: "input",
      termId: activeTermId,
      data: p.includes(" ") ? `"${p}"` : p,
    }),
  );
  closeFilePreview();
  switchView("terminal");
  showToast("Path inserted");
};

// ─── Context Menu ───
let _ctxMenu = null;
function hideCtxMenu() {
  if (_ctxMenu) {
    _ctxMenu.remove();
    _ctxMenu = null;
  }
}
document.addEventListener("click", hideCtxMenu);
document.addEventListener("contextmenu", hideCtxMenu);

function showCtxMenu(x, y, items) {
  hideCtxMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const item of items) {
    if (item === "sep") {
      const d = document.createElement("div");
      d.className = "ctx-menu-sep";
      menu.appendChild(d);
      continue;
    }
    if (item.label) {
      const d = document.createElement("div");
      d.className = "ctx-menu-label";
      d.textContent = item.label;
      menu.appendChild(d);
      continue;
    }
    const d = document.createElement("div");
    d.className = "ctx-menu-item";
    d.innerHTML = (item.icon || "") + `<span>${item.text}</span>`;
    d.onclick = (e) => {
      e.stopPropagation();
      hideCtxMenu();
      item.action();
    };
    menu.appendChild(d);
  }
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  document.body.appendChild(menu);
  // Keep in viewport
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth)
    menu.style.left = window.innerWidth - r.width - 8 + "px";
  if (r.bottom > window.innerHeight)
    menu.style.top = window.innerHeight - r.height - 8 + "px";
  _ctxMenu = menu;
}

const ICON = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
};

// Detect file path at position in xterm buffer
function getFilePathAtPosition(xterm, x, y) {
  const line = xterm.buffer.active.getLine(y)?.translateToString() || "";
  const re =
    /(?:[A-Za-z]:[\\\/][^\s"'<>|:]+|\/(?:home|usr|tmp|var|etc|opt|mnt)[^\s"'<>|:]+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (x >= m.index && x < m.index + m[0].length) return m[0];
  }
  return null;
}

function openInIde(filePath, ide) {
  fetch("/api/open-in-ide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, ide }),
  })
    .then((r) => r.json())
    .then((d) => {
      if (d.opened) showToast(`Opened in ${ide}`);
      else showToast(d.error || "Failed", "error");
    })
    .catch(() => showToast("Failed to open", "error"));
}
function openContainingFolder(filePath) {
  fetch("/api/open-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath }),
  })
    .then(() => showToast("Opened in Explorer"))
    .catch(() => {});
}

init();
