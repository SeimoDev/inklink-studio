import { describe, expect, it } from "vitest";

import { FRAME_BYTES, SCREEN_HEIGHT, SCREEN_WIDTH } from "../src/core/types";
import { changedRegion } from "../src/device/refresh";

describe("changedRegion", () => {
  it("returns the full screen without a baseline", () => {
    expect(changedRegion(null, new Uint8Array(FRAME_BYTES))).toEqual({
      x: 0,
      y: 0,
      width: SCREEN_WIDTH,
      height: SCREEN_HEIGHT,
    });
  });

  it("returns null for an identical frame", () => {
    const frame = new Uint8Array(FRAME_BYTES).fill(0xff);
    expect(changedRegion(frame, new Uint8Array(frame))).toBeNull();
  });

  it("finds exact changed pixels across byte boundaries", () => {
    const before = new Uint8Array(FRAME_BYTES).fill(0xff);
    const after = new Uint8Array(before);
    const stride = SCREEN_WIDTH / 8;
    after[3 * stride] = after[3 * stride]! & ~(0x80 >> 7);
    after[9 * stride + 2] = after[9 * stride + 2]! & ~(0x80 >> 1);
    expect(changedRegion(before, after)).toEqual({ x: 7, y: 3, width: 11, height: 7 });
  });
});
