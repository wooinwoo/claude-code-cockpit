// ─── ⚔️ Arena: 열려있는 세션 2~3개를 골라 주제 하나로 턴제 토론시키는 관전 모드 ───
// 프론트 전용 — 서버 변경 없음. 스트림 스크래핑 대신 렌더된 화면(xterm 버퍼)을 읽어서
// busy 감지·발언 캡처를 함 (TUI가 커서 이동으로 그려도 화면 텍스트는 항상 정확).
import { app } from './state.js';
import { esc, showToast } from './utils.js';

const S = { running: false, stop: false };

// 작업 중일 때만 상태바에 떠 있는 문구 (claude·codex 공통)
const BUSY_RE = /esc to interrupt/i;
// 캡처에서 걷어낼 TUI 크롬
const CHROME_RE = /^\s*$|esc to interrupt|⏵⏵|^\s*[❯›✻✽✶✢·●○◐◑*↓↑]|^\s*[─│╭╮╰╯┌┐└┘⎿]|Tip:|tokens|auto mode|plan mode|for agents|Press up|shift\+tab|\/skills|\[듀얼\]/;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const wsSend = (termId, data) => { if (app.ws?.readyState === 1) app.ws.send(JSON.stringify({ type: 'input', termId, data })); };

// ── 백그라운드 탭 대응 ──
// 페이지 setTimeout 은 숨은 탭에서 분당 1회로 스로틀돼 심판 루프가 동결됨.
// Web Worker 타이머는 스로틀 면제라 워커 틱으로 대기한다.
let _ticker = null;
function tickSleep(ms = 1000) {
  if (!_ticker) {
    try {
      _ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(1), 1000)'], { type: 'text/javascript' })));
    } catch { _ticker = false; /* 워커 불가 환경 — setTimeout 폴백 */ }
  }
  if (!_ticker) return sleep(ms);
  return new Promise(res => {
    let n = Math.max(1, Math.round(ms / 1000));
    const h = () => { if (--n <= 0) { _ticker.removeEventListener('message', h); res(); } };
    _ticker.addEventListener('message', h);
  });
}

// 참가 세션의 출력 이벤트 시각 추적 (재전송 오발 방지: 출력이 흐르면 살아있는 것)
const lastOut = {};
const _hookedWs = new WeakSet();
function hookOutputTracking() {
  const ws = app.ws;
  if (!ws || _hookedWs.has(ws)) return;
  _hookedWs.add(ws);
  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') lastOut[msg.termId] = Date.now();
    } catch { /* not JSON */ }
  });
}

function screenLines(t, lastN = null) {
  const buf = t.xterm.buffer.active;
  const start = lastN ? Math.max(0, buf.length - lastN) : 0;
  const out = [];
  for (let i = start; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString() ?? '');
  return out;
}

function isBusy(t) {
  return screenLines(t, t.xterm.rows + 6).some(l => BUSY_RE.test(l));
}

// 프롬프트 보낸 시점 이후의 화면에서 발언 추출
function capture(t, fromLen) {
  const buf = t.xterm.buffer.active;
  const start = Math.max(0, Math.min(fromLen, buf.length) - 2);
  const lines = [];
  for (let i = start; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString() ?? '');
  let text = lines.map(l => l.trimEnd()).filter(l => l.trim() && !CHROME_RE.test(l)).join('\n');
  // 마커가 있으면 그 안쪽만 (프레임에서 ⟦BEGIN⟧/⟦END⟧ 지시)
  const m = [...text.matchAll(/⟦BEGIN⟧([\s\S]*?)⟦END⟧/g)];
  if (m.length) text = m[m.length - 1][1];
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text.length > 2500 ? '…' + text.slice(-2500) : text;
}

async function say(termId, text) {
  wsSend(termId, `\x1b[200~${text}\x1b[201~`);
  await tickSleep(1000);
  wsSend(termId, '\r');
}

// 턴 종료 대기: 작업 시작(busy) 확인 → busy 마커가 8초 연속 사라지면 종료
async function waitTurn(t, termId, lastText, statusPrefix = '') {
  const start = Date.now();
  let busySeen = false;
  let idleSince = null;
  let resent = false;
  hookOutputTracking();
  for (;;) {
    if (S.stop) throw new Error('중단됨');
    const busy = isBusy(t) || Date.now() - (lastOut[termId] || 0) < 3000; // 마커 or 출력 흐름
    // 타임아웃은 "신호 없는 교착"에만 — 실제 작업 중(busy)인 턴은 자르지 않는다
    // (증거 수집형 검증 턴은 10분을 훌쩍 넘길 수 있음). 절대 상한 30분.
    if (!busy && Date.now() - start > 10 * 60 * 1000) return;
    if (Date.now() - start > 30 * 60 * 1000) return;
    if (busy) { busySeen = true; idleSince = null; }
    else if (busySeen) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince > 8000) return;
    } else if (!resent && Date.now() - start > 40000 && Date.now() - (lastOut[termId] || 0) > 40000) {
      resent = true; // 40초간 마커도 출력도 전혀 없을 때만 제출 유실로 판단해 재전송
      await say(termId, lastText);
    }
    if (statusPrefix) {
      const el = Math.round((Date.now() - start) / 1000);
      setStatus(`${statusPrefix} · ${Math.floor(el / 60)}m ${el % 60}s${busySeen ? '' : ' (작업 시작 대기)'}`);
    }
    await tickSleep(1000);
  }
}

function setStatus(html) {
  const el = document.getElementById('arena-status');
  if (el) el.innerHTML = html;
}

// ── 관전 연출: 참가 패널 링 테두리 + 발언자 펄스 글로우 ──
function leafOf(termId) {
  return app.termMap.get(termId)?.element?.closest('.split-leaf') || null;
}
function paintFighters(termIds, speakingId) {
  // renderLayout 이 패널을 재생성해도 매 턴 다시 칠하므로 자가 복구됨
  document.querySelectorAll('.split-leaf.arena-fighter, .split-leaf.arena-speaking')
    .forEach(el => el.classList.remove('arena-fighter', 'arena-speaking'));
  for (const id of termIds) {
    const leaf = leafOf(id);
    if (leaf) leaf.classList.add(id === speakingId ? 'arena-speaking' : 'arena-fighter');
  }
}
function clearPaint() { paintFighters([], null); }

function resultMarkdown() {
  if (!S.lastResult) return '';
  const { topic, transcript, ts } = S.lastResult;
  return `# Arena 상호검증 기록\n\n- 주제: ${topic}\n- 일시: ${ts}\n\n` +
    transcript.map(({ turn, name, text }) => `## Turn ${turn} — ${name}\n\n${text}\n`).join('\n');
}

export function copyArenaResult() {
  import('./utils.js').then(({ copyText }) => copyText(resultMarkdown()).then(ok => showToast(ok ? '기록 복사됨' : '복사 실패', ok ? 'success' : 'error')));
}

export function downloadArenaResult() {
  const blob = new Blob([resultMarkdown()], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `arena-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function showResultDialog(topic, transcript, aborted) {
  ensureDialogs();
  S.lastResult = { topic, transcript, ts: new Date().toLocaleString() };
  const meta = document.getElementById('arena-result-meta');
  const log = document.getElementById('arena-result-log');
  if (!meta || !log) return;
  meta.innerHTML = `<b>주제</b> — ${esc(topic)}${aborted ? ' <span style="color:var(--yellow)">(중단됨)</span>' : ''}`;
  log.innerHTML = transcript.map(({ turn, name, text, stance }) => {
    const badge = stance === 'AGREE' ? ' <span class="arena-stance agree">🤝 AGREE</span>'
      : stance === 'CONTINUE' ? ' <span class="arena-stance">↩ CONTINUE</span>' : '';
    return `<div class="arena-log-turn"><div class="arena-log-head">Turn ${turn} — ${esc(name)}${badge}</div>` +
      `<div class="arena-log-body">${esc(text)}</div></div>`;
  }).join('') || '<div style="color:var(--text-3)">기록 없음</div>';
  document.getElementById('arena-result-dialog')?.showModal();
}

// index.html은 서버가 메모리 캐시(fs.watch 무효화가 깨질 수 있음)라, UI는 여기서 런타임 주입
function ensureDialogs() {
  // 구버전 다이얼로그(고정 턴 select)가 index.html 캐시로 남아있으면 교체
  const oldDlg = document.getElementById('arena-dialog');
  if (oldDlg && !oldDlg.querySelector('#arena-turns-min')) oldDlg.remove();
  if (!document.getElementById('arena-dialog')) {
    document.body.insertAdjacentHTML('beforeend', `
    <dialog id="arena-dialog">
      <div class="modal-header">
        <h2>&#x2694;&#xFE0F; Arena — 세션끼리 토론</h2>
        <button class="modal-close" data-action="close-dialog" data-dialog="arena-dialog">&times;</button>
      </div>
      <div class="modal-body">
        <label>참가자 (2~3개 선택)</label>
        <div id="arena-participants" class="arena-participants"></div>
        <label>주제</label>
        <textarea id="arena-topic" rows="3" placeholder="예: 이 레포의 알림 시스템, 폴링 유지 vs MQ 전환 — 근거 들고 싸워봐"></textarea>
        <label>턴 범위 — 이 안에서 세션들이 스스로 계속/합의를 판단</label>
        <div class="arena-turn-range">
          <input type="number" id="arena-turns-min" value="4" min="2" max="30"> 턴 이상
          <span class="arena-vs">~</span>
          <input type="number" id="arena-turns-max" value="10" min="2" max="30"> 턴 이하
        </div>
        <div class="arena-hint">종료 조건: <b>전원 진심 합의(AGREE)</b>. 최대 턴까지 합의 못 보면 연장할지 물어봅니다.</div>
        <div class="arena-warn">&#x26A0;&#xFE0F; 참가 세션은 자기 권한 그대로 동작합니다 (토론만 하라고 지시하지만 강제는 아님). 각 세션의 기존 맥락 위에 토론이 쌓입니다.</div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="close-dialog" data-dialog="arena-dialog">취소</button>
        <button class="btn primary" data-action="arena-start">&#x2694;&#xFE0F; 개전</button>
      </div>
    </dialog>`);
  }
  if (!document.getElementById('arena-result-dialog')) {
    document.body.insertAdjacentHTML('beforeend', `
    <dialog id="arena-result-dialog">
      <div class="modal-header">
        <h2>&#x1F3C1; Arena 결과</h2>
        <button class="modal-close" data-action="close-dialog" data-dialog="arena-result-dialog">&times;</button>
      </div>
      <div class="modal-body">
        <div id="arena-result-meta" class="arena-result-meta"></div>
        <div id="arena-result-log" class="arena-result-log"></div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-action="arena-copy-result">&#x1F4CB; 복사</button>
        <button class="btn" data-action="arena-download-result">&#x2B07; .md 저장</button>
        <button class="btn primary" data-action="close-dialog" data-dialog="arena-result-dialog">닫기</button>
      </div>
    </dialog>`);
  }
  if (!document.getElementById('arena-indicator')) {
    document.getElementById('broadcast-indicator')?.insertAdjacentHTML('afterend',
      `<div class="arena-indicator" id="arena-indicator" style="display:none">
        <span id="arena-status">&#x2694;&#xFE0F; Arena</span>
        <button class="bc-close" data-action="arena-stop" title="중단/취소">&times;</button>
      </div>`);
  }
  if (!document.getElementById('arena-extend-dialog')) {
    document.body.insertAdjacentHTML('beforeend', `
    <dialog id="arena-extend-dialog">
      <div class="modal-header"><h2>&#x23F3; 합의 미성립 — 연장할까요?</h2></div>
      <div class="modal-body">
        <div class="arena-result-meta" id="arena-extend-reason"></div>
      </div>
      <div class="modal-footer">
        <button class="btn" id="arena-extend-end">여기서 정리</button>
        <button class="btn" id="arena-extend-2">+2턴</button>
        <button class="btn primary" id="arena-extend-4">+4턴</button>
      </div>
    </dialog>`);
  }
  // 개전 없이 다이얼로그만 닫으면 선발 링 원상복구
  const dlg = document.getElementById('arena-dialog');
  if (dlg && !dlg._arenaCloseHooked) {
    dlg._arenaCloseHooked = true;
    dlg.addEventListener('close', () => setTimeout(() => {
      if (!S.running) { clearPaint(); pick.ids = []; const ind = document.getElementById('arena-indicator'); if (ind) ind.style.display = 'none'; }
    }, 50));
  }
}

// ── 픽 모드: 패널을 직접 클릭해서 참가자 선발 (리스트 없음) ──
const pick = { on: false, ids: [] };

function pickClickHandler(e) {
  const leaf = e.target.closest('.split-leaf');
  if (!leaf) return; // 인디케이터 버튼 등은 그대로 통과
  e.preventDefault();
  e.stopPropagation();
  const id = leaf.dataset.termId;
  if (!id) return;
  const i = pick.ids.indexOf(id);
  if (i >= 0) { pick.ids.splice(i, 1); leaf.classList.remove('arena-fighter'); }
  else if (pick.ids.length >= 3) { showToast('최대 3개까지', 'warning'); return; }
  else { pick.ids.push(id); leaf.classList.add('arena-fighter'); }
  updatePickStatus();
}

function updatePickStatus() {
  const names = pick.ids.map(id => esc(app.termMap.get(id)?.label || id)).join(' <b>vs</b> ');
  setStatus(`⚔️ 참가 패널 클릭 (${pick.ids.length}/3)${names ? ' — ' + names : ''} ` +
    (pick.ids.length >= 2 ? `<button class="arena-go-btn" data-action="arena-pick-done">주제 입력 →</button>` : ''));
}

export function startArenaPick() {
  ensureDialogs();
  if (S.running) { showToast('이미 토론이 진행 중입니다', 'warning'); return; }
  if (pick.on) return;
  pick.on = true; pick.ids = [];
  clearPaint();
  document.addEventListener('click', pickClickHandler, true);
  const ind = document.getElementById('arena-indicator');
  if (ind) ind.style.display = 'flex';
  updatePickStatus();
  showToast('⚔️ 토론에 참가시킬 패널을 클릭하세요 (2~3개)', 'info', 4000);
}

export function endArenaPick(cancel = true) {
  pick.on = false;
  document.removeEventListener('click', pickClickHandler, true);
  const ind = document.getElementById('arena-indicator');
  if (ind && !S.running) ind.style.display = 'none';
  if (cancel) { clearPaint(); pick.ids = []; }
}

export function arenaPickDone() {
  if (pick.ids.length < 2) { showToast('참가자는 2~3개 선택', 'warning'); return; }
  document.removeEventListener('click', pickClickHandler, true);
  pick.on = false;
  openArenaDialog(pick.ids);
}

export function openArenaDialog(preIds = null) {
  ensureDialogs();
  const list = document.getElementById('arena-participants');
  if (!list) return;
  if (preIds?.length) {
    // 픽 모드에서 온 경우: 선택된 패널을 칩으로만 표시
    list.innerHTML = `<div class="arena-chips">` + preIds.map(id => {
      const t = app.termMap.get(id);
      return `<span class="arena-chip"><span class="arena-part-dot" style="background:${t?.color || 'var(--accent)'}"></span>${esc(t?.label || id)}</span>`;
    }).join('<span class="arena-vs">vs</span>') + `</div>`;
  } else {
    let html = '';
    for (const [id, t] of app.termMap) {
      html += `<label class="arena-part"><input type="checkbox" value="${esc(id)}">` +
        `<span class="arena-part-dot" style="background:${t.color}"></span>${esc(t.label)}` +
        `<span class="arena-part-proj">${esc(t.projectId)}</span></label>`;
    }
    list.innerHTML = html || '<div style="color:var(--text-3)">열려있는 터미널이 없습니다</div>';
  }
  document.getElementById('arena-dialog')?.showModal();
}

export function startArenaFromDialog() {
  const ids = pick.ids.length >= 2
    ? [...pick.ids]
    : [...document.querySelectorAll('#arena-participants input:checked')].map(i => i.value);
  const topic = document.getElementById('arena-topic')?.value.trim();
  const minTurns = Math.max(2, parseInt(document.getElementById('arena-turns-min')?.value || '4', 10));
  const maxTurns = Math.min(30, Math.max(minTurns, parseInt(document.getElementById('arena-turns-max')?.value || '10', 10)));
  if (ids.length < 2 || ids.length > 3) { showToast('참가자는 2~3개 선택', 'warning'); return; }
  if (!topic) { showToast('주제를 입력하세요', 'warning'); return; }
  if (S.running) { showToast('이미 토론이 진행 중입니다', 'warning'); return; }
  document.getElementById('arena-dialog')?.close();
  pick.ids = [];
  runArena(ids, topic, minTurns, maxTurns).catch(e => { if (e.message !== '중단됨') showToast(`Arena 오류: ${e.message}`, 'error'); });
}

// 최대 턴 도달 & 합의 미성립 → 사용자에게 연장 여부를 물음 (세션의 마지막 입장을 근거로 첨부)
function askExtension(lastStatement) {
  return new Promise((resolve) => {
    ensureDialogs();
    const dlg = document.getElementById('arena-extend-dialog');
    document.getElementById('arena-extend-reason').innerHTML =
      `<b>세션들이 아직 합의에 이르지 못했습니다.</b><br>마지막 발언 요지:<br>` +
      `<span style="color:var(--text-2)">${esc(lastStatement.slice(-400))}</span>`;
    const done = (v) => { dlg.close(); resolve(v); };
    document.getElementById('arena-extend-end').onclick = () => done(0);
    document.getElementById('arena-extend-2').onclick = () => done(2);
    document.getElementById('arena-extend-4').onclick = () => done(4);
    dlg.showModal();
  });
}

export function stopArena() {
  if (pick.on) { endArenaPick(true); showToast('참가자 선택 취소'); return; }
  S.stop = true;
  const ind = document.getElementById('arena-indicator');
  if (ind) ind.style.display = 'none';
  showToast('⚔️ Arena 중단 — 세션들은 그대로 살아있음');
}

const STANCE_RE = /⟦STANCE:(AGREE|CONTINUE)⟧/g;
function parseStance(text) {
  const all = [...text.matchAll(STANCE_RE)];
  return all.length ? all[all.length - 1][1] : 'CONTINUE';
}

async function runArena(termIds, topic, minTurns, maxTurns) {
  S.running = true; S.stop = false;
  ensureDialogs();
  const ind = document.getElementById('arena-indicator');
  if (ind) ind.style.display = 'flex';

  const names = {};
  for (const id of termIds) names[id] = app.termMap.get(id)?.label || id;
  const roster = termIds.map(id => `'${names[id]}'`).join(', ');
  const frame = (name) =>
    `[상호검증] 너는 '${name}'. 참가자: ${roster}. 상대 발언이 [이름] 프리픽스로 전달된다. ` +
    `목적은 승패가 아니라 검증이다 — 상대 주장을 코드·사실로 확인해서 인정/반박하고, 틀린 건 인정하라. ` +
    `모든 주장에 근거(파일:행 또는 검증 가능한 사실) 필수. 수사 없이 간결하게, 한국어. ` +
    `코드 수정 금지(읽기는 허용), 하던 작업은 건드리지 말 것. ` +
    `발언 전문은 반드시 ⟦BEGIN⟧ 으로 시작해 ⟦END⟧ 로 끝내고, END 직전 줄에 스탠스를 표기하라: ` +
    `아직 쟁점이 남았으면 ⟦STANCE:CONTINUE⟧, 상대의 현재 결론이 옳다고 판단되면 ⟦STANCE:AGREE⟧. ` +
    `⚠️ AGREE 는 진심으로 동의할 때만 — 예의상·타협·피로로 선언하는 것 금지. 반론이 하나라도 남았으면 CONTINUE. 거짓 합의는 검증 실패다. ` +
    `전원이 AGREE 하면 토론이 종료된다. 주제: ${topic}`;

  let prevMsg = null, prevName = null;
  const stance = {}; // termId → 최신 스탠스
  const transcript = [];
  let turn = 0;
  let capMax = maxTurns;
  try {
    while (turn < capMax) {
      if (S.stop) break;
      turn++;
      const termId = termIds[(turn - 1) % termIds.length];
      const t = app.termMap.get(termId);
      if (!t) { showToast(`${names[termId]} 터미널이 사라짐 — 중단`, 'error'); break; }
      const baseLen = t.xterm.buffer.active.length;
      const intro = turn <= termIds.length ? frame(names[termId]) + '\n' : '';
      const agreeNotice = prevName && stance[termIds[(turn - 2 + termIds.length) % termIds.length]] === 'AGREE'
        ? `\n[알림] 상대가 합의(AGREE)를 선언했다. 그 결론을 코드·사실로 재검증해서, 진심으로 동의할 때만 너도 AGREE 하라. 남은 쟁점이 있으면 CONTINUE 로 반박을 이어가라.`
        : '';
      const body = prevMsg ? `[${prevName}] ${prevMsg}` : '먼저 네 입장을 제시하라.';
      const msg = intro + body + agreeNotice;
      const statusPrefix = `⚔️ Turn ${turn}/${capMax} — <b>${esc(names[termId])}</b> 발언 중`;
      setStatus(statusPrefix);
      paintFighters(termIds, termId);
      await say(termId, msg);
      await waitTurn(t, termId, msg, statusPrefix);
      prevMsg = capture(t, baseLen);
      prevName = names[termId];
      if (!prevMsg) prevMsg = '(발언 캡처 실패 — 화면을 직접 확인하라)';
      stance[termId] = parseStance(prevMsg);
      transcript.push({ turn, name: prevName, text: prevMsg, stance: stance[termId] });

      // 조기 종료: 최소 턴 이후 + 전원 발언 완료 + 전원 AGREE (진심 합의)
      const allSpoke = termIds.every(id => stance[id]);
      const allAgree = allSpoke && termIds.every(id => stance[id] === 'AGREE');
      if (turn >= minTurns && allAgree) {
        showToast('🤝 전원 합의 성립 — 정리 턴으로', 'success');
        break;
      }
      // 최대 턴 도달 & 합의 미성립 → 사용자에게 연장 요청
      if (turn === capMax && !allAgree && !S.stop) {
        setStatus('⏳ 합의 미성립 — 연장 여부 대기 중');
        const ext = await askExtension(prevMsg);
        if (ext > 0) { capMax += ext; showToast(`+${ext}턴 연장`, 'info'); }
      }
    }

    // 정리 턴: 다음 순번 세션에게 최종 정리를 맡김
    if (!S.stop && transcript.length) {
      const wrapId = termIds[turn % termIds.length];
      const wt = app.termMap.get(wrapId);
      if (wt) {
        const baseLen = wt.xterm.buffer.active.length;
        const agreed = termIds.every(id => stance[id] === 'AGREE');
        const wrapMsg = `[${prevName}] ${prevMsg}\n\n[정리 지시] 토론 종료(${agreed ? '전원 합의' : '최대 턴 도달'}). ` +
          `지금까지의 전체 토론을 다음 형식으로 정리하라 — ① 합의된 결론 ② 미해결 쟁점 ③ 액션 아이템(있으면), 각 항목에 근거 표기. ⟦BEGIN⟧/⟦END⟧ 마커 유지.`;
        const statusPrefix = `📋 정리 턴 — <b>${esc(names[wrapId])}</b>`;
        setStatus(statusPrefix);
        paintFighters(termIds, wrapId);
        await say(wrapId, wrapMsg);
        await waitTurn(wt, wrapId, wrapMsg, statusPrefix);
        const summary = capture(wt, baseLen);
        if (summary) transcript.push({ turn: turn + 1, name: names[wrapId] + ' (정리)', text: summary, stance: '' });
      }
      showToast('🏁 Arena 종료!', 'success', 4000);
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('⚔️ Arena 종료', { body: `"${topic.slice(0, 60)}" 검증 결과가 나왔습니다` }); } catch { /* unsupported */ }
      }
    }
    showResultDialog(topic, transcript, S.stop);
  } finally {
    S.running = false;
    clearPaint();
    if (ind) ind.style.display = 'none';
  }
}
