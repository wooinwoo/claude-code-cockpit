import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

export const MAX_PROJECTS = 3;
export const PORT = Number.parseInt(process.env.PRAETORIUM_PORT, 10) || 3847;
export const PROJECTS_ROOT = resolve(process.env.PRAETORIUM_PROJECTS_ROOT || (process.platform === 'win32' ? 'C:\\projects' : join(homedir(), 'projects')));

const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), '.local', 'share');
export const DATA_DIR = join(localAppData, 'PraetoriumData');
const projectsFile = join(DATA_DIR, 'projects.json');

mkdirSync(DATA_DIR, { recursive: true });

function slug(value, fallback = `project-${Date.now().toString(36)}`) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || fallback;
}

function validDirectory(path) {
  try { return isAbsolute(path) && statSync(path).isDirectory(); }
  catch { return false; }
}

function cleanProject(project) {
  if (!project?.path || !validDirectory(resolve(project.path))) return null;
  const path = resolve(project.path);
  return {
    id: slug(project.id || project.name || basename(path)),
    name: String(project.name || basename(path)).trim().slice(0, 80),
    path,
  };
}

function load() {
  const candidates = [projectsFile];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      const projects = (parsed.projects || parsed || []).map(cleanProject).filter(Boolean).slice(0, MAX_PROJECTS);
      if (projects.length || candidate === projectsFile) return { projects };
    } catch { /* try the next migration source */ }
  }
  return { projects: [] };
}

const state = load();

if (!state.projects.length && validDirectory(PROJECTS_ROOT)) {
  for (const entry of readdirSync(PROJECTS_ROOT, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (state.projects.length >= MAX_PROJECTS) break;
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = resolve(PROJECTS_ROOT, entry.name);
    if (!existsSync(join(path, '.git'))) continue;
    const project = cleanProject({ id: slug(entry.name, `project-${state.projects.length + 1}`), name: entry.name, path });
    if (project) state.projects.push(project);
  }
}

function save() {
  const temp = `${projectsFile}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(temp, projectsFile);
}

if (!existsSync(projectsFile) && state.projects.length) save();

export function getProjects() {
  return state.projects.map(project => ({ ...project }));
}

export function addProject(input) {
  if (state.projects.length >= MAX_PROJECTS) throw new Error(`Project Director는 최대 ${MAX_PROJECTS}개입니다.`);
  if (!input?.name || !input?.path) throw new Error('name and path required');
  const project = cleanProject({ ...input, id: input.id || slug(input.name, `project-${state.projects.length + 1}`) });
  if (!project) throw new Error('존재하는 프로젝트 절대 경로를 입력하세요.');
  const pathKey = project.path.toLowerCase();
  if (state.projects.some(item => item.path.toLowerCase() === pathKey)) throw new Error('이미 배정된 프로젝트입니다.');
  const used = new Set(state.projects.map(item => item.id));
  let id = project.id;
  for (let suffix = 2; used.has(id); suffix++) id = `${project.id}-${suffix}`;
  const created = { ...project, id };
  state.projects.push(created);
  save();
  return { ...created };
}

export function deleteProject(id) {
  const index = state.projects.findIndex(project => project.id === id);
  if (index < 0) return false;
  state.projects.splice(index, 1);
  save();
  return true;
}

export const _test = { slug, cleanProject, validDirectory };
