import { crc32 } from "../editor/framebuffer";
import { parseSensorValues } from "./sensors";
import type {
  DeviceConfig,
  DeviceInfo,
  DeviceResponse,
  FrameResponse,
  RefreshMode,
  ScreenRotation,
  SensorValues,
} from "../core/types";

type ResponseWaiter = {
  resolve: (response: DeviceResponse) => void;
  reject: (error: Error) => void;
  timer: number;
};

export class DeviceProtocolError extends Error {
  constructor(public readonly response: DeviceResponse) {
    super(String(response.message ?? response.code ?? "Device command failed"));
    this.name = "DeviceProtocolError";
  }
}

export class InkSerial {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readTask: Promise<void> | null = null;
  private decoder = new TextDecoder();
  private textBuffer = "";
  private nextRequestId = 1;
  private waiters = new Map<string, ResponseWaiter>();
  private operationTail: Promise<void> = Promise.resolve();

  onConnectionChange?: (connected: boolean) => void;
  onProtocolLine?: (line: string) => void;

  get supported(): boolean {
    return window.isSecureContext && navigator.serial !== undefined;
  }

  get connected(): boolean {
    return this.port !== null;
  }

  get selectedPort(): SerialPort | null {
    return this.port;
  }

  async connect(): Promise<DeviceInfo> {
    if (!this.supported || !navigator.serial) {
      throw new Error("Web Serial 需要 Chrome/Edge，并通过 localhost 或 HTTPS 打开网站");
    }
    if (this.port) {
      return this.getInfo();
    }

    this.port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x303a, usbProductId: 0x1001 }],
    });
    await this.port.open({ baudRate: 115200, bufferSize: 8192 });
    if (!this.port.readable) {
      await this.port.close();
      this.port = null;
      throw new Error("设备没有可读串口");
    }

    this.reader = this.port.readable.getReader();
    this.readTask = this.readLoop();
    this.onConnectionChange?.(true);

    try {
      return await this.getInfo();
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const port = this.port;
    this.port = null;
    this.rejectAll(new Error("设备已断开"));

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // The OS may already have removed the device.
      }
      this.reader.releaseLock();
      this.reader = null;
    }
    if (this.readTask) {
      try {
        await this.readTask;
      } catch {
        // Cancellation is expected during disconnect.
      }
      this.readTask = null;
    }
    if (port) {
      try {
        await port.close();
      } catch {
        // Ignore an already-closed port.
      }
    }
    this.onConnectionChange?.(false);
  }

  async getInfo(): Promise<DeviceInfo> {
    const response = await this.command("HELLO", "hello", 3000);
    return response as unknown as DeviceInfo;
  }

  async getSensors(): Promise<SensorValues> {
    const response = await this.command("SENSORS", "sensors", 3000);
    return parseSensorValues(response.values);
  }

  async getConfig(): Promise<DeviceConfig> {
    const response = await this.command("CONFIG", "config", 3000);
    return response as unknown as DeviceConfig;
  }

  async setConfig(config: DeviceConfig): Promise<DeviceConfig> {
    const response = await this.command("SET_CONFIG", "config", 10000, [
      config.wifiEnabled ? 1 : 0,
      config.bluetoothEnabled ? 1 : 0,
      Math.round(config.dataRefreshMs),
      Math.round(config.screenRefreshMs),
      Math.round(config.fullRefreshMs),
      config.partialRefreshEnabled ? 1 : 0,
    ]);
    return response as unknown as DeviceConfig;
  }

  async ping(): Promise<void> {
    await this.command("PING", "pong", 2000);
  }

  async clear(): Promise<DeviceResponse> {
    return this.command("CLEAR", "clear", 25000);
  }

  async sendFrame(
    frame: Uint8Array,
    rotation: ScreenRotation,
    mode: RefreshMode = "full",
  ): Promise<FrameResponse> {
    return this.exclusive(async () => {
      if (frame.length !== 5624) {
        throw new Error(`帧长度错误：${frame.length}`);
      }
      const id = this.allocateId();
      const checksum = crc32(frame);
      const ready = this.waitFor(id, "ready", 5000);
      const completed = this.waitFor(id, "frame", 30000);
      await this.writeRaw(
        new TextEncoder().encode(
          `FRAME ${id} ${frame.length} ${checksum.toString(16).padStart(8, "0")} ${rotation} ${mode}\n`,
        ),
      );
      await ready;

      for (let offset = 0; offset < frame.length; offset += 512) {
        await this.writeRaw(frame.subarray(offset, Math.min(offset + 512, frame.length)));
      }
      return completed as Promise<FrameResponse>;
    });
  }

  private async command(
    command: string,
    expectedType: string,
    timeoutMs: number,
    args: Array<string | number> = [],
  ): Promise<DeviceResponse> {
    return this.exclusive(async () => {
      const id = this.allocateId();
      const response = this.waitFor(id, expectedType, timeoutMs);
      const suffix = args.length > 0 ? ` ${args.join(" ")}` : "";
      await this.writeRaw(new TextEncoder().encode(`${command} ${id}${suffix}\n`));
      return response;
    });
  }

  private allocateId(): number {
    const id = this.nextRequestId;
    this.nextRequestId = this.nextRequestId >= 0x7fffffff ? 1 : this.nextRequestId + 1;
    return id;
  }

  private waitFor(id: number, type: string, timeoutMs: number): Promise<DeviceResponse> {
    const key = `${id}:${type}`;
    return new Promise<DeviceResponse>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`等待设备响应超时（${type}）`));
      }, timeoutMs);
      this.waiters.set(key, { resolve, reject, timer });
    });
  }

  private dispatch(response: DeviceResponse): void {
    if (response.type === "error" || response.ok === false) {
      const error = new DeviceProtocolError(response);
      for (const [key, waiter] of this.waiters) {
        if (key.startsWith(`${response.id}:`)) {
          window.clearTimeout(waiter.timer);
          this.waiters.delete(key);
          waiter.reject(error);
        }
      }
      return;
    }

    const key = `${response.id}:${response.type}`;
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    this.waiters.delete(key);
    waiter.resolve(response);
  }

  private async readLoop(): Promise<void> {
    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;
        this.textBuffer += this.decoder.decode(value, { stream: true });

        let newline = this.textBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.textBuffer.slice(0, newline).replace(/\r$/, "");
          this.textBuffer = this.textBuffer.slice(newline + 1);
          this.handleLine(line);
          newline = this.textBuffer.indexOf("\n");
        }
      }
    } catch (error) {
      if (this.port) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        this.port = null;
        this.onConnectionChange?.(false);
      }
    }
  }

  private handleLine(line: string): void {
    this.onProtocolLine?.(line);
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return;

    try {
      const response = JSON.parse(trimmed) as DeviceResponse;
      if (typeof response.id === "number" && typeof response.type === "string") {
        this.dispatch(response);
      }
    } catch {
      // Boot logs and malformed lines are intentionally ignored.
    }
  }

  private async writeRaw(data: Uint8Array): Promise<void> {
    if (!this.port?.writable) {
      throw new Error("设备未连接");
    }
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.waiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}
