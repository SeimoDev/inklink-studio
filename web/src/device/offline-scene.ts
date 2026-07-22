import {
  FRAME_BYTES,
  type ScreenRotation,
  type SensorLayer,
  type SensorValues,
} from "../core/types";
import { formatSensorValue } from "./sensors";

export const OFFLINE_SCENE_MAGIC = 0x534b4e49; // "INKS" in little-endian order.
export const OFFLINE_SCENE_VERSION = 1;
export const OFFLINE_SCENE_MAX_BYTES = 64 * 1024;

export enum OfflineSensorId {
  BatteryMillivolts = 0,
  BatteryPercent = 1,
  ChipTemperature = 2,
  VbusPresent = 3,
  UptimeSeconds = 4,
  FreeHeap = 5,
  StaticValue = 255,
}

export interface OfflineGlyph {
  codePoint: number;
  width: number;
  advance: number;
  bits: Uint8Array;
}

export interface OfflineFont {
  height: number;
  glyphs: OfflineGlyph[];
}

export interface OfflineLayer {
  sensorId: OfflineSensorId;
  fontIndex: number;
  x: number;
  y: number;
  padding: number;
  foreground: 0 | 1;
  background: 0 | 1 | 2;
  decimals: number;
  prefix: string;
  suffix: string;
  fallback: string;
  staticValue: string;
}

export interface OfflineScene {
  rotation: ScreenRotation;
  baseFrame: Uint8Array;
  fonts: OfflineFont[];
  layers: OfflineLayer[];
}

const SENSOR_IDS: Readonly<Record<string, OfflineSensorId>> = {
  battery_mv: OfflineSensorId.BatteryMillivolts,
  battery_percent: OfflineSensorId.BatteryPercent,
  chip_temperature_c: OfflineSensorId.ChipTemperature,
  vbus_present: OfflineSensorId.VbusPresent,
  uptime_s: OfflineSensorId.UptimeSeconds,
  free_heap: OfflineSensorId.FreeHeap,
};

const DYNAMIC_CHARACTERS = "0123456789.-+ 未连接已天小时分秒是否";

class BinaryWriter {
  private readonly data = new Uint8Array(OFFLINE_SCENE_MAX_BYTES);
  private readonly view = new DataView(this.data.buffer);
  private offset = 0;

  private reserve(length: number): void {
    if (this.offset + length > this.data.length) {
      throw new Error("离线场景超过 64 KB，请减少传感器图层、字号或字体种类");
    }
  }

  u8(value: number): void {
    this.reserve(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  u16(value: number): void {
    this.reserve(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  i16(value: number): void {
    this.reserve(2);
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
  }

  u32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  bytes(value: Uint8Array): void {
    this.reserve(value.length);
    this.data.set(value, this.offset);
    this.offset += value.length;
  }

  finish(): Uint8Array {
    return this.data.slice(0, this.offset);
  }
}

function encoded(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function encodeOfflineScene(scene: OfflineScene): Uint8Array {
  if (scene.baseFrame.length !== FRAME_BYTES) throw new Error("离线场景底图长度错误");
  if (scene.fonts.length > 8) throw new Error("离线场景最多使用 8 种字体");
  if (scene.layers.length > 32) throw new Error("离线场景最多包含 32 个传感器图层");

  const writer = new BinaryWriter();
  writer.u32(OFFLINE_SCENE_MAGIC);
  writer.u16(OFFLINE_SCENE_VERSION);
  writer.u16(16);
  writer.u16(scene.rotation);
  writer.u8(scene.fonts.length);
  writer.u8(scene.layers.length);
  writer.u16(FRAME_BYTES);
  writer.u16(0);
  writer.bytes(scene.baseFrame);

  for (const font of scene.fonts) {
    if (font.height < 1 || font.height > 120 || font.glyphs.length > 128) {
      throw new Error("离线字体尺寸或字形数量超出限制");
    }
    writer.u16(font.height);
    writer.u16(font.glyphs.length);
    for (const glyph of font.glyphs) {
      const expected = Math.ceil(glyph.width / 8) * font.height;
      if (
        glyph.codePoint < 0 || glyph.codePoint > 0x10ffff ||
        glyph.width < 1 || glyph.width > 192 ||
        glyph.advance < 0 || glyph.advance > 192 ||
        glyph.bits.length !== expected
      ) {
        throw new Error("离线字形数据无效");
      }
      writer.u32(glyph.codePoint);
      writer.u16(glyph.width);
      writer.u16(glyph.advance);
      writer.u16(glyph.bits.length);
      writer.bytes(glyph.bits);
    }
  }

  for (const layer of scene.layers) {
    if (layer.fontIndex < 0 || layer.fontIndex >= scene.fonts.length) {
      throw new Error("离线图层引用了无效字体");
    }
    const fields = [
      encoded(layer.prefix),
      encoded(layer.suffix),
      encoded(layer.fallback),
      encoded(layer.staticValue),
    ];
    if (fields.some((field) => field.length > 1024)) {
      throw new Error("离线图层文字过长");
    }
    writer.u8(layer.sensorId);
    writer.u8(layer.fontIndex);
    writer.i16(layer.x);
    writer.i16(layer.y);
    writer.u8(layer.padding);
    writer.u8(layer.foreground);
    writer.u8(layer.background);
    writer.u8(layer.decimals);
    for (const field of fields) writer.u16(field.length);
    for (const field of fields) writer.bytes(field);
  }
  return writer.finish();
}

function rasterizeGlyph(
  font: string,
  height: number,
  character: string,
): OfflineGlyph {
  const canvas = document.createElement("canvas");
  const measuring = canvas.getContext("2d", { willReadFrequently: true });
  if (!measuring) throw new Error("浏览器无法生成离线字体");
  measuring.font = font;
  measuring.textBaseline = "top";
  const metrics = measuring.measureText(character);
  const advance = Math.max(1, Math.ceil(metrics.width));
  const width = Math.max(advance, Math.ceil(metrics.actualBoundingBoxRight || 0), 1);
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法生成离线字体");
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  context.font = font;
  context.textBaseline = "top";
  context.fillStyle = "black";
  context.fillText(character, 0, 0);

  const pixels = context.getImageData(0, 0, width, height).data;
  const stride = Math.ceil(width / 8);
  const bits = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * 4;
      const luminance =
        0.2126 * (pixels[pixel] ?? 255) +
        0.7152 * (pixels[pixel + 1] ?? 255) +
        0.0722 * (pixels[pixel + 2] ?? 255);
      if (luminance < 128) bits[y * stride + Math.floor(x / 8)]! |= 0x80 >> (x % 8);
    }
  }
  return { codePoint: character.codePointAt(0)!, width, advance, bits };
}

function sensorId(key: string): OfflineSensorId {
  return SENSOR_IDS[key] ?? OfflineSensorId.StaticValue;
}

function backgroundId(background: SensorLayer["background"]): 0 | 1 | 2 {
  if (background === "white") return 1;
  if (background === "black") return 2;
  return 0;
}

export function buildOfflineScene(
  baseFrame: Uint8Array,
  rotation: ScreenRotation,
  sensorLayers: SensorLayer[],
  sensorValues: SensorValues,
): Uint8Array {
  const fontIndexes = new Map<string, number>();
  const fontCharacters: Array<Set<string>> = [];
  const fontStyles: Array<{ css: string; height: number }> = [];

  for (const layer of sensorLayers) {
    const key = `${layer.bold ? 700 : 400}|${layer.fontSize}|${layer.fontFamily}`;
    let index = fontIndexes.get(key);
    if (index === undefined) {
      index = fontStyles.length;
      if (index >= 8) throw new Error("离线传感器图层最多使用 8 种字体样式");
      fontIndexes.set(key, index);
      fontStyles.push({
        css: `${layer.bold ? 700 : 400} ${layer.fontSize}px ${layer.fontFamily}`,
        height: Math.ceil(layer.fontSize * 1.22),
      });
      fontCharacters.push(new Set());
    }
    const current = formatSensorValue(layer.sensorKey, sensorValues[layer.sensorKey], layer.decimals)
      ?? layer.fallback;
    for (const character of Array.from(
      `${DYNAMIC_CHARACTERS}${layer.prefix}${layer.suffix}${layer.fallback}${current}`,
    )) {
      fontCharacters[index]!.add(character);
    }
  }

  const fonts = fontStyles.map((style, index): OfflineFont => ({
    height: style.height,
    glyphs: [...fontCharacters[index]!]
      .sort((left, right) => left.codePointAt(0)! - right.codePointAt(0)!)
      .map((character) => rasterizeGlyph(style.css, style.height, character)),
  }));

  const layers = sensorLayers.map((layer): OfflineLayer => {
    const fontKey = `${layer.bold ? 700 : 400}|${layer.fontSize}|${layer.fontFamily}`;
    const id = sensorId(layer.sensorKey);
    return {
      sensorId: id,
      fontIndex: fontIndexes.get(fontKey)!,
      x: layer.x,
      y: layer.y,
      padding: layer.padding,
      foreground: layer.color === "white" ? 1 : 0,
      background: backgroundId(layer.background),
      decimals: layer.decimals,
      prefix: layer.prefix,
      suffix: layer.suffix,
      fallback: layer.fallback,
      staticValue: id === OfflineSensorId.StaticValue
        ? formatSensorValue(layer.sensorKey, sensorValues[layer.sensorKey], layer.decimals)
          ?? layer.fallback
        : "",
    };
  });

  return encodeOfflineScene({ rotation, baseFrame, fonts, layers });
}
