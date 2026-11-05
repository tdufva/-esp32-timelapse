import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EFFECTS, adjustTone, blendFrames, createFinish, exposureGain, meanLuma, normalizeColors, renderSize, sourceCrop } from '../docs/image-effects.mjs';

const options = (values) => ({ ...DEFAULT_EFFECTS, ...values });
const patch = (w, h, color) => ({ width: w, data: new Uint8ClampedArray(Array.from({ length: w * h }, () => color).flat()) });

test('custom palettes accept two to sixteen valid hex colors only', () => {
  assert.deepEqual(normalizeColors(['#AB12FF', '#330011']), ['#ab12ff', '#330011']);
  for (const value of [null, '#aabbcc', ['#aabbcc'], ['#ab2', '#778899'], Array(17).fill('#aabbcc')]) assert.equal(normalizeColors(value), null);
});

test('tone controls preserve the default and change lightness, contrast, saturation and temperature independently', () => {
  const original = [115, 75, 135, 210];
  const image = patch(1, 1, original);
  adjustTone(image, DEFAULT_EFFECTS);
  assert.deepEqual([...image.data], original);
  adjustTone(image, options({ brightness: 10 }));
  assert.deepEqual([...image.data], [131, 91, 151, 210]);
  adjustTone(image, options({ contrast: 25 }));
  assert(image.data[1] < 91 && image.data[2] > 151);
  adjustTone(image, options({ saturation: -100 }));
  assert.equal(image.data[0], image.data[2]);
  adjustTone(image, options({ warmth: 100 }));
  assert(image.data[0] > image.data[2]);
  assert.equal(image.data[3], 210);
});

test('ordered dithering is stable across frames and creates intermediate coverage with only two inks', () => {
  const palette = [[18, 64, 40], [255, 224, 181]];
  const finish = createFinish(palette, options({ paletteMode: 'duo', dither: 100 }));
  const one = patch(4, 4, [128, 128, 128, 255]);
  const two = patch(4, 4, [128, 128, 128, 255]);
  finish(one);
  finish(two);
  assert.deepEqual(one, two);
  const light = Array.from({ length: 16 }, (_, i) => one.data[i * 4]).filter((r) => r === 255).length;
  assert.equal(light, 8);
  assert([...one.data].every((channel, i) => i % 4 === 3 || palette.some((color) => color[i % 4] === channel)));
});

test('both print textures produce distinct deterministic patterns without adding palette colors', () => {
  const palette = [[10, 10, 10], [128, 128, 128], [240, 240, 240]];
  const outputs = new Map();
  for (const texture of ['none', 'riso', 'halftone']) {
    const finish = createFinish(palette, options({ paletteMode: 'custom', texture, ink: 100 }));
    const image = patch(14, 10, [150, 150, 150, 255]);
    const copy = patch(14, 10, [150, 150, 150, 255]);
    finish(image);
    finish(copy);
    assert.deepEqual(image, copy);
    assert(image.data.every((value, i) => i % 4 === 3 || [10, 128, 240].includes(value)));
    outputs.set(texture, image.data);
  }
  assert.notDeepEqual(outputs.get('riso'), outputs.get('none'));
  assert.notDeepEqual(outputs.get('halftone'), outputs.get('riso'));
});

test('deflicker smooths alternating exposures while retaining a log-linear transition and bounding the gain', () => {
  const low = 80 * exposureGain(80, [80, 120, 80, 120, 80], 100);
  const high = 120 * exposureGain(120, [120, 80, 120, 80, 120], 100);
  assert(Math.abs(high - low) < 0.000001);
  assert(Math.abs(exposureGain(80, [20, 40, 80, 160, 320], 100) - 1) < 0.000001);
  assert(exposureGain(32, [255, 255, 32, 255, 255], 100) <= 1.54);
  assert.equal(exposureGain(0, [255, 255, 0, 255, 255], 100), 1);
  assert(Math.abs(meanLuma(patch(3, 2, [80, 80, 80, 255]).data) - 80) < 0.000001);
});

test('trails weight recent layers most and never mutate cached pixels', () => {
  const layers = [0, 100, 250].map((r) => ({ gain: 1, data: patch(1, 1, [r, 0, 0, 255]).data }));
  assert.deepEqual(blendFrames(layers, 0), layers[0].data);
  const result = blendFrames(layers, 100);
  assert.equal(result[0], Math.round((100 * 0.68 + 250 * 0.68 ** 2) / (1 + 0.68 + 0.68 ** 2)));
  assert.deepEqual([...layers[0].data], [0, 0, 0, 255]);
  assert.equal(result[3], 255);
});

test('rotation, zoom and pan crop inside the source for each export aspect', () => {
  const original = sourceCrop(320, 240, DEFAULT_EFFECTS);
  assert.deepEqual(original, { x: 0, y: 0, width: 320, height: 240 });
  const crop = sourceCrop(320, 240, options({ aspect: 'portrait', rotation: 90, zoom: 200, panX: -100, panY: 100 }));
  assert.deepEqual(crop, { x: 0, y: 160, width: 90, height: 160 });
  assert.deepEqual(renderSize(crop, { longSide: 128 }, 'portrait'), { width: 72, height: 128 });
  assert.deepEqual(renderSize(original, { id: '4x6' }, 'original'), { width: 6, height: 4 });
  const landscape = sourceCrop(320, 240, options({ aspect: 'landscape' }));
  assert.deepEqual(landscape, { x: 0, y: 30, width: 320, height: 180 });
  assert.deepEqual(renderSize(landscape, { full: true }, 'landscape'), { width: 320, height: 180 });
});
