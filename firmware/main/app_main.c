#include "device_config.h"
#include "protocol.h"
#include "radios.h"
#include "sensors.h"

void app_main(void)
{
    (void)device_config_init();
    device_config_t config;
    device_config_get(&config);
    (void)radios_apply(&config);
    (void)sensors_init();
    (void)protocol_run();
}
