#include "device_config.h"

#include <string.h>

#include "nvs.h"
#include "nvs_flash.h"

#define CONFIG_NAMESPACE "inklink"
#define CONFIG_KEY "config"

typedef struct {
    uint32_t schema_version;
    uint8_t wifi_enabled;
    uint8_t bluetooth_enabled;
    uint8_t partial_refresh_enabled;
    uint8_t reserved;
    uint32_t data_refresh_ms;
    uint32_t screen_refresh_ms;
    uint32_t full_refresh_ms;
} stored_config_t;

static device_config_t s_config;

static device_config_t default_config(void)
{
    return (device_config_t){
        .wifi_enabled = false,
        .bluetooth_enabled = false,
        .partial_refresh_enabled = true,
        .data_refresh_ms = 30000,
        .screen_refresh_ms = 60000,
        .full_refresh_ms = 1800000,
    };
}

bool device_config_is_valid(const device_config_t *config)
{
    if (config == NULL) {
        return false;
    }
    if (config->data_refresh_ms < DEVICE_DATA_REFRESH_MIN_MS ||
        config->data_refresh_ms > DEVICE_REFRESH_MAX_MS) {
        return false;
    }
    if (config->screen_refresh_ms < DEVICE_SCREEN_REFRESH_MIN_MS ||
        config->screen_refresh_ms > DEVICE_REFRESH_MAX_MS) {
        return false;
    }
    if (config->full_refresh_ms < DEVICE_FULL_REFRESH_MIN_MS ||
        config->full_refresh_ms > DEVICE_REFRESH_MAX_MS) {
        return false;
    }
    return config->full_refresh_ms >= config->screen_refresh_ms;
}

static stored_config_t to_stored(const device_config_t *config)
{
    return (stored_config_t){
        .schema_version = DEVICE_CONFIG_SCHEMA_VERSION,
        .wifi_enabled = config->wifi_enabled ? 1 : 0,
        .bluetooth_enabled = config->bluetooth_enabled ? 1 : 0,
        .partial_refresh_enabled = config->partial_refresh_enabled ? 1 : 0,
        .data_refresh_ms = config->data_refresh_ms,
        .screen_refresh_ms = config->screen_refresh_ms,
        .full_refresh_ms = config->full_refresh_ms,
    };
}

static bool from_stored(const stored_config_t *stored, device_config_t *config)
{
    if (stored->schema_version != DEVICE_CONFIG_SCHEMA_VERSION ||
        stored->wifi_enabled > 1 || stored->bluetooth_enabled > 1 ||
        stored->partial_refresh_enabled > 1) {
        return false;
    }

    *config = (device_config_t){
        .wifi_enabled = stored->wifi_enabled != 0,
        .bluetooth_enabled = stored->bluetooth_enabled != 0,
        .partial_refresh_enabled = stored->partial_refresh_enabled != 0,
        .data_refresh_ms = stored->data_refresh_ms,
        .screen_refresh_ms = stored->screen_refresh_ms,
        .full_refresh_ms = stored->full_refresh_ms,
    };
    return device_config_is_valid(config);
}

esp_err_t device_config_init(void)
{
    s_config = default_config();

    esp_err_t result = nvs_flash_init();
    if (result == ESP_ERR_NVS_NO_FREE_PAGES || result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        result = nvs_flash_erase();
        if (result != ESP_OK) {
            return result;
        }
        result = nvs_flash_init();
    }
    if (result != ESP_OK) {
        return result;
    }

    nvs_handle_t handle;
    result = nvs_open(CONFIG_NAMESPACE, NVS_READONLY, &handle);
    if (result == ESP_ERR_NVS_NOT_FOUND) {
        return ESP_OK;
    }
    if (result != ESP_OK) {
        return result;
    }

    stored_config_t stored = {0};
    size_t length = sizeof(stored);
    result = nvs_get_blob(handle, CONFIG_KEY, &stored, &length);
    nvs_close(handle);
    if (result == ESP_ERR_NVS_NOT_FOUND) {
        return ESP_OK;
    }
    if (result != ESP_OK) {
        return result;
    }
    if (length == sizeof(stored)) {
        device_config_t loaded;
        if (from_stored(&stored, &loaded)) {
            s_config = loaded;
        }
    }
    return ESP_OK;
}

void device_config_get(device_config_t *config)
{
    if (config != NULL) {
        *config = s_config;
    }
}

esp_err_t device_config_save(const device_config_t *config)
{
    if (!device_config_is_valid(config)) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t result = nvs_open(CONFIG_NAMESPACE, NVS_READWRITE, &handle);
    if (result != ESP_OK) {
        return result;
    }

    const stored_config_t stored = to_stored(config);
    result = nvs_set_blob(handle, CONFIG_KEY, &stored, sizeof(stored));
    if (result == ESP_OK) {
        result = nvs_commit(handle);
    }
    nvs_close(handle);
    if (result == ESP_OK) {
        s_config = *config;
    }
    return result;
}
