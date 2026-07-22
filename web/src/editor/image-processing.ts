import type { DitherMode, ImageSettings } from "../core/types";

const BAYER_4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
] as const;

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function contrastFactor(contrast: number): number {
  const normalized = Math.max(-255, Math.min(255, contrast * 2.55));
  return (259 * (normalized + 255)) / (255 * (259 - normalized));
}

export function rgbaToAdjustedGray(
  rgba: Uint8ClampedArray,
  settings: Pick<ImageSettings, "brightness" | "contrast" | "gamma" | "invert">,
): Float32Array {
  const gray = new Float32Array(rgba.length / 4);
  const factor = contrastFactor(settings.contrast);
  const brightness = settings.brightness * 2.55;
  const gamma = Math.max(0.1, settings.gamma);

  for (let source = 0, destination = 0; source < rgba.length; source += 4, destination += 1) {
    const red = rgba[source] ?? 255;
    const green = rgba[source + 1] ?? 255;
    const blue = rgba[source + 2] ?? 255;
    let value = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    value = factor * (value - 128) + 128 + brightness;
    value = 255 * Math.pow(clampByte(value) / 255, 1 / gamma);
    gray[destination] = settings.invert ? 255 - value : value;
  }

  return gray;
}

function threshold(gray: Float32Array, cutoff: number): Uint8Array {
  const output = new Uint8Array(gray.length);
  for (let index = 0; index < gray.length; index += 1) {
    output[index] = (gray[index] ?? 255) >= cutoff ? 255 : 0;
  }
  return output;
}

function errorDiffusion(
  source: Float32Array,
  width: number,
  height: number,
  cutoff: number,
  mode: "floyd-steinberg" | "atkinson",
): Uint8Array {
  const values = new Float32Array(source);
  const output = new Uint8Array(values.length);

  const add = (x: number, y: number, error: number, weight: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const index = y * width + x;
    values[index] = (values[index] ?? 255) + error * weight;
  };

  for (let y = 0; y < height; y += 1) {
    const reverse = y % 2 === 1;
    for (let step = 0; step < width; step += 1) {
      const x = reverse ? width - 1 - step : step;
      const index = y * width + x;
      const oldValue = values[index] ?? 255;
      const newValue = oldValue >= cutoff ? 255 : 0;
      const error = oldValue - newValue;
      output[index] = newValue;
      const direction = reverse ? -1 : 1;

      if (mode === "floyd-steinberg") {
        add(x + direction, y, error, 7 / 16);
        add(x - direction, y + 1, error, 3 / 16);
        add(x, y + 1, error, 5 / 16);
        add(x + direction, y + 1, error, 1 / 16);
      } else {
        const weight = 1 / 8;
        add(x + direction, y, error, weight);
        add(x + direction * 2, y, error, weight);
        add(x - direction, y + 1, error, weight);
        add(x, y + 1, error, weight);
        add(x + direction, y + 1, error, weight);
        add(x, y + 2, error, weight);
      }
    }
  }

  return output;
}

function orderedDither(
  gray: Float32Array,
  width: number,
  height: number,
  cutoff: number,
): Uint8Array {
  const output = new Uint8Array(gray.length);
  const bias = cutoff - 128;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const matrix = BAYER_4[(y % 4) * 4 + (x % 4)] ?? 0;
      const localThreshold = (matrix + 0.5) * 16 + bias;
      output[index] = (gray[index] ?? 255) >= localThreshold ? 255 : 0;
    }
  }
  return output;
}

export function ditherGray(
  gray: Float32Array,
  width: number,
  height: number,
  mode: DitherMode,
  cutoff: number,
): Uint8Array {
  switch (mode) {
    case "floyd-steinberg":
    case "atkinson":
      return errorDiffusion(gray, width, height, cutoff, mode);
    case "bayer4":
      return orderedDither(gray, width, height, cutoff);
    case "threshold":
    default:
      return threshold(gray, cutoff);
  }
}

export function processImageData(image: ImageData, settings: ImageSettings): ImageData {
  const gray = rgbaToAdjustedGray(image.data, settings);
  const monochrome = ditherGray(gray, image.width, image.height, settings.dither, settings.threshold);
  const output = new ImageData(image.width, image.height);

  for (let index = 0; index < monochrome.length; index += 1) {
    const value = monochrome[index] ?? 255;
    const destination = index * 4;
    output.data[destination] = value;
    output.data[destination + 1] = value;
    output.data[destination + 2] = value;
    output.data[destination + 3] = 255;
  }
  return output;
}
