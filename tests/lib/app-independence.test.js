import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import test from 'node:test';

const root = new URL('../..', import.meta.url).pathname;
const sourceExtensions = new Set(['.js', '.mjs', '.json', '.rs']);

async function sourceFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? sourceFiles(child) : sourceExtensions.has(extname(child)) ? [child] : [];
  }));
  return files.flat();
}

test('Cockpit runtime stays independent from Praetorium', async () => {
  const files = [
    ...(await sourceFiles(join(root, 'js'))),
    ...(await sourceFiles(join(root, 'lib'))),
    ...(await sourceFiles(join(root, 'routes'))),
    ...(await sourceFiles(join(root, 'src-tauri', 'src'))),
    join(root, 'server.js'),
    join(root, 'package.json'),
    join(root, 'src-tauri', 'tauri.conf.json'),
  ];
  const source = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(source, /praetorium|PRAETORIUM_|(?:localhost|127\.0\.0\.1):3848/i);
});
