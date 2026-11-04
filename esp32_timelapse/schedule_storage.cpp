#include "schedule_storage.h"
#include <Preferences.h>
#include "config.h"

static bool readClock(const char *text, uint16_t &minute) {
  if (!text || strlen(text) != 5 || text[2] != ':' || text[0] < '0' || text[0] > '2' || text[1] < '0' || text[1] > '9' || text[3] < '0' || text[3] > '5' || text[4] < '0' || text[4] > '9') return false;
  int hour = (text[0] - '0') * 10 + text[1] - '0';
  if (hour > 23) return false;
  minute = hour * 60 + (text[3] - '0') * 10 + text[4] - '0';
  return true;
}

bool parseCaptureSchedule(JsonVariantConst value, CaptureSchedule &schedule, String &error) {
  CaptureSchedule result;
  if (!value.is<JsonObjectConst>() || !readClock(value["dayStart"], result.dayStart) || !readClock(value["nightStart"], result.nightStart) ||
      !value["dayIntervalMinutes"].is<uint16_t>() || !value["nightIntervalMinutes"].is<uint16_t>() || !value["nightEnabled"].is<bool>()) {
    error = "invalid_schedule";
    return false;
  }
  result.dayInterval = value["dayIntervalMinutes"].as<uint16_t>();
  result.nightInterval = value["nightIntervalMinutes"].as<uint16_t>();
  result.nightEnabled = value["nightEnabled"].as<bool>();
  if (!validCaptureSchedule(result)) { error = "invalid_schedule"; return false; }
  schedule = result;
  return true;
}

void writeCaptureSchedule(JsonObject value, const CaptureSchedule &schedule) {
  char clock[6];
  snprintf(clock, sizeof(clock), "%02u:%02u", schedule.dayStart / 60, schedule.dayStart % 60);
  value["dayStart"] = clock;
  snprintf(clock, sizeof(clock), "%02u:%02u", schedule.nightStart / 60, schedule.nightStart % 60);
  value["nightStart"] = clock;
  value["dayIntervalMinutes"] = schedule.dayInterval;
  value["nightIntervalMinutes"] = schedule.nightInterval;
  value["nightEnabled"] = schedule.nightEnabled;
}

CaptureSchedule loadCaptureSchedule() {
  CaptureSchedule schedule;
  if (CAPTURE_INTERVAL_MINUTES >= 5 && CAPTURE_INTERVAL_MINUTES <= 1440) schedule.dayInterval = CAPTURE_INTERVAL_MINUTES;
  Preferences preferences;
  if (!preferences.begin("capture_sched", true)) return schedule;
  String text = preferences.getString("schedule", "");
  preferences.end();
  if (text.length() && text.length() < 512) {
    JsonDocument document;
    String error;
    if (!deserializeJson(document, text)) parseCaptureSchedule(document.as<JsonVariantConst>(), schedule, error);
  }
  return schedule;
}

bool saveCaptureSchedule(const CaptureSchedule &schedule) {
  if (!validCaptureSchedule(schedule)) return false;
  JsonDocument document;
  writeCaptureSchedule(document.to<JsonObject>(), schedule);
  String text;
  serializeJson(document, text);
  Preferences preferences;
  if (!preferences.begin("capture_sched", false)) return false;
  bool saved = preferences.putString("schedule", text) == text.length();
  preferences.end();
  return saved;
}
