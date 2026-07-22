#include "sensors.h"

#include <math.h>
#include <string.h>

#include "board.h"
#include "driver/gpio.h"
#include "driver/temperature_sensor.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_system.h"
#include "esp_timer.h"

#define BATTERY_SAMPLE_COUNT 16
#define BATTERY_DIVIDER_RATIO 2

static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t s_adc_calibration;
static temperature_sensor_handle_t s_temperature;
static bool s_adc_ready;
static bool s_calibration_ready;
static bool s_temperature_ready;

static int battery_percent_from_mv(int millivolts)
{
    if (millivolts <= 3300) {
        return 0;
    }
    if (millivolts >= 4200) {
        return 100;
    }

    /* A conservative approximation suitable for a UI indicator. */
    return (millivolts - 3300) * 100 / 900;
}

esp_err_t sensors_init(void)
{
    const gpio_config_t vbus_config = {
        .pin_bit_mask = 1ULL << BOARD_VBUS_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    (void)gpio_config(&vbus_config);

    const adc_oneshot_unit_init_cfg_t unit_config = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    if (adc_oneshot_new_unit(&unit_config, &s_adc) == ESP_OK) {
        const adc_oneshot_chan_cfg_t channel_config = {
            .atten = ADC_ATTEN_DB_12,
            .bitwidth = ADC_BITWIDTH_DEFAULT,
        };
        if (adc_oneshot_config_channel(
                s_adc,
                BOARD_BATTERY_ADC_CHANNEL,
                &channel_config
            ) == ESP_OK) {
            s_adc_ready = true;
        }
    }

#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    if (s_adc_ready) {
        const adc_cali_curve_fitting_config_t calibration_config = {
            .unit_id = ADC_UNIT_1,
            .chan = BOARD_BATTERY_ADC_CHANNEL,
            .atten = ADC_ATTEN_DB_12,
            .bitwidth = ADC_BITWIDTH_DEFAULT,
        };
        if (adc_cali_create_scheme_curve_fitting(
                &calibration_config,
                &s_adc_calibration
            ) == ESP_OK) {
            s_calibration_ready = true;
        }
    }
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    if (s_adc_ready) {
        const adc_cali_line_fitting_config_t calibration_config = {
            .unit_id = ADC_UNIT_1,
            .atten = ADC_ATTEN_DB_12,
            .bitwidth = ADC_BITWIDTH_DEFAULT,
            .default_vref = 0,
        };
        if (adc_cali_create_scheme_line_fitting(
                &calibration_config,
                &s_adc_calibration
            ) == ESP_OK) {
            s_calibration_ready = true;
        }
    }
#endif

    temperature_sensor_config_t temperature_config =
        TEMPERATURE_SENSOR_CONFIG_DEFAULT(0, 80);
    if (temperature_sensor_install(&temperature_config, &s_temperature) == ESP_OK &&
        temperature_sensor_enable(s_temperature) == ESP_OK) {
        s_temperature_ready = true;
    }

    return ESP_OK;
}

static bool read_battery_mv(int *battery_mv)
{
    if (!s_adc_ready || battery_mv == NULL) {
        return false;
    }

    int64_t sum = 0;
    int samples = 0;
    for (int i = 0; i < BATTERY_SAMPLE_COUNT; ++i) {
        int raw = 0;
        if (adc_oneshot_read(s_adc, BOARD_BATTERY_ADC_CHANNEL, &raw) == ESP_OK) {
            sum += raw;
            ++samples;
        }
    }
    if (samples == 0) {
        return false;
    }

    const int average_raw = (int)(sum / samples);
    int pin_mv = 0;
    if (s_calibration_ready) {
        if (adc_cali_raw_to_voltage(s_adc_calibration, average_raw, &pin_mv) != ESP_OK) {
            return false;
        }
    } else {
        /* 12-bit fallback approximation at 12 dB attenuation. */
        pin_mv = average_raw * 2500 / 4095;
    }

    *battery_mv = pin_mv * BATTERY_DIVIDER_RATIO;
    return true;
}

void sensors_read(sensor_snapshot_t *snapshot)
{
    if (snapshot == NULL) {
        return;
    }

    memset(snapshot, 0, sizeof(*snapshot));
    snapshot->vbus_present = gpio_get_level(BOARD_VBUS_GPIO) != 0;
    snapshot->uptime_s = (uint32_t)(esp_timer_get_time() / 1000000ULL);
    snapshot->free_heap = esp_get_free_heap_size();

    snapshot->battery_valid = read_battery_mv(&snapshot->battery_mv);
    if (snapshot->battery_valid) {
        snapshot->battery_percent = battery_percent_from_mv(snapshot->battery_mv);
    }

    if (s_temperature_ready) {
        float celsius = NAN;
        if (temperature_sensor_get_celsius(s_temperature, &celsius) == ESP_OK &&
            isfinite(celsius)) {
            snapshot->temperature_valid = true;
            snapshot->chip_temperature_c = celsius;
        }
    }
}

bool sensors_vbus_present(void)
{
    return gpio_get_level(BOARD_VBUS_GPIO) != 0;
}
