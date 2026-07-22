#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define DEVICE_CONFIG_SCHEMA_VERSION 1
#define DEVICE_DATA_REFRESH_MIN_MS 1000U
#define DEVICE_SCREEN_REFRESH_MIN_MS 10000U
#define DEVICE_FULL_REFRESH_MIN_MS 180000U
#define DEVICE_REFRESH_MAX_MS 86400000U

typedef struct {
    bool wifi_enabled;
    bool bluetooth_enabled;
    bool partial_refresh_enabled;
    uint32_t data_refresh_ms;
    uint32_t screen_refresh_ms;
    uint32_t full_refresh_ms;
} device_config_t;

esp_err_t device_config_init(void);
void device_config_get(device_config_t *config);
bool device_config_is_valid(const device_config_t *config);
esp_err_t device_config_save(const device_config_t *config);
