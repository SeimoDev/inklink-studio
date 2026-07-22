#include "epd_uc8251.h"

#include <stdbool.h>
#include <string.h>

#include "board.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define EPD_NATIVE_STRIDE (EPD_NATIVE_WIDTH / 8)
#define EPD_READY_TIMEOUT_MS 5000
#define EPD_SLEEP_SETTLE_MS 2700
#define EPD_FULL_UPDATE_LUT_BYTES 0x178

static spi_device_handle_t s_spi;
static bool s_bus_ready;
static uint8_t s_native_frame[EPD_FRAME_BYTES];
static uint8_t s_previous_frame[EPD_FRAME_BYTES];
static bool s_previous_valid;
static epd_rotation_t s_previous_rotation;
static bool s_controller_awake;

/*
 * Full-refresh waveform used by the Quote/0 UC8251D panel.  The controller
 * does not contain a usable default waveform after reset; omitting these five
 * LUT registers leaves BUSY asserted after DISPLAY_REFRESH.
 */
static const uint8_t s_full_update_lut[] = {
    0x05, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x0e, 0x0e,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x18, 0x18, 0x01, 0x0e, 0x0e, 0x01,
    0x01, 0x00, 0x23, 0x23, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x90, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x40, 0x0e, 0x0e, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x90, 0x18, 0x18, 0x01, 0x0e, 0x0e, 0x01, 0x01, 0x80, 0x23, 0x23,
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x05, 0x90, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x40, 0x0e, 0x0e, 0x01, 0x01, 0x01, 0x01, 0x01, 0x90, 0x18, 0x18,
    0x01, 0x0e, 0x0e, 0x01, 0x01, 0x80, 0x23, 0x23, 0x01, 0x01, 0x01, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x05, 0x90, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x20, 0x0e, 0x0e,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x18, 0x18, 0x18, 0x01, 0x0e, 0x0e, 0x01,
    0x01, 0x10, 0x23, 0x23, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x90, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x20, 0x0e, 0x0e, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x18, 0x18, 0x18, 0x01, 0x0e, 0x0e, 0x01, 0x01, 0x10, 0x23, 0x23,
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
};

_Static_assert(
    sizeof(s_full_update_lut) == EPD_FULL_UPDATE_LUT_BYTES,
    "UC8251D full-update LUT size must match the five register payloads"
);

static esp_err_t epd_command(uint8_t command)
{
    ESP_RETURN_ON_ERROR(gpio_set_level(BOARD_EPD_DC_GPIO, 0), "epd", "dc");

    spi_transaction_t transaction = {
        .flags = SPI_TRANS_USE_TXDATA,
        .length = 8,
        .tx_data = {command, 0, 0, 0},
    };
    return spi_device_transmit(s_spi, &transaction);
}

static esp_err_t epd_data(const uint8_t *data, size_t length)
{
    if (length == 0) {
        return ESP_OK;
    }

    ESP_RETURN_ON_ERROR(gpio_set_level(BOARD_EPD_DC_GPIO, 1), "epd", "dc");

    spi_transaction_t transaction = {
        .length = length * 8,
        .tx_buffer = data,
    };
    return spi_device_transmit(s_spi, &transaction);
}

static esp_err_t epd_command_data(uint8_t command, const uint8_t *data, size_t length)
{
    ESP_RETURN_ON_ERROR(epd_command(command), "epd", "command");
    return epd_data(data, length);
}

static esp_err_t epd_load_full_update_lut(void)
{
    static const uint8_t commands[] = {0x20, 0x21, 0x22, 0x23, 0x24};
    static const size_t offsets[] = {0, 80, 136, 216, 296, EPD_FULL_UPDATE_LUT_BYTES};

    for (size_t index = 0; index < sizeof(commands); ++index) {
        const size_t offset = offsets[index];
        ESP_RETURN_ON_ERROR(
            epd_command_data(
                commands[index],
                s_full_update_lut + offset,
                offsets[index + 1] - offset
            ),
            "epd",
            "full update lut"
        );
    }
    return ESP_OK;
}

static esp_err_t epd_wait_ready(uint32_t timeout_ms)
{
    const int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;

    while (esp_timer_get_time() < deadline) {
        /*
         * UC8251D only presents a reliable BUSY state after GET_STATUS.  The
         * Quote/0 factory firmware sends 0x71 before every GPIO sample.
         * Sampling first can observe the stale idle-high level immediately
         * after POWER_ON or DISPLAY_REFRESH and shut the panel down mid-wave.
         */
        ESP_RETURN_ON_ERROR(epd_command(0x71), "epd", "get status");
        if (gpio_get_level(BOARD_EPD_BUSY_GPIO) != 0) {
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }

    return ESP_ERR_TIMEOUT;
}

static esp_err_t epd_configure_bus(void)
{
    if (s_bus_ready) {
        return ESP_OK;
    }

    const uint64_t output_mask =
        (1ULL << BOARD_EPD_POWER_GPIO) |
        (1ULL << BOARD_EPD_RESET_GPIO) |
        (1ULL << BOARD_EPD_DC_GPIO) |
        (1ULL << BOARD_EPD_CS_GPIO);

    const gpio_config_t output_config = {
        .pin_bit_mask = output_mask,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&output_config), "epd", "output gpio");

    const gpio_config_t busy_config = {
        .pin_bit_mask = 1ULL << BOARD_EPD_BUSY_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&busy_config), "epd", "busy gpio");

    gpio_set_level(BOARD_EPD_POWER_GPIO, 1);
    gpio_set_level(BOARD_EPD_RESET_GPIO, 1);
    gpio_set_level(BOARD_EPD_DC_GPIO, 1);
    gpio_set_level(BOARD_EPD_CS_GPIO, 1);

    const spi_bus_config_t bus_config = {
        .mosi_io_num = BOARD_EPD_MOSI_GPIO,
        .miso_io_num = -1,
        .sclk_io_num = BOARD_EPD_SCLK_GPIO,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = EPD_FRAME_BYTES,
    };
    ESP_RETURN_ON_ERROR(
        spi_bus_initialize(SPI2_HOST, &bus_config, SPI_DMA_CH_AUTO),
        "epd",
        "spi bus"
    );

    const spi_device_interface_config_t device_config = {
        .clock_speed_hz = BOARD_EPD_SPI_CLOCK_HZ,
        .mode = 0,
        .spics_io_num = BOARD_EPD_CS_GPIO,
        .queue_size = 4,
    };
    ESP_RETURN_ON_ERROR(
        spi_bus_add_device(SPI2_HOST, &device_config, &s_spi),
        "epd",
        "spi device"
    );

    memset(s_previous_frame, 0xff, sizeof(s_previous_frame));
    s_bus_ready = true;
    return ESP_OK;
}

static esp_err_t epd_enable_power(void)
{
    ESP_RETURN_ON_ERROR(
        gpio_set_direction(BOARD_EPD_POWER_GPIO, GPIO_MODE_OUTPUT),
        "epd",
        "power output"
    );
    ESP_RETURN_ON_ERROR(gpio_set_level(BOARD_EPD_POWER_GPIO, 1), "epd", "power on");
    vTaskDelay(pdMS_TO_TICKS(2));
    return ESP_OK;
}

static void epd_release_power(void)
{
    /* The factory firmware releases GPIO20 to high impedance instead of
     * forcing the panel supply low. */
    (void)gpio_set_direction(BOARD_EPD_POWER_GPIO, GPIO_MODE_INPUT);
}

static void epd_hardware_reset(void)
{
    /* Exact Quote/0 UC8251D reset pulse train: high -> low -> high, 10 ms each. */
    gpio_set_level(BOARD_EPD_RESET_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(BOARD_EPD_RESET_GPIO, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(BOARD_EPD_RESET_GPIO, 1);
    gpio_set_level(BOARD_EPD_CS_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
}

static esp_err_t epd_power_on(void)
{
    static const uint8_t panel_setting[] = {0xf3, 0x0e};
    static const uint8_t power_setting[] = {0x03, 0x00, 0x3f, 0x3f, 0x03};
    static const uint8_t booster_soft_start[] = {0x17, 0x17, 0x17};
    static const uint8_t resolution[] = {0x98, 0x01, 0x28}; /* 152 x 296 */
    static const uint8_t pll_control[] = {0x1b};
    static const uint8_t tcon_setting[] = {0x22};
    static const uint8_t vcom_dc[] = {0x00};
    static const uint8_t power_saving[] = {0x10};
    static const uint8_t border[] = {0x97};

    ESP_RETURN_ON_ERROR(epd_configure_bus(), "epd", "bus");
    ESP_RETURN_ON_ERROR(epd_enable_power(), "epd", "enable power");
    epd_hardware_reset();
    ESP_RETURN_ON_ERROR(epd_wait_ready(EPD_READY_TIMEOUT_MS), "epd", "reset busy");

    ESP_RETURN_ON_ERROR(epd_command_data(0x00, panel_setting, sizeof(panel_setting)), "epd", "panel");
    ESP_RETURN_ON_ERROR(epd_command_data(0x01, power_setting, sizeof(power_setting)), "epd", "power");
    ESP_RETURN_ON_ERROR(epd_command_data(0x06, booster_soft_start, sizeof(booster_soft_start)), "epd", "booster");
    ESP_RETURN_ON_ERROR(epd_command_data(0x61, resolution, sizeof(resolution)), "epd", "resolution");
    ESP_RETURN_ON_ERROR(epd_command_data(0x30, pll_control, sizeof(pll_control)), "epd", "pll");
    ESP_RETURN_ON_ERROR(epd_command_data(0x60, tcon_setting, sizeof(tcon_setting)), "epd", "tcon");
    ESP_RETURN_ON_ERROR(epd_command_data(0x82, vcom_dc, sizeof(vcom_dc)), "epd", "vcom");
    ESP_RETURN_ON_ERROR(epd_command_data(0x03, power_saving, sizeof(power_saving)), "epd", "power saving");
    ESP_RETURN_ON_ERROR(epd_command_data(0x50, border, sizeof(border)), "epd", "border");
    ESP_RETURN_ON_ERROR(epd_command(0x04), "epd", "power on");
    vTaskDelay(pdMS_TO_TICKS(100));
    ESP_RETURN_ON_ERROR(epd_wait_ready(EPD_READY_TIMEOUT_MS), "epd", "power busy");
    s_controller_awake = true;
    return ESP_OK;
}

static void landscape_to_native(
    const uint8_t *landscape,
    epd_rotation_t rotation,
    uint8_t *native
)
{
    memset(native, 0xff, EPD_FRAME_BYTES);

    for (int y = 0; y < EPD_LANDSCAPE_HEIGHT; ++y) {
        for (int x = 0; x < EPD_LANDSCAPE_WIDTH; ++x) {
            const size_t source_index = (size_t)y * (EPD_LANDSCAPE_WIDTH / 8) + (size_t)x / 8;
            const bool white = (landscape[source_index] & (0x80u >> (x & 7))) != 0;
            if (white) {
                continue;
            }

            int native_x;
            int native_y;
            if (rotation == EPD_ROTATE_270) {
                native_x = EPD_NATIVE_WIDTH - 1 - y;
                native_y = x;
            } else {
                native_x = y;
                native_y = EPD_NATIVE_HEIGHT - 1 - x;
            }

            const size_t destination_index =
                (size_t)native_y * EPD_NATIVE_STRIDE + (size_t)native_x / 8;
            native[destination_index] &= (uint8_t)~(0x80u >> (native_x & 7));
        }
    }
}

static void epd_sleep(void)
{
    if (!s_bus_ready) {
        return;
    }

    if (s_controller_awake) {
        static const uint8_t deep_sleep_check_code[] = {0xa5};

        /* Quote/0 waits for the waveform to settle before deep sleep.  Cutting
         * power immediately is visible as a blank, continuously cycling panel. */
        (void)epd_wait_ready(EPD_READY_TIMEOUT_MS);
        vTaskDelay(pdMS_TO_TICKS(EPD_SLEEP_SETTLE_MS));
        (void)epd_command_data(
            0x07,
            deep_sleep_check_code,
            sizeof(deep_sleep_check_code)
        );
        s_controller_awake = false;
    }

    epd_release_power();
}

typedef struct {
    int x_start;
    int x_end;
    int y_start;
    int y_end;
} native_window_t;

static bool find_changed_window(native_window_t *window)
{
    int first_byte = EPD_NATIVE_STRIDE;
    int last_byte = -1;
    int first_row = EPD_NATIVE_HEIGHT;
    int last_row = -1;

    for (int y = 0; y < EPD_NATIVE_HEIGHT; ++y) {
        for (int byte_x = 0; byte_x < EPD_NATIVE_STRIDE; ++byte_x) {
            const size_t index = (size_t)y * EPD_NATIVE_STRIDE + (size_t)byte_x;
            if (s_native_frame[index] == s_previous_frame[index]) {
                continue;
            }
            if (byte_x < first_byte) first_byte = byte_x;
            if (byte_x > last_byte) last_byte = byte_x;
            if (y < first_row) first_row = y;
            if (y > last_row) last_row = y;
        }
    }

    if (last_byte < 0 || last_row < 0) {
        return false;
    }
    *window = (native_window_t){
        .x_start = first_byte * 8,
        .x_end = last_byte * 8 + 7,
        .y_start = first_row,
        .y_end = last_row,
    };
    return true;
}

static void window_to_landscape(
    const native_window_t *native,
    epd_rotation_t rotation,
    epd_refresh_result_t *result
)
{
    if (rotation == EPD_ROTATE_270) {
        result->x = native->y_start;
        result->y = EPD_NATIVE_WIDTH - 1 - native->x_end;
        result->width = native->y_end - native->y_start + 1;
        result->height = native->x_end - native->x_start + 1;
    } else {
        result->x = EPD_NATIVE_HEIGHT - 1 - native->y_end;
        result->y = native->x_start;
        result->width = native->y_end - native->y_start + 1;
        result->height = native->x_end - native->x_start + 1;
    }
}

static esp_err_t epd_write_window(
    uint8_t command,
    const uint8_t *frame,
    const native_window_t *window
)
{
    ESP_RETURN_ON_ERROR(epd_command(command), "epd", "window data command");
    const size_t first_byte = (size_t)window->x_start / 8;
    const size_t byte_count = (size_t)(window->x_end - window->x_start + 1) / 8;
    for (int y = window->y_start; y <= window->y_end; ++y) {
        ESP_RETURN_ON_ERROR(
            epd_data(frame + (size_t)y * EPD_NATIVE_STRIDE + first_byte, byte_count),
            "epd",
            "window data"
        );
    }
    return ESP_OK;
}

static esp_err_t epd_update_full(void)
{
    const uint8_t *old_frame = s_previous_valid ? s_previous_frame : NULL;
    if (old_frame == NULL) {
        memset(s_previous_frame, 0xff, sizeof(s_previous_frame));
        old_frame = s_previous_frame;
    }

    ESP_RETURN_ON_ERROR(epd_command(0x10), "epd", "old frame command");
    ESP_RETURN_ON_ERROR(epd_data(old_frame, EPD_FRAME_BYTES), "epd", "old frame");
    ESP_RETURN_ON_ERROR(epd_command(0x13), "epd", "new frame command");
    ESP_RETURN_ON_ERROR(epd_data(s_native_frame, EPD_FRAME_BYTES), "epd", "new frame");
    ESP_RETURN_ON_ERROR(epd_command(0x12), "epd", "display refresh");
    vTaskDelay(pdMS_TO_TICKS(100));
    return epd_wait_ready(EPD_READY_TIMEOUT_MS);
}

static esp_err_t epd_update_partial(const native_window_t *window)
{
    const uint8_t partial_window[] = {
        (uint8_t)window->x_start,
        (uint8_t)window->x_end,
        (uint8_t)((window->y_start >> 8) & 0x01),
        (uint8_t)(window->y_start & 0xff),
        (uint8_t)((window->y_end >> 8) & 0x01),
        (uint8_t)(window->y_end & 0xff),
        0x00, /* PT_SCAN=0: gate/source scan is restricted to this window. */
    };

    ESP_RETURN_ON_ERROR(epd_command(0x91), "epd", "partial in");
    ESP_RETURN_ON_ERROR(
        epd_command_data(0x90, partial_window, sizeof(partial_window)),
        "epd",
        "partial window"
    );
    ESP_RETURN_ON_ERROR(
        epd_write_window(0x10, s_previous_frame, window),
        "epd",
        "partial old frame"
    );
    ESP_RETURN_ON_ERROR(
        epd_write_window(0x13, s_native_frame, window),
        "epd",
        "partial new frame"
    );
    ESP_RETURN_ON_ERROR(epd_command(0x12), "epd", "partial refresh");
    vTaskDelay(pdMS_TO_TICKS(100));
    ESP_RETURN_ON_ERROR(epd_wait_ready(EPD_READY_TIMEOUT_MS), "epd", "partial busy");
    return epd_command(0x92);
}

esp_err_t epd_display_landscape_update(
    const uint8_t *frame,
    epd_rotation_t rotation,
    bool allow_partial,
    epd_refresh_result_t *refresh_result
)
{
    if (frame == NULL || (rotation != EPD_ROTATE_90 && rotation != EPD_ROTATE_270)) {
        return ESP_ERR_INVALID_ARG;
    }

    landscape_to_native(frame, rotation, s_native_frame);

    native_window_t changed_window = {0};
    const bool comparable = s_previous_valid && s_previous_rotation == rotation;
    const bool changed = comparable && find_changed_window(&changed_window);
    if (allow_partial && comparable && !changed) {
        if (refresh_result != NULL) {
            *refresh_result = (epd_refresh_result_t){.mode = EPD_REFRESH_NONE};
        }
        return ESP_OK;
    }

    bool use_partial = allow_partial && comparable && changed;
    if (use_partial) {
        const int partial_area =
            (changed_window.x_end - changed_window.x_start + 1) *
            (changed_window.y_end - changed_window.y_start + 1);
        const int panel_area = EPD_NATIVE_WIDTH * EPD_NATIVE_HEIGHT;
        if (partial_area * 4 >= panel_area * 3) {
            use_partial = false;
        }
    }

    epd_refresh_result_t applied = {
        .mode = use_partial ? EPD_REFRESH_PARTIAL : EPD_REFRESH_FULL,
        .x = 0,
        .y = 0,
        .width = EPD_LANDSCAPE_WIDTH,
        .height = EPD_LANDSCAPE_HEIGHT,
    };
    if (use_partial) {
        window_to_landscape(&changed_window, rotation, &applied);
    }

    esp_err_t result = epd_power_on();
    if (result != ESP_OK) {
        epd_sleep();
        return result;
    }

    result = epd_load_full_update_lut();
    if (result != ESP_OK) {
        goto shutdown;
    }

    result = use_partial
        ? epd_update_partial(&changed_window)
        : epd_update_full();
    if (result != ESP_OK) goto shutdown;

    memcpy(s_previous_frame, s_native_frame, sizeof(s_previous_frame));
    s_previous_valid = true;
    s_previous_rotation = rotation;
    if (refresh_result != NULL) {
        *refresh_result = applied;
    }

shutdown:
    epd_sleep();
    return result;
}

esp_err_t epd_display_landscape(const uint8_t *frame, epd_rotation_t rotation)
{
    return epd_display_landscape_update(frame, rotation, false, NULL);
}

esp_err_t epd_clear(void)
{
    static uint8_t white_frame[EPD_FRAME_BYTES];
    memset(white_frame, 0xff, sizeof(white_frame));
    return epd_display_landscape(white_frame, EPD_ROTATE_90);
}

void epd_shutdown(void)
{
    epd_sleep();
}
