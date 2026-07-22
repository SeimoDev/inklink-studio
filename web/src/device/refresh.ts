import {
  FRAME_BYTES,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type RefreshMode,
} from "../core/types";

export interface ChangedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function refreshRequestMode(
  supportsPartial: boolean,
  partialRefreshEnabled: boolean,
): RefreshMode {
  return supportsPartial && partialRefreshEnabled ? "auto" : "full";
}

export function changedRegion(
  previous: Uint8Array | null,
  current: Uint8Array,
): ChangedRegion | null {
  if (current.length !== FRAME_BYTES) {
    throw new Error(`帧长度错误：${current.length}`);
  }
  if (previous === null || previous.length !== current.length) {
    return { x: 0, y: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
  }

  const stride = SCREEN_WIDTH / 8;
  let minX = SCREEN_WIDTH;
  let minY = SCREEN_HEIGHT;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < SCREEN_HEIGHT; y += 1) {
    for (let byteX = 0; byteX < stride; byteX += 1) {
      const index = y * stride + byteX;
      const changedBits = previous[index]! ^ current[index]!;
      if (changedBits === 0) continue;
      for (let bit = 0; bit < 8; bit += 1) {
        if ((changedBits & (0x80 >> bit)) === 0) continue;
        const x = byteX * 8 + bit;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

export function copyFrame(frame: Uint8Array): Uint8Array {
  return new Uint8Array(frame);
}
