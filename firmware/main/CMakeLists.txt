idf_component_register(
    SRCS
        "app_main.c"
        "crc32.c"
        "device_config.c"
        "epd_uc8251.c"
        "protocol.c"
        "radios.c"
        "sensors.c"
    INCLUDE_DIRS "."
    REQUIRES bt driver esp_adc esp_timer esp_system esp_wifi nvs_flash
)
