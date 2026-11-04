#include <Arduino.h>
#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "FS.h"
#include "SD_MMC.h"
#include "mbedtls/base64.h"
#include "mbedtls/sha1.h"
#include "time.h"
#include "esp_sleep.h"
#include "esp_sntp.h"
#include <string.h>

#include "config.h"

// Pin map for the common AI Thinker ESP32-CAM module.
#define CAMERA_MODEL_AI_THINKER

#if defined(CAMERA_MODEL_AI_THINKER)
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22
#define LED_GPIO_NUM 4
#else
#error "Select a camera pin map before compiling."
#endif

RTC_DATA_ATTR uint32_t bootCount = 0;

#ifndef MAX_UPLOADS_PER_WAKE
#define MAX_UPLOADS_PER_WAKE 6
#endif
#ifndef UPLOAD_BUDGET_MS
#define UPLOAD_BUDGET_MS 90000UL
#endif
#ifndef GITHUB_STATUS_PATH
#define GITHUB_STATUS_PATH "status"
#endif

static const char *FIRMWARE_VERSION = "2.0.0";
static const char *OUTBOX_PATH = "/outbox";
static const char *LOCAL_STATUS_PATH = "/camera-status.json";
static String lastCapturedFile;
static String lastUploadedFile;
static uint32_t lastCaptureAt = 0;
static uint32_t lastUploadAt = 0;
static String cycleError;
static int lastHttpStatus = 0;
static volatile bool ntpSynced = false;

void onTimeSync(struct timeval *) {
  ntpSynced = true;
}

void noteError(const String &error) {
  if (cycleError.length()) cycleError += ";";
  cycleError += error;
}

static const char *GITHUB_API_HOST = "api.github.com";
static const uint16_t HTTPS_PORT = 443;

#ifndef VERIFY_GITHUB_TLS
#define VERIFY_GITHUB_TLS 1
#endif

static const char GITHUB_ROOT_CA[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIDRjCCAsugAwIBAgIQGp6v7G3o4ZtcGTFBto2Q3TAKBggqhkjOPQQDAzCBiDEL
MAkGA1UEBhMCVVMxEzARBgNVBAgTCk5ldyBKZXJzZXkxFDASBgNVBAcTC0plcnNl
eSBDaXR5MR4wHAYDVQQKExVUaGUgVVNFUlRSVVNUIE5ldHdvcmsxLjAsBgNVBAMT
JVVTRVJUcnVzdCBFQ0MgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkwHhcNMjEwMzIy
MDAwMDAwWhcNMzgwMTE4MjM1OTU5WjBfMQswCQYDVQQGEwJHQjEYMBYGA1UEChMP
U2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQDEy1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIg
QXV0aGVudGljYXRpb24gUm9vdCBFNDYwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAR2
+pmpbiDt+dd34wc7qNs9Xzjoq1WmVk/WSOrsfy2qw7LFeeyZYX8QeccCWvkEN/U0
NSt3zn8gj1KjAIns1aeibVvjS5KToID1AZTc8GgHHs3u/iVStSBDHBv+6xnOQ6Oj
ggEgMIIBHDAfBgNVHSMEGDAWgBQ64QmG1M8ZwpZ2dEl23OA1xmNjmjAdBgNVHQ4E
FgQU0SLaTFnxS18mOKqd1u7rDcP7qWEwDgYDVR0PAQH/BAQDAgGGMA8GA1UdEwEB
/wQFMAMBAf8wHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMBEGA1UdIAQK
MAgwBgYEVR0gADBQBgNVHR8ESTBHMEWgQ6BBhj9odHRwOi8vY3JsLnVzZXJ0cnVz
dC5jb20vVVNFUlRydXN0RUNDQ2VydGlmaWNhdGlvbkF1dGhvcml0eS5jcmwwNQYI
KwYBBQUHAQEEKTAnMCUGCCsGAQUFBzABhhlodHRwOi8vb2NzcC51c2VydHJ1c3Qu
Y29tMAoGCCqGSM49BAMDA2kAMGYCMQCMCyBit99vX2ba6xEkDe+YO7vC0twjbkv9
PKpqGGuZ61JZryjFsp+DFpEclCVy4noCMQCwvZDXD/m2Ko1HA5Bkmz7YQOFAiNDD
49IWa2wdT7R3DtODaSXH/BiXv8fwB9su4tU=
-----END CERTIFICATE-----
)EOF";

String jsonEscape(const String &value) {
  String escaped;
  escaped.reserve(value.length() + 8);

  for (size_t i = 0; i < value.length(); i++) {
    char c = value[i];
    switch (c) {
      case '"': escaped += "\\\""; break;
      case '\\': escaped += "\\\\"; break;
      case '\b': escaped += "\\b"; break;
      case '\f': escaped += "\\f"; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default:
        if (static_cast<uint8_t>(c) < 0x20) {
          char buffer[7];
          snprintf(buffer, sizeof(buffer), "\\u%04x", c);
          escaped += buffer;
        } else {
          escaped += c;
        }
        break;
    }
  }

  return escaped;
}

bool initCamera() {
  // A warm reset can leave the sensor streaming before the driver queues exist.
  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, HIGH);
  delay(20);

  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAME_SIZE;
  config.jpeg_quality = JPEG_QUALITY;
  config.grab_mode = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.fb_count = 2;
  } else {
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.fb_count = 1;
    if (config.frame_size > FRAMESIZE_SVGA) {
      config.frame_size = FRAMESIZE_SVGA;
    }
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }

  sensor_t *sensor = esp_camera_sensor_get();
  if (sensor && sensor->id.PID == OV3660_PID) {
    sensor->set_vflip(sensor, 1);
    sensor->set_brightness(sensor, 1);
    sensor->set_saturation(sensor, -2);
  }

#if defined(LED_GPIO_NUM)
  pinMode(LED_GPIO_NUM, OUTPUT);
  digitalWrite(LED_GPIO_NUM, LOW);
#endif

  Serial.println("Camera ready");
  return true;
}

bool initSdCard() {
  if (!SD_MMC.begin("/sdcard", true)) {
    Serial.println("SD_MMC mount failed");
    return false;
  }

  uint8_t cardType = SD_MMC.cardType();
  if (cardType == CARD_NONE) {
    Serial.println("No microSD card detected");
    return false;
  }

  if (!SD_MMC.exists(LOCAL_PHOTO_PATH)) {
    SD_MMC.mkdir(LOCAL_PHOTO_PATH);
  }

  Serial.printf("microSD ready, size: %llu MB\n", SD_MMC.cardSize() / (1024ULL * 1024ULL));
  return true;
}

bool connectWiFi() {
  if (strlen(WIFI_SSID) == 0) {
    Serial.println("WiFi SSID is empty");
    return false;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting WiFi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi connection failed; photo will stay on microSD");
    return false;
  }

  Serial.print("WiFi connected: ");
  Serial.println(WiFi.localIP());
  return true;
}

bool syncClock() {
  ntpSynced = false;
  sntp_set_time_sync_notification_cb(onTimeSync);
  configTzTime(TIMEZONE, "pool.ntp.org", "time.google.com", "time.nist.gov");

  struct tm timeinfo;
  unsigned long start = millis();
  while (millis() - start < NTP_TIMEOUT_MS) {
    if (ntpSynced && getLocalTime(&timeinfo, 100)) {
      char stamp[32];
      strftime(stamp, sizeof(stamp), "%Y-%m-%d %H:%M:%S", &timeinfo);
      Serial.print("Clock synced: ");
      Serial.println(stamp);
      return true;
    }
    delay(50);
  }

  Serial.println("NTP sync failed; using fallback filename");
  return false;
}

String makeFileName(bool hasTime) {
  struct tm timeinfo;
  if (hasTime && getLocalTime(&timeinfo, 100)) {
    char filename[80];
    strftime(filename, sizeof(filename), CAMERA_NAME "_%Y%m%d_%H%M%S.jpg", &timeinfo);
    char uniqueName[96];
    snprintf(uniqueName, sizeof(uniqueName), "%s_%04lx.jpg", String(filename).substring(0, strlen(filename) - 4).c_str(), static_cast<unsigned long>(esp_random() & 0xffff));
    return String(uniqueName);
  }

  char fallback[96];
  snprintf(
    fallback,
    sizeof(fallback),
    CAMERA_NAME "_unsynced_%lu_%08lx.jpg",
    static_cast<unsigned long>(bootCount),
    static_cast<unsigned long>(esp_random())
  );
  return String(fallback);
}

camera_fb_t *capturePhoto() {
#if defined(LED_GPIO_NUM)
  if (USE_FLASH_LED) {
    digitalWrite(LED_GPIO_NUM, HIGH);
    delay(FLASH_LED_MS);
  }
#endif

  camera_fb_t *discard = esp_camera_fb_get();
  if (discard) {
    esp_camera_fb_return(discard);
  }

  camera_fb_t *frame = esp_camera_fb_get();

#if defined(LED_GPIO_NUM)
  if (USE_FLASH_LED) {
    digitalWrite(LED_GPIO_NUM, LOW);
  }
#endif

  if (!frame) {
    Serial.println("Camera capture failed");
    return nullptr;
  }

  if (frame->format != PIXFORMAT_JPEG) {
    Serial.println("Unexpected frame format");
    esp_camera_fb_return(frame);
    return nullptr;
  }

  Serial.printf("Captured %u bytes\n", static_cast<unsigned int>(frame->len));
  return frame;
}

bool isPhotoName(const String &name) {
  return name.length() && name.indexOf('/') < 0 && (name.endsWith(".jpg") || name.endsWith(".jpeg"));
}

String entryName(File &file) {
  String name(file.name());
  return name.substring(name.lastIndexOf('/') + 1);
}

bool markPending(const String &name) {
  if (!isPhotoName(name)) return false;
  String path = String(OUTBOX_PATH) + "/" + name;
  if (SD_MMC.exists(path)) return true;
  File marker = SD_MMC.open(path, FILE_WRITE);
  if (!marker) return false;
  marker.flush();
  marker.close();
  return true;
}

void initOutbox() {
  if (!SD_MMC.exists(OUTBOX_PATH) && !SD_MMC.mkdir(OUTBOX_PATH)) {
    noteError("outbox_unavailable");
    return;
  }
  String migrated = String(OUTBOX_PATH) + "/.imported-v2";
  if (SD_MMC.exists(migrated)) return;
  bool complete = true;
  File directory = SD_MMC.open(LOCAL_PHOTO_PATH);
  if (!directory || !directory.isDirectory()) return;
  for (File entry = directory.openNextFile(); entry; entry = directory.openNextFile()) {
    String name = entryName(entry);
    if (!entry.isDirectory() && isPhotoName(name) && !markPending(name)) complete = false;
    entry.close();
  }
  directory.close();
  if (complete) {
    File marker = SD_MMC.open(migrated, FILE_WRITE);
    if (marker) { marker.flush(); marker.close(); }
  }
}

uint32_t pendingCount() {
  uint32_t count = 0;
  File directory = SD_MMC.open(OUTBOX_PATH);
  if (!directory) return count;
  for (File entry = directory.openNextFile(); entry; entry = directory.openNextFile()) {
    if (!entry.isDirectory() && isPhotoName(entryName(entry))) count++;
    entry.close();
  }
  return count;
}

String oldestPending() {
  String oldest;
  File directory = SD_MMC.open(OUTBOX_PATH);
  if (!directory) return oldest;
  for (File entry = directory.openNextFile(); entry; entry = directory.openNextFile()) {
    String name = entryName(entry);
    if (!entry.isDirectory() && isPhotoName(name) && (!oldest.length() || name < oldest)) oldest = name;
    entry.close();
  }
  return oldest;
}

bool savePhotoToSd(const String &fileName, const uint8_t *data, size_t len) {
  String path = String(LOCAL_PHOTO_PATH) + "/" + fileName;
  String temporary = path + ".part";
  if (SD_MMC.exists(path) || !markPending(fileName)) {
    noteError("outbox_write_failed");
    return false;
  }
  // The durable marker exists before the photo is committed to its final name.
  File file = SD_MMC.open(temporary, FILE_WRITE);
  if (!file) {
    Serial.print("Could not open file for writing: ");
    Serial.println(path);
    SD_MMC.remove((String(OUTBOX_PATH) + "/" + fileName).c_str());
    return false;
  }

  size_t written = file.write(data, len);
  file.flush();
  file.close();

  if (written != len || !SD_MMC.rename(temporary, path)) {
    Serial.printf("microSD write incomplete: %u/%u bytes\n", static_cast<unsigned int>(written), static_cast<unsigned int>(len));
    SD_MMC.remove(temporary);
    SD_MMC.remove((String(OUTBOX_PATH) + "/" + fileName).c_str());
    return false;
  }

  Serial.print("Saved to microSD: ");
  Serial.println(path);
  return true;
}

size_t base64Length(size_t rawLength) {
  return 4 * ((rawLength + 2) / 3);
}

bool writeBase64(WiFiClientSecure &client, const uint8_t *data, size_t len, Stream *source = nullptr) {
  const size_t inputChunk = 1536;
  const size_t encodedChunk = 4 * ((inputChunk + 2) / 3);
  uint8_t encoded[encodedChunk + 4];
  uint8_t input[inputChunk];
  size_t offset = 0;

  while (offset < len) {
    size_t chunk = min(inputChunk, len - offset);
    if (offset + chunk < len) {
      chunk -= chunk % 3;
    }

    size_t encodedLength = 0;
    const uint8_t *chunkData = data ? data + offset : input;
    if (!data && (!source || source->readBytes(input, chunk) != chunk)) return false;
    int err = mbedtls_base64_encode(encoded, sizeof(encoded), &encodedLength, chunkData, chunk);
    if (err != 0) {
      Serial.printf("Base64 encode failed: %d\n", err);
      return false;
    }

    if (client.write(encoded, encodedLength) != encodedLength) {
      Serial.println("HTTPS write failed during base64 upload");
      return false;
    }

    offset += chunk;
    delay(1);
  }

  return true;
}

bool putGitHubContent(const String &repoPath, const uint8_t *data, size_t len, bool clockReady, const String &sha = String(), Stream *source = nullptr) {
  lastHttpStatus = 0;
  if (strlen(GITHUB_TOKEN) == 0 || strcmp(GITHUB_TOKEN, "github_pat_replace_me") == 0) {
    Serial.println("GitHub token not configured; skipping upload");
    return false;
  }

#if VERIFY_GITHUB_TLS
  if (!clockReady) {
    Serial.println("Clock not synced; skipping GitHub upload because TLS validation needs correct time");
    return false;
  }
#endif

  String apiPath = String("/repos/") + GITHUB_OWNER + "/" + GITHUB_REPO + "/contents/" + repoPath;
  String message = String("Update timelapse ") + repoPath;
  String prefix = String("{\"message\":\"") + jsonEscape(message) +
                  "\",\"branch\":\"" + jsonEscape(GITHUB_BRANCH) +
                  "\"," + (sha.length() ? String("\"sha\":\"") + sha + "\"," : String()) + "\"content\":\"";
  String suffix = "\"}";
  size_t bodyLength = prefix.length() + base64Length(len) + suffix.length();

  WiFiClientSecure client;
#if VERIFY_GITHUB_TLS
  client.setCACert(GITHUB_ROOT_CA);
#else
  client.setInsecure();
#endif
  client.setTimeout(30000);
  client.setConnectionTimeout(30000);

  Serial.print("Connecting to GitHub API...");
  if (!client.connect(GITHUB_API_HOST, HTTPS_PORT)) {
    Serial.println(" failed");
    return false;
  }
  Serial.println(" connected");

  String headers = String("PUT ") + apiPath + " HTTP/1.1\r\n" +
                   "Host: " + GITHUB_API_HOST + "\r\n" +
                   "User-Agent: esp32-cam-timelapse\r\n" +
                   "Authorization: Bearer " + GITHUB_TOKEN + "\r\n" +
                   "Accept: application/vnd.github+json\r\n" +
                   "X-GitHub-Api-Version: 2022-11-28\r\n" +
                   "Content-Type: application/json\r\n" +
                   "Content-Length: " + String(bodyLength) + "\r\n" +
                   "Connection: close\r\n\r\n";

  if (client.print(headers) != headers.length() || client.print(prefix) != prefix.length()) {
    Serial.println("HTTPS write failed during request headers or JSON prefix");
    client.stop();
    return false;
  }
  headers = String();
  if (!writeBase64(client, data, len, source)) {
    client.stop();
    return false;
  }
  if (client.print(suffix) != suffix.length()) {
    Serial.println("HTTPS write failed during JSON suffix");
    client.stop();
    return false;
  }
  Serial.printf("GitHub request body sent: %u bytes\n", static_cast<unsigned int>(bodyLength));

  String statusLine = client.readStringUntil('\n');
  statusLine.trim();
  Serial.print("GitHub response: ");
  Serial.println(statusLine);
  if (statusLine.length() == 0) {
    char error[160] = {};
    int tlsError = client.lastError(error, sizeof(error));
    Serial.printf("No GitHub HTTP response; TLS error %d: %s; WiFi status %d\n", tlsError, error, WiFi.status());
    client.stop();
    return false;
  }

  int statusCode = 0;
  if (statusLine.startsWith("HTTP/")) {
    statusCode = statusLine.substring(9, 12).toInt();
  }
  lastHttpStatus = statusCode;

  while (client.connected()) {
    String header = client.readStringUntil('\n');
    if (header == "\r" || header.length() == 0) {
      break;
    }
  }

  if (statusCode == 200 || statusCode == 201) {
    Serial.print("Uploaded to GitHub: ");
    Serial.println(repoPath);
    client.stop();
    return true;
  }

  String body;
  unsigned long start = millis();
  while (millis() - start < 2000 && body.length() < 1200) {
    while (client.available() && body.length() < 1200) {
      body += static_cast<char>(client.read());
    }
    if (!client.connected()) {
      break;
    }
    delay(10);
  }
  client.stop();

  Serial.println("GitHub upload failed. Response body:");
  Serial.println(body);
  return false;
}

bool readGitHubSha(const String &repoPath, String &sha) {
  sha = String();
  WiFiClientSecure client;
#if VERIFY_GITHUB_TLS
  client.setCACert(GITHUB_ROOT_CA);
#else
  client.setInsecure();
#endif
  client.setConnectionTimeout(15000);
  client.setTimeout(15000);
  HTTPClient http;
  // ArduinoJson can parse the body stream without buffering Base64 image data.
  http.useHTTP10(true);
  http.setReuse(false);
  http.setTimeout(15000);
  String url = String("https://") + GITHUB_API_HOST + "/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO + "/contents/" + repoPath + "?ref=" + GITHUB_BRANCH;
  if (!http.begin(client, url)) return false;
  http.addHeader("Authorization", String("Bearer ") + GITHUB_TOKEN);
  http.addHeader("Accept", "application/vnd.github+json");
  http.addHeader("User-Agent", "esp32-cam-timelapse");
  int code = http.GET();
  lastHttpStatus = code;
  if (code == 404) { http.end(); return true; }
  if (code != 200) { http.end(); return false; }
  JsonDocument filter;
  filter["sha"] = true;
  JsonDocument document;
  auto error = deserializeJson(document, http.getStream(), DeserializationOption::Filter(filter));
  if (!error) sha = document["sha"].as<String>();
  http.end();
  return !error && sha.length() == 40;
}

String gitBlobSha(File &file) {
  mbedtls_sha1_context hash;
  mbedtls_sha1_init(&hash);
  mbedtls_sha1_starts(&hash);
  String header = String("blob ") + file.size();
  mbedtls_sha1_update(&hash, reinterpret_cast<const uint8_t *>(header.c_str()), header.length() + 1);
  file.seek(0);
  uint8_t buffer[1024];
  while (file.available()) {
    size_t count = file.read(buffer, sizeof(buffer));
    if (!count) { mbedtls_sha1_free(&hash); return String(); }
    mbedtls_sha1_update(&hash, buffer, count);
  }
  uint8_t digest[20];
  mbedtls_sha1_finish(&hash, digest);
  mbedtls_sha1_free(&hash);
  char hex[41];
  for (size_t i = 0; i < 20; i++) snprintf(hex + i * 2, 3, "%02x", digest[i]);
  return String(hex);
}

bool uploadPendingPhoto(const String &name, bool clockReady) {
  String marker = String(OUTBOX_PATH) + "/" + name;
  String path = String(LOCAL_PHOTO_PATH) + "/" + name;
  File photo = SD_MMC.open(path, FILE_READ);
  if (!photo || !photo.size()) {
    // A power cut during capture may leave a marker and an unfinished .part file.
    photo.close();
    SD_MMC.remove(path + ".part");
    SD_MMC.remove(marker);
    noteError("incomplete_photo");
    return true;
  }
  String repoPath = String(GITHUB_PHOTO_PATH) + "/" + name;
  bool uploaded = putGitHubContent(repoPath, nullptr, photo.size(), clockReady, String(), &photo);
  if (!uploaded && lastHttpStatus == 422) {
    String remoteSha;
    String localSha = gitBlobSha(photo);
    bool checked = localSha.length() && readGitHubSha(repoPath, remoteSha);
    uploaded = checked && remoteSha == localSha;
    if (checked && remoteSha.length() && remoteSha != localSha) {
      photo.close();
      noteError("remote_photo_conflict");
      return false;
    }
    if (uploaded) Serial.println("Identical photo already exists on GitHub");
  }
  photo.close();
  if (!uploaded) {
    noteError(String("upload_http_") + lastHttpStatus);
    return false;
  }
  // Never remove the original photo. Only acknowledge the outbox entry.
  if (!SD_MMC.remove(marker)) { noteError("outbox_ack_failed"); return false; }
  lastUploadedFile = name;
  lastUploadAt = static_cast<uint32_t>(time(nullptr));
  return true;
}

void flushOutbox(bool clockReady, const String &priorityName) {
  unsigned long started = millis();
  for (size_t attempt = 0; attempt < MAX_UPLOADS_PER_WAKE && millis() - started < UPLOAD_BUDGET_MS; attempt++) {
    String name = attempt == 0 && priorityName.length() && SD_MMC.exists(String(OUTBOX_PATH) + "/" + priorityName) ? priorityName : oldestPending();
    if (!name.length()) break;
    if (!uploadPendingPhoto(name, clockReady)) break;
  }
}

void loadLocalStatus() {
  File file = SD_MMC.open(LOCAL_STATUS_PATH, FILE_READ);
  if (!file) file = SD_MMC.open(String(LOCAL_STATUS_PATH) + ".part", FILE_READ);
  if (!file) return;
  JsonDocument document;
  if (!deserializeJson(document, file)) {
    lastCapturedFile = document["lastCapturedFile"].as<String>();
    lastUploadedFile = document["lastUploadedFile"].as<String>();
    lastCaptureAt = document["lastCaptureAt"] | 0U;
    lastUploadAt = document["lastUploadAt"] | 0U;
  }
  file.close();
}

void publishStatus(bool sdReady, bool wifiReady, bool clockReady) {
  JsonDocument document;
  uint32_t now = clockReady ? static_cast<uint32_t>(time(nullptr)) : 0;
  document["schemaVersion"] = 1;
  document["camera"] = CAMERA_NAME;
  document["firmwareVersion"] = FIRMWARE_VERSION;
  document["updatedAt"] = now;
  document["captureIntervalMinutes"] = CAPTURE_INTERVAL_MINUTES;
  document["nextCaptureAt"] = now ? now + CAPTURE_INTERVAL_MINUTES * 60 : 0;
  document["lastCaptureAt"] = lastCaptureAt;
  document["lastUploadAt"] = lastUploadAt;
  document["lastCapturedFile"] = lastCapturedFile;
  document["lastUploadedFile"] = lastUploadedFile;
  document["pendingUploads"] = sdReady ? static_cast<int32_t>(pendingCount()) : -1;
  document["sdReady"] = sdReady;
  if (sdReady) {
    document["sdTotalBytes"] = SD_MMC.totalBytes();
    document["sdFreeBytes"] = SD_MMC.totalBytes() - SD_MMC.usedBytes();
  }
  document["wifiConnected"] = wifiReady;
  if (wifiReady) document["wifiRssi"] = WiFi.RSSI();
  document["error"] = cycleError;
  if (sdReady) {
    String temporary = String(LOCAL_STATUS_PATH) + ".part";
    File file = SD_MMC.open(temporary, FILE_WRITE);
    if (file) {
      size_t expected = measureJson(document);
      size_t written = serializeJson(document, file);
      file.flush();
      file.close();
      if (written == expected) {
        SD_MMC.remove(LOCAL_STATUS_PATH);
        if (!SD_MMC.rename(temporary, LOCAL_STATUS_PATH)) noteError("status_save_failed");
      } else { SD_MMC.remove(temporary); noteError("status_save_failed"); }
    } else noteError("status_save_failed");
  }
  document["error"] = cycleError;
  if (!wifiReady || !clockReady) return;
  String repoPath = String(GITHUB_STATUS_PATH) + "/" + CAMERA_NAME + ".json";
  String sha;
  if (!readGitHubSha(repoPath, sha)) {
    Serial.println("Could not read remote camera status metadata");
    return;
  }
  String json;
  serializeJson(document, json);
  putGitHubContent(repoPath, reinterpret_cast<const uint8_t *>(json.c_str()), json.length(), clockReady, sha);
}

void goToSleep() {
  Serial.printf("Sleeping for %llu minute(s)\n", CAPTURE_INTERVAL_MINUTES);
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  esp_sleep_enable_timer_wakeup(CAPTURE_INTERVAL_MINUTES * 60ULL * 1000000ULL);
  delay(200);
  esp_deep_sleep_start();
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  bootCount++;
  Serial.printf("\nESP32-CAM timelapse boot #%lu\n", static_cast<unsigned long>(bootCount));

  bool sdReady = initSdCard();
  if (sdReady) { initOutbox(); loadLocalStatus(); }
  else noteError("sd_unavailable");
  bool cameraReady = initCamera();
  if (!cameraReady) noteError("camera_init_failed");

  bool wifiReady = connectWiFi();
  if (!wifiReady) noteError("wifi_unavailable");
  bool timeReady = wifiReady ? syncClock() : false;
  if (!timeReady) noteError("clock_unavailable");

  String fileName = makeFileName(timeReady);
  camera_fb_t *frame = cameraReady ? capturePhoto() : nullptr;
  if (frame) {
    lastCapturedFile = fileName;
    lastCaptureAt = timeReady ? static_cast<uint32_t>(time(nullptr)) : 0;
    bool saved = sdReady && savePhotoToSd(fileName, frame->buf, frame->len);
    if (!saved) {
      noteError("sd_save_failed");
      if (wifiReady && timeReady && putGitHubContent(String(GITHUB_PHOTO_PATH) + "/" + fileName, frame->buf, frame->len, timeReady)) {
        lastUploadedFile = fileName;
        lastUploadAt = static_cast<uint32_t>(time(nullptr));
      }
    }
    esp_camera_fb_return(frame);
  } else if (cameraReady) noteError("capture_failed");
  if (cameraReady) esp_camera_deinit();
  pinMode(PWDN_GPIO_NUM, OUTPUT);
  digitalWrite(PWDN_GPIO_NUM, HIGH);
  if (sdReady && wifiReady && timeReady) flushOutbox(timeReady, frame ? fileName : String());
  publishStatus(sdReady, wifiReady, timeReady);
  goToSleep();
}

void loop() {
  // Work is done once per wake cycle in setup().
}
