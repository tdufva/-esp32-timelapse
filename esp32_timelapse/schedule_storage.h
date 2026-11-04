#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include "capture_schedule.h"

CaptureSchedule loadCaptureSchedule();
bool saveCaptureSchedule(const CaptureSchedule &schedule);
bool parseCaptureSchedule(JsonVariantConst value, CaptureSchedule &schedule, String &error);
void writeCaptureSchedule(JsonObject value, const CaptureSchedule &schedule);
