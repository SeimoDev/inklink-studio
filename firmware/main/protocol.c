#include "protocol.h"

#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "crc32.h"
#include "device_config.h"
#include "driver/usb_serial_jtag.h"
#include "epd_uc8251.h"
#include "esp_check.h"
#include "esp_err.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "radios.h"
#include "sensors.h"

#define PROTOCOL_VERSION 2
#define FIRMWARE_VERSION "1.1.0"
#define LINE_BUFFER_SIZE 256
#define RX_CHUNK_SIZE 512
#define FRAME_RECEIVE_TIMEOUT_US (10LL * 1000LL * 1000LL)
#define MAX_PARTIAL_REFRESHES 10U

typedef struct {
    bool active;
    uint32_t request_id;
    uint32_t expected_crc;
    size_t expected_length;
    size_t received_length;
    epd_rotation_t rotation;
    bool request_partial;
    int64_t last_byte_time_us;
} frame_receive_state_t;

static uint8_t s_frame[EPD_FRAME_BYTES];
static frame_receive_state_t s_frame_state;
static char s_line[LINE_BUFFER_SIZE];
static size_t s_line_length;
static int64_t s_last_full_refresh_us;
static uint32_t s_partial_refresh_count;

static void serial_write_all(const void *data, size_t length)
{
    const uint8_t *bytes = (const uint8_t *)data;
    size_t written = 0;

    while (written < length) {
        const int result = usb_serial_jtag_write_bytes(
            bytes + written,
            length - written,
            pdMS_TO_TICKS(1000)
        );
        if (result <= 0) {
            return;
        }
        written += (size_t)result;
    }
}

static void serial_printf(const char *format, ...)
{
    char buffer[768];
    va_list args;
    va_start(args, format);
    const int length = vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);

    if (length <= 0) {
        return;
    }
    const size_t safe_length =
        (size_t)length < sizeof(buffer) ? (size_t)length : sizeof(buffer) - 1;
    serial_write_all(buffer, safe_length);
}

static void send_error(uint32_t request_id, const char *code, const char *message)
{
    serial_printf(
        "{\"type\":\"error\",\"id\":%lu,\"ok\":false,"
        "\"code\":\"%s\",\"message\":\"%s\"}\n",
        (unsigned long)request_id,
        code,
        message
    );
}

static void send_info(uint32_t request_id)
{
    serial_printf(
        "{\"type\":\"hello\",\"id\":%lu,\"ok\":true,"
        "\"protocol\":%d,\"firmware\":\"%s\","
        "\"board\":\"MindReset Quote/0\",\"panel\":\"UC8251D\","
        "\"width\":%d,\"height\":%d,\"frameBytes\":%d,"
        "\"rotations\":[90,270],"
        "\"flashBytes\":4194304,"
        "\"capabilities\":{\"deviceConfig\":true,"
        "\"partialRefresh\":true,\"wifiSwitch\":true,"
        "\"bluetoothSwitch\":true},"
        "\"maxPartialRefreshes\":%u,"
        "\"sensors\":[\"battery_mv\",\"battery_percent\","
        "\"chip_temperature_c\",\"vbus_present\",\"uptime_s\","
        "\"free_heap\"]}\n",
        (unsigned long)request_id,
        PROTOCOL_VERSION,
        FIRMWARE_VERSION,
        EPD_LANDSCAPE_WIDTH,
        EPD_LANDSCAPE_HEIGHT,
        EPD_FRAME_BYTES,
        MAX_PARTIAL_REFRESHES
    );
}

static void send_config(uint32_t request_id)
{
    device_config_t config;
    device_config_get(&config);
    serial_printf(
        "{\"type\":\"config\",\"id\":%lu,\"ok\":true,"
        "\"wifiEnabled\":%s,\"bluetoothEnabled\":%s,"
        "\"wifiActive\":%s,\"bluetoothActive\":%s,"
        "\"dataRefreshMs\":%lu,\"screenRefreshMs\":%lu,"
        "\"fullRefreshMs\":%lu,\"partialRefreshEnabled\":%s,"
        "\"limits\":{\"dataMinMs\":%u,\"screenMinMs\":%u,"
        "\"fullMinMs\":%u,\"maxMs\":%u}}\n",
        (unsigned long)request_id,
        config.wifi_enabled ? "true" : "false",
        config.bluetooth_enabled ? "true" : "false",
        radios_wifi_active() ? "true" : "false",
        radios_bluetooth_active() ? "true" : "false",
        (unsigned long)config.data_refresh_ms,
        (unsigned long)config.screen_refresh_ms,
        (unsigned long)config.full_refresh_ms,
        config.partial_refresh_enabled ? "true" : "false",
        DEVICE_DATA_REFRESH_MIN_MS,
        DEVICE_SCREEN_REFRESH_MIN_MS,
        DEVICE_FULL_REFRESH_MIN_MS,
        DEVICE_REFRESH_MAX_MS
    );
}

static void set_config(const char *line)
{
    unsigned long request_id = 0;
    unsigned int wifi_enabled = 0;
    unsigned int bluetooth_enabled = 0;
    unsigned long data_refresh_ms = 0;
    unsigned long screen_refresh_ms = 0;
    unsigned long full_refresh_ms = 0;
    unsigned int partial_refresh_enabled = 0;

    if (sscanf(
            line,
            "SET_CONFIG %lu %u %u %lu %lu %lu %u",
            &request_id,
            &wifi_enabled,
            &bluetooth_enabled,
            &data_refresh_ms,
            &screen_refresh_ms,
            &full_refresh_ms,
            &partial_refresh_enabled
        ) != 7 || wifi_enabled > 1 || bluetooth_enabled > 1 ||
        partial_refresh_enabled > 1) {
        send_error(
            (uint32_t)request_id,
            "BAD_CONFIG",
            "expected SET_CONFIG id wifi bluetooth data_ms screen_ms full_ms partial"
        );
        return;
    }

    const device_config_t candidate = {
        .wifi_enabled = wifi_enabled != 0,
        .bluetooth_enabled = bluetooth_enabled != 0,
        .partial_refresh_enabled = partial_refresh_enabled != 0,
        .data_refresh_ms = (uint32_t)data_refresh_ms,
        .screen_refresh_ms = (uint32_t)screen_refresh_ms,
        .full_refresh_ms = (uint32_t)full_refresh_ms,
    };
    if (!device_config_is_valid(&candidate)) {
        send_error(
            (uint32_t)request_id,
            "BAD_CONFIG_RANGE",
            "refresh interval is outside the supported range"
        );
        return;
    }

    device_config_t previous;
    device_config_get(&previous);
    esp_err_t result = radios_apply(&candidate);
    if (result != ESP_OK) {
        (void)radios_apply(&previous);
        serial_printf(
            "{\"type\":\"config\",\"id\":%lu,\"ok\":false,"
            "\"code\":\"RADIO_FAILED\",\"espError\":%d}\n",
            request_id,
            (int)result
        );
        return;
    }
    result = device_config_save(&candidate);
    if (result != ESP_OK) {
        (void)radios_apply(&previous);
        serial_printf(
            "{\"type\":\"config\",\"id\":%lu,\"ok\":false,"
            "\"code\":\"CONFIG_SAVE_FAILED\",\"espError\":%d}\n",
            request_id,
            (int)result
        );
        return;
    }
    send_config((uint32_t)request_id);
}

static void send_sensors(uint32_t request_id)
{
    sensor_snapshot_t snapshot;
    sensors_read(&snapshot);

    char battery_mv[24];
    char battery_percent[24];
    char temperature[32];
    if (snapshot.battery_valid) {
        snprintf(battery_mv, sizeof(battery_mv), "%d", snapshot.battery_mv);
        snprintf(
            battery_percent,
            sizeof(battery_percent),
            "%d",
            snapshot.battery_percent
        );
    } else {
        strcpy(battery_mv, "null");
        strcpy(battery_percent, "null");
    }
    if (snapshot.temperature_valid) {
        snprintf(
            temperature,
            sizeof(temperature),
            "%.2f",
            (double)snapshot.chip_temperature_c
        );
    } else {
        strcpy(temperature, "null");
    }

    serial_printf(
        "{\"type\":\"sensors\",\"id\":%lu,\"ok\":true,\"values\":{"
        "\"battery_mv\":%s,\"battery_percent\":%s,"
        "\"chip_temperature_c\":%s,\"vbus_present\":%s,"
        "\"uptime_s\":%lu,\"free_heap\":%lu}}\n",
        (unsigned long)request_id,
        battery_mv,
        battery_percent,
        temperature,
        snapshot.vbus_present ? "true" : "false",
        (unsigned long)snapshot.uptime_s,
        (unsigned long)snapshot.free_heap
    );
}

static void finish_frame(void)
{
    const uint32_t actual_crc = ink_crc32(s_frame, s_frame_state.expected_length);
    const uint32_t request_id = s_frame_state.request_id;
    const epd_rotation_t rotation = s_frame_state.rotation;
    const bool request_partial = s_frame_state.request_partial;
    const uint32_t expected_crc = s_frame_state.expected_crc;
    memset(&s_frame_state, 0, sizeof(s_frame_state));

    if (actual_crc != expected_crc) {
        send_error(request_id, "CRC_MISMATCH", "frame checksum mismatch");
        return;
    }

    device_config_t config;
    device_config_get(&config);
    const int64_t now = esp_timer_get_time();
    const bool full_refresh_due =
        s_last_full_refresh_us == 0 ||
        now - s_last_full_refresh_us >= (int64_t)config.full_refresh_ms * 1000;
    const bool allow_partial =
        request_partial && config.partial_refresh_enabled &&
        !full_refresh_due && s_partial_refresh_count < MAX_PARTIAL_REFRESHES;

    const int64_t started = now;
    epd_refresh_result_t refresh = {0};
    const esp_err_t result = epd_display_landscape_update(
        s_frame,
        rotation,
        allow_partial,
        &refresh
    );
    const uint32_t elapsed_ms = (uint32_t)((esp_timer_get_time() - started) / 1000);
    if (result != ESP_OK) {
        serial_printf(
            "{\"type\":\"frame\",\"id\":%lu,\"ok\":false,"
            "\"code\":\"DISPLAY_FAILED\",\"espError\":%d}\n",
            (unsigned long)request_id,
            (int)result
        );
        return;
    }

    const char *mode = "none";
    if (refresh.mode == EPD_REFRESH_FULL) {
        mode = "full";
        s_last_full_refresh_us = esp_timer_get_time();
        s_partial_refresh_count = 0;
    } else if (refresh.mode == EPD_REFRESH_PARTIAL) {
        mode = "partial";
        ++s_partial_refresh_count;
    }

    serial_printf(
        "{\"type\":\"frame\",\"id\":%lu,\"ok\":true,"
        "\"crc32\":\"%08lx\",\"refreshMs\":%lu,"
        "\"mode\":\"%s\",\"region\":{\"x\":%d,\"y\":%d,"
        "\"width\":%d,\"height\":%d},\"partialCount\":%lu}\n",
        (unsigned long)request_id,
        (unsigned long)actual_crc,
        (unsigned long)elapsed_ms,
        mode,
        refresh.x,
        refresh.y,
        refresh.width,
        refresh.height,
        (unsigned long)s_partial_refresh_count
    );
}

static void begin_frame(const char *line)
{
    unsigned long request_id = 0;
    unsigned long length = 0;
    unsigned long expected_crc = 0;
    int rotation = 0;
    char mode[12] = "full";

    const int parsed = sscanf(
            line,
            "FRAME %lu %lu %lx %d %11s",
            &request_id,
            &length,
            &expected_crc,
            &rotation,
            mode
        );
    if (parsed != 4 && parsed != 5) {
        send_error(0, "BAD_FRAME_HEADER", "expected FRAME id length crc rotation mode");
        return;
    }
    if (length != EPD_FRAME_BYTES) {
        send_error((uint32_t)request_id, "BAD_FRAME_SIZE", "frame must be 5624 bytes");
        return;
    }
    if (strcmp(mode, "full") != 0 && strcmp(mode, "partial") != 0 &&
        strcmp(mode, "auto") != 0) {
        send_error((uint32_t)request_id, "BAD_REFRESH_MODE", "mode must be full or partial");
        return;
    }
    if (rotation != EPD_ROTATE_90 && rotation != EPD_ROTATE_270) {
        send_error((uint32_t)request_id, "BAD_ROTATION", "rotation must be 90 or 270");
        return;
    }

    s_frame_state = (frame_receive_state_t){
        .active = true,
        .request_id = (uint32_t)request_id,
        .expected_crc = (uint32_t)expected_crc,
        .expected_length = (size_t)length,
        .received_length = 0,
        .rotation = (epd_rotation_t)rotation,
        .request_partial = strcmp(mode, "full") != 0,
        .last_byte_time_us = esp_timer_get_time(),
    };
    serial_printf(
        "{\"type\":\"ready\",\"id\":%lu,\"ok\":true,\"bytes\":%lu}\n",
        request_id,
        length
    );
}

static uint32_t parse_request_id(const char *line)
{
    const char *space = strchr(line, ' ');
    if (space == NULL) {
        return 0;
    }
    unsigned long id = 0;
    return sscanf(space + 1, "%lu", &id) == 1 ? (uint32_t)id : 0;
}

static void handle_line(char *line)
{
    while (*line == ' ' || *line == '\t') {
        ++line;
    }
    if (*line == '\0') {
        return;
    }

    if (strncmp(line, "FRAME ", 6) == 0) {
        begin_frame(line);
        return;
    }

    const uint32_t request_id = parse_request_id(line);
    if (strncmp(line, "HELLO ", 6) == 0 || strncmp(line, "INFO ", 5) == 0) {
        send_info(request_id);
    } else if (strncmp(line, "PING ", 5) == 0) {
        serial_printf(
            "{\"type\":\"pong\",\"id\":%lu,\"ok\":true}\n",
            (unsigned long)request_id
        );
    } else if (strncmp(line, "SENSORS ", 8) == 0) {
        send_sensors(request_id);
    } else if (strncmp(line, "CONFIG ", 7) == 0) {
        send_config(request_id);
    } else if (strncmp(line, "SET_CONFIG ", 11) == 0) {
        set_config(line);
    } else if (strncmp(line, "CLEAR ", 6) == 0) {
        const int64_t started = esp_timer_get_time();
        const esp_err_t result = epd_clear();
        serial_printf(
            "{\"type\":\"clear\",\"id\":%lu,\"ok\":%s,"
            "\"espError\":%d,\"refreshMs\":%lu}\n",
            (unsigned long)request_id,
            result == ESP_OK ? "true" : "false",
            (int)result,
            (unsigned long)((esp_timer_get_time() - started) / 1000)
        );
        if (result == ESP_OK) {
            s_last_full_refresh_us = esp_timer_get_time();
            s_partial_refresh_count = 0;
        }
    } else {
        send_error(request_id, "UNKNOWN_COMMAND", "unknown command");
    }
}

static void consume_bytes(const uint8_t *data, size_t length)
{
    size_t offset = 0;
    while (offset < length) {
        if (s_frame_state.active) {
            const size_t remaining =
                s_frame_state.expected_length - s_frame_state.received_length;
            const size_t available = length - offset;
            const size_t take = remaining < available ? remaining : available;
            memcpy(s_frame + s_frame_state.received_length, data + offset, take);
            s_frame_state.received_length += take;
            s_frame_state.last_byte_time_us = esp_timer_get_time();
            offset += take;

            if (s_frame_state.received_length == s_frame_state.expected_length) {
                finish_frame();
            }
            continue;
        }

        const uint8_t byte = data[offset++];
        if (byte == '\r') {
            continue;
        }
        if (byte == '\n') {
            s_line[s_line_length] = '\0';
            handle_line(s_line);
            s_line_length = 0;
            continue;
        }
        if (byte >= 0x20 && byte <= 0x7e) {
            if (s_line_length + 1 < sizeof(s_line)) {
                s_line[s_line_length++] = (char)byte;
            } else {
                s_line_length = 0;
                send_error(0, "LINE_TOO_LONG", "command line too long");
            }
        }
    }
}

esp_err_t protocol_run(void)
{
    usb_serial_jtag_driver_config_t usb_config = {
        .tx_buffer_size = 2048,
        .rx_buffer_size = 8192,
    };
    ESP_RETURN_ON_ERROR(
        usb_serial_jtag_driver_install(&usb_config),
        "protocol",
        "usb serial jtag"
    );

    uint8_t chunk[RX_CHUNK_SIZE];
    while (true) {
        const int received = usb_serial_jtag_read_bytes(
            chunk,
            sizeof(chunk),
            pdMS_TO_TICKS(100)
        );
        if (received > 0) {
            consume_bytes(chunk, (size_t)received);
        }

        if (s_frame_state.active &&
            esp_timer_get_time() - s_frame_state.last_byte_time_us >
                FRAME_RECEIVE_TIMEOUT_US) {
            const uint32_t request_id = s_frame_state.request_id;
            memset(&s_frame_state, 0, sizeof(s_frame_state));
            send_error(request_id, "FRAME_TIMEOUT", "frame transfer timed out");
        }
    }
}
