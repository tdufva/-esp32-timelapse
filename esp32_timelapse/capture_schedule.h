#pragma once
#include <stdint.h>
#include <time.h>

struct CaptureSchedule {
  uint16_t dayStart = 7 * 60;
  uint16_t nightStart = 22 * 60;
  uint16_t dayInterval = 60;
  uint16_t nightInterval = 180;
  bool nightEnabled = true;
};

inline bool validCaptureSchedule(const CaptureSchedule &schedule) {
  return schedule.dayStart < 1440 && schedule.nightStart < 1440 && schedule.dayStart != schedule.nightStart &&
         schedule.dayInterval >= 5 && schedule.dayInterval <= 1440 && schedule.nightInterval >= 5 && schedule.nightInterval <= 1440;
}

inline bool isDayMinute(const CaptureSchedule &schedule, int minute) {
  return schedule.dayStart < schedule.nightStart
    ? minute >= schedule.dayStart && minute < schedule.nightStart
    : minute >= schedule.dayStart || minute < schedule.nightStart;
}

inline bool captureAllowedAt(time_t now, const CaptureSchedule &schedule) {
  struct tm local;
  localtime_r(&now, &local);
  return isDayMinute(schedule, local.tm_hour * 60 + local.tm_min) || schedule.nightEnabled;
}

inline const char *capturePeriodAt(time_t now, const CaptureSchedule &schedule) {
  struct tm local;
  localtime_r(&now, &local);
  if (isDayMinute(schedule, local.tm_hour * 60 + local.tm_min)) return "day";
  return schedule.nightEnabled ? "night" : "paused";
}

inline time_t nextScheduledCapture(time_t now, const CaptureSchedule &schedule) {
  if (!validCaptureSchedule(schedule)) return now + 3600;
  // Search real minutes, then evaluate local wall time. This also handles DST.
  time_t candidate = (now / 60 + 1) * 60;
  for (int step = 0; step < 48 * 60; step++, candidate += 60) {
    struct tm local;
    localtime_r(&candidate, &local);
    int minute = local.tm_hour * 60 + local.tm_min;
    bool day = isDayMinute(schedule, minute);
    if (!day && !schedule.nightEnabled) continue;
    int anchor = day ? schedule.dayStart : schedule.nightStart;
    int interval = day ? schedule.dayInterval : schedule.nightInterval;
    if (((minute - anchor + 1440) % 1440) % interval == 0) return candidate;
  }
  return now + 3600;
}
