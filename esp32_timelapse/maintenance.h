#pragma once
#include <Arduino.h>
#include "capture_schedule.h"

bool maintenanceConfigured();
const char *maintenanceHostname();
void loadMaintenanceState();
bool acceptMaintenanceRequest(const String &requestId, uint32_t expiresAt, uint32_t now);
bool maintenanceActive(uint32_t now);
uint32_t maintenanceEndsAt();
bool runMaintenance(CaptureSchedule &schedule);
