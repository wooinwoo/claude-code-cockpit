// ─── API Tester Module ───
import { app } from './state.js';
import { esc, showToast, fetchJson, postJson } from './utils.js';
import { registerClickActions } from './actions.js';

const MAX_HISTORY = 30;
let _requestHistory = [];
let _resBodyMode = 'pretty'; // 'pretty' | 'raw'

function _timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
  return Math.floor(d / 86400000) + 'd ago';
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
  } catch (err) {
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
  } catch (err) {
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

// ─── Action Registration ───
registerClickActions({
  'at-send': sendRequest,
  'at-save': saveCurrentRequest,
  'at-new': newRequest,
  'at-config-tab': (el) => switchConfigTab(el.dataset.tab),
  'at-select': (el) => selectRequest(el.dataset.id),
  'at-delete': (el, e) => { e.stopPropagation(); deleteReq(el.dataset.id); },
});
