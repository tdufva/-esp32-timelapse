import { parseFrameDate, filterFrames, CAMERA_TIME_ZONE } from './timelapse-core.mjs?v=3';
import { createDashboard } from './dashboard.mjs?v=3';
import { createIcons, icons } from './vendor/lucide.mjs?v=3';
import { applyFixedPalette, paletteColors } from './palettes.mjs?v=3';

const config = {
  owner: "your-github-user",
  repo: "esp32-timelapse",
  branch: "main",
  photoPath: "photos",
  frameRate: 8,
  refreshSeconds: 300,
  pixelWidth: 128,
  defaultResolution: "128",
  defaultStyle: "minimal",
  defaultPalette: '16',
  solarBrightness: 1.18,
  solarSaturation: 1.35,
  solarLevels: 5,
  timeZone: CAMERA_TIME_ZONE,
  cameraStatusPath: 'status/esp32cam.json',
  ...(window.TIMELAPSE_CONFIG || {})
};

const state = {
  allFrames: [],
  range: { start: '', end: '' },
  thumbnailBucket: -1,
  loading: false,
  frames: [],
  index: 0,
  playing: true,
  fps: Number(config.frameRate) || 8,
  resolutionIndex: 5,
  styleMode: config.defaultStyle || "minimal",
  paletteMode: config.defaultPalette || '16',
  timer: null,
  refreshTimer: null
};

const els = {
  sourceLabel: document.querySelector("#sourceLabel"),
  syncState: document.querySelector("#syncState"),
  frameCount: document.querySelector("#frameCount"),
  latestFrame: document.querySelector("#latestFrame"),
  frameCanvas: document.querySelector("#frameCanvas"),
  emptyState: document.querySelector("#emptyState"),
  frameSlider: document.querySelector("#frameSlider"),
  frameLabel: document.querySelector("#frameLabel"),
  playToggle: document.querySelector("#playToggle"),
  prevFrame: document.querySelector("#prevFrame"),
  nextFrame: document.querySelector("#nextFrame"),
  refreshFrames: document.querySelector("#refreshFrames"),
  speedSlider: document.querySelector("#speedSlider"),
  speedLabel: document.querySelector("#speedLabel"),
  resolutionSlider: document.querySelector("#resolutionSlider"),
  resolutionLabel: document.querySelector("#resolutionLabel"),
  styleSelect: document.querySelector("#styleSelect"),
  firstDate: document.querySelector("#firstDate"),
  lastDate: document.querySelector("#lastDate"),
  pathValue: document.querySelector("#pathValue"),
  currentName: document.querySelector("#currentName")
};
els.currentTime = document.querySelector('#currentTime');
els.thumbnailStrip = document.querySelector('#thumbnailStrip');
els.exportOpen = document.querySelector('#exportOpen');
els.emptyMessage = document.querySelector('#emptyMessage');

const renderState = {
  token: 0,
  images: new Map()
};

function loadImage(url, signal) {
  if (!renderState.images.has(url)) {
    const promise = new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      const timer = window.setTimeout(() => { image.onload = image.onerror = null; image.src = ''; reject(new Error('Kuvan lataus aikakatkaistiin')); }, 20000);
      image.onload = () => { window.clearTimeout(timer); resolve(image); };
      image.onerror = () => { window.clearTimeout(timer); reject(new Error('Kuva ei latautunut')); };
      image.src = url;
    });
    renderState.images.set(url, promise);
    promise.catch(() => { if (renderState.images.get(url) === promise) renderState.images.delete(url); });
    if (renderState.images.size > 24) renderState.images.delete(renderState.images.keys().next().value);
  }
  const promise = renderState.images.get(url);
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Keskeytetty', 'AbortError'));
  let abort;
  return Promise.race([promise, new Promise((_, reject) => {
    abort = () => reject(new DOMException('Keskeytetty', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
  })]).finally(() => signal.removeEventListener('abort', abort));
}

const resolutionPresets = [
  { id: "4x6", label: "4 x 6 px", longSide: 6 },
  { id: "12", label: "12 px", longSide: 12 },
  { id: "24", label: "24 px", longSide: 24 },
  { id: "48", label: "48 px", longSide: 48 },
  { id: "96", label: "96 px", longSide: 96 },
  { id: "128", label: "128 px", longSide: 128 },
  { id: "256", label: "256 px", longSide: 256 },
  { id: "512", label: "512 px", longSide: 512 },
  { id: "full", label: "Täysi", full: true }
];

const stylePresets = {
  minimal: { label: "Minimalistinen", levels: 5 },
  nature: { label: "Luontodokumentti", levels: 10 },
  cinematic: { label: "Cinematic", levels: 7 },
  mono: { label: "Mustavalkoinen", levels: 8 }
};

const configuredResolution = String(config.defaultResolution || config.pixelWidth || "128");
const configuredResolutionIndex = resolutionPresets.findIndex((preset) => preset.id === configuredResolution || String(preset.longSide) === configuredResolution);
state.resolutionIndex = configuredResolutionIndex >= 0 ? configuredResolutionIndex : 5;

if (!stylePresets[state.styleMode]) {
  state.styleMode = "minimal";
}
if (!['original', '8', '16'].includes(state.paletteMode)) state.paletteMode = '16';

function updatePaletteControls() {
  document.querySelectorAll('[data-palette]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.palette === state.paletteMode)));
  const preview = document.getElementById('palettePreview');
  preview.replaceChildren(...(paletteColors(state.styleMode, state.paletteMode) || []).map((color) => {
    const swatch = document.createElement('span');
    swatch.style.backgroundColor = `rgb(${color.join(',')})`;
    return swatch;
  }));
  preview.style.setProperty('--palette-count', preview.children.length || 16);
}

function isConfigured() {
  return config.owner && config.repo && config.owner !== "your-github-user";
}

function encodePath(path) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function treeUrl() {
  const owner = encodeURIComponent(config.owner);
  const repo = encodeURIComponent(config.repo);
  const ref = encodeURIComponent(config.branch);
  return `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
}

function rawUrl(path) {
  const owner = encodeURIComponent(config.owner);
  const repo = encodeURIComponent(config.repo);
  const branch = encodeURIComponent(config.branch);
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodePath(path)}`;
}

function setStatus(text) {
  els.syncState.textContent = text;
}

function formatDate(date) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("fi-FI", {
    year: "numeric",
    timeZone: config.timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function dateFromName(name) {
  return parseFrameDate(name, config.timeZone);
}

function imageFiles(items) {
  const photoPrefix = `${config.photoPath.replace(/^\/+|\/+$/g, "")}/`;

  return items
    .filter((item) => item.type === "blob" && item.path?.startsWith(photoPrefix) && /\.(jpe?g|png|webp)$/i.test(item.path))
    .map((item) => ({
      name: item.path.split("/").pop(),
      path: item.path,
      url: rawUrl(item.path),
      size: item.size || 0,
      date: dateFromName(item.path)
    })).sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0) || a.name.localeCompare(b.name));
}

function updateStats() {
  const total = state.frames.length;
  const current = state.frames[state.index];
  const first = state.frames[0];
  const last = state.frames[total - 1];

  els.frameCount.textContent = `${total} kuva${total === 1 ? "" : "a"}`;
  els.latestFrame.textContent = last?.date ? formatDate(last.date) : "Ei kuvia";
  els.firstDate.textContent = first?.date ? formatDate(first.date) : "-";
  els.lastDate.textContent = last?.date ? formatDate(last.date) : "-";
  els.currentName.textContent = current?.name || "-";
  els.currentTime.textContent = current?.date ? formatDate(current.date) : current ? 'Aika tuntematon' : '—';
  els.exportOpen.disabled = total === 0;
  els.playToggle.disabled = total === 0;
  els.prevFrame.disabled = total < 2;
  els.nextFrame.disabled = total < 2;
  els.pathValue.textContent = config.photoPath;
  els.frameSlider.max = String(Math.max(total - 1, 0));
  els.frameSlider.value = String(state.index);
  els.frameSlider.disabled = total < 2;
  els.frameLabel.value = total ? `${state.index + 1} / ${total}` : "0 / 0";
  renderThumbnails();
}

function renderThumbnails() {
  const bucket = Math.floor(state.index / 20);
  if (bucket !== state.thumbnailBucket) {
    state.thumbnailBucket = bucket;
    els.thumbnailStrip.replaceChildren(...state.frames.slice(bucket * 20, bucket * 20 + 20).map((frame, offset) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.index = bucket * 20 + offset;
      button.className = 'thumbnail';
      button.title = frame.name;
      button.setAttribute('aria-label', frame.date ? formatDate(frame.date) : frame.name);
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.loading = 'lazy';
      image.src = frame.url;
      image.alt = '';
      const time = document.createElement('span');
      time.textContent = frame.date ? new Intl.DateTimeFormat('fi-FI', { timeZone: config.timeZone, hour: '2-digit', minute: '2-digit' }).format(frame.date) : '—';
      button.append(image, time);
      return button;
    }));
  }
  els.thumbnailStrip.querySelectorAll('[data-index]').forEach((button) => button.setAttribute('aria-current', String(Number(button.dataset.index) === state.index)));
}

function applyFilters(keepPosition = true) {
  const previous = state.frames[state.index]?.name;
  state.frames = filterFrames(state.allFrames, state.range, config.timeZone);
  const index = keepPosition ? state.frames.findIndex((frame) => frame.name === previous) : -1;
  state.index = index >= 0 ? index : Math.max(0, state.frames.length - 1);
  state.thumbnailBucket = -1;
  els.emptyMessage.textContent = state.allFrames.length ? 'Valitulla aikavälillä ei ole kuvia.' : 'GitHubissa ei ole vielä kuvia.';
  updateStats();
  renderFrame();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function contrastLightness(value, amount = 1, lift = 0) {
  return clamp((value - 0.5) * amount + 0.5 + lift, 0, 1);
}

function rgbToHsl(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return [h, s, l];
}

function hueToRgb(p, q, t) {
  let next = t;
  if (next < 0) next += 1;
  if (next > 1) next -= 1;
  if (next < 1 / 6) return p + (q - p) * 6 * next;
  if (next < 1 / 2) return q;
  if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const gray = Math.round(l * 255);
    return [gray, gray, gray];
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255)
  ];
}

function posterize(value, levels) {
  const safeLevels = Math.max(2, Number(levels) || 5);
  return Math.round(Math.round(value * (safeLevels - 1)) / (safeLevels - 1) * 255);
}

function resolveRenderSize(image, resolutionIndex = state.resolutionIndex) {
  const preset = resolutionPresets[resolutionIndex] || resolutionPresets[5];
  const sourceWidth = Math.max(1, image.naturalWidth || image.width || 1);
  const sourceHeight = Math.max(1, image.naturalHeight || image.height || 1);

  if (preset.full) {
    return { width: sourceWidth, height: sourceHeight, full: true };
  }

  if (preset.id === "4x6") {
    return sourceWidth >= sourceHeight
      ? { width: 6, height: 4, full: false }
      : { width: 4, height: 6, full: false };
  }

  const longSide = Math.max(1, Number(preset.longSide) || 128);
  if (sourceWidth >= sourceHeight) {
    return {
      width: Math.min(sourceWidth, longSide),
      height: Math.max(1, Math.round(Math.min(sourceWidth, longSide) * sourceHeight / sourceWidth)),
      full: false
    };
  }

  return {
    width: Math.max(1, Math.round(Math.min(sourceHeight, longSide) * sourceWidth / sourceHeight)),
    height: Math.min(sourceHeight, longSide),
    full: false
  };
}

function updateResolutionLabel(width, height, isFull = false) {
  const suffix = isFull ? `Täysi ${width} x ${height} px` : `${width} x ${height} px`;
  els.resolutionLabel.value = suffix;
  els.resolutionLabel.textContent = suffix;
}

function updateResolutionPresetLabel() {
  const preset = resolutionPresets[state.resolutionIndex] || resolutionPresets[5];
  const label = preset.full ? "Täysi" : preset.label;
  els.resolutionLabel.value = label;
  els.resolutionLabel.textContent = label;
}

function gradeMinimal(red, green, blue) {
  const [h, s, l] = rgbToHsl(red, green, blue);
  const warmLight = clamp(l * Number(config.solarBrightness || 1.18) + 0.04, 0, 1);
  const vivid = clamp(s * Number(config.solarSaturation || 1.35) + 0.04, 0, 1);
  let hue = h;

  if (h > 0.16 && h < 0.48) {
    hue = clamp(h + 0.035, 0, 1);
  } else if (h >= 0.48 && h < 0.72) {
    hue = clamp(h - 0.055, 0, 1);
  } else if (h < 0.08 || h > 0.92) {
    hue = 0.105;
  } else if (warmLight > 0.72 && vivid < 0.28) {
    hue = 0.14;
  }

  let [r, g, b] = hslToRgb(hue, vivid, warmLight);
  r = posterize(r / 255, config.solarLevels);
  g = posterize(g / 255, config.solarLevels);
  b = posterize(b / 255, config.solarLevels);

  return [r, g, b];
}

function gradeNature(red, green, blue) {
  let [h, s, l] = rgbToHsl(red, green, blue);
  l = contrastLightness(l, 1.08, 0.015);
  s = clamp(s * 1.22 + 0.03, 0, 1);

  if (h > 0.16 && h < 0.44) {
    h = clamp(h - 0.018, 0, 1);
    s = clamp(s + 0.08, 0, 1);
  } else if (h > 0.48 && h < 0.68) {
    h = clamp(h - 0.025, 0, 1);
  } else if (h < 0.12) {
    h = clamp(h + 0.01, 0, 1);
  }

  let [r, g, b] = hslToRgb(h, s, l);
  r = posterize(r / 255, stylePresets.nature.levels);
  g = posterize(g / 255, stylePresets.nature.levels);
  b = posterize(b / 255, stylePresets.nature.levels);
  return [r, g, b];
}

function gradeCinematic(red, green, blue) {
  const [h, s, l] = rgbToHsl(red, green, blue);
  const contrast = contrastLightness(l, 1.22, -0.015);
  let hue = h;
  let saturation = clamp(s * 1.08 + 0.02, 0, 1);

  if (contrast < 0.42) {
    hue = 0.52;
    saturation = clamp(saturation + 0.12, 0, 1);
  } else if (contrast > 0.62) {
    hue = h < 0.2 || h > 0.9 ? 0.095 : clamp(h + 0.018, 0, 1);
    saturation = clamp(saturation + 0.08, 0, 1);
  } else if (h > 0.45 && h < 0.72) {
    hue = clamp(h - 0.06, 0, 1);
  }

  let [r, g, b] = hslToRgb(hue, saturation, contrast);
  r = posterize(r / 255, stylePresets.cinematic.levels);
  g = posterize(g / 255, stylePresets.cinematic.levels);
  b = posterize(b / 255, stylePresets.cinematic.levels);
  return [r, g, b];
}

function gradeMono(red, green, blue) {
  const luminance = contrastLightness((red * 0.299 + green * 0.587 + blue * 0.114) / 255, 1.16, 0.02);
  const gray = posterize(luminance, stylePresets.mono.levels);
  return [gray, gray, gray];
}

function gradePixel(red, green, blue, styleMode = state.styleMode) {
  switch (styleMode) {
    case "nature":
      return gradeNature(red, green, blue);
    case "cinematic":
      return gradeCinematic(red, green, blue);
    case "mono":
      return gradeMono(red, green, blue);
    default:
      return gradeMinimal(red, green, blue);
  }
}

function colorGrade(imageData, styleMode = state.styleMode) {
  const data = imageData.data;
  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b] = gradePixel(data[index], data[index + 1], data[index + 2], styleMode);
    data[index] = r;
    data[index + 1] = g;
    data[index + 2] = b;
  }
  return imageData;
}

function drawPixelFrame(image) {
  const { canvas, width, height, full } = pixelCanvas(image, state);
  els.frameCanvas.width = width;
  els.frameCanvas.height = height;
  const target = els.frameCanvas.getContext('2d');
  target.imageSmoothingEnabled = false;
  target.drawImage(canvas, 0, 0);
  updateResolutionLabel(width, height, full);
}

function pixelCanvas(image, settings) {
  const { width, height, full } = resolveRenderSize(image, settings.resolutionIndex);
  const workCanvas = document.createElement("canvas");
  const workContext = workCanvas.getContext("2d", { willReadFrequently: true });

  workCanvas.width = width;
  workCanvas.height = height;
  workContext.imageSmoothingEnabled = true;
  workContext.drawImage(image, 0, 0, width, height);

  const graded = colorGrade(workContext.getImageData(0, 0, width, height), settings.styleMode);
  applyFixedPalette(graded, settings.styleMode, settings.paletteMode);
  workContext.putImageData(graded, 0, 0);
  return { canvas: workCanvas, width, height, full };
}

async function renderFrame() {
  const frame = state.frames[state.index];
  const token = ++renderState.token;

  if (!frame) {
    els.frameCanvas.style.display = "none";
    els.emptyState.style.display = "grid";
    updateResolutionPresetLabel();
    updateStats();
    return;
  }

  els.emptyState.style.display = "none";
  els.frameCanvas.style.display = "block";

  try {
    const image = await loadImage(frame.url);
    if (token !== renderState.token) {
      return;
    }
    drawPixelFrame(image);
  } catch (error) {
    if (token !== renderState.token) return;
    console.error(error);
    setStatus("Kuvavirhe");
  }

  updateStats();
  preloadAround(state.index);
}

function preloadAround(index) {
  for (let step = 1; step <= 2; step++) {
    const frame = state.frames[(index + step) % state.frames.length];
    if (frame) {
      loadImage(frame.url).catch(() => {});
    }
  }
}

function nextFrame() {
  if (!state.frames.length) return;
  state.index = (state.index + 1) % state.frames.length;
  renderFrame();
}

function prevFrame() {
  if (!state.frames.length) return;
  state.index = (state.index - 1 + state.frames.length) % state.frames.length;
  renderFrame();
}

function stopPlayback() {
  window.clearInterval(state.timer);
  state.timer = null;
  state.playing = false;
  els.playToggle.classList.remove("is-playing");
}

function startPlayback() {
  window.clearInterval(state.timer);
  state.timer = window.setInterval(nextFrame, 1000 / Math.max(state.fps, 1));
  state.playing = true;
  els.playToggle.classList.add("is-playing");
}

function restartPlayback() {
  if (state.playing) {
    startPlayback();
  }
}

async function loadFrames({ keepPosition = true } = {}) {
  if (state.loading) return;
  if (!isConfigured()) {
    stopPlayback();
    setStatus("Asetukset puuttuvat");
    els.sourceLabel.textContent = "Muokkaa docs/config.js";
    renderFrame();
    return;
  }

  const previousName = state.frames[state.index]?.name;
  state.loading = true;
  els.refreshFrames.disabled = true;
  setStatus("Paivitetaan");
  els.sourceLabel.textContent = `${config.owner}/${config.repo}`;

  try {
    const response = await fetch(treeUrl(), {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}`);
    }

    const payload = await response.json();
    const files = Array.isArray(payload.tree) ? imageFiles(payload.tree) : [];
    state.allFrames = files;
    applyFilters(keepPosition && Boolean(previousName));
    dashboard.updateFrames(files);

    setStatus(payload.truncated ? "Osittainen" : files.length ? "Synkassa" : "Ei kuvia");
    restartPlayback();
    const statusEntry = payload.tree?.find((item) => item.path === config.cameraStatusPath);
    if (!statusEntry) dashboard.updateStatus(null);
    else {
      try {
        const response = await fetch(`${rawUrl(config.cameraStatusPath)}?v=${statusEntry.sha}`, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('status');
        dashboard.updateStatus(await response.json());
      } catch {
        dashboard.updateStatus(null, 'Tilatiedon haku epäonnistui');
      }
    }
  } catch (error) {
    console.error(error);
    setStatus("Virhe");
    stopPlayback();
    updateStats();
  } finally {
    state.loading = false;
    els.refreshFrames.disabled = false;
  }
}

const dashboard = createDashboard({
  getFrames: () => state.frames,
  getSettings: () => ({ resolutionIndex: state.resolutionIndex, styleMode: state.styleMode, paletteMode: state.paletteMode, paletteColors: paletteColors(state.styleMode, state.paletteMode), fps: state.fps, styleLabel: stylePresets[state.styleMode].label, resolutionLabel: els.resolutionLabel.textContent, paletteLabel: state.paletteMode === 'original' ? 'Vapaa paletti' : `${state.paletteMode} väriä` }),
  applyRange: (range) => { state.range = range; applyFilters(false); },
  renderExport: async (frame, settings, signal) => pixelCanvas(await loadImage(frame.url, signal), settings).canvas,
  timeZone: config.timeZone,
});
createIcons({ icons });
updatePaletteControls();
document.getElementById('paletteControls').addEventListener('click', (event) => {
  const button = event.target.closest('[data-palette]');
  if (!button) return;
  state.paletteMode = button.dataset.palette;
  updatePaletteControls();
  renderFrame();
});
els.thumbnailStrip.addEventListener('click', (event) => {
  const button = event.target.closest('[data-index]');
  if (!button) return;
  stopPlayback();
  state.index = Number(button.dataset.index);
  renderFrame();
});

els.playToggle.addEventListener("click", () => {
  if (state.playing) {
    stopPlayback();
  } else {
    startPlayback();
  }
});

els.prevFrame.addEventListener("click", () => {
  stopPlayback();
  prevFrame();
});

els.nextFrame.addEventListener("click", () => {
  stopPlayback();
  nextFrame();
});

els.refreshFrames.addEventListener("click", () => {
  loadFrames();
});

els.frameSlider.addEventListener("input", (event) => {
  stopPlayback();
  state.index = Number(event.target.value);
  renderFrame();
});

els.speedSlider.value = String(state.fps);
els.speedLabel.value = `${state.fps} fps`;
els.speedLabel.textContent = `${state.fps} fps`;
els.speedSlider.addEventListener("input", (event) => {
  state.fps = Number(event.target.value);
  els.speedLabel.value = `${state.fps} fps`;
  els.speedLabel.textContent = `${state.fps} fps`;
  restartPlayback();
});

els.resolutionSlider.min = "0";
els.resolutionSlider.max = String(resolutionPresets.length - 1);
els.resolutionSlider.value = String(state.resolutionIndex);
updateResolutionPresetLabel();
els.resolutionSlider.addEventListener("input", (event) => {
  state.resolutionIndex = Number(event.target.value);
  renderFrame();
});

els.styleSelect.value = state.styleMode;
els.styleSelect.addEventListener("change", (event) => {
  state.styleMode = event.target.value;
  updatePaletteControls();
  renderFrame();
});

loadFrames({ keepPosition: false });
state.refreshTimer = window.setInterval(loadFrames, Math.max(config.refreshSeconds, 30) * 1000);
