// ─── Ports Service: System listening ports + process info ───
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROTECTED_PIDS = new Set([0, 4]);

/**
 * Get all listening TCP/UDP ports with process info.
 * Cross-references with devServers map to tag project-owned ports.
 */
export async function getListeningPorts(devServers) {
  // Step 1: netstat -ano
  let stdout;
  try {
    const result = await execFileAsync('netstat', ['-ano'], { timeout: 8000, windowsHide: true });
    stdout = result.stdout;
  } catch { return []; }

  // Step 2: Parse lines with LISTENING
  const lines = stdout.split('\n').filter(l => l.includes('LISTENING'));
  const entries = [];
  const pidSet = new Set();

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const protocol = parts[0]; // TCP
    const localAddr = parts[1]; // 0.0.0.0:3847 or [::]:3847
    const pid = parseInt(parts[4], 10);
    if (isNaN(pid)) continue;

    // Parse address and port
    const lastColon = localAddr.lastIndexOf(':');
    if (lastColon === -1) continue;
    const address = localAddr.slice(0, lastColon);
    const port = parseInt(localAddr.slice(lastColon + 1), 10);
    if (isNaN(port)) continue;

    // Skip duplicate ports (IPv4 and IPv6 both show up)
    if (entries.some(e => e.port === port && e.pid === pid)) continue;

    pidSet.add(pid);
    entries.push({ port, pid, protocol, address, processName: '' });
  }

  // Step 3: Batch PID → process name lookup
  if (pidSet.size > 0) {
    const pidNames = await resolvePidNames([...pidSet]);
    for (const e of entries) {
      e.processName = pidNames.get(e.pid) || 'Unknown';
    }
  }

  // Step 4: Cross-reference with devServers
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

  // Sort by port number
  entries.sort((a, b) => a.port - b.port);
  return entries;
}

/**
 * Resolve PIDs to process names using tasklist.
 */
async function resolvePidNames(pids) {
  const map = new Map();
  try {
    const result = await execFileAsync('tasklist', ['/fo', 'csv', '/nh'], { timeout: 8000, windowsHide: true });
    for (const line of result.stdout.split('\n')) {
      // "process.exe","1234","Console","1","12,345 K"
      const match = line.match(/^"([^"]+)","(\d+)"/);
      if (match) {
        const pid = parseInt(match[2], 10);
        if (pids.includes(pid)) map.set(pid, match[1]);
      }
    }
  } catch { /* fallback: names stay empty */ }
  return map;
}

/**
 * Kill a process by PID.
 * Security: refuses protected PIDs and own process.
 */
export async function killProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('Invalid PID');
  }
  if (PROTECTED_PIDS.has(pid) || pid === process.pid) {
    throw new Error('Cannot kill protected process');
  }
  try {
    await execFileAsync('taskkill', ['/pid', String(pid), '/F'], { timeout: 5000, windowsHide: true });
    return { killed: true };
  } catch (err) {
    throw new Error(`Failed to kill PID ${pid}: ${err.message}`);
  }
}
