import { calendarCells, cameraHealth, dateKey, presetRange, shiftDateKey, normalizeStatus, CAMERA_TIME_ZONE } from './timelapse-core.mjs';
import { exportTimelapse } from './export.mjs';

const errorLabels = {
  sd_unavailable: 'Muistikortti ei ole käytettävissä', camera_init_failed: 'Kameran alustus epäonnistui',
  wifi_unavailable: 'Wi-Fi-yhteys epäonnistui', clock_unavailable: 'Kellon synkronointi epäonnistui',
  capture_failed: 'Kuvan ottaminen epäonnistui', sd_save_failed: 'Kortille tallentaminen epäonnistui',
  outbox_unavailable: 'Lähetysjono ei ole käytettävissä', outbox_write_failed: 'Lähetysjonoon kirjoittaminen epäonnistui',
  outbox_ack_failed: 'Lähetyksen kuittaus kortille epäonnistui', incomplete_photo: 'Keskeneräinen kuva ohitettu',
  remote_photo_conflict: 'Samanniminen kuva on GitHubissa eri sisältöisenä', status_save_failed: 'Tilatiedon tallentaminen kortille epäonnistui',
  remote_metadata_invalid: 'GitHubin kuvan tarkistus ei onnistunut',
};

export function createDashboard({ getFrames, getSettings, applyRange, renderExport, timeZone = CAMERA_TIME_ZONE }) {
  const $ = (id) => document.getElementById(id);
  let allFrames = [];
  let status = null;
  let statusError = '';
  let selectedRange = { start: '', end: '' };
  let exportController = null;
  let exporting = false;
  let calendarInitialized = false;
  $('calendarMonth').value = dateKey(new Date(), timeZone).slice(0, 7);

  function formatTime(seconds) {
    return Number(seconds) > 0 ? new Intl.DateTimeFormat('fi-FI', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(Number(seconds) * 1000)) : '—';
  }

  function updateHealth() {
    const latest = allFrames.filter((frame) => frame.date).at(-1)?.date;
    const health = cameraHealth(status, latest);
    $('cameraHealth').textContent = health.label;
    $('cameraHealth').dataset.level = health.level;
    $('cameraCaptured').textContent = status?.lastCaptureAt ? formatTime(status.lastCaptureAt) : latest ? formatTime(latest.getTime() / 1000) : '—';
    $('cameraUploaded').textContent = formatTime(status?.lastUploadAt);
    $('cameraPending').textContent = Number.isInteger(status?.pendingUploads) && status.pendingUploads >= 0 ? `${status.pendingUploads} kuvaa` : '—';
    $('cameraStorage').textContent = status?.sdReady === false ? 'Ei käytettävissä' : Number.isFinite(status?.sdFreeBytes) ? `${(status.sdFreeBytes / 1e9).toLocaleString('fi-FI', { maximumFractionDigits: 2 })} Gt` : '—';
    $('cameraNext').textContent = formatTime(status?.nextCaptureAt);
    $('cameraFirmware').textContent = status?.firmwareVersion || '—';
    const errors = String(status?.error || '').split(';').filter(Boolean).map((code) => errorLabels[code] || (code.startsWith('upload_http_') ? `Lähetysvirhe HTTP ${code.slice(12)}` : code)).join(' · ');
    $('cameraNote').textContent = statusError || errors || (health.available ? `Tilatieto ${formatTime(status.updatedAt)}${Number.isFinite(status.wifiRssi) ? ` · Wi-Fi ${status.wifiRssi} dBm` : ''}` : 'Odottaa kameraohjelman tilatietoja');
  }

  function updateRangeSummary() {
    $('rangeSummary').textContent = `${getFrames().length} / ${allFrames.length} kuvaa`;
  }

  function renderCalendar() {
    const counts = new Map();
    for (const frame of allFrames) {
      const key = dateKey(frame.date, timeZone);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const month = $('calendarMonth').value;
    const today = dateKey(new Date(), timeZone);
    $('calendarGrid').replaceChildren(...calendarCells(month).map((key) => {
      const button = document.createElement('button');
      const count = counts.get(key) || 0;
      button.type = 'button';
      button.dataset.date = key;
      button.className = `calendar-day${key.slice(0, 7) === month ? '' : ' outside-month'}${count ? ' has-frames' : ''}`;
      button.disabled = !count;
      button.setAttribute('aria-label', `${key.split('-').reverse().join('.')}, ${count} kuvaa`);
      button.setAttribute('aria-pressed', String(Boolean((selectedRange.start || selectedRange.end) && (!selectedRange.start || key >= selectedRange.start) && (!selectedRange.end || key <= selectedRange.end))));
      if (key === today) button.setAttribute('aria-current', 'date');
      const day = document.createElement('span');
      day.textContent = String(Number(key.slice(8)));
      const total = document.createElement('small');
      total.textContent = count ? `${count} kuvaa` : '';
      button.append(day, total);
      return button;
    }));
  }

  function selectRange(range, preset = 'custom') {
    const invalid = Boolean(range.start && range.end && range.start > range.end);
    $('rangeError').hidden = !invalid;
    $('rangeError').textContent = invalid ? 'Alkupäivä on loppupäivän jälkeen.' : '';
    $('rangeEnd').setCustomValidity(invalid ? 'Alkupäivä on loppupäivän jälkeen.' : '');
    selectedRange = range;
    $('rangeStart').value = range.start;
    $('rangeEnd').value = range.end;
    document.querySelectorAll('[data-range]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.range === preset)));
    if (range.start) $('calendarMonth').value = range.start.slice(0, 7);
    applyRange(range);
    renderCalendar();
    updateRangeSummary();
  }

  $('rangePresets').addEventListener('click', (event) => {
    const button = event.target.closest('[data-range]');
    if (button) selectRange(presetRange(button.dataset.range, new Date(), timeZone), button.dataset.range);
  });
  for (const id of ['rangeStart', 'rangeEnd']) $(id).addEventListener('change', () => selectRange({ start: $('rangeStart').value, end: $('rangeEnd').value }));
  $('calendarGrid').addEventListener('click', (event) => {
    const day = event.target.closest('[data-date]');
    if (day && !day.disabled) selectRange({ start: day.dataset.date, end: day.dataset.date });
  });
  $('calendarMonth').addEventListener('change', () => { calendarInitialized = true; renderCalendar(); });
  function moveMonth(direction) {
    calendarInitialized = true;
    const first = `${$('calendarMonth').value}-01`;
    const next = direction < 0 ? shiftDateKey(first, -1) : shiftDateKey(first, 32);
    $('calendarMonth').value = next.slice(0, 7);
    renderCalendar();
  }
  $('monthPrev').addEventListener('click', () => moveMonth(-1));
  $('monthNext').addEventListener('click', () => moveMonth(1));

  function updateExportDuration() {
    const fps = Number($('exportFps').value);
    $('exportDuration').textContent = `${getFrames().length} kuvaa · ${Number.isFinite(fps) && fps > 0 ? (getFrames().length / fps).toLocaleString('fi-FI', { maximumFractionDigits: 1 }) : '—'} s`;
  }
  $('exportFps').addEventListener('input', updateExportDuration);
  $('exportOpen').addEventListener('click', () => {
    const settings = getSettings();
    $('exportFps').value = settings.fps;
    $('exportSummary').textContent = `${settings.styleLabel} · ${settings.resolutionLabel}`;
    $('exportMessage').textContent = '';
    $('exportProgress').hidden = true;
    updateExportDuration();
    $('exportDialog').showModal();
  });
  const cancelExport = () => exportController?.abort();
  $('exportCancel').addEventListener('click', cancelExport);
  $('exportClose').addEventListener('click', () => { cancelExport(); $('exportDialog').close(); });
  $('exportDialog').addEventListener('cancel', cancelExport);
  $('exportForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (exporting || !$('exportForm').reportValidity()) return;
    exporting = true;
    exportController = new AbortController();
    const controller = exportController;
    const frames = [...getFrames()];
    const settings = { ...getSettings() };
    const format = $('exportFormat').value;
    const fps = Number($('exportFps').value);
    $('exportStart').disabled = true;
    $('exportFormat').disabled = true;
    $('exportFps').disabled = true;
    $('exportCancel').hidden = false;
    $('exportProgress').hidden = false;
    $('exportProgress').value = 0;
    $('exportMessage').textContent = 'Valmistellaan…';
    try {
      const blob = await exportTimelapse({ frames, fps, format, signal: controller.signal,
        render: (frame, signal) => renderExport(frame, settings, signal),
        onProgress: (progress) => {
          $('exportProgress').value = progress;
          $('exportMessage').textContent = `${Math.round(progress * 100)} %`;
        },
      });
      if (controller.signal.aborted) throw new DOMException('Keskeytetty', 'AbortError');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `timelapse-${frames[0].name.replace(/\.[^.]+$/, '')}-${settings.styleMode}.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      $('exportMessage').textContent = `Valmis · ${(blob.size / 1024).toLocaleString('fi-FI', { maximumFractionDigits: 0 })} kt`;
    } catch (error) {
      $('exportMessage').textContent = error.name === 'AbortError' ? 'Vienti keskeytetty' : `Vienti epäonnistui: ${error.message}`;
    } finally {
      exporting = false;
      exportController = null;
      $('exportStart').disabled = false;
      $('exportFormat').disabled = false;
      $('exportFps').disabled = false;
      $('exportCancel').hidden = true;
    }
  });
  renderCalendar();
  const healthTimer = window.setInterval(updateHealth, 60000);
  window.addEventListener('pagehide', () => { window.clearInterval(healthTimer); cancelExport(); }, { once: true });
  return {
    updateFrames(frames) {
      allFrames = frames;
      if (!calendarInitialized && frames.some((frame) => frame.date)) {
        $('calendarMonth').value = dateKey(frames.filter((frame) => frame.date).at(-1).date, timeZone).slice(0, 7);
        calendarInitialized = true;
      }
      renderCalendar();
      updateRangeSummary();
      updateHealth();
    },
    updateStatus(value, error = '') {
      statusError = error;
      if (!error) status = normalizeStatus(value);
      updateHealth();
    },
  };
}
