#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include "../esp32_timelapse/capture_schedule.h"

static time_t at(int year, int month, int day, int hour, int minute, int second = 0) {
  struct tm local = {};
  local.tm_year = year - 1900; local.tm_mon = month - 1; local.tm_mday = day;
  local.tm_hour = hour; local.tm_min = minute; local.tm_sec = second; local.tm_isdst = -1;
  return mktime(&local);
}

int main() {
  setenv("TZ", "EET-2EEST,M3.5.0/3,M10.5.0/4", 1);
  tzset();
  CaptureSchedule schedule;
  assert(validCaptureSchedule(schedule));
  assert(nextScheduledCapture(at(2026, 11, 4, 14, 43, 56), schedule) == at(2026, 11, 4, 15, 0));
  assert(nextScheduledCapture(at(2026, 11, 4, 21, 59, 59), schedule) == at(2026, 11, 4, 22, 0));
  assert(nextScheduledCapture(at(2026, 11, 4, 22, 0), schedule) == at(2026, 11, 5, 1, 0));
  assert(nextScheduledCapture(at(2026, 11, 5, 4, 0), schedule) == at(2026, 11, 5, 7, 0));
  assert(nextScheduledCapture(at(2026, 3, 29, 1, 0), schedule) == at(2026, 3, 29, 4, 0));
  assert(nextScheduledCapture(at(2026, 10, 25, 1, 0), schedule) == at(2026, 10, 25, 4, 0));
  schedule.nightEnabled = false;
  assert(!captureAllowedAt(at(2026, 11, 4, 23, 0), schedule));
  assert(captureAllowedAt(at(2026, 11, 4, 12, 0), schedule));
  assert(nextScheduledCapture(at(2026, 11, 4, 21, 59), schedule) == at(2026, 11, 5, 7, 0));
  assert(nextScheduledCapture(at(2026, 11, 5, 2, 0), schedule) == at(2026, 11, 5, 7, 0));
  schedule.dayStart = 20 * 60; schedule.nightStart = 8 * 60;
  assert(captureAllowedAt(at(2026, 11, 4, 23, 0), schedule));
  assert(!captureAllowedAt(at(2026, 11, 4, 12, 0), schedule));
  assert(nextScheduledCapture(at(2026, 11, 4, 12, 0), schedule) == at(2026, 11, 4, 20, 0));
  schedule.nightStart = schedule.dayStart;
  assert(!validCaptureSchedule(schedule));
  puts("Schedule tests passed: day/night boundaries, pauses, midnight and DST");
}
