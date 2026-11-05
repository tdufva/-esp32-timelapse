import { ASPECTS } from './image-effects.mjs?v=4';

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Vienti keskeytetty', 'AbortError');
}

export async function exportTimelapse({ frames, fps, format, render, signal, aspect = 'original', paletteColors = null, onProgress = () => {} }) {
  if (!frames.length) throw new Error('Valitulla aikavälillä ei ole kuvia.');
  if (!Number.isFinite(fps) || fps < 1 || fps > 24) throw new Error('Virheellinen kuvanopeus.');
  if (!['mp4', 'gif'].includes(format)) throw new Error('Tuntematon tiedostomuoto.');
  if (format === 'mp4' && typeof globalThis.VideoEncoder !== 'function') throw new Error('MP4-koodaus ei ole käytettävissä tässä selaimessa. GIF-vienti on käytettävissä.');
  const limit = format === 'gif' ? 1000 : 10000;
  if (frames.length > limit) throw new Error(`${format.toUpperCase()}-viennin enimmäismäärä on ${limit} kuvaa.`);
  checkAbort(signal);
  const first = await render(frames[0], signal, 0);
  const canvas = document.createElement('canvas');
  const target = Object.hasOwn(ASPECTS, aspect) ? ASPECTS[aspect] : null;
  const [width, height] = target || [first.width, first.height];
  const scale = 640 / Math.max(width, height);
  canvas.width = Math.max(16, Math.round(width * scale / 2) * 2);
  canvas.height = Math.max(16, Math.round(height * scale / 2) * 2);
  const context = canvas.getContext('2d', { willReadFrequently: format === 'gif' });
  context.imageSmoothingEnabled = false;
  function draw(source) {
    if (target) {
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      return;
    }
    context.fillStyle = '#111514';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const ratio = Math.min(canvas.width / source.width, canvas.height / source.height);
    const width = source.width * ratio;
    const height = source.height * ratio;
    context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  }
  if (format === 'gif') {
    const { GIFEncoder, quantize, applyPalette, nearestColorIndex } = await import('./vendor/gifenc.mjs');
    const gif = GIFEncoder();
    const fixedIndices = new Map((paletteColors || []).map((rgb, index) => [(rgb[0] << 16) | (rgb[1] << 8) | rgb[2], index]));
    for (let index = 0; index < frames.length; index++) {
      checkAbort(signal);
      draw(index === 0 ? first : await render(frames[index], signal, index));
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const palette = paletteColors || quantize(data, 256);
      let indexed;
      if (paletteColors) {
        indexed = new Uint8Array(data.length / 4);
        for (let offset = 0; offset < data.length; offset += 4) {
          const rgb = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
          let color = fixedIndices.get(rgb);
          if (color === undefined) {
            color = nearestColorIndex(palette, [data[offset], data[offset + 1], data[offset + 2]]);
            if (fixedIndices.size < 8192) fixedIndices.set(rgb, color);
          }
          indexed[offset / 4] = color;
        }
      } else indexed = applyPalette(data, palette);
      gif.writeFrame(indexed, canvas.width, canvas.height, { palette: !paletteColors || index === 0 ? palette : undefined, delay: 1000 / fps, repeat: 0 });
      onProgress((index + 1) / frames.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    checkAbort(signal);
    gif.finish();
    return new Blob([gif.bytes()], { type: 'image/gif' });
  }
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, Quality, getFirstEncodableVideoCodec } = await import('./vendor/mediabunny.mjs');
  checkAbort(signal);
  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: canvas.width, height: canvas.height, frameRate: fps });
  if (!codec) throw new Error('MP4-koodaus ei ole käytettävissä tässä selaimessa. GIF-vienti on käytettävissä.');
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec, quality: new Quality('high') });
  output.addVideoTrack(source, { frameRate: fps });
  try {
    await output.start();
    for (let index = 0; index < frames.length; index++) {
      checkAbort(signal);
      draw(index === 0 ? first : await render(frames[index], signal, index));
      await source.add(index / fps, 1 / fps);
      onProgress((index + 1) / frames.length);
    }
    source.close();
    checkAbort(signal);
    await output.finalize();
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }
}
