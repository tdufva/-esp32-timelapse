import { adjustTone, blendFrames, createFinish, exposureGain, meanLuma, renderSize, sourceCrop } from './image-effects.mjs?v=4';

function sample(image, crop, { width, height }, rotation) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  context.scale(width / crop.width, height / crop.height);
  context.translate(-crop.x, -crop.y);
  if (rotation === 90) context.translate(image.naturalHeight, 0);
  if (rotation === 180) context.translate(image.naturalWidth, image.naturalHeight);
  if (rotation === 270) context.translate(0, image.naturalWidth);
  if (rotation) context.rotate(rotation * Math.PI / 180);
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, width, height).data;
}

export function createFrameRenderer({ loadImage, grade }) {
  const samples = new Map();
  const exposure = new Map();
  const pixelBudget = 1_200_000;
  let pixels = 0;
  let finishKey = '';
  let finish;
  const cropFor = (image, settings) => sourceCrop(image.naturalWidth, image.naturalHeight, settings);
  function pixelsFor(frame, image, size, settings, geometry) {
    const key = JSON.stringify([frame.url, geometry, size.width, size.height]);
    let data = samples.get(key);
    if (data) {
      samples.delete(key);
      samples.set(key, data);
      return data;
    }
    data = sample(image, cropFor(image, settings), size, settings.rotation);
    const count = data.length / 4;
    if (count <= pixelBudget) {
      while (samples.size >= 16 || pixels + count > pixelBudget) {
        const oldest = samples.keys().next().value;
        pixels -= samples.get(oldest).length / 4;
        samples.delete(oldest);
      }
      samples.set(key, data);
      pixels += count;
    }
    return data;
  }

  return async function render(frames, index, settings, signal) {
    signal?.throwIfAborted();
    const current = frames[index];
    const { resolution, aspect, rotation, zoom, panX, panY, trails, deflicker } = settings;
    const geometry = [aspect, rotation, zoom, panX, panY].join('/');
    const first = trails ? Math.max(0, index - 3) : index;
    const from = deflicker ? Math.max(0, first - 2) : first;
    const to = deflicker ? Math.min(frames.length - 1, index + 2) : index;
    const currentImage = await loadImage(current.url, signal);
    const size = renderSize(cropFor(currentImage, settings), resolution, aspect);
    const images = new Map([[index, currentImage]]);
    const levels = new Map();
    await Promise.all(Array.from({ length: to - from + 1 }, async (_, offset) => {
      const i = from + offset;
      const frame = frames[i];
      const key = JSON.stringify([frame.url, geometry]);
      if (deflicker && exposure.has(key)) levels.set(i, exposure.get(key));
      if ((i < first || i > index) && levels.has(i)) return;
      try {
        const image = i === index ? currentImage : await loadImage(frame.url, signal);
        if (i >= first && i <= index) images.set(i, image);
        if (deflicker && !levels.has(i)) {
          const level = meanLuma(sample(image, cropFor(image, settings), { width: 32, height: 32 }, rotation));
          if (exposure.size >= 512) exposure.delete(exposure.keys().next().value);
          exposure.set(key, level);
          levels.set(i, level);
        }
      } catch (error) {
        if (i === index || signal?.aborted) throw error;
      }
    }));
    signal?.throwIfAborted();
    const layers = [];
    for (let i = index; i >= first; i--) {
      const image = images.get(i);
      if (!image) continue;
      const neighbors = deflicker ? Array.from({ length: 5 }, (_, j) => levels.get(i + j - 2)) : [];
      layers.push({
        data: pixelsFor(frames[i], image, size, settings, geometry),
        gain: exposureGain(levels.get(i), neighbors, deflicker),
      });
    }
    const data = new ImageData(blendFrames(layers, trails), size.width, size.height);
    grade(data, settings.styleMode, !(settings.paletteMode === 'duo' || settings.dither && settings.paletteColors));
    adjustTone(data, settings);
    const key = JSON.stringify([settings.paletteColors, settings.paletteMode, settings.dither, settings.texture, settings.ink]);
    if (key !== finishKey) {
      finish = createFinish(settings.paletteColors, settings);
      finishKey = key;
    }
    finish(data);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d').putImageData(data, 0, 0);
    return { canvas, ...size, full: resolution.full };
  };
}
