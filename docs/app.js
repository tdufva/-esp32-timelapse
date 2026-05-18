const config = {
  owner: "your-github-user",
  repo: "esp32-timelapse",
  branch: "main",
  photoPath: "photos",
  frameRate: 8,
  refreshSeconds: 300,
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
  frameImage: document.querySelector("#frameImage"),
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

function renderFrame() {
  const frame = state.frames[state.index];
  if (!frame) {
    els.frameImage.removeAttribute("src");
    els.frameImage.style.display = "none";
    els.emptyState.style.display = "grid";
    updateStats();
    return;
  }

  els.emptyState.style.display = "none";
  els.frameImage.style.display = "block";
  if (els.frameImage.src !== frame.url) {
    els.frameImage.src = frame.url;
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
