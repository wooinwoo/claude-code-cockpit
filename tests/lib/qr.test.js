import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateQRSvg } from '../../lib/qr.js';

describe('generateQRSvg', () => {

  describe('basic SVG output', () => {
    it('returns a valid SVG string for simple text', () => {
      const svg = generateQRSvg('Hello');
      assert.ok(typeof svg === 'string');
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.endsWith('</svg>'));
    });

    it('contains required SVG namespace', () => {
      const svg = generateQRSvg('test');
      assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
    });

    it('contains viewBox attribute', () => {
      const svg = generateQRSvg('test');
      assert.match(svg, /viewBox="0 0 \d+ \d+"/);
    });

    it('contains width and height attributes', () => {
      const svg = generateQRSvg('test');
      assert.match(svg, /width="\d+"/);
      assert.match(svg, /height="\d+"/);
    });

    it('contains a white background rect', () => {
      const svg = generateQRSvg('test');
      assert.ok(svg.includes('fill="#fff"'));
    });

    it('contains a group with black fill for modules', () => {
      const svg = generateQRSvg('test');
      assert.ok(svg.includes('<g fill="#000">'));
    });

    it('contains rect elements for QR modules', () => {
      const svg = generateQRSvg('test');
      assert.match(svg, /<rect x="\d+" y="\d+" width="\d+" height="\d+"\/>/);
    });
  });

  describe('different text inputs', () => {
    it('handles a short string (1 char)', () => {
      const svg = generateQRSvg('A');
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('<rect'));
    });

    it('handles a medium string', () => {
      const svg = generateQRSvg('Hello, World! This is a QR code test.');
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('<rect'));
    });

    it('handles a URL', () => {
      const svg = generateQRSvg('https://example.com/path?query=value&foo=bar#section');
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('<rect'));
    });

    it('handles numeric-only text', () => {
      const svg = generateQRSvg('1234567890');
      assert.ok(svg.startsWith('<svg'));
    });

    it('handles special characters', () => {
      const svg = generateQRSvg('!@#$%^&*()_+-=[]{}|;:,.<>?');
      assert.ok(svg.startsWith('<svg'));
    });

    it('handles unicode/UTF-8 text', () => {
      const svg = generateQRSvg('Hello World');
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('<rect'));
    });
  });

  describe('deterministic output', () => {
    it('produces identical SVG for the same input', () => {
      const svg1 = generateQRSvg('deterministic');
      const svg2 = generateQRSvg('deterministic');
      assert.strictEqual(svg1, svg2);
    });

    it('produces different SVG for different inputs', () => {
      const svg1 = generateQRSvg('hello');
      const svg2 = generateQRSvg('world');
      assert.notStrictEqual(svg1, svg2);
    });
  });

  describe('options: scale', () => {
    it('uses default scale of 6', () => {
      const svg = generateQRSvg('test');
      // Version 1: size = 21, default margin = 4 => total = (21+8)*6 = 174
      assert.ok(svg.includes('width="174"'));
      assert.ok(svg.includes('height="174"'));
    });

    it('respects custom scale', () => {
      const svg = generateQRSvg('test', { scale: 10 });
      // (21+8)*10 = 290
      assert.ok(svg.includes('width="290"'));
      assert.ok(svg.includes('height="290"'));
    });

    it('rect dimensions match the scale value', () => {
      const scale = 8;
      const svg = generateQRSvg('test', { scale });
      assert.ok(svg.includes(`width="${scale}" height="${scale}"`));
    });
  });

  describe('options: margin', () => {
    it('uses default margin of 4', () => {
      const svg = generateQRSvg('test');
      // size=21, margin=4, scale=6 => total=(21+8)*6=174
      assert.ok(svg.includes('174'));
    });

    it('respects custom margin', () => {
      const svg = generateQRSvg('test', { margin: 0 });
      // size=21, margin=0, scale=6 => total=21*6=126
      assert.ok(svg.includes('width="126"'));
    });

    it('larger margin increases total dimensions', () => {
      const svgSmall = generateQRSvg('test', { margin: 1 });
      const svgLarge = generateQRSvg('test', { margin: 10 });
      const widthSmall = parseInt(svgSmall.match(/width="(\d+)"/)[1]);
      const widthLarge = parseInt(svgLarge.match(/width="(\d+)"/)[1]);
      assert.ok(widthLarge > widthSmall, 'larger margin should produce larger SVG');
    });
  });

  describe('options: combined scale and margin', () => {
    it('computes total correctly with both options', () => {
      const scale = 4;
      const margin = 2;
      const svg = generateQRSvg('test', { scale, margin });
      // Version 1: size=21, total=(21+2*2)*4=100
      assert.ok(svg.includes('width="100"'));
      assert.ok(svg.includes('height="100"'));
    });
  });

  describe('QR version scaling', () => {
    it('uses version 1 for short text (size 21)', () => {
      // "A" = 1 byte, capacity[0]=17, fits in version 1
      const svg = generateQRSvg('A', { scale: 1, margin: 0 });
      // Version 1 size = 17 + 1*4 = 21
      assert.ok(svg.includes('width="21"'));
    });

    it('scales up version for longer text', () => {
      // 18 bytes needs version 2 (capacity[0]=17, capacity[1]=32)
      const text = 'ABCDEFGHIJKLMNOPQR'; // 18 chars
      const svg = generateQRSvg(text, { scale: 1, margin: 0 });
      // Version 2 size = 17 + 2*4 = 25
      assert.ok(svg.includes('width="25"'));
    });

    it('handles text requiring version 3+', () => {
      // 33 bytes needs version 3 (capacity[1]=32, capacity[2]=53)
      const text = 'A'.repeat(33);
      const svg = generateQRSvg(text, { scale: 1, margin: 0 });
      // Version 3 size = 17 + 3*4 = 29
      assert.ok(svg.includes('width="29"'));
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      const svg = generateQRSvg('');
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.endsWith('</svg>'));
    });

    it('handles text at max capacity of version 1 (17 bytes)', () => {
      const text = 'A'.repeat(17);
      const svg = generateQRSvg(text, { scale: 1, margin: 0 });
      assert.ok(svg.includes('width="21"'));
    });

    it('handles text just over version 1 capacity (18 bytes)', () => {
      const text = 'A'.repeat(18);
      const svg = generateQRSvg(text, { scale: 1, margin: 0 });
      // Should bump to version 2 => size 25
      assert.ok(svg.includes('width="25"'));
    });

    it('handles text near max version 10 capacity (271 bytes)', () => {
      const text = 'B'.repeat(271);
      const svg = generateQRSvg(text, { scale: 1, margin: 0 });
      // Version 10 size = 17 + 10*4 = 57
      assert.ok(svg.includes('width="57"'));
    });

    it('handles single space character', () => {
      const svg = generateQRSvg(' ');
      assert.ok(svg.startsWith('<svg'));
    });

    it('handles newlines and tabs', () => {
      const svg = generateQRSvg('line1\nline2\ttab');
      assert.ok(svg.startsWith('<svg'));
    });

    it('with no options object defaults work', () => {
      const svg = generateQRSvg('test');
      // Should not throw, and should produce valid SVG
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('width="174"'));
    });
  });

  describe('SVG structure', () => {
    it('has exactly one root svg element', () => {
      const svg = generateQRSvg('test');
      const svgOpens = (svg.match(/<svg/g) || []).length;
      const svgCloses = (svg.match(/<\/svg>/g) || []).length;
      assert.strictEqual(svgOpens, 1);
      assert.strictEqual(svgCloses, 1);
    });

    it('has a background rect as first child', () => {
      const svg = generateQRSvg('test');
      // After the opening <svg...>, the first element should be a rect with fill="#fff"
      const afterSvgTag = svg.split('>').slice(1).join('>');
      assert.ok(afterSvgTag.startsWith('<rect'));
    });

    it('wraps module rects in a g element', () => {
      const svg = generateQRSvg('test');
      assert.ok(svg.includes('<g fill="#000">'));
      assert.ok(svg.includes('</g>'));
    });

    it('all module rects have non-negative coordinates', () => {
      const svg = generateQRSvg('test');
      const rects = svg.match(/<rect x="(\d+)" y="(\d+)"/g) || [];
      assert.ok(rects.length > 0, 'should have module rects');
      for (const rect of rects) {
        const [, x, y] = rect.match(/x="(\d+)" y="(\d+)"/);
        assert.ok(parseInt(x) >= 0, `x=${x} should be >= 0`);
        assert.ok(parseInt(y) >= 0, `y=${y} should be >= 0`);
      }
    });

    it('viewBox matches width and height', () => {
      const svg = generateQRSvg('test');
      const [, vbW, vbH] = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
      const [, w] = svg.match(/width="(\d+)"/);
      const [, h] = svg.match(/height="(\d+)"/);
      assert.strictEqual(vbW, w);
      assert.strictEqual(vbH, h);
    });
  });
});
