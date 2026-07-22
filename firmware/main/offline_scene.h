#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "epd_uc8251.h"
#include "esp_err.h"
#include "sensors.h"

#define OFFLINE_SCENE_MAX_BYTES (64U * 1024U)

/* Loads the last scene stored in the dedicated flash partition, if present. */
esp_err_t offline_scene_init(void);

/*
 * Validates and persists a scene received from the Web application. Ownership
 * of data transfers to this module only when ESP_OK is returned.
 */
esp_err_t offline_scene_install(uint8_t *data, size_t length);

esp_err_t offline_scene_clear(void);
bool offline_scene_available(void);

esp_err_t offline_scene_render(
    const sensor_snapshot_t *snapshot,
    uint8_t *frame,
    epd_rotation_t *rotation
);
