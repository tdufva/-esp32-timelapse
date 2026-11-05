const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8000';
const output = process.env.TEST_OUTPUT_DIR || path.join(os.tmpdir(), 'esp32-timelapse-editor-qa');
const favorite = ['#244d37', '#fff1ad', '#f28f77'];

async function pixels(page) {
  await page.waitForFunction(() => document.querySelector('#frameCanvas').getAttribute('aria-busy') === 'false');
  return page.locator('#frameCanvas').evaluate((canvas) => {
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const colors = new Set();
    let hash = 0, gray = true;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const rgb = r << 16 | g << 8 | b;
      if (colors.size < 64) colors.add('#' + rgb.toString(16).padStart(6, '0'));
      if (r !== g || r !== b) gray = false;
      hash = Math.imul(hash ^ rgb, 16777619);
    }
    return { width, height, hash, gray, colors: [...colors].sort() };
  });
}

async function fixture(page) {
  const images = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    return Array.from({ length: 7 }, (_, i) => {
      const gradient = ctx.createLinearGradient(0, 0, 320, 240);
      gradient.addColorStop(0, i % 2 ? '#576654' : '#293d34');
      gradient.addColorStop(0.48, i % 2 ? '#91b490' : '#576d51');
      gradient.addColorStop(1, i % 2 ? '#ede0ae' : '#bdad83');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = '#c67965';
      ctx.fillRect(38 + i * 23, 78, 60, 103);
      ctx.fillStyle = '#648baf';
      ctx.fillRect(18 + i * 12, 24, 47, 57);
      return canvas.toDataURL('image/png').split(',')[1];
    });
  });
  const names = images.map((_, i) => `esp32cam_20261105_0${i + 1}0000.jpg`);
  await page.route('https://api.github.com/**', (route) => route.fulfill({ json: { tree: names.map((name) => ({ type: 'blob', path: 'photos/' + name, sha: name })) } }));
  await page.route('https://raw.githubusercontent.com/**', (route) => {
    const i = names.indexOf(new URL(route.request().url()).pathname.split('/').at(-1));
    return route.fulfill({ body: Buffer.from(images[i], 'base64'), contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  return names;
}

async function setRange(page, id, value) {
  await page.locator('#' + id).evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
}

async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#frameCanvas').width === 128 && document.querySelector('#frameCount').textContent === '7 kuvaa');
  if (await page.locator('#playToggle').evaluate((el) => el.classList.contains('is-playing'))) await page.locator('#playToggle').click();
}

async function selectFrame(page, names, index) {
  await setRange(page, 'frameSlider', index);
  await page.waitForFunction((name) => document.querySelector('#currentName').textContent === name, names[index]);
}

async function download(page, format, aspect, filename) {
  await page.locator('#exportFormat').selectOption(format);
  await page.locator('#exportAspect').selectOption(aspect);
  const pending = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('#exportStart').click();
  await (await pending).saveAs(filename);
  await page.waitForFunction(() => !document.querySelector('#exportStart').disabled);
  return fs.readFileSync(filename);
}

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'fi-FI', acceptDownloads: true });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const names = await fixture(page);
      await page.goto(base);
      await ready(page);
      await selectFrame(page, names, 3);
      await page.locator('[data-palette=custom]').click();
      await page.locator('#customCount').fill('4');
      await page.locator('#customCount').dispatchEvent('change');
      assert.equal(await page.locator('#customColors input').count(), 4);
      await page.locator('#customCount').fill('3');
      await page.locator('#customCount').dispatchEvent('change');
      await page.locator('#customColors input').nth(2).fill(favorite[2]);
      await page.locator('#paletteName').fill('Metsä ja koralli');
      await page.locator('#paletteForm button').click();
      assert.equal(await page.locator('#paletteMessage').textContent(), 'Paletti tallennettu.');
      await page.reload();
      await ready(page);
      await selectFrame(page, names, 3);
      await page.locator('[data-palette=custom]').click();
      await page.locator('#favoritePalettes').selectOption({ label: 'Metsä ja koralli' });
      assert.deepEqual(await page.locator('#customColors input').evaluateAll((inputs) => inputs.map((input) => input.value)), favorite);
      assert((await pixels(page)).colors.every((color) => favorite.includes(color)));

      await page.locator('[data-palette=duo]').click();
      await page.locator('#duoPreset').selectOption('peach');
      await page.locator('#duoLight').fill('#e9bca1');
      assert.equal(await page.locator('#duoPreset').inputValue(), 'custom');
      await page.getByText('Painojälki', { exact: true }).click();
      const plain = await pixels(page);
      await setRange(page, 'dither', 90);
      const dither = await pixels(page);
      assert.notEqual(dither.hash, plain.hash);
      await page.locator('#texture').selectOption('riso');
      const riso = await pixels(page);
      assert.notEqual(riso.hash, dither.hash);
      await page.locator('#texture').selectOption('halftone');
      const dots = await pixels(page);
      assert.notEqual(dots.hash, riso.hash);
      assert.deepEqual(dots.colors, ['#244d37', '#e9bca1']);
      await selectFrame(page, names, 4);
      await selectFrame(page, names, 3);
      assert.equal((await pixels(page)).hash, dots.hash);

      await page.locator('[data-palette=original]').click();
      assert(await page.locator('#dither').isDisabled());
      await page.locator('#resetEffects').click();
      await page.getByText('Valotus', { exact: true }).click();
      let previous = await pixels(page);
      for (const [id, value] of [['brightness', 20], ['contrast', 30], ['saturation', -100], ['warmth', 80]]) {
        await setRange(page, id, value);
        const current = await pixels(page);
        assert.notEqual(current.hash, previous.hash, id);
        if (id === 'saturation') assert(current.gray);
        if (id === 'warmth') assert(!current.gray);
        previous = current;
      }
      await page.locator('#resetEffects').click();
      await page.getByText('Liike', { exact: true }).click();
      const still = await pixels(page);
      await setRange(page, 'deflicker', 100);
      assert.notEqual((await pixels(page)).hash, still.hash);
      await setRange(page, 'deflicker', 0);
      await setRange(page, 'trails', 75);
      assert.notEqual((await pixels(page)).hash, still.hash);
      await selectFrame(page, names, 0);
      const first = await pixels(page);
      await setRange(page, 'trails', 0);
      assert.equal((await pixels(page)).hash, first.hash);

      await page.getByText('Rajaus ja kääntö', { exact: true }).click();
      await page.locator('#rotation').selectOption('90');
      assert.deepEqual(await page.locator('#frameCanvas').evaluate((canvas) => [canvas.width, canvas.height]), [96, 128]);
      await page.locator('#aspect').selectOption('portrait');
      assert.deepEqual(await page.locator('#frameCanvas').evaluate((canvas) => [canvas.width, canvas.height]), [72, 128]);
      const centered = await pixels(page);
      await setRange(page, 'zoom', 170);
      const zoomed = await pixels(page);
      assert.notEqual(zoomed.hash, centered.hash);
      await setRange(page, 'panX', 100);
      await setRange(page, 'panY', -65);
      assert.notEqual((await pixels(page)).hash, zoomed.hash);

      await page.locator('[data-palette=custom]').click();
      await setRange(page, 'dither', 55);
      await page.locator('#texture').selectOption('riso');
      await setRange(page, 'deflicker', 65);
      await setRange(page, 'trails', 55);
      await selectFrame(page, names, 3);
      if (width === 1280) {
        await page.locator('#exportOpen').click();
        assert.equal(await page.locator('#exportAspect').inputValue(), 'portrait');
        for (const [aspect, dimensions] of [['portrait', [360, 640]], ['square', [640, 640]], ['landscape', [640, 360]]]) {
          const gif = await download(page, 'gif', aspect, path.join(output, aspect + '.gif'));
          assert.equal(gif.subarray(0, 6).toString(), 'GIF89a');
          assert.deepEqual([gif.readUInt16LE(6), gif.readUInt16LE(8)], dimensions);
          assert.deepEqual(Array.from({ length: favorite.length }, (_, i) => '#' + gif.subarray(13 + i * 3, 16 + i * 3).toString('hex')), favorite);
          if (aspect === 'portrait') {
            const match = await page.evaluate(async (base64) => {
              const decoder = new ImageDecoder({ data: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)), type: 'image/gif' });
              const { image } = await decoder.decode({ frameIndex: 3 });
              const preview = document.querySelector('#frameCanvas');
              const { width, height } = preview;
              const canvas = document.createElement('canvas');
              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext('2d');
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(image, 0, 0, width, height);
              image.close();
              decoder.close();
              const expected = preview.getContext('2d').getImageData(0, 0, width, height).data;
              return ctx.getImageData(0, 0, width, height).data.every((value, i) => value === expected[i]);
            }, gif.toString('base64'));
            assert(match, 'Exported GIF pixels should match preview');
          }
        }
        const mp4 = await download(page, 'mp4', 'portrait', path.join(output, 'portrait.mp4'));
        const dimensions = await page.evaluate(async (base64) => {
          const { Input, BlobSource, ALL_FORMATS } = await import('/vendor/mediabunny.mjs');
          const input = new Input({ source: new BlobSource(new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))])), formats: ALL_FORMATS });
          const track = await input.getPrimaryVideoTrack();
          const result = [await track.getDisplayWidth(), await track.getDisplayHeight()];
          input.dispose();
          return result;
        }, mp4.toString('base64'));
        assert.deepEqual(dimensions, [360, 640]);
        await page.locator('#exportClose').click();
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(output, 'editor-' + width + '.png'), fullPage: true });
      await page.locator('#deletePalette').click();
      assert.equal(await page.locator('#paletteMessage').textContent(), 'Paletti poistettu.');
      assert(await page.locator('#favoritePalettes').isDisabled());
      assert.deepEqual(errors, []);
      console.log(`Editor ${width}px: favorites, two inks, print, tone, motion and crop passed${width === 1280 ? '; GIF/MP4 dimensions passed' : ''}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
run().catch((error) => { console.error(error.stack); process.exitCode = 1; });
