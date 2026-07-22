#include "radios.h"

#include "esp_bt.h"
#include "esp_wifi.h"

static bool s_wifi_initialized;
static bool s_wifi_active;

static esp_err_t set_wifi(bool enabled)
{
    if (enabled) {
        if (!s_wifi_initialized) {
            const wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
            esp_err_t result = esp_wifi_init(&init_config);
            if (result != ESP_OK) {
                return result;
            }
            s_wifi_initialized = true;
            result = esp_wifi_set_mode(WIFI_MODE_STA);
            if (result != ESP_OK) {
                (void)esp_wifi_deinit();
                s_wifi_initialized = false;
                return result;
            }
        }
        if (!s_wifi_active) {
            const esp_err_t result = esp_wifi_start();
            if (result != ESP_OK) {
                return result;
            }
            s_wifi_active = true;
        }
        return ESP_OK;
    }

    if (s_wifi_active) {
        const esp_err_t result = esp_wifi_stop();
        if (result != ESP_OK) {
            return result;
        }
        s_wifi_active = false;
    }
    if (s_wifi_initialized) {
        const esp_err_t result = esp_wifi_deinit();
        if (result != ESP_OK) {
            return result;
        }
        s_wifi_initialized = false;
    }
    return ESP_OK;
}

static esp_err_t set_bluetooth(bool enabled)
{
    esp_bt_controller_status_t status = esp_bt_controller_get_status();
    if (enabled) {
        if (status == ESP_BT_CONTROLLER_STATUS_IDLE) {
            esp_bt_controller_config_t controller_config =
                BT_CONTROLLER_INIT_CONFIG_DEFAULT();
            esp_err_t result = esp_bt_controller_init(&controller_config);
            if (result != ESP_OK) {
                return result;
            }
            status = esp_bt_controller_get_status();
        }
        if (status == ESP_BT_CONTROLLER_STATUS_INITED) {
            return esp_bt_controller_enable(ESP_BT_MODE_BLE);
        }
        return status == ESP_BT_CONTROLLER_STATUS_ENABLED
            ? ESP_OK
            : ESP_ERR_INVALID_STATE;
    }

    if (status == ESP_BT_CONTROLLER_STATUS_ENABLED) {
        const esp_err_t result = esp_bt_controller_disable();
        if (result != ESP_OK) {
            return result;
        }
        status = esp_bt_controller_get_status();
    }
    if (status == ESP_BT_CONTROLLER_STATUS_INITED) {
        return esp_bt_controller_deinit();
    }
    return status == ESP_BT_CONTROLLER_STATUS_IDLE
        ? ESP_OK
        : ESP_ERR_INVALID_STATE;
}

esp_err_t radios_apply(const device_config_t *config)
{
    if (config == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t result = set_wifi(config->wifi_enabled);
    if (result != ESP_OK) {
        return result;
    }
    result = set_bluetooth(config->bluetooth_enabled);
    if (result != ESP_OK) {
        return result;
    }
    return ESP_OK;
}

bool radios_wifi_active(void)
{
    return s_wifi_active;
}

bool radios_bluetooth_active(void)
{
    return esp_bt_controller_get_status() == ESP_BT_CONTROLLER_STATUS_ENABLED;
}
