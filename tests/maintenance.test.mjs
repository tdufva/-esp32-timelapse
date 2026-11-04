import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { initMaintenance, readKeystore, requestDevice, parseFirmware, validLocalAddress, OTA_FAMILY, OTA_SLOT_BYTES } from '../tools/maintenance-lib.mjs';

test('OTA preflight rejects truncated, wrong-chip, oversized and unrelated images', () => {
  const image = Buffer.alloc(512);
  image[0] = 0xe9;
  image.writeUInt32LE(0xabcd5432, 32);
  image.write(OTA_FAMILY, 300);
  assert.equal(parseFirmware(image).bytes, 512);
  assert.equal(parseFirmware(image).sha256.length, 64);
  assert.throws(() => parseFirmware(image.subarray(0, 100)));
  assert.throws(() => parseFirmware(Buffer.alloc(OTA_SLOT_BYTES + 1)));
  const wrongChip = Buffer.from(image); wrongChip.writeUInt16LE(9, 12);
  assert.throws(() => parseFirmware(wrongChip));
  const wrongFamily = Buffer.from(image); wrongFamily.fill(0, 300);
  assert.throws(() => parseFirmware(wrongFamily));
});

test('device connections cannot target public IPs or arbitrary hostnames', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.58', '172.16.0.1', '172.31.255.254', '169.254.0.1', 'esp32cam.local']) assert(validLocalAddress(address, 'esp32cam.local'));
  for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', 'example.com', 'evil.local', '192.168.1.999', 'https://esp32cam.local']) assert(!validLocalAddress(address, 'esp32cam.local'));
});

test('maintenance deadline also bounds a stalled TLS handshake', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esp32-maint-timeout-'));
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    fs.mkdirSync(path.join(root, 'esp32_timelapse'));
    initMaintenance(root);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await assert.rejects(requestDevice(readKeystore(root), { address: '127.0.0.1', port: server.address().port, timeout: 100 }), { name: 'AbortError' });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TLS client pins the private certificate and sends authenticated CSRF-protected requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'esp32-maint-test-'));
  fs.mkdirSync(path.join(root, 'esp32_timelapse'));
  let server;
  try {
    const initial = initMaintenance(root);
    const stored = readKeystore(root);
    assert.equal(fs.statSync(path.join(root, '.secrets/maintenance.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, 'esp32_timelapse/maintenance_secrets.h')).mode & 0o777, 0o600);
    assert.equal(initMaintenance(root).certificateFingerprint, initial.certificateFingerprint);
    assert.equal(readKeystore(root).password, stored.password);
    assert.throws(() => initMaintenance(root, 'other.local'));
    server = https.createServer({ key: stored.privateKeyPem, cert: stored.certificatePem }, (req, res) => {
      assert.equal(req.headers.host, stored.hostname);
      assert.equal(req.headers.authorization, `Basic ${Buffer.from(`${stored.username}:${stored.password}`).toString('base64')}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') {
        assert.equal(req.headers['x-csrf-token'], 'test-nonce');
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => res.end(JSON.stringify({ received: JSON.parse(Buffer.concat(chunks).toString()) })));
      } else res.end(JSON.stringify({ firmwareVersion: '3.0.0', csrfToken: 'test-nonce' }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const connection = { address: '127.0.0.1', port: server.address().port };
    const info = await requestDevice(stored, connection);
    assert.equal(info.firmwareVersion, '3.0.0');
    const result = await requestDevice(stored, { ...connection, pathname: '/api/schedule', method: 'POST', csrfToken: info.csrfToken, json: { nightEnabled: false } });
    assert.deepEqual(result.received, { nightEnabled: false });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'esp32-maint-other-'));
    try {
      fs.mkdirSync(path.join(other, 'esp32_timelapse'));
      initMaintenance(other);
      await assert.rejects(requestDevice(readKeystore(other), connection));
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
