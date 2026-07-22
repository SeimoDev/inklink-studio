# InkLink Quote/0 固件

目标：ESP32-C3 + UC8251D，USB Serial/JTAG 有线通信，296×152 黑白画面。

## ESP-IDF 构建

基线版本为 [ESP-IDF v5.5.2](https://github.com/espressif/esp-idf/releases/tag/v5.5.2)。

```sh
. "$IDF_PATH/export.sh"
idf.py set-target esp32c3
idf.py build
```

主要产物位于 `build/`：

- `inklink_quote0.bin`：应用
- `bootloader/bootloader.bin`：Bootloader
- `partition_table/partition-table.bin`：分区表

当前 Web 内置镜像由 ESP-IDF 5.5.2 与 GCC 14.2.0 构建并校验。v1.2.1 应用包含 Wi‑Fi/BLE 控制器、NVS 配置、离线场景持久化、自主传感器渲染和局刷 RAM 基线恢复；局刷 source 窗口会按面板扫描方向做垂直镜像。镜像大小为 `0xB1C80` 字节（约 711 KiB），仍低于 `0x1F0000` 的分区上限。

## 生成浏览器固件

Web 刷写器需要一个从 `0x0` 开始的一体化镜像。构建完成后，在 `firmware/` 中生成唯一的浏览器固件资源：

```sh
uvx --from esptool==5.3.1 esptool --chip esp32c3 merge-bin \
  --flash-mode dio \
  --flash-freq 80m \
  --flash-size 4MB \
  --output ../web/public/firmware/inklink-quote0-full.bin \
  0x0000 build/bootloader/bootloader.bin \
  0x8000 build/partition_table/partition-table.bin \
  0xD000 build/ota_data_initial.bin \
  0x10000 build/inklink_quote0.bin
```

随后计算新文件的 SHA-256，并更新 `web/src/core/release.ts` 中的版本和校验值：

```sh
shasum -a 256 ../web/public/firmware/inklink-quote0-full.bin
```

用户刷写、载入自定义固件和整片备份均从 Web 页面执行。不要把此配置刷入引脚不同的通用 ESP32-C3 开发板。

## 分区策略

新固件使用单个 `factory` 应用分区：

| Label | Offset | Size |
| --- | ---: | ---: |
| `nvs` | `0x9000` | `0x4000` |
| `otadata` | `0xD000` | `0x2000` |
| `phy_init` | `0xF000` | `0x1000` |
| `factory` | `0x10000` | `0x1F0000` |
| `scene` | `0x200000` | `0x200000` |

前三个数据分区沿用原设备偏移，应用从 `0x10000` 开始。`scene` 保存网页生成的静态底图、动态传感器布局和所需字形；当前场景上限为 64 KiB，分区余量为后续格式扩展保留。设备私有整片备份仅保存在 Git 忽略的 `backups/` 中。

## 运行配置

- NVS 命名空间为 `inklink`，保存 Wi‑Fi/BLE 开关、数据读取、屏幕刷新、强制全刷间隔和局刷开关。
- Wi‑Fi 和 BLE 默认关闭；网页可启停底层控制器。固件没有 Wi‑Fi 入网凭据界面、IP 服务或 BLE GATT 应用。
- 默认数据读取 30 秒、屏幕更新 60 秒、强制全刷 30 分钟。网页发送场景后，三个定时器都由固件执行；关闭网页或拔掉 USB 但设备仍由电池供电时不会停止。
- 网页以 `auto` 模式发送完整帧，局刷/全刷的最终决策由固件状态完成；GPIO0 的 VBUS 状态变化会绕过普通数据间隔并立即重绘。
- 首帧、方向变化、局刷关闭、变化区域达到 75% 或到达用户设置的全刷间隔时强制全屏刷新。局刷次数只用于诊断，不再覆盖用户的全刷时间设置。

## 设计约束

- USB 接收缓冲区为 8 KiB，可容纳一帧；每帧仍必须通过 CRC32。
- 屏幕 BUSY 等待最长 5 秒；每次采样前先发送 `GET_STATUS (0x71)`。二进制接收间隔最长 10 秒。
- 每次刷新前写入 Quote/0 的 376 字节 UC8251D 波形 LUT。局刷先恢复完整的新旧显示 RAM，再使用 `0x91/0x90/0x92` 限定物理扫描窗口，避免硬复位后窗口外变白；不使用未经验证的快速波形。
- 刷屏结束后等待波形稳定 2.7 秒，发送 deep-sleep `0x07 A5`，再将屏幕电源 GPIO20 释放为高阻输入。
- 第一次刷新使用全白旧帧；后续使用内存中的上一帧，并按真实像素差异计算局刷窗口。

线缆协议见 [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md)，硬件映射见 [`../docs/HARDWARE.md`](../docs/HARDWARE.md)。
