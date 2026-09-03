import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

process.env.COCKPIT_OPENCODE_DB = join(tmpdir(), `cockpit-opencode-test-${process.pid}.db`);

const { detectOpencodeState, detectSessionState } = await import('../../lib/claude-data.js');

const PROJECT = { id: 'proj-1', path: '/home/user/work/project-a' };

function makeDb(dir) {
  process.env.COCKPIT_OPENCODE_DB = join(dir || tmpdir(), `oc-test-${process.pid}-${Date.now()}.db`);
  const db = new DatabaseSync(process.env.COCKPIT_OPENCODE_DB);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  return db;
}

function seedSession(db, { updatedAt, archived = null, model = '{"id":"glm-5.3","providerID":"zai"}' }) {
  db.prepare('INSERT INTO session (id, directory, model, time_updated, time_archived) VALUES (?, ?, ?, ?, ?)')
    .run('ses_test_1', PROJECT.path, model, updatedAt, archived);
  return 'ses_test_1';
}

function seedLastMessage(db, sessionId, role, at) {
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
    .run('msg_1', sessionId, at, JSON.stringify({ role }));
}

describe('detectOpencodeState', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ } });

  it('returns null when no opencode db exists at the override path', () => {
    process.env.COCKPIT_OPENCODE_DB = join(dir, 'missing.db');
    assert.equal(detectOpencodeState(PROJECT), null);
  });

  it('reports busy when the session updated within 15s', () => {
    const db = makeDb(dir);
    const sid = seedSession(db, { updatedAt: Date.now() - 3000 });
    seedLastMessage(db, sid, 'assistant', Date.now() - 3000);
    db.close();
    const state = detectOpencodeState(PROJECT);
    assert.equal(state.state, 'busy');
    assert.equal(state.sessionId, 'ses_test_1');
    assert.equal(state.model, 'glm-5.3');
  });

  it('reports waiting when last message is assistant within 5min', () => {
    const db = makeDb(dir);
    const sid = seedSession(db, { updatedAt: Date.now() - 60_000 });
    seedLastMessage(db, sid, 'assistant', Date.now() - 60_000);
    db.close();
    assert.equal(detectOpencodeState(PROJECT).state, 'waiting');
  });

  it('reports idle when last message is user within 5min', () => {
    const db = makeDb(dir);
    const sid = seedSession(db, { updatedAt: Date.now() - 60_000 });
    seedLastMessage(db, sid, 'user', Date.now() - 60_000);
    db.close();
    assert.equal(detectOpencodeState(PROJECT).state, 'idle');
  });

  it('returns null for sessions older than 5min so Claude detection stays authoritative', () => {
    const db = makeDb(dir);
    seedSession(db, { updatedAt: Date.now() - 600_000 });
    db.close();
    assert.equal(detectOpencodeState(PROJECT), null);
  });

  it('ignores archived sessions', () => {
    const db = makeDb(dir);
    seedSession(db, { updatedAt: Date.now(), archived: Date.now() });
    db.close();
    assert.equal(detectOpencodeState(PROJECT), null);
  });
});

describe('detectSessionState opencode merge', () => {
  it('prefers the more active detector result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-merge-'));
    const db = makeDb(dir);
    const sid = seedSession(db, { updatedAt: Date.now() - 1000 });
    seedLastMessage(db, sid, 'assistant', Date.now() - 1000);
    db.close();
    // Claude jsonl이 없는 프로젝트 경로 — 기존엔 no_data였지만 opencode가 busy를 제공
    const state = detectSessionState(PROJECT);
    assert.equal(state.state, 'busy');
    assert.equal(state.model, 'glm-5.3');
  });
});

describe('getProjectSessions opencode merge', () => {
  it('lists opencode sessions with oc: prefix when no Claude jsonl exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-list-'));
    const db = makeDb(dir);
    db.prepare('INSERT INTO session (id, directory, title, model, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ses_list_1', PROJECT.path, '리팩터링 작업', '{"id":"glm-5.3"}', Date.now() - 1000, null);
    db.prepare('INSERT INTO session (id, directory, title, model, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ses_list_2', PROJECT.path, '이전 작업', '{"id":"glm-5.3"}', Date.now() - 60_000, null);
    db.close();
    const { getProjectSessions } = await import('../../lib/claude-data.js?list=' + Date.now());
    const sessions = getProjectSessions(PROJECT);
    assert.equal(sessions.length, 2);
    assert.ok(sessions[0].sessionId.startsWith('oc:ses_list_'));
    assert.equal(sessions[0].source, 'opencode');
    assert.equal(sessions[0].title, '리팩터링 작업');
    // 최근 세션이 먼저 오도록 정렬
    assert.ok(new Date(sessions[0].lastModified) >= new Date(sessions[1].lastModified));
  });
});
