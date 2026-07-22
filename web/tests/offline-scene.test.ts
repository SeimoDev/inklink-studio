import { describe, expect, it } from "vitest";

import { FRAME_BYTES } from "../src/core/types";
import {
  encodeOfflineScene,
  OfflineSensorId,
  OFFLINE_SCENE_MAGIC,
  OFFLINE_SCENE_VERSION,
} from "../src/device/offline-scene";

describe("encodeOfflineScene", () => {
  it("encodes a versioned frame, glyph atlas, and sensor layer", () => {
    const encoded = encodeOfflineScene({
      rotation: 270,
      baseFrame: new Uint8Array(FRAME_BYTES).fill(0xff),
      fonts: [{
        height: 2,
        glyphs: [{
          codePoint: "7".codePointAt(0)!,
          width: 1,
          advance: 2,
          bits: new Uint8Array([0x80, 0x80]),
        }],
      }],
      layers: [{
        sensorId: OfflineSensorId.BatteryPercent,
        fontIndex: 0,
        x: 12,
        y: 34,
        padding: 2,
        foreground: 0,
        background: 1,
        decimals: 0,
        prefix: "B",
        suffix: "%",
        fallback: "--",
        staticValue: "",
      }],
    });

    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    expect(view.getUint32(0, true)).toBe(OFFLINE_SCENE_MAGIC);
    expect(view.getUint16(4, true)).toBe(OFFLINE_SCENE_VERSION);
    expect(view.getUint16(8, true)).toBe(270);
    expect(view.getUint8(10)).toBe(1);
    expect(view.getUint8(11)).toBe(1);
    expect(view.getUint16(12, true)).toBe(FRAME_BYTES);
    expect(encoded.subarray(16, 16 + FRAME_BYTES).every((byte) => byte === 0xff)).toBe(true);
    expect(encoded).toHaveLength(5678);
  });

  it("rejects a malformed base frame", () => {
    expect(() => encodeOfflineScene({
      rotation: 90,
      baseFrame: new Uint8Array(1),
      fonts: [],
      layers: [],
    })).toThrow("底图长度错误");
  });
});
