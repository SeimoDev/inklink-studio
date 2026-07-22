# InkLink Studio

InkLink Studio 是 MindReset Quote/0（ESP32-C3 + 296×152 黑白墨水屏）的本地 Web 控制工程。浏览器是唯一的用户入口：通过 USB Web Serial 编辑画面、读取传感器与设备配置、控制 Wi-Fi/BLE、备份 Flash，并刷写内置或本地固件。

项目不依赖云服务或后端，也不再维护独立启动、刷写或恢复脚本。

## 在线使用

访问 [https://eink.seimo.cn](https://eink.seimo.cn)，使用桌面版 Chrome 或 Edge 通过 USB 连接设备。

## 工程结构

```text
EInk/
├── web/                    # TypeScript / Canvas / Web Serial 前端
│   ├── public/firmware/    # 浏览器内置的当前一体化固件
│   ├── src/core/           # 共享模型与版本信息
│   ├── src/device/         # 串口协议、传感器、刷新与浏览器刷写
│   ├── src/editor/         # 画布、图像处理与 1-bit 帧缓冲
│   ├── src/platform/       # 浏览器平台类型声明
│   └── tests/              # 单元测试
├── firmware/               # ESP-IDF 固件与 UC8251D 驱动
├── docs/                   # 硬件映射、架构与 USB 协议
└── backups/                # 设备私有备份，仅本地存在并由 Git 忽略
```

详细的数据流和模块边界见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 启动 Web

需要桌面版 Chrome 或 Edge。Web Serial 必须运行在 `localhost` 或 HTTPS 安全上下文中，不能直接双击 `index.html`。

```sh
cd web
npm ci
npm run dev
```

打开 <http://127.0.0.1:4173>，然后在网页中完成设备连接、配置读取、画面发送、固件备份或刷写。

## 验证 Web

```sh
cd web
npm run typecheck
npm test
npm run build
```

更多前端开发信息见 [`web/README.md`](web/README.md)。

## Docker 部署

Docker 使用多阶段构建生成 Web 生产包，并由非 root Nginx 容器提供静态服务。默认映射宿主机 `19888` 端口：

```sh
docker compose up -d --build
curl http://127.0.0.1:19888/healthz
```

如需更换宿主机端口，可在启动时设置 `INKLINK_PORT`。容器设置了健康检查、只读根文件系统和 `unless-stopped` 自动重启策略。

## 构建固件

固件基线为 ESP-IDF 5.5.2：

```sh
. "$IDF_PATH/export.sh"
cd firmware
idf.py set-target esp32c3
idf.py build
```

日常刷写统一从网页的“浏览器刷写与备份”区域执行。固件构建、合并为浏览器资源及分区说明见 [`firmware/README.md`](firmware/README.md)。

## 当前能力

- 296×152 可视化编辑，图片裁剪、缩放、灰阶转 1-bit 与多种抖动算法
- 文字和传感器图层自由定位、样式调整、层级管理与项目 JSON 导入导出
- 电池电压、电量、芯片温度、USB 状态、运行时间和可用内存读取
- 从设备载入并保存 Wi-Fi、BLE、数据读取、屏幕更新及强制全刷间隔
- UC8251D 变化区域局刷、周期全刷和无变化跳过
- 浏览器内置固件刷写、本地固件载入及整颗 4 MB Flash 备份下载

屏幕是黑白 1-bit 面板；网页中的灰阶效果通过抖动网点模拟，发送到设备的最终画面只有黑白两色。

## 隐私与安全

`backups/`、设备信息和其他私有目录不会进入 Git。网页内置资源只有当前 InkLink 一体化固件，不包含原设备 NVS、凭据或整片 Flash 备份。

浏览器刷写会覆盖设备固件。仅对已确认采用相同板级引脚、UC8251D 屏幕和 4 MB Flash 的 Quote/0 设备操作。

## 文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：Web-only 工程架构和数据流
- [`docs/HARDWARE.md`](docs/HARDWARE.md)：屏幕、GPIO、电源时序与局刷依据
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md)：USB 串口协议 v2
- [`firmware/README.md`](firmware/README.md)：固件构建与浏览器固件资源生成
- [`web/README.md`](web/README.md)：前端开发、测试和生产构建
