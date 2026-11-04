import test from 'node:test';
import assert from 'node:assert/strict';
import { dateKey, shiftDateKey, parseFrameDate, presetRange, filterFrames, calendarCells, cameraHealth, normalizeStatus, normalizeSchedule } from '../docs/timelapse-core.mjs';
import { exportTimelapse } from '../docs/export.mjs';

const now = new Date('2026-11-04T10:00:00Z');
const frames = ['esp32cam_unsynced_1.jpg', 'esp32cam_20261031_120000.jpg', 'esp32cam_20261103_230000.jpg', 'esp32cam_20261104_001000_abcd.jpg', 'esp32cam_20261104_110000.jpg'].map((name) => ({ name, date: parseFrameDate(name) }));

test('camera filenames use Helsinki time, including summer time and random suffixes', () => {
  assert.equal(parseFrameDate('esp32cam_20261104_001000_abcd.jpg').toISOString(), '2026-11-03T22:10:00.000Z');
  assert.equal(parseFrameDate('esp32cam_20260604_120000.jpg').toISOString(), '2026-06-04T09:00:00.000Z');
  assert.equal(parseFrameDate('esp32cam_unsynced_1.jpg'), null);
  assert.equal(parseFrameDate('esp32cam_20260230_120000.jpg'), null);
});
test('date keys and calendar arithmetic are independent of browser time zone', () => {
  assert.equal(dateKey(new Date('2026-11-03T23:00:00Z')), '2026-11-04');
  assert.equal(dateKey(null), '');
  assert.equal(shiftDateKey('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDateKey('2028-03-01', -1), '2028-02-29');
});
test('range presets include both boundary dates', () => {
  assert.deepEqual(presetRange('today', now), { start: '2026-11-04', end: '2026-11-04' });
  assert.deepEqual(presetRange('week', now), { start: '2026-10-29', end: '2026-11-04' });
  assert.deepEqual(presetRange('month', now), { start: '2026-11-01', end: '2026-11-04' });
  assert.equal(filterFrames(frames, presetRange('today', now)).length, 2);
  assert.equal(filterFrames(frames, presetRange('month', now)).length, 3);
  assert.equal(filterFrames(frames, presetRange('all', now)).length, 5);
  assert.equal(filterFrames(frames, { start: '2026-11-05', end: '2026-11-04' }).length, 0);
});
test('calendar contains a complete six-week Monday-first grid', () => {
  const cells = calendarCells('2026-11');
  assert.equal(cells.length, 42);
  assert.equal(cells[0], '2026-10-26');
  assert.equal(cells[6], '2026-11-01');
  assert.deepEqual(calendarCells('2026-99'), []);
});
test('health distinguishes missing telemetry, delayed images and queued uploads', () => {
  const updatedAt = now.getTime() / 1000;
  assert.equal(cameraHealth(null, now, now).level, 'unknown');
  assert.equal(cameraHealth(null, new Date('2026-11-03'), now).level, 'stale');
  assert.equal(cameraHealth({ updatedAt, pendingUploads: 2 }, now, now).level, 'warning');
  assert.equal(cameraHealth({ updatedAt, pendingUploads: 0, sdReady: true }, now, now).level, 'ok');
  assert.equal(cameraHealth({ updatedAt: updatedAt + 3600 }, now, now).label, 'Kellonaika poikkeaa');
  assert.equal(cameraHealth({ updatedAt: updatedAt - 7200 }, now, now).label, 'Tilatieto vanhentunut');
});
test('malformed telemetry cannot introduce invalid dates or objects into the UI', () => {
  assert.equal(normalizeStatus({ schemaVersion: 9 }), null);
  const status = normalizeStatus({ schemaVersion: 1, updatedAt: 1e30, firmwareVersion: {}, pendingUploads: '7', error: [] });
  assert.equal(status.updatedAt, 0);
  assert.equal(status.firmwareVersion, '');
  assert.equal(status.pendingUploads, -1);
  assert.equal(status.error, '');
});
test('scheduled night pauses stay healthy until the next capture is actually overdue', () => {
  const status = { updatedAt: now.getTime() / 1000 - 7200, nextCaptureAt: now.getTime() / 1000 + 3600, captureIntervalMinutes: 60, capturePeriod: 'paused' };
  assert.equal(cameraHealth(status, null, now).label, 'Yötauko');
  assert.equal(cameraHealth(status, null, new Date(now.getTime() + 7200000)).level, 'stale');
  assert.equal(cameraHealth({ ...status, nextCaptureAt: status.updatedAt + 1e9 }, null, now).level, 'stale');
});
test('schedule and maintenance telemetry are validated before building a local link', () => {
  const schedule = { dayStart: '07:00', nightStart: '22:00', dayIntervalMinutes: 60, nightIntervalMinutes: 180, nightEnabled: true };
  assert.deepEqual(normalizeSchedule(schedule), schedule);
  assert.equal(normalizeSchedule({ ...schedule, dayStart: '25:00' }), null);
  assert.equal(normalizeSchedule({ ...schedule, dayIntervalMinutes: '60' }), null);
  assert.equal(normalizeSchedule({ ...schedule, nightStart: schedule.dayStart }), null);
  const status = normalizeStatus({ schemaVersion: 1, schedule, maintenance: { configured: true, active: true, hostname: 'attacker.example/' } });
  assert.equal(status.maintenance.hostname, '');
  assert.deepEqual(status.schedule, schedule);
});
test('exports reject empty ranges and invalid formats before touching the canvas', async () => {
  await assert.rejects(exportTimelapse({ frames: [], fps: 8, format: 'gif' }), /ei ole kuvia/);
  await assert.rejects(exportTimelapse({ frames, fps: 0, format: 'gif' }), /kuvanopeus/);
  await assert.rejects(exportTimelapse({ frames, fps: 8, format: 'unknown' }), /Tiedostomuoto|tiedostomuoto/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(exportTimelapse({ frames, fps: 8, format: 'gif', signal: controller.signal }), { name: 'AbortError' });
});
