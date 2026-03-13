// ─── Project Plan Routes ───
import {
  generatePlan, approvePlan, executePlan, stopPlan, deletePlan,
  getPlan, listPlans, saveUploadedImage, getImagePath,
} from '../lib/project-plan.js';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

export function register(ctx) {
  const { addRoute, json, readBody, rateLimit, LIMITS } = ctx;

  // List all plans
  addRoute('GET', '/api/project-plan/runs', (_req, res) => {
    json(res, listPlans());
  });

  // Get single plan
  addRoute('GET', '/api/project-plan/runs/:id', (req, res) => {
    const plan = getPlan(req.params.id);
    if (!plan) return json(res, { error: 'Not found' }, 404);
    json(res, plan);
  });

  // Generate plan (AI analysis)
  addRoute('POST', '/api/project-plan/generate', async (req, res) => {
    if (!rateLimit(`plan:gen:${req.socket?.remoteAddress}`, 3)) {
      return json(res, { error: 'Rate limit exceeded' }, 429);
    }
    const body = await readBody(req);
    if (!body.projectId || !body.description) {
      return json(res, { error: 'projectId and description required' }, 400);
    }
    try {
      const result = await generatePlan(body.projectId, body.description, body.images || []);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  // Approve plan (with optional edits)
  addRoute('POST', '/api/project-plan/approve/:id', async (req, res) => {
    const body = await readBody(req);
    try {
      const result = approvePlan(req.params.id, body.features || null);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // Execute approved plan
  addRoute('POST', '/api/project-plan/execute/:id', async (req, res) => {
    try {
      const result = await executePlan(req.params.id);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // Stop running plan
  addRoute('POST', '/api/project-plan/stop/:id', async (req, res) => {
    try {
      const result = await stopPlan(req.params.id);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // Delete plan
  addRoute('DELETE', '/api/project-plan/:id', (req, res) => {
    try {
      deletePlan(req.params.id);
      json(res, { deleted: true });
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // Upload image for plan (JSON with base64 data)
  addRoute('POST', '/api/project-plan/upload', async (req, res) => {
    try {
      // Collect raw body
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 10 * 1024 * 1024) throw new Error('File too large (max 10MB)');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';

      if (ct.includes('multipart')) {
        const boundaryMatch = ct.match(/boundary=(.+)/);
        if (!boundaryMatch) return json(res, { error: 'Invalid multipart' }, 400);
        const parts = parseMultipart(raw, boundaryMatch[1]);
        const filePart = parts.find(p => p.filename);
        const planIdPart = parts.find(p => p.name === 'planId');
        if (!filePart || !planIdPart) return json(res, { error: 'File and planId required' }, 400);
        const result = saveUploadedImage(planIdPart.data.toString().trim(), filePart.filename, filePart.data);
        return json(res, result);
      }

      // JSON with base64
      const jbody = JSON.parse(raw.toString('utf8'));
      if (!jbody.planId || !jbody.filename || !jbody.data) {
        return json(res, { error: 'planId, filename, data required' }, 400);
      }
      const buf = Buffer.from(jbody.data, 'base64');
      const result = saveUploadedImage(jbody.planId, jbody.filename, buf);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  // Serve uploaded image
  addRoute('GET', '/api/project-plan/image/:planId/:file', (req, res) => {
    const fp = getImagePath(req.params.planId, req.params.file);
    if (!fp) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = extname(req.params.file).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const data = readFileSync(fp);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    res.end(data);
  });
}

// Minimal multipart parser
function parseMultipart(buf, boundary) {
  const parts = [];
  const sep = Buffer.from(`--${boundary}`);
  let start = 0;
  while (true) {
    const idx = buf.indexOf(sep, start);
    if (idx === -1) break;
    if (start > 0) {
      const chunk = buf.slice(start, idx);
      const headerEnd = chunk.indexOf('\r\n\r\n');
      if (headerEnd > -1) {
        const headerStr = chunk.slice(0, headerEnd).toString();
        const data = chunk.slice(headerEnd + 4, chunk.length - 2); // trim trailing \r\n
        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const fileMatch = headerStr.match(/filename="([^"]+)"/);
        parts.push({
          name: nameMatch?.[1] || '',
          filename: fileMatch?.[1] || '',
          data,
        });
      }
    }
    start = idx + sep.length + 2; // skip \r\n after boundary
  }
  return parts;
}
