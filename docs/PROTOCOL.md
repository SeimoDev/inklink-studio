# InkLink USB 协议 v2

固件通过 ESP32-C3 内置 USB Serial/JTAG 暴露串口。主机发送 ASCII 命令行，设备以单行 JSON 回复；只有 `FRAME` 在头部之后携带定长二进制数据。v2 在 v1 的画面与传感器命令上增加设备配置、无线开关和局部刷新。

## 串口与帧格式

| 项目 | 值 |
| --- | --- |
| 逻辑波特率 | 115200（原生 USB） |
| 文本编码 | UTF-8；命令为可打印 ASCII |
| 行结束 | `\n`，也接受 `\r\n` |
| 最大命令行 | 255 字节 |
| 协议版本 | 2 |
| 画面 | 296×152、1-bit、5,624 字节 |
| 像素 | MSB-first；`1 = white`，`0 = black` |
| CRC | CRC-32/ISO-HDLC，反射多项式 `0xEDB88320` |

像素 `(x, y)` 的位置为 `frame[y * 37 + floor(x / 8)]`，位掩码为 `0x80 >> (x % 8)`。ASCII `123456789` 的 CRC 校验结果是 `CBF43926`。

所有请求均带十进制 `id`，设备原样返回。错误响应示例：

```json
{"type":"error","id":7,"ok":false,"code":"BAD_CONFIG_RANGE","message":"refresh interval is outside the supported range"}
```

## 设备信息

```text
HELLO 1\n
```

```json
{"type":"hello","id":1,"ok":true,"protocol":2,"firmware":"1.1.2","board":"MindReset Quote/0","panel":"UC8251D","width":296,"height":152,"frameBytes":5624,"rotations":[90,270],"flashBytes":4194304,"capabilities":{"deviceConfig":true,"partialRefresh":true,"wifiSwitch":true,"bluetoothSwitch":true},"maxPartialRefreshes":10,"sensors":["battery_mv","battery_percent","chip_temperature_c","vbus_present","uptime_s","free_heap"]}
```

`INFO id` 是别名，响应类型仍为 `hello`。`PING id` 返回 `pong`。

## 读取传感器

```text
SENSORS 2\n
```

```json
{"type":"sensors","id":2,"ok":true,"values":{"battery_mv":3894,"battery_percent":66,"chip_temperature_c":32.25,"vbus_present":true,"uptime_s":84,"free_heap":295104}}
```

无法读取的模拟值为 `null`。芯片温度不是环境温度，电量百分比是电压估算。

## 读取与写入设备配置

读取 NVS 中的当前配置：

```text
CONFIG 3\n
```

```json
{"type":"config","id":3,"ok":true,"wifiEnabled":false,"bluetoothEnabled":false,"wifiActive":false,"bluetoothActive":false,"dataRefreshMs":30000,"screenRefreshMs":60000,"fullRefreshMs":1800000,"partialRefreshEnabled":true,"limits":{"dataMinMs":1000,"screenMinMs":10000,"fullMinMs":180000,"maxMs":86400000}}
```

写入配置：

```text
SET_CONFIG <id> <wifi:0|1> <bluetooth:0|1> <data_ms> <screen_ms> <full_ms> <partial:0|1>\n
```

示例：

```text
SET_CONFIG 4 1 0 30000 60000 1800000 1\n
```

设备会先启停 Wi‑Fi/BLE 控制器，成功后再提交 NVS，并返回最新 `config`。`wifiEnabled`/`bluetoothEnabled` 是持久化请求值，`wifiActive`/`bluetoothActive` 是当前运行状态。当前固件只负责射频控制器开关，不包含 Wi‑Fi 入网或 BLE 应用服务。

间隔限制：数据读取 1 秒以上、屏幕更新 10 秒以上、强制全刷 180 秒以上；全刷间隔不能小于屏幕更新间隔。数据与屏幕定时任务由保持打开且已连接的网页执行，固件保存并向新网页会话提供这些参数。

## 发送画面

```text
FRAME <id> <length> <crc32-hex> <rotation> [full|partial|auto]\n
```

省略刷新模式时按 `full` 处理，兼容协议 v1。设备验证头部后回复：

```json
{"type":"ready","id":5,"ok":true,"bytes":5624}
```

主机随后发送恰好 5,624 个原始字节，不追加换行。完成响应示例：

```json
{"type":"frame","id":5,"ok":true,"crc32":"89abcdef","refreshMs":4038,"mode":"partial","region":{"x":180,"y":16,"width":64,"height":24},"partialCount":3}
```

刷新策略：

- `full` 始终执行全屏刷新。
- `partial` 和 `auto` 都表示允许固件按设备中保存的策略选择刷新方式，而不是强制局刷。网页使用 `auto`，因此断开和重新连接 Web Serial 不会重置局刷/全刷策略。
- 固件根据上一帧计算真实变化边界，并按 UC8251D 的 8 像素源线边界对齐。
- 首帧、方向变化、未启用局刷、变化区域达到屏幕 75%、达到全刷时间或累计 10 次局刷时自动降级为全刷。
- 像素完全相同且无需维护性全刷时返回 `mode:"none"`，不驱动屏幕。
- `region` 使用网页横向坐标；实际窗口可能因 8 像素对齐稍大于网页计算的像素变化范围。

可用方向只有 `90` 和 `270`。二进制传输超过 10 秒没有新数据时，设备丢弃帧并返回 `FRAME_TIMEOUT`。

## 清空屏幕

```text
CLEAR 6\n
```

设备执行全白全刷，返回 `clear`、`espError` 和 `refreshMs`，同时清零局刷计数。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `BAD_FRAME_HEADER` | FRAME 头格式错误 |
| `BAD_FRAME_SIZE` | 长度不是 5,624 字节 |
| `BAD_ROTATION` | 方向不是 90 或 270 |
| `BAD_REFRESH_MODE` | 模式不是 full/partial/auto |
| `CRC_MISMATCH` | 二进制内容和 CRC 不一致 |
| `FRAME_TIMEOUT` | 帧接收中断超过 10 秒 |
| `DISPLAY_FAILED` | 屏幕初始化、SPI 或 BUSY 等待失败 |
| `BAD_CONFIG` | 配置命令格式或布尔值错误 |
| `BAD_CONFIG_RANGE` | 刷新间隔超出限制 |
| `RADIO_FAILED` | 无线控制器启停失败；旧状态会被恢复 |
| `CONFIG_SAVE_FAILED` | NVS 写入失败；旧状态会被恢复 |
| `LINE_TOO_LONG` | 文本命令超过缓冲区 |
| `UNKNOWN_COMMAND` | 命令未知 |

协议一次只允许一个请求在途。网页客户端串行化所有命令，发送帧时先等 `ready`，再写二进制并等待最终响应。
