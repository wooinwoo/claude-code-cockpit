// ═══════════════════════════════════════════════════════
// Import Reconciliation — deterministic post-build fixes
// Fixes: src/ → root move, named/default mismatch, broken imports → stub
// ═══════════════════════════════════════════════════════

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const IS_WIN = process.platform === 'win32';
const toWinPath = p => p.replace(/\//g, '\\');

export async function reconcileImports(plan) {
  const wt = plan.worktreePath;
  if (!wt) return;
  const wtNative = IS_WIN ? toWinPath(wt) : wt;
  const isNext = plan.toolchain === 'next';
  const log = (msg) => plan.addLog?.('system', msg, '');

  log('🔧 Import reconciliation 시작...');
  let fixCount = 0;

  // ── Step 1: Move src/ → root (agents put files in wrong dir) ──
  if (isNext) {
    for (const sub of ['app', 'components', 'hooks', 'types', 'lib', 'widgets', 'store', 'utils', 'data']) {
      const src = join(wtNative, 'src', sub);
      const dest = join(wtNative, sub);
      if (existsSync(src)) {
        const n = copyDirMerge(src, dest);
        fixCount += n;
      }
    }
    if (fixCount > 0) log(`📁 src/ → root 이동: ${fixCount}건`);
  }

  // ── Step 2: Scan all source files for exports ──
  const exportMap = new Map();
  const allFiles = [];
  scanDir(wtNative, '', allFiles, exportMap);

  // ── Step 3: Fix imports in every file ──
  let importFixes = 0;
  for (const { full, rel } of allFiles) {
    try {
      let content = readFileSync(full, 'utf8');
      let changed = false;

      // Fix @/src/ → @/
      if (content.includes('@/src/')) {
        content = content.replace(/@\/src\//g, '@/');
        changed = true;
        importFixes++;
      }

      // Process each line
      const lines = content.split('\n');
      const newLines = [];

      for (const line of lines) {
        const m = line.match(/^(import\s+)((?:\w+)|(?:\{[^}]+\}))\s+(from\s+['"]([^'"]+)['"];?\s*)$/);
        if (!m) { newLines.push(line); continue; }

        const [, kw, spec, fromClause, path] = m;
        if (!path.startsWith('./') && !path.startsWith('../') && !path.startsWith('@/')) {
          newLines.push(line); continue;
        }

        const resolved = resolveImport(wtNative, rel, path);

        // Broken import → create stub
        if (!resolved) {
          const stub = createStub(wtNative, path, spec);
          if (stub) { importFixes++; log(`📝 Stub: ${stub}`); }
          newLines.push(line);
          continue;
        }

        const info = exportMap.get(resolved);
        if (!info) { newLines.push(line); continue; }

        const isDefault = !spec.startsWith('{');

        // default import → named export
        if (isDefault && !info.hasDefault && info.named.length > 0) {
          const name = info.named.find(n => n.toLowerCase() === spec.trim().toLowerCase()) || info.named[0];
          newLines.push(`${kw}{ ${name} } ${fromClause}`);
          changed = true; importFixes++;
          continue;
        }

        // named import → default only
        if (!isDefault && info.hasDefault && info.named.length === 0) {
          const name = spec.replace(/[{}]/g, '').trim().split(',')[0].trim();
          newLines.push(`${kw}${name} ${fromClause}`);
          changed = true; importFixes++;
          continue;
        }

        newLines.push(line);
      }

      if (changed) writeFileSync(full, newLines.join('\n'), 'utf8');
    } catch { /* ok */ }
  }
  if (importFixes > 0) log(`🔗 Import 수정: ${importFixes}건`);
  fixCount += importFixes;

  // ── Step 4: (Next.js) Create missing page routes ──
  if (isNext) {
    const appDir = join(wtNative, 'app');
    const routes = [
      'cart', 'checkout', 'login', 'register', 'signup',
      'mypage', 'my-page', 'profile',
      'wishlist', 'orders', 'search',
      'products', 'categories', 'category',
      'admin', 'admin/products', 'admin/orders', 'admin/users',
      'admin/settings', 'admin/content', 'admin/coupons',
      'order/complete', 'notice',
    ];

    let routeFixes = 0;
    for (const route of routes) {
      const pagePath = join(appDir, route, 'page.tsx');
      if (existsSync(pagePath)) continue;

      const routeName = route.split('/').pop();
      const cand = allFiles.find(f => {
        const lo = f.rel.toLowerCase();
        return lo.includes(routeName.toLowerCase()) &&
          (lo.includes('page') || lo.endsWith(routeName.toLowerCase() + '.tsx')) &&
          !f.rel.startsWith('app/');
      });

      if (cand) {
        const info = exportMap.get(cand.rel);
        const name = info?.named?.[0] || cand.rel.match(/(\w+)\.\w+$/)?.[1] || 'Page';
        const depth = route.split('/').length;
        const relPath = '../'.repeat(depth + 1) + cand.rel.replace(/\.\w+$/, '');
        const imp = info?.hasDefault ? `import ${name} from '${relPath}'` : `import { ${name} } from '${relPath}'`;

        try {
          mkdirSync(join(appDir, route), { recursive: true });
          writeFileSync(pagePath, `${imp};\n\nexport default function Page() {\n  return <${name} />;\n}\n`, 'utf8');
          routeFixes++;
        } catch { /* ok */ }
      }
    }
    if (routeFixes > 0) log(`📄 Route 생성: ${routeFixes}건`);
    fixCount += routeFixes;
  }

  log(`🔧 Reconciliation 완료: 총 ${fixCount}건 수정`);
}

// ── Helpers ──

function scanDir(root, prefix, files, exportMap) {
  try {
    for (const e of readdirSync(join(root, prefix || '.'), { withFileTypes: true })) {
      if (['node_modules', '.next', '.git', 'dist', 'build'].includes(e.name)) continue;
      const rel = prefix ? prefix + '/' + e.name : e.name;
      const full = join(root, rel);
      if (e.isDirectory()) { scanDir(root, rel, files, exportMap); continue; }
      if (!/\.(tsx?|ts)$/.test(e.name) || e.name.endsWith('.d.ts')) continue;

      files.push({ full, rel });
      try {
        const content = readFileSync(full, 'utf8');
        const named = [];
        for (const line of content.split('\n')) {
          const m = line.match(/^export\s+(?:const|function|class|enum|interface|type)\s+(\w+)/);
          if (m) named.push(m[1]);
        }
        exportMap.set(rel, { named, hasDefault: /^export\s+default/m.test(content) });
      } catch { /* ok */ }
    }
  } catch { /* ok */ }
}

function resolveImport(wtRoot, fromFile, importPath) {
  let target;
  if (importPath.startsWith('@/')) {
    target = importPath.slice(2);
  } else {
    const parts = fromFile.split('/').slice(0, -1);
    for (const seg of importPath.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    target = parts.join('/');
  }
  for (const ext of ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
    if (existsSync(join(wtRoot, target + ext))) return target + ext;
  }
  return null;
}

function createStub(wtRoot, importPath, importSpec) {
  if (!importPath.startsWith('@/')) return null;
  const target = importPath.slice(2);
  const filePath = join(wtRoot, target + '.tsx');
  if (existsSync(filePath)) return null;

  const names = importSpec.startsWith('{')
    ? importSpec.replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean)
    : [importSpec.trim()];

  const stubs = names.map(name => {
    if (/^[A-Z]/.test(name)) {
      return `export function ${name}({ children, ...props }: any) {\n  return <div {...props}>{children}</div>;\n}`;
    }
    return `export const ${name} = (...args: any[]) => {};`;
  });

  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `// Auto-generated stub\n${stubs.join('\n\n')}\n`, 'utf8');
    return target + '.tsx';
  } catch { return null; }
}

function copyDirMerge(src, dest) {
  let count = 0;
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const sp = join(src, e.name), dp = join(dest, e.name);
    if (e.isDirectory()) { count += copyDirMerge(sp, dp); }
    else if (!existsSync(dp)) { writeFileSync(dp, readFileSync(sp)); count++; }
  }
  return count;
}
