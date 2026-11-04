import { nearestColorIndex } from './vendor/gifenc.mjs';

const hexPalettes = {
  minimal: ['#182b29', '#354e45', '#526e48', '#75965b', '#a4bd78', '#d4dcaa', '#eff0d8', '#f8f8ed', '#6fa8a1', '#9cc9bd', '#638ba6', '#bcc9c3', '#a38c54', '#e4c967', '#d99d91', '#efc4ad'],
  nature: ['#182923', '#33452f', '#50643d', '#7f914d', '#b1bd77', '#d8dbb0', '#f2f0d8', '#fafbf3', '#405f67', '#7294a0', '#abc8cd', '#959b8f', '#645446', '#a18457', '#d2b183', '#b9807a'],
  cinematic: ['#14292e', '#26434a', '#426267', '#6b8986', '#a3b3a0', '#d1c8a2', '#eee0bd', '#fbf1da', '#2c384a', '#55677e', '#8e9ca9', '#bec4c0', '#7b694e', '#bb965d', '#dfb57b', '#bc827c'],
};
const eightIndices = [0, 2, 4, 7, 8, 10, 13, 14];
const palettes = new Map();
const caches = new Map();

export function paletteColors(style = 'minimal', mode = '16') {
  if (!['8', '16'].includes(String(mode))) return null;
  const key = `${style}:${mode}`;
  if (!palettes.has(key)) {
    let colors;
    if (style === 'mono') {
      const count = Number(mode);
      colors = Array.from({ length: count }, (_, index) => Array(3).fill(Math.round(index * 255 / (count - 1))));
    } else {
      const source = hexPalettes[style] || hexPalettes.minimal;
      colors = (String(mode) === '8' ? eightIndices.map((index) => source[index]) : source).map((hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)));
    }
    palettes.set(key, Object.freeze(colors.map(Object.freeze)));
  }
  return palettes.get(key);
}

export function applyFixedPalette(imageData, style, mode) {
  const palette = paletteColors(style, mode);
  if (!palette) return imageData;
  const key = `${style}:${mode}`;
  if (!caches.has(key)) caches.set(key, new Map());
  const cache = caches.get(key);
  const data = imageData.data;
  for (let offset = 0; offset < data.length; offset += 4) {
    const color = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
    let index = cache.get(color);
    if (index === undefined) {
      index = nearestColorIndex(palette, [data[offset], data[offset + 1], data[offset + 2]]);
      if (cache.size >= 8192) cache.clear();
      cache.set(color, index);
    }
    [data[offset], data[offset + 1], data[offset + 2]] = palette[index];
  }
  return imageData;
}
