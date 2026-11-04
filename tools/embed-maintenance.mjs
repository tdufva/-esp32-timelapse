import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icons } from '../docs/vendor/lucide.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function renderMaintenanceHtml(directory = root) {
  return fs.readFileSync(path.join(directory, 'esp32_timelapse/maintenance.html'), 'utf8').replace(/<i data-icon="([A-Za-z]+)"><\/i>/g, (_, name) => {
    const icon = icons[name];
    if (!icon) throw new Error(`Missing Lucide icon: ${name}`);
    const nodes = icon.map(([tag, attributes]) => `<${tag} ${Object.entries(attributes).map(([key, value]) => `${key}="${String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`).join(' ')}/>`).join('');
    return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${nodes}</svg>`;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = renderMaintenanceHtml();
  if (html.includes(')ESP_MAINT"')) throw new Error('Reserved embedded HTML delimiter');
  const expected = `// Generated from maintenance.html by tools/embed-maintenance.mjs.\n#pragma once\nstatic const char MAINTENANCE_PAGE[] PROGMEM = R"ESP_MAINT(${html})ESP_MAINT";\n`;
  const destination = path.join(root, 'esp32_timelapse/maintenance_page.h');
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== expected) throw new Error('maintenance_page.h is out of date');
  } else fs.writeFileSync(destination, expected);
}
