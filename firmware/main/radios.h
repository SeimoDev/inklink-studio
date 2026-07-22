#pragma once

#include <stdbool.h>

#include "device_config.h"
#include "esp_err.h"

esp_err_t radios_apply(const device_config_t *config);
bool radios_wifi_active(void);
bool radios_bluetooth_active(void);
