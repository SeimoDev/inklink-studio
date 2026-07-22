# InkLink Web

这是 InkLink Studio 唯一的用户控制入口。它是一个无后端的 Vite + TypeScript 应用，通过 Web Serial 直接连接 Quote/0。

## 环境要求

- 桌面版 Chrome 或 Edge
- Node.js 与 npm
- `localhost` 或 HTTPS；Web Serial 不允许普通文件页面访问设备

## 开发命令

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run preview
```

开发服务器和预览服务器均监听 <http://127.0.0.1:4173>。

## 源码分层

| 路径 | 职责 |
| --- | --- |
| `src/main.ts` | 页面装配、事件绑定和任务调度 |
| `src/core/` | 数据模型、屏幕常量和当前发布信息 |
| `src/device/` | Web Serial、离线场景编码、传感器、刷新策略和 esptool-js |
| `src/editor/` | Canvas 编辑器、图像处理和 1-bit 帧编码 |
| `src/platform/` | 浏览器 API 类型补充 |
| `tests/` | 纯逻辑单元测试 |

## 内置固件

浏览器从 `public/firmware/inklink-quote0-full.bin` 载入当前一体化固件。文件 URL、版本和 SHA-256 集中定义在 `src/core/release.ts`；更换固件时必须同时更新二进制和校验值。相同固件也单独附加在对应 GitHub Release，方便不经过网页直接下载。

网页也允许用户选择本地一体化 `.bin` 文件。载入和刷写前会检查 ESP 镜像头、分区表、应用偏移、目标 ESP32-C3 及 4 MB Flash 容量。

设备整片备份只通过浏览器生成并下载到用户选择的位置，不写入项目目录，也不会被打包到生产网站。

## 生产产物

`npm run build` 会生成 `dist/`。该目录属于可重复生成的构建产物，不纳入 Git；部署时发布 `dist/` 内容即可。

项目源码采用 `GPL-3.0-only`，完整条款见仓库根目录 [`LICENSE`](../LICENSE)。
