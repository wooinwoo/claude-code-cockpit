// ─── Ports Routes ───
import { getListeningPorts, killProcess } from '../lib/ports-service.js';

export function register(ctx) {
  const { addRoute, json, readBody, isLocalhost, devServers } = ctx;

  addRoute('GET', '/api/ports', async (_req, res) => {
    try {
      const ports = await getListeningPorts(devServers);
      json(res, ports);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  addRoute('POST', '/api/ports/kill', async (req, res) => {
    if (!isLocalhost(req)) { json(res, { error: 'Forbidden' }, 403); return; }
    const body = await readBody(req);
    const pid = parseInt(body?.pid, 10);
    if (!pid || pid <= 0) { json(res, { error: 'Invalid PID' }, 400); return; }
    try {
      const result = await killProcess(pid);
      json(res, result);
    } catch (err) {
      json(res, { error: err.message }, 400);
    }
  });
}
