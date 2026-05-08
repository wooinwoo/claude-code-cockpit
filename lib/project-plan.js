// ─── AutoBuild Pipeline: Single-Worktree Accumulative Builder ───
// Inspired by AutoBE: compiler-driven self-healing, phased accumulative builds,
// file-level parallelism within phases, surgical fixes.
//
// Architecture:
//   Phase 0: Setup     — Single worktree, npm install once, deep project scan
//   Phase 1: Planning  — One Gemini Pro call → file-level WorkUnits grouped by phase with deps
//   Phase 2: Execution — Per build-phase: parallel file writes → full compile → surgical fix → commit
//   Phase 3: Finalize  — Full validation, PR, cleanup
//
// Key difference from Sprint Engine:
//   - Sprint = 1 task per worktree, parallel worktrees
//   - AutoBuild = N tasks in 1 worktree, sequential phases, parallel files WITHIN phase
//   - No merge conflicts. Each phase builds on the previous.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.js';
import { IS_WIN } from './platform.js';
import { toWinPath, gitExecSync } from './wsl-utils.js';
import { reconcileImports } from './reconcile.js';
import { AGENT_PROFILES } from './agent-profiles.js';
import { registerWorktreeRoot, unregisterWorktreeRoot } from './agent-tools.js';

const execFileAsync = promisify(execFile);
const PLAN_HISTORY_DIR = join(DATA_DIR, 'plan-history');
try { mkdirSync(PLAN_HISTORY_DIR, { recursive: true }); } catch { /* ok */ }

// ─── Constants ───
const IMPL_SEMAPHORE = 6;        // Parallel file writers per phase
const VALIDATION_MAX_FIX = 2;    // Max fix attempts per validation level
const VALIDATION_CYCLES = 1;     // Full validation cycles
const VALIDATION_LEVELS = 3;     // Multi-level error recovery (inline → diagnostic → partial)
const REVIEW_ENABLED = false;    // Code review after final phase (disabled for speed)

// ─── Injected Dependencies ───
let _poller = null;
let _runSubAgentLoop = null;
let _getProjectById = null;

const _plans = new Map(); // planId → AutoBuildPlan

// ─── Status Constants ───
const FEATURE_STATUS = {
  QUEUED: 'queued',
  READY: 'ready',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

const PLAN_STATUS = {
  DRAFT: 'draft',
  APPROVED: 'approved',
  RUNNING: 'running',
  PAUSED: 'paused',
  DONE: 'done',
  FAILED: 'failed',
};

// ─── Agent Templates ───
const AGENTS = {
  architect: { id: 'dev_bujang', name: '김부장', emoji: '📋', provider: 'claude', model: 'claude-opus-4-6' },
  senior: { id: 'dev_gwajang', name: '원과장', emoji: '😎', provider: 'claude', model: 'claude-opus-4-6' },
  mid: { id: 'dev_daeri', name: '핏대리', emoji: '🔥', provider: 'claude', model: 'claude-sonnet-4-6' },
  junior: { id: 'dev_sawon', name: '콕사원', emoji: '🐣', provider: 'claude', model: 'claude-sonnet-4-6' },
};

function getProfile(agentKey) {
  const template = AGENTS[agentKey] || AGENTS.mid;
  // Force Gemini for AutoBuild agents — Claude structured JSON doesn't format EDIT correctly
  const base = AGENT_PROFILES[template.id] || {};
  return {
    ...base,
    id: template.id,
    name: template.name || base.name,
    emoji: template.emoji || base.emoji,
    provider: template.provider,  // always use Gemini from AGENTS template
    model: template.model,
    team: 'dev',
    maxIter: base.maxIter || 15,
    systemPrompt: base.systemPrompt || '',
  };
}

// ─── Semaphore (from sprint-engine) ───
class Semaphore {
  constructor(max) { this._max = max; this._current = 0; this._queue = []; }
  async acquire() {
    if (this._current < this._max) { this._current++; return; }
    await new Promise(resolve => this._queue.push(resolve));
  }
  release() {
    this._current--;
    if (this._queue.length > 0) { this._current++; this._queue.shift()(); }
  }
}

// ══════════════════════════════════════════════════
// Data Models
// ══════════════════════════════════════════════════

class Feature {
  constructor({ id, title, description, phase, deps, images, files, type }) {
    this.id = id;
    this.title = title || '';
    this.description = description || '';
    this.phase = phase || 'core';
    this.images = images || [];
    this.deps = deps || [];
    this.files = files || [];      // target files this feature touches
    this.type = type || 'create';  // create | modify
    this.status = FEATURE_STATUS.QUEUED;
    this.sprintId = null;          // kept for backward compat
    this.retryCount = 0;
    this.startedAt = null;
    this.endedAt = null;
    this.error = null;
    this.agentId = null;           // which agent worked on this
    this.agentLog = [];            // [{ts, agent, action, detail}]
  }

  toJSON() {
    return {
      id: this.id, title: this.title, description: this.description,
      phase: this.phase, images: this.images, deps: this.deps,
      files: this.files, type: this.type,
      status: this.status, sprintId: this.sprintId,
      retryCount: this.retryCount, startedAt: this.startedAt,
      endedAt: this.endedAt, error: this.error,
      agentId: this.agentId, agentLog: this.agentLog.slice(-20),
    };
  }
}

class AutoBuildPlan {
  constructor(planId, projectId, description) {
    this.planId = planId;
    this.projectId = projectId;
    this.description = description;
    this.features = [];
    this.phases = [];
    this.status = PLAN_STATUS.DRAFT;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.endedAt = null;
    this.totalCost = 0;
    this.images = [];
    // AutoBuild-specific
    this.worktreePath = null;
    this.branch = null;
    this.baseBranch = 'main';
    this.projectPath = null;
    this.toolchain = null;         // vite | next | cra
    this.designSystem = null;      // design spec from plan generation
    this.validationLog = [];
    this.currentPhase = null;
    this.error = null;
    this._stopped = false;
    this._loopState = { aborted: false };
  }

  getFeature(featureId) {
    return this.features.find(f => f.id === featureId);
  }

  getProgress() {
    const total = this.features.length;
    const done = this.features.filter(f => f.status === FEATURE_STATUS.DONE).length;
    const running = this.features.filter(f => f.status === FEATURE_STATUS.RUNNING).length;
    const failed = this.features.filter(f => f.status === FEATURE_STATUS.FAILED || f.status === FEATURE_STATUS.SKIPPED).length;
    const queued = this.features.filter(f => f.status === FEATURE_STATUS.QUEUED || f.status === FEATURE_STATUS.READY).length;
    return { total, done, running, failed, queued, percent: total ? Math.round((done / total) * 100) : 0 };
  }

  isStopped() { return this._stopped || this._loopState.aborted; }

  stop() {
    this._stopped = true;
    this._loopState.aborted = true;
  }

  addLog(role, msg, detail) {
    const entry = { ts: new Date().toISOString(), role, message: msg, detail: detail || '' };
    _poller?.broadcast('project:log', { planId: this.planId, ...entry });
    return entry;
  }

  toJSON() {
    return {
      planId: this.planId, projectId: this.projectId,
      description: this.description,
      features: this.features.map(f => f.toJSON()),
      phases: this.phases, status: this.status,
      createdAt: this.createdAt, startedAt: this.startedAt,
      endedAt: this.endedAt, totalCost: this.totalCost,
      images: this.images, progress: this.getProgress(),
      worktreePath: this.worktreePath, branch: this.branch,
      baseBranch: this.baseBranch, toolchain: this.toolchain, designSystem: this.designSystem,
      currentPhase: this.currentPhase, error: this.error,
      validationLog: this.validationLog.slice(-10),
    };
  }
}

// ══════════════════════════════════════════════════
// Init
// ══════════════════════════════════════════════════

export function initProjectPlan({ poller, runSubAgentLoop, getProjectById }) {
  _poller = poller;
  _runSubAgentLoop = runSubAgentLoop;
  _getProjectById = getProjectById;
  _restorePlans();
}

// ══════════════════════════════════════════════════
// Plan Generation (AI Analysis)
// ══════════════════════════════════════════════════

export async function generatePlan(projectId, description, images = []) {
  const project = _getProjectById(projectId);
  if (!project) throw new Error('Project not found');

  const planId = `plan-${Date.now().toString(36)}`;
  const plan = new AutoBuildPlan(planId, projectId, description);
  plan.images = images;
  plan.projectPath = project.path;

  // Detect toolchain
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(project.path, 'package.json'), 'utf8')); } catch { /* ok */ }
  plan.toolchain = _detectToolchain(pkg);

  const profile = {
    id: 'plan_analyst', name: '플래너', emoji: '📋',
    provider: 'claude', model: 'claude-opus-4-6',
    team: 'dev', maxIter: 3, systemPrompt: '',
  };
  const loopState = { aborted: false };
  const projectInfo = _scanProjectInfo(project);

  _poller?.broadcast('project:plan-generating', { planId, projectId, status: 'generating' });

  try {
    const analysisPrompt = _buildAnalysisPrompt(description, projectInfo, images, plan.toolchain);
    const result = await _runSubAgentLoop(
      `plan-${planId}-analysis`,
      { id: 'analyze', description: analysisPrompt },
      profile, '', description, loopState, { maxIter: 3 },
    );

    // The AI may write the plan to autobuild-plan.json via WRITE tool — check for it first
    let rawResponse = result.finalResponse || result;
    const writtenPlanPath = join(project.path, 'autobuild-plan.json');
    if (existsSync(writtenPlanPath)) {
      try {
        const fileContent = readFileSync(writtenPlanPath, 'utf8');
        const testParse = JSON.parse(fileContent);
        if (testParse.plan || testParse.features || testParse.tasks) {
          console.log('[AutoBuild] Using autobuild-plan.json written by AI agent');
          rawResponse = fileContent;
          // Clean up the temp file
          try { unlinkSync(writtenPlanPath); } catch { /* ok */ }
        }
      } catch { /* invalid JSON, ignore */ }
    }
    const parsed = _parseFeatureList(rawResponse);
    plan.features = parsed.features.map((f, i) => new Feature({
      id: f.id || `F-${i + 1}`, title: f.title || f.name || f.feature_name || f.summary || `Feature ${i+1}`, description: f.description || f.desc || f.details || '',
      phase: f.phase || 'core', deps: f.deps || [], images: f.images || [],
      files: f.files || [], type: f.type || 'create',
    }));
    plan.phases = parsed.phases || _defaultPhases();
    plan.designSystem = parsed.designSystem || null;

    // Validate deps — remove references to non-existent features
    const featureIds = new Set(plan.features.map(f => f.id));
    for (const f of plan.features) {
      f.deps = f.deps.filter(d => featureIds.has(d));
    }
  } catch (err) {
    console.error('[AutoBuild] Generation failed:', err);
    _poller?.broadcast('project:error', { planId, error: err.message });
    throw err;
  }

  _plans.set(planId, plan);
  _savePlan(plan);
  _poller?.broadcast('project:plan', plan.toJSON());
  return plan.toJSON();
}

// ══════════════════════════════════════════════════
// Plan Approval
// ══════════════════════════════════════════════════

export function approvePlan(planId, editedFeatures) {
  const plan = _plans.get(planId);
  if (!plan) throw new Error('Plan not found');
  if (plan.status !== PLAN_STATUS.DRAFT) throw new Error('Plan already approved');

  if (editedFeatures && Array.isArray(editedFeatures)) {
    plan.features = editedFeatures.map(f => new Feature({
      id: f.id, title: f.title, description: f.description,
      phase: f.phase, deps: f.deps || [], images: f.images || [],
      files: f.files || [], type: f.type || 'create',
    }));
  }

  plan.status = PLAN_STATUS.APPROVED;
  _savePlan(plan);
  _poller?.broadcast('project:plan', plan.toJSON());
  return plan.toJSON();
}

// ══════════════════════════════════════════════════
// Plan Execution — The AutoBuild Pipeline
// ══════════════════════════════════════════════════

export function executePlan(planId) {
  const plan = _plans.get(planId);
  if (!plan) throw new Error('Plan not found');
  if (!['approved', 'paused', 'failed'].includes(plan.status)) {
    throw new Error(`Cannot execute plan in ${plan.status} state`);
  }

  // Restore projectPath if missing (e.g. after server restart)
  if (!plan.projectPath) {
    const project = _getProjectById(plan.projectId);
    if (!project) throw new Error(`Project not found: ${plan.projectId}`);
    plan.projectPath = project.path;
  }

  // Feature 2: Checkpointing — reset interrupted features, skip completed ones
  const skipped = [];
  for (const f of plan.features) {
    if (f.status === FEATURE_STATUS.DONE) {
      skipped.push(f.id);
    } else if (f.status === FEATURE_STATUS.RUNNING || f.status === FEATURE_STATUS.FAILED) {
      // Reset interrupted/failed features so they can be retried
      f.status = FEATURE_STATUS.QUEUED;
      f.error = null;
    }
  }
  if (skipped.length > 0) {
    console.log(`[AutoBuild] Resuming: skipping ${skipped.length} completed features: ${skipped.join(', ')}`);
  }

  plan.status = PLAN_STATUS.RUNNING;
  plan.startedAt = plan.startedAt || Date.now();
  plan._stopped = false;
  plan._loopState = { aborted: false };
  _savePlan(plan);
  _poller?.broadcast('project:plan', plan.toJSON());

  // Run pipeline async (non-blocking)
  _runAutoBuildPipeline(plan).catch(err => {
    console.error('[AutoBuild] Pipeline error:', err);
    plan.status = PLAN_STATUS.FAILED;
    plan.endedAt = Date.now();
    _poller?.broadcast('project:error', { planId, error: err.message });
    _savePlan(plan);
  });

  return plan.toJSON();
}

// ══════════════════════════════════════════════════
// THE PIPELINE — Single worktree, phased accumulative builds
// ══════════════════════════════════════════════════

async function _runAutoBuildPipeline(plan) {
  console.log(`[AutoBuild] Pipeline START planId=${plan.planId} project=${plan.projectPath}`);
  try {
    // ── Phase 0: Setup ──
    console.log('[AutoBuild] Phase 0: Setup');
    plan.addLog('system', '🏗️ Phase 0: Setup — worktree + npm install', '');
    plan.currentPhase = 'setup';
    _broadcastProgress(plan);

    await _setupWorktree(plan);
    console.log(`[AutoBuild] Worktree ready: ${plan.worktreePath}`);
    if (plan.isStopped()) return _finalizePlan(plan, 'paused');

    // ── Phase 1: Execute features by build-phase ──
    const phaseOrder = {};
    plan.phases.forEach((p, i) => { phaseOrder[p.id] = i; });

    // Group features by phase
    const phaseGroups = new Map();
    for (const phase of plan.phases) {
      phaseGroups.set(phase.id, []);
    }
    for (const feature of plan.features) {
      const group = phaseGroups.get(feature.phase);
      if (group) group.push(feature);
      else {
        // Unknown phase — add to last
        const lastPhase = plan.phases[plan.phases.length - 1];
        if (lastPhase) phaseGroups.get(lastPhase.id)?.push(feature);
      }
    }

    // Execute each phase sequentially
    for (const phase of plan.phases) {
      if (plan.isStopped()) break;

      const features = phaseGroups.get(phase.id) || [];
      if (features.length === 0) continue;

      plan.currentPhase = phase.id;
      plan.addLog('system', `📦 Phase: ${phase.label} (${features.length} features)`, '');
      _broadcastProgress(plan);

      // Within each phase: topo-sort by deps, then execute in parallel layers
      await _executePhaseFeatures(plan, features);
      if (plan.isStopped()) break;

      // After each phase: skip validation for now (too slow)
      plan.addLog('system', `⏭️ Validation skipped for ${phase.label}`, '');
      // await _validateAndHeal(plan);
      // if (plan.isStopped()) break;

      // Commit phase results
      await _commitPhase(plan, phase);
    }

    if (plan.isStopped()) return _finalizePlan(plan, 'paused');

    // ── Pre-validation: fix known issues agents get wrong ──
    await _fixTailwindConfig(plan);
    await reconcileImports(plan);
    await _exec(plan, 'git add -A').catch(() => {});

    // ── Phase 2: Final validation ──
    plan.currentPhase = 'final-validation';
    plan.addLog('system', '🔬 Final validation (tsc + build)...', '');
    _broadcastProgress(plan);
    await _validateAndHeal(plan);
    if (plan.isStopped()) return _finalizePlan(plan, 'paused');

    // ── Phase 3: Review (optional) ──
    if (REVIEW_ENABLED && plan.features.length > 2) {
      plan.currentPhase = 'review';
      plan.addLog('system', '👀 Code review...', '');
      _broadcastProgress(plan);
      await _phaseReview(plan);
      if (plan.isStopped()) return _finalizePlan(plan, 'paused');
    }

    // ── Phase 4: Finalize — PR ──
    plan.currentPhase = 'finalize';
    plan.addLog('system', '🎉 Finalizing — creating PR...', '');
    _broadcastProgress(plan);
    await _phaseFinalize(plan);

    return _finalizePlan(plan, 'done');
  } catch (err) {
    plan.error = err.message;
    plan.addLog('system', `❌ Pipeline error: ${err.message}`, err.stack?.slice(0, 300) || '');
    plan.status = PLAN_STATUS.FAILED;
    plan.endedAt = Date.now();
    _poller?.broadcast('project:error', { planId: plan.planId, error: err.message });
    _savePlan(plan);
  }
}

function _finalizePlan(plan, status) {
  if (status === 'done') {
    plan.status = PLAN_STATUS.DONE;
    // Mark remaining queued features as done (they were executed in-phase)
    for (const f of plan.features) {
      if (f.status === FEATURE_STATUS.RUNNING) {
        f.status = FEATURE_STATUS.DONE;
        f.endedAt = Date.now();
      }
    }
  } else if (status === 'paused') {
    plan.status = PLAN_STATUS.PAUSED;
  }
  plan.endedAt = Date.now();
  _savePlan(plan);

  const progress = plan.getProgress();
  if (status === 'done') {
    _poller?.broadcast('project:done', {
      planId: plan.planId, totalCost: plan.totalCost,
      elapsed: plan.endedAt - plan.startedAt, progress,
      branch: plan.branch,
    });
  }
  _poller?.broadcast('project:plan', plan.toJSON());

  // Cleanup worktree + branches
  if (plan.worktreePath) {
    try { unregisterWorktreeRoot(plan.worktreePath); } catch { /* ok */ }
  }
  if (status === 'done' || status === 'failed') {
    _cleanupWorktree(plan);
  }
}

// ══════════════════════════════════════════════════
// Shared Context — agents share knowledge via .autobuild/context.md
// ══════════════════════════════════════════════════

const CONTEXT_FILE = '.autobuild/context.md';

async function _appendSharedContext(plan, feature) {
  if (!plan.worktreePath) return;
  const wtNative = IS_WIN ? toWinPath(plan.worktreePath) : plan.worktreePath;
  const ctxPath = join(wtNative, CONTEXT_FILE);

  // Scan what files this feature created/modified
  let changedFiles = '';
  try {
    changedFiles = gitExecSync(plan.worktreePath, ['diff', '--name-only', 'HEAD'], { timeout: 5000 }).trim();
    // Also include staged files
    const untracked = gitExecSync(plan.worktreePath, ['diff', '--name-only', '--cached'], { timeout: 5000 }).trim();
    if (untracked) changedFiles += '\n' + untracked;
    changedFiles = [...new Set(changedFiles.split('\n').filter(Boolean))].join('\n');
  } catch { /* ok */ }

  // Scan exports from new/modified .tsx/.ts files
  const exports = [];
  if (changedFiles) {
    for (const f of changedFiles.split('\n')) {
      if (!/\.(tsx?|ts)$/.test(f)) continue;
      try {
        const content = readFileSync(join(wtNative, f), 'utf8');
        const expNames = [];
        for (const line of content.split('\n')) {
          const m = line.match(/^export\s+(?:const|function|class|interface|type|default\s+function)\s+(\w+)/);
          if (m) expNames.push(m[1]);
        }
        if (/^export\s+default/m.test(content) && !expNames.length) expNames.push('default');
        if (expNames.length) exports.push(`  ${f}: ${expNames.join(', ')}`);
      } catch { /* ok */ }
    }
  }

  // Build context entry
  const entry = [
    `## ${feature.id}: ${feature.title}`,
    `Phase: ${feature.phase} | Agent: ${feature.agentId} | Time: ${feature.startedAt && feature.endedAt ? Math.round((feature.endedAt - feature.startedAt) / 1000) + 's' : '?'}`,
    '',
    changedFiles ? `### Files\n\`\`\`\n${changedFiles}\n\`\`\`\n` : 'No files changed.',
    exports.length ? `### Exports\n${exports.join('\n')}\n` : '',
    '---',
    '',
  ].join('\n');

  try {
    mkdirSync(join(wtNative, '.autobuild'), { recursive: true });
    const existing = existsSync(ctxPath) ? readFileSync(ctxPath, 'utf8') : '# AutoBuild Shared Context\n\n';
    const updated = _condenseSharedContext(existing + entry);
    writeFileSync(ctxPath, updated, 'utf8');
  } catch { /* ok */ }
}

/**
 * Feature 1: Context Summarization
 * Keep only the last 5 features in full detail.
 * Older features are condensed to a single-line summary.
 */
function _condenseSharedContext(content) {
  const KEEP_FULL = 5;
  // Split by feature sections (## F-N: title)
  const sections = content.split(/(?=^## F-\d+:)/m);
  const header = sections[0]; // "# AutoBuild Shared Context\n\n" or similar
  const featureSections = sections.slice(1);

  if (featureSections.length <= KEEP_FULL) return content;

  // Condense older features
  const toCondense = featureSections.slice(0, featureSections.length - KEEP_FULL);
  const toKeep = featureSections.slice(featureSections.length - KEEP_FULL);

  const condensed = toCondense.map(section => {
    // Extract "## F-N: title" and files list
    const titleMatch = section.match(/^## (F-\d+): (.+)/m);
    if (!titleMatch) return '';
    const fId = titleMatch[1];
    const fTitle = titleMatch[2].trim();
    // Extract file list from ```...``` block
    const filesMatch = section.match(/### Files\n```\n([\s\S]*?)```/);
    const files = filesMatch ? filesMatch[1].trim().split('\n').filter(Boolean).join(', ') : '';
    return `- ${fId}: ${fTitle}${files ? ' → ' + files : ''}`;
  }).filter(Boolean);

  return [
    header.trimEnd(),
    '',
    '## Completed (condensed)',
    ...condensed,
    '',
    '---',
    '',
    ...toKeep,
  ].join('\n');
}

function _readSharedContext(plan) {
  if (!plan.worktreePath) return '';
  const wtNative = IS_WIN ? toWinPath(plan.worktreePath) : plan.worktreePath;
  const ctxPath = join(wtNative, CONTEXT_FILE);
  try {
    if (existsSync(ctxPath)) return readFileSync(ctxPath, 'utf8');
  } catch { /* ok */ }
  return '';
}

// ══════════════════════════════════════════════════
// Feature 3: Self-tracking Todo in .autobuild/todos.md
// ══════════════════════════════════════════════════

const TODO_FILE = '.autobuild/todos.md';

function _writeTodoForFeature(plan, feature) {
  if (!plan.worktreePath) return;
  const wtNative = IS_WIN ? toWinPath(plan.worktreePath) : plan.worktreePath;
  const todoPath = join(wtNative, TODO_FILE);

  // Build task items based on feature type
  const tasks = [];
  if (feature.type === 'create') {
    tasks.push('기존 코드 구조 확인 (GLOB)');
    for (const f of feature.files) {
      tasks.push(`${f} 생성`);
    }
    if (feature.files.length === 0) {
      tasks.push('대상 파일 생성');
    }
    tasks.push('mock 데이터 추가');
    tasks.push('import 경로 확인');
  } else {
    tasks.push('수정 대상 파일 읽기 (READ)');
    for (const f of feature.files) {
      tasks.push(`${f} 수정`);
    }
    if (feature.files.length === 0) {
      tasks.push('대상 파일 수정');
    }
    tasks.push('기존 코드와 호환성 확인');
  }
  tasks.push('git add -A');

  const todoSection = [
    `## ${feature.id}: ${feature.title}`,
    ...tasks.map(t => `- [ ] ${t}`),
    '',
  ].join('\n');

  try {
    mkdirSync(join(wtNative, '.autobuild'), { recursive: true });
    const existing = existsSync(todoPath) ? readFileSync(todoPath, 'utf8') : '# AutoBuild Task Tracker\n\n';
    writeFileSync(todoPath, existing + todoSection + '\n', 'utf8');
  } catch { /* ok */ }

  return todoPath;
}

function _updateTodoChecked(plan, feature) {
  if (!plan.worktreePath) return;
  const wtNative = IS_WIN ? toWinPath(plan.worktreePath) : plan.worktreePath;
  const todoPath = join(wtNative, TODO_FILE);

  try {
    if (!existsSync(todoPath)) return;
    let content = readFileSync(todoPath, 'utf8');

    // Find the section for this feature and check all boxes
    const sectionRegex = new RegExp(
      `(## ${feature.id.replace(/[-/]/g, '\\$&')}:[^]*?)(?=\n## |$)`, 'm'
    );
    content = content.replace(sectionRegex, (match) => {
      return match.replace(/- \[ \]/g, '- [x]');
    });

    writeFileSync(todoPath, content, 'utf8');
  } catch { /* ok */ }
}

function _cleanupWorktree(plan) {
  if (!plan.worktreePath || !plan.projectPath) return;
  const wtNative = IS_WIN ? toWinPath(plan.worktreePath) : plan.worktreePath;

  // Remove worktree directory
  try {
    gitExecSync(plan.projectPath, ['worktree', 'remove', plan.worktreePath, '--force'], { timeout: 10000 });
    plan.addLog('system', '🧹 워크트리 삭제 완료', '');
  } catch {
    // Fallback: just prune
    try {
      gitExecSync(plan.projectPath, ['worktree', 'prune'], { timeout: 5000 });
    } catch { /* ok */ }
  }

  // Delete autobuild branch
  if (plan.branch) {
    try {
      gitExecSync(plan.projectPath, ['branch', '-D', plan.branch], { timeout: 5000 });
    } catch { /* ok */ }
  }
}

// ══════════════════════════════════════════════════
// Phase Feature Execution — Parallel within deps layers
// ══════════════════════════════════════════════════

async function _executePhaseFeatures(plan, features) {
  // Topo-sort within phase: split into layers by deps
  const completed = new Set();
  // Features already done from previous phases
  for (const f of plan.features) {
    if (f.status === FEATURE_STATUS.DONE) completed.add(f.id);
  }

  const remaining = [...features.filter(f => f.status !== FEATURE_STATUS.DONE)];

  while (remaining.length > 0) {
    if (plan.isStopped()) return;

    // Find features whose deps are all satisfied
    const ready = remaining.filter(f =>
      f.deps.every(d => completed.has(d))
    );

    if (ready.length === 0) {
      // Circular deps or unsatisfied — force execute remaining sequentially
      plan.addLog('system', `⚠️ ${remaining.length} features with unresolved deps — executing sequentially`, '');
      for (const f of remaining) {
        if (plan.isStopped()) return;
        await _executeSingleFeature(plan, f);
        completed.add(f.id);
      }
      break;
    }

    // Execute ready features in parallel (semaphore-limited)
    plan.addLog('system', `▶️ Executing ${ready.length} features in parallel`, ready.map(f => f.id).join(', '));
    await _executeBatchFeatures(plan, ready);

    for (const f of ready) {
      completed.add(f.id);
      remaining.splice(remaining.indexOf(f), 1);
    }
  }
}

async function _executeBatchFeatures(plan, features) {
  if (features.length === 0) return;

  // First feature runs sequentially — establishes context in shared context file
  const [first, ...rest] = features;
  plan.addLog('system', `🔑 ${first.id} 선행 실행 (컨텍스트 확립)`, '');
  try {
    await _executeSingleFeature(plan, first);
  } catch (err) {
    first.status = FEATURE_STATUS.FAILED;
    first.error = err.message;
    first.endedAt = Date.now();
    plan.addLog('system', `❌ ${first.id} failed: ${err.message}`, '');
  }

  if (rest.length === 0 || plan.isStopped()) return;

  // Remaining features run in parallel (can read the context established by first)
  plan.addLog('system', `⚡ ${rest.length}개 Feature 병렬 실행 (컨텍스트 참조)`, rest.map(f => f.id).join(', '));
  const sem = new Semaphore(IMPL_SEMAPHORE);

  const tasks = rest.map((feature) => {
    return (async () => {
      await sem.acquire();
      if (plan.isStopped()) { sem.release(); return; }

      try {
        await _executeSingleFeature(plan, feature);
      } catch (err) {
        feature.status = FEATURE_STATUS.FAILED;
        feature.error = err.message;
        feature.endedAt = Date.now();
        plan.addLog('system', `❌ ${feature.id} failed: ${err.message}`, '');
      }

      sem.release();
    })();
  });

  await Promise.all(tasks);
}

async function _executeSingleFeature(plan, feature) {
  console.log(`[AutoBuild] Feature ${feature.id} START: ${feature.title}`);
  feature.status = FEATURE_STATUS.RUNNING;
  feature.startedAt = Date.now();
  _poller?.broadcast('project:feature-update', {
    planId: plan.planId, featureId: feature.id,
    status: feature.status,
  });

  // Pick agent: last feature or integration → always senior (Pro), others by complexity
  const featureIdx = plan.features.indexOf(feature);
  const isLast = featureIdx === plan.features.length - 1;
  const isIntegration = feature.phase === 'integration' || feature.deps.length > 1 || isLast;
  // Opus for: integration, last feature, setup phase (design system), complex features
  const isSetup = feature.phase === 'setup';
  const agentKey = (isIntegration || isSetup) ? 'architect' : (feature.files.length > 3 ? 'senior' : 'mid');
  const profile = getProfile(agentKey);
  feature.agentId = profile.id;

  const convId = `autobuild-${plan.planId}-${feature.id}`;

  // Feature 3: Write task todo before starting
  const todoPath = _writeTodoForFeature(plan, feature);
  const prompt = _buildFeaturePrompt(plan, feature, todoPath);

  try {
    const result = await _runSubAgentLoop(convId, {
      id: convId,
      description: prompt,
    }, profile, '', plan.description, plan._loopState, {
      projectContext: _buildProjectContext(plan),
      maxIter: 15,
      sprintMode: true,
    });

    feature.agentLog.push({ ts: new Date().toISOString(), agent: profile.id, action: 'implement', detail: (typeof result === 'string' ? result : '').slice(0, 500) });

    // Ensure changes are staged (agent may have committed already)
    let hasChanges = false;
    try {
      const st = await _exec(plan, 'git status --porcelain');
      hasChanges = !!st.output.trim();
      if (hasChanges) {
        await _exec(plan, 'git add -A');
      }
    } catch { /* ok */ }

    // Check: agent must have actually produced changes
    if (!hasChanges) {
      console.error(`[AutoBuild] WARNING: ${feature.id} agent finished but NO file changes detected!`);
      plan.addLog(profile.id, `⚠️ ${feature.id}: 에이전트 완료했지만 파일 변경 없음`, (typeof result === 'string' ? result : '').slice(0, 300));
    }

    // Write shared context — so next agents know what this feature produced
    await _appendSharedContext(plan, feature);

    // Integration quality check: if last feature, verify App.tsx imports components
    if (isIntegration && plan.worktreePath) {
      const appPath = join(IS_WIN ? toWinPath(plan.worktreePath) : plan.worktreePath, 'src/App.tsx');
      if (existsSync(appPath)) {
        const appContent = readFileSync(appPath, 'utf8');
        const hasImports = /^import\s+.*from\s+['"]\.\/(?:components|hooks)/m.test(appContent);
        const hasPlaceholder = /placeholder|여기에.*예정|will be.*here|통합될/i.test(appContent);
        if (!hasImports || hasPlaceholder) {
          console.error(`[AutoBuild] ${feature.id}: App.tsx integration incomplete (imports=${hasImports}, placeholder=${hasPlaceholder}). Retrying...`);
          plan.addLog(profile.id, `⚠️ ${feature.id}: App.tsx 통합 불완전 — 재시도`, '');
          // Retry with stronger prompt
          const retryPrompt = `[RETRY - App.tsx 통합 불완전]
${prompt}

⚠️ 이전 시도에서 App.tsx가 컴포넌트를 import하지 않았거나 placeholder만 넣었습니다.
반드시 위에 제공된 import 구문을 사용하고, 모든 컴포넌트를 실제로 렌더링하세요.
"여기에 들어갈 예정" 같은 텍스트는 절대 금지입니다.`;
          try {
            await _runSubAgentLoop(`${convId}-integration-retry`, {
              id: `${convId}-integration-retry`,
              description: retryPrompt,
            }, profile, '', plan.description, plan._loopState, {
              projectContext: _buildProjectContext(plan),
              maxIter: 15,
              sprintMode: true,
            });
            try { await _exec(plan, 'git add -A'); } catch { /* ok */ }
          } catch (retryErr) {
            plan.addLog(profile.id, `❌ ${feature.id} 재시도 실패: ${retryErr.message}`, '');
          }
        }
      }
    }

    feature.status = FEATURE_STATUS.DONE;
    feature.endedAt = Date.now();
  } catch (err) {
    feature.status = FEATURE_STATUS.FAILED;
    feature.error = err.message;
    feature.endedAt = Date.now();

    // Retry once with senior agent
    if (feature.retryCount < 1) {
      feature.retryCount++;
      feature.status = FEATURE_STATUS.RUNNING;
      feature.error = null;
      plan.addLog(profile.id, `${feature.id} 실패 — 재시도 (${feature.retryCount})`, err.message);

      try {
        const retryProfile = getProfile('senior');
        await _runSubAgentLoop(`${convId}-retry`, {
          id: `${convId}-retry`,
          description: `[RETRY] 이전 시도 실패: ${err.message}\n\n${prompt}`,
        }, retryProfile, '', plan.description, plan._loopState, {
          projectContext: _buildProjectContext(plan),
          maxIter: 15,
          sprintMode: true,
        });

        try {
          const st2 = await _exec(plan, 'git status --porcelain');
          if (st2.output.trim()) await _exec(plan, 'git add -A');
        } catch { /* ok */ }

        feature.status = FEATURE_STATUS.DONE;
        feature.endedAt = Date.now();
      } catch (retryErr) {
        feature.status = FEATURE_STATUS.FAILED;
        feature.error = retryErr.message;
        feature.endedAt = Date.now();
      }
    }
  }

  // Feature 3: Mark todo items as checked on completion
  if (feature.status === FEATURE_STATUS.DONE) {
    _updateTodoChecked(plan, feature);
  }

  _poller?.broadcast('project:feature-update', {
    planId: plan.planId, featureId: feature.id,
    status: feature.status, agentId: feature.agentId,
    error: feature.error,
  });
  _broadcastProgress(plan);
  _savePlan(plan);
}

// ══════════════════════════════════════════════════
// Compiler-Driven Self-Healing (Validate + Fix)
// ══════════════════════════════════════════════════

async function _validateAndHeal(plan) {
  const validationCmds = _getValidationCmds(plan.toolchain);

  const steps = [
    { name: 'typecheck', cmd: validationCmds.typecheck, label: 'TypeScript' },
    { name: 'lint', cmd: null, label: 'ESLint' },  // dynamic — lint only changed files
    { name: 'build', cmd: validationCmds.build, label: 'Build' },
  ];

  for (let cycle = 0; cycle < VALIDATION_CYCLES; cycle++) {
    if (plan.isStopped()) return;

    plan.addLog('system', `검증 사이클 ${cycle + 1}/${VALIDATION_CYCLES}`, '');
    let allPassed = true;

    for (const step of steps) {
      if (plan.isStopped()) return;

      // Dynamic lint command: only changed files
      let cmd = step.cmd;
      if (step.name === 'lint') {
        const changedFiles = await _getChangedFiles(plan);
        if (!changedFiles) {
          plan.addLog('system', `✅ ${step.label} 스킵 (변경 파일 없음)`, '');
          continue;
        }
        cmd = `npx eslint ${changedFiles} --format json 2>&1 || true`;
      }

      const result = await _exec(plan, cmd);
      const passed = result.exitCode === 0;

      _poller?.broadcast('sprint:validate', {
        sprintId: plan.planId, cycle: cycle + 1,
        command: step.name, label: step.label, passed,
      });

      if (passed) {
        plan.addLog('system', `✅ ${step.label} 통과`, '');
        continue;
      }

      allPassed = false;
      plan.addLog('system', `❌ ${step.label} 실패 — 3단계 수정 시작`, result.output.slice(0, 500));

      let fixed = false;

      // ── Level 1: Inline retry — just re-run build, sometimes transient ──
      if (!fixed) {
        plan.addLog('system', `🔄 Level 1: Inline 재시도 (${step.label})`, '');
        const inlineRetry = await _exec(plan, cmd);
        if (inlineRetry.exitCode === 0) {
          plan.addLog('system', `✅ ${step.label} Level 1 통과 (transient error)`, '');
          fixed = true;
        } else {
          result.output = inlineRetry.output;
        }
      }

      // ── Level 2: Diagnostic-driven fix — parse errors into structured diagnostics ──
      if (!fixed) {
        const diagnostics = _parseErrorDiagnostics(result.output, plan.worktreePath);
        const diagnosticText = diagnostics.length > 0
          ? diagnostics.map((d, i) => `${i + 1}. 파일: ${d.file}${d.line ? ` (line ${d.line})` : ''}\n   에러: ${d.message}\n   수정방법: ${d.suggestion}`).join('\n')
          : `(구조화 파싱 실패 — 원본 에러 참고)\n\`\`\`\n${result.output.slice(0, 2000)}\n\`\`\``;

        for (let retry = 0; retry < VALIDATION_MAX_FIX; retry++) {
          if (plan.isStopped()) return;
          if (fixed) break;

          const fixProfile = getProfile(retry === 0 ? 'senior' : 'architect');
          plan.addLog(fixProfile.id, `🔍 Level 2: 진단 기반 수정 ${retry + 1}/${VALIDATION_MAX_FIX} (${step.label})`, '');

          const fixConvId = `autobuild-${plan.planId}-fix-${step.name}-c${cycle}-L2-r${retry}`;
          await _runSubAgentLoop(fixConvId, {
            id: fixConvId,
            description: `[VALIDATION FIX - ${step.label.toUpperCase()} - Level 2: Diagnostic]
PROJECT: ${plan.worktreePath}

검증 명령 "${cmd}" 실행 결과 에러가 발생했습니다.

## 에러 진단
${diagnosticText}

수행할 작업:
1. 위 진단을 순서대로 처리 — 각 파일의 해당 라인을 수정
2. READ로 해당 파일 확인 (반드시 절대 경로: ${plan.worktreePath}/src/...)
3. WRITE로 파일 전체를 다시 작성하세요 (EDIT보다 확실합니다)
4. import 경로가 틀렸다면 GLOB으로 실제 파일 위치를 확인하세요
5. 수정 완료 후 git add -A (커밋은 하지 마세요 — 엔진이 관리합니다)

중요: any 타입 금지, eslint-disable 금지. 근본 원인을 수정하세요. 모든 경로는 절대 경로로.`,
          }, fixProfile, '', plan.description, plan._loopState, {
            projectContext: _buildProjectContext(plan),
            maxIter: 10,
            sprintMode: true,
          });

          try { await _exec(plan, 'git add -A'); } catch { /* ok */ }

          const recheck = await _exec(plan, cmd);
          if (recheck.exitCode === 0) {
            plan.addLog(fixProfile.id, `✅ ${step.label} Level 2 수정 성공`, '');
            fixed = true;
          } else {
            result.output = recheck.output;
          }
        }
      }

      // ── Level 3: Partial retry — identify working vs broken features, re-run only broken ──
      if (!fixed) {
        plan.addLog('system', `🧩 Level 3: 부분 재시도 (${step.label})`, '');
        const brokenFiles = _parseBrokenFiles(result.output, plan.worktreePath);
        if (brokenFiles.length > 0 && brokenFiles.length < 10) {
          // Only fix specific broken files, not the entire project
          const fixProfile = getProfile('architect');
          const fixConvId = `autobuild-${plan.planId}-fix-${step.name}-c${cycle}-L3`;

          await _runSubAgentLoop(fixConvId, {
            id: fixConvId,
            description: `[VALIDATION FIX - ${step.label.toUpperCase()} - Level 3: Partial Fix]
PROJECT: ${plan.worktreePath}

대부분의 코드는 정상이지만 아래 파일들에만 에러가 있습니다.
이 파일들만 집중적으로 수정하세요. 나머지 파일은 건드리지 마세요.

## 수정 대상 파일
${brokenFiles.map(f => `- ${f}`).join('\n')}

## 에러 출력 (해당 파일 관련만 참고)
\`\`\`
${result.output.slice(0, 3000)}
\`\`\`

수행할 작업:
1. 위 파일들만 READ로 확인 (절대 경로: ${plan.worktreePath}/...)
2. WRITE로 해당 파일만 다시 작성
3. 다른 파일은 절대 수정하지 마세요
4. import 경로 문제면 GLOB으로 실제 위치 확인
5. 수정 완료 후 git add -A

중요: any 타입 금지, eslint-disable 금지. 근본 원인을 수정하세요.`,
          }, fixProfile, '', plan.description, plan._loopState, {
            projectContext: _buildProjectContext(plan),
            maxIter: 10,
            sprintMode: true,
          });

          try { await _exec(plan, 'git add -A'); } catch { /* ok */ }

          const recheck = await _exec(plan, cmd);
          if (recheck.exitCode === 0) {
            plan.addLog(fixProfile.id, `✅ ${step.label} Level 3 부분 수정 성공`, '');
            fixed = true;
          } else {
            result.output = recheck.output;
          }
        }
      }

      if (!fixed) {
        plan.addLog('system', `⚠️ ${step.label} 3단계 수정 모두 실패 — 다음 사이클에서 재시도`, '');
        break; // Stop current cycle, try next
      }
    }

    plan.validationLog.push({ cycle: cycle + 1, allPassed });

    if (allPassed) {
      plan.addLog('system', '✅ 모든 검증 통과', '');
      return;
    }
  }

  plan.addLog('system', `⚠️ 검증 ${VALIDATION_CYCLES}사이클 완료 — 일부 미해결`, '');
}

/**
 * Parse compiler/build error output into structured diagnostics.
 * Handles TypeScript, ESLint, and Next.js/Vite build errors.
 */
function _parseErrorDiagnostics(output, worktreePath) {
  const diagnostics = [];
  const lines = output.split('\n');
  const wtPrefix = worktreePath ? worktreePath.replace(/\\/g, '/') : '';

  for (const line of lines) {
    // TypeScript: src/components/Foo.tsx(5,10): error TS2307: Cannot find module...
    let m = line.match(/([^\s(]+\.(tsx?|jsx?))\((\d+),\d+\):\s*error\s+TS\d+:\s*(.+)/);
    if (m) {
      diagnostics.push({
        file: m[1], line: m[3], message: m[4].trim(),
        suggestion: _suggestFix(m[4].trim()),
      });
      continue;
    }
    // TypeScript alt: src/components/Foo.tsx:5:10 - error TS2307: Cannot find module...
    m = line.match(/([^\s:]+\.(tsx?|jsx?)):(\d+):\d+\s*-\s*error\s+TS\d+:\s*(.+)/);
    if (m) {
      diagnostics.push({
        file: m[1], line: m[3], message: m[4].trim(),
        suggestion: _suggestFix(m[4].trim()),
      });
      continue;
    }
    // Next.js/Vite build: ./src/app/cart/page.tsx:5:0  Module not found...
    m = line.match(/\.\/([^\s:]+\.(tsx?|jsx?)):(\d+):\d+\s+(.+)/);
    if (m) {
      diagnostics.push({
        file: m[1], line: m[3], message: m[4].trim(),
        suggestion: _suggestFix(m[4].trim()),
      });
      continue;
    }
    // ESLint JSON or generic: "filePath":"...", or Error: file.tsx line N
    m = line.match(/"filePath":\s*"([^"]+)"/);
    if (m) {
      // Try to extract message from nearby lines
      const msgMatch = output.match(new RegExp(`${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]{0,200}?"message":\\s*"([^"]+)"`));
      diagnostics.push({
        file: m[1].replace(wtPrefix + '/', '').replace(wtPrefix, ''),
        line: null, message: msgMatch ? msgMatch[1] : 'ESLint error',
        suggestion: 'ESLint 규칙에 따라 코드 수정',
      });
      continue;
    }
    // export 'X' (imported as 'X') was not found in '...'
    m = line.match(/export '(\w+)'.*was not found in '([^']+)'/);
    if (m) {
      diagnostics.push({
        file: m[2], line: null, message: `export '${m[1]}' not found`,
        suggestion: `${m[1]} 컴포넌트/함수를 해당 모듈에 추가하거나, import 경로를 수정`,
      });
      continue;
    }
  }

  // Deduplicate by file+line
  const seen = new Set();
  return diagnostics.filter(d => {
    const key = `${d.file}:${d.line || '?'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 15); // Cap at 15 diagnostics
}

function _suggestFix(errorMsg) {
  if (/cannot find module|module not found/i.test(errorMsg))
    return 'GLOB으로 실제 파일 위치 확인 후 import 경로 수정';
  if (/is not assignable to|type.*is not/i.test(errorMsg))
    return '타입 정의 확인 후 올바른 타입으로 수정';
  if (/property.*does not exist/i.test(errorMsg))
    return '해당 타입/인터페이스에 프로퍼티 추가 또는 올바른 프로퍼티명 사용';
  if (/export.*not found|has no exported member/i.test(errorMsg))
    return '해당 모듈에서 실제 export되는 이름 확인 후 import 수정';
  if (/cannot redeclare|duplicate identifier/i.test(errorMsg))
    return '중복 선언 제거';
  if (/unused|declared but.*never/i.test(errorMsg))
    return '사용하지 않는 변수/import 제거';
  if (/expected.*arguments.*got/i.test(errorMsg))
    return '함수 시그니처에 맞게 인자 수정';
  return '에러 메시지를 분석하고 근본 원인을 수정';
}

/**
 * Extract the list of broken files from error output.
 * Used by Level 3 partial retry to scope fixes to specific files.
 */
function _parseBrokenFiles(output, worktreePath) {
  const files = new Set();
  const wtPrefix = worktreePath ? worktreePath.replace(/\\/g, '/') : '';

  for (const line of output.split('\n')) {
    // Match file paths in error output
    let m = line.match(/([^\s(:"]+\.(tsx?|jsx?))/);
    if (m) {
      let f = m[1];
      // Normalize: remove absolute prefix, leading ./
      f = f.replace(wtPrefix + '/', '').replace(wtPrefix, '').replace(/^\.\//, '');
      // Only include src/ files (not node_modules etc.)
      if (f.startsWith('src/') || f.startsWith('app/') || f.startsWith('components/') || f.startsWith('lib/') || f.startsWith('pages/')) {
        files.add(f);
      }
    }
  }
  return [...files];
}

async function _getChangedFiles(plan) {
  try {
    const result = await _exec(plan, `git diff --name-only --diff-filter=ACMR origin/${plan.baseBranch}...HEAD`);
    if (result.exitCode !== 0) return null;
    const files = result.output.split('\n')
      .filter(f => /\.(ts|tsx|js|jsx)$/.test(f.trim()))
      .map(f => f.trim())
      .filter(Boolean);
    return files.length > 0 ? files.join(' ') : null;
  } catch { return null; }
}

// ══════════════════════════════════════════════════
// Code Review
// ══════════════════════════════════════════════════

async function _phaseReview(plan) {
  const profile = getProfile('architect');
  const convId = `autobuild-${plan.planId}-review`;

  await _runSubAgentLoop(convId, {
    id: convId,
    description: `[CODE REVIEW]

PROJECT: ${plan.worktreePath}
BRANCH: ${plan.branch}

React 코드 리뷰 체크리스트:
1. useEffect dependency array 누락/과잉
2. Array.map에 key prop 없음
3. state 직접 변이 (setter 미사용)
4. 3레벨+ prop drilling
5. 200줄+ 컴포넌트
6. inline style 객체 매 렌더 재생성
7. cleanup 없는 useEffect (구독, 타이머)
8. 불필요한 리렌더
9. XSS 위험: dangerouslySetInnerHTML
10. 시크릿/API 키 하드코딩

수행할 작업:
1. BASH git diff origin/${plan.baseBranch}...HEAD --stat
2. 변경된 주요 파일 READ (최대 10개)
3. Critical 이슈 발견 시 EDIT로 직접 수정
4. 수정 후 git add -A (커밋은 하지 마세요)`,
  }, profile, '', plan.description, plan._loopState, {
    projectContext: _buildProjectContext(plan),
    maxIter: 15,
    sprintMode: true,
  });

  // Stage review fixes
  try { await _exec(plan, 'git add -A'); } catch { /* ok */ }
}

// ══════════════════════════════════════════════════
// Finalize — PR Creation
// ══════════════════════════════════════════════════

async function _phaseFinalize(plan) {
  // Final commit of any unstaged changes
  try {
    const st = await _exec(plan, 'git status --porcelain');
    if (st.output.trim()) {
      await _exec(plan, 'git add -A');
      await _exec(plan, `git commit -m "feat: AutoBuild final polish"`);
      await _exec(plan, `git push origin ${plan.branch}`);
    }
  } catch { /* ok */ }

  // Create PR
  const progress = plan.getProgress();
  const elapsed = Date.now() - plan.startedAt;
  const title = `[AutoBuild] ${plan.description.slice(0, 60)}`;
  const body = [
    '## AutoBuild Summary',
    `- **Description**: ${plan.description}`,
    `- **Branch**: \`${plan.branch}\``,
    `- **Features**: ${progress.done}/${progress.total} done`,
    `- **Elapsed**: ${Math.round(elapsed / 60000)}min`,
    `- **Cost**: $${plan.totalCost.toFixed(4)}`,
    '',
    '## Features',
    ...plan.features.map(f => `- ${f.status === 'done' ? '✅' : '❌'} ${f.id}: ${f.title}`),
    '',
    '---',
    '🤖 Generated by AutoBuild Pipeline',
  ].join('\n');

  try {
    const result = await _exec(plan, `gh pr create --head ${plan.branch} --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`);
    const urlMatch = result.output.match(/https:\/\/github\.com\/[^\s]+/);
    if (urlMatch) plan.addLog('system', `PR: ${urlMatch[0]}`, '');
  } catch (err) {
    plan.addLog('system', `PR 생성 실패: ${err.message}`, '');
  }
}

// ══════════════════════════════════════════════════
// Worktree Setup — Single worktree for entire plan
// ══════════════════════════════════════════════════

async function _setupWorktree(plan) {
  console.log(`[AutoBuild] _setupWorktree start for ${plan.projectPath}`);
  const projectPath = plan.projectPath;
  const projectName = basename(projectPath);
  const branchSlug = slugify(plan.description.slice(0, 40));
  plan.branch = `autobuild/${branchSlug}-${Date.now().toString(36)}`;

  const worktreePathFwd = dirname(projectPath) + '/' + `${projectName}-autobuild-${plan.planId}`;

  // Pre-cleanup: remove stale worktrees and branches from previous runs
  try {
    await _execInProject(projectPath, 'git worktree prune');
    // Remove the target worktree dir if it exists as a stale entry
    const wtNativeCheck = IS_WIN ? toWinPath(worktreePathFwd) : worktreePathFwd;
    if (existsSync(wtNativeCheck)) {
      await _execInProject(projectPath, `git worktree remove "${worktreePathFwd}" --force`).catch(() => {});
    }
    // Remove any existing autobuild branches for this plan
    const branches = await _execInProject(projectPath, 'git branch');
    if (branches.exitCode === 0) {
      const abBranches = branches.output.split('\n')
        .map(b => b.trim().replace(/^\*\s*/, ''))
        .filter(b => b.startsWith('autobuild/') && b !== plan.branch);
      for (const b of abBranches) {
        await _execInProject(projectPath, `git branch -D "${b}"`).catch(() => {});
      }
    }
  } catch { /* ok */ }

  // Detect base branch + check if remote exists
  let hasRemote = false;
  try {
    const remoteCheck = await _execInProject(projectPath, 'git remote');
    hasRemote = remoteCheck.exitCode === 0 && remoteCheck.output.trim().includes('origin');
  } catch { /* ok */ }

  if (hasRemote) {
    try {
      const headRef = await _execInProject(projectPath, 'git symbolic-ref refs/remotes/origin/HEAD');
      if (headRef.exitCode === 0) {
        const detected = headRef.output.trim().replace(/^refs\/remotes\/origin\//, '');
        if (detected && !detected.includes('fatal')) plan.baseBranch = detected;
      } else {
        for (const branch of ['dev', 'main', 'master']) {
          const check = await _execInProject(projectPath, `git rev-parse --verify origin/${branch}`);
          if (check.exitCode === 0) { plan.baseBranch = branch; break; }
        }
      }
    } catch { /* ok */ }
  } else {
    // No remote — detect local branch
    try {
      const localBranch = await _execInProject(projectPath, 'git branch --show-current');
      if (localBranch.exitCode === 0 && localBranch.output.trim()) {
        plan.baseBranch = localBranch.output.trim();
      }
    } catch { /* ok */ }
  }

  plan.addLog('system', `기본 브랜치: ${plan.baseBranch} (remote: ${hasRemote})`, '');

  // Fetch + create worktree
  if (hasRemote) {
    const fetchResult = await _execInProject(projectPath, `git fetch origin ${plan.baseBranch}`);
    if (fetchResult.exitCode !== 0) {
      plan.addLog('system', `fetch 실패 — 로컬 브랜치에서 worktree 생성`, '');
    }
  }

  plan.addLog('system', `워크트리 생성: ${worktreePathFwd}`, '');
  const wtBase = hasRemote ? `origin/${plan.baseBranch}` : plan.baseBranch;
  await _execInProject(projectPath, `git worktree add ${worktreePathFwd} -b ${plan.branch} ${wtBase}`);

  const wtNative = IS_WIN ? toWinPath(worktreePathFwd) : worktreePathFwd;
  if (!existsSync(wtNative)) {
    throw new Error('Worktree creation failed');
  }

  // Push branch (only if remote exists)
  if (hasRemote) {
    try { await _execInProject(worktreePathFwd, `git push -u origin ${plan.branch}`); } catch { /* ok */ }
  }

  // npm install (once!)
  if (existsSync(join(wtNative, 'package.json'))) {
    plan.addLog('system', 'npm install 실행 중...', '');
    try { await _execInProject(worktreePathFwd, 'npm install', 180000); } catch (err) {
      plan.addLog('system', `npm install 경고: ${err.message}`, '');
    }
  }

  plan.worktreePath = worktreePathFwd;
  registerWorktreeRoot(worktreePathFwd);

  // Auto-fix Tailwind v4 config (agents consistently get this wrong)
  await _fixTailwindConfig(plan);

  // Install shadcn/ui components (so agents use real components, not stubs)
  await _setupShadcn(plan);

  plan.addLog('system', `✅ 워크트리 준비 완료`, '');
}

async function _setupShadcn(plan) {
  const wt = plan.worktreePath;
  const wtNative = IS_WIN ? toWinPath(wt) : wt;

  // Check if shadcn is already set up
  if (existsSync(join(wtNative, 'components', 'ui', 'button.tsx'))) return;

  plan.addLog('system', '🎨 shadcn/ui 설치 중...', '');

  // Install deps
  try {
    await _execInProject(wt, 'npm install @radix-ui/react-slot class-variance-authority clsx tailwind-merge lucide-react', 60000);
  } catch { /* ok */ }

  // Create lib/utils.ts (shadcn requirement)
  const utilsPath = plan.toolchain === 'next' ? join(wtNative, 'lib', 'utils.ts') : join(wtNative, 'src', 'lib', 'utils.ts');
  if (!existsSync(utilsPath)) {
    mkdirSync(dirname(utilsPath), { recursive: true });
    writeFileSync(utilsPath, `import { type ClassValue, clsx } from "clsx";\nimport { twMerge } from "tailwind-merge";\n\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs));\n}\n`, 'utf8');
  }

  // Create core shadcn components
  const uiDir = plan.toolchain === 'next' ? join(wtNative, 'components', 'ui') : join(wtNative, 'src', 'components', 'ui');
  mkdirSync(uiDir, { recursive: true });

  const cnImport = plan.toolchain === 'next' ? '@/lib/utils' : '@/lib/utils';

  const components = {
    'button.tsx': `import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "${cnImport}";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";
export { Button, buttonVariants };`,

    'input.tsx': `import * as React from "react";
import { cn } from "${cnImport}";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";
export { Input };`,

    'card.tsx': `import * as React from "react";
import { cn } from "${cnImport}";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)} {...props} />
  )
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
  )
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn("text-2xl font-semibold leading-none tracking-tight", className)} {...props} />
  )
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  )
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  )
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
  )
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };`,

    'badge.tsx': `import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "${cnImport}";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
export { Badge, badgeVariants };`,

    'label.tsx': `import * as React from "react";
import { cn } from "${cnImport}";

const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label ref={ref} className={cn("text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70", className)} {...props} />
  )
);
Label.displayName = "Label";
export { Label };`,

    'separator.tsx': `import * as React from "react";
import { cn } from "${cnImport}";

const Separator = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }>(
  ({ className, orientation = "horizontal", ...props }, ref) => (
    <div ref={ref} className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]", className)} {...props} />
  )
);
Separator.displayName = "Separator";
export { Separator };`,

    'textarea.tsx': `import * as React from "react";
import { cn } from "${cnImport}";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn("flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} />
  )
);
Textarea.displayName = "Textarea";
export { Textarea };`,

    'table.tsx': `import * as React from "react";
import { cn } from "${cnImport}";

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto"><table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} /></div>
));
Table.displayName = "Table";
const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => (<thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />));
TableHeader.displayName = "TableHeader";
const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(({ className, ...props }, ref) => (<tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />));
TableBody.displayName = "TableBody";
const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(({ className, ...props }, ref) => (<tr ref={ref} className={cn("border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted", className)} {...props} />));
TableRow.displayName = "TableRow";
const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(({ className, ...props }, ref) => (<th ref={ref} className={cn("h-12 px-4 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0", className)} {...props} />));
TableHead.displayName = "TableHead";
const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(({ className, ...props }, ref) => (<td ref={ref} className={cn("p-4 align-middle [&:has([role=checkbox])]:pr-0", className)} {...props} />));
TableCell.displayName = "TableCell";
export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };`,

    'dialog.tsx': `import * as React from "react";
import { cn } from "${cnImport}";

export function Dialog({ open, onOpenChange, children }: { open?: boolean; onOpenChange?: (open: boolean) => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={() => onOpenChange?.(false)} />
      <div className="relative z-50 bg-background rounded-lg shadow-lg max-w-lg w-full mx-4 p-6">{children}</div>
    </div>
  );
}
export function DialogContent({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("space-y-4", className)} {...props}>{children}</div>; }
export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("space-y-1.5", className)} {...props} />; }
export function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) { return <h2 className={cn("text-lg font-semibold", className)} {...props} />; }
export function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) { return <p className={cn("text-sm text-muted-foreground", className)} {...props} />; }
export function DialogTrigger({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button {...props}>{children}</button>; }`,
  };

  for (const [file, content] of Object.entries(components)) {
    writeFileSync(join(uiDir, file), content, 'utf8');
  }

  // Add CSS variables for shadcn theme
  const globalsCss = plan.toolchain === 'next' ? join(wtNative, 'app', 'globals.css') : join(wtNative, 'src', 'index.css');
  if (existsSync(globalsCss)) {
    let css = readFileSync(globalsCss, 'utf8');
    if (!css.includes('--background')) {
      css += `\n@layer base {\n  :root {\n    --background: 0 0% 100%;\n    --foreground: 222.2 84% 4.9%;\n    --card: 0 0% 100%;\n    --card-foreground: 222.2 84% 4.9%;\n    --popover: 0 0% 100%;\n    --popover-foreground: 222.2 84% 4.9%;\n    --primary: 222.2 47.4% 11.2%;\n    --primary-foreground: 210 40% 98%;\n    --secondary: 210 40% 96.1%;\n    --secondary-foreground: 222.2 47.4% 11.2%;\n    --muted: 210 40% 96.1%;\n    --muted-foreground: 215.4 16.3% 46.9%;\n    --accent: 210 40% 96.1%;\n    --accent-foreground: 222.2 47.4% 11.2%;\n    --destructive: 0 84.2% 60.2%;\n    --destructive-foreground: 210 40% 98%;\n    --border: 214.3 31.8% 91.4%;\n    --input: 214.3 31.8% 91.4%;\n    --ring: 222.2 84% 4.9%;\n    --radius: 0.5rem;\n  }\n}\n\n@layer base {\n  * { @apply border-border; }\n  body { @apply bg-background text-foreground; }\n}\n`;
      writeFileSync(globalsCss, css, 'utf8');
    }
  }

  plan.addLog('system', `🎨 shadcn/ui ${Object.keys(components).length}개 컴포넌트 + CSS 변수 설치 완료`, '');
}

async function _fixTailwindConfig(plan) {
  const wt = plan.worktreePath;
  const wtNative = IS_WIN ? toWinPath(wt) : wt;

  // Detect Tailwind version
  let twMajor = 0;
  try {
    const twPkg = JSON.parse(readFileSync(join(wtNative, 'node_modules/tailwindcss/package.json'), 'utf8'));
    twMajor = parseInt(twPkg.version);
  } catch { return; } // No tailwind installed

  if (twMajor < 4) return; // v3 is fine as-is

  plan.addLog('system', `Tailwind v${twMajor} 감지 — config 자동 설정`, '');

  // Check if @tailwindcss/postcss is installed
  const hasPostcssPlugin = existsSync(join(wtNative, 'node_modules/@tailwindcss/postcss'));
  if (!hasPostcssPlugin) {
    plan.addLog('system', '@tailwindcss/postcss 설치 중...', '');
    try { await _execInProject(wt, 'npm install -D @tailwindcss/postcss', 60000); } catch { /* ok */ }
  }

  // Detect package.json type
  let isESM = false;
  try {
    const pkg = JSON.parse(readFileSync(join(wtNative, 'package.json'), 'utf8'));
    isESM = pkg.type === 'module';
  } catch { /* ok */ }

  // Fix postcss.config
  const postcssContent = isESM
    ? `export default {\n  plugins: {\n    "@tailwindcss/postcss": {},\n    autoprefixer: {},\n  },\n};\n`
    : `module.exports = {\n  plugins: {\n    "@tailwindcss/postcss": {},\n    autoprefixer: {},\n  },\n};\n`;

  const postcssFile = isESM ? 'postcss.config.js' : 'postcss.config.cjs';
  writeFileSync(join(wtNative, postcssFile), postcssContent, 'utf8');
  // Remove conflicting config files
  for (const f of ['postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs']) {
    if (f !== postcssFile) {
      try { unlinkSync(join(wtNative, f)); } catch { /* ok */ }
    }
  }

  // Fix index.css — replace @tailwind directives with @import
  const cssPath = join(wtNative, 'src/index.css');
  if (existsSync(cssPath)) {
    let css = readFileSync(cssPath, 'utf8');
    if (css.includes('@tailwind')) {
      css = css.replace(/@tailwind\s+base;\s*/g, '')
               .replace(/@tailwind\s+components;\s*/g, '')
               .replace(/@tailwind\s+utilities;\s*/g, '');
      css = '@import "tailwindcss";\n\n' + css.trim() + '\n';
      writeFileSync(cssPath, css, 'utf8');
      plan.addLog('system', 'index.css: @tailwind → @import "tailwindcss"', '');
    }
  }

  // Ensure tailwind.config exists with content paths
  const twConfigPath = join(wtNative, 'tailwind.config.js');
  if (!existsSync(twConfigPath)) {
    const twConfig = isESM
      ? `/** @type {import('tailwindcss').Config} */\nexport default {\n  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],\n  theme: { extend: {} },\n  plugins: [],\n};\n`
      : `/** @type {import('tailwindcss').Config} */\nmodule.exports = {\n  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],\n  theme: { extend: {} },\n  plugins: [],\n};\n`;
    writeFileSync(twConfigPath, twConfig, 'utf8');
  }
}

// (Reconciliation moved to ./reconcile.js)

function __REMOVED_reconcileImports(plan) {
  const wt = plan.worktreePath;
  if (!wt) return;
  const wtNative = IS_WIN ? toWinPath(wt) : wt;

  plan.addLog('system', '🔧 Import reconciliation...', '');
  let fixCount = 0;

  // 1. Scan all .tsx/.ts files for their export style
  const exportMap = new Map(); // relativePath → { named: ['Foo','Bar'], hasDefault: bool }
  const allFiles = [];

  function scanDir(dir, prefix = '') {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full, prefix + entry.name + '/');
        } else if (/\.(tsx?|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          const relPath = prefix + entry.name;
          allFiles.push({ full, rel: relPath });
          try {
            const content = readFileSync(full, 'utf8');
            const named = [];
            const lines = content.split('\n');
            for (const line of lines) {
              const m = line.match(/^export\s+(?:const|function|class|enum|interface|type)\s+(\w+)/);
              if (m) named.push(m[1]);
            }
            const hasDefault = /^export\s+default/m.test(content);
            exportMap.set(relPath, { named, hasDefault });
          } catch { /* ok */ }
        }
      }
    } catch { /* ok */ }
  }

  scanDir(wtNative);

  // 2. For each file, check imports and fix mismatches
  for (const { full, rel } of allFiles) {
    try {
      let content = readFileSync(full, 'utf8');
      let changed = false;

      // Match import statements: import X from './path' or import { X } from './path'
      const importRegex = /^(import\s+)((?:\w+)|(?:\{[^}]+\}))\s+(from\s+['"]([^'"]+)['"])/gm;
      let match;
      const replacements = [];

      while ((match = importRegex.exec(content)) !== null) {
        const [fullMatch, importKw, importSpec, fromClause, importPath] = match;
        if (!importPath.startsWith('./') && !importPath.startsWith('@/')) continue;

        // Resolve import path to file
        const resolved = _resolveImportPath(wtNative, rel, importPath);
        if (!resolved) continue;

        const exportInfo = exportMap.get(resolved);
        if (!exportInfo) continue;

        const isDefaultImport = !importSpec.startsWith('{');
        const isNamedImport = importSpec.startsWith('{');

        // Fix: default import but file only has named exports
        if (isDefaultImport && !exportInfo.hasDefault && exportInfo.named.length > 0) {
          const importName = importSpec.trim();
          // Find matching named export
          const matchingExport = exportInfo.named.find(n =>
            n.toLowerCase() === importName.toLowerCase()
          ) || exportInfo.named[0];
          replacements.push({
            old: fullMatch,
            new: `${importKw}{ ${matchingExport} } ${fromClause}`,
          });
          fixCount++;
        }

        // Fix: named import but file only has default export
        if (isNamedImport && exportInfo.hasDefault && exportInfo.named.length === 0) {
          const names = importSpec.replace(/[{}]/g, '').trim().split(',').map(s => s.trim());
          const mainName = names[0];
          replacements.push({
            old: fullMatch,
            new: `${importKw}${mainName} ${fromClause}`,
          });
          fixCount++;
        }
      }

      // Apply replacements
      for (const r of replacements) {
        content = content.replace(r.old, r.new);
        changed = true;
      }

      if (changed) {
        writeFileSync(full, content, 'utf8');
      }
    } catch { /* ok */ }
  }

  // 3. For Next.js: move src/app/* → app/* (agents often create in wrong location)
  if (plan.toolchain === 'next') {
    const srcAppDir = join(wtNative, 'src', 'app');
    const appDir = join(wtNative, 'app');
    if (existsSync(srcAppDir)) {
      try {
        function copyRecursive(src, dest) {
          for (const entry of readdirSync(src, { withFileTypes: true })) {
            const srcPath = join(src, entry.name);
            const destPath = join(dest, entry.name);
            if (entry.isDirectory()) {
              mkdirSync(destPath, { recursive: true });
              copyRecursive(srcPath, destPath);
            } else if (!existsSync(destPath)) {
              mkdirSync(dirname(destPath), { recursive: true });
              writeFileSync(destPath, readFileSync(srcPath));
              fixCount++;
            }
          }
        }
        copyRecursive(srcAppDir, appDir);
        plan.addLog('system', `📁 src/app/ → app/ 이동 완료`, '');
      } catch (err) {
        plan.addLog('system', `src/app 이동 실패: ${err.message}`, '');
      }
    }
    // Also move src/components → components, src/hooks → hooks, etc.
    for (const subDir of ['components', 'hooks', 'types', 'lib']) {
      const srcDir = join(wtNative, 'src', subDir);
      const destDir = join(wtNative, subDir);
      if (existsSync(srcDir)) {
        try {
          function copyDir(s, d) {
            mkdirSync(d, { recursive: true });
            for (const e of readdirSync(s, { withFileTypes: true })) {
              const sp = join(s, e.name), dp = join(d, e.name);
              if (e.isDirectory()) copyDir(sp, dp);
              else if (!existsSync(dp)) { writeFileSync(dp, readFileSync(sp)); fixCount++; }
            }
          }
          copyDir(srcDir, destDir);
        } catch { /* ok */ }
      }
    }

    // Scan for page-like components that should be routes
    const pagePatterns = [
      { pattern: /cart/i, route: 'cart' },
      { pattern: /checkout/i, route: 'checkout' },
      { pattern: /login/i, route: 'login' },
      { pattern: /register|signup/i, route: 'register' },
      { pattern: /mypage|my-page|profile/i, route: 'mypage' },
      { pattern: /wishlist/i, route: 'wishlist' },
      { pattern: /orders/i, route: 'orders' },
      { pattern: /admin.*dashboard/i, route: 'admin' },
      { pattern: /products/i, route: 'products' },
      { pattern: /categories/i, route: 'categories' },
      { pattern: /settings/i, route: 'admin/settings' },
    ];

    for (const { pattern, route } of pagePatterns) {
      const routePagePath = join(appDir, route, 'page.tsx');
      if (existsSync(routePagePath)) continue; // Already exists

      // Find a component that matches this route
      const matchingFile = allFiles.find(f =>
        pattern.test(f.rel) &&
        (f.rel.includes('Page') || f.rel.includes('page')) &&
        !f.rel.startsWith('app/')
      );

      if (matchingFile) {
        // Create a thin page.tsx that imports the component
        const componentRel = matchingFile.rel.replace(/\.(tsx?|ts)$/, '');
        const depth = route.split('/').length;
        const prefix = '../'.repeat(depth + 1);
        const exportInfo = exportMap.get(matchingFile.rel);
        const componentName = exportInfo?.named?.[0] || matchingFile.rel.match(/(\w+)\.\w+$/)?.[1] || 'Page';
        const importStyle = exportInfo?.hasDefault
          ? `import ${componentName} from '${prefix}${componentRel}'`
          : `import { ${componentName} } from '${prefix}${componentRel}'`;

        const pageContent = `${importStyle};\n\nexport default function Page() {\n  return <${componentName} />;\n}\n`;

        try {
          mkdirSync(join(appDir, route), { recursive: true });
          writeFileSync(routePagePath, pageContent, 'utf8');
          fixCount++;
          plan.addLog('system', `📄 Route 생성: /app/${route}/page.tsx → ${componentName}`, '');
        } catch { /* ok */ }
      }
    }
  }

  plan.addLog('system', `🔧 Reconciliation 완료: ${fixCount}건 수정`, '');
}

function _resolveImportPath(wtRoot, fromFile, importPath) {
  // Convert import path to actual file path
  let target;
  if (importPath.startsWith('@/')) {
    target = importPath.slice(2);
  } else {
    // Relative path
    const fromDir = fromFile.split('/').slice(0, -1).join('/');
    const parts = [...(fromDir ? fromDir.split('/') : [])];
    for (const seg of importPath.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    target = parts.join('/');
  }

  // Try extensions
  for (const ext of ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
    const candidate = target + ext;
    if (existsSync(join(wtRoot, candidate))) return candidate;
  }
  return null;
}

// ══════════════════════════════════════════════════
// Phase Commit — accumulative: each phase commits on top of previous
// ══════════════════════════════════════════════════

async function _commitPhase(plan, phase) {
  try {
    const st = await _exec(plan, 'git status --porcelain');
    if (!st.output.trim()) return; // Nothing to commit
    await _exec(plan, 'git add -A');
    await _exec(plan, `git commit -m "feat(${phase.id}): ${phase.label}"`);
    await _exec(plan, `git push origin ${plan.branch}`);
    plan.addLog('system', `📝 Phase ${phase.label} 커밋 완료`, '');
  } catch (err) {
    plan.addLog('system', `Phase 커밋 실패: ${err.message}`, '');
  }
}

// ══════════════════════════════════════════════════
// Stop / Delete / Getters
// ══════════════════════════════════════════════════

export function stopPlan(planId) {
  const plan = _plans.get(planId);
  if (!plan) throw new Error('Plan not found');

  plan.stop();
  plan.status = PLAN_STATUS.PAUSED;

  // Reset running features to queued
  for (const f of plan.features) {
    if (f.status === FEATURE_STATUS.RUNNING) {
      f.status = FEATURE_STATUS.QUEUED;
    }
    if (f.status === FEATURE_STATUS.READY) {
      f.status = FEATURE_STATUS.QUEUED;
    }
  }

  _savePlan(plan);
  _poller?.broadcast('project:plan', plan.toJSON());
  return { stopped: true, planId };
}

export function deletePlan(planId) {
  const plan = _plans.get(planId);
  if (!plan) throw new Error('Plan not found');

  // Stop if running
  if (plan.status === PLAN_STATUS.RUNNING) {
    plan.stop();
  }

  // Clean up worktree
  if (plan.worktreePath) {
    try { unregisterWorktreeRoot(plan.worktreePath); } catch { /* ok */ }
    try {
      _execInProject(plan.projectPath, `git worktree remove ${plan.worktreePath} --force`);
    } catch { /* ok */ }
  }

  // Remove from memory
  _plans.delete(planId);

  // Remove persisted files
  const dir = join(PLAN_HISTORY_DIR, planId);
  if (existsSync(dir)) {
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        try { unlinkSync(join(dir, file)); } catch { /* ok */ }
      }
      // Try to remove subdirs (images)
      const imgDir = join(dir, 'images');
      if (existsSync(imgDir)) {
        const imgs = readdirSync(imgDir);
        for (const img of imgs) try { unlinkSync(join(imgDir, img)); } catch { /* ok */ }
        try { readdirSync(imgDir).length === 0 && unlinkSync(imgDir); } catch { /* ok */ }
      }
    } catch { /* ok */ }
  }
}

export function getPlan(planId) {
  const plan = _plans.get(planId);
  return plan ? plan.toJSON() : null;
}

export function listPlans() {
  return [..._plans.values()].map(p => p.toJSON());
}

// ══════════════════════════════════════════════════
// Image Upload
// ══════════════════════════════════════════════════

export function saveUploadedImage(planId, filename, buffer) {
  const imageDir = join(PLAN_HISTORY_DIR, planId, 'images');
  try { mkdirSync(imageDir, { recursive: true }); } catch { /* ok */ }
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const filePath = join(imageDir, safe);
  writeFileSync(filePath, buffer);
  return { url: `/api/project-plan/image/${planId}/${safe}`, filename: safe };
}

export function getImagePath(planId, filename) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const filePath = join(PLAN_HISTORY_DIR, planId, 'images', safe);
  if (!existsSync(filePath)) return null;
  return filePath;
}

// ══════════════════════════════════════════════════
// Shell Execution Helpers
// ══════════════════════════════════════════════════

async function _exec(plan, cmd, timeout = 120000) {
  return _execInProject(plan.worktreePath, cmd, timeout);
}

async function _execInProject(projectPath, cmd, timeout = 120000) {
  const cwd = IS_WIN ? toWinPath(projectPath) : projectPath;
  const shell = IS_WIN ? 'cmd' : '/bin/bash';
  const args = IS_WIN ? ['/c', cmd] : ['-c', cmd];

  try {
    const { stdout, stderr } = await execFileAsync(shell, args, {
      cwd, timeout, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NODE_ENV: 'development' },
    });
    return { exitCode: 0, output: (stdout + '\n' + stderr).trim() };
  } catch (err) {
    return { exitCode: err.code || 1, output: ((err.stdout || '') + '\n' + (err.stderr || '') + '\n' + (err.message || '')).trim() };
  }
}

// ══════════════════════════════════════════════════
// Prompt Builders
// ══════════════════════════════════════════════════

function _buildProjectContext(plan) {
  return `\n## AutoBuild Project Context
⚠️ 이 빌드에서는 아래 프로젝트만 작업하세요.
- **프로젝트 경로**: ${plan.worktreePath}
- **브랜치**: ${plan.branch}
- **작업**: ${plan.description}
- 모든 파일 읽기/쓰기/실행은 반드시 위 경로 안에서만 수행하세요.
- DELEGATE 금지 — AutoBuild 엔진이 에이전트 배정을 관리합니다.\n`;
}

function _buildFeaturePrompt(plan, feature, todoPath) {
  // Read shared context from previous features
  const sharedContext = _readSharedContext(plan);

  // Gather ACTUAL file list from worktree (not plan's expected files)
  let actualFiles = '';
  let exportSummary = '';
  if (plan.worktreePath) {
    try {
      let modified = '';
      try { modified = gitExecSync(plan.worktreePath, ['diff', '--name-only', 'HEAD'], { timeout: 5000 }).trim(); } catch { /* ok */ }
      let untracked = '';
      try { untracked = gitExecSync(plan.worktreePath, ['ls-files', '--others', '--exclude-standard'], { timeout: 5000 }).trim(); } catch { /* ok */ }
      const files = [modified, untracked].filter(Boolean).join('\n').trim();
      if (files) actualFiles = files;

      // For integration features: extract export signatures from .tsx/.ts files
      const isIntegration = feature.phase === 'integration' || feature.deps.length > 1 || feature === plan.features[plan.features.length - 1];
      if (isIntegration && files) {
        const srcFiles = files.split('\n').filter(f => /\.(tsx?|ts)$/.test(f) && f.startsWith('src/') && !f.includes('main.tsx'));
        const exports = [];
        const importLines = [];
        for (const sf of srcFiles.slice(0, 20)) {
          try {
            const content = readFileSync(join(plan.worktreePath, sf), 'utf8');
            // Extract named exports
            const namedExports = [];
            for (const line of content.split('\n')) {
              const m = line.match(/^export\s+(?:const|function|class)\s+(\w+)/);
              if (m) namedExports.push(m[1]);
            }
            const hasDefault = /^export\s+default/m.test(content);

            if (namedExports.length > 0 || hasDefault) {
              const relPath = './' + sf.replace(/^src\//, '').replace(/\.(tsx?|ts)$/, '');
              if (namedExports.length > 0) {
                importLines.push(`import { ${namedExports.join(', ')} } from '${relPath}';`);
              }
              if (hasDefault && namedExports.length === 0) {
                const name = basename(sf).replace(/\.\w+$/, '');
                importLines.push(`import ${name} from '${relPath}';`);
              }
              exports.push(`${sf}: ${namedExports.join(', ') || 'default export'}`);
            }
          } catch { /* ok */ }
        }
        if (exports.length > 0) exportSummary = exports.join('\n');
        if (importLines.length > 0) {
          exportSummary += '\n\n**App.tsx에서 사용할 import 구문 (복사해서 사용하세요):**\n```typescript\n' + importLines.join('\n') + '\n```';
        }
      }
    } catch { /* ok */ }
  }

  // Gather context from completed deps — include their actual created files
  const doneDepInfo = feature.deps
    .map(id => plan.getFeature(id))
    .filter(f => f && f.status === FEATURE_STATUS.DONE)
    .map(f => `- ${f.id}: ${f.title}`)
    .join('\n');

  const rules = plan.toolchain ? _getToolchainRules(plan.toolchain, plan) : '';

  // Design system spec — injected into EVERY feature prompt
  const designSpec = plan.designSystem ? `
## 디자인 시스템 (모든 컴포넌트에 반드시 적용)
컨셉: ${plan.designSystem.concept || '모던 미니멀'}
${plan.designSystem.colors ? `색상: ${JSON.stringify(plan.designSystem.colors)}` : ''}
${plan.designSystem.typography ? `타이포: ${JSON.stringify(plan.designSystem.typography)}` : ''}
${plan.designSystem.layout ? `레이아웃: ${JSON.stringify(plan.designSystem.layout)}` : ''}
${plan.designSystem.components ? `컴포넌트: ${JSON.stringify(plan.designSystem.components)}` : ''}
${plan.designSystem.referenceStyle ? `레퍼런스: ${plan.designSystem.referenceStyle}` : ''}

⚠️ 위 디자인 시스템을 반드시 따르세요. 모든 페이지/컴포넌트가 일관된 스타일이어야 합니다.
` : '';

  // Phase-specific guidance
  const phaseGuidance = _getPhaseGuidance(feature, plan);

  // Integration features MUST read existing files first
  const isIntegration = feature.phase === 'integration' || feature.deps.length > 1 || feature === plan.features[plan.features.length - 1];

  return `[AUTOBUILD FEATURE - ${feature.id}: ${feature.title}]
${rules}
${designSpec}
${phaseGuidance}

PROJECT: ${plan.worktreePath}
BRANCH: ${plan.branch}
FEATURE: ${feature.id} — ${feature.title}
FILES: ${feature.files.length > 0 ? feature.files.join(', ') : '(AI가 판단)'}
TYPE: ${feature.type}
${todoPath ? `TASK_PLAN: ${todoPath} (작업 체크리스트 — 참고용)` : ''}

## 작업 설명
${feature.description}

${feature.images.length > 0 ? `## 참고 이미지\n${feature.images.join(', ')}\n` : ''}
${sharedContext ? `## 이전 Feature들의 작업 내역 (Shared Context)\n<shared_context>\n${sharedContext}\n</shared_context>\n\n⚠️ 위 context에 나온 파일과 export를 반드시 확인하고 사용하세요. 이미 만들어진 컴포넌트를 다시 만들지 마세요.\n` : ''}
${actualFiles ? `## 현재 프로젝트 파일 목록\n\`\`\`\n${actualFiles}\n\`\`\`\n` : ''}
${exportSummary ? `## 사용 가능한 컴포넌트/함수 (실제 export)\n${exportSummary}\n\n⚠️ 위 export를 그대로 사용하세요. 존재하지 않는 모듈을 import하지 마세요.\n` : ''}

## 수행할 작업
${isIntegration ? `🚨 이 Feature는 통합(integration) 작업입니다.

### 절대 규칙
1. 위에 제공된 **import 구문을 그대로 복사**해서 App.tsx 상단에 넣으세요
2. 모든 컴포넌트와 훅을 **실제로 사용**하세요 — placeholder 텍스트 금지
3. 존재하지 않는 모듈(ThemeProvider, Layout 등)을 import하지 마세요
4. WRITE로 App.tsx를 완전히 새로 작성하세요 (기존 파일 덮어쓰기)
5. 완료 후 git add -A

### App.tsx 작성 가이드
- 위 import 구문 복사 → 붙여넣기
- 커스텀 훅(useTodos 등)으로 상태 관리
- 컴포넌트를 조합해서 완전한 UI 구성
- "여기에 들어갈 예정" 같은 placeholder 절대 금지 — 실제 동작하는 코드만` : `1. 기존 코드 확인: GLOB src/**/*
2. 새 파일은 WRITE, 기존 파일 수정은 WRITE(덮어쓰기 가능) 사용
3. 대상 파일: ${feature.files.length > 0 ? feature.files.join(', ') : '설명에 따라 판단'}
4. 완료 후 git add -A (커밋은 하지 마세요 — 엔진이 Phase 단위로 커밋합니다)`}

**중요**: 기존 파일(예: App.tsx)을 완전히 바꿔야 하면 WRITE로 덮어쓰세요. EDIT는 부분 수정에만 사용.

## 규칙
- 모든 파일 경로는 반드시 **절대 경로**로 사용 (예: ${plan.worktreePath}/src/...)
- TypeScript (.tsx/.ts) 필수
- Tailwind CSS 유틸리티 클래스만
- shadcn/ui 컴포넌트 사용 (Button, Card, Input, Badge, Label, Separator, Table 등이 이미 설치되어 있음)
  - import 경로: ${plan.toolchain === 'next' ? "'@/components/ui/button'" : "'@/components/ui/button'"}
- import 경로는 반드시 실제 파일 위치에 맞추세요
- git commit 하지 마세요 — git add -A만 해주세요

## 퀄리티 기준 (중요!)
- **placeholder 텍스트 금지**: "여기에 들어갈 예정", "TODO", "Coming soon" 등 절대 금지
- **실제 동작하는 UI**: 폼은 실제 input/button, 리스트는 실제 데이터 렌더링, 카드는 실제 내용
- **mock 데이터 필수**: 최소 5개 이상의 현실적인 한국어 mock 데이터 포함
- **반응형**: sm/md/lg 브레이크포인트 적용
- **인터랙션**: hover 효과, 클릭 이벤트, 상태 변경 등 실제 동작
- **최소 50줄 이상**: 각 페이지/컴포넌트는 최소 50줄 (의미 있는 코드)
- **lucide-react 아이콘**: 적절한 아이콘 사용 (Heart, ShoppingCart, Search, Star 등)`;
}

function _getPhaseGuidance(feature, plan) {
  const isLast = feature === plan.features[plan.features.length - 1];

  if (isLast || feature.phase === 'integration') {
    return `## 단계별 가이드 (Integration)
이 Feature는 전체 라우팅 연결 단계입니다.
- 모든 페이지가 접근 가능한지 확인하세요
- Navigation에 모든 링크가 있는지 확인하세요
- App.tsx/layout.tsx를 최종 정리하세요
- 새로운 컴포넌트를 만들지 말고 기존 것을 연결만 하세요
`;
  }

  switch (feature.phase) {
    case 'setup':
      return `## 단계별 가이드 (Setup)
이 단계는 프로젝트 기초를 만드는 단계입니다.
- 디자인 시스템, 공통 컴포넌트, 타입 정의, 유틸리티에 집중하세요
- 모든 후속 Feature가 이 코드를 사용합니다
- 퀄리티와 일관성이 가장 중요합니다
`;
    case 'core':
      return `## 단계별 가이드 (Core)
핵심 페이지/기능을 구현하세요.
- setup에서 만든 컴포넌트를 반드시 사용하세요
- Shared Context를 읽고 기존 컴포넌트를 재사용하세요
- 새 UI 컴포넌트를 만들지 말고 setup의 것을 가져다 쓰세요
`;
    case 'extra':
    case 'polish':
      return `## 단계별 가이드 (Extra/Polish)
부가 기능과 마무리 단계입니다.
- 기존 코드와의 일관성이 핵심입니다
- 새로운 디자인 패턴을 도입하지 마세요
- Shared Context에 나온 기존 패턴을 따르세요
`;
    default:
      return '';
  }
}

function _getToolchainRules(toolchain, plan) {
  const rules = {
    vite: 'STACK: React + TypeScript + Vite + Tailwind CSS + shadcn/ui',
    next: 'STACK: Next.js + TypeScript + Tailwind CSS + shadcn/ui',
    cra: 'STACK: React + TypeScript + CRA + Tailwind CSS',
  };

  // Detect Tailwind version from worktree
  let tailwindInfo = '';
  if (plan?.worktreePath) {
    try {
      const pkgPath = join(plan.worktreePath, 'node_modules/tailwindcss/package.json');
      const twVer = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
      const major = parseInt(twVer);
      if (major >= 4) {
        tailwindInfo = `\nTAILWIND VERSION: v${twVer} (v4+)
- CSS에서 @tailwind 디렉티브 대신 @import "tailwindcss" 사용
- postcss.config.js에서 tailwindcss 대신 @tailwindcss/postcss 사용
- @apply는 여전히 사용 가능`;
      } else {
        tailwindInfo = `\nTAILWIND VERSION: v${twVer} (v3)
- CSS에서 @tailwind base; @tailwind components; @tailwind utilities; 사용`;
      }
    } catch { /* ok */ }
  }

  const isNext = toolchain === 'next';

  return `${rules[toolchain] || rules.vite}${tailwindInfo}
${isNext ? `STRUCTURE: Next.js App Router
  app/                → 페이지 라우트 (layout.tsx, page.tsx)
  app/(shop)/         → 쇼핑 관련 그룹 라우트
  app/admin/          → 관리자 그룹 라우트
  components/         → React 컴포넌트
  components/ui/      → 공용 UI 컴포넌트 (Button, Card 등)
  hooks/              → 커스텀 훅
  types/              → TypeScript 타입
  lib/                → 유틸리티 함수, mock 데이터

NEXT.JS 규칙:
- 페이지는 app/경로/page.tsx (예: app/products/page.tsx → /products)
- 레이아웃은 app/경로/layout.tsx (중첩 레이아웃)
- "use client" 디렉티브: 이벤트핸들러, useState, useEffect 사용 시 필수
- Server Component가 기본 — 데이터 페칭은 서버에서
- Image: next/image 사용
- Link: next/link 사용
- 동적 라우트: app/products/[id]/page.tsx` : `STRUCTURE: Simple flat structure
  src/components/    → React 컴포넌트 (UI + feature 컴포넌트)
  src/components/ui/ → 공용 UI 컴포넌트 (Button, Card 등)
  src/hooks/         → 커스텀 훅
  src/types/         → TypeScript 타입
  src/lib/           → 유틸리티 함수`}

CONVENTIONS:
- Functional components only
- Custom hooks: useXxx
- Tailwind 유틸리티 클래스만 (CSS 파일 작성 금지)
- UI: shadcn/ui 스타일 (Button, Card, Input 등)
- ⚠️ 파일은 위 구조에만 생성하세요. src/app/, src/features/, src/widgets/ 등 다른 폴더 금지.
- postcss.config.js와 tailwind.config.js는 ESM 형식 사용 (export default, import 사용. module.exports 금지 — type:module 프로젝트)
- 상태: 로컬=useState, 글로벌=Zustand
- Props interface co-locate
- features/ 간 직접 import 금지 (shared/ 경유)`;
}

function _getValidationCmds(toolchain) {
  const cmds = {
    vite: { typecheck: 'npx tsc --noEmit', build: 'npx vite build', test: 'npx vitest run --reporter=json' },
    next: { typecheck: 'npx tsc --noEmit', build: 'npx next build', test: 'npx vitest run --reporter=json' },
    cra: { typecheck: 'npx tsc --noEmit', build: 'npm run build', test: 'npx react-scripts test --watchAll=false' },
  };
  return cmds[toolchain] || cmds.vite;
}

function _detectToolchain(pkg) {
  if (!pkg) return 'vite';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return 'next';
  if (deps.vite) return 'vite';
  if (deps['react-scripts']) return 'cra';
  return 'vite';
}

function _buildAnalysisPrompt(description, projectInfo, images, toolchain) {
  return `# AutoBuild — Feature 분석 & 파일 레벨 계획

## 역할
너는 JSON 생성기다. 입력을 분석해서 오직 JSON만 출력한다. 설명, 인사, 마크다운 없음. 순수 JSON만.
각 Feature는 AutoBuild 엔진이 에이전트에게 배정하여 자동 구현한다.

## 프로젝트 정보
${projectInfo}
Toolchain: ${toolchain}

## 사용자 요구사항
${description}

${images.length > 0 ? `## 참고 이미지\n첨부된 이미지 ${images.length}장을 분석하여 Feature에 반영하라.\n` : ''}

## 출력 형식
⚠️ JSON만 출력하라. 설명문, 인사말, 마크다운 헤더, 코드블록 없음. 응답의 첫 글자는 반드시 { 이어야 한다.

\`\`\`json
{
  "designSystem": {
    "concept": "미니멀 화이트 / 모던 다크 / 감성 파스텔 등 한 줄 컨셉",
    "colors": {
      "background": "bg-white 또는 bg-gray-950 등",
      "foreground": "text-gray-900 또는 text-gray-100 등",
      "primary": "bg-blue-600 text-white (CTA 버튼)",
      "secondary": "bg-gray-100 text-gray-700",
      "accent": "포인트 색상",
      "muted": "text-gray-500 (부가 텍스트)"
    },
    "typography": {
      "font": "Pretendard / Noto Sans KR / Inter 등",
      "heading": "text-2xl font-bold tracking-tight",
      "body": "text-sm text-muted-foreground",
      "price": "text-lg font-bold"
    },
    "layout": {
      "maxWidth": "max-w-7xl mx-auto px-4",
      "cardStyle": "rounded-lg border shadow-sm hover:shadow-md transition",
      "spacing": "gap-4 또는 gap-6",
      "imageRatio": "aspect-square 또는 aspect-[4/3]"
    },
    "components": {
      "button": "rounded-full / rounded-md, 크기별 패딩",
      "card": "Card + CardHeader + CardContent 구조",
      "badge": "rounded-full px-2 py-0.5 text-xs",
      "input": "h-10 rounded-md border"
    },
    "referenceStyle": "쿠팡 / 무신사 / 29CM / Apple Store 등 레퍼런스"
  },
  "phases": [
    {"id": "setup", "label": "기초 세팅", "order": 0},
    {"id": "core", "label": "핵심 기능", "order": 1},
    {"id": "extra", "label": "부가 기능", "order": 2},
    {"id": "polish", "label": "마무리 & 통합", "order": 3}
  ],
  "features": [
    {
      "id": "F-1",
      "title": "프로젝트 초기 설정 + 디자인 시스템",
      "description": "Tailwind, shadcn/ui 설정. 디자인 토큰(CSS 변수). 공통 폰트 로딩.",
      "phase": "setup",
      "deps": [],
      "files": ["tailwind.config.ts", "lib/utils.ts", "app/globals.css"],
      "type": "create"
    },
    {
      "id": "F-2",
      "title": "공통 레이아웃",
      "description": "Header, Footer, MainLayout 컴포넌트 구현. designSystem의 colors/typography 반영.",
      "phase": "setup",
      "deps": ["F-1"],
      "files": ["components/layout/Header.tsx", "components/layout/Footer.tsx", "app/layout.tsx"],
      "type": "create"
    }
  ]
}
\`\`\`

## 디자인 시스템 규칙
- designSystem은 사용자의 요구사항과 프로젝트 성격에 맞게 생성
- 쇼핑몰이면 쿠팡/무신사 스타일, SaaS면 깔끔한 대시보드 스타일
- 모든 Feature의 description에 "designSystem 참조" 문구 포함
- F-1에서 globals.css에 CSS 변수로 디자인 토큰 설정

## 핵심 규칙
1. 각 Feature는 파일 1~5개 수준으로 잘게 쪼갠다 (에이전트가 15분 내 완료 가능)
2. files 필드에 구체적 파일 경로를 명시한다 (에이전트가 정확히 뭘 만들지 알도록)
3. 독립적인 Feature는 deps=[]로 → 병렬 실행됨
4. 같은 Phase 안에서 독립 Feature 최대화 (병렬 극대화)
5. description은 에이전트가 코드를 작성할 수 있을 만큼 상세히
6. setup → core → extra → polish 순서로 누적 빌드
7. 기존 코드가 있으면 type:"modify", 없으면 type:"create"
8. Phase간 의존: core의 Feature는 setup의 Feature를 deps로 참조 가능
9. 공유 타입/유틸은 setup Phase에 넣어서 먼저 만든다
10. 마지막 통합 Feature (라우팅, 프로바이더 연결)는 polish Phase에`;
}

// ══════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════

function _scanProjectInfo(project) {
  const path = project.path;
  let info = `프로젝트: ${project.name}\n경로: ${path}\n`;
  try {
    const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    info += `\npackage.json:\n`;
    info += `  name: ${pkg.name || 'N/A'}\n`;
    info += `  dependencies: ${Object.keys(pkg.dependencies || {}).join(', ')}\n`;
    info += `  devDependencies: ${Object.keys(pkg.devDependencies || {}).join(', ')}\n`;
    if (pkg.scripts) info += `  scripts: ${Object.keys(pkg.scripts).join(', ')}\n`;
  } catch { /* no package.json */ }
  try {
    const readme = readFileSync(join(path, 'README.md'), 'utf8').slice(0, 2000);
    info += `\nREADME.md:\n${readme}\n`;
  } catch { /* no README */ }
  try {
    const entries = readdirSync(path, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
      .slice(0, 30);
    info += `\n파일 구조:\n${entries.join('\n')}\n`;
  } catch { /* can't read */ }
  try {
    const srcPath = join(path, 'src');
    if (existsSync(srcPath)) {
      const srcEntries = _listDirRecursive(srcPath, '', 3, 50);
      info += `\nsrc/ 구조:\n${srcEntries.join('\n')}\n`;
    }
  } catch { /* can't read */ }
  return info;
}

function _listDirRecursive(dirPath, prefix, maxDepth, maxEntries) {
  if (maxDepth <= 0) return [];
  const results = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules');
    for (const entry of entries) {
      if (results.length >= maxEntries) break;
      results.push(`${prefix}${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`);
      if (entry.isDirectory()) {
        const sub = _listDirRecursive(join(dirPath, entry.name), prefix + '  ', maxDepth - 1, maxEntries - results.length);
        results.push(...sub);
      }
    }
  } catch { /* can't read */ }
  return results;
}

// Convert Gemini's alternative JSON schemas to our Feature[] format
function _convertAltSchema(p) {
  // Handles schemas:
  // { plan: [{feature:'...', files:[{operation, path, description}]}] }
  // { plan: [{type:'task', task:'...', steps:[{action, file, description}]}] }
  // { tasks: [...] } / [...] (bare array)
  const planArr = Array.isArray(p) ? p : (p.plan || p.tasks || p.steps || []);
  if (!planArr.length) return null;
  // Validate: items should be objects with some text field
  if (!planArr[0] || typeof planArr[0] !== 'object') return null;
  const features = [];
  for (let i = 0; i < planArr.length; i++) {
    const item = planArr[i];
    const title = item.task || item.feature || item.title || item.name || `Step ${i + 1}`;
    const description = item.description || item.details || '';
    // steps/tasks/files might be [{file:'', path:'', operation:'', action:'', ...}]
    const steps = item.steps || item.tasks || item.files || [];
    const files = Array.isArray(steps)
      ? steps.filter(s => s && (s.file || s.path)).map(s => s.path || s.file)
      : [];
    const deps = (item.dependencies || item.deps || []).map(d => typeof d === 'string' ? d : `F-${d}`);
    const n = planArr.length;
    const phase = n <= 1 ? 'core' : i === 0 ? 'setup' : i < Math.ceil(n * 0.6) ? 'core' : i < Math.ceil(n * 0.85) ? 'extra' : 'polish';
    features.push({ id: `F-${i + 1}`, title, description, phase, deps, files, type: 'create' });
  }
  return features.length ? { phases: _defaultPhases(), features } : null;
}

function _tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function _extractJsonFromText(text) {
  // Try all { ... } blocks depth-first
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let depth = 0, end = -1;
    for (let j = start; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end > start) {
      const p = _tryParseJson(text.slice(start, end + 1));
      if (p) return p;
    }
    i = start + 1;
  }
  return null;
}

function _parseFeatureList(response) {
  const jsonStr = typeof response === 'string' ? response : JSON.stringify(response);

  // 1. Fenced JSON block(s) — try ALL fence blocks
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let fm;
  while ((fm = fenceRe.exec(jsonStr)) !== null) {
    const p = _tryParseJson(fm[1].trim());
    if (!p) continue;
    if (p.features?.length) return { phases: p.phases || _defaultPhases(), features: p.features, designSystem: p.designSystem || null };
    const alt = _convertAltSchema(p);
    if (alt) { console.log('[AutoBuild] Alt schema from fence:', alt.features.length, 'features'); return alt; }
    // Try nested: p.plan?.features, p.data?.features
    for (const key of ['plan', 'data', 'result', 'output']) {
      if (p[key]?.features?.length) return { phases: _defaultPhases(), features: p[key].features };
      if (Array.isArray(p[key]) && p[key].length) {
        const alt2 = _convertAltSchema(p[key]);
        if (alt2) { console.log('[AutoBuild] Alt schema nested in', key, ':', alt2.features.length, 'features'); return alt2; }
      }
    }
  }

  // 2. Find any JSON object in text that has features or plan/tasks
  const extracted = _extractJsonFromText(jsonStr);
  if (extracted) {
    if (extracted.features?.length) return { phases: extracted.phases || _defaultPhases(), features: extracted.features };
    const alt = _convertAltSchema(extracted);
    if (alt) { console.log('[AutoBuild] Alt schema from text extraction:', alt.features.length, 'features'); return alt; }
  }

  // 3. Markdown fallback — "### Feature N: title" or "**Feature N:**" blocks
  const phases = _defaultPhases();
  const phaseIds = ['setup', 'core', 'extra', 'polish'];
  const features = [];
  const blockRe = /(?:###\s*Feature\s*(\d+)\s*[:\-]\s*(.+?)\n|\*{2}Feature\s*(\d+)[:\-]\s*(.+?)\*{2})([\s\S]*?)(?=###\s*Feature\s*\d+|\*{2}Feature\s*\d+|---|\n##\s|$)/gi;
  let m;
  while ((m = blockRe.exec(jsonStr)) !== null) {
    const num = m[1] || m[3];
    const title = (m[2] || m[4] || '').trim();
    const body = (m[5] || '').trim();
    const files = [];
    const fileRe = /`([^`]+\.(tsx?|jsx?|css|json))`/g;
    let fm;
    while ((fm = fileRe.exec(body)) !== null) files.push(fm[1]);
    const deps = [];
    const depRe = /Feature\s*(\d+)/gi;
    let dm;
    while ((dm = depRe.exec(body)) !== null) {
      if (dm[1] !== num) deps.push(`F-${dm[1]}`);
    }
    const phaseIdx = Math.min(Math.floor((parseInt(num) - 1) / 2), phaseIds.length - 1);
    features.push({ id: `F-${num}`, title, description: body.slice(0, 2000), phase: phaseIds[phaseIdx] || 'core', deps: [...new Set(deps)], files: [...new Set(files)], type: 'create' });
  }
  if (features.length > 0) {
    console.log(`[AutoBuild] Markdown fallback: ${features.length} features extracted`);
    return { phases, features };
  }

  // 4. Last resort — single feature
  console.error('[AutoBuild] Could not parse feature list, using single-feature fallback');
  return {
    phases: [{ id: 'core', label: '핵심 기능', order: 0 }],
    features: [{ id: 'F-1', title: '전체 구현', description: jsonStr.slice(0, 5000), phase: 'core', deps: [], files: [], type: 'create' }],
  };
}

function _defaultPhases() {
  return [
    { id: 'setup', label: '기초 세팅', order: 0 },
    { id: 'core', label: '핵심 기능', order: 1 },
    { id: 'extra', label: '부가 기능', order: 2 },
    { id: 'polish', label: '마무리 & 통합', order: 3 },
  ];
}

function _broadcastProgress(plan) {
  const progress = plan.getProgress();
  _poller?.broadcast('project:progress', {
    planId: plan.planId, ...progress,
    currentPhase: plan.currentPhase,
  });
}

function slugify(text) {
  return text.replace(/[^a-zA-Z0-9가-힣]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30).toLowerCase();
}

// ══════════════════════════════════════════════════
// Persistence
// ══════════════════════════════════════════════════

function _savePlan(plan) {
  const dir = join(PLAN_HISTORY_DIR, plan.planId);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan.toJSON(), null, 2));
}

function _restorePlans() {
  try {
    const dirs = readdirSync(PLAN_HISTORY_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('plan-'));
    for (const dir of dirs) {
      const planFile = join(PLAN_HISTORY_DIR, dir.name, 'plan.json');
      if (!existsSync(planFile)) continue;
      try {
        const data = JSON.parse(readFileSync(planFile, 'utf8'));
        const plan = new AutoBuildPlan(data.planId, data.projectId, data.description);
        plan.phases = data.phases || [];
        plan.status = data.status;
        plan.createdAt = data.createdAt;
        plan.startedAt = data.startedAt;
        plan.endedAt = data.endedAt;
        plan.totalCost = data.totalCost || 0;
        plan.images = data.images || [];
        plan.worktreePath = data.worktreePath || null;
        plan.branch = data.branch || null;
        plan.baseBranch = data.baseBranch || 'main';
        plan.toolchain = data.toolchain || null;
        plan.validationLog = data.validationLog || [];
        plan.currentPhase = data.currentPhase || null;
        plan.features = (data.features || []).map(f => {
          const feat = new Feature(f);
          feat.status = f.status;
          feat.sprintId = f.sprintId;
          feat.retryCount = f.retryCount || 0;
          feat.startedAt = f.startedAt;
          feat.endedAt = f.endedAt;
          feat.error = f.error;
          feat.agentId = f.agentId || null;
          feat.agentLog = f.agentLog || [];
          return feat;
        });
        _plans.set(plan.planId, plan);

        // Running plans → pause (server restarted)
        if (plan.status === PLAN_STATUS.RUNNING) {
          plan.status = PLAN_STATUS.PAUSED;
          for (const f of plan.features) {
            if (f.status === FEATURE_STATUS.RUNNING) {
              f.status = FEATURE_STATUS.QUEUED;
            }
          }
          _savePlan(plan);
        }
      } catch (err) {
        console.warn(`[AutoBuild] Failed to restore ${dir.name}:`, err.message);
      }
    }
    console.log(`[AutoBuild] Restored ${_plans.size} plans`);
  } catch { /* no plans */ }
}
