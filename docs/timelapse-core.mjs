export const CAMERA_TIME_ZONE = 'Europe/Helsinki';

export function dateKey(date = new Date(), timeZone = CAMERA_TIME_ZONE) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shiftDateKey(key, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '';
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function parseFrameDate(name, timeZone = CAMERA_TIME_ZONE) {
  const match = name.match(/(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(guess);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  let timestamp = guess;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let pass = 0; pass < 3; pass++) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
    const wallTime = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    timestamp += guess - wallTime;
  }
  return new Date(timestamp);
}

export function presetRange(preset, now = new Date(), timeZone = CAMERA_TIME_ZONE) {
  const end = dateKey(now, timeZone);
  if (preset === 'today') return { start: end, end };
  if (preset === 'week') return { start: shiftDateKey(end, -6), end };
  if (preset === 'month') return { start: `${end.slice(0, 7)}-01`, end };
  return { start: '', end: '' };
}

export function filterFrames(frames, { start = '', end = '' }, timeZone = CAMERA_TIME_ZONE) {
  return frames.filter((frame) => {
    if (!start && !end) return true;
    const key = dateKey(frame.date, timeZone);
    return key && (!start || key >= start) && (!end || key <= end);
  });
}

export function calendarCells(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return [];
  const first = `${month}-01`;
  const weekday = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => shiftDateKey(first, index - weekday));
}

export function cameraHealth(status, latestDate, now = new Date(), fallbackInterval = 60) {
  const interval = Math.max(1, Number(status?.captureIntervalMinutes) || fallbackInterval);
  const updated = Number(status?.updatedAt) * 1000;
  const reference = updated > 0 ? updated : latestDate?.getTime();
  if (Number.isFinite(reference) && reference > now.getTime() + 300000) return { level: 'warning', label: 'Kellonaika poikkeaa', available: Boolean(updated) };
  const stale = Number.isFinite(reference) && now.getTime() - reference > (interval * 1.75 + 5) * 60000;
  if (stale) {
    const recentImage = latestDate && now.getTime() - latestDate.getTime() <= (interval * 1.75 + 5) * 60000;
    return { level: updated && recentImage ? 'warning' : 'stale', label: updated && recentImage ? 'Tilatieto vanhentunut' : 'Kuvat viivästyneet', available: Boolean(updated) };
  }
  if (!updated) return { level: 'unknown', label: 'Ei tilatietoja', available: false };
  if (status.error || Number(status.pendingUploads) > 0 || status.sdReady === false) return { level: 'warning', label: 'Huomioitavaa', available: true };
  return { level: 'ok', label: 'Ajallaan', available: true };
}

export function normalizeStatus(value) {
  if (!value || value.schemaVersion !== 1) return null;
  const timestamp = (input) => Number.isInteger(input) && input >= 0 && input <= 0xffffffff ? input : 0;
  const bytes = (input) => Number.isSafeInteger(input) && input >= 0 ? input : null;
  return {
    schemaVersion: 1,
    updatedAt: timestamp(value.updatedAt),
    lastCaptureAt: timestamp(value.lastCaptureAt),
    lastUploadAt: timestamp(value.lastUploadAt),
    nextCaptureAt: timestamp(value.nextCaptureAt),
    captureIntervalMinutes: Number.isFinite(value.captureIntervalMinutes) && value.captureIntervalMinutes >= 1 && value.captureIntervalMinutes <= 10080 ? value.captureIntervalMinutes : 60,
    pendingUploads: Number.isSafeInteger(value.pendingUploads) && value.pendingUploads >= 0 ? value.pendingUploads : -1,
    sdReady: typeof value.sdReady === 'boolean' ? value.sdReady : null,
    sdFreeBytes: bytes(value.sdFreeBytes),
    wifiRssi: Number.isFinite(value.wifiRssi) && value.wifiRssi >= -140 && value.wifiRssi <= 0 ? value.wifiRssi : null,
    firmwareVersion: typeof value.firmwareVersion === 'string' ? value.firmwareVersion.slice(0, 40) : '',
    error: typeof value.error === 'string' ? value.error.slice(0, 300) : '',
  };
}
