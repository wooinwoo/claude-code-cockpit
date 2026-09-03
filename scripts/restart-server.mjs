import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

const parentPid = Number(process.argv[2]);
const serverPath = process.argv[3];
if (!Number.isInteger(parentPid) || parentPid < 2 || !serverPath) process.exit(2);

for (let attempt = 0; attempt < 100; attempt++) {
  try { process.kill(parentPid, 0); }
  catch {
    const child = spawn(process.execPath, [serverPath, '--no-open'], {
      cwd: dirname(serverPath), env: process.env, detached: true, stdio: 'ignore',
    });
    child.unref();
    process.exit(0);
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}

process.exit(1);
