// ─── API Tester Routes ───
import {
  executeRequest,
  listRequests, getRequest, createRequest, updateRequest, deleteRequest,
} from '../lib/api-tester-service.js';
import {
  parseSwaggerSpec,
} from '../lib/swagger-service.js';

export function register(ctx) {
  const { addRoute, json, readBody, isLocalhost, PORT, __dirname, callClaudeStream } = ctx;

  // Execute HTTP request (proxy)
  addRoute('POST', '/api/api-tester/execute', async (req, res) => {
    if (!isLocalhost(req)) { json(res, { error: 'Forbidden' }, 403); return; }
    const body = await readBody(req);
    if (!body?.url) { json(res, { error: 'URL is required' }, 400); return; }
    try {
      const result = await executeRequest(body, PORT);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // Saved requests CRUD
  addRoute('GET', '/api/api-tester/requests', async (_req, res) => {
    try { json(res, await listRequests(__dirname)); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('GET', '/api/api-tester/requests/:id', async (req, res) => {
    const request = await getRequest(__dirname, req.params.id);
    if (!request) return json(res, { error: 'Not found' }, 404);
    json(res, request);
  });

  addRoute('POST', '/api/api-tester/requests', async (req, res) => {
    const body = await readBody(req);
    try { json(res, await createRequest(__dirname, body), 201); }
    catch (err) { json(res, { error: err.message }, 500); }
  });

  addRoute('PUT', '/api/api-tester/requests/:id', async (req, res) => {
    const body = await readBody(req);
    const request = await updateRequest(__dirname, req.params.id, body);
    if (!request) return json(res, { error: 'Not found' }, 404);
    json(res, request);
  });

  addRoute('DELETE', '/api/api-tester/requests/:id', async (req, res) => {
    const ok = await deleteRequest(__dirname, req.params.id);
    if (!ok) return json(res, { error: 'Not found' }, 404);
    json(res, { deleted: true });
  });

  // ─── Swagger Fetch from URL ───
  addRoute('POST', '/api/api-tester/swagger/fetch', async (req, res) => {
    if (!isLocalhost(req)) return json(res, { error: 'Forbidden' }, 403);
    const body = await readBody(req);
    if (!body?.url) return json(res, { error: 'url is required' }, 400);

    let parsed;
    try { parsed = new URL(body.url); } catch { return json(res, { error: 'Invalid URL' }, 400); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return json(res, { error: 'Only http/https allowed' }, 400);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(body.url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

      const text = await resp.text();
      let spec;
      try { spec = JSON.parse(text); }
      catch { throw new Error('Response is not valid JSON'); }

      const result = parseSwaggerSpec(spec);
      json(res, result);
    } catch (err) {
      if (err.name === 'AbortError') return json(res, { error: 'Request timed out (15s)' }, 400);
      json(res, { error: err.message }, 400);
    }
  });

  // ─── Swagger Parse ───
  addRoute('POST', '/api/api-tester/swagger/parse', async (req, res) => {
    if (!isLocalhost(req)) return json(res, { error: 'Forbidden' }, 403);
    const body = await readBody(req);
    if (!body?.spec || typeof body.spec !== 'object') {
      return json(res, { error: 'spec (JSON object) is required' }, 400);
    }
    try {
      const result = parseSwaggerSpec(body.spec);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });

  // ─── Auto Test (SSE streaming) ───
  addRoute('POST', '/api/api-tester/auto-test', async (req, res) => {
    if (!isLocalhost(req)) return json(res, { error: 'Forbidden' }, 403);
    const body = await readBody(req);
    if (!Array.isArray(body?.steps) || !body.steps.length) {
      return json(res, { error: 'steps[] is required' }, 400);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let aborted = false;
    req.on('close', () => { aborted = true; });
    const emit = (d) => { if (!aborted) res.write(`data: ${JSON.stringify(d)}\n\n`); };

    const total = body.steps.length;
    let extractedId = null;
    let passed = 0, failed = 0;

    emit({ type: 'start', total });

    for (let i = 0; i < body.steps.length; i++) {
      if (aborted) break;
      const step = body.steps[i];
      let url = step.url;
      if (extractedId != null) url = url.replace(/\{id\}/g, String(extractedId));

      emit({ type: 'running', index: i, method: step.method, label: step.label || step.path || url });

      try {
        const result = await executeRequest({
          method: step.method, url,
          headers: step.headers || {},
          body: step.body || null,
          timeout: step.timeout || 15000,
        }, PORT);

        let pass = false;
        if (step.expect) {
          if (step.expect.status) pass = result.status === step.expect.status;
          else if (step.expect.statusRange === '2xx') pass = result.status >= 200 && result.status < 300;
        } else {
          pass = result.status >= 200 && result.status < 300;
        }

        if (step.extractId && pass && result.body) {
          const b = typeof result.body === 'string' ? _tryParse(result.body) : result.body;
          extractedId = b?.id ?? b?._id ?? b?.data?.id ?? b?.data?._id ?? null;
        }

        if (pass) passed++; else failed++;
        emit({ type: 'result', index: i, method: step.method, url, path: step.path, label: step.label, result, pass, passed, failed, total });
      } catch (err) {
        failed++;
        emit({ type: 'result', index: i, method: step.method, url, path: step.path, label: step.label, result: { error: err.message }, pass: false, passed, failed, total });
      }
    }

    emit({ type: 'done', passed, failed, total });
    res.end();
  });

  // ─── AI Analyze (Claude CLI SSE streaming) ───
  addRoute('POST', '/api/api-tester/analyze', async (req, res) => {
    if (!isLocalhost(req)) return json(res, { error: 'Forbidden' }, 403);
    const body = await readBody(req);
    if (!body?.results) return json(res, { error: 'results required' }, 400);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let aborted = false;
    req.on('close', () => { aborted = true; });
    const emit = (d) => { if (!aborted) res.write(`data: ${JSON.stringify(d)}\n\n`); };

    const systemPrompt = 'You are an API testing expert. Analyze the following API test results. Provide analysis in Korean:\n1. Test Coverage: missing endpoints, missing error cases\n2. CRUD Cycle Integrity: correct order, ID chaining\n3. Failed Test Analysis: root causes and fix suggestions\n4. Response Data Anomalies: empty arrays, unexpected schemas\n5. Overall Score and Improvement Suggestions\n\nBe concise but thorough. Use markdown formatting.';

    const userContent = JSON.stringify({
      spec: body.spec || null,
      steps: body.steps || [],
      results: body.results,
    }, null, 2);

    try {
      await callClaudeStream(userContent, {
        model: 'sonnet',
        systemPrompt,
        timeoutMs: 120000,
        onChunk: (text) => emit({ type: 'text', delta: text }),
      });
      emit({ type: 'done' });
    } catch (err) {
      emit({ type: 'error', message: 'AI analysis failed: ' + err.message });
    }
    res.end();
  });

  // ─── AI Review Plan (Claude CLI SSE streaming) ───
  addRoute('POST', '/api/api-tester/review-plan', async (req, res) => {
    if (!isLocalhost(req)) return json(res, { error: 'Forbidden' }, 403);
    const body = await readBody(req);
    if (!body?.spec || !Array.isArray(body?.steps)) return json(res, { error: 'spec and steps[] required' }, 400);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let aborted = false;
    req.on('close', () => { aborted = true; });
    const emit = (d) => { if (!aborted) res.write(`data: ${JSON.stringify(d)}\n\n`); };

    const baseUrl = body.baseUrl || '';

    const systemPrompt = `You are an API testing expert and test planner. You receive an OpenAPI/Swagger spec summary and auto-generated test steps. Your job is to REVIEW, REFINE, and REORDER these steps into an optimal test plan.

Respond in Korean with TWO parts:

**Part 1: Review Commentary (markdown)**
- 제거한 스텝과 이유 (위험한 엔드포인트, 불필요한 중복 등)
- 순서 변경 이유 (의존성, 선행조건 등)
- 추가한 스텝과 이유 (누락된 중요 테스트)
- 수정한 스텝 (expect 값 보정, 헤더 추가 등)
- 주의사항 (프로덕션 위험, 부작용 가능성 등)

**Part 2: JSON code block with the refined steps**
\`\`\`json
[
  {
    "method": "GET|POST|PUT|PATCH|DELETE",
    "url": "${baseUrl}/full/path",
    "path": "/path",
    "headers": {"Content-Type": "application/json"},
    "body": "{\\"key\\":\\"value\\"}",
    "label": "Step description in Korean",
    "expect": {"status": 200},
    "extractId": false,
    "group": "GET|CRUD:resourceName|custom"
  }
]
\`\`\`

Rules:
- DELETE on admin/system resources: REMOVE and explain why
- If a POST (create) exists, ensure GET/PUT/DELETE for same resource come AFTER it
- Add extractId:true on create steps so subsequent steps can use {id}
- If auth is required but no auth scheme detected, warn about it
- Merge duplicate tests (same method+path)
- Add meaningful Korean labels describing what each step tests
- Keep the "group" field to identify which section each step belongs to
- If endpoints look dangerous (drop, reset, truncate, admin), exclude with warning
- Order: health/status checks → GET list endpoints → CRUD cycles → edge cases
- Be practical: don't remove steps unnecessarily, only when there's a real reason`;

    const userContent = JSON.stringify({
      spec: body.spec,
      autoGeneratedSteps: body.steps,
      securitySchemes: body.securitySchemes || [],
      baseUrl,
    }, null, 2);

    let fullText = '';
    try {
      await callClaudeStream(userContent, {
        model: 'sonnet',
        systemPrompt,
        timeoutMs: 120000,
        onChunk: (text) => {
          fullText += text;
          emit({ type: 'text', delta: text });
        },
      });

      // Extract refined plan from JSON block
      const jsonMatch = fullText.match(/```json\s*\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        try {
          const plan = JSON.parse(jsonMatch[1]);
          if (Array.isArray(plan)) {
            emit({ type: 'plan', steps: plan });
          }
        } catch { /* malformed JSON */ }
      }

      emit({ type: 'done' });
    } catch (err) {
      emit({ type: 'error', message: 'Plan review failed: ' + err.message });
    }
    res.end();
  });

  // ─── AI Scenario Generation (Claude CLI SSE streaming) ───
  addRoute('POST', '/api/api-tester/generate-scenarios', async (req, res) => {
    if (!isLocalhost(req)) return json(res, { error: 'Forbidden' }, 403);
    const body = await readBody(req);
    if (!body?.spec) return json(res, { error: 'spec required' }, 400);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let aborted = false;
    req.on('close', () => { aborted = true; });
    const emit = (d) => { if (!aborted) res.write(`data: ${JSON.stringify(d)}\n\n`); };

    const baseUrl = body.baseUrl || '';

    const systemPrompt = `You are an API testing expert. Given an OpenAPI/Swagger spec summary, generate test scenarios.

Output TWO parts:
1. A brief Korean description of what scenarios you're generating and why
2. A JSON code block with executable test scenarios

The JSON must be a valid array of scenario objects:
\`\`\`json
[
  {
    "name": "Scenario name",
    "steps": [
      {
        "method": "GET|POST|PUT|PATCH|DELETE",
        "url": "${baseUrl}/full/path",
        "path": "/path",
        "headers": {"Content-Type": "application/json"},
        "body": "{\\"key\\":\\"value\\"}",
        "label": "Step description",
        "expect": {"status": 200}
      }
    ]
  }
]
\`\`\`

Generate scenarios for:
- Edge cases (empty body, missing required fields, invalid types)
- Auth failures (no token, invalid token, expired token)
- Boundary values (very long strings, negative numbers, zero, max int)
- Not found (invalid IDs, deleted resources)
- Method not allowed
- Duplicate creation
- Pagination edge cases (page=0, page=-1, huge limit)

Use the actual endpoints from the spec. Be practical — only generate scenarios that make sense for the given API.`;

    const userContent = JSON.stringify(body.spec, null, 2);

    let fullText = '';
    try {
      await callClaudeStream(userContent, {
        model: 'sonnet',
        systemPrompt,
        timeoutMs: 120000,
        onChunk: (text) => {
          fullText += text;
          emit({ type: 'text', delta: text });
        },
      });

      // Try to extract JSON scenarios from the response
      const jsonMatch = fullText.match(/```json\s*\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        try {
          const scenarios = JSON.parse(jsonMatch[1]);
          if (Array.isArray(scenarios)) {
            emit({ type: 'scenarios', scenarios });
          }
        } catch { /* malformed JSON */ }
      }

      emit({ type: 'done' });
    } catch (err) {
      emit({ type: 'error', message: 'Scenario generation failed: ' + err.message });
    }
    res.end();
  });
}

function _tryParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
