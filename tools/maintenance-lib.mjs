import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

export const OTA_FAMILY = 'ESP32_TIMELAPSE_OTA_V3';
export const OTA_SLOT_BYTES = 1966080;

export function parseFirmware(data) {
  const buffer = Buffer.from(data);
  if (buffer.length < 288 || buffer.length > OTA_SLOT_BYTES || buffer[0] !== 0xe9 || buffer.readUInt16LE(12) !== 0 || buffer.readUInt32LE(32) !== 0xabcd5432 || !buffer.includes(Buffer.from(OTA_FAMILY))) throw new Error('Tiedosto ei ole tämän ESP32-CAMin OTA-ohjelma.');
  return { bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), elfSha256: buffer.subarray(176, 208).toString('hex') };
}

export function validLocalAddress(address, hostname) {
  if (address === hostname) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254;
  }
  return false;
}

export function readKeystore(root) {
  const file = path.join(root, '.secrets/maintenance.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (stored.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9-]{0,40}\.local$/.test(stored.hostname) || !/^[A-Za-z0-9_-]{1,32}$/.test(stored.username) || !/^[A-Za-z0-9_-]{32,96}$/.test(stored.password)) throw new Error('Huollon paikallinen asetustiedosto on virheellinen.');
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077)) throw new Error('Huollon asetustiedoston oikeuksien tulee olla 600.');
  const certificate = new crypto.X509Certificate(stored.certificatePem);
  const key = crypto.createPrivateKey(stored.privateKeyPem);
  if (!certificate.checkHost(stored.hostname) || !certificate.checkPrivateKey(key)) throw new Error('Huoltovarmenteen ja avaimen tarkistus epäonnistui.');
  return { ...stored, certificatePem: certificate.toString(), privateKeyPem: key.export({ type: 'pkcs8', format: 'pem' }), fingerprint: certificate.fingerprint256 };
}

export function initMaintenance(root, hostname = 'esp32cam.local') {
  if (!/^[a-z0-9][a-z0-9-]{0,40}\.local$/.test(hostname)) throw new Error('Virheellinen .local-laitenimi.');
  const directory = path.join(root, '.secrets');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'maintenance.json');
  if (!fs.existsSync(file)) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'esp32-maint-cert-'));
    fs.chmodSync(temporary, 0o700);
    try {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      const keyPath = path.join(temporary, 'key.pem');
      const certPath = path.join(temporary, 'cert.pem');
      const configPath = path.join(temporary, 'openssl.cnf');
      fs.writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
      fs.writeFileSync(configPath, `[req]\ndistinguished_name=dn\nx509_extensions=server\nprompt=no\n[dn]\nCN=${hostname}\n[server]\nsubjectAltName=DNS:${hostname}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`);
      const result = spawnSync('openssl', ['req', '-new', '-x509', '-sha256', '-days', '3650', '-key', keyPath, '-out', certPath, '-config', configPath], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('Paikallisen TLS-varmenteen luominen epäonnistui.');
      const stored = { schemaVersion: 1, hostname, username: 'admin', password: crypto.randomBytes(32).toString('base64url'), certificatePem: fs.readFileSync(certPath, 'utf8'), privateKeyPem };
      fs.writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  const stored = readKeystore(root);
  if (stored.hostname !== hostname) throw new Error('Olemassa olevaa huoltotunnusta ei korvata toiselle laitenimelle.');
  const header = `// Private generated file. Never commit or publish firmware binaries.\n#pragma once\n#define MAINT_USER ${JSON.stringify(stored.username)}\n#define MAINT_PASSWORD ${JSON.stringify(stored.password)}\n#define MAINT_HOSTNAME ${JSON.stringify(stored.hostname)}\n#define MAINT_CERT_PEM R"MAINTCERT(${stored.certificatePem})MAINTCERT"\n#define MAINT_KEY_PEM R"MAINTKEY(${stored.privateKeyPem})MAINTKEY"\n`;
  fs.writeFileSync(path.join(root, 'esp32_timelapse/maintenance_secrets.h'), header, { mode: 0o600 });
  fs.chmodSync(path.join(root, 'esp32_timelapse/maintenance_secrets.h'), 0o600);
  const loginFile = path.join(directory, 'maintenance-login.txt');
  fs.writeFileSync(loginFile, `ESP32-CAM HTTPS-huolto\nOsoite: https://${stored.hostname}\nKayttaja: ${stored.username}\nSalasana: ${stored.password}\nVarmenteen SHA-256: ${stored.fingerprint}\n\nTama tiedosto on yksityinen. Ala julkaise sita tai ohjelman .bin-tiedostoa.\n`, { mode: 0o600 });
  return { hostname: stored.hostname, credentialsFile: loginFile, certificateFingerprint: stored.fingerprint };
}

export function requestDevice(keystore, { address = keystore.hostname, port = 443, pathname = '/api/info', method = 'GET', json, body, csrfToken, headers = {}, timeout = 20000 } = {}) {
  if (!validLocalAddress(address, keystore.hostname) || !Number.isInteger(Number(port)) || port < 1 || port > 65535 || !pathname.startsWith('/api/')) throw new Error('Huoltoyhteys on rajattu laitteen lähiverkko-osoitteeseen.');
  const payload = json === undefined ? body : Buffer.from(JSON.stringify(json));
  const fingerprint = new crypto.X509Certificate(keystore.certificatePem).fingerprint256;
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: address, servername: keystore.hostname, port, path: pathname, method, ca: keystore.certificatePem, agent: false, signal: AbortSignal.timeout(timeout),
      checkServerIdentity: (host, certificate) => {
        const error = tls.checkServerIdentity(keystore.hostname, certificate);
        if (error) return error;
        if (certificate.fingerprint256 !== fingerprint) return new Error('Huoltovarmenteen sormenjälki ei täsmää.');
      },
      headers: { Host: keystore.hostname, Authorization: `Basic ${Buffer.from(`${keystore.username}:${keystore.password}`).toString('base64')}`, ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...(payload ? { 'Content-Length': payload.length } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...headers },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > 65536) request.destroy(new Error('Liian suuri huoltovastaus.')); else chunks.push(chunk); });
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode < 200 || response.statusCode >= 300) reject(new Error(`Huoltopalvelu HTTP ${response.statusCode}: ${String(result.error || 'request_failed')}`));
          else resolve(result);
        } catch { reject(new Error('Huoltopalvelun vastaus ei ole JSON-muodossa.')); }
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('Huoltoyhteys aikakatkaistiin.')));
    request.on('error', reject);
    request.end(payload);
  });
}

export async function requestMaintenance(root) {
  const config = fs.readFileSync(path.join(root, 'esp32_timelapse/config.h'), 'utf8');
  const literal = (name) => config.match(new RegExp(`^\\s*#define\\s+${name}\\s+"([A-Za-z0-9_./-]+)"\\s*(?://[^\\n]*)?$`, 'm'))?.[1];
  const token = literal('GITHUB_TOKEN'), owner = literal('GITHUB_OWNER'), repo = literal('GITHUB_REPO'), branch = literal('GITHUB_BRANCH'), camera = literal('CAMERA_NAME');
  if (!token?.startsWith('github_pat_') || !owner || !repo || !branch || !camera || !/^[A-Za-z0-9_-]+$/.test(camera)) throw new Error('GitHubin paikalliset asetukset puuttuvat tai ovat virheelliset.');
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/control/${camera}.json`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'esp32-timelapse-maintenance', 'X-GitHub-Api-Version': '2022-11-28' };
  const previous = await fetch(`https://api.github.com${apiPath}?ref=${encodeURIComponent(branch)}`, { headers, signal: AbortSignal.timeout(30000) });
  if (!previous.ok && previous.status !== 404) throw new Error(`Huoltopyynnön luku epäonnistui: HTTP ${previous.status}`);
  const sha = previous.ok ? (await previous.json()).sha : undefined;
  const control = { schemaVersion: 1, requestId: crypto.randomUUID(), expiresAt: Math.floor(Date.now() / 1000) + 86400 };
  const response = await fetch(`https://api.github.com${apiPath}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000), body: JSON.stringify({ message: 'Request temporary camera maintenance', branch, sha, content: Buffer.from(JSON.stringify(control) + '\n').toString('base64') }) });
  if (!response.ok) throw new Error(`Huoltopyyntö epäonnistui: HTTP ${response.status}`);
  return { requested: true, requestId: control.requestId, expiresAt: control.expiresAt };
}
