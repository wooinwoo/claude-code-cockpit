// ─── API Tester Module ───
import { app } from './state.js';
import { esc, showToast, fetchJson, postJson, simpleMarkdown } from './utils.js';
import { registerClickActions, registerInputActions, registerChangeActions } from './actions.js';

const MAX_HISTORY = 30;
const _requestHistory = [];
let _resBodyMode = 'pretty'; // 'pretty' | 'raw'

function _timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
}

async function* _readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (line.startsWith('data: ')) {
          try { yield JSON.parse(line.slice(6)); } catch { /* malformed JSON */ }
        }
      }
    }
  }
}

// ─── Init ───
export function initApiTester() {
  if (app.apiTester.initialized) {
    renderApiTester();
    return;
  }
  app.apiTester.initialized = true;
  loadSavedRequests();
}

// ─── Load saved requests ───
async function loadSavedRequests() {
  try {
    const list = await fetchJson('/api/api-tester/requests');
    app.apiTester.requests = Array.isArray(list) ? list : [];
  } catch { app.apiTester.requests = []; }
  renderApiTester();
}

// ─── Full render ───
function renderApiTester() {
  renderSidebar();
  renderConfigPanel();
  renderResponse();
}

// ─── Sidebar ───
function renderSidebar() {
  const el = document.getElementById('at-request-list');
  if (!el) return;
  const reqs = app.apiTester.requests;
  if (!reqs.length) {
    el.innerHTML = '<div class="at-sidebar-empty">No saved requests</div>';
    return;
  }

  // Group by collection
  const groups = new Map();
  for (const r of reqs) {
    const col = r.collection || '';
    if (!groups.has(col)) groups.set(col, []);
    groups.get(col).push(r);
  }

  let html = '';
  for (const [col, items] of groups) {
    if (col) html += `<div class="at-collection-name">${esc(col)}</div>`;
    for (const r of items) {
      const active = r.id === app.apiTester.activeId ? ' active' : '';
      const methodCls = `at-method-${(r.method || 'GET').toLowerCase()}`;
      html += `<div class="at-req-item${active}" data-action="at-select" data-id="${esc(r.id)}">
        <span class="at-req-method ${methodCls}">${esc(r.method || 'GET')}</span>
        <span class="at-req-name">${esc(r.name || r.url || 'Untitled')}</span>
        <button class="at-req-del" data-action="at-delete" data-id="${esc(r.id)}" title="Delete">&times;</button>
      </div>`;
    }
  }
  el.innerHTML = html;
}

// ─── Select saved request ───
async function selectRequest(id) {
  try {
    const req = await fetchJson(`/api/api-tester/requests/${id}`);
    app.apiTester.activeId = id;
    app.apiTester.method = req.method || 'GET';
    app.apiTester.url = req.url || '';
    app.apiTester.headers = req.headers || [];
    app.apiTester.params = req.params || [];
    app.apiTester.body = req.body || '';
    app.apiTester.bodyType = req.bodyType || 'none';
    // Update form
    const methodEl = document.getElementById('at-method');
    const urlEl = document.getElementById('at-url');
    if (methodEl) methodEl.value = app.apiTester.method;
    if (urlEl) urlEl.value = app.apiTester.url;
    renderSidebar();
    renderConfigPanel();
    app.apiTester.response = null;
    renderResponse();
  } catch {
    showToast('Failed to load request', 'error');
  }
}

// ─── Send request ───
async function sendRequest() {
  const at = app.apiTester;
  const method = document.getElementById('at-method')?.value || at.method;
  const url = document.getElementById('at-url')?.value || at.url;
  if (!url.trim()) { showToast('Enter a URL', 'error'); return; }

  at.method = method;
  at.url = url;
  at.loading = true;
  renderSendingState();

  // Build headers
  const headerObj = {};
  for (const h of at.headers) {
    if (h.enabled !== false && h.key?.trim()) headerObj[h.key] = h.value || '';
  }

  // Build params → append to URL
  let finalUrl = url;
  const enabledParams = at.params.filter(p => p.enabled !== false && p.key?.trim());
  if (enabledParams.length) {
    const sep = finalUrl.includes('?') ? '&' : '?';
    finalUrl += sep + enabledParams.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value || '')}`).join('&');
  }

  // Build body
  let body = null;
  if (!['GET', 'HEAD'].includes(method)) {
    if (at.bodyType === 'json') {
      body = at.body;
      headerObj['Content-Type'] = headerObj['Content-Type'] || 'application/json';
    } else if (at.bodyType === 'text') {
      body = at.body;
      headerObj['Content-Type'] = headerObj['Content-Type'] || 'text/plain';
    } else if (at.bodyType === 'form') {
      body = at.body;
      headerObj['Content-Type'] = headerObj['Content-Type'] || 'application/x-www-form-urlencoded';
    }
  }

  try {
    const result = await postJson('/api/api-tester/execute', {
      method, url: finalUrl, headers: headerObj, body, timeout: 30000,
    });
    at.response = result;
    _requestHistory.unshift({ method, url: finalUrl, status: result.status, time: result.time, ts: Date.now() });
    if (_requestHistory.length > MAX_HISTORY) _requestHistory.pop();
    _resBodyMode = 'pretty';
    renderResponse();
  } catch (err) {
    at.response = { error: err.message };
    _requestHistory.unshift({ method, url: finalUrl, status: 'ERR', time: 0, ts: Date.now() });
    if (_requestHistory.length > MAX_HISTORY) _requestHistory.pop();
    renderResponse();
  } finally {
    at.loading = false;
  }
}

function renderSendingState() {
  const el = document.getElementById('at-response');
  if (el) el.innerHTML = '<div class="at-loading"><div class="at-spinner"></div> Sending request...</div>';
}

// ─── Save request ───
async function saveCurrentRequest() {
  const at = app.apiTester;
  const method = document.getElementById('at-method')?.value || at.method;
  const url = document.getElementById('at-url')?.value || at.url;
  at.method = method;
  at.url = url;

  const name = prompt('Request name:', at.url || 'Untitled');
  if (!name) return;
  const collection = prompt('Collection (optional):', '') || '';

  try {
    if (at.activeId) {
      await postJson(`/api/api-tester/requests/${at.activeId}`, {
        name, collection, method: at.method, url: at.url,
        headers: at.headers, params: at.params, body: at.body, bodyType: at.bodyType,
      }, { method: 'PUT' });
      showToast('Request updated', 'success');
    } else {
      const created = await postJson('/api/api-tester/requests', {
        name, collection, method: at.method, url: at.url,
        headers: at.headers, params: at.params, body: at.body, bodyType: at.bodyType,
      });
      at.activeId = created.id;
      showToast('Request saved', 'success');
    }
    loadSavedRequests();
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
  }
}

// ─── Delete request ───
async function deleteReq(id) {
  if (!confirm('Delete this request?')) return;
  try {
    await fetchJson(`/api/api-tester/requests/${id}`, { method: 'DELETE' });
    if (app.apiTester.activeId === id) {
      app.apiTester.activeId = null;
      clearForm();
    }
    showToast('Deleted', 'success');
    loadSavedRequests();
  } catch {
    showToast('Failed to delete', 'error');
  }
}

// ─── New request ───
function newRequest() {
  app.apiTester.activeId = null;
  clearForm();
  renderSidebar();
}

function clearForm() {
  app.apiTester.method = 'GET';
  app.apiTester.url = '';
  app.apiTester.headers = [];
  app.apiTester.params = [];
  app.apiTester.body = '';
  app.apiTester.bodyType = 'none';
  app.apiTester.response = null;
  const methodEl = document.getElementById('at-method');
  const urlEl = document.getElementById('at-url');
  if (methodEl) methodEl.value = 'GET';
  if (urlEl) urlEl.value = '';
  renderConfigPanel();
  renderResponse();
}

// ─── Config Panel ───
function switchConfigTab(tab) {
  app.apiTester.configTab = tab;
  document.querySelectorAll('.at-config-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  renderConfigPanel();
}

function renderConfigPanel() {
  const el = document.getElementById('at-config-panel');
  if (!el) return;
  const tab = app.apiTester.configTab;

  if (tab === 'params') {
    el.innerHTML = renderKVEditor(app.apiTester.params, 'param');
  } else if (tab === 'headers') {
    el.innerHTML = renderKVEditor(app.apiTester.headers, 'header');
  } else if (tab === 'body') {
    const bt = app.apiTester.bodyType;
    el.innerHTML = `
      <div class="at-body-type-bar">
        <label><input type="radio" name="at-bt" value="none" ${bt === 'none' ? 'checked' : ''} data-action="at-body-type"> none</label>
        <label><input type="radio" name="at-bt" value="json" ${bt === 'json' ? 'checked' : ''} data-action="at-body-type"> JSON</label>
        <label><input type="radio" name="at-bt" value="text" ${bt === 'text' ? 'checked' : ''} data-action="at-body-type"> Text</label>
        <label><input type="radio" name="at-bt" value="form" ${bt === 'form' ? 'checked' : ''} data-action="at-body-type"> Form</label>
      </div>
      ${bt !== 'none' ? `<textarea class="at-body-input" id="at-body-input" placeholder="${bt === 'json' ? '{"key": "value"}' : 'Body content...'}" data-action="at-body-edit">${esc(app.apiTester.body)}</textarea>` : '<div class="at-body-none">This request does not have a body</div>'}
    `;
  }

  // Wire up KV row events (delegation on panel)
  if (!el.dataset.delegated) {
    el.dataset.delegated = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'at-add-row') addKVRow(btn.dataset.type);
      else if (btn.dataset.action === 'at-remove-row') removeKVRow(btn.dataset.type, +btn.dataset.idx);
    });
    el.addEventListener('input', e => {
      if (e.target.dataset.action === 'at-kv-key' || e.target.dataset.action === 'at-kv-val') {
        updateKVRow(e.target.dataset.type, +e.target.dataset.idx, e.target.dataset.action === 'at-kv-key' ? 'key' : 'value', e.target.value);
      }
      if (e.target.dataset.action === 'at-body-edit') {
        app.apiTester.body = e.target.value;
      }
    });
    el.addEventListener('change', e => {
      if (e.target.dataset.action === 'at-kv-toggle') {
        toggleKVRow(e.target.dataset.type, +e.target.dataset.idx, e.target.checked);
      }
      if (e.target.dataset.action === 'at-body-type') {
        app.apiTester.bodyType = e.target.value;
        renderConfigPanel();
      }
    });
  }
}

function renderKVEditor(items, type) {
  let rows = '';
  items.forEach((item, i) => {
    rows += `<div class="at-kv-row">
      <input type="checkbox" ${item.enabled !== false ? 'checked' : ''} data-action="at-kv-toggle" data-type="${type}" data-idx="${i}">
      <input type="text" class="at-kv-key" placeholder="Key" value="${esc(item.key || '')}" data-action="at-kv-key" data-type="${type}" data-idx="${i}">
      <input type="text" class="at-kv-val" placeholder="Value" value="${esc(item.value || '')}" data-action="at-kv-val" data-type="${type}" data-idx="${i}">
      <button class="at-kv-del" data-action="at-remove-row" data-type="${type}" data-idx="${i}">&times;</button>
    </div>`;
  });
  return `<div class="at-kv-editor">${rows}
    <button class="at-kv-add" data-action="at-add-row" data-type="${type}">+ Add ${type}</button>
  </div>`;
}

function addKVRow(type) {
  const arr = type === 'header' ? app.apiTester.headers : app.apiTester.params;
  arr.push({ key: '', value: '', enabled: true });
  renderConfigPanel();
}

function removeKVRow(type, idx) {
  const arr = type === 'header' ? app.apiTester.headers : app.apiTester.params;
  arr.splice(idx, 1);
  renderConfigPanel();
}

function updateKVRow(type, idx, field, value) {
  const arr = type === 'header' ? app.apiTester.headers : app.apiTester.params;
  if (arr[idx]) arr[idx][field] = value;
}

function toggleKVRow(type, idx, checked) {
  const arr = type === 'header' ? app.apiTester.headers : app.apiTester.params;
  if (arr[idx]) arr[idx].enabled = checked;
}

// ─── Response ───
function renderResponse() {
  const el = document.getElementById('at-response');
  if (!el) return;
  const r = app.apiTester.response;

  if (!r) {
    el.innerHTML = `<div class="at-empty">
      <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="var(--text-3)" stroke-width="1.5"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
      <div>Send a request to see the response</div>
    </div>`;
    return;
  }

  if (r.error) {
    el.innerHTML = `<div class="at-response-error">
      <div class="at-error-icon">!</div>
      <div class="at-error-msg">${esc(r.error)}</div>
    </div>`;
    return;
  }

  const statusCls = r.status < 300 ? 'at-status-2xx' : r.status < 400 ? 'at-status-3xx' : r.status < 500 ? 'at-status-4xx' : 'at-status-5xx';
  const bodyPretty = typeof r.body === 'object' ? JSON.stringify(r.body, null, 2) : String(r.body || '');
  const bodyRaw = typeof r.body === 'object' ? JSON.stringify(r.body) : String(r.body || '');
  const bodyStr = _resBodyMode === 'pretty' ? bodyPretty : bodyRaw;
  const sizeStr = r.size >= 1024 ? (r.size / 1024).toFixed(1) + ' KB' : r.size + ' B';

  // Response headers
  const headersHtml = r.headers ? Object.entries(r.headers).map(([k, v]) =>
    `<div class="at-res-hdr"><span class="at-res-hdr-key">${esc(k)}</span>: <span class="at-res-hdr-val">${esc(v)}</span></div>`
  ).join('') : '';

  // History panel
  const historyHtml = _requestHistory.length ? _requestHistory.slice(0, 10).map(h => {
    const sCls = typeof h.status === 'number' ? (h.status < 300 ? 'at-status-2xx' : h.status < 400 ? 'at-status-3xx' : h.status < 500 ? 'at-status-4xx' : 'at-status-5xx') : 'at-status-5xx';
    const ago = _timeAgo(h.ts);
    return `<div class="at-hist-item"><span class="at-req-method at-method-${h.method.toLowerCase()}">${h.method}</span><span class="at-hist-url" title="${esc(h.url)}">${esc(h.url)}</span><span class="at-status-badge at-status-sm ${sCls}">${h.status}</span><span class="at-res-time">${h.time}ms</span><span class="at-hist-ts">${ago}</span></div>`;
  }).join('') : '<div class="at-body-none">No history yet</div>';

  el.innerHTML = `
    <div class="at-response-header">
      <span class="at-status-badge ${statusCls}">${r.status} ${esc(r.statusText || '')}</span>
      <span class="at-res-time">${r.time}ms</span>
      <span class="at-res-size">${sizeStr}</span>
      <div class="at-res-tabs">
        <button class="at-res-tab active" data-action="at-res-tab" data-tab="body" role="tab" aria-selected="true">Body</button>
        <button class="at-res-tab" data-action="at-res-tab" data-tab="headers" role="tab" aria-selected="false">Headers ${r.headers ? `(${Object.keys(r.headers).length})` : ''}</button>
        <button class="at-res-tab" data-action="at-res-tab" data-tab="history" role="tab" aria-selected="false">History (${_requestHistory.length})</button>
      </div>
      <div class="at-res-actions">
        <button class="at-res-mode ${_resBodyMode === 'pretty' ? 'active' : ''}" data-action="at-res-mode" data-mode="pretty" title="Pretty">{ }</button>
        <button class="at-res-mode ${_resBodyMode === 'raw' ? 'active' : ''}" data-action="at-res-mode" data-mode="raw" title="Raw">Raw</button>
        <button class="at-copy-btn" data-action="at-copy-body" title="Copy response body"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
      </div>
    </div>
    <div class="at-res-body-panel" id="at-res-body">${bodyStr ? `<pre class="at-response-body">${esc(bodyStr)}</pre>` : '<div class="at-body-none">Empty response</div>'}</div>
    <div class="at-res-headers-panel" id="at-res-headers" style="display:none">${headersHtml || '<div class="at-body-none">No headers</div>'}</div>
    <div class="at-res-history-panel" id="at-res-history" style="display:none">${historyHtml}</div>
  `;

  // Response tab/action switching
  if (!el.dataset.resDelegated) {
    el.dataset.resDelegated = '1';
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'at-res-tab') {
        const tab = btn.dataset.tab;
        el.querySelectorAll('.at-res-tab').forEach(t => {
          const selected = t.dataset.tab === tab;
          t.classList.toggle('active', selected);
          t.setAttribute('aria-selected', String(selected));
        });
        document.getElementById('at-res-body')?.style.setProperty('display', tab === 'body' ? '' : 'none');
        document.getElementById('at-res-headers')?.style.setProperty('display', tab === 'headers' ? '' : 'none');
        document.getElementById('at-res-history')?.style.setProperty('display', tab === 'history' ? '' : 'none');
      } else if (btn.dataset.action === 'at-res-mode') {
        _resBodyMode = btn.dataset.mode;
        renderResponse();
      } else if (btn.dataset.action === 'at-copy-body') {
        const r = app.apiTester.response;
        if (r && !r.error) {
          const text = typeof r.body === 'object' ? JSON.stringify(r.body, null, 2) : String(r.body || '');
          navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard')).catch(() => showToast('Clipboard access denied', 'error'));
        }
      }
    });
  }
}

// ═══════════════════════════════════════════════════════
// Swagger Import & Auto Test
// ═══════════════════════════════════════════════════════

// ─── Swagger Import Dialog ───
let _importMode = 'url'; // 'url' | 'json'

function openSwaggerImportDialog() {
  const dlg = document.getElementById('at-swagger-dialog');
  if (!dlg) return;
  const jsonEl = document.getElementById('at-swagger-json');
  const urlEl = document.getElementById('at-swagger-url');
  const baseEl = document.getElementById('at-swagger-base-url');
  if (jsonEl) jsonEl.value = '';
  if (urlEl) urlEl.value = '';
  if (baseEl) baseEl.value = app.apiTester.swaggerBaseUrl || '';
  const errEl = document.getElementById('at-swagger-error');
  if (errEl) errEl.style.display = 'none';
  _switchImportMode('url');
  dlg.showModal();
}

function _switchImportMode(mode) {
  _importMode = mode;
  document.querySelectorAll('.at-import-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  const urlPanel = document.getElementById('at-import-url-panel');
  const jsonPanel = document.getElementById('at-import-json-panel');
  if (urlPanel) urlPanel.style.display = mode === 'url' ? '' : 'none';
  if (jsonPanel) jsonPanel.style.display = mode === 'json' ? '' : 'none';
  // Update Import button text
  const btn = document.getElementById('at-import-btn');
  if (btn) btn.textContent = mode === 'url' ? 'Fetch & Import' : 'Import';
}

async function fetchSwaggerUrl() {
  const url = document.getElementById('at-swagger-url')?.value?.trim();
  const errEl = document.getElementById('at-swagger-error');
  if (!url) { _showSwaggerError(errEl, 'URL을 입력하세요'); return; }

  const fetchBtn = document.getElementById('at-fetch-swagger-btn');
  if (fetchBtn) { fetchBtn.disabled = true; fetchBtn.textContent = 'Fetching...'; }

  try {
    const result = await postJson('/api/api-tester/swagger/fetch', { url });
    if (result.error) { _showSwaggerError(errEl, result.error); return; }
    _applySwaggerResult(result, url);
  } catch (err) {
    _showSwaggerError(errEl, err.message);
  } finally {
    if (fetchBtn) { fetchBtn.disabled = false; fetchBtn.textContent = 'Fetch'; }
  }
}

async function parseSwagger() {
  if (_importMode === 'url') { await fetchSwaggerUrl(); return; }

  const jsonStr = document.getElementById('at-swagger-json')?.value?.trim();
  const errEl = document.getElementById('at-swagger-error');

  if (!jsonStr) { _showSwaggerError(errEl, 'JSON 스펙을 붙여넣으세요'); return; }

  let spec;
  try { spec = JSON.parse(jsonStr); }
  catch { _showSwaggerError(errEl, 'Invalid JSON - JSON 형식이 올바르지 않습니다'); return; }

  try {
    const result = await postJson('/api/api-tester/swagger/parse', { spec });
    if (result.error) { _showSwaggerError(errEl, result.error); return; }
    _applySwaggerResult(result);
  } catch (err) {
    _showSwaggerError(errEl, err.message);
  }
}

function _applySwaggerResult(result, fetchedUrl) {
  const baseUrlOverride = document.getElementById('at-swagger-base-url')?.value?.trim();

  app.apiTester.swagger = result;
  // Base URL priority: user override > spec servers > extract from fetched URL
  let autoBase = result.servers?.[0]?.url || '';
  if (!autoBase && fetchedUrl) {
    try { const u = new URL(fetchedUrl); autoBase = u.origin; } catch { /* invalid URL */ }
  }
  app.apiTester.swaggerBaseUrl = baseUrlOverride || autoBase;
  app.apiTester.swaggerExcluded = new Set();

  // Update base URL field to show resolved value
  const baseEl = document.getElementById('at-swagger-base-url');
  if (baseEl && !baseEl.value) baseEl.value = app.apiTester.swaggerBaseUrl;

  // Auto-detect auth type from security schemes
  if (result.securitySchemes?.length) {
    const scheme = result.securitySchemes[0];
    app.apiTester.detectedAuth = scheme;
  }

  document.getElementById('at-swagger-dialog')?.close();
  switchSidebarMode('swagger');
  const btn = document.getElementById('at-autotest-btn');
  if (btn) btn.style.display = '';

  const authHint = result.securitySchemes?.length
    ? ` — Auth: ${result.securitySchemes.map(s => s.type).join(', ')}`
    : '';
  showToast(`Imported ${result.endpoints.length} endpoints (${result.info?.title || 'API'})${authHint}`, 'success');
}

function _showSwaggerError(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.style.display = '';
}

// ─── Sidebar Mode ───
function switchSidebarMode(mode) {
  app.apiTester.sidebarMode = mode;

  // Show tabs
  const tabs = document.getElementById('at-sidebar-tabs');
  if (tabs) tabs.style.display = app.apiTester.swagger ? '' : 'none';

  // Toggle active tab
  tabs?.querySelectorAll('.at-sidebar-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });

  // Toggle panels
  const reqList = document.getElementById('at-request-list');
  const swgPanel = document.getElementById('at-swagger-panel');
  if (reqList) reqList.style.display = mode === 'requests' ? '' : 'none';
  if (swgPanel) swgPanel.style.display = mode === 'swagger' ? '' : 'none';

  if (mode === 'swagger') renderSwaggerList();
  else renderSidebar();
}

// ─── Swagger List ───
function renderSwaggerList() {
  const el = document.getElementById('at-swagger-list');
  if (!el) return;
  const swg = app.apiTester.swagger;
  if (!swg) { el.innerHTML = '<div class="at-sidebar-empty">No spec loaded</div>'; return; }

  const filter = app.apiTester.swaggerFilter.toLowerCase();
  const excluded = app.apiTester.swaggerExcluded;

  // Group by tag
  const tagMap = new Map();
  for (const ep of swg.endpoints) {
    if (filter && !ep.path.toLowerCase().includes(filter) && !ep.method.toLowerCase().includes(filter) && !(ep.summary || '').toLowerCase().includes(filter)) continue;
    for (const tag of ep.tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag).push(ep);
    }
  }

  let html = '';

  // CRUD Resources section
  if (swg.resources.length) {
    html += '<div class="at-swagger-section-title">CRUD Resources</div>';
    for (const res of swg.resources) {
      html += `<div class="at-swagger-resource">
        <span class="at-swagger-resource-name">${esc(res.name)}</span>
        <span class="at-swagger-resource-path">${esc(res.basePath)}</span>
        <span class="at-swagger-resource-steps">${res.steps.length} steps</span>
      </div>`;
    }
  }

  // Endpoints by tag
  for (const [tag, eps] of tagMap) {
    html += `<div class="at-swagger-tag">${esc(tag)}</div>`;
    for (const ep of eps) {
      const key = `${ep.method}:${ep.path}`;
      const isExcluded = excluded.has(key);
      const methodCls = `at-method-${ep.method.toLowerCase()}`;
      html += `<div class="at-swagger-ep${isExcluded ? ' at-ep-excluded' : ''}">
        <input type="checkbox" class="at-ep-check" ${isExcluded ? '' : 'checked'} data-action="at-toggle-ep-check" data-key="${esc(key)}">
        <span class="at-req-method ${methodCls}" style="font-size:.6rem">${ep.method}</span>
        <span class="at-swagger-ep-path" data-action="at-load-swagger-ep" data-method="${ep.method}" data-path="${esc(ep.path)}" title="${esc(ep.summary || ep.path)}">${esc(ep.path)}</span>
      </div>`;
    }
  }

  if (!html) html = '<div class="at-sidebar-empty">No matching endpoints</div>';
  el.innerHTML = html;
}

// ─── Endpoint Exclude Toggle ───
function toggleEndpoint(key, checked) {
  if (checked === undefined) {
    // toggle
    if (app.apiTester.swaggerExcluded.has(key)) app.apiTester.swaggerExcluded.delete(key);
    else app.apiTester.swaggerExcluded.add(key);
  } else {
    if (checked) app.apiTester.swaggerExcluded.delete(key);
    else app.apiTester.swaggerExcluded.add(key);
  }
  renderSwaggerList();
}

function toggleAllEndpoints() {
  const swg = app.apiTester.swagger;
  if (!swg) return;
  const allKeys = swg.endpoints.map(ep => `${ep.method}:${ep.path}`);
  const allExcluded = allKeys.every(k => app.apiTester.swaggerExcluded.has(k));
  if (allExcluded) {
    app.apiTester.swaggerExcluded.clear();
  } else {
    allKeys.forEach(k => app.apiTester.swaggerExcluded.add(k));
  }
  renderSwaggerList();
}

// ─── Load Swagger Endpoint into Builder ───
function loadSwaggerEndpoint(method, path) {
  const swg = app.apiTester.swagger;
  if (!swg) return;

  const ep = swg.endpoints.find(e => e.method === method && e.path === path);
  if (!ep) return;

  const base = app.apiTester.swaggerBaseUrl || '';
  app.apiTester.method = method;
  app.apiTester.url = base + path;
  app.apiTester.response = null;

  // Build params from path/query parameters
  app.apiTester.params = (ep.parameters || [])
    .filter(p => p.in === 'query')
    .map(p => ({ key: p.name, value: '', enabled: true }));

  // Build headers
  app.apiTester.headers = (ep.parameters || [])
    .filter(p => p.in === 'header')
    .map(p => ({ key: p.name, value: '', enabled: true }));

  // Build body from requestBody
  if (ep.requestBody?.content?.['application/json']?.schema) {
    app.apiTester.bodyType = 'json';
    // Generate sample body from schema (client-side simple version)
    const schema = ep.requestBody.content['application/json'].schema;
    const sample = _clientSampleFromSchema(schema, swg.defs || {});
    app.apiTester.body = sample ? JSON.stringify(sample, null, 2) : '{}';
  } else {
    app.apiTester.bodyType = ['GET', 'HEAD', 'DELETE'].includes(method) ? 'none' : 'json';
    app.apiTester.body = '';
  }

  // Update form elements
  const methodEl = document.getElementById('at-method');
  const urlEl = document.getElementById('at-url');
  if (methodEl) methodEl.value = method;
  if (urlEl) urlEl.value = app.apiTester.url;

  renderConfigPanel();
  renderResponse();
}

// Simple client-side sample generator (mirrors server logic but lighter)
function _clientSampleFromSchema(schema, defs, depth = 0) {
  if (!schema || depth > 4) return null;
  if (schema.$ref) {
    const refName = schema.$ref.split('/').pop();
    const refSchema = defs[refName];
    if (refSchema) return _clientSampleFromSchema(refSchema, defs, depth + 1);
    return null;
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === 'string') return 'sample';
  if (schema.type === 'integer' || schema.type === 'number') return 1;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'array') {
    const item = _clientSampleFromSchema(schema.items, defs, depth + 1);
    return item != null ? [item] : [];
  }
  if (schema.type === 'object' || schema.properties) {
    const obj = {};
    for (const [k, v] of Object.entries(schema.properties || {})) {
      const val = _clientSampleFromSchema(v, defs, depth + 1);
      if (val != null) obj[k] = val;
    }
    return obj;
  }
  return null;
}

// ═══════════════════════════════════════════════════════
// Auto Test Runner
// ═══════════════════════════════════════════════════════

function openAutoTestDialog() {
  const swg = app.apiTester.swagger;
  if (!swg) { showToast('Import a Swagger spec first', 'error'); return; }

  const dlg = document.getElementById('at-auto-test-dialog');
  if (!dlg) return;

  app.apiTester.autoTest = { running: false, results: [], progress: { current: 0, total: 0, passed: 0, failed: 0 } };
  app.apiTester.aiAnalysis = null;
  app.apiTester.aiAnalyzing = false;
  app.apiTester.reviewedPlan = null;

  // Auto-set auth type from detected scheme
  const authSelect = document.getElementById('at-auth-type');
  if (authSelect && app.apiTester.detectedAuth) {
    const d = app.apiTester.detectedAuth;
    authSelect.value = d.type || 'none';
  }

  const sectionsEl = document.getElementById('at-autotest-sections');
  if (sectionsEl) sectionsEl.style.display = '';
  _renderAuthFields();
  renderAutoTestSections();
  document.getElementById('at-autotest-results').style.display = 'none';
  document.getElementById('at-ai-analysis').style.display = 'none';
  dlg.showModal();
}

function _buildAllAutoSteps() {
  const swg = app.apiTester.swagger;
  if (!swg) return [];
  const base = app.apiTester.swaggerBaseUrl;
  const excluded = app.apiTester.swaggerExcluded;
  const steps = [];

  // GET endpoints
  for (const ep of swg.endpoints) {
    if (ep.method !== 'GET' || excluded.has(`GET:${ep.path}`) || ep.path.match(/\{[^}]+\}/)) continue;
    steps.push({ method: 'GET', url: `${base}${ep.path}`, path: ep.path, headers: { Accept: 'application/json' }, label: `GET ${ep.path}`, group: 'GET' });
  }

  // CRUD cycles
  for (const res of swg.resources) {
    const itemPath = res.basePath + '/{id}';
    if (res.create && !excluded.has(`POST:${res.basePath}`)) {
      const schema = res.create.requestBody?.content?.['application/json']?.schema;
      const sample = schema ? _clientSampleFromSchema(schema, swg.defs || {}) : {};
      steps.push({ method: 'POST', url: `${base}${res.basePath}`, path: res.basePath, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(sample || {}), extractId: true, label: `Create ${res.name}`, group: `CRUD:${res.name}` });
    }
    if (res.readOne && !excluded.has(`GET:${itemPath}`)) {
      steps.push({ method: 'GET', url: `${base}${itemPath}`, path: itemPath, headers: { Accept: 'application/json' }, label: `Read ${res.name}`, group: `CRUD:${res.name}` });
    }
    if (res.update) {
      const m = res.update.method;
      if (!excluded.has(`${m}:${itemPath}`)) {
        const schema = res.update.requestBody?.content?.['application/json']?.schema;
        const sample = schema ? _clientSampleFromSchema(schema, swg.defs || {}) : {};
        steps.push({ method: m, url: `${base}${itemPath}`, path: itemPath, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(sample || {}), label: `Update ${res.name}`, group: `CRUD:${res.name}` });
      }
    }
    if (res.delete && !excluded.has(`DELETE:${itemPath}`)) {
      steps.push({ method: 'DELETE', url: `${base}${itemPath}`, path: itemPath, headers: { Accept: 'application/json' }, label: `Delete ${res.name}`, group: `CRUD:${res.name}` });
      if (res.readOne && !excluded.has(`GET:${itemPath}`)) {
        steps.push({ method: 'GET', url: `${base}${itemPath}`, path: itemPath, headers: { Accept: 'application/json' }, label: `Verify ${res.name} deleted`, expect: { status: 404 }, group: `CRUD:${res.name}` });
      }
    }
  }
  return steps;
}

function renderAutoTestSections() {
  const el = document.getElementById('at-autotest-sections');
  if (!el) return;
  const swg = app.apiTester.swagger;
  const excluded = app.apiTester.swaggerExcluded;

  const getEndpoints = swg.endpoints
    .filter(ep => ep.method === 'GET' && !excluded.has(`GET:${ep.path}`) && !ep.path.match(/\{[^}]+\}/));
  const getCount = getEndpoints.length;
  const crudCount = swg.resources.reduce((n, r) => n + r.steps.length, 0);

  // AI Plan section at the top
  let html = `<div class="at-autotest-section at-plan-section">
    <div class="at-autotest-section-head">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      <span>AI Test Planner</span>
      <span class="at-autotest-count">${getCount + crudCount} steps</span>
    </div>
    <p class="at-ai-scenario-desc">자동 생성된 GET + CRUD 테스트를 Claude가 검토합니다. 위험한 엔드포인트 제거, 순서 최적화, 누락 테스트 추가, 의존성 체이닝을 자동으로 처리합니다.</p>
    <div class="at-plan-actions">
      <button class="btn primary btn-sm" data-action="at-review-plan" id="at-review-plan-btn">AI Review & Plan</button>
      <button class="btn btn-sm" data-action="at-run-raw" title="AI 검토 없이 바로 실행">Skip AI, Run Raw</button>
    </div>
    <div id="at-plan-review"></div>
  </div>`;

  // Manual sections (collapsed)
  html += `<details class="at-manual-sections">
    <summary class="at-manual-summary">Manual Test Sections</summary>
    <div class="at-autotest-section">
      <div class="at-autotest-section-head">
        <span>GET Endpoints</span>
        <span class="at-autotest-count">${getCount} endpoints</span>
      </div>
      <button class="btn primary btn-sm" data-action="at-run-get-tests" ${getCount === 0 ? 'disabled' : ''}>Run GET Tests (${getCount})</button>
    </div>`;

  if (swg.resources.length) {
    html += `<div class="at-autotest-section">
      <div class="at-autotest-section-head">
        <span>CRUD Cycles</span>
        <button class="btn primary btn-sm" data-action="at-run-all-crud" style="margin-left:auto">Run All CRUD</button>
      </div>`;
    for (const res of swg.resources) {
      const stepLabels = res.steps.map(s => {
        const key = `${s.method}:${s.path}`;
        return excluded.has(key) ? `<s>${s.method}</s>` : s.method;
      }).join(' → ');
      html += `<div class="at-autotest-crud-item">
        <span class="at-autotest-crud-name">${esc(res.name)}</span>
        <span class="at-autotest-crud-steps">${stepLabels}</span>
        <button class="btn btn-sm" data-action="at-run-crud" data-path="${esc(res.basePath)}">Run</button>
      </div>`;
    }
    html += '</div>';
  }

  // AI scenario generation
  html += `<div class="at-autotest-section">
      <div class="at-autotest-section-head">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--accent)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>AI Scenarios</span>
      </div>
      <p class="at-ai-scenario-desc">Claude가 엣지케이스, 인증 실패, 경계값 등 추가 시나리오를 생성합니다.</p>
      <button class="btn primary btn-sm" data-action="at-gen-ai-scenarios" id="at-gen-scenarios-btn">Generate AI Scenarios</button>
      <div id="at-ai-scenarios"></div>
    </div>
  </details>`;

  el.innerHTML = html;
}

async function reviewTestPlan() {
  const swg = app.apiTester.swagger;
  if (!swg) return;

  const btn = document.getElementById('at-review-plan-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Reviewing...'; }

  const reviewEl = document.getElementById('at-plan-review');
  if (reviewEl) reviewEl.innerHTML = '<div class="at-loading"><div class="at-spinner"></div> Claude가 테스트 플랜을 검토 중...</div>';

  const autoSteps = _buildAllAutoSteps();
  if (!autoSteps.length) {
    if (reviewEl) reviewEl.innerHTML = '<div class="at-response-error"><div class="at-error-msg">자동 생성된 테스트 스텝이 없습니다.</div></div>';
    if (btn) { btn.disabled = false; btn.textContent = 'AI Review & Plan'; }
    return;
  }

  const specSummary = {
    info: swg.info,
    endpoints: swg.endpoints.map(ep => ({ method: ep.method, path: ep.path, summary: ep.summary, parameters: ep.parameters, hasBody: !!ep.requestBody })),
    resources: swg.resources.map(r => ({ basePath: r.basePath, name: r.name, steps: r.steps.map(s => s.method) })),
    securitySchemes: swg.securitySchemes || [],
  };

  try {
    const response = await fetch('/api/api-tester/review-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: specSummary, steps: autoSteps, baseUrl: app.apiTester.swaggerBaseUrl, securitySchemes: swg.securitySchemes || [] }),
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try { msg = (await response.json()).error || msg; } catch { /* malformed JSON */ }
      throw new Error(msg);
    }

    let fullText = '';
    for await (const event of _readSSE(response)) {
      if (event.type === 'text') {
        fullText += event.delta;
        if (reviewEl) reviewEl.innerHTML = `<div class="at-ai-analysis-content">${simpleMarkdown(fullText)}</div>`;
      } else if (event.type === 'plan') {
        app.apiTester.reviewedPlan = event.steps;
        _renderReviewedPlan(event.steps);
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }

    // Fallback: try parsing from markdown if no structured plan came through
    if (!app.apiTester.reviewedPlan && fullText) {
      const jsonMatch = fullText.match(/```json\s*\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        try {
          const plan = JSON.parse(jsonMatch[1]);
          if (Array.isArray(plan) && plan.length) {
            app.apiTester.reviewedPlan = plan;
            _renderReviewedPlan(plan);
          }
        } catch { /* malformed JSON */ }
      }
    }
  } catch (err) {
    if (reviewEl) reviewEl.innerHTML = `<div class="at-response-error"><div class="at-error-msg">${esc(err.message)}</div></div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'AI Review & Plan'; }
  }
}

function _renderReviewedPlan(steps) {
  const el = document.getElementById('at-plan-review');
  if (!el || !steps?.length) return;

  // Group steps for display
  const groups = new Map();
  for (const s of steps) {
    const g = s.group || 'other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }

  let html = el.innerHTML; // keep review text
  html += `<div class="at-reviewed-plan">
    <div class="at-plan-header">
      <span class="at-plan-title">Reviewed Plan — ${steps.length} steps</span>
      <button class="btn primary btn-sm" data-action="at-run-reviewed-plan">Run Reviewed Plan</button>
    </div>
    <div class="at-plan-steps">`;

  for (const [group, gSteps] of groups) {
    html += `<div class="at-plan-group-name">${esc(group)}</div>`;
    for (const s of gSteps) {
      const methodCls = `at-method-${s.method.toLowerCase()}`;
      html += `<div class="at-plan-step">
        <span class="at-req-method ${methodCls}" style="font-size:.6rem">${s.method}</span>
        <span class="at-plan-step-label">${esc(s.label || s.path)}</span>
        ${s.extractId ? '<span class="at-plan-tag">ID추출</span>' : ''}
        ${s.expect?.status ? `<span class="at-plan-tag">expect:${s.expect.status}</span>` : ''}
      </div>`;
    }
  }

  html += '</div></div>';
  el.innerHTML = html;
}

async function runReviewedPlan() {
  const steps = app.apiTester.reviewedPlan;
  if (!steps?.length) { showToast('No reviewed plan', 'error'); return; }
  const auth = _getAuthHeaders();
  const withAuth = steps.map(s => ({ ...s, headers: { ...s.headers, ...auth } }));
  await _runAutoTest(withAuth);
}

async function runRawSteps() {
  const auth = _getAuthHeaders();
  const steps = _buildAllAutoSteps().map(s => ({ ...s, headers: { ...s.headers, ...auth } }));
  if (!steps.length) { showToast('No steps to run', 'error'); return; }
  await _runAutoTest(steps);
}

async function generateAiScenarios() {
  const swg = app.apiTester.swagger;
  if (!swg) return;

  const btn = document.getElementById('at-gen-scenarios-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }

  const scenariosEl = document.getElementById('at-ai-scenarios');
  if (scenariosEl) scenariosEl.innerHTML = '<div class="at-loading"><div class="at-spinner"></div> Claude analyzing spec...</div>';

  const base = app.apiTester.swaggerBaseUrl;
  const specSummary = {
    info: swg.info,
    endpoints: swg.endpoints.map(ep => ({ method: ep.method, path: ep.path, summary: ep.summary, parameters: ep.parameters, hasBody: !!ep.requestBody })),
    resources: swg.resources.map(r => ({ basePath: r.basePath, name: r.name, steps: r.steps.map(s => s.method) })),
    securitySchemes: swg.securitySchemes || [],
  };

  try {
    const response = await fetch('/api/api-tester/generate-scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: specSummary, baseUrl: base }),
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try { msg = (await response.json()).error || msg; } catch { /* malformed JSON */ }
      throw new Error(msg);
    }

    // Stream the response
    let fullText = '';
    for await (const event of _readSSE(response)) {
      if (event.type === 'text') {
        fullText += event.delta;
        if (scenariosEl) scenariosEl.innerHTML = `<div class="at-ai-analysis-content">${simpleMarkdown(fullText)}</div>`;
      } else if (event.type === 'scenarios') {
        // Server parsed the AI output into executable steps
        app.apiTester.aiScenarios = event.scenarios;
        _renderAiScenarioButtons(event.scenarios);
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }

    // If no structured scenarios came through, try parsing from the markdown
    if (!app.apiTester.aiScenarios && fullText) {
      _tryParseScenarios(fullText);
    }
  } catch (err) {
    if (scenariosEl) scenariosEl.innerHTML = `<div class="at-response-error"><div class="at-error-msg">${esc(err.message)}</div></div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate AI Scenarios'; }
  }
}

function _renderAiScenarioButtons(scenarios) {
  const el = document.getElementById('at-ai-scenarios');
  if (!el || !scenarios?.length) return;

  let html = el.innerHTML;
  html += '<div class="at-ai-scenario-actions">';
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    html += `<button class="btn btn-sm" data-action="at-run-ai-scenario" data-idx="${i}">${esc(s.name)} (${s.steps.length} steps)</button>`;
  }
  html += '<button class="btn primary btn-sm" data-action="at-run-all-ai-scenarios">Run All Scenarios</button>';
  html += '</div>';
  el.innerHTML = html;
}

function _tryParseScenarios(text) {
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!jsonMatch) return;
  try {
    const scenarios = JSON.parse(jsonMatch[1]);
    if (Array.isArray(scenarios) && scenarios.length) {
      app.apiTester.aiScenarios = scenarios;
      _renderAiScenarioButtons(scenarios);
    }
  } catch { /* malformed JSON */ }
}

async function runAiScenario(idx) {
  const scenarios = app.apiTester.aiScenarios;
  if (!scenarios?.[idx]) return;
  const auth = _getAuthHeaders();
  const steps = scenarios[idx].steps.map(s => ({
    ...s,
    headers: { ...s.headers, ...auth },
  }));
  await _runAutoTest(steps);
}

async function runAllAiScenarios() {
  const scenarios = app.apiTester.aiScenarios;
  if (!scenarios?.length) { showToast('No AI scenarios generated', 'error'); return; }
  const auth = _getAuthHeaders();
  const allSteps = scenarios.flatMap(s => s.steps.map(step => ({
    ...step,
    headers: { ...step.headers, ...auth },
  })));
  await _runAutoTest(allSteps);
}

async function runGetTests() {
  const swg = app.apiTester.swagger;
  if (!swg) return;
  const base = app.apiTester.swaggerBaseUrl;
  const excluded = app.apiTester.swaggerExcluded;
  const auth = _getAuthHeaders();

  const steps = swg.endpoints
    .filter(ep => ep.method === 'GET' && !excluded.has(`GET:${ep.path}`) && !ep.path.match(/\{[^}]+\}/))
    .map(ep => ({
      method: 'GET',
      url: `${base}${ep.path}`,
      path: ep.path,
      headers: { Accept: 'application/json', ...auth },
      label: `GET ${ep.path}`,
    }));

  if (!steps.length) { showToast('No GET endpoints to test', 'error'); return; }
  await _runAutoTest(steps);
}

async function runCrudCycle(basePath) {
  const swg = app.apiTester.swagger;
  if (!swg) return;
  const res = swg.resources.find(r => r.basePath === basePath);
  if (!res) return;

  const base = app.apiTester.swaggerBaseUrl;
  const excluded = app.apiTester.swaggerExcluded;
  const auth = _getAuthHeaders();
  const itemPath = basePath + '/{id}';

  const steps = [];
  if (res.create && !excluded.has(`POST:${basePath}`)) {
    const schema = res.create.requestBody?.content?.['application/json']?.schema;
    const sample = schema ? _clientSampleFromSchema(schema, swg.defs || {}) : {};
    steps.push({
      method: 'POST', url: `${base}${basePath}`, path: basePath,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...auth },
      body: JSON.stringify(sample || {}), extractId: true, label: 'Create',
    });
  }
  if (res.readOne && !excluded.has(`GET:${itemPath}`)) {
    steps.push({ method: 'GET', url: `${base}${itemPath}`, path: itemPath, headers: { Accept: 'application/json', ...auth }, label: 'Read' });
  }
  if (res.update) {
    const m = res.update.method;
    if (!excluded.has(`${m}:${itemPath}`)) {
      const schema = res.update.requestBody?.content?.['application/json']?.schema;
      const sample = schema ? _clientSampleFromSchema(schema, swg.defs || {}) : {};
      steps.push({
        method: m, url: `${base}${itemPath}`, path: itemPath,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...auth },
        body: JSON.stringify(sample || {}), label: 'Update',
      });
    }
  }
  if (res.delete && !excluded.has(`DELETE:${itemPath}`)) {
    steps.push({ method: 'DELETE', url: `${base}${itemPath}`, path: itemPath, headers: { Accept: 'application/json', ...auth }, label: 'Delete' });
    if (res.readOne && !excluded.has(`GET:${itemPath}`)) {
      steps.push({ method: 'GET', url: `${base}${itemPath}`, path: itemPath, headers: { Accept: 'application/json', ...auth }, label: 'Verify 404', expect: { status: 404 } });
    }
  }

  if (!steps.length) { showToast('No steps (all excluded)', 'error'); return; }
  await _runAutoTest(steps);
}

async function runAllCrudCycles() {
  const swg = app.apiTester.swagger;
  if (!swg?.resources.length) { showToast('No CRUD resources detected', 'error'); return; }
  for (const res of swg.resources) {
    await runCrudCycle(res.basePath);
  }
}

async function _runAutoTest(steps) {
  const at = app.apiTester.autoTest;
  at.running = true;
  at.results = [];
  at.progress = { current: 0, total: steps.length, passed: 0, failed: 0 };

  // Hide sections, show live progress
  const sectionsEl = document.getElementById('at-autotest-sections');
  if (sectionsEl) sectionsEl.style.display = 'none';

  const el = document.getElementById('at-autotest-results');
  if (!el) return;
  el.style.display = '';
  el.innerHTML = `
    <div class="at-progress-wrap">
      <div class="at-progress-info">
        <span class="at-progress-label" id="at-progress-label">Starting...</span>
        <span class="at-progress-count" id="at-progress-count">0/${steps.length}</span>
      </div>
      <div class="at-progress-bar"><div class="at-progress-fill" id="at-progress-fill"></div></div>
      <div class="at-progress-stats" id="at-progress-stats"></div>
    </div>
    <div class="at-live-results" id="at-live-results"></div>
  `;

  try {
    const response = await fetch('/api/api-tester/auto-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps }),
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try { msg = (await response.json()).error || msg; } catch { /* malformed JSON */ }
      throw new Error(msg);
    }

    for await (const event of _readSSE(response)) {
      if (event.type === 'running') {
        _appendRunningItem(event);
        const label = document.getElementById('at-progress-label');
        if (label) label.textContent = `${event.method} ${event.label}`;
      } else if (event.type === 'result') {
        at.results.push(event);
        _updateResultItem(event);
        _updateAutoProgress(event.index + 1, event.total, event.passed, event.failed);
      } else if (event.type === 'done') {
        at.running = false;
        _updateAutoProgress(event.total, event.total, event.passed, event.failed);
        _showAutoTestDone(event);
        // Auto-trigger AI analysis
        setTimeout(() => analyzeWithAI(), 600);
      }
    }
  } catch (err) {
    at.running = false;
    showToast('Auto test failed: ' + err.message, 'error');
  }
}

function _updateAutoProgress(current, total, passed, failed) {
  const fill = document.getElementById('at-progress-fill');
  const count = document.getElementById('at-progress-count');
  const stats = document.getElementById('at-progress-stats');
  if (fill) fill.style.width = `${(current / total) * 100}%`;
  if (count) count.textContent = `${current}/${total}`;
  if (stats) stats.innerHTML = `<span class="at-autotest-pass">✓ ${passed}</span> <span class="at-autotest-fail">✗ ${failed}</span>`;
}

function _appendRunningItem(event) {
  const el = document.getElementById('at-live-results');
  if (!el) return;
  const methodCls = `at-method-${event.method.toLowerCase()}`;
  const item = document.createElement('div');
  item.className = 'at-live-item at-live-running';
  item.id = `at-live-${event.index}`;
  item.innerHTML = `
    <div class="at-live-spinner"></div>
    <span class="at-req-method ${methodCls}" style="font-size:.6rem">${event.method}</span>
    <span class="at-live-label">${esc(event.label)}</span>
    <span class="at-live-status">running...</span>
  `;
  el.appendChild(item);
  item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function _updateResultItem(event) {
  const item = document.getElementById(`at-live-${event.index}`);
  if (!item) return;
  const statusCls = event.pass ? 'at-status-2xx' : (event.result?.status >= 500 ? 'at-status-5xx' : 'at-status-4xx');
  const badge = event.pass ? '✓' : '✗';
  const badgeCls = event.pass ? 'at-live-pass' : 'at-live-fail';
  const status = event.result?.status || 'ERR';
  const time = event.result?.time ? `${event.result.time}ms` : '-';
  const methodCls = `at-method-${event.method.toLowerCase()}`;
  item.className = `at-live-item at-live-done ${badgeCls}`;
  item.innerHTML = `
    <span class="at-live-badge ${badgeCls}">${badge}</span>
    <span class="at-req-method ${methodCls}" style="font-size:.6rem">${event.method}</span>
    <span class="at-live-label">${esc(event.label || event.path || event.url)}</span>
    <span class="at-status-badge at-status-sm ${statusCls}">${status}</span>
    <span class="at-res-time">${time}</span>
  `;
}

function _showAutoTestDone(event) {
  const label = document.getElementById('at-progress-label');
  if (label) label.textContent = event.failed > 0 ? `Done — ${event.failed} failed` : 'All tests passed!';
  const fill = document.getElementById('at-progress-fill');
  if (fill) fill.classList.add(event.failed > 0 ? 'at-progress-warn' : 'at-progress-ok');
  const stats = document.getElementById('at-progress-stats');
  if (stats) stats.innerHTML += `<button class="btn btn-sm at-ai-btn" data-action="at-analyze-ai" style="margin-left:auto">AI Analyze</button>`;
}

// ═══════════════════════════════════════════════════════
// AI Analysis (SSE streaming)
// ═══════════════════════════════════════════════════════

async function analyzeWithAI() {
  const at = app.apiTester;
  if (!at.autoTest.results.length) { showToast('Run tests first', 'error'); return; }
  if (at.aiAnalyzing) return;
  at.aiAnalyzing = true;

  const analysisEl = document.getElementById('at-ai-analysis');
  if (!analysisEl) return;
  analysisEl.style.display = '';
  analysisEl.innerHTML = `
    <div class="at-ai-analysis-header">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      AI Analysis
      <span class="at-ai-typing">analyzing...</span>
    </div>
    <div class="at-ai-analysis-content" id="at-ai-stream"></div>
  `;

  let fullText = '';
  const contentEl = document.getElementById('at-ai-stream');

  try {
    const response = await fetch('/api/api-tester/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spec: at.swagger?.info || null,
        steps: at.autoTest.results.map(r => ({ method: r.method, url: r.url, label: r.label, path: r.path, expect: r.expect })),
        results: at.autoTest.results.map(r => ({ pass: r.pass, status: r.result?.status, time: r.result?.time, body: _truncateBody(r.result?.body), error: r.result?.error })),
      }),
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try { msg = (await response.json()).error || msg; } catch { /* malformed JSON */ }
      throw new Error(msg);
    }

    for await (const event of _readSSE(response)) {
      if (event.type === 'text') {
        fullText += event.delta;
        if (contentEl) contentEl.innerHTML = simpleMarkdown(fullText);
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }

    at.aiAnalysis = fullText;
  } catch (err) {
    if (analysisEl) analysisEl.innerHTML = `<div class="at-response-error"><div class="at-error-msg">${esc(err.message)}</div></div>`;
  } finally {
    at.aiAnalyzing = false;
    analysisEl?.querySelector('.at-ai-typing')?.remove();
  }
}

function _truncateBody(body) {
  if (body == null) return null;
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  return s.length > 500 ? s.slice(0, 500) + '...' : s;
}

// ─── Auth Config ───
function _renderAuthFields() {
  const type = document.getElementById('at-auth-type')?.value || 'none';
  const el = document.getElementById('at-auth-fields');
  if (!el) return;
  const saved = app.apiTester.authConfig || {};

  if (type === 'none') { el.innerHTML = ''; return; }
  if (type === 'bearer') {
    el.innerHTML = `<input type="text" class="at-url" id="at-auth-token" placeholder="Bearer token..." value="${esc(saved.token || '')}" style="width:100%;box-sizing:border-box">`;
  } else if (type === 'apikey') {
    el.innerHTML = `<div style="display:flex;gap:6px"><input type="text" class="at-url" id="at-auth-key-name" placeholder="Header name (e.g. X-API-Key)" value="${esc(saved.keyName || '')}" style="flex:1"><input type="text" class="at-url" id="at-auth-key-value" placeholder="Key value" value="${esc(saved.keyValue || '')}" style="flex:1"></div>`;
  } else if (type === 'basic') {
    el.innerHTML = `<div style="display:flex;gap:6px"><input type="text" class="at-url" id="at-auth-user" placeholder="Username" value="${esc(saved.user || '')}" style="flex:1"><input type="password" class="at-url" id="at-auth-pass" placeholder="Password" value="${esc(saved.pass || '')}" style="flex:1"></div>`;
  } else if (type === 'custom') {
    el.innerHTML = `<div style="display:flex;gap:6px"><input type="text" class="at-url" id="at-auth-hdr-name" placeholder="Header name" value="${esc(saved.hdrName || '')}" style="flex:1"><input type="text" class="at-url" id="at-auth-hdr-value" placeholder="Header value" value="${esc(saved.hdrValue || '')}" style="flex:1"></div>`;
  }
}

function _getAuthHeaders() {
  const type = document.getElementById('at-auth-type')?.value || 'none';
  const headers = {};
  if (type === 'bearer') {
    const token = document.getElementById('at-auth-token')?.value?.trim();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } else if (type === 'apikey') {
    const name = document.getElementById('at-auth-key-name')?.value?.trim();
    const value = document.getElementById('at-auth-key-value')?.value?.trim();
    if (name && value) headers[name] = value;
  } else if (type === 'basic') {
    const user = document.getElementById('at-auth-user')?.value || '';
    const pass = document.getElementById('at-auth-pass')?.value || '';
    if (user) headers['Authorization'] = `Basic ${btoa(user + ':' + pass)}`;
  } else if (type === 'custom') {
    const name = document.getElementById('at-auth-hdr-name')?.value?.trim();
    const value = document.getElementById('at-auth-hdr-value')?.value?.trim();
    if (name && value) headers[name] = value;
  }
  return headers;
}

// ─── Action Registration ───
registerClickActions({
  'at-send': sendRequest,
  'at-save': saveCurrentRequest,
  'at-new': newRequest,
  'at-config-tab': (el) => switchConfigTab(el.dataset.tab),
  'at-select': (el) => selectRequest(el.dataset.id),
  'at-delete': (el, e) => { e.stopPropagation(); deleteReq(el.dataset.id); },
  'at-import-swagger': openSwaggerImportDialog,
  'at-parse-swagger': parseSwagger,
  'at-fetch-swagger': fetchSwaggerUrl,
  'at-import-mode': (el) => _switchImportMode(el.dataset.mode),
  'at-sidebar-mode': (el) => switchSidebarMode(el.dataset.mode),
  'at-load-swagger-ep': (el) => loadSwaggerEndpoint(el.dataset.method, el.dataset.path),
  'at-toggle-ep': (el) => toggleEndpoint(el.dataset.key),
  'at-toggle-all-ep': toggleAllEndpoints,
  'at-open-auto-test': openAutoTestDialog,
  'at-run-get-tests': runGetTests,
  'at-run-crud': (el) => runCrudCycle(el.dataset.path),
  'at-run-all-crud': runAllCrudCycles,
  'at-analyze-ai': analyzeWithAI,
  'at-review-plan': reviewTestPlan,
  'at-run-reviewed-plan': runReviewedPlan,
  'at-run-raw': runRawSteps,
  'at-gen-ai-scenarios': generateAiScenarios,
  'at-run-ai-scenario': (el) => runAiScenario(+el.dataset.idx),
  'at-run-all-ai-scenarios': runAllAiScenarios,
});
registerInputActions({
  'at-swagger-filter': (el) => { app.apiTester.swaggerFilter = el.value; renderSwaggerList(); },
});
registerChangeActions({
  'at-toggle-ep-check': (el) => toggleEndpoint(el.dataset.key, el.checked),
  'at-auth-type-change': () => _renderAuthFields(),
});
