// ─── Pure Utility Functions ───

const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(s) {
  return s ? String(s).replace(/[&<>"']/g, c => _escMap[c]) : '';
}

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function timeAgo(v) {
  const ms = Date.now() - (v instanceof Date ? v : new Date(v)).getTime();
  if (isNaN(ms) || ms < 0) return '—';
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

export function showToast(message, type = 'info', duration = 3000, html = false) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  if (html) toast.innerHTML = message; else toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('exiting');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

export function fmtTok(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

export function timeUntil(isoStr) {
  const diff = new Date(isoStr) - new Date();
  if (diff <= 0) return 'now';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function row(label, val) {
  return `<div class="uc-stat-row"><span class="label">${label}</span><span class="val">${val}</span></div>`;
}

export function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ─── Simple Markdown Renderer ───
export function simpleMarkdown(md) {
  let html = '';
  const lines = md.split('\n');
  let inCode = false, codeBlock = '', inList = false, listType = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (inCode) { html += `<pre><code>${codeBlock}</code></pre>`; codeBlock = ''; }
      inCode = !inCode; continue;
    }
    if (inCode) { codeBlock += esc(line) + '\n'; continue; }
    if (inList && !/^(\s*[-*]|\s*\d+\.)/.test(line)) {
      html += `</${listType}>`; inList = false;
    }
    if (/^### (.+)/.test(line)) { html += `<h3>${inline(line.slice(4))}</h3>`; continue; }
    if (/^## (.+)/.test(line)) { html += `<h2>${inline(line.slice(3))}</h2>`; continue; }
    if (/^# (.+)/.test(line)) { html += `<h1>${inline(line.slice(2))}</h1>`; continue; }
    if (/^---\s*$/.test(line)) { html += '<hr>'; continue; }
    if (/^>\s?(.*)/.test(line)) { html += `<blockquote><p>${inline(line.slice(2))}</p></blockquote>`; continue; }
    if (/^\|(.+)\|/.test(line)) {
      let tableHtml = '<table>';
      while (i < lines.length && /^\|(.+)\|/.test(lines[i])) {
        const cells = lines[i].split('|').filter(Boolean).map(c => c.trim());
        if (cells.every(c => /^[-:]+$/.test(c))) { i++; continue; }
        const tag = tableHtml === '<table>' ? 'th' : 'td';
        tableHtml += '<tr>' + cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>';
        i++;
      }
      i--; html += tableHtml + '</table>'; continue;
    }
    if (/^\s*[-*] (.+)/.test(line)) {
      if (!inList || listType !== 'ul') { if (inList) html += `</${listType}>`; html += '<ul>'; inList = true; listType = 'ul'; }
      html += `<li>${inline(line.replace(/^\s*[-*] /, ''))}</li>`; continue;
    }
    if (/^\s*\d+\. (.+)/.test(line)) {
      if (!inList || listType !== 'ol') { if (inList) html += `</${listType}>`; html += '<ol>'; inList = true; listType = 'ol'; }
      html += `<li>${inline(line.replace(/^\s*\d+\. /, ''))}</li>`; continue;
    }
    if (!line.trim()) { html += ''; continue; }
    html += `<p>${inline(line)}</p>`;
  }
  if (inCode) html += `<pre><code>${codeBlock}</code></pre>`;
  if (inList) html += `</${listType}>`;
  return html;
  // MINOR-1: HTML-escape input first, then apply markdown transforms
  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
        // Decode escaped entities back for URL validation
        const rawUrl = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        return /^https?:\/\//.test(rawUrl) ? `<a href="${url}" target="_blank">${text}</a>` : text;
      });
  }
}

// ─── HTML Sanitizer for trusted-but-untrusted content (e.g. Jira rendered HTML) ───
const SAFE_TAGS = new Set([
  'p', 'br', 'b', 'i', 'em', 'strong', 'u', 's', 'del', 'ins', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'div', 'span', 'hr', 'dd', 'dl', 'dt', 'figure', 'figcaption'
]);
const SAFE_ATTRS = new Set(['href', 'src', 'alt', 'title', 'class', 'colspan', 'rowspan', 'width', 'height']);

export function sanitizeHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  function walk(node) {
    const frag = document.createDocumentFragment();
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        frag.appendChild(document.createTextNode(child.textContent));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (!SAFE_TAGS.has(tag)) {
          // Unwrap: keep children, drop the tag
          frag.appendChild(walk(child));
          continue;
        }
        const el = document.createElement(tag);
        for (const attr of child.attributes) {
          if (!SAFE_ATTRS.has(attr.name.toLowerCase())) continue;
          // Block javascript: URIs in href/src
          if ((attr.name === 'href' || attr.name === 'src') && /^\s*javascript:/i.test(attr.value)) continue;
          el.setAttribute(attr.name, attr.value);
        }
        // Force external links to open in new tab
        if (tag === 'a') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
        el.appendChild(walk(child));
        frag.appendChild(el);
      }
    }
    return frag;
  }
  const container = document.createElement('div');
  container.appendChild(walk(doc.body));
  return container.innerHTML;
}

export const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico']);

export const DIFF_LINE_LIMIT = 500;
