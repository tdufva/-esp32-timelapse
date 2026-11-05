import { nearestColorIndex } from './vendor/gifenc.mjs';

export const ASPECTS = Object.freeze({ landscape: [16, 9], square: [1, 1], portrait: [9, 16] });
const EXPOSURE_WEIGHTS = [1, 4, 6, 4, 1];
export const DUOTONES = Object.freeze({ cyanotype: ['#16365e', '#f4f6ef'], peach: ['#244d37', '#ffc3a0'] });
export const DEFAULT_COLORS = Object.freeze(['#244d37', '#fff1ad', '#e78272']);
export const DEFAULT_EFFECTS = Object.freeze({
  brightness: 0, contrast: 0, saturation: 0, warmth: 0,
  dither: 0, texture: 'none', ink: 60, deflicker: 0, trails: 0,
  aspect: 'original', rotation: 0, zoom: 100, panX: 0, panY: 0,
});
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function normalizeColors(colors) {
  if (!Array.isArray(colors) || colors.length < 2 || colors.length > 16 ||
      !colors.every((color) => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color))) return null;
  return colors.map((color) => color.toLowerCase());
}

export function hexToRgb(color) {
  const number = Number.parseInt(color.slice(1), 16);
  return [number >> 16, (number >> 8) & 255, number & 255];
}

export function sourceCrop(width, height, { aspect, rotation, zoom, panX, panY }) {
  const turned = rotation === 90 || rotation === 270;
  const w = turned ? height : width;
  const h = turned ? width : height;
  const target = Object.hasOwn(ASPECTS, aspect) ? ASPECTS[aspect] : null;
  const ratio = target ? target[0] / target[1] : w / h;
  const scale = 100 / zoom;
  const cropWidth = Math.min(w, h * ratio) * scale;
  const cropHeight = Math.min(h, w / ratio) * scale;
  return { x: (w - cropWidth) * (panX + 100) / 200, y: (h - cropHeight) * (panY + 100) / 200, width: cropWidth, height: cropHeight };
}

export function renderSize(crop, preset, aspect) {
  const longSide = Math.max(crop.width, crop.height);
  if (preset.id === '4x6' && aspect === 'original') {
    return crop.width >= crop.height ? { width: 6, height: 4 } : { width: 4, height: 6 };
  }
  const scale = preset.full ? 1 : Math.min(1, preset.longSide / longSide);
  return { width: Math.max(1, Math.round(crop.width * scale)), height: Math.max(1, Math.round(crop.height * scale)) };
}

export function meanLuma(data) {
  let total = 0;
  for (let i = 0; i < data.length; i += 4) total += luma(data[i], data[i + 1], data[i + 2]);
  return data.length ? total * 4 / data.length : 0;
}

export function exposureGain(center, neighbors, strength) {
  if (!strength || !center) return 1;
  const base = Math.log(Math.max(8, center));
  let sum = 0, weight = 0;
  for (let i = 0; i < EXPOSURE_WEIGHTS.length; i++) {
    if (neighbors[i] == null) continue;
    sum += Math.log(Math.max(8, neighbors[i])) * EXPOSURE_WEIGHTS[i];
    weight += EXPOSURE_WEIGHTS[i];
  }
  if (!weight) return 1;
  // Smooth exposure changes, but do not try to turn a night frame into daylight.
  return Math.exp(clamp(sum / weight - base, -0.43, 0.43) * strength / 100 * Math.min(1, center / 24));
}

export function blendFrames(layers, strength) {
  const result = new Uint8ClampedArray(layers[0].data);
  if (layers.length === 1 && layers[0].gain === 1) return result;
  const weights = layers.map((_, index) => (strength * 0.0068) ** index);
  const total = weights.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < result.length; i++) {
    if ((i & 3) === 3) continue;
    let value = 0;
    for (let j = 0; j < layers.length; j++) value += Math.min(255, layers[j].data[i] * layers[j].gain) * weights[j];
    result[i] = value / total;
  }
  return result;
}

export function adjustTone({ data }, { brightness, contrast, saturation, warmth }) {
  if (!brightness && !contrast && !saturation && !warmth) return;
  const slope = 1 + contrast / 100;
  const shift = 128 * (1 - slope) + brightness * 1.6;
  const chroma = 1 + saturation / 100;
  for (let i = 0; i < data.length; i += 4) {
    const y = luma(data[i], data[i + 1], data[i + 2]);
    data[i] = (y + (data[i] - y) * chroma) * slope + shift + warmth * 0.42;
    data[i + 1] = (y + (data[i + 1] - y) * chroma) * slope + shift + warmth * 0.04;
    data[i + 2] = (y + (data[i + 2] - y) * chroma) * slope + shift - warmth * 0.42;
  }
}

function textureOffset(x, y, mode) {
  if (mode === 'halftone') {
    const dx = (x + Math.floor(y / 5) * 2) % 5 - 2;
    const dy = y % 5 - 2;
    return (dx * dx + dy * dy - 4) * 13;
  }
  let grain = Math.imul(x + 1, 0x45d9f3b) ^ Math.imul(y + 1, 0x119de1f3);
  grain = Math.imul(grain ^ (grain >>> 16), 0x45d9f3b);
  return ((grain >>> 24) - 128) * 0.59 + ((x + y * 2) % 7 < 2 ? -27 : 11);
}

export function createFinish(palette, { paletteMode, dither, texture, ink }) {
  const cache = new Map();
  const print = texture === 'none' ? 0 : ink / 100;
  const ordered = palette ? dither / 100 : 0;
  let step = 0;
  if (ordered) {
    const meanSpacing = palette.reduce((sum, color, index) => sum + Math.min(...palette.map((other, j) =>
      index === j ? Infinity : Math.hypot(...other.map((channel, i) => channel - color[i])))), 0) / palette.length;
    step = paletteMode === 'duo' ? 255 : clamp(meanSpacing * 0.92, 40, 180);
  }
  return ({ data, width }) => {
    if (!palette && !print) return;
    for (let i = 0, pixel = 0; i < data.length; i += 4, pixel++) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const bias = (print ? textureOffset(x, y, texture) * print : 0) +
        (ordered ? ((bayer[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * ordered * step : 0);
      if (paletteMode === 'duo') {
        [data[i], data[i + 1], data[i + 2]] = palette[luma(data[i], data[i + 1], data[i + 2]) + bias >= 127.5 ? 1 : 0];
        continue;
      }
      const r = clamp(Math.round(data[i] + bias), 0, 255);
      const g = clamp(Math.round(data[i + 1] + bias), 0, 255);
      const b = clamp(Math.round(data[i + 2] + bias), 0, 255);
      if (!palette) {
        data[i] = r; data[i + 1] = g; data[i + 2] = b;
        continue;
      }
      const key = (r << 16) | (g << 8) | b;
      let color = cache.get(key);
      if (!color) {
        color = palette[nearestColorIndex(palette, [r, g, b])];
        if (cache.size < 8192) cache.set(key, color);
      }
      [data[i], data[i + 1], data[i + 2]] = color;
    }
  };
}
