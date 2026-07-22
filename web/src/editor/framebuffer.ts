import { FRAME_BYTES, SCREEN_HEIGHT, SCREEN_WIDTH } from "../core/types";

export function packMonochrome(image: ImageData): Uint8Array {
  if (image.width !== SCREEN_WIDTH || image.height !== SCREEN_HEIGHT) {
    throw new Error(`Expected ${SCREEN_WIDTH}×${SCREEN_HEIGHT} image`);
  }

  const output = new Uint8Array(FRAME_BYTES);
  output.fill(0xff);
  const stride = SCREEN_WIDTH / 8;

  for (let y = 0; y < SCREEN_HEIGHT; y += 1) {
    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      const pixel = (y * SCREEN_WIDTH + x) * 4;
      const luminance =
        0.2126 * (image.data[pixel] ?? 255) +
        0.7152 * (image.data[pixel + 1] ?? 255) +
        0.0722 * (image.data[pixel + 2] ?? 255);
      if (luminance < 128) {
        output[y * stride + Math.floor(x / 8)]! &= ~(0x80 >> (x % 8));
      }
    }
  }

  return output;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) !== 0 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
