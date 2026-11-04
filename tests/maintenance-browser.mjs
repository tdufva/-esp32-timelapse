import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderMaintenanceHtml } from '../tools/embed-maintenance.mjs';
import { readKeystore, OTA_FAMILY } from '../tools/maintenance-lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.TEST_OUTPUT_DIR || '/tmp/esp32-maintenance-qa';
const key = readKeystore(root);
const image = Buffer.alloc(512);
image[0] = 0xe9; image.writeUInt32LE(0xabcd5432, 32); image.write(OTA_FAMILY, 300);
const expectedElf = image.subarray(176, 208).toString('hex');
const photo = fs.readdirSync(path.join(root, 'photos')).find((name) => name.endsWith('.jpg'));
const schedule = { dayStart: '07:00', nightStart: '22:00', dayIntervalMinutes: 60, nightIntervalMinutes: 180, nightEnabled: true };
let info = { firmwareVersion: '3.0.0', family: OTA_FAMILY, bootSlot: 'app0', elfSha256: '1'.repeat(64), otaSlotSize: 1966080, csrfToken: 'test-nonce', endsAt: Date.now() / 1000 + 600, nextCaptureAt: Date.now() / 1000 + 3600, lastCaptureAt: Date.now() / 1000, lastCapturedFile: photo, schedule };
const server = https.createServer({ key: key.privateKeyPem, cert: key.certificatePem }, async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const reply = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url === '/') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'nonce-test-nonce'; style-src 'nonce-test-nonce'; img-src 'self'; connect-src 'self'; base-uri 'none'");
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(renderMaintenanceHtml().replaceAll('__NONCE__', 'test-nonce'));
  }
  if (req.url.startsWith('/api/photo')) { res.setHeader('Content-Type', 'image/jpeg'); return res.end(fs.readFileSync(path.join(root, 'photos', photo))); }
  if (req.url === '/api/info') return reply(info);
  if (req.headers['x-csrf-token'] !== info.csrfToken) return reply({ error: 'csrf_rejected' }, 403);
  if (req.url === '/api/schedule') {
    const value = JSON.parse(body.toString());
    if (value.dayStart === value.nightStart) return reply({ error: 'invalid_schedule' }, 400);
    info.schedule = value;
    return reply({ schedule: value, nextCaptureAt: info.nextCaptureAt });
  }
  if (req.url === '/api/update') {
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    assert.equal(req.headers['x-firmware-sha256'], sha256);
    assert.deepEqual(body, image);
    info.bootSlot = 'app1'; info.elfSha256 = expectedElf;
    return reply({ updated: true, sha256 });
  }
  if (req.url === '/api/finish') return reply({ finished: true, nextCaptureAt: info.nextCaptureAt });
  reply({ error: 'not_found' }, 404);
});
let browser;
try {
  fs.mkdirSync(output, { recursive: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true });
  for (const width of [1280, 390, 320]) {
    info = { ...info, bootSlot: 'app0', elfSha256: '1'.repeat(64), schedule: { ...schedule } };
    const page = await browser.newPage({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true, timezoneId: 'Europe/Helsinki' });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`https://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.querySelector('#firmware').textContent === '3.0.0');
    assert.equal(await page.locator('#dayStart').inputValue(), '07:00');
    await page.locator('#nightEnabled').uncheck();
    assert(await page.locator('#nightInterval').isDisabled());
    await page.locator('#scheduleForm button').click();
    await page.waitForFunction(() => document.querySelector('#scheduleMessage').textContent.startsWith('Tallennettu'));
    assert.equal(info.schedule.nightEnabled, false);
    await page.locator('#nightStart').fill('07:00');
    await page.locator('#scheduleForm button').click();
    await page.waitForFunction(() => document.querySelector('#scheduleMessage').textContent.includes('Tarkista'));
    await page.locator('#nightStart').fill('22:00');
    await page.locator('#nightEnabled').check();
    await page.locator('#scheduleForm button').click();
    await page.locator('#firmwareFile').setInputFiles({ name: 'wrong.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(512) });
    await page.waitForFunction(() => document.querySelector('#updateMessage').textContent.includes('ei ole tämän'));
    assert(await page.locator('#upload').isDisabled());
    await page.locator('#firmwareFile').setInputFiles({ name: 'timelapse.bin', mimeType: 'application/octet-stream', buffer: image });
    await page.waitForFunction(() => !document.querySelector('#upload').disabled);
    await page.locator('#upload').click();
    await page.waitForFunction(() => document.querySelector('#updateMessage').textContent === 'Päivitys valmis');
    assert.equal(await page.locator('#slot').textContent(), 'app1');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert(await page.locator('#photo').evaluate((img) => img.complete && img.naturalWidth > 0));
    await page.screenshot({ path: path.join(output, `maintenance-${width}.png`), fullPage: true });
    await page.locator('#finish').click();
    await page.waitForFunction(() => document.querySelector('#sessionState').textContent === 'Päättynyt');
    assert(await page.locator('#firmwareFile').isDisabled());
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`HTTPS maintenance UI ${width}px: schedule, validation, OTA confirmation, finish passed`);
  }
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
