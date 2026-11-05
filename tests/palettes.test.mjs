import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteColors } from '../docs/palettes.mjs';
import { createFinish, DEFAULT_EFFECTS } from '../docs/image-effects.mjs';

test('each fixed style has exactly 8 or 16 distinct stable colors', () => {
  for (const style of ['minimal', 'nature', 'cinematic', 'mono']) {
    for (const count of ['8', '16']) {
      const palette = paletteColors(style, count);
      assert.equal(palette.length, Number(count));
      assert.equal(new Set(palette.map((color) => color.join(','))).size, Number(count));
      assert.equal(paletteColors(style, count), palette);
      if (style === 'mono') assert(palette.every(([r, g, b]) => r === g && g === b));
    }
  }
});
test('fixed mapping is independent of pixel order and only uses palette members', () => {
  const pixels = [[21, 99, 151, 255], [188, 196, 100, 255], [255, 255, 254, 255], [8, 19, 22, 200]];
  for (const count of ['8', '16']) {
    const image = { data: new Uint8ClampedArray(pixels.flat()) };
    const reversed = { data: new Uint8ClampedArray([...pixels].reverse().flat()) };
    const finish = createFinish(paletteColors('minimal', count), DEFAULT_EFFECTS);
    finish(image);
    finish(reversed);
    const mapped = Array.from({ length: pixels.length }, (_, i) => [...image.data.slice(i * 4, i * 4 + 4)]);
    const mappedReverse = Array.from({ length: pixels.length }, (_, i) => [...reversed.data.slice(i * 4, i * 4 + 4)]).reverse();
    assert.deepEqual(mapped, mappedReverse);
    const palette = new Set(paletteColors('minimal', count).map((color) => color.join(',')));
    assert(mapped.every((color, index) => palette.has(color.slice(0, 3).join(',')) && color[3] === pixels[index][3]));
  }
});
test('free palette preserves the existing graded image unchanged', () => {
  const image = { data: new Uint8ClampedArray([14, 65, 99, 255]) };
  assert.equal(paletteColors('minimal', 'original'), null);
  createFinish(null, DEFAULT_EFFECTS)(image);
  assert.deepEqual([...image.data], [14, 65, 99, 255]);
});
