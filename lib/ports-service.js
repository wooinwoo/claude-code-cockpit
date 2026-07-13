// ─── Ports Service: System listening ports + process info ───

/**
 * @typedef {Object} PortEntry
 * @property {number} port
 * @property {number} pid
 * @property {string} protocol - 'TCP' or 'UDP'
 * @property {string} address
 * @property {string} processName
 * @property {string|null} projectId
 * @property {string|null} projectName
 * @property {boolean} isDevServer
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IS_WIN } from './platform.js';

const execFileAsync = promisify(execFile);

const PROTECTED_PIDS = new Set([0, 4]);

/**
 * Get all listening TCP/UDP ports with process info.
 * Cross-references with devServers map to tag project-owned ports.
 * @param {Map<string, {port: number, projectName?: string}>} [devServers]
 * @returns {Promise<PortEntry[]>}
 */
export async function getListeningPorts(devServers) {
  let entries;
  try {
    entries = IS_WIN ? await getPortsWindows() : await getPortsUnix();
  } catch { return []; }

  // Batch PID → process name lookup
  const pidSet = new Set(entries.map(e => e.pid));
  if (pidSet.size > 0) {
    const pidNames = await resolvePidNames([...pidSet]);
    for (const e of entries) {
      e.processName = pidNames.get(e.pid) || 'Unknown';
    }
  }

  // Cross-reference with devServers
  const devPorts = new Map();
  if (devServers) {
    for (const [projectId, ds] of devServers) {
      if (ds.port) devPorts.set(ds.port, { projectId, projectName: ds.projectName || projectId });
    }
  }

  for (const e of entries) {
    const dev = devPorts.get(e.port);
    if (dev) {
      e.projectId = dev.projectId;
      e.projectName = dev.projectName;
      e.isDevServer = true;
    } else {
      e.projectId = null;
      e.projectName = null;
      e.isDevServer = false;
    }
  }

  entries.sort((a, b) => a.port - b.port);
  return entries;
}

// ─── Windows: netstat -ano ───
async function getPortsWindows() {
  const { stdout } = await execFileAsync('netstat', ['-ano'], { timeout: 8000, windowsHide: true });
  const lines = stdout.split('\n').filter(l => l.includes('LISTENING'));
  const entries = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const protocol = parts[0];
    const localAddr = parts[1];
    const pid = parseInt(parts[4], 10);
    if (isNaN(pid)) continue;

    const lastColon = localAddr.lastIndexOf(':');
    if (lastColon === -1) continue;
    const address = localAddr.slice(0, lastColon);
    const port = parseInt(localAddr.slice(lastColon + 1), 10);
    if (isNaN(port)) continue;

    if (entries.some(e => e.port === port && e.pid === pid)) continue;
    entries.push({ port, pid, protocol, address, processName: '' });
  }
  return entries;
}

// ─── macOS/Linux: lsof -iTCP -sTCP:LISTEN ───
async function getPortsUnix() {
  const entries = [];
  try {
    const { stdout } = await execFileAsync('lsof', ['-iTCP', '-sTCP:LISTEN', '-nP', '-F', 'pcn'], { timeout: 8000 });
    // lsof -F output: p<pid>\nc<command>\nn<name> (repeated per entry)
    let currentPid = 0;
    let currentName = '';
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const tag = line[0];
      const value = line.slice(1);
      if (tag === 'p') {
        currentPid = parseInt(value, 10);
      } else if (tag === 'c') {
        currentName = value;
      } else if (tag === 'n') {
        // n*:3847 or n127.0.0.1:3847 or n[::1]:3847
        const lastColon = value.lastIndexOf(':');
        if (lastColon === -1) continue;
        const address = value.slice(0, lastColon);
        const port = parseInt(value.slice(lastColon + 1), 10);
        if (isNaN(port)) continue;
        if (entries.some(e => e.port === port && e.pid === currentPid)) continue;
        entries.push({ port, pid: currentPid, protocol: 'TCP', address, processName: currentName });
      }
    }
  } catch {
    // lsof not available or no permission — try ss as fallback (Linux)
    try {
      const { stdout } = await execFileAsync('ss', ['-tlnp'], { timeout: 8000 });
      const lines = stdout.split('\n').slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const local = parts[3]; // *:3847 or 0.0.0.0:3847
        const lastColon = local.lastIndexOf(':');
        if (lastColon === -1) continue;
        const address = local.slice(0, lastColon);
        const port = parseInt(local.slice(lastColon + 1), 10);
        if (isNaN(port)) continue;
        // Extract PID from users column: users:(("node",pid=1234,...))
        const usersCol = parts[5] || '';
        const pidMatch = usersCol.match(/pid=(\d+)/);
        const pid = pidMatch ? parseInt(pidMatch[1], 10) : 0;
        const nameMatch = usersCol.match(/\("([^"]+)"/);
        const name = nameMatch ? nameMatch[1] : '';
        if (entries.some(e => e.port === port && e.pid === pid)) continue;
        entries.push({ port, pid, protocol: 'TCP', address, processName: name });
      }
    } catch { /* no ss either */ }
  }
  return entries;
}

/**
 * Resolve PIDs to process names.
 * Windows: tasklist, Unix: ps
 */
async function resolvePidNames(pids) {
  const map = new Map();
  try {
    if (IS_WIN) {
      const result = await execFileAsync('tasklist', ['/fo', 'csv', '/nh'], { timeout: 8000, windowsHide: true });
      for (const line of result.stdout.split('\n')) {
        const match = line.match(/^"([^"]+)","(\d+)"/);
        if (match) {
          const pid = parseInt(match[2], 10);
          if (pids.includes(pid)) map.set(pid, match[1]);
        }
      }
    } else {
      for (const pid of pids) {
        try {
          const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 3000 });
          const name = stdout.trim();
          if (name) map.set(pid, name);
        } catch { /* process may have exited */ }
      }
    }
  } catch { /* fallback: names stay empty */ }
  return map;
}

/**
 * Kill a process by PID.
 * Security: refuses protected PIDs (0, 4) and own process.
 * @param {number} pid
 * @returns {Promise<{killed: boolean}>}
 * @throws {Error} If PID is invalid, protected, or kill fails
 */
export async function killProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('Invalid PID');
  }
  if (PROTECTED_PIDS.has(pid) || pid === process.pid) {
    throw new Error('Cannot kill protected process');
  }
  try {
    if (IS_WIN) {
      await execFileAsync('taskkill', ['/pid', String(pid), '/F'], { timeout: 5000, windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return { killed: true };
  } catch (err) {
    throw new Error(`Failed to kill PID ${pid}: ${err.message}`);
  }
}
