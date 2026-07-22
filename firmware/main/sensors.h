#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

typedef struct {
    bool battery_valid;
    int battery_mv;
    int battery_percent;
    bool temperature_valid;
    float chip_temperature_c;
    bool vbus_present;
    uint32_t uptime_s;
    uint32_t free_heap;
} sensor_snapshot_t;

esp_err_t sensors_init(void);
void sensors_read(sensor_snapshot_t *snapshot);
