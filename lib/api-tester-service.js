// ─── API Tester Service: HTTP proxy execution + saved request CRUD ───
import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_TIMEOUT = 60000; // 60s
const DEFAULT_TIMEOUT = 30000; // 30s
const ALLOWED_SCHEMES = ['http:', 'https:'];

let REQUESTS_DIR;

function init(baseDir) {
  REQUESTS_DIR = join(baseDir, 'api-tests');
}

function ensureInit() {
  if (!REQUESTS_DIR) throw new Error('api-tester-service not initialized');
}

async function ensureDir() {
  ensureInit();
  if (!existsSync(REQUESTS_DIR)) await mkdir(REQUESTS_DIR, { recursive: true });
}

function isValidId(id) { return /^[a-f0-9]+$/.test(id); }

// ─── Execute HTTP Request ───

export async function executeRequest({ method, url, headers, body, timeout }, serverPort) {
  // Validate URL
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    throw new Error(`Only http/https allowed, got ${parsed.protocol}`);
  }

  // SSRF: block requests to self
  const selfHosts = ['localhost', '127.0.0.1', '[::1]'];
  if (selfHosts.includes(parsed.hostname) && String(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) === String(serverPort)) {
    throw new Error('Cannot send requests to the Cockpit server itself');
  }

  const timeoutMs = Math.min(Math.max(timeout || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const fetchOpts = {
    method: method || 'GET',
    headers: headers || {},
    signal: controller.signal,
  };

  // Only add body for methods that support it
  if (body && !['GET', 'HEAD'].includes(method?.toUpperCase())) {
    fetchOpts.body = body;
  }

  const startTime = Date.now();
  try {
    const res = await fetch(url, fetchOpts);
    const elapsed = Date.now() - startTime;

    // Read response with size limit
    const chunks = [];
    let totalSize = 0;
    const reader = res.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.length;
        if (totalSize > MAX_RESPONSE_SIZE) {
          reader.cancel();
          throw new Error('Response too large (>5MB)');
        }
        chunks.push(value);
      }
    }

    const bodyBuffer = Buffer.concat(chunks);
    const bodyText = bodyBuffer.toString('utf-8');
    const contentType = res.headers.get('content-type') || '';

    // Try to parse as JSON for pretty display
    let bodyParsed = bodyText;
    if (contentType.includes('application/json')) {
      try { bodyParsed = JSON.parse(bodyText); } catch { /* keep as text */ }
    }

    // Convert headers to plain object
    const resHeaders = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });

    return {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
      body: bodyParsed,
      contentType,
      time: elapsed,
      size: totalSize,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out (${timeoutMs}ms)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Saved Request CRUD ───

export async function listRequests(baseDir) {
  init(baseDir);
  await ensureDir();
  const files = await readdir(REQUESTS_DIR);
  const requests = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(REQUESTS_DIR, f), 'utf8');
      const req = JSON.parse(raw);
      requests.push({
        id: req.id,
        name: req.name,
        collection: req.collection || '',
        method: req.method,
        url: req.url,
        updatedAt: req.updatedAt,
      });
    } catch { /* skip corrupt */ }
  }
  requests.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return requests;
}

export async function getRequest(baseDir, id) {
  init(baseDir);
  if (!isValidId(id)) return null;
  const path = join(REQUESTS_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function createRequest(baseDir, data) {
  init(baseDir);
  await ensureDir();
  const id = randomBytes(8).toString('hex');
  const now = Date.now();
  const request = {
    id,
    name: data.name || 'Untitled',
    collection: data.collection || '',
    method: data.method || 'GET',
    url: data.url || '',
    headers: data.headers || [],
    params: data.params || [],
    body: data.body || '',
    bodyType: data.bodyType || 'none',
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(join(REQUESTS_DIR, `${id}.json`), JSON.stringify(request, null, 2), 'utf8');
  return request;
}

export async function updateRequest(baseDir, id, updates) {
  init(baseDir);
  const request = await getRequest(baseDir, id);
  if (!request) return null;
  const allowed = ['name', 'collection', 'method', 'url', 'headers', 'params', 'body', 'bodyType'];
  for (const k of allowed) {
    if (updates[k] !== undefined) request[k] = updates[k];
  }
  request.updatedAt = Date.now();
  await writeFile(join(REQUESTS_DIR, `${id}.json`), JSON.stringify(request, null, 2), 'utf8');
  return request;
}

export async function deleteRequest(baseDir, id) {
  init(baseDir);
  if (!isValidId(id)) return false;
  const path = join(REQUESTS_DIR, `${id}.json`);
  if (!existsSync(path)) return false;
  await unlink(path);
  return true;
}
