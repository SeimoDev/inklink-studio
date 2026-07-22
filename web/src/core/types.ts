export const SCREEN_WIDTH = 296;
export const SCREEN_HEIGHT = 152;
export const FRAME_BYTES = (SCREEN_WIDTH / 8) * SCREEN_HEIGHT;

export type DitherMode = "threshold" | "floyd-steinberg" | "atkinson" | "bayer4";
export type ScreenRotation = 90 | 270;

export interface ImageSettings {
  brightness: number;
  contrast: number;
  gamma: number;
  threshold: number;
  invert: boolean;
  dither: DitherMode;
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface LayerBase {
  id: string;
  x: number;
  y: number;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  color: "black" | "white";
  background: "transparent" | "white" | "black";
  padding: number;
}

export interface TextLayer extends LayerBase {
  type: "text";
  text: string;
}

export interface SensorLayer extends LayerBase {
  type: "sensor";
  sensorKey: string;
  prefix: string;
  suffix: string;
  decimals: number;
  fallback: string;
}

export type EditorLayer = TextLayer | SensorLayer;
export type SensorValues = Record<string, number | boolean | null>;

export interface ProjectFile {
  version: 1;
  backgroundDataUrl: string | null;
  image: ImageSettings;
  layers: EditorLayer[];
  rotation: ScreenRotation;
  customSensors: SensorValues;
}

export interface DeviceInfo {
  type: "hello";
  id: number;
  ok: true;
  protocol: number;
  firmware: string;
  board: string;
  panel: string;
  width: number;
  height: number;
  frameBytes: number;
  flashBytes: number;
  rotations: ScreenRotation[];
  capabilities: {
    deviceConfig: boolean;
    partialRefresh: boolean;
    wifiSwitch: boolean;
    bluetoothSwitch: boolean;
    offlineSensorRefresh?: boolean;
  };
  maxPartialRefreshes: number;
  offlineSceneLoaded?: boolean;
  sensors: string[];
}

export interface DeviceConfig {
  wifiEnabled: boolean;
  bluetoothEnabled: boolean;
  wifiActive: boolean;
  bluetoothActive: boolean;
  dataRefreshMs: number;
  screenRefreshMs: number;
  fullRefreshMs: number;
  partialRefreshEnabled: boolean;
  limits: {
    dataMinMs: number;
    screenMinMs: number;
    fullMinMs: number;
    maxMs: number;
  };
}

export type RefreshMode = "full" | "partial" | "auto";
export type AppliedRefreshMode = Exclude<RefreshMode, "auto">;

export interface FrameResponse extends DeviceResponse {
  type: "frame";
  ok: true;
  mode: "none" | AppliedRefreshMode;
  refreshMs: number;
  partialCount: number;
  region: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface DeviceResponse {
  type: string;
  id: number;
  ok: boolean;
  [key: string]: unknown;
}
