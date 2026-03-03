#!/usr/bin/env node
// ─── Build Installer: auto-generate Tauri resources + build NSIS installer ───
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TAURI_CONF = join(ROOT, 'src-tauri', 'tauri.conf.json');

// ─── Step 1: Scan node_modules for all directories (Tauri resources need explicit paths) ───
function scanDirs(base, dir = '') {
  const dirs = [];
  const full = join(base, dir);
  if (!existsSync(full)) return dirs;

  const entries = readdirSync(full, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    dirs.push(rel);
    dirs.push(...scanDirs(base, rel));
  }
  return dirs;
}

console.log('📦 Step 1: Scanning node_modules...');
const nmDir = join(ROOT, 'node_modules');
const allDirs = scanDirs(nmDir);

// Build resources map
const resources = {
  // Core app files
  '../server.js': './',
  '../index.html': './',
  '../style.css': './',
  '../manifest.json': './',
  '../sw.js': './',
  '../package.json': './',
  // JS modules
  '../js/*': './js/',
  // Server lib
  '../lib/*': './lib/',
  // Workflows
  '../workflows/*': './workflows/',
  // Defaults (initial config templates)
  '../defaults/*': './defaults/',
  // node_modules top-level files
  '../node_modules/*': './node_modules/',
};

// Add every subdirectory of node_modules
for (const dir of allDirs) {
  resources[`../node_modules/${dir}/*`] = `./node_modules/${dir}/`;
}

console.log(`   Found ${allDirs.length} directories in node_modules`);

// ─── Step 2: Update tauri.conf.json ───
console.log('📝 Step 2: Updating tauri.conf.json resources...');
const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));
conf.bundle.resources = resources;
writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + '\n');
console.log('   Updated with', Object.keys(resources).length, 'resource entries');

// ─── Step 3: Check icons ───
const iconsDir = join(ROOT, 'src-tauri', 'icons');
if (!existsSync(iconsDir)) {
  console.log('🎨 Step 3: Generating default icons...');
  mkdirSync(iconsDir, { recursive: true });
  // Generate minimal icons using Tauri CLI
  try {
    execSync('npx tauri icon', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    console.log('   Warning: Could not generate icons. Using defaults.');
    // Create placeholder icon.ico if needed
  }
} else {
  console.log('🎨 Step 3: Icons already exist, skipping');
}

// ─── Step 4: Build ───
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const bundleType = isMac ? 'DMG' : 'NSIS';
console.log(`🔨 Step 4: Building Tauri ${bundleType} installer...`);
console.log('   This may take several minutes on first build.\n');

try {
  execSync('cargo tauri build', {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, COCKPIT_PORT: undefined }
  });
} catch (err) {
  console.error('\n❌ Build failed. Common fixes:');
  console.error('   - Install Rust: https://rustup.rs/');
  console.error('   - Install Tauri CLI: cargo install tauri-cli');
  console.error('   - Check Node.js is in PATH');
  if (isMac) console.error('   - Install Xcode Command Line Tools: xcode-select --install');
  process.exit(1);
}

// ─── Step 5: Locate output ───
if (isMac) {
  const dmgDir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'dmg');
  if (existsSync(dmgDir)) {
    const installers = readdirSync(dmgDir).filter(f => f.endsWith('.dmg'));
    if (installers.length) {
      console.log('\n✅ DMG built successfully!');
      console.log(`   📂 ${join(dmgDir, installers[0])}`);
    }
  } else {
    console.log('\n⚠️  Build completed but DMG output not found.');
    console.log('   Check src-tauri/target/release/bundle/');
  }
} else {
  const nsisDir = join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  if (existsSync(nsisDir)) {
    const installers = readdirSync(nsisDir).filter(f => f.endsWith('.exe'));
    if (installers.length) {
      console.log('\n✅ Installer built successfully!');
      console.log(`   📂 ${join(nsisDir, installers[0])}`);
    }
  } else {
    console.log('\n⚠️  Build completed but NSIS output not found.');
    console.log('   Check src-tauri/target/release/bundle/');
  }
}
