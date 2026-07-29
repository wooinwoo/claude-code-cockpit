import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

function kindOf(comm, cmdline) {
  const names = [comm, ...cmdline.split('\0').filter(Boolean).slice(0, 2).map(value => basename(value))]
    .map(value => String(value || '').toLowerCase());
  if (names.includes('claude')) return 'claude';
  if (names.includes('codex')) return 'codex';
  return null;
}

export function detectAgentProcess(rootPid, read = readFileSync) {
  // ponytail: Linux /proc fast path; add a native Windows process-tree adapter
  // only when Cockpit needs to detect manually typed agents outside WSL.
  if (!Number.isInteger(rootPid) || rootPid <= 0) return { available: false, kind: null };
  const queue = [rootPid];
  const seen = new Set();
  try {
    while (queue.length && seen.size < 128) {
      const pid = queue.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const comm = String(read(`/proc/${pid}/comm`, 'utf8')).trim();
      const cmdline = String(read(`/proc/${pid}/cmdline`, 'utf8'));
      const kind = pid === rootPid ? null : kindOf(comm, cmdline);
      if (kind) return { available: true, kind };
      const children = String(read(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim();
      if (children) queue.push(...children.split(/\s+/).map(Number).filter(Number.isInteger));
    }
    return { available: true, kind: null };
  } catch {
    return { available: false, kind: null };
  }
}
