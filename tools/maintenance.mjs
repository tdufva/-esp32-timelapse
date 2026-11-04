import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { initMaintenance, readKeystore, requestDevice, requestMaintenance, parseFirmware, OTA_SLOT_BYTES } from './maintenance-lib.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  root: { type: 'string' }, hostname: { type: 'string', default: 'esp32cam.local' }, address: { type: 'string' }, port: { type: 'string', default: '443' },
  firmware: { type: 'string' }, 'arduino-cli': { type: 'string', default: 'arduino-cli' }, 'arduino-config': { type: 'string' },
  'day-start': { type: 'string' }, 'night-start': { type: 'string' }, 'day-interval': { type: 'string' }, 'night-interval': { type: 'string' }, 'night-enabled': { type: 'string' },
} });
const root = path.resolve(values.root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const command = positionals[0];
const print = (value) => console.log(JSON.stringify(value, null, 2));

try {
  if (command === 'init') print(initMaintenance(root, values.hostname));
  else if (command === 'request') print(await requestMaintenance(root));
  else if (command === 'build') {
    const key = readKeystore(root);
    initMaintenance(root, key.hostname);
    const embed = spawnSync(process.execPath, [path.join(root, 'tools/embed-maintenance.mjs')], { encoding: 'utf8' });
    if (embed.status !== 0) throw new Error('Huoltosivun paketointi epäonnistui.');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'esp32-ota-build-'));
    fs.chmodSync(directory, 0o700);
    const log = path.join(directory, 'build.log');
    const fd = fs.openSync(log, 'w', 0o600);
    const args = [...(values['arduino-config'] ? ['--config-file', values['arduino-config']] : []), 'compile', '--fqbn', 'esp32:esp32:esp32cam:PartitionScheme=min_spiffs', '--jobs', '4', '--build-path', path.join(directory, 'build'), path.join(root, 'esp32_timelapse')];
    const result = spawnSync(values['arduino-cli'], args, { stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    if (result.status !== 0) throw new Error(`Käännös epäonnistui. Yksityinen loki: ${log}`);
    const firmware = path.join(directory, 'build/esp32_timelapse.ino.bin');
    const parsed = parseFirmware(fs.readFileSync(firmware));
    if (parsed.bytes > OTA_SLOT_BYTES) throw new Error('Ohjelma ei mahdu OTA-ohjelmapaikkaan.');
    print({ firmware, ...parsed, privateBuild: true });
  } else if (['status', 'schedule', 'finish', 'upload'].includes(command)) {
    const key = readKeystore(root);
    const connection = { address: values.address || key.hostname, port: Number(values.port) };
    const info = await requestDevice(key, connection);
    if (command === 'status') { const { csrfToken, ...safe } = info; print(safe); }
    else if (command === 'finish') print(await requestDevice(key, { ...connection, pathname: '/api/finish', method: 'POST', csrfToken: info.csrfToken }));
    else if (command === 'schedule') {
      const schedule = { ...info.schedule };
      if (values['day-start']) schedule.dayStart = values['day-start'];
      if (values['night-start']) schedule.nightStart = values['night-start'];
      if (values['day-interval']) schedule.dayIntervalMinutes = Number(values['day-interval']);
      if (values['night-interval']) schedule.nightIntervalMinutes = Number(values['night-interval']);
      if (values['night-enabled']) {
        if (!['true', 'false'].includes(values['night-enabled'])) throw new Error('night-enabled on true tai false.');
        schedule.nightEnabled = values['night-enabled'] === 'true';
      }
      print(await requestDevice(key, { ...connection, pathname: '/api/schedule', method: 'POST', csrfToken: info.csrfToken, json: schedule }));
    } else {
      if (!values.firmware) throw new Error('--firmware puuttuu.');
      const body = fs.readFileSync(values.firmware);
      const parsed = parseFirmware(body);
      if (parsed.bytes > info.otaSlotSize) throw new Error('Ohjelma ei mahdu laitteen OTA-paikkaan.');
      const result = await requestDevice(key, { ...connection, pathname: '/api/update', method: 'POST', csrfToken: info.csrfToken, body, timeout: 180000, headers: { 'Content-Type': 'application/octet-stream', 'X-Firmware-SHA256': parsed.sha256 } });
      if (!result.updated || result.sha256 !== parsed.sha256) throw new Error('OTA-kuittauksen tiiviste ei täsmää.');
      print({ updated: true, sha256: parsed.sha256, previousBootSlot: info.bootSlot, restarting: true });
    }
  } else throw new Error('Komento: init, request, build, status, schedule, upload tai finish.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
