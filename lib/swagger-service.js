// ─── Swagger/OpenAPI Parser Service ───
// Pure JS, no dependencies. Supports Swagger 2.0 and OpenAPI 3.x.

const MAX_REF_DEPTH = 10;
const MAX_SCHEMA_DEPTH = 5;

// ─── Main Parser ───

export function parseSwaggerSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Invalid spec: expected JSON object');

  const isSwagger2 = spec.swagger && spec.swagger.startsWith('2.');
  const isOpenAPI3 = spec.openapi && spec.openapi.startsWith('3.');
  if (!isSwagger2 && !isOpenAPI3) throw new Error('Unsupported spec: requires swagger 2.0 or openapi 3.x');

  const info = spec.info || { title: 'Unknown', version: '0.0.0' };
  const servers = isSwagger2 ? _swagger2Servers(spec) : (spec.servers || []);
  const defs = isSwagger2 ? (spec.definitions || {}) : (spec.components?.schemas || {});
  const allDefs = isSwagger2 ? spec : spec; // full spec for $ref resolution

  const endpoints = [];
  const tagsSet = new Set();

  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (method.startsWith('x-') || method === 'parameters') continue;
      const m = method.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(m)) continue;

      const tags = op.tags || ['default'];
      tags.forEach(t => tagsSet.add(t));

      const parameters = _mergeParams(methods.parameters, op.parameters, allDefs);
      const requestBody = isSwagger2
        ? _swagger2Body(parameters)
        : _resolveRef(op.requestBody, allDefs);

      endpoints.push({
        method: m,
        path,
        summary: op.summary || '',
        tags,
        parameters: parameters.filter(p => p.in !== 'body'),
        requestBody,
        responses: op.responses || {},
        operationId: op.operationId || '',
      });
    }
  }

  const resources = detectCrudResources(endpoints);

  // Extract security schemes
  const securitySchemes = isSwagger2
    ? _swagger2SecuritySchemes(spec.securityDefinitions || {})
    : _openapi3SecuritySchemes(spec.components?.securitySchemes || {});

  return {
    info,
    servers,
    endpoints,
    resources,
    tags: [...tagsSet].sort(),
    defs,
    securitySchemes,
  };
}

// ─── Swagger 2.0 → servers ───

function _swagger2Servers(spec) {
  const schemes = spec.schemes || ['https'];
  const host = spec.host || 'localhost';
  const basePath = spec.basePath || '';
  return schemes.map(s => ({ url: `${s}://${host}${basePath}` }));
}

// ─── Merge path-level + operation-level parameters ───

function _mergeParams(pathParams, opParams, spec) {
  const map = new Map();
  for (const p of (pathParams || [])) {
    const resolved = _resolveRef(p, spec);
    if (resolved) map.set(`${resolved.in}:${resolved.name}`, resolved);
  }
  for (const p of (opParams || [])) {
    const resolved = _resolveRef(p, spec);
    if (resolved) map.set(`${resolved.in}:${resolved.name}`, resolved);
  }
  return [...map.values()];
}

// ─── Swagger 2.0: extract body param as requestBody ───

function _swagger2Body(params) {
  const bodyParam = params.find(p => p.in === 'body');
  if (!bodyParam) return null;
  return {
    required: bodyParam.required || false,
    content: {
      'application/json': {
        schema: bodyParam.schema || {},
      },
    },
  };
}

// ─── $ref Resolution ───

function _resolveRef(obj, spec, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > MAX_REF_DEPTH) return obj;
  if (!obj.$ref) return obj;

  const refPath = obj.$ref;
  if (!refPath.startsWith('#/')) return obj; // only local refs

  const parts = refPath.slice(2).split('/');
  let current = spec;
  for (const part of parts) {
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
    current = current?.[decoded];
    if (current === undefined) return obj; // unresolvable
  }
  return _resolveRef(current, spec, depth + 1);
}

// Deep resolve refs in a schema
function _deepResolveRefs(obj, spec, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > MAX_REF_DEPTH) return obj;
  if (obj.$ref) return _deepResolveRefs(_resolveRef(obj, spec), spec, depth + 1);
  if (Array.isArray(obj)) return obj.map(item => _deepResolveRefs(item, spec, depth + 1));
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = _deepResolveRefs(v, spec, depth + 1);
  }
  return result;
}

// ─── Security Scheme Extraction ───

function _swagger2SecuritySchemes(defs) {
  const result = [];
  for (const [name, def] of Object.entries(defs)) {
    if (def.type === 'apiKey') {
      result.push({ name, type: 'apikey', in: def.in, keyName: def.name });
    } else if (def.type === 'oauth2') {
      result.push({ name, type: 'bearer', hint: 'OAuth2 — use Bearer token' });
    } else if (def.type === 'basic') {
      result.push({ name, type: 'basic' });
    }
  }
  return result;
}

function _openapi3SecuritySchemes(schemes) {
  const result = [];
  for (const [name, def] of Object.entries(schemes)) {
    if (def.type === 'http' && def.scheme === 'bearer') {
      result.push({ name, type: 'bearer' });
    } else if (def.type === 'http' && def.scheme === 'basic') {
      result.push({ name, type: 'basic' });
    } else if (def.type === 'apiKey') {
      result.push({ name, type: 'apikey', in: def.in, keyName: def.name });
    } else if (def.type === 'oauth2') {
      result.push({ name, type: 'bearer', hint: 'OAuth2 — use Bearer token' });
    } else if (def.type === 'openIdConnect') {
      result.push({ name, type: 'bearer', hint: 'OpenID Connect — use Bearer token' });
    }
  }
  return result;
}

// ─── CRUD Resource Detection ───

export function detectCrudResources(endpoints) {
  // Group by base resource: /pets/{id} → /pets
  const groups = new Map();

  for (const ep of endpoints) {
    const base = ep.path.replace(/\/\{[^}]+\}$/, '');
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(ep);
  }

  const resources = [];
  for (const [basePath, eps] of groups) {
    const _hasParam = eps.some(e => e.path !== basePath); // has /{id} variant
    const methods = new Map(eps.map(e => [`${e.method}:${e.path === basePath ? 'base' : 'item'}`, e]));

    const create = methods.get('POST:base') || null;
    const list = methods.get('GET:base') || null;
    const readOne = methods.get('GET:item') || null;
    const update = methods.get('PUT:item') || methods.get('PATCH:item') || null;
    const del = methods.get('DELETE:item') || null;

    // Must have at least create + (readOne or delete) to qualify
    if (create && (readOne || del)) {
      resources.push({
        basePath,
        name: basePath.split('/').filter(Boolean).pop() || basePath,
        create,
        list,
        readOne,
        update,
        delete: del,
        steps: [create, readOne, update, del].filter(Boolean),
      });
    }
  }
  return resources;
}

// ─── Sample Data Generation ───

export function generateSampleFromSchema(schema, spec, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > MAX_SCHEMA_DEPTH) return null;

  // Resolve ref first
  const resolved = schema.$ref ? _resolveRef(schema, spec) : schema;
  if (!resolved || typeof resolved !== 'object') return null;

  // Use example/default if available
  if (resolved.example !== undefined) return resolved.example;
  if (resolved.default !== undefined) return resolved.default;

  const type = resolved.type;

  if (resolved.enum && resolved.enum.length > 0) return resolved.enum[0];

  if (type === 'string') {
    if (resolved.format === 'date') return '2024-01-01';
    if (resolved.format === 'date-time') return '2024-01-01T00:00:00Z';
    if (resolved.format === 'email') return 'user@example.com';
    if (resolved.format === 'uri' || resolved.format === 'url') return 'https://example.com';
    if (resolved.format === 'uuid') return '550e8400-e29b-41d4-a716-446655440000';
    return 'sample';
  }
  if (type === 'integer' || type === 'number') return resolved.minimum != null ? resolved.minimum : 1;
  if (type === 'boolean') return true;
  if (type === 'array') {
    const item = generateSampleFromSchema(resolved.items, spec, depth + 1);
    return item !== null ? [item] : [];
  }
  if (type === 'object' || resolved.properties) {
    const obj = {};
    for (const [key, propSchema] of Object.entries(resolved.properties || {})) {
      const val = generateSampleFromSchema(propSchema, spec, depth + 1);
      if (val !== null) obj[key] = val;
    }
    return obj;
  }

  // allOf / oneOf / anyOf
  if (resolved.allOf) {
    const merged = {};
    for (const sub of resolved.allOf) {
      const val = generateSampleFromSchema(sub, spec, depth + 1);
      if (val && typeof val === 'object') Object.assign(merged, val);
    }
    return Object.keys(merged).length ? merged : null;
  }
  if (resolved.oneOf || resolved.anyOf) {
    const choices = resolved.oneOf || resolved.anyOf;
    return generateSampleFromSchema(choices[0], spec, depth + 1);
  }

  return null;
}

// ─── Build Auto-Test Steps ───

export function buildGetTestSteps(endpoints, baseUrl, excluded) {
  return endpoints
    .filter(ep => ep.method === 'GET' && !excluded.has(`GET:${ep.path}`))
    .filter(ep => !ep.path.match(/\{[^}]+\}/)) // skip parameterized paths for GET auto-test
    .map(ep => ({
      method: 'GET',
      url: `${baseUrl}${ep.path}`,
      path: ep.path,
      headers: { 'Accept': 'application/json' },
      expect: { statusRange: '2xx' },
    }));
}

export function buildCrudSteps(resource, baseUrl, spec, excluded) {
  const steps = [];
  const itemPath = resource.basePath + '/{id}';

  if (resource.create && !excluded.has(`POST:${resource.basePath}`)) {
    const schema = _getRequestBodySchema(resource.create);
    const sample = schema ? generateSampleFromSchema(schema, spec) : {};
    steps.push({
      method: 'POST',
      url: `${baseUrl}${resource.basePath}`,
      path: resource.basePath,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(sample || {}),
      extractId: true,
      label: 'Create',
      expect: { statusRange: '2xx' },
    });
  }

  if (resource.readOne && !excluded.has(`GET:${itemPath}`)) {
    steps.push({
      method: 'GET',
      url: `${baseUrl}${itemPath}`,
      path: itemPath,
      headers: { 'Accept': 'application/json' },
      label: 'Read',
      expect: { statusRange: '2xx' },
    });
  }

  if (resource.update) {
    const m = resource.update.method;
    if (!excluded.has(`${m}:${itemPath}`)) {
      const schema = _getRequestBodySchema(resource.update);
      const sample = schema ? generateSampleFromSchema(schema, spec) : {};
      steps.push({
        method: m,
        url: `${baseUrl}${itemPath}`,
        path: itemPath,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(sample || {}),
        label: 'Update',
        expect: { statusRange: '2xx' },
      });
    }
  }

  if (resource.delete && !excluded.has(`DELETE:${itemPath}`)) {
    steps.push({
      method: 'DELETE',
      url: `${baseUrl}${itemPath}`,
      path: itemPath,
      headers: { 'Accept': 'application/json' },
      label: 'Delete',
      expect: { statusRange: '2xx' },
    });

    // Verify 404 after delete
    if (resource.readOne && !excluded.has(`GET:${itemPath}`)) {
      steps.push({
        method: 'GET',
        url: `${baseUrl}${itemPath}`,
        path: itemPath,
        headers: { 'Accept': 'application/json' },
        label: 'Verify Deleted',
        expect: { status: 404 },
      });
    }
  }

  return steps;
}

function _getRequestBodySchema(ep) {
  if (!ep.requestBody) return null;
  const content = ep.requestBody.content;
  if (!content) return null;
  const json = content['application/json'];
  return json?.schema || null;
}
