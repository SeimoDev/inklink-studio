#pragma once

#include "driver/gpio.h"
#include "esp_adc/adc_oneshot.h"

/*
 * MindReset Quote/0 board mapping recovered from the original firmware.
 * Panel: UC8251D, native 152 x 296, four-wire SPI at 15 MHz.
 */
#define BOARD_EPD_BUSY_GPIO GPIO_NUM_3
#define BOARD_EPD_RESET_GPIO GPIO_NUM_4
#define BOARD_EPD_DC_GPIO GPIO_NUM_5
#define BOARD_EPD_CS_GPIO GPIO_NUM_6
#define BOARD_EPD_MOSI_GPIO GPIO_NUM_7
#define BOARD_EPD_SCLK_GPIO GPIO_NUM_10
#define BOARD_EPD_POWER_GPIO GPIO_NUM_20

#define BOARD_VBUS_GPIO GPIO_NUM_0
#define BOARD_BATTERY_ADC_CHANNEL ADC_CHANNEL_1 /* GPIO1 */

#define BOARD_EPD_SPI_CLOCK_HZ 15000000
