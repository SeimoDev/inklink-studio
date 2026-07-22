import { describe, expect, it } from "vitest";

import { FRAME_BYTES, SCREEN_HEIGHT, SCREEN_WIDTH } from "../src/core/types";
import { crc32, packMonochrome } from "../src/editor/framebuffer";

function solidImage(value: number): ImageData {
  const data = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, data } as ImageData;
}

describe("packMonochrome", () => {
  it("packs a white frame as one bits", () => {
    const frame = packMonochrome(solidImage(255));
    expect(frame).toHaveLength(FRAME_BYTES);
    expect(frame.every((byte) => byte === 0xff)).toBe(true);
  });

  it("packs a black frame as zero bits", () => {
    const frame = packMonochrome(solidImage(0));
    expect(frame.every((byte) => byte === 0x00)).toBe(true);
  });

  it("uses MSB-first pixel order", () => {
    const image = solidImage(255);
    image.data[0] = 0;
    image.data[1] = 0;
    image.data[2] = 0;
    expect(packMonochrome(image)[0]).toBe(0x7f);
  });

  it("rejects a frame with the wrong dimensions", () => {
    expect(() => packMonochrome({ width: 1, height: 1, data: new Uint8ClampedArray(4) } as ImageData)).toThrow(
      "296×152",
    );
  });
});

describe("crc32", () => {
  it("matches the standard CRC-32 check vector", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});
