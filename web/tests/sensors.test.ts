import { describe, expect, it } from "vitest";

import {
  formatSensorReading,
  formatSensorValue,
  hasLegacyBatteryFormatting,
  parseSensorValues,
  sensorLayerDefaults,
  sensorSupportsDecimals,
} from "../src/device/sensors";

describe("sensor presentation", () => {
  it("uses source-specific layer defaults", () => {
    expect(sensorLayerDefaults("battery_percent")).toMatchObject({
      prefix: "电量 ",
      suffix: "%",
      decimals: 0,
    });
    expect(sensorLayerDefaults("chip_temperature_c")).toMatchObject({
      prefix: "芯片温度 ",
      suffix: "°C",
      decimals: 1,
    });
    expect(sensorLayerDefaults("free_heap")).toMatchObject({
      prefix: "可用内存 ",
      suffix: " KB",
      decimals: 1,
    });
  });

  it("converts raw protocol units for display", () => {
    expect(formatSensorValue("battery_mv", 4142, 2)).toBe("4.14");
    expect(formatSensorReading("battery_mv", 4142)).toBe("4.14 V");
    expect(formatSensorReading("free_heap", 287404)).toBe("280.7 KB");
    expect(formatSensorReading("chip_temperature_c", 44.47)).toBe("44.5°C");
  });

  it("formats states and durations as readable text", () => {
    expect(formatSensorReading("vbus_present", true)).toBe("已连接");
    expect(formatSensorReading("vbus_present", false)).toBe("未连接");
    expect(formatSensorReading("uptime_s", 65)).toBe("1分 5秒");
    expect(formatSensorReading("uptime_s", 3665)).toBe("1小时 1分");
    expect(sensorSupportsDecimals("vbus_present")).toBe(false);
    expect(sensorSupportsDecimals("uptime_s")).toBe(false);
  });

  it("rejects malformed protocol values instead of coercing them", () => {
    expect(
      parseSensorValues({
        battery_percent: 93,
        vbus_present: true,
        missing: null,
        bad_number: Number.NaN,
        numeric_string: "93",
      }),
    ).toEqual({ battery_percent: 93, vbus_present: true, missing: null });
  });

  it("detects projects created with the old battery-only defaults", () => {
    expect(hasLegacyBatteryFormatting("chip_temperature_c", "电量 ", "%", 0)).toBe(true);
    expect(hasLegacyBatteryFormatting("battery_percent", "电量 ", "%", 0)).toBe(false);
  });
});
