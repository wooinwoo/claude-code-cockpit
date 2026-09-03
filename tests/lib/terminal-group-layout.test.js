import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTerminalGroupLayout,
  terminalGroupLayoutOptions,
  terminalGroupRects,
} from '../../js/terminal-group-layout.js';

const WIDTH = 950;
const HEIGHT = 657;

test('terminal group presets tile the usable canvas without overlap', () => {
  for (const count of [2, 3, 4]) {
    for (const [layout] of terminalGroupLayoutOptions(count)) {
      const rects = terminalGroupRects(count, layout, WIDTH, HEIGHT);
      assert.equal(rects.length, count, `${count}/${layout} returns every terminal`);
      rects.forEach(rect => {
        assert.ok(rect.w > 0 && rect.h > 0, `${count}/${layout} has positive cells`);
        assert.ok(rect.x >= 0 && rect.y >= 0, `${count}/${layout} starts inside the canvas`);
        assert.ok(rect.x + rect.w <= WIDTH + 0.001, `${count}/${layout} fits horizontally`);
        assert.ok(rect.y + rect.h <= HEIGHT + 0.001, `${count}/${layout} fits vertically`);
      });
      for (let first = 0; first < rects.length; first++) {
        for (let second = first + 1; second < rects.length; second++) {
          const a = rects[first];
          const b = rects[second];
          const overlaps = a.x < b.x + b.w && a.x + a.w > b.x
            && a.y < b.y + b.h && a.y + a.h > b.y;
          assert.equal(overlaps, false, `${count}/${layout} cells do not overlap`);
        }
      }
    }
  }
});

test('legacy pair directions migrate and three-terminal main layouts prioritize the first terminal', () => {
  assert.equal(normalizeTerminalGroupLayout('h', 2), 'cols');
  assert.equal(normalizeTerminalGroupLayout('v', 2), 'rows');
  assert.equal(normalizeTerminalGroupLayout('grid', 3), 'main-left');
  for (const layout of ['main-left', 'main-right', 'main-top', 'main-bottom']) {
    const [main, ...secondary] = terminalGroupRects(3, layout, WIDTH, HEIGHT);
    assert.ok(secondary.every(rect => main.w * main.h > rect.w * rect.h), `${layout} keeps terminal one largest`);
  }
});
