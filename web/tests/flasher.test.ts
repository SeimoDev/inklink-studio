import { describe, expect, it } from "vitest";

import { md5Hex, QUOTE0_FLASH_BYTES, validateFullFirmware } from "../src/device/flasher";

function validImage(): Uint8Array {
  const image = new Uint8Array(0x10001).fill(0xff);
  image[0] = 0xe9;
  image[0x8000] = 0xaa;
  image[0x8001] = 0x50;
  image[0x10000] = 0xe9;
  return image;
}

describe("validateFullFirmware", () => {
  it("accepts a merged ESP32 image", () => {
    expect(() => validateFullFirmware(validImage())).not.toThrow();
  });

  it("rejects an app-only image", () => {
    const image = validImage();
    image[0x8000] = 0xff;
    expect(() => validateFullFirmware(image)).toThrow(/分区表/);
  });

  it("rejects images larger than flash", () => {
    expect(() => validateFullFirmware(new Uint8Array(QUOTE0_FLASH_BYTES + 1))).toThrow(/4 MB/);
  });
});

describe("md5Hex", () => {
  it("matches the standard abc vector used for post-write verification", () => {
    expect(md5Hex(new TextEncoder().encode("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
  });
});
