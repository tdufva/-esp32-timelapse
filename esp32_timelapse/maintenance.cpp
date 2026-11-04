#include "maintenance.h"
#include "schedule_storage.h"
#include "firmware_identity.h"
#include "config.h"
#include "maintenance_page.h"
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Update.h>
#include <SD_MMC.h>
#include <esp_https_server.h>
#include <esp_ota_ops.h>
#include <esp_app_desc.h>
#include <esp_app_format.h>
#include <mbedtls/base64.h>
extern "C" {
#include <mbedtls/constant_time.h>
}
#include <algorithm>

#if __has_include("maintenance_secrets.h")
#include "maintenance_secrets.h"
#else
#define MAINT_USER "admin"
#define MAINT_PASSWORD ""
#define MAINT_HOSTNAME "esp32cam.local"
#define MAINT_CERT_PEM ""
#define MAINT_KEY_PEM ""
#endif

static uint32_t activeUntil = 0;
static String consumedRequest;
static String csrfToken;
static CaptureSchedule *currentSchedule = nullptr;
static volatile bool finishRequested = false;
static volatile bool uploading = false;
static volatile uint32_t restartAt = 0;
static unsigned authFailures = 0;
static uint32_t authBlockedUntil = 0;

bool maintenanceConfigured() {
  return strlen(MAINT_PASSWORD) >= 16 && strlen(MAINT_PASSWORD) <= 96 && strlen(MAINT_USER) > 0 && strlen(MAINT_USER) <= 32 && strlen(MAINT_CERT_PEM) > 128 && strlen(MAINT_KEY_PEM) > 64;
}

const char *maintenanceHostname() { return MAINT_HOSTNAME; }
uint32_t maintenanceEndsAt() { return activeUntil; }

void loadMaintenanceState() {
  Preferences preferences;
  if (!preferences.begin("maintenance", true)) return;
  consumedRequest = preferences.getString("request", "");
  activeUntil = preferences.getUInt("until", 0);
  preferences.end();
}

static void persistUntil(uint32_t until) {
  activeUntil = until;
  Preferences preferences;
  if (preferences.begin("maintenance", false)) { preferences.putUInt("until", until); preferences.end(); }
}

bool maintenanceActive(uint32_t now) {
  return maintenanceConfigured() && now > 1700000000U && activeUntil > now && activeUntil - now <= 1200;
}

bool acceptMaintenanceRequest(const String &id, uint32_t expiresAt, uint32_t now) {
  if (!maintenanceConfigured() || !id.length() || id.length() > 64 || id == consumedRequest || expiresAt <= now || expiresAt - now > 172800) return false;
  for (size_t i = 0; i < id.length(); i++) if (!isalnum(static_cast<unsigned char>(id[i])) && id[i] != '-' && id[i] != '_' && id[i] != ':' && id[i] != '.') return false;
  Preferences preferences;
  if (!preferences.begin("maintenance", false)) return false;
  bool saved = preferences.putString("request", id) == id.length() && preferences.putUInt("until", now + 600) == sizeof(uint32_t);
  preferences.end();
  if (!saved) return false;
  consumedRequest = id;
  activeUntil = now + 600;
  return true;
}

static void secureHeaders(httpd_req_t *request) {
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
  httpd_resp_set_hdr(request, "X-Frame-Options", "DENY");
}

static esp_err_t sendJson(httpd_req_t *request, JsonDocument &document, const char *status = "200 OK") {
  String json;
  serializeJson(document, json);
  secureHeaders(request);
  httpd_resp_set_type(request, "application/json; charset=utf-8");
  httpd_resp_set_status(request, status);
  return httpd_resp_send(request, json.c_str(), json.length());
}

static esp_err_t sendError(httpd_req_t *request, const char *status, const char *error) {
  JsonDocument document;
  document["error"] = error;
  httpd_resp_set_hdr(request, "Connection", "close");
  sendJson(request, document, status);
  return ESP_FAIL;
}

static String header(httpd_req_t *request, const char *name, size_t limit = 256) {
  size_t length = httpd_req_get_hdr_value_len(request, name);
  if (!length || length > limit) return String();
  char value[513];
  if (length >= sizeof(value) || httpd_req_get_hdr_value_str(request, name, value, sizeof(value)) != ESP_OK) return String();
  return String(value);
}

static bool sameText(const String &left, const String &right) {
  return left.length() == right.length() && mbedtls_ct_memcmp(left.c_str(), right.c_str(), left.length()) == 0;
}

static bool authenticated(httpd_req_t *request, bool mutation = false) {
  String host = header(request, "Host", 128);
  String address = WiFi.localIP().toString();
  if (host != MAINT_HOSTNAME && host != String(MAINT_HOSTNAME) + ":443" && host != address && host != address + ":443") { sendError(request, "403 Forbidden", "invalid_host"); return false; }
  if (authBlockedUntil && static_cast<int32_t>(millis() - authBlockedUntil) < 0) { httpd_resp_set_hdr(request, "Retry-After", "30"); sendError(request, "429 Too Many Requests", "authentication_rate_limited"); return false; }
  String credentials = String(MAINT_USER) + ":" + MAINT_PASSWORD;
  uint8_t encoded[192];
  size_t length = 0;
  mbedtls_base64_encode(encoded, sizeof(encoded) - 1, &length, reinterpret_cast<const uint8_t *>(credentials.c_str()), credentials.length());
  encoded[length] = 0;
  String expected = String("Basic ") + reinterpret_cast<char *>(encoded);
  if (!sameText(header(request, "Authorization"), expected)) {
    if (++authFailures >= 8) { authFailures = 0; authBlockedUntil = millis() + 30000; }
    httpd_resp_set_hdr(request, "WWW-Authenticate", "Basic realm=\"ESP32-CAM maintenance\"");
    sendError(request, "401 Unauthorized", "authentication_required");
    return false;
  }
  authFailures = 0;
  if (mutation) {
    String origin = header(request, "Origin");
    if ((origin.length() && origin != String("https://") + host) || !sameText(header(request, "X-CSRF-Token"), csrfToken)) { sendError(request, "403 Forbidden", "csrf_rejected"); return false; }
  }
  return true;
}

static String latestPhoto(uint32_t *capturedAt = nullptr) {
  File file = SD_MMC.open("/camera-status.json", FILE_READ);
  if (!file) return String();
  JsonDocument status;
  if (deserializeJson(status, file)) { file.close(); return String(); }
  file.close();
  if (capturedAt) *capturedAt = status["lastCaptureAt"] | 0U;
  String name = status["lastCapturedFile"].as<String>();
  if (name.indexOf('/') >= 0 || !name.endsWith(".jpg")) return String();
  return name;
}

static esp_err_t rootHandler(httpd_req_t *request) {
  if (!authenticated(request)) return ESP_FAIL;
  String page(FPSTR(MAINTENANCE_PAGE));
  page.replace("__NONCE__", csrfToken);
  secureHeaders(request);
  String policy = String("default-src 'none'; script-src 'nonce-") + csrfToken + "'; style-src 'nonce-" + csrfToken + "'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  httpd_resp_set_hdr(request, "Content-Security-Policy", policy.c_str());
  httpd_resp_set_type(request, "text/html; charset=utf-8");
  return httpd_resp_send(request, page.c_str(), page.length());
}

static esp_err_t infoHandler(httpd_req_t *request) {
  if (!authenticated(request)) return ESP_FAIL;
  JsonDocument document;
  document["firmwareVersion"] = TIMELAPSE_VERSION;
  char elfHash[65];
  const esp_app_desc_t *description = esp_app_get_description();
  for (size_t i = 0; i < 32; i++) snprintf(elfHash + i * 2, 3, "%02x", description->app_elf_sha256[i]);
  document["elfSha256"] = elfHash;
  document["family"] = TIMELAPSE_OTA_FAMILY;
  document["csrfToken"] = csrfToken;
  document["endsAt"] = activeUntil;
  document["freeHeap"] = ESP.getFreeHeap();
  const esp_partition_t *running = esp_ota_get_running_partition();
  const esp_partition_t *next = esp_ota_get_next_update_partition(nullptr);
  document["bootSlot"] = running ? running->label : "unknown";
  document["otaSlotSize"] = next ? next->size : 0;
  document["rollbackAvailable"] = Update.canRollBack();
  document["nextCaptureAt"] = nextScheduledCapture(time(nullptr), *currentSchedule);
  uint32_t captureAt = 0;
  document["lastCapturedFile"] = latestPhoto(&captureAt);
  document["lastCaptureAt"] = captureAt;
  writeCaptureSchedule(document["schedule"].to<JsonObject>(), *currentSchedule);
  return sendJson(request, document);
}

static esp_err_t photoHandler(httpd_req_t *request) {
  if (!authenticated(request)) return ESP_FAIL;
  String name = latestPhoto();
  File file = name.length() ? SD_MMC.open(String(LOCAL_PHOTO_PATH) + "/" + name, FILE_READ) : File();
  if (!file) return sendError(request, "404 Not Found", "photo_unavailable");
  secureHeaders(request);
  httpd_resp_set_type(request, "image/jpeg");
  uint8_t buffer[1024];
  while (file.available()) {
    size_t length = file.read(buffer, sizeof(buffer));
    if (!length || httpd_resp_send_chunk(request, reinterpret_cast<const char *>(buffer), length) != ESP_OK) { file.close(); return ESP_FAIL; }
  }
  file.close();
  return httpd_resp_send_chunk(request, nullptr, 0);
}

static bool readJson(httpd_req_t *request, JsonDocument &document) {
  if (!request->content_len || request->content_len > 1024 || !header(request, "Content-Type").startsWith("application/json")) return false;
  char buffer[1025];
  size_t received = 0;
  unsigned long started = millis();
  while (received < request->content_len && millis() - started < 10000) {
    int count = httpd_req_recv(request, buffer + received, request->content_len - received);
    if (count == HTTPD_SOCK_ERR_TIMEOUT) continue;
    if (count <= 0) return false;
    received += count;
  }
  return received == request->content_len && !deserializeJson(document, buffer, received);
}

static esp_err_t scheduleHandler(httpd_req_t *request) {
  if (!authenticated(request, true)) return ESP_FAIL;
  JsonDocument input;
  CaptureSchedule schedule;
  String error;
  if (!readJson(request, input) || !parseCaptureSchedule(input.as<JsonVariantConst>(), schedule, error)) return sendError(request, "400 Bad Request", "invalid_schedule");
  if (!saveCaptureSchedule(schedule)) return sendError(request, "500 Internal Server Error", "schedule_save_failed");
  *currentSchedule = schedule;
  JsonDocument result;
  writeCaptureSchedule(result["schedule"].to<JsonObject>(), schedule);
  result["nextCaptureAt"] = nextScheduledCapture(time(nullptr), schedule);
  return sendJson(request, result);
}

static esp_err_t previewHandler(httpd_req_t *request) {
  if (!authenticated(request, true)) return ESP_FAIL;
  JsonDocument input;
  if (!readJson(request, input) || !input["at"].is<uint32_t>() || input["at"].as<uint32_t>() < 1700000000U) return sendError(request, "400 Bad Request", "invalid_preview");
  CaptureSchedule schedule = *currentSchedule;
  String error;
  if (!input["schedule"].isNull() && !parseCaptureSchedule(input["schedule"], schedule, error)) return sendError(request, "400 Bad Request", "invalid_schedule");
  uint32_t now = input["at"];
  JsonDocument result;
  result["period"] = capturePeriodAt(now, schedule);
  result["captureAllowed"] = captureAllowedAt(now, schedule);
  result["nextCaptureAt"] = nextScheduledCapture(now, schedule);
  return sendJson(request, result);
}

static esp_err_t finishHandler(httpd_req_t *request) {
  if (!authenticated(request, true)) return ESP_FAIL;
  JsonDocument result;
  result["finished"] = true;
  result["nextCaptureAt"] = nextScheduledCapture(time(nullptr), *currentSchedule);
  esp_err_t sent = sendJson(request, result);
  finishRequested = true;
  return sent;
}

static esp_err_t updateHandler(httpd_req_t *request) {
  if (!authenticated(request, true)) return ESP_FAIL;
  if (uploading || restartAt) return sendError(request, "409 Conflict", "update_in_progress");
  const esp_partition_t *next = esp_ota_get_next_update_partition(nullptr);
  const size_t prefixSize = sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t) + sizeof(esp_app_desc_t);
  String expected = header(request, "X-Firmware-SHA256");
  if (!next || request->content_len < prefixSize || request->content_len > next->size || expected.length() != 64 || header(request, "Content-Type") != "application/octet-stream") return sendError(request, "400 Bad Request", "invalid_firmware");
  for (size_t i = 0; i < expected.length(); i++) if (!isxdigit(static_cast<unsigned char>(expected[i]))) return sendError(request, "400 Bad Request", "invalid_hash");
  uploading = true;
  unsigned long started = millis();
  uint8_t buffer[4096];
  size_t received = 0;
  while (received < prefixSize && millis() - started < 180000) {
    int count = httpd_req_recv(request, reinterpret_cast<char *>(buffer + received), prefixSize - received);
    if (count == HTTPD_SOCK_ERR_TIMEOUT) continue;
    if (count <= 0) { uploading = false; return sendError(request, "400 Bad Request", "upload_incomplete"); }
    received += count;
  }
  esp_image_header_t image;
  esp_app_desc_t description;
  memcpy(&image, buffer, sizeof(image));
  memcpy(&description, buffer + sizeof(image) + sizeof(esp_image_segment_header_t), sizeof(description));
  if (received != prefixSize || image.magic != ESP_IMAGE_HEADER_MAGIC || image.chip_id != ESP_CHIP_ID_ESP32 || description.magic_word != ESP_APP_DESC_MAGIC_WORD) { uploading = false; return sendError(request, "400 Bad Request", "wrong_firmware_image"); }
  if (!Update.begin(request->content_len, U_FLASH) || !Update.setSHA256(expected.c_str())) { Update.abort(); uploading = false; return sendError(request, "500 Internal Server Error", "update_begin_failed"); }
  persistUntil(std::max(activeUntil, static_cast<uint32_t>(time(nullptr)) + 180));
  bool familyFound = false;
  const char *family = TIMELAPSE_OTA_FAMILY;
  const size_t familyLength = strlen(family);
  uint8_t tail[64];
  size_t tailLength = 0;
  auto inspect = [&](const uint8_t *data, size_t size) {
    uint8_t combined[4096 + 64];
    memcpy(combined, tail, tailLength);
    memcpy(combined + tailLength, data, size);
    size_t total = tailLength + size;
    if (std::search(combined, combined + total, family, family + familyLength) != combined + total) familyFound = true;
    tailLength = std::min(total, familyLength - 1);
    memcpy(tail, combined + total - tailLength, tailLength);
  };
  inspect(buffer, received);
  bool complete = Update.write(buffer, received) == received;
  while (complete && received < request->content_len && millis() - started < 180000) {
    int count = httpd_req_recv(request, reinterpret_cast<char *>(buffer), std::min(sizeof(buffer), request->content_len - received));
    if (count == HTTPD_SOCK_ERR_TIMEOUT) continue;
    if (count <= 0) { complete = false; break; }
    inspect(buffer, count);
    complete = Update.write(buffer, count) == static_cast<size_t>(count);
    received += count;
    delay(1);
  }
  if (!complete || received != request->content_len || !familyFound) { Update.abort(); uploading = false; return sendError(request, "400 Bad Request", "firmware_rejected"); }
  if (!Update.end(false)) { uploading = false; return sendError(request, "400 Bad Request", "firmware_verification_failed"); }
  JsonDocument result;
  result["updated"] = true;
  result["sha256"] = Update.sha256String();
  esp_err_t sent = sendJson(request, result);
  uploading = false;
  restartAt = millis() + 1500;
  return sent;
}

bool runMaintenance(CaptureSchedule &schedule) {
  if (!maintenanceActive(time(nullptr))) return false;
  currentSchedule = &schedule;
  finishRequested = false; uploading = false; restartAt = 0; authFailures = 0; authBlockedUntil = 0;
  uint8_t random[32];
  esp_fill_random(random, sizeof(random));
  char hex[65];
  for (size_t i = 0; i < sizeof(random); i++) snprintf(hex + i * 2, 3, "%02x", random[i]);
  csrfToken = hex;
  httpd_ssl_config_t config = HTTPD_SSL_CONFIG_DEFAULT();
  config.httpd.max_uri_handlers = 10;
  config.httpd.max_open_sockets = 2;
  config.httpd.lru_purge_enable = true;
  config.httpd.max_req_hdr_len = 4096;
  config.httpd.stack_size = 16384;
  config.httpd.recv_wait_timeout = 10;
  config.httpd.send_wait_timeout = 10;
  config.servercert = reinterpret_cast<const uint8_t *>(MAINT_CERT_PEM);
  config.servercert_len = strlen(MAINT_CERT_PEM) + 1;
  config.prvtkey_pem = reinterpret_cast<const uint8_t *>(MAINT_KEY_PEM);
  config.prvtkey_len = strlen(MAINT_KEY_PEM) + 1;
  httpd_handle_t server = nullptr;
  esp_err_t error = httpd_ssl_start(&server, &config);
  if (error != ESP_OK) { Serial.printf("Maintenance HTTPS start failed: %d\n", error); persistUntil(0); return false; }
  const httpd_uri_t routes[] = {
    { .uri = "/", .method = HTTP_GET, .handler = rootHandler, .user_ctx = nullptr },
    { .uri = "/api/info", .method = HTTP_GET, .handler = infoHandler, .user_ctx = nullptr },
    { .uri = "/api/photo", .method = HTTP_GET, .handler = photoHandler, .user_ctx = nullptr },
    { .uri = "/api/schedule", .method = HTTP_POST, .handler = scheduleHandler, .user_ctx = nullptr },
    { .uri = "/api/preview", .method = HTTP_POST, .handler = previewHandler, .user_ctx = nullptr },
    { .uri = "/api/update", .method = HTTP_POST, .handler = updateHandler, .user_ctx = nullptr },
    { .uri = "/api/finish", .method = HTTP_POST, .handler = finishHandler, .user_ctx = nullptr },
  };
  for (const auto &route : routes) httpd_register_uri_handler(server, &route);
  String hostname(MAINT_HOSTNAME);
  hostname.replace(".local", "");
  if (MDNS.begin(hostname.c_str())) MDNS.addService("https", "tcp", 443);
  Serial.printf("Maintenance HTTPS ready: https://%s\n", MAINT_HOSTNAME);
  uint32_t limit = millis() + std::min<uint32_t>(activeUntil - static_cast<uint32_t>(time(nullptr)), 600) * 1000U;
  while ((!finishRequested && static_cast<int32_t>(millis() - limit) < 0) || uploading || restartAt) {
    if (restartAt && static_cast<int32_t>(millis() - restartAt) >= 0) ESP.restart();
    delay(20);
  }
  delay(200);
  httpd_ssl_stop(server);
  MDNS.end();
  persistUntil(0);
  csrfToken = String();
  Serial.println("Maintenance finished");
  return true;
}
