import { DEFAULT_COLORS, DEFAULT_EFFECTS, DUOTONES, hexToRgb, normalizeColors } from './image-effects.mjs?v=4';
import { paletteColors } from './palettes.mjs?v=4';

const storageKey = 'esp32-timelapse:palettes:v1';
const modes = ['original', '8', '16', 'custom', 'duo'];
const percentControls = ['dither', 'ink', 'deflicker', 'trails', 'zoom'];

function readFavorites() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (!Array.isArray(value)) return [];
    return value.slice(0, 32).flatMap((item) => {
      const colors = normalizeColors(item?.colors);
      const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 40) : '';
      return name && colors ? [{ name, colors }] : [];
    });
  } catch {
    return [];
  }
}

export function createEditor({ initialPalette, getStyle, onChange }) {
  const $ = (id) => document.getElementById(id);
  const effects = { ...DEFAULT_EFFECTS };
  let paletteMode = modes.includes(initialPalette) ? initialPalette : '16';
  let custom = [...DEFAULT_COLORS];
  let duo = [...DUOTONES.cyanotype];
  let favorites = readFavorites();
  let favoriteIndex = -1;

  function currentPalette() {
    if (paletteMode === 'custom') return custom.map(hexToRgb);
    if (paletteMode === 'duo') return duo.map(hexToRgb);
    return paletteColors(getStyle(), paletteMode);
  }

  function refreshFavorites() {
    const select = $('favoritePalettes');
    select.replaceChildren(new Option('Tallennetut paletit', ''), ...favorites.map(({ name }, index) => new Option(name, String(index))));
    select.value = favoriteIndex < 0 ? '' : String(favoriteIndex);
    select.disabled = !favorites.length;
    $('deletePalette').disabled = favoriteIndex < 0;
  }

  function saveFavorites(next, index, message) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      $('paletteMessage').textContent = 'Palettia ei voitu tallentaa tähän selaimeen.';
      return;
    }
    favorites = next;
    favoriteIndex = index;
    refreshFavorites();
    $('paletteMessage').textContent = message;
  }

  function refreshSwatches() {
    $('customCount').value = custom.length;
    $('customColors').replaceChildren(...custom.map((color, index) => {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = color;
      input.dataset.color = index;
      input.setAttribute('aria-label', `Paletin väri ${index + 1}`);
      input.title = `Paletin väri ${index + 1}`;
      return input;
    }));
  }

  function refreshDuo() {
    $('duoDark').value = duo[0];
    $('duoLight').value = duo[1];
    $('duoPreset').value = Object.keys(DUOTONES).find((key) => DUOTONES[key].every((color, i) => color === duo[i])) || 'custom';
  }

  function refreshPalette() {
    $('paletteControls').querySelectorAll('[data-palette]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.palette === paletteMode)));
    $('customPalette').hidden = paletteMode !== 'custom';
    $('duoPalette').hidden = paletteMode !== 'duo';
    $('dither').disabled = paletteMode === 'original';
    const preview = $('palettePreview');
    preview.replaceChildren(...(['8', '16'].includes(paletteMode) ? currentPalette() : []).map((color) => {
      const swatch = document.createElement('span');
      swatch.style.backgroundColor = `rgb(${color.join(',')})`;
      return swatch;
    }));
    preview.style.setProperty('--palette-count', preview.children.length || 16);
    preview.hidden = !preview.children.length;
  }

  $('paletteControls').addEventListener('click', (event) => {
    const button = event.target.closest('[data-palette]');
    if (!button) return;
    paletteMode = button.dataset.palette;
    refreshPalette();
    onChange();
  });
  $('customCount').addEventListener('change', (event) => {
    const count = event.target.valueAsNumber;
    if (!Number.isInteger(count) || count < 2 || count > 16) {
      event.target.value = custom.length;
      return;
    }
    const defaults = paletteColors(getStyle(), '16');
    custom = Array.from({ length: count }, (_, i) => custom[i] ?? '#' + defaults[i].map((value) => value.toString(16).padStart(2, '0')).join(''));
    refreshSwatches();
    onChange();
  });
  $('customColors').addEventListener('input', (event) => {
    if (!event.target.matches('[data-color]')) return;
    custom[Number(event.target.dataset.color)] = event.target.value;
    $('paletteMessage').textContent = '';
    onChange();
  });
  $('favoritePalettes').addEventListener('change', (event) => {
    favoriteIndex = event.target.value === '' ? -1 : Number(event.target.value);
    const item = favorites[favoriteIndex];
    $('deletePalette').disabled = !item;
    $('paletteMessage').textContent = '';
    if (item) {
      custom = [...item.colors];
      $('paletteName').value = item.name;
      refreshSwatches();
      onChange();
    }
  });
  $('paletteForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('paletteName').value.trim();
    if (!name) {
      $('paletteMessage').textContent = 'Anna paletille nimi.';
      return;
    }
    const next = [...favorites];
    let index = next.findIndex((item) => item.name === name);
    if (index < 0) index = next.length;
    if (index >= 32) {
      $('paletteMessage').textContent = 'Tallennustila täynnä (32 palettia).';
      return;
    }
    next[index] = { name, colors: [...custom] };
    saveFavorites(next, index, 'Paletti tallennettu.');
  });
  $('deletePalette').addEventListener('click', () => {
    if (favoriteIndex >= 0) saveFavorites(favorites.filter((_, index) => index !== favoriteIndex), -1, 'Paletti poistettu.');
  });
  $('duoPreset').addEventListener('change', (event) => {
    if (!Object.hasOwn(DUOTONES, event.target.value)) return;
    duo = [...DUOTONES[event.target.value]];
    refreshDuo();
    onChange();
  });
  for (const [index, id] of ['duoDark', 'duoLight'].entries()) $(id).addEventListener('input', (event) => {
    duo[index] = event.target.value;
    $('duoPreset').value = Object.keys(DUOTONES).find((key) => DUOTONES[key].every((color, i) => color === duo[i])) || 'custom';
    onChange();
  });

  function refreshEffect(key) {
    const input = $(key);
    const output = $(key + 'Value');
    if (output) {
      const value = effects[key];
      output.value = percentControls.includes(key) ? `${value} %` : value > 0 ? `+${value}` : String(value);
    }
    if (key === 'texture') $('inkControl').hidden = input.value === 'none';
  }
  for (const key of Object.keys(effects)) {
    const input = $(key);
    input.value = effects[key];
    refreshEffect(key);
    input.addEventListener(input.type === 'range' ? 'input' : 'change', () => {
      effects[key] = typeof DEFAULT_EFFECTS[key] === 'number' ? Number(input.value) : input.value;
      refreshEffect(key);
      onChange();
    });
  }
  $('resetEffects').addEventListener('click', () => {
    for (const [key, value] of Object.entries(DEFAULT_EFFECTS)) {
      effects[key] = value;
      $(key).value = value;
      refreshEffect(key);
    }
    onChange();
  });
  refreshSwatches();
  refreshFavorites();
  refreshDuo();
  refreshPalette();
  return {
    refreshPalette,
    getSettings: () => ({
      ...effects, paletteMode, paletteColors: currentPalette(),
      paletteLabel: { original: 'Vapaa paletti', custom: `Oma (${custom.length} väriä)`, duo: 'Kaksivärinen' }[paletteMode] || `${paletteMode} väriä`,
    }),
  };
}
