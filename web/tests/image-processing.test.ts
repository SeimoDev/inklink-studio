import { describe, expect, it } from "vitest";

import { ditherGray, rgbaToAdjustedGray } from "../src/editor/image-processing";

describe("rgbaToAdjustedGray", () => {
  it("uses perceptual RGB luminance", () => {
    const result = rgbaToAdjustedGray(new Uint8ClampedArray([255, 0, 0, 255]), {
      brightness: 0,
      contrast: 0,
      gamma: 1,
      invert: false,
    });
    expect(result[0]).toBeCloseTo(54.213, 2);
  });

  it("supports inversion", () => {
    const result = rgbaToAdjustedGray(new Uint8ClampedArray([40, 40, 40, 255]), {
      brightness: 0,
      contrast: 0,
      gamma: 1,
      invert: true,
    });
    expect(result[0]).toBeCloseTo(215, 4);
  });
});

describe("ditherGray", () => {
  it("applies a configurable threshold", () => {
    const output = ditherGray(new Float32Array([0, 127, 128, 255]), 4, 1, "threshold", 128);
    expect([...output]).toEqual([0, 0, 255, 255]);
  });

  it.each(["floyd-steinberg", "atkinson", "bayer4"] as const)(
    "%s always emits one-bit values",
    (mode) => {
      const gray = Float32Array.from({ length: 64 }, (_, index) => index * 4);
      const output = ditherGray(gray, 8, 8, mode, 128);
      expect(output.every((value) => value === 0 || value === 255)).toBe(true);
    },
  );

  it("preserves pure white and black through error diffusion", () => {
    const output = ditherGray(new Float32Array([0, 0, 255, 255]), 2, 2, "floyd-steinberg", 128);
    expect([...output]).toEqual([0, 0, 255, 255]);
  });
});
