import "./styles.css";

import { BUILT_IN_FIRMWARE_LABEL, PRODUCT_VERSION } from "./core/release";
import type {
  DeviceConfig,
  DeviceInfo,
  DitherMode,
  EditorLayer,
  FrameResponse,
  ImageSettings,
  ProjectFile,
  ScreenRotation,
  SensorValues,
} from "./core/types";
import {
  BrowserFlasher,
  loadBuiltInFirmware,
  sha256Hex,
  validateFullFirmware,
} from "./device/flasher";
import { changedRegion, copyFrame } from "./device/refresh";
import {
  formatSensorReading,
  KNOWN_SENSOR_KEYS,
  sensorLabel,
  sensorLayerDefaults,
  sensorSupportsDecimals,
} from "./device/sensors";
import { InkSerial } from "./device/serial";
import { CanvasEditor, DEFAULT_IMAGE_SETTINGS, type EditorLayerPatch } from "./editor/editor";

const NUMERIC_IMAGE_KEYS = ["brightness", "contrast", "gamma", "threshold", "zoom"] as const;
type NumericImageKey = (typeof NUMERIC_IMAGE_KEYS)[number];

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`页面缺少元素 #${id}`);
  return found as T;
}

function input(id: string): HTMLInputElement {
  return element<HTMLInputElement>(id);
}

function select(id: string): HTMLSelectElement {
  return element<HTMLSelectElement>(id);
}

function button(id: string): HTMLButtonElement {
  return element<HTMLButtonElement>(id);
}

const editor = new CanvasEditor(
  element<HTMLCanvasElement>("displayCanvas"),
  element<HTMLCanvasElement>("overlayCanvas"),
);
const serial = new InkSerial();

let deviceInfo: DeviceInfo | null = null;
let deviceConfig: DeviceConfig | null = null;
let liveSensors: SensorValues = {};
let customSensors: SensorValues = {};
let imageLoaded = false;
let inspectorSyncing = false;
let lastSentFrame: Uint8Array | null = null;
let lastSentRotation: ScreenRotation | null = null;
let lastFullRefreshAt = 0;
let dataRefreshTimer: number | null = null;
let screenRefreshTimer: number | null = null;
let automaticScreenRefreshRunning = false;
let frameSendRunning = false;
let sensorRefreshPromise: Promise<void> | null = null;
let customFirmwareFile: File | null = null;
let firmwareOperationRunning = false;

function combinedSensors(): SensorValues {
  return { ...liveSensors, ...customSensors };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toast(message: string, kind: "success" | "error" = "success"): void {
  const node = document.createElement("div");
  node.className = `toast ${kind === "error" ? "error" : ""}`;
  node.textContent = message;
  element("toastRegion").append(node);
  window.setTimeout(() => node.remove(), 3600);
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function setSendStatus(
  title: string,
  detail: string,
  state: "idle" | "ready" | "busy" = "idle",
): void {
  element("sendStatusTitle").textContent = title;
  element("sendStatusDetail").textContent = detail;
  element("sendIndicator").className = `send-indicator ${state === "idle" ? "" : state}`;
}

function setConnectedUi(connected: boolean): void {
  const state = element("connectionState");
  const connect = button("connectBtn");
  state.classList.toggle("connected", connected);
  element("connectionText").textContent = connected ? "设备已连接" : "设备未连接";
  connect.textContent = connected ? "断开设备" : "连接 USB";
  button("refreshSensorsBtn").disabled = !connected;
  button("sendBtn").disabled = !connected;
  button("clearBtn").disabled = !connected;
  button("reloadConfigBtn").disabled = !connected;
  button("saveConfigBtn").disabled = !connected;
  for (const control of document.querySelectorAll<HTMLInputElement>(".device-config-control")) {
    control.disabled = !connected;
  }
  if (connected) setSendStatus("设备已就绪", "画面将通过 USB 有线发送", "ready");
  else setSendStatus("画面已就绪", "连接设备后即可发送");
}

function showDeviceInfo(info: DeviceInfo | null): void {
  const details = element<HTMLDListElement>("deviceDetails");
  const message = element("deviceMessage");
  if (!info) {
    details.hidden = true;
    message.hidden = false;
    message.textContent = serial.supported
      ? "使用 Chrome 或 Edge，通过 USB-C 数据线连接设备。"
      : "当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge，并从 localhost/HTTPS 打开。";
    return;
  }
  message.hidden = true;
  details.hidden = false;
  element("firmwareValue").textContent = info.firmware;
  element("panelValue").textContent = `${info.panel} · ${info.width}×${info.height}`;
  element("protocolValue").textContent = `v${info.protocol}`;
  const supportsPartial = info.capabilities?.partialRefresh === true;
  element("partialSupportState").textContent = supportsPartial
    ? "UC8251D 已确认支持"
    : "当前固件未报告支持";
}

function renderSensorOptions(): void {
  const control = select("sensorKeyInput");
  const current = editor.getSelectedLayer();
  const selectedKey = current?.type === "sensor" ? current.sensorKey : control.value;
  const keys = new Set([
    ...KNOWN_SENSOR_KEYS,
    ...Object.keys(liveSensors),
    ...Object.keys(customSensors),
  ]);
  if (selectedKey) keys.add(selectedKey);
  control.replaceChildren();
  for (const key of keys) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = `${sensorLabel(key)} · ${key}`;
    control.append(option);
  }
  if (selectedKey) control.value = selectedKey;
}

function renderSensors(): void {
  const list = element("sensorList");
  const values = combinedSensors();
  const entries = Object.entries(values);
  list.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "连接设备以读取实时数据";
    list.append(empty);
  }
  for (const [key, value] of entries) {
    const row = document.createElement("div");
    row.className = "sensor-row";
    const label = document.createElement("span");
    label.textContent = sensorLabel(key);
    label.title = key;
    const display = document.createElement("b");
    display.textContent = formatSensorReading(key, value);
    row.append(label, display);
    if (Object.hasOwn(customSensors, key)) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.title = `移除 ${key}`;
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        delete customSensors[key];
        applySensors();
      });
      row.append(remove);
    }
    list.append(row);
  }
  renderSensorOptions();
}

function applySensors(): void {
  editor.setSensorValues(combinedSensors());
  renderSensors();
}

async function refreshSensors(): Promise<void> {
  if (!serial.connected) return;
  if (sensorRefreshPromise) return sensorRefreshPromise;
  sensorRefreshPromise = (async () => {
    liveSensors = await serial.getSensors();
    applySensors();
  })();
  try {
    await sensorRefreshPromise;
  } finally {
    sensorRefreshPromise = null;
  }
}

function stopRefreshSchedulers(): void {
  if (dataRefreshTimer !== null) window.clearInterval(dataRefreshTimer);
  if (screenRefreshTimer !== null) window.clearInterval(screenRefreshTimer);
  dataRefreshTimer = null;
  screenRefreshTimer = null;
}

function restartRefreshSchedulers(): void {
  stopRefreshSchedulers();
  if (!serial.connected || !deviceConfig) return;

  dataRefreshTimer = window.setInterval(() => {
    void refreshSensors().catch((error) => {
      element("configMessage").textContent = `自动读取失败：${errorMessage(error)}`;
    });
  }, deviceConfig.dataRefreshMs);

  screenRefreshTimer = window.setInterval(() => {
    if (!input("autoRefreshInput").checked || automaticScreenRefreshRunning) return;
    automaticScreenRefreshRunning = true;
    void sendCurrentFrame(false, false)
      .catch((error) => {
        setSendStatus("自动更新失败", errorMessage(error));
      })
      .finally(() => {
        automaticScreenRefreshRunning = false;
      });
  }, deviceConfig.screenRefreshMs);
}

function syncConfigForm(config: DeviceConfig): void {
  input("wifiEnabledInput").checked = config.wifiEnabled;
  input("bluetoothEnabledInput").checked = config.bluetoothEnabled;
  input("partialRefreshInput").checked = config.partialRefreshEnabled;
  input("dataRefreshInput").value = String(config.dataRefreshMs / 1000);
  input("screenRefreshInput").value = String(config.screenRefreshMs / 1000);
  input("fullRefreshInput").value = String(config.fullRefreshMs / 1000);
  input("dataRefreshInput").min = String(config.limits.dataMinMs / 1000);
  input("screenRefreshInput").min = String(config.limits.screenMinMs / 1000);
  input("fullRefreshInput").min = String(config.limits.fullMinMs / 1000);
  const maximumSeconds = String(config.limits.maxMs / 1000);
  input("dataRefreshInput").max = maximumSeconds;
  input("screenRefreshInput").max = maximumSeconds;
  input("fullRefreshInput").max = maximumSeconds;
  element("wifiRuntimeState").textContent = config.wifiActive ? "运行中" : "已停止";
  element("bluetoothRuntimeState").textContent = config.bluetoothActive ? "运行中" : "已停止";
  element("configMessage").textContent = "已从设备读取并载入当前配置。";

  const supportsPartial = deviceInfo?.capabilities?.partialRefresh === true;
  input("partialRefreshInput").disabled = !supportsPartial;
}

function configFromForm(): DeviceConfig {
  if (!deviceConfig) throw new Error("尚未从设备读取配置");
  const seconds = (id: string): number => {
    const value = Number(input(id).value);
    if (!Number.isFinite(value) || value <= 0) throw new Error("刷新间隔必须是正数");
    return Math.round(value * 1000);
  };
  const candidate: DeviceConfig = {
    ...deviceConfig,
    wifiEnabled: input("wifiEnabledInput").checked,
    bluetoothEnabled: input("bluetoothEnabledInput").checked,
    partialRefreshEnabled: input("partialRefreshInput").checked,
    dataRefreshMs: seconds("dataRefreshInput"),
    screenRefreshMs: seconds("screenRefreshInput"),
    fullRefreshMs: seconds("fullRefreshInput"),
  };
  const limits = candidate.limits;
  if (candidate.dataRefreshMs < limits.dataMinMs || candidate.dataRefreshMs > limits.maxMs) {
    throw new Error(`数据读取间隔必须在 ${limits.dataMinMs / 1000}–${limits.maxMs / 1000} 秒之间`);
  }
  if (candidate.screenRefreshMs < limits.screenMinMs || candidate.screenRefreshMs > limits.maxMs) {
    throw new Error(`屏幕更新间隔必须在 ${limits.screenMinMs / 1000}–${limits.maxMs / 1000} 秒之间`);
  }
  if (candidate.fullRefreshMs < limits.fullMinMs || candidate.fullRefreshMs > limits.maxMs) {
    throw new Error(`全屏刷新间隔必须在 ${limits.fullMinMs / 1000}–${limits.maxMs / 1000} 秒之间`);
  }
  if (candidate.fullRefreshMs < candidate.screenRefreshMs) {
    throw new Error("全屏刷新间隔不能小于屏幕更新间隔");
  }
  return candidate;
}

async function loadDeviceConfig(): Promise<void> {
  if (!serial.connected) return;
  if (!deviceInfo?.capabilities?.deviceConfig) {
    deviceConfig = null;
    element("configMessage").textContent = `当前固件不支持配置读取，请先刷写内置 v${PRODUCT_VERSION} 固件。`;
    button("saveConfigBtn").disabled = true;
    button("reloadConfigBtn").disabled = true;
    for (const control of document.querySelectorAll<HTMLInputElement>(".device-config-control")) {
      control.disabled = true;
    }
    return;
  }
  element("configMessage").textContent = "正在从设备读取配置…";
  deviceConfig = await serial.getConfig();
  syncConfigForm(deviceConfig);
  restartRefreshSchedulers();
}

async function saveDeviceConfig(): Promise<void> {
  const candidate = configFromForm();
  button("saveConfigBtn").disabled = true;
  element("configMessage").textContent = "正在保存并应用设备配置…";
  try {
    deviceConfig = await serial.setConfig(candidate);
    syncConfigForm(deviceConfig);
    restartRefreshSchedulers();
    toast("设备配置已保存");
  } finally {
    button("saveConfigBtn").disabled = !serial.connected;
  }
}

function layerTitle(layer: EditorLayer): string {
  if (layer.type === "text") return layer.text.trim() || "空文字";
  return sensorLabel(layer.sensorKey);
}

function renderLayerList(): void {
  const list = element("layerList");
  element("layerCount").textContent = String(editor.layers.length);
  list.replaceChildren();
  if (editor.layers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "还没有图层";
    list.append(empty);
    return;
  }

  for (const layer of [...editor.layers].reverse()) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `layer-item ${layer.id === editor.selectedId ? "selected" : ""}`;
    const icon = document.createElement("span");
    icon.className = "layer-item-icon";
    icon.textContent = layer.type === "text" ? "T" : "⌁";
    const copy = document.createElement("span");
    copy.className = "layer-item-copy";
    const title = document.createElement("strong");
    title.textContent = layerTitle(layer);
    const meta = document.createElement("small");
    meta.textContent = `${layer.type.toUpperCase()} · X ${layer.x} / Y ${layer.y}`;
    copy.append(title, meta);
    item.append(icon, copy);
    item.addEventListener("click", () => editor.select(layer.id));
    list.append(item);
  }
}

function setControlValue(id: string, value: string | number): void {
  const control = element<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id);
  control.value = String(value);
}

function syncInspector(layer: EditorLayer | null): void {
  inspectorSyncing = true;
  const empty = element("inspectorEmpty");
  const form = element<HTMLFormElement>("inspectorForm");
  const badge = element("layerTypeBadge");
  empty.hidden = layer !== null;
  form.hidden = layer === null;
  badge.hidden = layer === null;

  if (layer) {
    badge.textContent = layer.type === "text" ? "TEXT" : "SENSOR";
    element("textFieldWrap").hidden = layer.type !== "text";
    element("sensorFieldWrap").hidden = layer.type !== "sensor";
    if (layer.type === "text") setControlValue("layerTextInput", layer.text);
    else {
      renderSensorOptions();
      setControlValue("sensorKeyInput", layer.sensorKey);
      setControlValue("prefixInput", layer.prefix);
      setControlValue("suffixInput", layer.suffix);
      setControlValue("fallbackInput", layer.fallback);
      setControlValue("decimalsInput", layer.decimals);
      input("decimalsInput").disabled = !sensorSupportsDecimals(layer.sensorKey);
    }
    setControlValue("xInput", layer.x);
    setControlValue("yInput", layer.y);
    setControlValue("fontSizeInput", layer.fontSize);
    setControlValue("fontFamilyInput", layer.fontFamily);
    setControlValue("colorInput", layer.color);
    setControlValue("backgroundInput", layer.background);
    setControlValue("paddingInput", layer.padding);
    input("boldInput").checked = layer.bold;
  }
  inspectorSyncing = false;
  renderLayerList();
}

function updateSelected(patch: EditorLayerPatch): void {
  if (!inspectorSyncing) editor.updateSelected(patch);
}

function formatImageValue(key: NumericImageKey, value: number): string {
  if (key === "zoom") return `${Math.round(value * 100)}%`;
  if (key === "gamma") return value.toFixed(1);
  return String(Math.round(value));
}

function syncImageControls(): void {
  for (const key of NUMERIC_IMAGE_KEYS) {
    const control = input(`${key}Input`);
    const value = editor.imageSettings[key];
    control.value = String(value);
    element<HTMLOutputElement>(`${key}Value`).value = formatImageValue(key, value);
  }
  select("ditherInput").value = editor.imageSettings.dither;
  input("invertInput").checked = editor.imageSettings.invert;
}

function bindNumericImageControl(key: NumericImageKey): void {
  const control = input(`${key}Input`);
  control.addEventListener("input", () => {
    const value = Number(control.value);
    editor.setImageSettings({ [key]: value } as Partial<ImageSettings>);
    element<HTMLOutputElement>(`${key}Value`).value = formatImageValue(key, value);
  });
}

async function handleImage(file: File | undefined): Promise<void> {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) throw new Error("图片不能超过 20 MB");
  await editor.loadImage(file);
  imageLoaded = true;
  element("dropzone").hidden = true;
  element("imageActions").hidden = false;
  syncImageControls();
  toast("背景图片已加载，可在画布拖动裁剪");
}

function rotation(): ScreenRotation {
  return Number(select("rotationInput").value) as ScreenRotation;
}

function describeFrameResponse(response: FrameResponse): string {
  if (response.mode === "none") return "画面没有变化，设备跳过刷新";
  if (response.mode === "partial") {
    const region = response.region;
    return `局部刷新 ${region.width}×${region.height} @ (${region.x}, ${region.y})`;
  }
  return "已执行全屏刷新";
}

async function sendCurrentFrame(
  refreshSensorsFirst: boolean,
  notify: boolean,
): Promise<FrameResponse | null> {
  if (!serial.connected) throw new Error("设备未连接");
  if (frameSendRunning) return null;
  frameSendRunning = true;
  const send = button("sendBtn");
  send.disabled = true;
  try {
    if (refreshSensorsFirst) await refreshSensors();
    const frame = editor.getFrame();
    const currentRotation = rotation();
    const changed = changedRegion(lastSentFrame, frame);
    const fullRefreshDue =
      lastFullRefreshAt === 0 ||
      (deviceConfig !== null && Date.now() - lastFullRefreshAt >= deviceConfig.fullRefreshMs);
    if (changed === null && !fullRefreshDue) {
      setSendStatus("无需刷新", "画面像素没有变化", "ready");
      return null;
    }

    const canUsePartial =
      changed !== null &&
      !fullRefreshDue &&
      lastSentFrame !== null &&
      lastSentRotation === currentRotation &&
      deviceInfo?.capabilities?.partialRefresh === true &&
      deviceConfig?.partialRefreshEnabled === true;
    const requestedMode = canUsePartial ? "partial" : "full";
    setSendStatus(
      requestedMode === "partial" ? "正在局部更新" : "正在全屏更新",
      requestedMode === "partial"
        ? `变化区域 ${changed?.width ?? 0}×${changed?.height ?? 0}，正在发送画面`
        : "正在传输 5,624 字节画面",
      "busy",
    );

    const response = await serial.sendFrame(frame, currentRotation, requestedMode);
    lastSentFrame = copyFrame(frame);
    lastSentRotation = currentRotation;
    if (response.mode === "full") lastFullRefreshAt = Date.now();
    const detail = describeFrameResponse(response);
    setSendStatus("发送完成", detail, "ready");
    if (notify) toast(detail);
    return response;
  } finally {
    frameSendRunning = false;
    send.disabled = !serial.connected;
  }
}

async function connectOrDisconnect(): Promise<void> {
  const connect = button("connectBtn");
  connect.disabled = true;
  try {
    if (serial.connected) {
      await serial.disconnect();
      deviceInfo = null;
      deviceConfig = null;
      liveSensors = {};
      lastSentFrame = null;
      lastSentRotation = null;
      lastFullRefreshAt = 0;
      stopRefreshSchedulers();
      showDeviceInfo(null);
      applySensors();
      return;
    }
    setSendStatus("正在连接", "请在浏览器窗口中选择 ESP32-C3", "busy");
    deviceInfo = await serial.connect();
    showDeviceInfo(deviceInfo);
    await Promise.all([refreshSensors(), loadDeviceConfig()]);
    toast(`已连接 ${deviceInfo.board}`);
  } catch (error) {
    setConnectedUi(false);
    toast(errorMessage(error), "error");
  } finally {
    connect.disabled = false;
  }
}

function setFirmwareBusy(busy: boolean): void {
  firmwareOperationRunning = busy;
  button("backupFirmwareBtn").disabled = busy || !serial.supported;
  button("flashFirmwareBtn").disabled = busy || !serial.supported;
  button("chooseFirmwareBtn").disabled = busy;
  button("useBuiltInFirmwareBtn").disabled = busy;
  button("connectBtn").disabled = busy || !serial.supported;
}

const browserFlasher = new BrowserFlasher(
  ({ percent, detail }) => {
    element("flashProgressWrap").hidden = false;
    element<HTMLProgressElement>("flashProgress").value = Math.max(0, Math.min(100, percent));
    element("flashStatus").textContent = detail;
  },
  (line) => {
    const trimmed = line.trim();
    if (trimmed) element("flashStatus").textContent = trimmed;
  },
);

async function firmwareOperationPort(): Promise<SerialPort> {
  const connectedPort = serial.selectedPort;
  if (connectedPort) {
    await serial.disconnect();
    return connectedPort;
  }
  if (!navigator.serial) throw new Error("当前浏览器不支持 Web Serial");
  return navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a }] });
}

async function selectedFirmwareImage(): Promise<Uint8Array> {
  if (customFirmwareFile) {
    const data = new Uint8Array(await customFirmwareFile.arrayBuffer());
    validateFullFirmware(data);
    return data;
  }
  return loadBuiltInFirmware();
}

function useBuiltInFirmware(): void {
  customFirmwareFile = null;
  element("firmwareFileName").textContent = BUILT_IN_FIRMWARE_LABEL;
  element("firmwareFileMeta").textContent = "刷写地址 0x0 · DIO · 4 MB";
  button("useBuiltInFirmwareBtn").hidden = true;
}

function bindInspector(): void {
  element<HTMLTextAreaElement>("layerTextInput").addEventListener("input", (event) => {
    updateSelected({ text: (event.currentTarget as HTMLTextAreaElement).value });
  });
  select("sensorKeyInput").addEventListener("change", (event) => {
    const sensorKey = (event.currentTarget as HTMLSelectElement).value;
    updateSelected({ sensorKey, ...sensorLayerDefaults(sensorKey) });
  });
  const textFields: Array<[string, keyof Pick<EditorLayerPatch, "prefix" | "suffix" | "fallback">]> = [
    ["prefixInput", "prefix"],
    ["suffixInput", "suffix"],
    ["fallbackInput", "fallback"],
  ];
  for (const [id, key] of textFields) {
    input(id).addEventListener("input", (event) => {
      updateSelected({ [key]: (event.currentTarget as HTMLInputElement).value });
    });
  }
  const numberFields: Array<
    [string, keyof Pick<EditorLayerPatch, "x" | "y" | "fontSize" | "padding" | "decimals">]
  > = [
    ["xInput", "x"],
    ["yInput", "y"],
    ["fontSizeInput", "fontSize"],
    ["paddingInput", "padding"],
    ["decimalsInput", "decimals"],
  ];
  for (const [id, key] of numberFields) {
    input(id).addEventListener("input", (event) => {
      const value = Number((event.currentTarget as HTMLInputElement).value);
      if (Number.isFinite(value)) updateSelected({ [key]: value });
    });
  }
  select("fontFamilyInput").addEventListener("change", () =>
    updateSelected({ fontFamily: select("fontFamilyInput").value }),
  );
  select("colorInput").addEventListener("change", () =>
    updateSelected({ color: select("colorInput").value as "black" | "white" }),
  );
  select("backgroundInput").addEventListener("change", () =>
    updateSelected({
      background: select("backgroundInput").value as "transparent" | "white" | "black",
    }),
  );
  input("boldInput").addEventListener("change", () =>
    updateSelected({ bold: input("boldInput").checked }),
  );
}

for (const key of NUMERIC_IMAGE_KEYS) bindNumericImageControl(key);
select("ditherInput").addEventListener("change", () => {
  editor.setImageSettings({ dither: select("ditherInput").value as DitherMode });
});
input("invertInput").addEventListener("change", () => {
  editor.setImageSettings({ invert: input("invertInput").checked });
});
button("resetImageBtn").addEventListener("click", () => {
  editor.setImageSettings({ ...DEFAULT_IMAGE_SETTINGS });
  syncImageControls();
});

const imageInput = input("imageInput");
const dropzone = element("dropzone");
dropzone.addEventListener("click", () => imageInput.click());
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") imageInput.click();
});
imageInput.addEventListener("change", () => {
  void handleImage(imageInput.files?.[0]).catch((error) => toast(errorMessage(error), "error"));
  imageInput.value = "";
});
for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  });
}
dropzone.addEventListener("drop", (event) => {
  void handleImage(event.dataTransfer?.files[0]).catch((error) => toast(errorMessage(error), "error"));
});
button("chooseImageBtn").addEventListener("click", () => imageInput.click());
button("removeImageBtn").addEventListener("click", () => {
  editor.clearImage();
  imageLoaded = false;
  dropzone.hidden = false;
  element("imageActions").hidden = true;
});

button("addTextBtn").addEventListener("click", () => editor.addText("新的文字"));
button("addSensorBtn").addEventListener("click", () => editor.addSensor());
button("duplicateLayerBtn").addEventListener("click", () => editor.duplicateSelected());
button("deleteLayerBtn").addEventListener("click", () => editor.removeSelected());
button("layerUpBtn").addEventListener("click", () => {
  if (editor.selectedId) editor.moveLayer(editor.selectedId, "up");
});
button("layerDownBtn").addEventListener("click", () => {
  if (editor.selectedId) editor.moveLayer(editor.selectedId, "down");
});
bindInspector();

button("connectBtn").addEventListener("click", () => void connectOrDisconnect());
button("refreshSensorsBtn").addEventListener("click", () => {
  void refreshSensors()
    .then(() => toast("传感器数据已刷新"))
    .catch((error) => toast(errorMessage(error), "error"));
});
button("reloadConfigBtn").addEventListener("click", () => {
  void loadDeviceConfig()
    .then(() => toast("已重新载入设备配置"))
    .catch((error) => toast(errorMessage(error), "error"));
});
element<HTMLFormElement>("deviceConfigForm").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveDeviceConfig().catch((error) => {
    element("configMessage").textContent = `保存失败：${errorMessage(error)}`;
    toast(errorMessage(error), "error");
  });
});
input("autoRefreshInput").addEventListener("change", restartRefreshSchedulers);
button("sendBtn").addEventListener("click", () => {
  void sendCurrentFrame(true, true).catch((error) => {
      setSendStatus("发送失败", errorMessage(error));
      toast(errorMessage(error), "error");
  });
});
button("clearBtn").addEventListener("click", () => {
  void (async () => {
    const clear = button("clearBtn");
    clear.disabled = true;
    setSendStatus("正在清空", "设备正在刷新为全白画面", "busy");
    try {
      await serial.clear();
      lastSentFrame = new Uint8Array(5624).fill(0xff);
      lastSentRotation = 90;
      lastFullRefreshAt = Date.now();
      setSendStatus("屏幕已清空", "编辑器内容仍然保留", "ready");
      toast("设备屏幕已清空");
    } catch (error) {
      setSendStatus("清空失败", errorMessage(error));
      toast(errorMessage(error), "error");
    } finally {
      clear.disabled = !serial.connected;
    }
  })();
});

const firmwareFileInput = input("firmwareFileInput");
button("chooseFirmwareBtn").addEventListener("click", () => firmwareFileInput.click());
button("useBuiltInFirmwareBtn").addEventListener("click", useBuiltInFirmware);
firmwareFileInput.addEventListener("change", () => {
  const file = firmwareFileInput.files?.[0];
  firmwareFileInput.value = "";
  if (!file) return;
  void (async () => {
    const data = new Uint8Array(await file.arrayBuffer());
    validateFullFirmware(data);
    customFirmwareFile = file;
    const hash = await sha256Hex(data);
    element("firmwareFileName").textContent = file.name;
    element("firmwareFileMeta").textContent = `${(file.size / 1024).toFixed(0)} KB · SHA-256 ${hash.slice(0, 12)}…`;
    button("useBuiltInFirmwareBtn").hidden = false;
    toast("本地一体化固件已载入并校验");
  })().catch((error) => toast(errorMessage(error), "error"));
});

button("backupFirmwareBtn").addEventListener("click", () => {
  if (firmwareOperationRunning) return;
  if (!window.confirm("将读取并下载设备整颗 4 MB Flash。备份可能包含网络凭据，是否继续？")) return;
  setFirmwareBusy(true);
  const portPromise = firmwareOperationPort();
  void (async () => {
    const port = await portPromise;
    const result = await browserFlasher.backup(port);
    const hash = await sha256Hex(result.data);
    const blobData = result.data.slice().buffer as ArrayBuffer;
    download(new Blob([blobData], { type: "application/octet-stream" }), `quote0-backup-${timestamp()}.bin`);
    element("flashStatus").textContent = `备份完成 · SHA-256 ${hash}`;
    toast("4 MB 固件备份已下载");
  })()
    .catch((error) => {
      element("flashProgressWrap").hidden = false;
      element("flashStatus").textContent = `备份失败：${errorMessage(error)}`;
      toast(errorMessage(error), "error");
    })
    .finally(() => setFirmwareBusy(false));
});

button("flashFirmwareBtn").addEventListener("click", () => {
  if (firmwareOperationRunning) return;
  const source = customFirmwareFile ? customFirmwareFile.name : BUILT_IN_FIRMWARE_LABEL;
  if (!window.confirm(`即将用“${source}”覆盖设备固件。请确认目标是 Quote/0 ESP32-C3，是否继续？`)) return;
  setFirmwareBusy(true);
  const portPromise = firmwareOperationPort();
  void (async () => {
    const port = await portPromise;
    const image = await selectedFirmwareImage();
    const hash = await sha256Hex(image);
    const result = await browserFlasher.flash(image, port);
    element("flashStatus").textContent = `刷写完成 · ${result.chip} · SHA-256 ${hash}`;
    toast("固件刷写完成，设备已复位；请重新连接 USB");
  })()
    .catch((error) => {
      element("flashProgressWrap").hidden = false;
      element("flashStatus").textContent = `刷写失败：${errorMessage(error)}`;
      toast(errorMessage(error), "error");
    })
    .finally(() => setFirmwareBusy(false));
});

element<HTMLFormElement>("customSensorForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = input("customSensorKey").value.trim();
  const value = Number(input("customSensorValue").value);
  if (!key || !Number.isFinite(value)) return;
  customSensors[key] = value;
  input("customSensorKey").value = "";
  input("customSensorValue").value = "";
  applySensors();
  toast(`已添加自定义数据 ${key}`);
});

button("exportPngBtn").addEventListener("click", () => {
  void editor
    .toPngBlob()
    .then((blob) => download(blob, `inklink-screen-${timestamp()}.png`))
    .catch((error) => toast(errorMessage(error), "error"));
});
button("saveProjectBtn").addEventListener("click", () => {
  const project = editor.toProject(rotation(), customSensors);
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  download(blob, `inklink-project-${timestamp()}.json`);
  toast("项目文件已保存");
});
const projectInput = input("projectInput");
button("loadProjectBtn").addEventListener("click", () => projectInput.click());
projectInput.addEventListener("change", () => {
  const file = projectInput.files?.[0];
  projectInput.value = "";
  if (!file) return;
  void (async () => {
    const parsed = JSON.parse(await file.text()) as ProjectFile;
    await editor.loadProject(parsed);
    customSensors = { ...(parsed.customSensors ?? {}) };
    select("rotationInput").value = String(parsed.rotation ?? 90);
    imageLoaded = Boolean(parsed.backgroundDataUrl);
    dropzone.hidden = imageLoaded;
    element("imageActions").hidden = !imageLoaded;
    syncImageControls();
    applySensors();
    toast("项目已打开");
  })().catch((error) => toast(`打开失败：${errorMessage(error)}`, "error"));
});

window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.matches("input, textarea, select") || target?.isContentEditable) return;
  if ((event.key === "Delete" || event.key === "Backspace") && editor.selectedId) {
    editor.removeSelected();
    event.preventDefault();
    return;
  }
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    const layer = editor.getSelectedLayer();
    if (!layer) return;
    const amount = event.shiftKey ? 10 : 1;
    const patch: EditorLayerPatch = {};
    if (event.key === "ArrowLeft") patch.x = layer.x - amount;
    if (event.key === "ArrowRight") patch.x = layer.x + amount;
    if (event.key === "ArrowUp") patch.y = layer.y - amount;
    if (event.key === "ArrowDown") patch.y = layer.y + amount;
    editor.updateSelected(patch);
    event.preventDefault();
  }
});

serial.onConnectionChange = (connected) => {
  setConnectedUi(connected);
  if (!connected) {
    deviceInfo = null;
    deviceConfig = null;
    lastSentFrame = null;
    lastSentRotation = null;
    lastFullRefreshAt = 0;
    stopRefreshSchedulers();
    showDeviceInfo(null);
    element("configMessage").textContent = "连接设备后自动读取当前配置。";
    element("wifiRuntimeState").textContent = "未连接";
    element("bluetoothRuntimeState").textContent = "未连接";
    element("partialSupportState").textContent = "等待检测屏幕";
  }
};

editor.onChange = () => {
  renderLayerList();
};
editor.onSelectionChange = syncInspector;

showDeviceInfo(null);
setConnectedUi(false);
syncImageControls();
renderLayerList();
renderSensors();
useBuiltInFirmware();
setFirmwareBusy(false);

if (!serial.supported) {
  button("connectBtn").disabled = true;
  toast("Web Serial 不可用：请使用桌面版 Chrome/Edge，并通过 localhost 或 HTTPS 打开", "error");
}
