import { packMonochrome } from "./framebuffer";
import { processImageData } from "./image-processing";
import {
  formatSensorValue,
  hasLegacyBatteryFormatting,
  sensorLayerDefaults,
} from "../device/sensors";
import {
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type EditorLayer,
  type ImageSettings,
  type ProjectFile,
  type ScreenRotation,
  type SensorLayer,
  type SensorValues,
  type TextLayer,
} from "../core/types";

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  brightness: 0,
  contrast: 0,
  gamma: 1,
  threshold: 128,
  invert: false,
  dither: "floyd-steinberg",
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
};

export interface EditorLayerPatch {
  x?: number;
  y?: number;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  color?: "black" | "white";
  background?: "transparent" | "white" | "black";
  padding?: number;
  text?: string;
  sensorKey?: string;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  fallback?: string;
}

type Bounds = { x: number; y: number; width: number; height: number };
type DragState =
  | { kind: "layer"; id: string; pointerX: number; pointerY: number; startX: number; startY: number }
  | { kind: "background"; pointerX: number; pointerY: number; startX: number; startY: number };

function createId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `layer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cloneLayer(layer: EditorLayer): EditorLayer {
  return { ...layer };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function imageFromSource(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取图片，请换一张图片后重试"));
    image.src = source;
  });
}

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export class CanvasEditor {
  private readonly context: CanvasRenderingContext2D;
  private readonly overlayContext: CanvasRenderingContext2D;
  private readonly backgroundCanvas = document.createElement("canvas");
  private readonly backgroundContext: CanvasRenderingContext2D;
  private backgroundImage: HTMLImageElement | null = null;
  private backgroundDataUrl: string | null = null;
  private bounds = new Map<string, Bounds>();
  private drag: DragState | null = null;

  imageSettings: ImageSettings = { ...DEFAULT_IMAGE_SETTINGS };
  layers: EditorLayer[] = [];
  sensorValues: SensorValues = {};
  selectedId: string | null = null;

  onChange?: () => void;
  onSelectionChange?: (layer: EditorLayer | null) => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly overlay: HTMLCanvasElement,
  ) {
    canvas.width = SCREEN_WIDTH;
    canvas.height = SCREEN_HEIGHT;
    overlay.width = SCREEN_WIDTH;
    overlay.height = SCREEN_HEIGHT;
    this.backgroundCanvas.width = SCREEN_WIDTH;
    this.backgroundCanvas.height = SCREEN_HEIGHT;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    const overlayContext = overlay.getContext("2d");
    const backgroundContext = this.backgroundCanvas.getContext("2d", { willReadFrequently: true });
    if (!context || !overlayContext || !backgroundContext) {
      throw new Error("浏览器无法创建 Canvas 2D 画布");
    }
    this.context = context;
    this.overlayContext = overlayContext;
    this.backgroundContext = backgroundContext;

    overlay.addEventListener("pointerdown", this.handlePointerDown);
    overlay.addEventListener("pointermove", this.handlePointerMove);
    overlay.addEventListener("pointerup", this.handlePointerUp);
    overlay.addEventListener("pointercancel", this.handlePointerUp);
    overlay.addEventListener("wheel", this.handleWheel, { passive: false });

    this.render();
  }

  async loadImage(file: File): Promise<void> {
    if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
    const dataUrl = await fileAsDataUrl(file);
    await this.setBackgroundSource(dataUrl);
    this.imageSettings.zoom = 1;
    this.imageSettings.offsetX = 0;
    this.imageSettings.offsetY = 0;
    this.changed();
  }

  clearImage(): void {
    this.backgroundImage = null;
    this.backgroundDataUrl = null;
    this.imageSettings = { ...this.imageSettings, zoom: 1, offsetX: 0, offsetY: 0 };
    this.changed();
  }

  setImageSettings(settings: Partial<ImageSettings>): void {
    this.imageSettings = {
      ...this.imageSettings,
      ...settings,
      zoom: clamp(settings.zoom ?? this.imageSettings.zoom, 0.25, 8),
    };
    this.changed();
  }

  setSensorValues(values: SensorValues): void {
    this.sensorValues = { ...values };
    this.changed();
  }

  addText(text = "双击编辑文字"): TextLayer {
    const layer: TextLayer = {
      id: createId(),
      type: "text",
      text,
      x: 16,
      y: 16,
      fontSize: 18,
      fontFamily: "system-ui, sans-serif",
      bold: true,
      color: "black",
      background: "transparent",
      padding: 2,
    };
    this.layers.push(layer);
    this.select(layer.id);
    this.changed();
    return layer;
  }

  addSensor(sensorKey = "battery_percent"): SensorLayer {
    const defaults = sensorLayerDefaults(sensorKey);
    const layer: SensorLayer = {
      id: createId(),
      type: "sensor",
      sensorKey,
      ...defaults,
      x: 16,
      y: 48,
      fontSize: 16,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      bold: true,
      color: "black",
      background: "white",
      padding: 3,
    };
    this.layers.push(layer);
    this.select(layer.id);
    this.changed();
    return layer;
  }

  select(id: string | null): void {
    const next = id && this.layers.some((layer) => layer.id === id) ? id : null;
    if (next === this.selectedId) return;
    this.selectedId = next;
    this.drawOverlay();
    this.onSelectionChange?.(this.getSelectedLayer());
  }

  getSelectedLayer(): EditorLayer | null {
    return this.layers.find((layer) => layer.id === this.selectedId) ?? null;
  }

  updateSelected(patch: EditorLayerPatch): void {
    const layer = this.getSelectedLayer();
    if (!layer) return;
    Object.assign(layer, patch);
    layer.x = Math.round(clamp(layer.x, -SCREEN_WIDTH, SCREEN_WIDTH));
    layer.y = Math.round(clamp(layer.y, -SCREEN_HEIGHT, SCREEN_HEIGHT));
    layer.fontSize = Math.round(clamp(layer.fontSize, 6, 96));
    layer.padding = Math.round(clamp(layer.padding, 0, 24));
    if (layer.type === "sensor") layer.decimals = Math.round(clamp(layer.decimals, 0, 4));
    this.changed();
    this.onSelectionChange?.(layer);
  }

  removeSelected(): void {
    if (!this.selectedId) return;
    this.layers = this.layers.filter((layer) => layer.id !== this.selectedId);
    this.selectedId = null;
    this.changed();
    this.onSelectionChange?.(null);
  }

  duplicateSelected(): EditorLayer | null {
    const layer = this.getSelectedLayer();
    if (!layer) return null;
    const copy = { ...cloneLayer(layer), id: createId(), x: layer.x + 8, y: layer.y + 8 };
    this.layers.push(copy);
    this.select(copy.id);
    this.changed();
    return copy;
  }

  moveLayer(id: string, direction: "up" | "down"): void {
    const index = this.layers.findIndex((layer) => layer.id === id);
    if (index < 0) return;
    const target = direction === "up" ? index + 1 : index - 1;
    if (target < 0 || target >= this.layers.length) return;
    const current = this.layers[index];
    const other = this.layers[target];
    if (!current || !other) return;
    this.layers[index] = other;
    this.layers[target] = current;
    this.changed();
  }

  getFrame(): Uint8Array {
    this.render();
    return packMonochrome(this.context.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT));
  }

  getStaticFrame(): Uint8Array {
    this.render(false);
    const frame = packMonochrome(
      this.context.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT),
    );
    this.render();
    return frame;
  }

  async toPngBlob(): Promise<Blob> {
    this.render();
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("导出 PNG 失败"));
      }, "image/png");
    });
  }

  toProject(rotation: ScreenRotation, customSensors: SensorValues): ProjectFile {
    return {
      version: 1,
      backgroundDataUrl: this.backgroundDataUrl,
      image: { ...this.imageSettings },
      layers: this.layers.map(cloneLayer),
      rotation,
      customSensors: { ...customSensors },
    };
  }

  async loadProject(project: ProjectFile): Promise<void> {
    if (project.version !== 1 || !Array.isArray(project.layers)) {
      throw new Error("不支持的项目文件格式");
    }
    this.backgroundImage = null;
    this.backgroundDataUrl = null;
    if (project.backgroundDataUrl) await this.setBackgroundSource(project.backgroundDataUrl, false);
    this.imageSettings = { ...DEFAULT_IMAGE_SETTINGS, ...project.image };
    this.layers = project.layers.map((layer) => {
      const copy = cloneLayer(layer);
      if (
        copy.type === "sensor" &&
        hasLegacyBatteryFormatting(copy.sensorKey, copy.prefix, copy.suffix, copy.decimals)
      ) {
        const fallback = copy.fallback;
        Object.assign(copy, sensorLayerDefaults(copy.sensorKey));
        copy.fallback = fallback;
      }
      return copy;
    });
    this.sensorValues = { ...project.customSensors, ...this.sensorValues };
    this.selectedId = null;
    this.changed();
    this.onSelectionChange?.(null);
  }

  render(includeSensorLayers = true): void {
    const ctx = this.context;
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);

    if (this.backgroundImage) {
      const image = this.backgroundImage;
      const cover = Math.max(SCREEN_WIDTH / image.naturalWidth, SCREEN_HEIGHT / image.naturalHeight);
      const scale = cover * this.imageSettings.zoom;
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      const x = (SCREEN_WIDTH - width) / 2 + this.imageSettings.offsetX;
      const y = (SCREEN_HEIGHT - height) / 2 + this.imageSettings.offsetY;
      const bg = this.backgroundContext;
      bg.save();
      bg.fillStyle = "#ffffff";
      bg.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
      bg.imageSmoothingEnabled = true;
      bg.imageSmoothingQuality = "high";
      bg.drawImage(image, x, y, width, height);
      bg.restore();
      const source = bg.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
      ctx.putImageData(processImageData(source, this.imageSettings), 0, 0);
    }

    this.bounds.clear();
    for (const layer of this.layers) {
      if (includeSensorLayers || layer.type !== "sensor") this.drawLayer(ctx, layer);
    }
    this.forceBlackAndWhite(ctx);
    ctx.restore();
    this.drawOverlay();
  }

  private drawLayer(ctx: CanvasRenderingContext2D, layer: EditorLayer): void {
    const value = layer.type === "text" ? layer.text : this.formatSensor(layer);
    ctx.save();
    ctx.font = `${layer.bold ? 700 : 400} ${layer.fontSize}px ${layer.fontFamily}`;
    ctx.textBaseline = "top";
    const metrics = ctx.measureText(value || " ");
    const textHeight = Math.ceil(layer.fontSize * 1.22);
    const width = Math.ceil(metrics.width) + layer.padding * 2;
    const height = textHeight + layer.padding * 2;
    const bounds = { x: layer.x, y: layer.y, width, height };
    this.bounds.set(layer.id, bounds);

    if (layer.background !== "transparent") {
      ctx.fillStyle = layer.background;
      ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    }
    ctx.fillStyle = layer.color;
    ctx.fillText(value, layer.x + layer.padding, layer.y + layer.padding);
    ctx.restore();
  }

  private formatSensor(layer: SensorLayer): string {
    const raw = this.sensorValues[layer.sensorKey];
    const value = formatSensorValue(layer.sensorKey, raw, layer.decimals) ?? layer.fallback;
    return `${layer.prefix}${value}${layer.suffix}`;
  }

  private forceBlackAndWhite(ctx: CanvasRenderingContext2D): void {
    const image = ctx.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const luminance =
        0.2126 * (image.data[offset] ?? 255) +
        0.7152 * (image.data[offset + 1] ?? 255) +
        0.0722 * (image.data[offset + 2] ?? 255);
      const color = luminance < 128 ? 0 : 255;
      image.data[offset] = color;
      image.data[offset + 1] = color;
      image.data[offset + 2] = color;
      image.data[offset + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }

  private drawOverlay(): void {
    const ctx = this.overlayContext;
    ctx.clearRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    if (!this.selectedId) return;
    const bounds = this.bounds.get(this.selectedId);
    if (!bounds) return;

    ctx.save();
    ctx.strokeStyle = "#ff5c35";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(bounds.x - 1.5, bounds.y - 1.5, bounds.width + 3, bounds.height + 3);
    ctx.setLineDash([]);
    ctx.fillStyle = "#ff5c35";
    const handles: Array<readonly [number, number]> = [
      [bounds.x - 2, bounds.y - 2],
      [bounds.x + bounds.width - 2, bounds.y - 2],
      [bounds.x - 2, bounds.y + bounds.height - 2],
      [bounds.x + bounds.width - 2, bounds.y + bounds.height - 2],
    ];
    for (const [x, y] of handles) {
      ctx.fillRect(x, y, 4, 4);
    }
    ctx.restore();
  }

  private changed(): void {
    this.render();
    this.onChange?.();
  }

  private async setBackgroundSource(source: string, emit = true): Promise<void> {
    const image = await imageFromSource(source);
    this.backgroundImage = image;
    this.backgroundDataUrl = source;
    if (emit) this.changed();
  }

  private eventPoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.overlay.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * SCREEN_WIDTH) / rect.width,
      y: ((event.clientY - rect.top) * SCREEN_HEIGHT) / rect.height,
    };
  }

  private hitTest(x: number, y: number): EditorLayer | null {
    for (let index = this.layers.length - 1; index >= 0; index -= 1) {
      const layer = this.layers[index];
      if (!layer) continue;
      const bounds = this.bounds.get(layer.id);
      if (
        bounds &&
        x >= bounds.x - 3 &&
        x <= bounds.x + bounds.width + 3 &&
        y >= bounds.y - 3 &&
        y <= bounds.y + bounds.height + 3
      ) {
        return layer;
      }
    }
    return null;
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    const point = this.eventPoint(event);
    const layer = this.hitTest(point.x, point.y);
    if (layer) {
      this.select(layer.id);
      this.drag = {
        kind: "layer",
        id: layer.id,
        pointerX: point.x,
        pointerY: point.y,
        startX: layer.x,
        startY: layer.y,
      };
    } else {
      this.select(null);
      this.drag = {
        kind: "background",
        pointerX: point.x,
        pointerY: point.y,
        startX: this.imageSettings.offsetX,
        startY: this.imageSettings.offsetY,
      };
    }
    this.overlay.setPointerCapture(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    const point = this.eventPoint(event);
    const deltaX = point.x - drag.pointerX;
    const deltaY = point.y - drag.pointerY;
    if (drag.kind === "layer") {
      const selected = this.layers.find((candidate) => candidate.id === drag.id);
      if (!selected) return;
      selected.x = Math.round(drag.startX + deltaX);
      selected.y = Math.round(drag.startY + deltaY);
    } else {
      this.imageSettings.offsetX = Math.round(drag.startX + deltaX);
      this.imageSettings.offsetY = Math.round(drag.startY + deltaY);
    }
    this.changed();
    if (drag.kind === "layer") this.onSelectionChange?.(this.getSelectedLayer());
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    this.drag = null;
    if (this.overlay.hasPointerCapture(event.pointerId)) this.overlay.releasePointerCapture(event.pointerId);
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.backgroundImage) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.setImageSettings({ zoom: this.imageSettings.zoom * factor });
  };
}
