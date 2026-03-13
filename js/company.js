// ─── Company View: Pixel Office Simulation ───
import { esc, fetchJson, postJson, simpleMarkdown } from './utils.js';
import { registerClickActions } from './actions.js';

const TEAMS = {
  dev:       { name: '개발팀',   icon: '💻', color: '#6366f1' },
  plan:      { name: '기획팀',   icon: '📋', color: '#f59e0b' },
  design:    { name: '디자인팀', icon: '🎨', color: '#ec4899' },
  admin:     { name: '경영지원', icon: '💰', color: '#14b8a6' },
  marketing: { name: '마케팅팀', icon: '📢', color: '#f97316' },
};
const RK = { Director:'이사', CEO:'이사', VP:'부장', 'Team Lead':'팀장', Manager:'과장', 'Asst.Mgr':'대리', Staff:'사원', Intern:'인턴' };

// ─── User Name ───
function getUserName() { return localStorage.getItem('cockpit-username') || ''; }
function setUserName(name) { localStorage.setItem('cockpit-username', name); }
function ensureUserName() {
  if (getUserName()) return;
  showNameDialog();
}
function showNameDialog() {
  document.getElementById('co-name-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'co-name-overlay';
  overlay.className = 'co-orgmap-overlay';
  overlay.style.zIndex = '10000';
  overlay.innerHTML = `
    <div class="co-name-dialog">
      <div class="co-name-title">이름을 입력해주세요</div>
      <div class="co-name-sub">직원들이 이 이름으로 부릅니다</div>
      <input class="co-name-input" id="co-name-input" placeholder="이름 (예: 홍길동)" maxlength="10" value="${esc(getUserName())}" />
      <button class="co-name-btn" id="co-name-confirm">확인</button>
    </div>`;
  document.body.appendChild(overlay);
  const input = document.getElementById('co-name-input');
  const confirm = () => {
    const name = input.value.trim();
    if (!name) { input.style.borderColor = '#ef4444'; return; }
    setUserName(name);
    // Sync to server so agents know the user's name
    postJson('/api/agent/username', { name }).catch(() => {});
    overlay.remove();
    render();
  };
  document.getElementById('co-name-confirm').addEventListener('click', confirm);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); });
  setTimeout(() => input.focus(), 100);
}

// Tool affinity per agent — primary (strong) and secondary (can use)
const TOOL_MAP = {
  daepyo:          { primary: ['DELEGATE','COCKPIT'],          secondary: ['BASH','READ'] },
  dev_bujang:      { primary: ['BASH','EDIT','WRITE','DELEGATE'], secondary: ['READ','SEARCH','GLOB','GIT_DIFF','GIT_LOG','CICD'] },
  dev_gwajang:     { primary: ['CICD','GIT_DIFF','GIT_LOG','EDIT'], secondary: ['BASH','READ','SEARCH','JIRA'] },
  dev_daeri:       { primary: ['READ','SEARCH','GLOB','EDIT'],  secondary: ['BASH','GIT_DIFF','GIT_LOG','WRITE'] },
  dev_sawon:       { primary: ['READ','SEARCH','GLOB','BASH'],  secondary: ['GIT_DIFF'] },
  plan_teamlead:   { primary: ['JIRA','COCKPIT','WRITE'],      secondary: ['READ','SEARCH'] },
  plan_daeri:      { primary: ['JIRA','READ','SEARCH'],         secondary: ['COCKPIT'] },
  plan_sawon:      { primary: ['JIRA','READ'],                  secondary: ['SEARCH','COCKPIT'] },
  design_teamlead: { primary: ['READ','EDIT','WRITE'],          secondary: ['SEARCH','GLOB','OPEN'] },
  design_daeri:    { primary: ['EDIT','WRITE','READ'],           secondary: ['SEARCH','GLOB'] },
  admin_teamlead:  { primary: ['COCKPIT','BASH'],               secondary: ['READ','JIRA'] },
  admin_sawon:     { primary: ['COCKPIT','WEATHER'],             secondary: ['READ','BASH'] },
  mkt_teamlead:    { primary: ['WRITE','OPEN','SEARCH'],        secondary: ['READ','EDIT'] },
  mkt_sawon:       { primary: ['SEARCH','WRITE','OPEN'],        secondary: ['READ'] },
  intern:          { primary: ['WEATHER','OPEN','SEARCH'],       secondary: ['READ','BASH'] },
};
const ALL_TOOLS = ['BASH','READ','SEARCH','EDIT','WRITE','GLOB','GIT_DIFF','GIT_LOG','JIRA','CICD','OPEN','COCKPIT','WEATHER','DELEGATE'];
const TOOL_ICONS = {
  BASH:'$_', READ:'RD', SEARCH:'SR', EDIT:'ED', WRITE:'WR', GLOB:'GL',
  GIT_DIFF:'GD', GIT_LOG:'GL', JIRA:'JR', CICD:'CI', OPEN:'OP',
  COCKPIT:'CK', WEATHER:'WE', DELEGATE:'DG',
};

let _data = null, _sseBound = false;
const _tasks = [];
let _targetAgent = null; // { id, name, emoji, color } — clicked agent target
const _st = {};
function S(id) { return _st[id] ??= { s:'idle', t:'', ts:0 }; }

// ═══ Office Layout Constants (percentage-based) ═══

// Zones: team areas on the office floor
const ZONES = {
  exec:      { x:1,  y:1,  w:22, h:24, label:'대표실',   color:'#ef4444' },
  meetA:     { x:25, y:1,  w:24, h:24, label:'회의실 A',  color:'#6366f1', room:true },
  meetB:     { x:51, y:1,  w:24, h:24, label:'회의실 B',  color:'#6366f1', room:true },
  meetC:     { x:77, y:1,  w:22, h:24, label:'회의실 C',  color:'#6366f1', room:true },
  dev:       { x:1,  y:30, w:32, h:28, label:'개발팀',    color:'#6366f1' },
  plan:      { x:34, y:30, w:32, h:28, label:'기획팀',    color:'#f59e0b' },
  design:    { x:67, y:30, w:32, h:28, label:'디자인팀',  color:'#ec4899' },
  admin:     { x:1,  y:63, w:24, h:28, label:'경영지원',  color:'#14b8a6' },
  marketing: { x:26, y:63, w:24, h:28, label:'마케팅팀',  color:'#f97316' },
  monitor:   { x:51, y:63, w:24, h:28, label:'감시팀',    color:'#64748b' },
  intern:    { x:76, y:63, w:23, h:28, label:'인턴석',    color:'#94a3b8' },
};

// Meeting room center positions (where agents walk to when working)
const MEET_POS = {
  meetA: { x: 37, y: 13 },
  meetB: { x: 63, y: 13 },
  meetC: { x: 88, y: 13 },
};

// Desk positions per agent — will be computed dynamically based on team zone
function computeDesks(agents) {
  const desks = {};
  const teamMembers = {};

  for (const a of agents) {
    if (a.rank === 'Director' || a.rank === 'CEO') {
      desks[a.id] = { x: 12, y: 14 };
      continue;
    }
    if (a.rank === 'Intern') {
      desks[a.id] = { x: 88, y: 77 };
      continue;
    }
    const tid = a.team;
    if (!tid) continue;
    (teamMembers[tid] ??= []).push(a);
  }

  // Sort each team by rank
  const ro = ['VP','Team Lead','Manager','Asst.Mgr','Staff'];
  for (const [tid, members] of Object.entries(teamMembers)) {
    members.sort((a, b) => ro.indexOf(a.rank) - ro.indexOf(b.rank));
    const zone = ZONES[tid];
    if (!zone) continue;

    const cols = Math.min(members.length, 3);
    const rows = Math.ceil(members.length / cols);
    const cellW = zone.w / (cols + 1);
    const cellH = zone.h / (rows + 1);

    members.forEach((a, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      desks[a.id] = {
        x: zone.x + cellW * (col + 1),
        y: zone.y + cellH * (row + 1) + 2,
      };
    });
  }

  return desks;
}

let _desks = {};
let _meetingRoom = 0; // round-robin meeting room assignment
let _orchMeetingRoom = null; // fixed room during orchestration
const _orchParticipants = new Set(); // agents in current orchestration

// ═══ State transitions ═══

function work(id, tool) {
  const s = S(id);
  const wasIdle = s.s !== 'working';
  s.s = 'working';
  if (tool) s.t = tool;
  s.ts = Date.now();
  updateSprite(id);
  if (wasIdle) moveToMeeting(id, _orchMeetingRoom);
}

function done(id) {
  const s = S(id);
  s.s = 'done';
  s.ts = Date.now();
  updateSprite(id);
  // Stay in meeting room during orchestration, go to desk otherwise
  if (!_orchParticipants.has(id)) moveToDesk(id);
  setTimeout(() => {
    if (s.s === 'done') { s.s = 'idle'; s.t = ''; updateSprite(id); }
  }, 8000);
}

function orchStart(orchestratorId) {
  // Pick a fixed meeting room for this orchestration session
  const rooms = Object.keys(MEET_POS);
  _orchMeetingRoom = rooms[_meetingRoom % rooms.length];
  _meetingRoom++;
  _orchParticipants.clear();
  _orchParticipants.add(orchestratorId);
}

function orchEnd() {
  // Send all participants back to their desks and reset state
  for (const id of _orchParticipants) {
    const s = S(id);
    if (s.s !== 'idle') { s.s = 'idle'; s.t = ''; updateSprite(id); }
    moveToDesk(id);
  }
  _orchParticipants.clear();
  _orchMeetingRoom = null;
}

function orchSubStart(agentId) {
  _orchParticipants.add(agentId);
}

// ═══ DELEGATE visualization ═══

function showDelegation(fromId, toId) {
  const fromEl = document.getElementById(`ag-${fromId}`);
  const toEl = document.getElementById(`ag-${toId}`);
  if (!fromEl || !toEl) return;
  const office = document.querySelector('.co-office');
  if (!office) return;

  // Create arrow line
  const arrow = document.createElement('div');
  arrow.className = 'co-delegate-arrow';
  const fx = parseFloat(fromEl.style.left), fy = parseFloat(fromEl.style.top);
  const tx = parseFloat(toEl.style.left), ty = parseFloat(toEl.style.top);
  const dx = tx - fx, dy = ty - fy;
  const len = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  arrow.style.left = fx + '%';
  arrow.style.top = fy + '%';
  arrow.style.width = len + '%';
  arrow.style.transform = `rotate(${angle}deg)`;
  office.appendChild(arrow);
  // Remove after animation
  setTimeout(() => arrow.remove(), 2000);
}

function updateSprite(id) {
  const el = document.getElementById(`ag-${id}`);
  if (!el) return;
  const s = S(id);
  el.dataset.state = s.s;
  const tip = el.querySelector('.ag-tip');
  if (tip) tip.textContent = s.s === 'working' ? (s.t || '작업 중...') : s.s === 'done' ? '✓ 완료' : '';
}

// ═══ Movement ═══

function moveToMeeting(id, fixedRoom) {
  const el = document.getElementById(`ag-${id}`);
  if (!el) return;
  let room;
  if (fixedRoom && MEET_POS[fixedRoom]) {
    room = fixedRoom;
  } else {
    const rooms = Object.keys(MEET_POS);
    room = rooms[_meetingRoom % rooms.length];
    _meetingRoom++;
  }
  const pos = MEET_POS[room];
  // Offset slightly so multiple agents don't stack exactly
  const offset = (Math.random() - 0.5) * 8;
  el.classList.add('walking');
  el.style.left = (pos.x + offset) + '%';
  el.style.top = (pos.y + offset * 0.5) + '%';
  // Remove walking class after transition
  setTimeout(() => el.classList.remove('walking'), 900);
}

function moveToDesk(id) {
  const el = document.getElementById(`ag-${id}`);
  if (!el) return;
  const desk = _desks[id];
  if (!desk) return;
  el.classList.add('walking');
  el.style.left = desk.x + '%';
  el.style.top = desk.y + '%';
  setTimeout(() => el.classList.remove('walking'), 900);
}

// ═══ Init & Render ═══

export async function initCompany() {
  try { _data = await fetchJson('/api/agent/company'); } catch { _data = null; }
  ensureUserName();
  // Sync existing name to server
  const name = getUserName();
  if (name) postJson('/api/agent/username', { name }).catch(() => {});
  render();
  renderTasks();
  renderStatsBar();
  startClock();
  loadProjectOptions();
  if (!_sseBound) {
    _sseBound = true;
    for (const ev of ['agent:start','agent:thinking','agent:tool','agent:response','agent:done','orch:start','orch:plan','orch:sub-start','orch:sub-done','orch:response','orch:done'])
      document.addEventListener(ev, e => onEv(ev, e.detail));
    for (const ev of ['sprint:start','sprint:phase','sprint:log','sprint:validate','sprint:done','sprint:error','sprint:stopped','sprint:cost','sprint:agent'])
      document.addEventListener(ev, e => onSprintEvent(ev, e.detail));
    document.addEventListener('agent:proactive', e => onAlert(e.detail));
    // Monitor-triggered reviews
    document.addEventListener('monitor:review-start', e => onMonitorReviewStart(e.detail));
    document.addEventListener('monitor:report', e => onMonitorReport(e.detail));
  }
  loadAlerts();
  loadReports();
}

function render() {
  const el = document.getElementById('company-org');
  if (!el || !_data) return;
  const { agents } = _data;

  // Compute desk positions
  _desks = computeDesks(agents);

  // Add monitor agent to data
  const _monitorAgent = {
    id: 'monitor', name: '모니터', emoji: '🛡', color: '#64748b',
    rank: 'Staff', team: 'monitor', provider: 'system', model: 'scanner',
  };

  let h = '<div class="co-office">';

  // Render zones — clickable team areas open workspace panel
  for (const [zid, z] of Object.entries(ZONES)) {
    const cls = z.room ? 'co-room' : 'co-zone';
    const clickable = !z.room;
    const members = _data.agents.filter(a => a.team === zid).length;
    h += `<div class="${cls}" style="--tc:${z.color};left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%" ${clickable ? `data-action="co-open-workspace" data-zone="${zid}"` : ''}>
      <span class="co-zlabel">${esc(z.label)}</span>
      ${z.room ? '<div class="co-table"></div>' : ''}
      ${clickable && members ? `<span class="co-zone-count">${members}</span>` : ''}
    </div>`;
  }

  // Render agent sprites
  const userName = getUserName() || 'ME';
  for (const a of agents) {
    const desk = _desks[a.id];
    if (!desk) continue;
    const isCeo = a.rank === 'Director' || a.rank === 'CEO';
    const s = S(a.id);
    const action = isCeo ? 'data-action="co-change-name"' : `data-action="company-show-profile" data-agent="${esc(a.id)}"`;
    const rank = RK[a.rank] || '';
    h += `<div class="co-sprite ${isCeo ? 'co-sprite-me' : ''}" id="ag-${a.id}" data-state="${s.s}" style="--c:${a.color};left:${desk.x}%;top:${desk.y}%" ${action}>
      <div class="co-sprite-face" style="background:${isCeo ? 'linear-gradient(135deg,#ef4444,#b91c1c)' : a.color}">${isCeo ? '👤' : a.emoji}<span class="co-sprite-dot"></span></div>
      <span class="co-sprite-name" style="color:${a.color}">${isCeo ? esc(userName) : esc(a.name)}</span>
      ${!isCeo ? `<span class="co-sprite-rank">${esc(rank)}</span>` : ''}
      <span class="ag-tip">${s.s === 'working' ? esc(s.t || '작업 중...') : s.s === 'done' ? '✓ 완료' : ''}</span>
    </div>`;
    // Desk icon decoration
    if (!isCeo) h += `<span class="co-desk-icon" style="left:${desk.x}%;top:${desk.y + 5}%">🖥</span>`;
  }

  // Monitor agent sprite
  const monDesk = { x: 63, y: 77 };
  _desks['monitor'] = monDesk;
  h += `<div class="co-sprite" id="ag-monitor" data-state="idle" style="--c:#64748b;left:${monDesk.x}%;top:${monDesk.y}%">
    <div class="co-sprite-face" style="background:#475569">🛡</div>
    <span class="co-sprite-name" style="color:#94a3b8">모니터</span>
    <span class="ag-tip" id="monitor-tip"></span>
  </div>`;

  // Hallway strips between zone rows
  h += `<div class="co-hallway" style="top:25%;height:5%"></div>`;
  h += `<div class="co-hallway" style="top:58%;height:5%"></div>`;
  h += `<div class="co-hallway" style="top:91%;height:5%"></div>`;

  // Office decorations
  h += `
    <div class="co-deco co-deco-plant" style="left:24%;top:27%">🌿</div>
    <div class="co-deco co-deco-plant" style="left:50%;top:27%">🪴</div>
    <div class="co-deco co-deco-plant" style="left:76%;top:27%">🌱</div>
    <div class="co-deco co-deco-plant" style="left:0.5%;top:61%">🌵</div>
    <div class="co-deco co-deco-plant" style="left:99%;top:61%">🌿</div>
    <div class="co-deco co-deco-obj" style="left:49%;top:62%">🧊</div>
    <div class="co-deco co-deco-obj" style="left:25%;top:94%">🖨️</div>
    <div class="co-deco co-deco-obj" style="left:75%;top:94%">☕</div>
    <div class="co-live-clock"></div>
  `;

  // Org map button
  h += `<button class="co-orgmap-btn" data-action="co-show-orgmap" title="조직도 / 도구 관계">ORG</button>`;

  h += '</div>'; // .co-office
  el.innerHTML = h;
  startMonitorPulse();
}

// ─── Monitor status pulse ───
let _monitorInterval = null;
function startMonitorPulse() {
  if (_monitorInterval) clearInterval(_monitorInterval);
  const el = document.getElementById('ag-monitor');
  const tip = document.getElementById('monitor-tip');
  if (!el || !tip) return;
  let cycle = 0;
  const scans = ['터미널 스캔...','CI/CD 체크...','Jira 감시...'];
  _monitorInterval = setInterval(() => {
    const phase = cycle % 30;
    if (phase < 3) {
      el.dataset.state = 'working';
      tip.textContent = scans[phase] || '스캔 중...';
    } else {
      el.dataset.state = _alerts.length ? 'done' : 'idle';
      tip.textContent = _alerts.length ? `${_alerts.length}건 감지` : '';
    }
    cycle++;
  }, 1000);
}

// ─── Stats Bar ───
function renderStatsBar() {
  const el = document.getElementById('co-stats-bar');
  if (!el || !_data) return;
  const agents = _data.agents || [];
  const workingCount = agents.filter(a => S(a.id).s === 'working').length;
  const doneCount = agents.filter(a => S(a.id).s === 'done').length;
  const pendingTasks = _tasks.filter(t => t.status === 'routing' || t.status === 'assigned').length;
  const activeTasks = _tasks.filter(t => t.status === 'working').length;
  const alertCount = _alerts.length;

  el.innerHTML = `
    <span class="co-stat-item">👥 <span class="co-stat-val">${agents.length}</span> 에이전트</span>
    <span class="co-stat-sep"></span>
    <span class="co-stat-item">🔧 <span class="co-stat-val${workingCount ? ' active' : ''}">${workingCount}</span> 작업중</span>
    ${doneCount ? `<span class="co-stat-item">✅ <span class="co-stat-val">${doneCount}</span> 완료</span>` : ''}
    <span class="co-stat-sep"></span>
    <span class="co-stat-item">📋 <span class="co-stat-val">${activeTasks + pendingTasks}</span> 태스크</span>
    ${alertCount ? `<span class="co-stat-sep"></span><span class="co-stat-item">⚠ <span class="co-stat-val warn">${alertCount}</span> 알림</span>` : ''}
  `;
}

// ─── Live Clock ───
let _clockInterval = null;
function startClock() {
  if (_clockInterval) clearInterval(_clockInterval);
  updateClock();
  _clockInterval = setInterval(updateClock, 30000);
}
function updateClock() {
  const el = document.querySelector('.co-live-clock');
  if (!el) return;
  el.textContent = new Date().toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' });
}

// ─── Zone Active Glow ───
function updateZoneGlow() {
  if (!_data) return;
  const agents = _data.agents || [];
  const activeTeams = new Set();
  for (const a of agents) {
    if (S(a.id).s === 'working' && a.team) activeTeams.add(a.team);
  }
  document.querySelectorAll('.co-zone').forEach(z => {
    z.classList.toggle('has-active', activeTeams.has(z.dataset.zone));
  });
}

// ─── Events ───
function onEv(ev, d) {
  if (!d) return;
  const id = d.agentId;
  if (id) {
    if (ev === 'orch:start') { orchStart(id); work(id, '오케스트레이션'); }
    else if (ev === 'orch:done') { done(id); orchEnd(); }
    else if (ev === 'orch:sub-start') { orchSubStart(id); work(id, d.taskDesc || ''); }
    else if (ev === 'orch:sub-done') done(id);
    else if (ev === 'agent:start') work(id, '');
    else if (ev === 'agent:thinking') work(id, `사고 중 (${d.iteration || ''})`);
    else if (ev === 'agent:tool') {
      work(id, d.tool || '도구');
      // DELEGATE visualization: show arrow to target agent
      if (d.tool === 'DELEGATE' && d.targetAgentId) showDelegation(id, d.targetAgentId);
    }
    else if (ev === 'agent:response' || ev === 'agent:done') done(id);
  }
  renderStatsBar();
  updateZoneGlow();
  // Update chat count
  const chatCount = document.getElementById('co-chat-count');
  if (chatCount) {
    const active = _tasks.filter(t => t.status === 'working').length;
    chatCount.textContent = active ? `${active} 진행중` : '';
  }
  // task
  const task = _tasks.find(t => t.convId === d.convId);
  if (task) {
    if ((ev === 'agent:start' || ev === 'orch:start') && id) {
      const a = _data?.agents?.find(x => x.id === id);
      task.agent = d.agentName || a?.name || id;
      task.emoji = a?.emoji || '';
      task.color = d.agentColor || a?.color || '#888';
      task.team = a?.team || null;
      task.status = 'working';
    }
    if (ev === 'agent:response' || ev === 'orch:response') { task.result = d.content; task.status = 'done'; }
    if (ev === 'agent:done' || ev === 'orch:done') { if (task.status !== 'done') task.status = 'done'; }
    renderTasks();
  }
  addFeed(ev, d);
  onEv_captureReport(ev, d);
}

function addFeed(ev, d) {
  const feed = document.getElementById('co-activity-feed');
  if (!feed) return;
  const a = d.agentId ? _data?.agents?.find(x => x.id === d.agentId) : null;
  const nm = d.agentName || a?.name || '';
  const col = d.agentColor || a?.color || '#6366f1';
  const emoji = a?.emoji || '';
  let txt = '';
  switch (ev) {
    case 'agent:start': if (!nm) return; txt = `${emoji} ${nm} 시작`; break;
    case 'agent:tool': txt = `🔧 ${nm} → ${d.tool}`; break;
    case 'agent:response': txt = `✅ ${nm} 완료`; break;
    case 'orch:start': txt = `${emoji} ${nm} 오케스트레이션`; break;
    case 'orch:sub-start': txt = `${emoji} ${d.agentName || ''} 서브태스크`; break;
    case 'orch:sub-done': txt = `✅ ${d.agentName || ''} 완료`; break;
    case 'orch:response': txt = `📊 ${nm} 보고`; break;
    case 'agent:proactive': txt = `${d.level === 'error' ? '!!' : d.level === 'warning' ? '!' : '~'} ${d.title || '알림'}`; break;
    default: return;
  }
  const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const span = document.createElement('span');
  span.className = 'co-feed-item';
  span.innerHTML = `<b style="color:${col}">${esc(txt)}</b> <small>${time}</small>`;
  feed.appendChild(span);
  while (feed.children.length > 30) feed.removeChild(feed.firstChild);
  feed.scrollLeft = feed.scrollWidth;
}

// ─── Agent Profile Popover ───
function showAgentProfile(agentId) {
  document.getElementById('co-profile-pop')?.remove();
  const agent = _data?.agents?.find(a => a.id === agentId);
  if (!agent) return;
  const sprite = document.getElementById(`ag-${agentId}`);
  if (!sprite) return;

  const tm = TOOL_MAP[agentId] || { primary: [], secondary: [] };
  const rank = RK[agent.rank] || agent.rank;
  const teamName = agent.team ? (TEAMS[agent.team]?.name || agent.team) : '특수';
  const provLabel = agent.provider === 'claude' ? 'Claude' : agent.provider === 'gemini' ? 'Gemini' : agent.provider;
  const modelShort = agent.model.split('/').pop().split('-').slice(0, 3).join('-');
  const s = S(agentId);
  const statusText = s.s === 'working' ? `작업 중: ${s.t || ''}` : s.s === 'done' ? '완료' : '대기';

  const toolTags = tm.primary.map(t => `<span class="co-prof-tool primary">${t}</span>`).join('')
    + tm.secondary.map(t => `<span class="co-prof-tool secondary">${t}</span>`).join('');

  const pop = document.createElement('div');
  pop.id = 'co-profile-pop';
  pop.className = 'co-profile-pop';
  // Position near sprite
  const rect = sprite.getBoundingClientRect();
  const office = document.querySelector('.co-office')?.getBoundingClientRect() || { left: 0, top: 0 };
  let px = rect.left - office.left + 30, py = rect.top - office.top - 10;
  if (px + 220 > (office.width || 800)) px = rect.left - office.left - 230;
  if (py < 0) py = 0;
  pop.style.left = px + 'px';
  pop.style.top = py + 'px';

  pop.innerHTML = `
    <div class="co-prof-header" style="border-color:${agent.color}">
      <div class="co-prof-face" style="background:${agent.color}">${agent.emoji}</div>
      <div class="co-prof-info">
        <b class="co-prof-name">${esc(agent.name)}</b>
        <span class="co-prof-rank">${esc(rank)} · ${esc(teamName)}</span>
        <span class="co-prof-model">${esc(provLabel)} / ${esc(modelShort)}</span>
      </div>
    </div>
    <div class="co-prof-status co-status-${s.s}">${statusText}</div>
    <div class="co-prof-section">
      <div class="co-prof-label">도구</div>
      <div class="co-prof-tools">${toolTags}</div>
    </div>
    <div class="co-prof-actions">
      <button class="co-prof-btn" data-action="company-call-agent" data-agent="${esc(agentId)}">지시하기</button>
    </div>`;

  document.querySelector('.co-office')?.appendChild(pop);
  // Close on outside click
  const close = (e) => { if (!pop.contains(e.target) && e.target !== sprite && !sprite.contains(e.target)) { pop.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 10);
}

// ─── Agent Targeting ───
function targetAgent(agentId) {
  if (!_data) return;
  const agent = _data.agents.find(a => a.id === agentId);
  if (!agent) { clearTarget(); return; }

  // Toggle off if same agent clicked again
  if (_targetAgent?.id === agentId) { clearTarget(); return; }

  _targetAgent = { id: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color };

  // Update input placeholder
  const input = document.getElementById('co-counter-input');
  if (input) input.placeholder = `${agent.emoji} ${agent.name}에게 지시...`;

  // Update target indicator in chat header
  const indicator = document.getElementById('co-target-indicator');
  if (indicator) indicator.innerHTML = `<span class="co-target-emoji">${agent.emoji}</span><span class="co-target-name" style="color:${agent.color}">${esc(agent.name)}</span>`;

  // Highlight sprite
  document.querySelectorAll('.co-sprite.targeted').forEach(el => el.classList.remove('targeted'));
  const sprite = document.getElementById(`ag-${agentId}`);
  if (sprite) sprite.classList.add('targeted');

  // Update send button
  const btn = document.querySelector('.co-chat-send');
  if (btn) btn.textContent = `${agent.emoji} 전송`;

  input?.focus();
}

function clearTarget() {
  _targetAgent = null;
  const input = document.getElementById('co-counter-input');
  if (input) input.placeholder = '업무를 지시하세요... (자동 배정)';
  document.querySelectorAll('.co-sprite.targeted').forEach(el => el.classList.remove('targeted'));
  const btn = document.querySelector('.co-chat-send');
  if (btn) btn.textContent = '전송';
  const indicator = document.getElementById('co-target-indicator');
  if (indicator) indicator.innerHTML = '';
}

// ─── Task Chat ───
async function submitTask() {
  const input = document.getElementById('co-counter-input');
  if (!input) return;
  const msg = input.value.trim(); if (!msg) return;
  input.value = '';
  const agentId = _targetAgent?.id || 'auto';
  const projSelect = document.getElementById('co-project-select');
  const projectId = projSelect?.value || null;
  clearTarget();
  const task = { id: `t-${Date.now()}`, message: msg, status: 'routing', team: null, agent: null, emoji: null, color: null, result: null, ts: Date.now() };
  _tasks.unshift(task); renderTasks();
  try {
    const conv = await postJson('/api/agent/conversations', {});
    task.convId = conv.id;
    const payload = { convId: conv.id, message: msg, agentId };
    if (projectId) payload.projectId = projectId;
    await postJson('/api/agent/chat', payload);
    task.status = 'assigned'; renderTasks();
  } catch (e) { task.status = 'error'; task.result = e.message; renderTasks(); }
}

function renderTasks() {
  const el = document.getElementById('co-counter-log');
  if (!el) return;
  if (!_tasks.length) {
    el.innerHTML = `<div class="co-chat-empty">
      <div class="co-chat-empty-icon">💬</div>
      <div class="co-chat-empty-title">업무를 지시하세요</div>
      <div class="co-chat-empty-desc">에이전트를 클릭해서 직접 지시하거나<br>아래 입력창에 업무를 입력하면 자동 배정됩니다</div>
      <div class="co-chat-empty-examples">
        <span data-action="co-quick-msg" data-msg="오늘 커밋 내용 요약해줘">📝 커밋 요약</span>
        <span data-action="co-quick-msg" data-msg="프로젝트 전체 현황 브리핑해줘">📊 현황 브리핑</span>
        <span data-action="co-quick-msg" data-msg="오늘 날씨 알려줘">🌤️ 날씨</span>
      </div>
    </div>`;
    return;
  }
  el.innerHTML = _tasks.slice(0, 20).map(t => {
    const time = new Date(t.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const isMe = !t.agent;
    if (isMe || t.status === 'routing') {
      return `<div class="co-msg co-msg-me">
        <div class="co-msg-bubble">${esc(t.message)}</div>
        <small class="co-msg-time">${time}</small>
      </div>`;
    }
    const statusCls = t.status === 'working' ? 'working' : t.status === 'done' ? 'done' : t.status === 'error' ? 'error' : '';
    const statusLabel = t.status === 'working' ? '작업 중...' : t.status === 'done' ? '완료' : t.status === 'error' ? '오류' : '배정 중';
    const teamInfo = t.team ? (TEAMS[t.team]?.name || '') : '';

    // Render result with markdown
    let resHtml = '';
    if (t.result) {
      const rendered = simpleMarkdown(t.result);
      const isLong = t.result.length > 300;
      resHtml = `<div class="co-msg-result${isLong ? ' collapsed' : ''}" data-task-id="${t.id}">
        <div class="co-msg-result-content">${rendered}</div>
      </div>
      ${isLong ? `<button class="co-msg-expand" data-action="co-toggle-msg" data-task-id="${t.id}">펼치기</button>` : ''}`;
    }

    // Working spinner
    const spinner = t.status === 'working' ? '<div class="co-msg-spinner"><span></span><span></span><span></span></div>' : '';

    return `<div class="co-msg co-msg-agent co-msg-${statusCls}">
      <div class="co-msg-avatar" style="background:${t.color || '#6366f1'}">${t.emoji || '?'}</div>
      <div class="co-msg-body">
        <div class="co-msg-head">
          <span class="co-msg-name" style="color:${t.color || '#888'}">${esc(t.agent || '배정 중')}</span>
          ${teamInfo ? `<span class="co-msg-team">${esc(teamInfo)}</span>` : ''}
          <span class="co-msg-status co-status-${statusCls}">${statusLabel}</span>
          <small class="co-msg-time">${time}</small>
        </div>
        <div class="co-msg-question">${esc(t.message)}</div>
        ${spinner}
        ${resHtml}
      </div>
    </div>`;
  }).reverse().join('');
  el.scrollTop = el.scrollHeight;
}

// ─── Proactive Alerts ───
const _alerts = [];
const LEVEL_ICON = { error: '!!', warning: '!', info: '~' };
const LEVEL_COLOR = { error: '#ef4444', warning: '#f59e0b', info: '#6366f1' };

async function loadAlerts() {
  try {
    const res = await fetchJson('/api/agent/alerts');
    const list = Array.isArray(res) ? res : res?.alerts || [];
    if (list.length) {
      _alerts.length = 0;
      _alerts.push(...list);
      renderAlerts();
    }
  } catch { /* no alerts */ }
}

function onAlert(d) {
  if (!d?.id) return;
  if (_alerts.find(a => a.id === d.id)) return;
  _alerts.unshift(d);
  if (_alerts.length > 20) _alerts.length = 20;
  renderAlerts();
  addFeed('agent:proactive', d);
}

function renderAlerts() {
  const el = document.getElementById('co-alerts');
  if (!el) return;
  if (!_alerts.length) { el.innerHTML = ''; return; }
  el.innerHTML = _alerts.slice(0, 8).map(a => {
    const icon = LEVEL_ICON[a.level] || '~';
    const col = LEVEL_COLOR[a.level] || '#6366f1';
    const time = new Date(a.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    return `<div class="co-alert co-alert-${a.level}" data-action="co-handle-alert" data-alert-id="${esc(a.id)}">
      <span class="co-alert-icon" style="color:${col}">${icon}</span>
      <div class="co-alert-body">
        <b class="co-alert-title">${esc(a.title)}</b>
        <span class="co-alert-detail">${esc((a.detail || '').slice(0, 120))}</span>
      </div>
      <span class="co-alert-action">${esc(a.suggestedAction?.slice(0, 40) || '')}</span>
      <small class="co-alert-time">${time}</small>
      <button class="co-alert-dismiss" data-action="co-dismiss-alert" data-alert-id="${esc(a.id)}">x</button>
    </div>`;
  }).join('');
}

async function handleAlert(alertId) {
  const a = _alerts.find(x => x.id === alertId);
  if (!a?.suggestedPrompt) return;
  const input = document.getElementById('co-counter-input');
  if (input) { input.value = a.suggestedPrompt; submitTask(); }
}

async function dismissAlert(alertId) {
  _alerts.splice(_alerts.findIndex(a => a.id === alertId), 1);
  renderAlerts();
  try { await postJson('/api/agent/alerts/dismiss', { alertId }); } catch { /* request failed */ }
}

// ─── Org Map Popup ───
function showOrgMap() {
  document.getElementById('co-orgmap-overlay')?.remove();

  const agents = _data?.agents || [];
  const teamGroups = {};
  let ceo = null, intern = null;
  for (const a of agents) {
    if (a.rank === 'Director' || a.rank === 'CEO') { ceo = a; continue; }
    if (a.rank === 'Intern') { intern = a; continue; }
    if (a.team) (teamGroups[a.team] ??= []).push(a);
  }
  const ro = ['VP','Team Lead','Manager','Asst.Mgr','Staff'];

  // ── Tab 1: 조직도 (Org Chart) ──
  const agentCard = (a, size = '') => {
    const provLabel = a.provider === 'claude' ? 'C' : a.provider === 'gemini' ? 'G' : 'S';
    const provCls = a.provider === 'claude' ? '#a78bfa' : a.provider === 'gemini' ? '#4ade80' : '#64748b';
    return `<div class="co-org-card ${size}" style="--ac:${a.color}">
      <div class="co-org-card-face" style="background:${a.color}">${a.emoji}
        <span class="co-org-card-prov" style="background:${provCls}">${provLabel}</span>
      </div>
      <div class="co-org-card-info">
        <b>${esc(a.name)}</b>
        <small>${esc(RK[a.rank] || a.rank)}</small>
        <span class="co-org-card-model">${esc(a.model.split('/').pop().split('-').slice(0, 2).join('-'))}</span>
      </div>
    </div>`;
  };

  let orgH = '<div class="co-org-chart">';

  // CEO row — the user
  if (ceo) {
    const uName = getUserName() || 'CEO';
    orgH += `<div class="co-org-tier co-org-ceo">
      <div class="co-org-card lg co-org-card-me" style="--ac:#ef4444">
        <div class="co-org-card-face" style="background:linear-gradient(135deg,#ef4444,#b91c1c)">👤</div>
        <div class="co-org-card-info">
          <b>${esc(uName)} <small style="color:#ef4444;opacity:.5">YOU</small></b>
          <small>대표</small>
          <span class="co-org-card-model">사용자</span>
        </div>
      </div>
    </div>`;
    orgH += `<div class="co-org-line-down"></div>`;
  }

  // Team leads row + vertical connector
  orgH += `<div class="co-org-line-h"></div>`;
  orgH += `<div class="co-org-tier co-org-leads">`;
  for (const tid of Object.keys(TEAMS)) {
    const members = teamGroups[tid] || [];
    members.sort((a, b) => ro.indexOf(a.rank) - ro.indexOf(b.rank));
    const lead = members.find(m => m.rank === 'VP' || m.rank === 'Team Lead');
    const tm = TEAMS[tid];
    if (lead) {
      orgH += `<div class="co-org-team-col" style="--tc:${tm.color}">
        <span class="co-org-team-label" style="color:${tm.color}">${tm.icon} ${esc(tm.name)}</span>
        ${agentCard(lead)}
        <div class="co-org-line-down-sm"></div>
        <div class="co-org-members">`;
      for (const m of members) {
        if (m.id === lead.id) continue;
        orgH += agentCard(m, 'sm');
      }
      orgH += `</div></div>`;
    }
  }
  orgH += `</div>`; // .co-org-leads

  // Bottom row: special agents
  orgH += `<div class="co-org-line-h" style="margin-top:16px"></div>`;
  orgH += `<div class="co-org-tier co-org-special">`;
  // Monitor
  orgH += `<div class="co-org-team-col" style="--tc:#64748b">
    <span class="co-org-team-label" style="color:#64748b">🛡 감시팀</span>
    <div class="co-org-card sm" style="--ac:#64748b">
      <div class="co-org-card-face" style="background:#475569">🛡<span class="co-org-card-prov" style="background:#334155">S</span></div>
      <div class="co-org-card-info"><b>모니터</b><small>자동 감시</small><span class="co-org-card-model">scanner</span></div>
    </div>
  </div>`;
  // Intern
  if (intern) {
    orgH += `<div class="co-org-team-col" style="--tc:#94a3b8">
      <span class="co-org-team-label" style="color:#94a3b8">🧹 인턴석</span>
      ${agentCard(intern, 'sm')}
    </div>`;
  }
  orgH += `</div>`; // .co-org-special

  // Relationship arrows description
  orgH += `<div class="co-org-relations">
    <div class="co-org-rel-title">보고/위임 관계</div>
    <div class="co-org-rel-items">
      <span class="co-org-rel">대표 (YOU) ← 업무 지시, 전체 총괄. 치명적 이슈는 콕핏이사가 처리</span>
      <span class="co-org-rel">김부장 ← 개발팀 오케스트레이터, DELEGATE 허브</span>
      <span class="co-org-rel">팀장급 ← 각 팀 실무 총괄, 팀원 작업 결과 대표에게 보고</span>
      <span class="co-org-rel">사원/대리급 → 팀장에게 보고, 단순 작업 수행</span>
      <span class="co-org-rel">DELEGATE → 팀 간 협업 시 에이전트가 타 팀에 위임</span>
      <span class="co-org-rel">모니터 → 전 시스템 감시, 이상 감지 시 대표에게 알림</span>
    </div>
  </div>`;

  orgH += '</div>'; // .co-org-chart

  // ── Tab 2: 도구 관계 (Tool Matrix) ──
  const allAgents = [];
  if (ceo) allAgents.push(ceo);
  for (const tid of Object.keys(TEAMS)) {
    const members = teamGroups[tid] || [];
    members.sort((a, b) => ro.indexOf(a.rank) - ro.indexOf(b.rank));
    allAgents.push(...members);
  }
  if (intern) allAgents.push(intern);
  allAgents.push({ id: 'monitor', name: '모니터', emoji: '🛡', color: '#64748b', rank: 'Staff', team: 'monitor', provider: 'system', model: 'scanner' });

  let tableH = `<div class="co-orgmap-tools"><table class="co-orgmap-table">
    <thead><tr><th class="co-orgmap-agent-col">에이전트</th>`;
  for (const t of ALL_TOOLS) {
    tableH += `<th class="co-orgmap-tool-col" title="${t}">${TOOL_ICONS[t]}</th>`;
  }
  tableH += `</tr></thead><tbody>`;
  for (const a of allAgents) {
    const tm = a.id === 'monitor'
      ? { primary: ['COCKPIT'], secondary: ['BASH'] }
      : TOOL_MAP[a.id] || { primary: [], secondary: [] };
    tableH += `<tr><td class="co-orgmap-agent">
        <span class="co-orgmap-emoji" style="background:${a.color}">${a.emoji}</span>
        <span class="co-orgmap-name">${esc(a.name)}</span>
        <span class="co-orgmap-rank">${esc(RK[a.rank] || a.rank)}</span>
      </td>`;
    for (const t of ALL_TOOLS) {
      const isPrimary = tm.primary.includes(t);
      const isSecondary = tm.secondary.includes(t);
      const cls = isPrimary ? 'co-orgmap-primary' : isSecondary ? 'co-orgmap-secondary' : '';
      const symbol = isPrimary ? '●' : isSecondary ? '○' : '';
      tableH += `<td class="co-orgmap-cell ${cls}" style="${isPrimary ? `color:${a.color}` : ''}">${symbol}</td>`;
    }
    tableH += `</tr>`;
  }
  tableH += `</tbody></table>
  <div class="co-orgmap-legend">
    <span><b style="color:#22c55e">●</b> 주력 도구</span>
    <span><b style="color:#6b7280">○</b> 보조 사용</span>
    <span style="opacity:.5">전원 모든 도구 사용 가능 (소프트 가이드)</span>
  </div></div>`;

  // ── Assemble popup ──
  const overlay = document.createElement('div');
  overlay.id = 'co-orgmap-overlay';
  overlay.className = 'co-orgmap-overlay';
  overlay.innerHTML = `
    <div class="co-orgmap-popup">
      <div class="co-orgmap-header">
        <div class="co-orgmap-tabs">
          <button class="co-orgmap-tab active" data-action="co-orgmap-tab" data-tab="org">조직도</button>
          <button class="co-orgmap-tab" data-action="co-orgmap-tab" data-tab="tools">도구 관계</button>
        </div>
        <button class="co-orgmap-close" data-action="co-close-orgmap">&times;</button>
      </div>
      <div class="co-orgmap-body">
        <div class="co-orgmap-pane active" data-pane="org">${orgH}</div>
        <div class="co-orgmap-pane" data-pane="tools">${tableH}</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ═══════════════════════════════════════════════════════
// Workspace Panel — team zone click → mini dashboard
// ═══════════════════════════════════════════════════════

let _activeWorkspace = null;

// Zone → workspace type mapping
const ZONE_WORKSPACE = {
  exec:      { type: 'exec',      title: '대표실',   icon: '🏢', fetch: wsExec },
  dev:       { type: 'dev',       title: '개발팀',   icon: '💻', fetch: wsDev },
  plan:      { type: 'plan',      title: '기획팀',   icon: '📋', fetch: wsPlan },
  design:    { type: 'design',    title: '디자인팀', icon: '🎨', fetch: wsDesign },
  admin:     { type: 'admin',     title: '경영지원', icon: '💰', fetch: wsAdmin },
  marketing: { type: 'marketing', title: '마케팅팀', icon: '📢', fetch: wsMarketing },
  monitor:   { type: 'monitor',   title: '감시팀',   icon: '🛡', fetch: wsMonitor },
  intern:    { type: 'intern',    title: '인턴석',   icon: '🧹', fetch: wsIntern },
};

async function openWorkspace(zoneId) {
  const ws = ZONE_WORKSPACE[zoneId];
  if (!ws) return;
  const panel = document.getElementById('co-workspace');
  if (!panel) return;

  // Toggle off if same zone clicked again
  if (_activeWorkspace === zoneId) {
    panel.innerHTML = '';
    panel.classList.remove('open');
    _activeWorkspace = null;
    // Remove highlight from zones
    document.querySelectorAll('.co-zone').forEach(z => z.classList.remove('ws-active'));
    return;
  }

  _activeWorkspace = zoneId;
  // Highlight active zone
  document.querySelectorAll('.co-zone').forEach(z =>
    z.classList.toggle('ws-active', z.dataset.zone === zoneId)
  );

  // Loading state
  panel.innerHTML = `<div class="ws-panel"><div class="ws-header"><span class="ws-title">${ws.icon} ${ws.title}</span><button class="ws-close" data-action="co-close-workspace">&times;</button></div><div class="ws-body ws-loading">불러오는 중...</div></div>`;
  panel.classList.add('open');

  // Fetch data and render
  try {
    const content = await ws.fetch();
    const body = panel.querySelector('.ws-body');
    if (body && _activeWorkspace === zoneId) {
      body.className = 'ws-body';
      body.innerHTML = content;
    }
  } catch (err) {
    const body = panel.querySelector('.ws-body');
    if (body) body.innerHTML = `<div class="ws-error">데이터 로드 실패: ${esc(err.message)}</div>`;
  }
}

function closeWorkspace() {
  const panel = document.getElementById('co-workspace');
  if (panel) { panel.innerHTML = ''; panel.classList.remove('open'); }
  _activeWorkspace = null;
  document.querySelectorAll('.co-zone').forEach(z => z.classList.remove('ws-active'));
}

// ─── Exec (대표실): 프로젝트 현황 + 터미널 리스트 ───
async function wsExec() {
  const [projects, health] = await Promise.all([
    fetchJson('/api/projects').catch(() => []),
    fetchJson('/api/health').catch(() => ({})),
  ]);
  let h = '<div class="ws-grid">';

  // System info
  h += `<div class="ws-card">
    <div class="ws-card-title">시스템</div>
    <div class="ws-kv"><span>Uptime</span><span>${Math.floor((health.uptime||0)/60)}분</span></div>
    <div class="ws-kv"><span>메모리</span><span>${health.memory||0}MB</span></div>
    <div class="ws-kv"><span>프로젝트</span><span>${health.projects||0}개</span></div>
    <div class="ws-kv"><span>터미널</span><span>${health.terminals||0}개</span></div>
  </div>`;

  // Projects summary
  h += `<div class="ws-card ws-card-wide">
    <div class="ws-card-title">프로젝트 (${projects.length})</div>
    <div class="ws-proj-list">`;
  for (const p of projects.slice(0, 8)) {
    const color = p.color || '#6366f1';
    h += `<div class="ws-proj-item">
      <span class="ws-proj-dot" style="background:${color}"></span>
      <span class="ws-proj-name">${esc(p.name)}</span>
      <span class="ws-proj-stack">${esc(p.stack || '')}</span>
    </div>`;
  }
  if (projects.length > 8) h += `<div class="ws-more">+${projects.length - 8}개 더</div>`;
  h += '</div></div>';
  h += '</div>';
  return h;
}

// ─── Dev (개발팀): 최근 커밋 + 변경사항 ───
async function wsDev() {
  const projects = await fetchJson('/api/projects').catch(() => []);
  let h = '<div class="ws-grid">';
  let hasCard = false;

  for (const p of projects.slice(0, 4)) {
    try {
      const diff = await fetchJson(`/api/projects/${p.id}/diff`).catch(() => null);
      if (!diff) continue;
      const all = [...(diff.stagedFiles || []), ...(diff.unstagedFiles || [])];
      const ins = all.reduce((s, f) => s + (f.additions || 0), 0);
      const del = all.reduce((s, f) => s + (f.deletions || 0), 0);
      hasCard = true;
      h += `<div class="ws-card">
        <div class="ws-card-title">${esc(p.name)}</div>
        <div class="ws-code-stats">
          <span class="ws-stat-add">+${ins}</span>
          <span class="ws-stat-del">-${del}</span>
          <span class="ws-stat-files">${all.length} files</span>
        </div>
        <div class="ws-branch">${esc(diff.branch || 'main')}</div>
      </div>`;
    } catch { /* skip */ }
  }

  if (!hasCard) {
    h += '<div class="ws-card"><div class="ws-card-title">Git</div><div class="ws-empty">프로젝트 없음</div></div>';
  }
  h += '</div>';
  return h;
}

// ─── Plan (기획팀): 노트/문서 리스트 ───
async function wsPlan() {
  const notes = await fetchJson('/api/notes').catch(() => []);
  let h = '<div class="ws-doc-list">';
  h += `<div class="ws-card-title">문서 (${notes.length})</div>`;
  if (!notes.length) {
    h += '<div class="ws-empty">문서 없음. 에이전트에게 문서 작성을 요청하세요.</div>';
  }
  for (const n of notes.slice(0, 12)) {
    const date = n.modified ? new Date(n.modified).toLocaleDateString('ko') : '';
    h += `<div class="ws-doc-item">
      <span class="ws-doc-icon">📄</span>
      <span class="ws-doc-name">${esc(n.title || n.name || n.id)}</span>
      <span class="ws-doc-date">${date}</span>
    </div>`;
  }
  if (notes.length > 12) h += `<div class="ws-more">+${notes.length - 12}개 더</div>`;
  h += '</div>';
  return h;
}

// ─── Design (디자인팀): 실시간 테마 변수 + 컴포넌트 현황 ───
async function wsDesign() {
  // Extract live CSS variables
  const cs = getComputedStyle(document.documentElement);
  const vars = ['--accent','--bg-0','--bg-1','--text-0','--text-1','--green','--red','--yellow','--blue'];
  const colors = vars.map(v => ({ name: v.replace('--',''), val: cs.getPropertyValue(v).trim() })).filter(c => c.val);

  // Count views and components
  const viewCount = document.querySelectorAll('.view').length;
  const tabCount = document.querySelectorAll('.nav-tab').length;

  // Recently modified design files from diff
  let recentFiles = [];
  try {
    const projects = await fetchJson('/api/projects').catch(() => []);
    for (const p of projects.slice(0, 3)) {
      const diff = await fetchJson(`/api/projects/${p.id}/diff`).catch(() => null);
      if (!diff) continue;
      const all = [...(diff.stagedFiles || []), ...(diff.unstagedFiles || [])];
      recentFiles.push(...all.filter(f => /\.(css|scss|html|svg)$/i.test(f.path)).map(f => ({ name: f.path.split('/').pop(), proj: p.name })));
    }
  } catch { /* skip */ }

  let h = '<div class="ws-grid">';
  h += `<div class="ws-card"><div class="ws-card-title">라이브 테마</div>
    <div class="ws-design-palette">${colors.slice(0, 8).map(c => `<div class="ws-color-chip" style="background:${c.val}" title="${c.name}: ${c.val}"></div>`).join('')}</div>
    <div class="ws-kv"><span>폰트</span><span>${cs.getPropertyValue('--font').trim().split(',')[0] || 'Inter'}</span></div>
    <div class="ws-kv"><span>radius</span><span>${cs.getPropertyValue('--radius').trim() || '10px'}</span></div>
  </div>`;
  h += `<div class="ws-card"><div class="ws-card-title">컴포넌트</div>
    <div class="ws-kv"><span>뷰</span><span>${viewCount}개</span></div>
    <div class="ws-kv"><span>탭</span><span>${tabCount}개</span></div>
    <div class="ws-kv"><span>모달</span><span>${document.querySelectorAll('dialog').length}개</span></div>
  </div>`;
  if (recentFiles.length) {
    h += `<div class="ws-card ws-card-wide"><div class="ws-card-title">최근 수정된 디자인 파일</div><div class="ws-doc-list">`;
    for (const f of recentFiles.slice(0, 6)) {
      h += `<div class="ws-doc-item"><span class="ws-doc-icon">🎨</span><span class="ws-doc-name">${esc(f.name)}</span><span class="ws-doc-date">${esc(f.proj)}</span></div>`;
    }
    h += '</div></div>';
  }
  h += '</div>';
  return h;
}

// ─── Admin (경영지원): Jira 미니 보드 ───
async function wsAdmin() {
  let h = '<div class="ws-grid">';
  try {
    const issues = await fetchJson('/api/jira/issues?maxResults=10').catch(() => null);
    if (issues?.issues?.length) {
      h += `<div class="ws-card ws-card-wide"><div class="ws-card-title">Jira 이슈 (최근 ${issues.issues.length})</div>`;
      h += '<div class="ws-jira-list">';
      for (const iss of issues.issues) {
        const status = iss.fields?.status?.name || '';
        const statusCls = status.includes('Done') || status.includes('완료') ? 'done' : status.includes('Progress') || status.includes('진행') ? 'progress' : 'todo';
        h += `<div class="ws-jira-item">
          <span class="ws-jira-key">${esc(iss.key)}</span>
          <span class="ws-jira-summary">${esc((iss.fields?.summary || '').slice(0, 40))}</span>
          <span class="ws-jira-status ws-jira-${statusCls}">${esc(status)}</span>
        </div>`;
      }
      h += '</div></div>';
    } else {
      h += '<div class="ws-card"><div class="ws-card-title">Jira</div><div class="ws-empty">Jira 미연결 또는 이슈 없음</div></div>';
    }
  } catch {
    h += '<div class="ws-card"><div class="ws-card-title">Jira</div><div class="ws-empty">Jira 연결 안 됨</div></div>';
  }

  // Cost info
  try {
    const cost = await fetchJson('/api/cost/daily').catch(() => null);
    if (cost) {
      h += `<div class="ws-card"><div class="ws-card-title">비용</div>
        <div class="ws-kv"><span>오늘</span><span>$${(cost.todayCost ?? cost.today ?? 0).toFixed(2)}</span></div>
        <div class="ws-kv"><span>세션</span><span>${cost.sessionCount ?? 0}개</span></div>
        <div class="ws-kv"><span>토큰</span><span>${((cost.totalTokens ?? cost.tokens ?? 0) / 1000).toFixed(0)}K</span></div>
      </div>`;
    }
  } catch { /* skip */ }
  h += '</div>';
  return h;
}

// ─── Marketing (마케팅팀): 노트/콘텐츠 + 퀵액션 ───
async function wsMarketing() {
  const notes = await fetchJson('/api/notes').catch(() => []);
  let h = '<div class="ws-grid">';
  h += `<div class="ws-card"><div class="ws-card-title">콘텐츠 (${notes.length})</div>`;
  if (notes.length) {
    h += '<div class="ws-doc-list">';
    for (const n of notes.slice(0, 5)) {
      const date = n.modified ? new Date(n.modified).toLocaleDateString('ko') : '';
      h += `<div class="ws-doc-item"><span class="ws-doc-icon">📝</span><span class="ws-doc-name">${esc(n.title || n.name || n.id)}</span><span class="ws-doc-date">${date}</span></div>`;
    }
    h += '</div>';
  } else {
    h += '<div class="ws-empty">작성된 문서 없음</div>';
  }
  h += '</div>';
  h += `<div class="ws-card"><div class="ws-card-title">빠른 지시</div>
    <div class="ws-doc-list">
      <div class="ws-doc-item" style="cursor:pointer" data-action="co-quick-msg" data-msg="이번 주 주요 변경사항 요약 리포트 작성해줘"><span class="ws-doc-icon">📊</span><span class="ws-doc-name">주간 리포트 생성</span></div>
      <div class="ws-doc-item" style="cursor:pointer" data-action="co-quick-msg" data-msg="프로젝트별 README 현황 체크해줘"><span class="ws-doc-icon">📋</span><span class="ws-doc-name">README 현황 체크</span></div>
      <div class="ws-doc-item" style="cursor:pointer" data-action="co-quick-msg" data-msg="최근 커밋 기반으로 릴리스 노트 초안 만들어줘"><span class="ws-doc-icon">🚀</span><span class="ws-doc-name">릴리스 노트 초안</span></div>
    </div>
  </div>`;
  h += '</div>';
  return h;
}

// ─── Monitor (감시팀): 시스템 모니터링 + 포트/CI ───
async function wsMonitor() {
  const [health, ports] = await Promise.all([
    fetchJson('/api/health').catch(() => ({})),
    fetchJson('/api/ports').catch(() => []),
  ]);
  const activePorts = Array.isArray(ports) ? ports.filter(p => p.pid).length : 0;
  const uptimeH = Math.floor((health.uptime || 0) / 3600);
  const uptimeM = Math.floor(((health.uptime || 0) % 3600) / 60);

  let h = '<div class="ws-grid">';
  h += `<div class="ws-card"><div class="ws-card-title">시스템 상태</div>
    <div class="ws-kv"><span>서버</span><span style="color:#22c55e">● 정상</span></div>
    <div class="ws-kv"><span>Uptime</span><span>${uptimeH ? uptimeH + '시간 ' : ''}${uptimeM}분</span></div>
    <div class="ws-kv"><span>메모리</span><span>${health.memory || 0}MB</span></div>
    <div class="ws-kv"><span>SSE</span><span>${health.sseClients || 0} clients</span></div>
    <div class="ws-kv"><span>터미널</span><span>${health.terminals || 0}개</span></div>
    <div class="ws-kv"><span>활성 포트</span><span>${activePorts}개</span></div>
  </div>`;

  // Alerts
  if (_alerts.length) {
    h += `<div class="ws-card"><div class="ws-card-title">감지 알림 (${_alerts.length})</div>`;
    for (const a of _alerts.slice(0, 5)) {
      h += `<div class="ws-alert-item ws-alert-${a.level}">${esc(a.title)}</div>`;
    }
    h += '</div>';
  }

  // Recent reports
  const recentReports = _reportList.filter(r => !r.dismissed).slice(0, 3);
  if (recentReports.length) {
    h += `<div class="ws-card ws-card-wide"><div class="ws-card-title">최근 리뷰 (${recentReports.length})</div>`;
    for (const r of recentReports) {
      const time = new Date(r.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      h += `<div class="ws-doc-item"><span class="ws-doc-icon">${r.agentEmoji || '📄'}</span><span class="ws-doc-name">${esc(r.title || r.type)}</span><span class="ws-doc-date">${time}</span></div>`;
    }
    h += '</div>';
  }
  h += '</div>';
  return h;
}

// ─── Intern (인턴석) ───
async function wsIntern() {
  // Show recent tasks assigned to intern
  const internTasks = _tasks.filter(t => t.agent && (t.agent.includes('막내') || t.agent.includes('인턴'))).slice(0, 5);
  let h = '<div class="ws-grid">';
  if (internTasks.length) {
    h += `<div class="ws-card"><div class="ws-card-title">최근 작업 (${internTasks.length})</div><div class="ws-doc-list">`;
    for (const t of internTasks) {
      const icon = t.status === 'done' ? '✅' : t.status === 'working' ? '🔄' : '⏳';
      h += `<div class="ws-doc-item"><span class="ws-doc-icon">${icon}</span><span class="ws-doc-name">${esc(t.message.slice(0, 40))}</span></div>`;
    }
    h += '</div></div>';
  }
  h += `<div class="ws-card"><div class="ws-card-title">빠른 지시</div>
    <div class="ws-doc-list">
      <div class="ws-doc-item" style="cursor:pointer" data-action="co-quick-msg" data-msg="오늘 날씨 알려줘"><span class="ws-doc-icon">🌤️</span><span class="ws-doc-name">날씨 확인</span></div>
      <div class="ws-doc-item" style="cursor:pointer" data-action="co-quick-msg" data-msg="현재 시스템 상태 체크해줘"><span class="ws-doc-icon">🔍</span><span class="ws-doc-name">시스템 체크</span></div>
      <div class="ws-doc-item" style="cursor:pointer" data-action="co-quick-msg" data-msg="열려있는 포트 목록 확인해줘"><span class="ws-doc-icon">🔌</span><span class="ws-doc-name">포트 스캔</span></div>
    </div>
  </div>`;
  h += '</div>';
  return h;
}

// ═══════════════════════════════════════════════════════
// Reports Panel — Agent review results & monitor reports
// ═══════════════════════════════════════════════════════

const _reportList = [];
const _pendingReviews = new Map(); // convId → { agentId, type, projectName, ts }

async function loadReports() {
  try {
    const reports = await fetchJson('/api/agent/reports');
    if (Array.isArray(reports) && reports.length) {
      _reportList.length = 0;
      _reportList.push(...reports);
      renderReports();
    }
  } catch { /* no reports */ }
}

function onMonitorReviewStart(d) {
  if (!d?.convId) return;
  _pendingReviews.set(d.convId, { agentId: d.agentId, type: d.type, projectName: d.projectName, ts: Date.now() });
}

function onMonitorReport(d) {
  if (!d?.id) return;
  if (_reportList.find(r => r.id === d.id)) return;
  _reportList.unshift(d);
  if (_reportList.length > 30) _reportList.length = 30;
  renderReports();
}

function onEv_captureReport(ev, d) {
  // Capture agent:response from monitor-triggered reviews
  if (ev !== 'agent:response' || !d?.convId || !d?.content) return;
  const pending = _pendingReviews.get(d.convId);
  if (!pending) return;
  _pendingReviews.delete(d.convId);

  const agent = _data?.agents?.find(a => a.id === pending.agentId || a.id === d.agentId);
  const report = {
    id: `report-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    type: pending.type || 'review',
    agentId: d.agentId || pending.agentId,
    agentName: d.agentName || agent?.name || '',
    agentEmoji: agent?.emoji || '',
    agentColor: d.agentColor || agent?.color || '#6366f1',
    team: agent?.team || null,
    projectName: pending.projectName || '',
    title: pending.type === 'commit-review' ? '커밋 리뷰' : pending.type === 'diff-review' ? '코드 리뷰' : '리뷰',
    content: d.content,
    timestamp: Date.now(),
    dismissed: false,
  };
  _reportList.unshift(report);
  if (_reportList.length > 30) _reportList.length = 30;
  renderReports();
  addFeed('agent:proactive', { ...d, title: report.title });
}

function renderReports() {
  const el = document.getElementById('co-reports');
  if (!el) return;
  const visible = _reportList.filter(r => !r.dismissed);
  if (!visible.length) { el.innerHTML = ''; return; }

  el.innerHTML = visible.slice(0, 10).map(r => {
    const time = new Date(r.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const typeLabel = { 'commit-review': '커밋 리뷰', 'diff-review': '코드 리뷰', 'review': '리뷰' }[r.type] || r.title || '보고서';
    const teamColor = r.agentColor || '#6366f1';
    const rendered = simpleMarkdown(r.content || '');
    return `<div class="co-report" data-report-id="${esc(r.id)}">
      <div class="co-report-header">
        <span class="co-report-avatar" style="background:${teamColor}">${r.agentEmoji || '?'}</span>
        <div class="co-report-meta">
          <b style="color:${teamColor}">${esc(r.agentName || r.agentId)}</b>
          <span class="co-report-type">${esc(typeLabel)}</span>
          ${r.projectName ? `<span class="co-report-proj">${esc(r.projectName)}</span>` : ''}
        </div>
        <small class="co-report-time">${time}</small>
        <button class="co-report-dismiss" data-action="co-dismiss-report" data-report-id="${esc(r.id)}">x</button>
        <button class="co-report-toggle" data-action="co-toggle-report" data-report-id="${esc(r.id)}">▼</button>
      </div>
      <div class="co-report-body collapsed">${rendered}</div>
    </div>`;
  }).join('');
}

function toggleReport(reportId) {
  const card = document.querySelector(`.co-report[data-report-id="${reportId}"]`);
  if (!card) return;
  const body = card.querySelector('.co-report-body');
  if (body) body.classList.toggle('collapsed');
  const toggle = card.querySelector('.co-report-toggle');
  if (toggle) toggle.textContent = body?.classList.contains('collapsed') ? '▼' : '▲';
}

async function dismissReport(reportId) {
  const idx = _reportList.findIndex(r => r.id === reportId);
  if (idx >= 0) _reportList[idx].dismissed = true;
  renderReports();
  try { await postJson('/api/agent/reports/dismiss', { reportId }); } catch { /* request failed */ }
}

// ══════════════════════════════════════════════════
// Sprint Mode — AutoBE-inspired React Dev Pipeline
// ══════════════════════════════════════════════════

let _sprintMode = false;
let _activeSprint = null;

function setSprintMode(enabled) {
  _sprintMode = enabled;
  const toggle = document.getElementById('co-mode-toggle');
  if (toggle) {
    toggle.querySelectorAll('.co-mode-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === (enabled ? 'sprint' : 'chat'))
    );
  }
  const projSelect = document.getElementById('co-project-select');
  if (projSelect) {
    // 프로젝트 선택은 항상 표시 (채팅/스프린트 모두 필요)
    projSelect.style.display = '';
    if (projSelect.options.length <= 1) loadProjectOptions();
  }
  const input = document.getElementById('co-counter-input');
  if (input) input.placeholder = enabled
    ? '구현할 작업을 입력하세요... (예: 다크모드 추가)'
    : '업무를 지시하세요... (자동 배정)';
}

async function loadProjectOptions() {
  const sel = document.getElementById('co-project-select');
  if (!sel) return;
  try {
    const projects = await fetchJson('/api/projects');
    sel.innerHTML = '<option value="">프로젝트 선택</option>' +
      projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  } catch { /* ok */ }
}

async function startSprintFromUI() {
  const input = document.getElementById('co-counter-input');
  const projSelect = document.getElementById('co-project-select');
  if (!input || !projSelect) return;
  const task = input.value.trim();
  const projectId = projSelect.value;
  if (!task) return;
  if (!projectId) { alert('프로젝트를 선택해주세요'); return; }
  input.value = '';

  try {
    const result = await postJson('/api/sprint/start', { projectId, task });
    _activeSprint = { sprintId: result.sprintId, branch: result.branch, task, projectId };
    showSprintPanel(task);
  } catch (err) {
    alert(`스프린트 시작 실패: ${err.message}`);
  }
}

function showSprintPanel(task) {
  const panel = document.getElementById('sprint-panel');
  if (!panel) return;
  panel.style.display = '';
  document.getElementById('sprint-title').textContent = `🏃 Sprint: ${task}`;
  document.getElementById('sprint-stop-btn').style.display = '';
  document.getElementById('sprint-diff-btn').style.display = 'none';
  renderSprintPhases(null);
  document.getElementById('sprint-log').innerHTML = '';
  document.getElementById('sprint-validation').innerHTML = '';
}

function renderSprintPhases(currentPhase) {
  const el = document.getElementById('sprint-phases');
  if (!el) return;
  const phases = [
    { id: 'planning', label: '📋 Planning', icon: '📋' },
    { id: 'implementing', label: '🔨 Implementing', icon: '🔨' },
    { id: 'validating', label: '✅ Validating', icon: '✅' },
    { id: 'reviewing', label: '👀 Reviewing', icon: '👀' },
    { id: 'finalizing', label: '🎉 Finalizing', icon: '🎉' },
  ];
  const phaseOrder = phases.map(p => p.id);
  const currentIdx = phaseOrder.indexOf(currentPhase);

  el.innerHTML = phases.map((p, i) => {
    let cls = 'sprint-phase';
    if (i < currentIdx) cls += ' done';
    else if (i === currentIdx) cls += ' active';
    return `<div class="${cls}"><span class="sprint-phase-icon">${p.icon}</span><span class="sprint-phase-label">${p.label}</span></div>`;
  }).join('<span class="sprint-phase-arrow">→</span>');
}

function addSprintLog(role, message) {
  const el = document.getElementById('sprint-log');
  if (!el) return;
  const roleEmojis = {
    dev_bujang: '🦊', dev_gwajang: '😎', dev_daeri: '🧐', dev_sawon: '🐣',
    dev_reviewer: '🔍', dev_security: '🛡️', system: '⚙️',
  };
  const roleNames = {
    dev_bujang: '김부장', dev_gwajang: '원과장', dev_daeri: '핏대리', dev_sawon: '콕사원',
    dev_reviewer: '이코드', dev_security: '방보안', system: '시스템',
  };
  const emoji = roleEmojis[role] || '🔧';
  const name = roleNames[role] || role;
  const line = document.createElement('div');
  line.className = 'sprint-log-entry';
  line.innerHTML = `<span class="sprint-log-role">${emoji} ${esc(name)}</span> <span class="sprint-log-msg">${esc(message)}</span>`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function updateSprintValidation(data) {
  const el = document.getElementById('sprint-validation');
  if (!el) return;
  const icon = data.passed ? '✅' : '❌';
  const label = data.label || data.command;
  const line = document.createElement('div');
  line.className = `sprint-validate-entry ${data.passed ? 'passed' : 'failed'}`;
  line.innerHTML = `${icon} ${esc(label)} <span class="sprint-validate-cycle">(cycle ${data.cycle})</span>`;
  el.appendChild(line);
}

// Sprint SSE event handlers
function onSprintEvent(ev, detail) {
  if (!detail || !_activeSprint) return;
  if (detail.sprintId !== _activeSprint.sprintId) return;

  switch (ev) {
    case 'sprint:phase':
      renderSprintPhases(detail.phase);
      // Pixel office: work/done animations for all 6 agents
      if (detail.phase === 'planning') { work('dev_sawon', '구조 스캔'); work('dev_bujang', '플래닝'); }
      else if (detail.phase === 'implementing') { done('dev_sawon'); done('dev_bujang'); work('dev_gwajang', '구현'); work('dev_daeri', '서브 구현'); }
      else if (detail.phase === 'validating') { done('dev_daeri'); work('dev_gwajang', '검증'); }
      else if (detail.phase === 'reviewing') { done('dev_gwajang'); work('dev_reviewer', '리뷰'); work('dev_security', '보안'); }
      else if (detail.phase === 'finalizing') { done('dev_reviewer'); done('dev_security'); work('dev_bujang', '최종검토'); }
      break;
    case 'sprint:agent':
      // Individual agent activity from sprint engine
      if (detail.agentId) work(detail.agentId, detail.action || '');
      break;
    case 'sprint:log':
      addSprintLog(detail.role, detail.message);
      break;
    case 'sprint:validate':
      updateSprintValidation(detail);
      break;
    case 'sprint:done':
      renderSprintPhases('done');
      addSprintLog('system', `✅ 스프린트 완료! Branch: ${detail.branch}`);
      if (detail.prUrl) addSprintLog('system', `PR: ${detail.prUrl}`);
      document.getElementById('sprint-stop-btn').style.display = 'none';
      document.getElementById('sprint-diff-btn').style.display = '';
      // All agents done
      ['dev_bujang', 'dev_gwajang', 'dev_daeri', 'dev_sawon', 'dev_reviewer', 'dev_security'].forEach(id => done(id));
      break;
    case 'sprint:error':
      addSprintLog('system', `❌ 에러: ${detail.error}`);
      document.getElementById('sprint-stop-btn').style.display = 'none';
      ['dev_bujang', 'dev_gwajang', 'dev_daeri', 'dev_sawon', 'dev_reviewer', 'dev_security'].forEach(id => done(id));
      break;
    case 'sprint:stopped':
      addSprintLog('system', '🛑 스프린트 중단됨');
      document.getElementById('sprint-stop-btn').style.display = 'none';
      ['dev_bujang', 'dev_gwajang', 'dev_daeri', 'dev_sawon', 'dev_reviewer', 'dev_security'].forEach(id => done(id));
      break;
  }
}

async function stopActiveSprint() {
  if (!_activeSprint) return;
  try {
    await postJson(`/api/sprint/stop/${_activeSprint.sprintId}`, {});
  } catch (err) {
    addSprintLog('system', `중단 실패: ${err.message}`);
  }
}

function closeSprintPanel() {
  const panel = document.getElementById('sprint-panel');
  if (panel) panel.style.display = 'none';
  _activeSprint = null;
}

registerClickActions({
  'co-submit-task': () => {
    if (_sprintMode) startSprintFromUI();
    else submitTask();
  },
  'company-call-agent': (el) => {
    document.getElementById('co-profile-pop')?.remove();
    targetAgent(el.dataset.agent);
  },
  'company-show-profile': (el) => showAgentProfile(el.dataset.agent),
  'co-change-name': () => showNameDialog(),
  'co-show-orgmap': showOrgMap,
  'co-close-orgmap': () => document.getElementById('co-orgmap-overlay')?.remove(),
  'co-open-workspace': (el) => openWorkspace(el.dataset.zone),
  'co-close-workspace': closeWorkspace,
  'co-orgmap-tab': (el) => {
    const tab = el.dataset.tab;
    const popup = el.closest('.co-orgmap-popup');
    if (!popup) return;
    popup.querySelectorAll('.co-orgmap-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    popup.querySelectorAll('.co-orgmap-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
  },
  'co-handle-alert': (el) => handleAlert(el.dataset.alertId),
  'co-dismiss-alert': (el) => { el.stopPropagation?.(); dismissAlert(el.dataset.alertId); },
  'co-quick-msg': (el) => {
    const input = document.getElementById('co-counter-input');
    if (input) { input.value = el.dataset.msg; submitTask(); }
  },
  'co-toggle-msg': (el) => {
    const id = el.dataset.taskId;
    const res = document.querySelector(`.co-msg-result[data-task-id="${id}"]`);
    if (res) { res.classList.toggle('collapsed'); el.textContent = res.classList.contains('collapsed') ? '펼치기' : '접기'; }
  },
  'co-toggle-report': (el) => toggleReport(el.dataset.reportId),
  'co-dismiss-report': (el) => { el.stopPropagation?.(); dismissReport(el.dataset.reportId); },
  'co-clear-chat': () => { _tasks.length = 0; renderTasks(); renderStatsBar(); },
  'co-mode-chat': () => setSprintMode(false),
  'co-mode-sprint': () => setSprintMode(true),
  'sprint-stop': stopActiveSprint,
  'sprint-close-panel': closeSprintPanel,
  'sprint-view-diff': () => {
    if (_activeSprint) window.open(`/api/sprint/diff/${_activeSprint.sprintId}`, '_blank');
  },
});
document.addEventListener('keydown', e => { if (e.target?.id === 'co-counter-input' && e.key === 'Enter') { e.preventDefault(); submitTask(); } });
