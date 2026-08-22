// ─── System Monitor Service ───

/**
 * @typedef {Object} MemoryInfo
 * @property {number} total - Total memory in bytes
 * @property {number} free - Free memory in bytes
 * @property {number} used - Used memory in bytes
 * @property {number} percent - Usage percentage (0-100)
 */

/**
 * @typedef {Object} DiskInfo
 * @property {string} drive - Mount point or drive letter
 * @property {number} total - Total space in bytes
 * @property {number} free - Free space in bytes
 * @property {number} used - Used space in bytes
 * @property {number} percent - Usage percentage (0-100)
 */

/**
 * @typedef {Object} ProcessInfo
 * @property {number} Id - Process ID
 * @property {string} ProcessName
 * @property {number} Cpu - CPU usage (seconds or percentage)
 * @property {number} MemMB - Memory usage in MB
 */

/**
 * @typedef {Object} SystemInfo
 * @property {string} hostname
 * @property {string} platform
 * @property {string} arch
 * @property {string} cpuModel
 * @property {number} cpuCores
 * @property {number} totalMemory - In bytes
 * @property {number} uptime - In seconds
 * @property {string} nodeVersion
 */

/**
 * @typedef {Object} AllStats
 * @property {number} cpu - CPU usage percentage (0-100)
 * @property {MemoryInfo} memory
 * @property {DiskInfo[]} disk
 * @property {ProcessInfo[]} processes
 * @property {SystemInfo} system
 * @property {number} timestamp
 */

import { cpus, totalmem, freemem, uptime, hostname, platform, arch } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IS_WIN } from './platform.js';

const exec = promisify(execFile);

// ─── CPU Usage (sampled over 500ms) ───
const _prevIdle = 0, _prevTotal = 0;

function cpuSnapshot() {
  const c = cpus();
  let idle = 0, total = 0;
  for (const cpu of c) {
    for (const type of Object.keys(cpu.times)) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/**
 * Sample CPU usage over 300ms.
 * @returns {Promise<number>} CPU usage percentage (0-100)
 */
export async function getCpuUsage() {
  const s1 = cpuSnapshot();
  await new Promise(r => setTimeout(r, 300));
  const s2 = cpuSnapshot();
  const idleDiff = s2.idle - s1.idle;
  const totalDiff = s2.total - s1.total;
  return totalDiff === 0 ? 0 : Math.round((1 - idleDiff / totalDiff) * 100);
}

/** @returns {MemoryInfo} */
export function getMemoryInfo() {
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  return { total, free, used, percent: Math.round(used / total * 100) };
}

/** @returns {Promise<DiskInfo[]>} */
export async function getDiskInfo() {
  try {
    if (IS_WIN) return await getDiskInfoWindows();
    return await getDiskInfoUnix();
  } catch {
    return [];
  }
}

async function getDiskInfoWindows() {
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
}

async function getDiskInfoUnix() {
  // df -k: 1K blocks, works on macOS and Linux
  const { stdout } = await exec('df', ['-k'], { timeout: 5000 });
  const lines = stdout.trim().split('\n').slice(1); // skip header
  const disks = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [filesystem, blocks, used, available, , mountpoint] = parts;
    // Skip pseudo-filesystems
    if (!mountpoint || filesystem === 'tmpfs' || filesystem === 'devtmpfs' || filesystem.startsWith('map ')) continue;
    // Only show real mounts
    if (!filesystem.startsWith('/') && !filesystem.includes(':')) continue;
    const total = parseInt(blocks) * 1024;
    const usedBytes = parseInt(used) * 1024;
    const free = parseInt(available) * 1024;
    if (!total || total === 0) continue;
    disks.push({ drive: mountpoint, total, free, used: usedBytes, percent: Math.round(usedBytes / total * 100) });
  }
  return disks;
}

/**
 * Get top processes sorted by memory usage.
 * @param {number} [limit=15]
 * @returns {Promise<ProcessInfo[]>}
 */
export async function getTopProcesses(limit = 15) {
  try {
    if (IS_WIN) return await getTopProcessesWindows(limit);
    return await getTopProcessesUnix(limit);
  } catch {
    return [];
  }
}

async function getTopProcessesWindows(limit) {
  const { stdout } = await exec('powershell', [
    '-NoProfile', '-Command',
    `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${limit} Id,ProcessName,@{N='Cpu';E={[math]::Round($_.CPU,1)}},@{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json`
  ], { timeout: 10000, windowsHide: true });
  try { const data = JSON.parse(stdout); return Array.isArray(data) ? data : [data]; }
  catch { return []; }
}

async function getTopProcessesUnix(limit) {
  // ps: works on macOS and Linux (macOS doesn't support --sort, use sort command)
  const { stdout } = await exec('ps', ['-eo', 'pid,comm,%cpu,rss'], { timeout: 5000 });
  const lines = stdout.trim().split('\n').slice(1); // skip header
  const procs = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = parseInt(parts[0]);
    const cpu = parseFloat(parts[parts.length - 2]) || 0;
    const rssKb = parseInt(parts[parts.length - 1]) || 0;
    // comm can contain spaces, take everything between pid and %cpu
    const name = parts.slice(1, parts.length - 2).join(' ');
    procs.push({ Id: pid, ProcessName: name, Cpu: Math.round(cpu * 10) / 10, MemMB: Math.round(rssKb / 1024 * 10) / 10 });
  }
  // Sort by memory descending
  procs.sort((a, b) => b.MemMB - a.MemMB);
  return procs.slice(0, limit);
}

/** @returns {SystemInfo} */
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

/** @returns {Promise<AllStats>} */
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
