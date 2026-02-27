// ─── System Monitor Service ───
import { cpus, totalmem, freemem, uptime, hostname, platform, arch, loadavg } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';

const exec = promisify(execFile);

// ─── CPU Usage (sampled over 500ms) ───
let _prevIdle = 0, _prevTotal = 0;

function cpuSnapshot() {
  const c = cpus();
  let idle = 0, total = 0;
  for (const cpu of c) {
    for (const type of Object.keys(cpu.times)) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

export async function getCpuUsage() {
  const s1 = cpuSnapshot();
  await new Promise(r => setTimeout(r, 300));
  const s2 = cpuSnapshot();
  const idleDiff = s2.idle - s1.idle;
  const totalDiff = s2.total - s1.total;
  return totalDiff === 0 ? 0 : Math.round((1 - idleDiff / totalDiff) * 100);
}

// ─── Memory ───
export function getMemoryInfo() {
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  return { total, free, used, percent: Math.round(used / total * 100) };
}

// ─── Disk (Windows) ───
export async function getDiskInfo() {
  try {
    const { stdout } = await exec('wmic', ['logicaldisk', 'get', 'Caption,Size,FreeSpace', '/format:csv'], { timeout: 5000, windowsHide: true });
    const lines = stdout.trim().split('\n').filter(l => l.includes(','));
    const disks = [];
    for (const line of lines.slice(1)) {
      const parts = line.trim().split(',');
      if (parts.length < 4) continue;
      const [, drive, freeSpace, size] = parts;
      if (!size || size === '0' || !freeSpace) continue;
      const total = parseInt(size);
      const free = parseInt(freeSpace);
      const used = total - free;
      disks.push({ drive: drive.trim(), total, free, used, percent: Math.round(used / total * 100) });
    }
    return disks;
  } catch {
    return [];
  }
}

// ─── Top Processes (Windows) ───
export async function getTopProcesses(limit = 15) {
  try {
    const { stdout } = await exec('powershell', [
      '-NoProfile', '-Command',
      `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${limit} Id,ProcessName,@{N='Cpu';E={[math]::Round($_.CPU,1)}},@{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json`
    ], { timeout: 10000, windowsHide: true });
    try { const data = JSON.parse(stdout); return Array.isArray(data) ? data : [data]; }
    catch { return []; }
  } catch {
    return [];
  }
}

// ─── System Info ───
export function getSystemInfo() {
  const c = cpus();
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpuModel: c[0]?.model || 'Unknown',
    cpuCores: c.length,
    totalMemory: totalmem(),
    uptime: uptime(),
    nodeVersion: process.version,
  };
}

// ─── All Stats ───
export async function getAllStats() {
  const [cpu, disk, processes] = await Promise.all([
    getCpuUsage(),
    getDiskInfo(),
    getTopProcesses(),
  ]);
  return {
    cpu,
    memory: getMemoryInfo(),
    disk,
    processes,
    system: getSystemInfo(),
    timestamp: Date.now(),
  };
}
