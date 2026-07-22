#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#define EPD_NATIVE_WIDTH 152
#define EPD_NATIVE_HEIGHT 296
#define EPD_LANDSCAPE_WIDTH 296
#define EPD_LANDSCAPE_HEIGHT 152
#define EPD_FRAME_BYTES ((EPD_LANDSCAPE_WIDTH / 8) * EPD_LANDSCAPE_HEIGHT)

typedef enum {
    EPD_ROTATE_90 = 90,
    EPD_ROTATE_270 = 270,
} epd_rotation_t;

typedef enum {
    EPD_REFRESH_NONE = 0,
    EPD_REFRESH_FULL,
    EPD_REFRESH_PARTIAL,
} epd_refresh_mode_t;

typedef struct {
    epd_refresh_mode_t mode;
    int x;
    int y;
    int width;
    int height;
} epd_refresh_result_t;

esp_err_t epd_display_landscape(const uint8_t *frame, epd_rotation_t rotation);
esp_err_t epd_display_landscape_update(
    const uint8_t *frame,
    epd_rotation_t rotation,
    bool allow_partial,
    epd_refresh_result_t *refresh_result
);
esp_err_t epd_clear(void);
void epd_shutdown(void);
