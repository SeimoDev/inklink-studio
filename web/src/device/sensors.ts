import type { SensorValues } from "../core/types";

export interface SensorLayerDefaults {
  prefix: string;
  suffix: string;
  decimals: number;
  fallback: string;
}

type SensorDefinition = SensorLayerDefaults & {
  label: string;
  scale?: number;
  duration?: boolean;
  booleanText?: readonly [whenFalse: string, whenTrue: string];
};

const SENSOR_DEFINITIONS: Record<string, SensorDefinition> = {
  battery_mv: {
    label: "电池电压",
    prefix: "电压 ",
    suffix: " V",
    decimals: 2,
    fallback: "--",
    scale: 1 / 1000,
  },
  battery_percent: {
    label: "剩余电量",
    prefix: "电量 ",
    suffix: "%",
    decimals: 0,
    fallback: "--",
  },
  chip_temperature_c: {
    label: "ESP32 芯片温度",
    prefix: "芯片温度 ",
    suffix: "°C",
    decimals: 1,
    fallback: "--",
  },
  vbus_present: {
    label: "USB 供电状态",
    prefix: "USB供电 ",
    suffix: "",
    decimals: 0,
    fallback: "--",
    booleanText: ["未连接", "已连接"],
  },
  uptime_s: {
    label: "本次启动时长",
    prefix: "运行 ",
    suffix: "",
    decimals: 0,
    fallback: "--",
    duration: true,
  },
  free_heap: {
    label: "ESP32 可用内存",
    prefix: "可用内存 ",
    suffix: " KB",
    decimals: 1,
    fallback: "--",
    scale: 1 / 1024,
  },
};

export const KNOWN_SENSOR_KEYS = Object.freeze(Object.keys(SENSOR_DEFINITIONS));

function formatDuration(secondsValue: number): string {
  const totalSeconds = Math.max(0, Math.floor(secondsValue));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分`;
  if (minutes > 0) return `${minutes}分 ${seconds}秒`;
  return `${seconds}秒`;
}

export function sensorLabel(key: string): string {
  return SENSOR_DEFINITIONS[key]?.label ?? key;
}

export function sensorLayerDefaults(key: string): SensorLayerDefaults {
  const definition = SENSOR_DEFINITIONS[key];
  if (definition) {
    return {
      prefix: definition.prefix,
      suffix: definition.suffix,
      decimals: definition.decimals,
      fallback: definition.fallback,
    };
  }
  return { prefix: `${key} `, suffix: "", decimals: 1, fallback: "--" };
}

export function sensorSupportsDecimals(key: string): boolean {
  const definition = SENSOR_DEFINITIONS[key];
  return definition?.duration !== true && definition?.booleanText === undefined;
}

export function formatSensorValue(
  key: string,
  raw: number | boolean | null | undefined,
  decimals = sensorLayerDefaults(key).decimals,
): string | null {
  if (raw === null || raw === undefined) return null;

  const definition = SENSOR_DEFINITIONS[key];
  if (typeof raw === "boolean") {
    const labels = definition?.booleanText;
    return labels ? labels[raw ? 1 : 0] : raw ? "是" : "否";
  }
  if (!Number.isFinite(raw)) return null;
  if (definition?.duration) return formatDuration(raw);

  const scaled = raw * (definition?.scale ?? 1);
  return scaled.toFixed(Math.max(0, Math.min(4, Math.round(decimals))));
}

export function formatSensorReading(
  key: string,
  raw: number | boolean | null | undefined,
): string {
  const definition = SENSOR_DEFINITIONS[key];
  const value = formatSensorValue(key, raw, definition?.decimals);
  if (value === null) return "—";
  return `${value}${definition?.suffix ?? ""}`;
}

export function parseSensorValues(input: unknown): SensorValues {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};

  const parsed: SensorValues = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      parsed[key] = value;
    }
  }
  return parsed;
}

export function hasLegacyBatteryFormatting(
  key: string,
  prefix: string,
  suffix: string,
  decimals: number,
): boolean {
  return key !== "battery_percent" && prefix === "电量 " && suffix === "%" && decimals === 0;
}
