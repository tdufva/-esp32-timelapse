const config = {
  owner: "your-github-user",
  repo: "esp32-timelapse",
  branch: "main",
  photoPath: "photos",
  frameRate: 8,
  refreshSeconds: 300,
  pixelWidth: 128,
  solarBrightness: 1.18,
  solarSaturation: 1.35,
  solarLevels: 5,
  ...(window.TIMELAPSE_CONFIG || {})
};

const state = {
  frames: [],
  index: 0,
  playing: true,
  fps: Number(config.frameRate) || 8,
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
  firstDate: document.querySelector("#firstDate"),
  lastDate: document.querySelector("#lastDate"),
  pathValue: document.querySelector("#pathValue"),
  currentName: document.querySelector("#currentName")
};

const renderState = {
  token: 0,
  sourceImage: new Image()
};

renderState.sourceImage.crossOrigin = "anonymous";

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
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function dateFromName(name) {
  const match = name.match(/(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

function imageFiles(items) {
  const photoPrefix = `${config.photoPath.replace(/^\/+|\/+$/g, "")}/`;

  return items
    .filter((item) => item.type === "blob" && item.path?.startsWith(photoPrefix) && /\.(jpe?g|png|webp)$/i.test(item.path))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((item) => ({
      name: item.path.split("/").pop(),
      path: item.path,
      url: rawUrl(item.path),
      size: item.size || 0,
      date: dateFromName(item.path)
    }));
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
  els.pathValue.textContent = config.photoPath;
  els.frameSlider.max = String(Math.max(total - 1, 0));
  els.frameSlider.value = String(state.index);
  els.frameSlider.disabled = total < 2;
  els.frameLabel.value = total ? `${state.index + 1} / ${total}` : "0 / 0";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function solarizePixel(red, green, blue) {
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

function colorGrade(imageData) {
  const data = imageData.data;
  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b] = solarizePixel(data[index], data[index + 1], data[index + 2]);
    data[index] = r;
    data[index + 1] = g;
    data[index + 2] = b;
  }
  return imageData;
}

function drawPixelFrame(image) {
  const ratio = image.naturalHeight / image.naturalWidth || 0.75;
  const width = clamp(Math.round(Number(config.pixelWidth) || 128), 48, 320);
  const height = Math.max(1, Math.round(width * ratio));
  const workCanvas = document.createElement("canvas");
  const workContext = workCanvas.getContext("2d", { willReadFrequently: true });
  const targetContext = els.frameCanvas.getContext("2d");

  workCanvas.width = width;
  workCanvas.height = height;
  workContext.imageSmoothingEnabled = true;
  workContext.drawImage(image, 0, 0, width, height);

  const graded = colorGrade(workContext.getImageData(0, 0, width, height));
  els.frameCanvas.width = width;
  els.frameCanvas.height = height;
  targetContext.imageSmoothingEnabled = false;
  targetContext.putImageData(graded, 0, 0);
}

async function renderFrame() {
  const frame = state.frames[state.index];
  const token = ++renderState.token;

  if (!frame) {
    els.frameCanvas.style.display = "none";
    els.emptyState.style.display = "grid";
    updateStats();
    return;
  }

  els.emptyState.style.display = "none";
  els.frameCanvas.style.display = "block";

  try {
    renderState.sourceImage.src = frame.url;
    await renderState.sourceImage.decode();
    if (token !== renderState.token) {
      return;
    }
    drawPixelFrame(renderState.sourceImage);
  } catch (error) {
    console.error(error);
    setStatus("Kuvavirhe");
  }

  updateStats();
  preloadAround(state.index);
}

function preloadAround(index) {
  for (let step = 1; step <= 3; step++) {
    const frame = state.frames[(index + step) % state.frames.length];
    if (frame) {
      const img = new Image();
      img.src = frame.url;
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
  if (!isConfigured()) {
    stopPlayback();
    setStatus("Asetukset puuttuvat");
    els.sourceLabel.textContent = "Muokkaa docs/config.js";
    renderFrame();
    return;
  }

  const previousName = state.frames[state.index]?.name;
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
    state.frames = files;

    if (keepPosition && previousName) {
      const nextIndex = state.frames.findIndex((frame) => frame.name === previousName);
      state.index = nextIndex >= 0 ? nextIndex : Math.max(state.frames.length - 1, 0);
    } else {
      state.index = Math.max(state.frames.length - 1, 0);
    }

    setStatus(payload.truncated ? "Osittainen" : files.length ? "Synkassa" : "Ei kuvia");
    renderFrame();
    restartPlayback();
  } catch (error) {
    console.error(error);
    setStatus("Virhe");
    stopPlayback();
  }
}

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
els.speedSlider.addEventListener("input", (event) => {
  state.fps = Number(event.target.value);
  els.speedLabel.value = `${state.fps} fps`;
  restartPlayback();
});

loadFrames({ keepPosition: false });
state.refreshTimer = window.setInterval(loadFrames, Math.max(config.refreshSeconds, 30) * 1000);
