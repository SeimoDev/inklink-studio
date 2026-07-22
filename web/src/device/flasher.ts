import { ESPLoader, Transport, type IEspLoaderTerminal } from "esptool-js";
import SparkMD5 from "spark-md5";

import {
  BUILT_IN_FIRMWARE_SHA256,
  BUILT_IN_FIRMWARE_URL,
} from "../core/release";

export const QUOTE0_FLASH_BYTES = 4 * 1024 * 1024;
export { BUILT_IN_FIRMWARE_SHA256, BUILT_IN_FIRMWARE_URL };

export type FlasherPhase = "connect" | "backup" | "flash" | "reset";

export interface FlasherProgress {
  phase: FlasherPhase;
  percent: number;
  detail: string;
}

export interface BackupResult {
  data: Uint8Array;
  chip: string;
  flashSize: string;
}

type ProgressHandler = (progress: FlasherProgress) => void;
type LogHandler = (line: string) => void;

export function validateFullFirmware(image: Uint8Array): void {
  if (image.length < 0x10001) {
    throw new Error("固件过小；请选择从地址 0x0 开始的一体化固件");
  }
  if (image.length > QUOTE0_FLASH_BYTES) {
    throw new Error("固件超过 Quote/0 的 4 MB Flash 容量");
  }
  if (image[0] !== 0xe9) {
    throw new Error("0x0 处不是 ESP32 引导镜像，拒绝刷写");
  }
  if (image[0x8000] !== 0xaa || image[0x8001] !== 0x50) {
    throw new Error("固件缺少 0x8000 分区表，必须使用一体化固件");
  }
  if (image[0x10000] !== 0xe9) {
    throw new Error("固件缺少 0x10000 应用镜像，必须使用一体化固件");
  }
}

export async function loadBuiltInFirmware(): Promise<Uint8Array> {
  const response = await fetch(BUILT_IN_FIRMWARE_URL, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`内置固件载入失败（HTTP ${response.status}）`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  validateFullFirmware(data);
  const hash = await sha256Hex(data);
  if (hash !== BUILT_IN_FIRMWARE_SHA256) {
    throw new Error("内置固件 SHA-256 校验失败，拒绝刷写");
  }
  return data;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const source = data.slice().buffer as ArrayBuffer;
  const buffer = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(buffer), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function md5Hex(data: Uint8Array): string {
  return SparkMD5.ArrayBuffer.hash(data.slice().buffer as ArrayBuffer);
}

export class BrowserFlasher {
  constructor(
    private readonly onProgress: ProgressHandler,
    private readonly onLog: LogHandler,
  ) {}

  async backup(port?: SerialPort): Promise<BackupResult> {
    return this.withLoader(async (loader, chip, flashSize) => {
      this.onProgress({ phase: "backup", percent: 0, detail: "正在读取整颗 4 MB Flash" });
      const data = await loader.readFlash(0, QUOTE0_FLASH_BYTES, (_packet, progress, total) => {
        this.onProgress({
          phase: "backup",
          percent: total > 0 ? (progress / total) * 100 : 0,
          detail: `已读取 ${(progress / 1024 / 1024).toFixed(2)} / ${(total / 1024 / 1024).toFixed(2)} MB`,
        });
      });
      this.onProgress({ phase: "backup", percent: 100, detail: "备份读取完成" });
      return { data, chip, flashSize };
    }, port);
  }

  async flash(image: Uint8Array, port?: SerialPort): Promise<{ chip: string; flashSize: string }> {
    validateFullFirmware(image);
    return this.withLoader(async (loader, chip, flashSize) => {
      this.onProgress({ phase: "flash", percent: 0, detail: "正在写入一体化固件" });
      await loader.writeFlash({
        fileArray: [{ data: image, address: 0 }],
        flashMode: "dio",
        flashFreq: "80m",
        flashSize: "4MB",
        eraseAll: false,
        compress: true,
        calculateMD5Hash: md5Hex,
        reportProgress: (_fileIndex, written, total) => {
          this.onProgress({
            phase: "flash",
            percent: total > 0 ? (written / total) * 100 : 0,
            detail: `已写入 ${(written / 1024).toFixed(0)} / ${(total / 1024).toFixed(0)} KB`,
          });
        },
      });
      this.onProgress({ phase: "flash", percent: 100, detail: "固件写入完成" });
      return { chip, flashSize };
    }, port);
  }

  private async withLoader<T>(
    operation: (loader: ESPLoader, chip: string, flashSize: string) => Promise<T>,
    selectedPort?: SerialPort,
  ): Promise<T> {
    if (!window.isSecureContext || !navigator.serial) {
      throw new Error("浏览器刷写需要桌面版 Chrome/Edge，并通过 localhost 或 HTTPS 打开");
    }

    this.onProgress({ phase: "connect", percent: 0, detail: "请选择要操作的 ESP32-C3" });
    const port = selectedPort ?? await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x303a }],
    });
    const transport = new Transport(port, false);
    const terminal: IEspLoaderTerminal = {
      clean: () => undefined,
      write: (data) => this.onLog(data),
      writeLine: (data) => this.onLog(data),
    };
    const loader = new ESPLoader({
      transport,
      baudrate: 460800,
      terminal,
      debugLogging: false,
    });

    let connected = false;
    try {
      const chip = await loader.main();
      connected = true;
      if (!/ESP32-C3/i.test(chip)) {
        throw new Error(`检测到 ${chip}，目标必须是 ESP32-C3`);
      }
      const flashSize = await loader.detectFlashSize();
      if (flashSize !== "4MB") {
        throw new Error(`检测到 ${flashSize} Flash，Quote/0 固件要求 4MB`);
      }
      this.onProgress({ phase: "connect", percent: 100, detail: `${chip} · ${flashSize}` });
      return await operation(loader, chip, flashSize);
    } finally {
      if (connected) {
        this.onProgress({ phase: "reset", percent: 100, detail: "正在复位设备" });
        try {
          await loader.after("hard_reset");
        } catch (error) {
          this.onLog(`复位提示：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        await transport.disconnect();
      } catch {
        // The USB reset may already have closed the Web Serial port.
      }
    }
  }
}
