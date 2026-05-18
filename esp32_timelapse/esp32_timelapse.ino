#include <Arduino.h>
#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include "FS.h"
#include "SD_MMC.h"
#include "mbedtls/base64.h"
#include "time.h"
#include "esp_sleep.h"
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
  configTzTime(TIMEZONE, "pool.ntp.org", "time.google.com", "time.nist.gov");

  struct tm timeinfo;
  unsigned long start = millis();
  while (millis() - start < NTP_TIMEOUT_MS) {
    if (getLocalTime(&timeinfo, 1000)) {
      char stamp[32];
      strftime(stamp, sizeof(stamp), "%Y-%m-%d %H:%M:%S", &timeinfo);
      Serial.print("Clock synced: ");
      Serial.println(stamp);
      return true;
    }
  }

  Serial.println("NTP sync failed; using fallback filename");
  return false;
}

String makeFileName(bool hasTime) {
  struct tm timeinfo;
  if (hasTime && getLocalTime(&timeinfo, 100)) {
    char filename[80];
    strftime(filename, sizeof(filename), CAMERA_NAME "_%Y%m%d_%H%M%S.jpg", &timeinfo);
    return String(filename);
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

bool savePhotoToSd(const String &fileName, const uint8_t *data, size_t len) {
  String path = String(LOCAL_PHOTO_PATH) + "/" + fileName;
  File file = SD_MMC.open(path, FILE_WRITE);
  if (!file) {
    Serial.print("Could not open file for writing: ");
    Serial.println(path);
    return false;
  }

  size_t written = file.write(data, len);
  file.close();

  if (written != len) {
    Serial.printf("microSD write incomplete: %u/%u bytes\n", static_cast<unsigned int>(written), static_cast<unsigned int>(len));
    return false;
  }

  Serial.print("Saved to microSD: ");
  Serial.println(path);
  return true;
}

size_t base64Length(size_t rawLength) {
  return 4 * ((rawLength + 2) / 3);
}

bool writeBase64(WiFiClientSecure &client, const uint8_t *data, size_t len) {
  const size_t inputChunk = 1536;
  const size_t encodedChunk = 4 * ((inputChunk + 2) / 3);
  uint8_t encoded[encodedChunk + 4];
  size_t offset = 0;

  while (offset < len) {
    size_t chunk = min(inputChunk, len - offset);
    if (offset + chunk < len) {
      chunk -= chunk % 3;
    }

    size_t encodedLength = 0;
    int err = mbedtls_base64_encode(encoded, sizeof(encoded), &encodedLength, data + offset, chunk);
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

bool uploadPhotoToGitHub(const String &fileName, const uint8_t *data, size_t len, bool clockReady) {
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

  String repoPath = String(GITHUB_PHOTO_PATH) + "/" + fileName;
  String apiPath = String("/repos/") + GITHUB_OWNER + "/" + GITHUB_REPO + "/contents/" + repoPath;
  String message = String("Add timelapse frame ") + fileName;
  String prefix = String("{\"message\":\"") + jsonEscape(message) +
                  "\",\"branch\":\"" + jsonEscape(GITHUB_BRANCH) +
                  "\",\"content\":\"";
  String suffix = "\"}";
  size_t bodyLength = prefix.length() + base64Length(len) + suffix.length();

  WiFiClientSecure client;
#if VERIFY_GITHUB_TLS
  client.setCACert(GITHUB_ROOT_CA);
#else
  client.setInsecure();
#endif
  client.setTimeout(30000);

  Serial.print("Connecting to GitHub API...");
  if (!client.connect(GITHUB_API_HOST, HTTPS_PORT)) {
    Serial.println(" failed");
    return false;
  }
  Serial.println(" connected");

  client.print("PUT ");
  client.print(apiPath);
  client.println(" HTTP/1.1");
  client.print("Host: ");
  client.println(GITHUB_API_HOST);
  client.println("User-Agent: esp32-cam-timelapse");
  client.print("Authorization: Bearer ");
  client.println(GITHUB_TOKEN);
  client.println("Accept: application/vnd.github+json");
  client.println("X-GitHub-Api-Version: 2022-11-28");
  client.println("Content-Type: application/json");
  client.print("Content-Length: ");
  client.println(bodyLength);
  client.println("Connection: close");
  client.println();

  client.print(prefix);
  if (!writeBase64(client, data, len)) {
    client.stop();
    return false;
  }
  client.print(suffix);

  String statusLine = client.readStringUntil('\n');
  statusLine.trim();
  Serial.print("GitHub response: ");
  Serial.println(statusLine);

  int statusCode = 0;
  if (statusLine.startsWith("HTTP/")) {
    statusCode = statusLine.substring(9, 12).toInt();
  }

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
  bool cameraReady = initCamera();
  if (!cameraReady) {
    goToSleep();
    return;
  }

  bool wifiReady = connectWiFi();
  bool timeReady = wifiReady ? syncClock() : false;

  String fileName = makeFileName(timeReady);
  camera_fb_t *frame = capturePhoto();
  if (!frame) {
    goToSleep();
    return;
  }

  if (sdReady) {
    savePhotoToSd(fileName, frame->buf, frame->len);
  }

  if (wifiReady) {
    uploadPhotoToGitHub(fileName, frame->buf, frame->len, timeReady);
  }

  esp_camera_fb_return(frame);
  goToSleep();
}

void loop() {
  // Work is done once per wake cycle in setup().
}
