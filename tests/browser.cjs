const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8000';
const outputDir = process.env.TEST_OUTPUT_DIR || path.join(require('node:os').tmpdir(), 'esp32-timelapse-qa');
const root = path.resolve(__dirname, '..');
const names = fs.readdirSync(path.join(root, 'photos')).filter((name) => /\.jpg$/.test(name));
const now = new Date('2026-11-04T10:30:00Z');
const status = { schemaVersion: 1, camera: 'esp32cam', firmwareVersion: '3.0.0', updatedAt: +now / 1000, lastCaptureAt: +now / 1000, lastUploadAt: +now / 1000, nextCaptureAt: +now / 1000 + 3600, captureIntervalMinutes: 60, pendingUploads: 0, sdReady: true, sdFreeBytes: 30 * 1024 ** 3, wifiRssi: -55, error: '', schedule: { dayStart: '07:00', nightStart: '22:00', dayIntervalMinutes: 60, nightIntervalMinutes: 180, nightEnabled: true }, maintenance: { configured: true, active: false, hostname: 'esp32cam.local', endsAt: 0 } };
const tree = names.map((name) => ({ type: 'blob', path: `photos/${name}`, sha: name, size: fs.statSync(path.join(root, 'photos', name)).size }));
const day3Count = names.filter((name) => name.includes('_20261103_')).length;
const day4Count = names.filter((name) => name.includes('_20261104_')).length;

async function stats(page) {
  return page.locator('#frameCanvas').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0, hash = 0;
    for (let i = 0; i < data.length; i += 4) { if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) colored++; hash = Math.imul(hash ^ data[i], 16777619); hash = Math.imul(hash ^ data[i + 1], 16777619); hash = Math.imul(hash ^ data[i + 2], 16777619); }
    return { width: canvas.width, height: canvas.height, colored, hash };
  });
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = [];
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
      const context = await browser.newContext({ viewport, timezoneId: 'America/New_York', acceptDownloads: true });
      const page = await context.newPage();
      const errors = [];
      let includeStatus = true;
      let apiFails = false;
      page.on('pageerror', (error) => errors.push(error.message));
      await page.clock.setFixedTime(now);
      await page.route('https://api.github.com/**', (route) => route.fulfill({ status: apiFails ? 403 : 200, contentType: 'application/json', body: JSON.stringify({ tree: includeStatus ? [...tree, { type: 'blob', path: 'status/esp32cam.json', sha: 'status-fixture' }] : tree }) }));
      await page.route('https://raw.githubusercontent.com/**', (route) => {
        if (route.request().url().includes('/status/')) return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(status) });
        const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
        return route.fulfill({ path: path.join(root, 'photos', name), contentType: 'image/jpeg', headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=3600' } });
      });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((count) => parseInt(document.querySelector('#frameCount').textContent, 10) === count && document.querySelector('#frameCanvas').width === 128, names.length);
      await page.waitForTimeout(500);
      if (await page.locator('#playToggle').evaluate((el) => el.classList.contains('is-playing'))) await page.locator('#playToggle').click();
      assert.equal(await page.locator('#cameraHealth').textContent(), 'Ajallaan');
      assert.equal(await page.locator('#cameraPending').textContent(), '0 kuvaa');
      assert.equal(await page.locator('#cameraFirmware').textContent(), '3.0.0');
      assert.equal(await page.locator('#scheduleDayHours').textContent(), '07:00–22:00');
      assert.equal(await page.locator('#scheduleNight').textContent(), '3 h välein');
      assert(await page.locator('#maintenanceLink').isHidden());
      assert(await page.locator('svg[data-lucide]').count() >= 10);
      const reference = names.filter((name) => name.includes('_20261104_')).sort().indexOf('esp32cam_20261104_102521.jpg');
      if (reference >= 0) {
        await page.locator('[data-range="today"]').click();
        await page.locator('#frameSlider').evaluate((el, index) => { el.value = index; el.dispatchEvent(new Event('input')); }, reference);
        await page.waitForFunction(() => document.querySelector('#currentName').textContent === 'esp32cam_20261104_102521.jpg');
      }
      const styles = {};
      for (const style of ['minimal', 'nature', 'cinematic', 'mono']) {
        await page.locator('#styleSelect').selectOption(style);
        await page.waitForTimeout(50);
        styles[style] = await stats(page);
      }
      assert.equal(styles.mono.colored, 0);
      assert.equal(new Set(Object.values(styles).map((value) => value.hash)).size, 4, JSON.stringify(styles));
      for (const mode of ['8', '16']) {
        await page.locator(`[data-palette="${mode}"]`).click();
        await page.waitForTimeout(60);
        const result = await page.locator('#frameCanvas').evaluate(async (canvas, mode) => {
          const { paletteColors } = await import('/palettes.mjs');
          const palette = new Set(paletteColors('mono', mode).map((rgb) => rgb.join(',')));
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          const colors = new Set();
          for (let i = 0; i < pixels.length; i += 4) colors.add(Array.from(pixels.slice(i, i + 3)).join(','));
          return { count: colors.size, matches: [...colors].every((rgb) => palette.has(rgb)) };
        }, mode);
        assert(result.matches);
        assert(result.count <= Number(mode));
        assert.equal(await page.locator('#palettePreview span').count(), Number(mode));
      }
      await page.locator('#resolutionSlider').evaluate((el) => { el.value = '0'; el.dispatchEvent(new Event('input')); });
      await page.waitForTimeout(50);
      const minimum = await stats(page);
      assert.equal(minimum.width * minimum.height, 24);
      await page.locator('#resolutionSlider').evaluate((el) => { el.value = '8'; el.dispatchEvent(new Event('input')); });
      await page.waitForTimeout(50);
      assert.equal((await stats(page)).width, 320);
      await page.locator('[data-range="today"]').click();
      assert.equal(await page.locator('#frameCount').textContent(), `${day4Count} kuvaa`);
      await page.locator('[data-date="2026-11-03"]').click();
      assert.equal(await page.locator('#frameCount').textContent(), `${day3Count} kuvaa`);
      await page.locator('#rangeStart').fill('2026-11-05');
      await page.locator('#rangeStart').dispatchEvent('change');
      assert(await page.locator('#rangeError').isVisible());
      assert.equal(await page.locator('#frameCount').textContent(), '0 kuvaa');
      assert(await page.locator('#exportOpen').isDisabled());
      await page.locator('[data-range="all"]').click();
      await page.locator('#monthPrev').click();
      assert.equal(await page.locator('#calendarMonth').inputValue(), '2026-10');
      await page.locator('#monthNext').click();
      await page.locator('[data-date="2026-11-04"]').click();
      assert.equal(await page.locator('#frameCount').textContent(), `${day4Count} kuvaa`);
      await page.locator('.thumbnail').first().click();
      await page.waitForFunction(() => document.querySelector('#currentName').textContent.includes('_20261104_'));
      await page.locator('#styleSelect').selectOption('minimal');
      await page.locator('#resolutionSlider').evaluate((el) => { el.value = '5'; el.dispatchEvent(new Event('input')); });
      await page.locator('#playToggle').click();
      const played = new Set();
      for (let sample = 0; sample < 10; sample++) { await page.waitForTimeout(80); played.add(await page.locator('#currentName').textContent()); }
      assert(played.size >= 2);
      await page.locator('#playToggle').click();

      const downloads = [];
      if (viewport.width !== 320) {
        await page.locator('#exportOpen').click();
        for (const format of ['mp4', 'gif']) {
          await page.locator('#exportFormat').selectOption(format);
          if (format === 'gif') {
            await page.route('**/vendor/gifenc.mjs', async (route) => { await new Promise((resolve) => setTimeout(resolve, 900)); await route.continue(); });
            await page.locator('#exportStart').click();
            await page.locator('#exportCancel').click();
            await page.waitForFunction(() => document.querySelector('#exportMessage').textContent === 'Vienti keskeytetty');
            assert.equal(await page.locator('#exportStart').isDisabled(), false);
            await page.unroute('**/vendor/gifenc.mjs');
          }
          const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
          await page.locator('#exportStart').click();
          const download = await downloadPromise;
          const filename = path.join(outputDir, `${viewport.width}.${format}`);
          await download.saveAs(filename);
          assert(fs.statSync(filename).size > 100);
          await page.waitForFunction(() => !document.querySelector('#exportStart').disabled);
          downloads.push(filename);
          if (format === 'mp4') {
            const metadata = await page.evaluate(async (base64) => {
              const { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } = await import('/vendor/mediabunny.mjs');
              const input = new Input({ source: new BlobSource(new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))])), formats: ALL_FORMATS });
              const track = await input.getPrimaryVideoTrack();
              let count = 0;
              for await (const _ of new EncodedPacketSink(track).packets()) count++;
              const result = { duration: await input.computeDuration(), width: await track.getDisplayWidth(), height: await track.getDisplayHeight(), frames: count };
              input.dispose();
              return result;
            }, fs.readFileSync(filename).toString('base64'));
            assert.equal(metadata.frames, day4Count);
            assert.equal(metadata.width, 640);
            assert(Math.abs(metadata.duration - day4Count / 8) < 0.01);
          }
        }
        await page.locator('#exportClose').click();
      }
      status.pendingUploads = 3;
      await page.locator('#refreshFrames').click();
      await page.waitForFunction(() => document.querySelector('#cameraPending').textContent === '3 kuvaa');
      assert.equal(await page.locator('#cameraHealth').textContent(), 'Huomioitavaa');
      status.pendingUploads = 0;
      status.maintenance.active = true;
      status.maintenance.endsAt = +now / 1000 + 600;
      await page.locator('#refreshFrames').click();
      await page.waitForFunction(() => !document.querySelector('#maintenanceLink').hidden);
      assert.equal(await page.locator('#maintenanceLink').getAttribute('href'), 'https://esp32cam.local/');
      assert.equal(await page.locator('#cameraHealth').textContent(), 'Huoltotila');
      status.maintenance.active = false;
      status.maintenance.endsAt = 0;
      includeStatus = false;
      await page.locator('#refreshFrames').click();
      await page.waitForFunction(() => document.querySelector('#cameraFirmware').textContent === '—');
      assert.equal(await page.locator('#frameCount').textContent(), `${day4Count} kuvaa`);
      apiFails = true;
      await page.locator('#refreshFrames').click();
      await page.waitForFunction(() => document.querySelector('#syncState').textContent === 'Virhe');
      assert.equal(await page.locator('#frameCount').textContent(), `${day4Count} kuvaa`);
      apiFails = false;
      includeStatus = true;
      await page.locator('#refreshFrames').click();
      await page.waitForFunction(() => document.querySelector('#syncState').textContent === 'Synkassa');
      if (viewport.width === 1280) {
        await page.evaluate(() => { window.savedVideoEncoder = window.VideoEncoder; window.VideoEncoder = undefined; });
        await page.locator('#exportOpen').click();
        await page.locator('#exportFormat').selectOption('mp4');
        await page.locator('#exportStart').click();
        await page.waitForFunction(() => document.querySelector('#exportMessage').textContent.includes('GIF-vienti on käytettävissä'));
        assert.equal(await page.locator('#exportStart').isDisabled(), false);
        await page.locator('#exportClose').click();
        await page.evaluate(() => { window.VideoEncoder = window.savedVideoEncoder; delete window.savedVideoEncoder; });
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const screenshot = path.join(outputDir, `ui-${viewport.width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      assert.deepEqual(errors, []);
      report.push({ viewport, frames: await page.locator('#frameCount').textContent(), styles, minimum, played: played.size, downloads, screenshot, errors });
      await context.close();
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
