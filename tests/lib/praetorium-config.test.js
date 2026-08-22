import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PROJECTS, _test } from '../../lib/praetorium-config.js';

describe('Praetorium project configuration', () => {
  it('caps the product at three project Directors', () => {
    assert.equal(MAX_PROJECTS, 3);
  });

  it('creates CLI-safe project identifiers', () => {
    assert.equal(_test.slug('Career App'), 'career-app');
    assert.equal(_test.slug('학교', 'project-1'), 'project-1');
  });

  it('rejects missing directories from project assignment', () => {
    assert.equal(_test.cleanProject({ name: 'missing', path: 'Z:\\not-real\\praetorium' }), null);
  });
});
