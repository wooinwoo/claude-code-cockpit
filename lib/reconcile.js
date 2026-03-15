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

  // ── Step 0: Fix tsconfig paths (@/* → ./* if no src/ dir) ──
  const tsconfigPath = join(wtNative, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    try {
      let tsconfig = readFileSync(tsconfigPath, 'utf8');
      if (tsconfig.includes('"./src/*"') && !existsSync(join(wtNative, 'src'))) {
        tsconfig = tsconfig.replace('"./src/*"', '"./*"');
        writeFileSync(tsconfigPath, tsconfig, 'utf8');
        fixCount++;
        log('📝 tsconfig.json: @/* → ./* (src/ 없음)');
      }
      // Also: if src/ exists but most files are at root, prefer root
      if (tsconfig.includes('"./src/*"') && existsSync(join(wtNative, 'components'))) {
        tsconfig = tsconfig.replace('"./src/*"', '"./*"');
        writeFileSync(tsconfigPath, tsconfig, 'utf8');
        fixCount++;
        log('📝 tsconfig.json: @/* → ./* (root에 components 있음)');
      }
    } catch { /* ok */ }
  }

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
          const stub = createStub(wtNative, path, spec, rel);
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

  // ── Step 4b: (Vite/CRA) Auto-generate React Router ──
  if (!isNext) {
    const routerFixes = _generateReactRouter(wtNative, allFiles, exportMap, log);
    fixCount += routerFixes;
  }

  // ── Step 5: Auto-install missing npm packages ──
  const commonDeps = [
    '@radix-ui/react-slot', 'class-variance-authority', 'clsx',
    'lucide-react', 'tailwind-merge', 'zustand',
    ...(isNext ? [] : ['react-router-dom']),
  ];
  const missingDeps = [];
  for (const dep of commonDeps) {
    if (!existsSync(join(wtNative, 'node_modules', dep))) {
      missingDeps.push(dep);
    }
  }
  // Also scan for imports of uninstalled packages
  for (const { full } of allFiles) {
    try {
      const content = readFileSync(full, 'utf8');
      const pkgImports = content.match(/from\s+['"]([^./'"@][^'"]*)['"]/g) || [];
      for (const m of pkgImports) {
        const pkg = m.match(/['"]([^'"]+)['"]/)?.[1];
        if (!pkg) continue;
        const pkgName = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
        if (!existsSync(join(wtNative, 'node_modules', pkgName)) && !missingDeps.includes(pkgName)) {
          missingDeps.push(pkgName);
        }
      }
    } catch { /* ok */ }
  }
  if (missingDeps.length > 0) {
    log(`📦 Missing packages: ${missingDeps.join(', ')}`);
    try {
      const { execSync } = require('child_process');
      execSync(`npm install ${missingDeps.join(' ')} --save 2>&1`, {
        cwd: wtNative, timeout: 120000, encoding: 'utf8',
      });
      fixCount += missingDeps.length;
      log(`📦 ${missingDeps.length}개 패키지 설치 완료`);
    } catch (err) {
      log(`📦 패키지 설치 실패: ${err.message?.slice(0, 100)}`);
    }
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

function createStub(wtRoot, importPath, importSpec, fromFile) {
  let target;
  if (importPath.startsWith('@/')) {
    target = importPath.slice(2);
  } else if (importPath.startsWith('./') || importPath.startsWith('../')) {
    // Resolve relative path
    const fromDir = (fromFile || '').split('/').slice(0, -1);
    const parts = [...fromDir];
    for (const seg of importPath.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    target = parts.join('/');
  } else {
    return null; // node_module, skip
  }
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

// ═══════════════════════════════════════════════════════
// React Router auto-generation (Vite/CRA projects)
// ═══════════════════════════════════════════════════════

function _generateReactRouter(wtRoot, allFiles, exportMap, log) {
  let fixes = 0;

  // Find page-like components by naming convention
  const pageFiles = allFiles.filter(f => {
    const lo = f.rel.toLowerCase();
    return (lo.includes('page') || lo.includes('view')) &&
      /\.(tsx|jsx)$/.test(f.rel) &&
      !lo.includes('node_modules') &&
      !lo.includes('.test') &&
      f.rel.startsWith('src/');
  });

  if (pageFiles.length < 2) return 0; // Not enough pages to warrant a router

  // Route mapping: infer route path from file name/path
  const routes = [];
  for (const f of pageFiles) {
    const info = exportMap.get(f.rel);
    if (!info) continue;
    const componentName = info.named?.[0] || f.rel.match(/(\w+)\.\w+$/)?.[1] || 'Page';
    const importPath = './' + f.rel.replace(/\.(tsx?|jsx?)$/, '');

    // Infer route path from file name
    let routePath = '/';
    const lower = f.rel.toLowerCase();
    if (/home|index|landing/i.test(lower) && !lower.includes('admin')) routePath = '/';
    else if (/login/i.test(lower)) routePath = '/login';
    else if (/register|signup/i.test(lower)) routePath = '/register';
    else if (/cart/i.test(lower)) routePath = '/cart';
    else if (/checkout/i.test(lower)) routePath = '/checkout';
    else if (/order.*complete|complete.*order/i.test(lower)) routePath = '/order/complete';
    else if (/order.*detail|order.*\[/i.test(lower)) routePath = '/orders/:id';
    else if (/order/i.test(lower)) routePath = '/orders';
    else if (/product.*detail|product.*\[/i.test(lower)) routePath = '/products/:id';
    else if (/product/i.test(lower)) routePath = '/products';
    else if (/category/i.test(lower)) routePath = '/categories';
    else if (/search/i.test(lower)) routePath = '/search';
    else if (/wishlist/i.test(lower)) routePath = '/wishlist';
    else if (/mypage|my-page|profile/i.test(lower)) routePath = '/mypage';
    else if (/admin.*dashboard/i.test(lower)) routePath = '/admin';
    else if (/admin.*product/i.test(lower)) routePath = '/admin/products';
    else if (/admin.*order/i.test(lower)) routePath = '/admin/orders';
    else if (/admin.*user|admin.*member/i.test(lower)) routePath = '/admin/users';
    else if (/admin.*coupon/i.test(lower)) routePath = '/admin/coupons';
    else if (/admin.*setting/i.test(lower)) routePath = '/admin/settings';
    else if (/setting/i.test(lower)) routePath = '/settings';
    else if (/notice/i.test(lower)) routePath = '/notice';
    else {
      // Fallback: derive from filename
      const name = f.rel.match(/(\w+?)(?:Page|View)?\.\w+$/)?.[1] || '';
      if (name) routePath = '/' + name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
    }

    // Avoid duplicates
    if (!routes.find(r => r.path === routePath)) {
      routes.push({ path: routePath, componentName, importPath, isDefault: info.hasDefault });
    }
  }

  if (routes.length === 0) return 0;

  // Generate router file
  const imports = routes.map(r =>
    r.isDefault
      ? `import ${r.componentName} from '${r.importPath}';`
      : `import { ${r.componentName} } from '${r.importPath}';`
  ).join('\n');

  const routeElements = routes.map(r => {
    if (r.path === '/') return `      <Route index element={<${r.componentName} />} />`;
    return `      <Route path="${r.path}" element={<${r.componentName} />} />`;
  }).join('\n');

  // Check if Layout component exists
  const hasLayout = allFiles.some(f => /layout/i.test(f.rel) && /\.(tsx|jsx)$/.test(f.rel));
  const layoutFile = allFiles.find(f => /layout/i.test(f.rel) && /\.(tsx|jsx)$/.test(f.rel));
  let layoutImport = '';
  let layoutName = '';
  if (layoutFile) {
    const info = exportMap.get(layoutFile.rel);
    layoutName = info?.named?.[0] || 'Layout';
    const lPath = './' + layoutFile.rel.replace(/\.(tsx?|jsx?)$/, '');
    layoutImport = info?.hasDefault
      ? `import ${layoutName} from '${lPath}';`
      : `import { ${layoutName} } from '${lPath}';`;
  }

  const routerContent = `import { createBrowserRouter, RouterProvider, Route, createRoutesFromElements, Outlet } from 'react-router-dom';
${layoutImport}
${imports}

${hasLayout ? `function RootLayout() {\n  return <${layoutName}><Outlet /></${layoutName}>;\n}\n` : ''}
const router = createBrowserRouter(
  createRoutesFromElements(
    <Route ${hasLayout ? 'element={<RootLayout />}' : 'element={<Outlet />}'}>
${routeElements}
    </Route>
  )
);

export default function AppRouter() {
  return <RouterProvider router={router} />;
}
`;

  const routerPath = join(wtRoot, 'src', 'router.tsx');
  mkdirSync(dirname(routerPath), { recursive: true });
  writeFileSync(routerPath, routerContent, 'utf8');
  fixes++;
  log(`🛣️ React Router 생성: ${routes.length}개 라우트`);

  // Inject router into App.tsx
  const appPath = join(wtRoot, 'src', 'App.tsx');
  if (existsSync(appPath)) {
    const appContent = readFileSync(appPath, 'utf8');
    // Only inject if not already using router
    if (!appContent.includes('Router') && !appContent.includes('router')) {
      const newApp = `import AppRouter from './router';\n\nfunction App() {\n  return <AppRouter />;\n}\n\nexport default App;\n`;
      writeFileSync(appPath, newApp, 'utf8');
      fixes++;
      log('📝 App.tsx에 Router 주입');
    }
  }

  return fixes;
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
