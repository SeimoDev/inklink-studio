import { describe, expect, it, vi } from "vitest";

import type { ESPLoader } from "esptool-js";

import {
  isRetryableSerialReadError,
  md5Hex,
  QUOTE0_FLASH_BYTES,
  readFlashStable,
  validateFullFirmware,
} from "../src/device/flasher";

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

describe("readFlashStable", () => {
  it("copies packets into one result buffer and acknowledges each offset", async () => {
    const packets = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])];
    const read = vi.fn()
      .mockResolvedValueOnce(packets[0])
      .mockResolvedValueOnce(packets[1]);
    const write = vi.fn().mockResolvedValue(undefined);
    const checkCommand = vi.fn().mockResolvedValue(0);
    const intToBytes = (value: number) => {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, value, true);
      return bytes;
    };
    const loader = {
      ESP_READ_FLASH: 0xd2,
      FLASH_READ_TIMEOUT: 100_000,
      _intToByteArray: intToBytes,
      checkCommand,
      transport: { read, write },
    } as unknown as Pick<
      ESPLoader,
      "ESP_READ_FLASH" | "FLASH_READ_TIMEOUT" | "_intToByteArray" | "checkCommand" | "transport"
    >;
    const progress = vi.fn();

    const result = await readFlashStable(loader, 0, 8, progress);

    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(checkCommand).toHaveBeenCalledOnce();
    expect(Array.from(checkCommand.mock.calls[0]![2] as Uint8Array)).toEqual([
      0, 0, 0, 0,
      8, 0, 0, 0,
      0, 16, 0, 0,
      0, 4, 0, 0,
    ]);
    expect(write.mock.calls.map(([value]) => Array.from(value as Uint8Array))).toEqual([
      [4, 0, 0, 0],
      [8, 0, 0, 0],
    ]);
    expect(progress).toHaveBeenLastCalledWith(packets[1], 8, 8);
  });

  it("rejects a packet that exceeds the requested range", async () => {
    const loader = {
      ESP_READ_FLASH: 0xd2,
      FLASH_READ_TIMEOUT: 100_000,
      _intToByteArray: () => new Uint8Array(4),
      checkCommand: vi.fn().mockResolvedValue(0),
      transport: {
        read: vi.fn().mockResolvedValue(new Uint8Array(9)),
        write: vi.fn(),
      },
    } as unknown as Pick<
      ESPLoader,
      "ESP_READ_FLASH" | "FLASH_READ_TIMEOUT" | "_intToByteArray" | "checkCommand" | "transport"
    >;

    await expect(readFlashStable(loader, 0, 8)).rejects.toThrow(/超出预期长度/);
  });
});

describe("isRetryableSerialReadError", () => {
  it("recognizes recoverable SLIP stream interruptions", () => {
    expect(isRetryableSerialReadError(new Error(
      "Serial data stream stopped: Possible serial noise or corruption.",
    ))).toBe(true);
    expect(isRetryableSerialReadError(new Error("目标必须是 ESP32-C3"))).toBe(false);
  });
});
