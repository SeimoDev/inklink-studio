# Quote/0 硬件映射

本文记录新固件实际使用的板级信息。信息来自启动日志、固件静态分析和非破坏性串口探测，并用公开驱动交叉核对；没有拆焊或修改 eFuse。

## 核心器件

| 项目 | 值 |
| --- | --- |
| 主控 | ESP32-C3 QFN32 revision v0.4 |
| Flash | 4 MB，DIO，80 MHz |
| USB | ESP32-C3 内置 USB Serial/JTAG，VID:PID `303A:1001` |
| 产品 | MindReset Quote/0 |
| 墨水屏控制器 | UC8251D，原固件检测 revision `0x0A` |
| 面板原生尺寸 | 152×296 |
| 用户画布 | 296×152 |
| 像素格式 | 1-bit，`1` 为白、`0` 为黑，MSB-first |
| 屏幕总线 | 四线 SPI，mode 0，15 MHz |

## GPIO

| 功能 | GPIO | 方向/备注 |
| --- | ---: | --- |
| EPD BUSY | 3 | 输入，上拉；低电平表示忙 |
| EPD RESET | 4 | 输出 |
| EPD DC | 5 | 输出，命令/数据选择 |
| EPD CS | 6 | 输出，SPI 片选 |
| EPD MOSI | 7 | 输出 |
| EPD SCLK | 10 | 输出 |
| EPD 电源使能 | 20 | 输出高电平开启；休眠后切换为高阻输入 |
| VBUS 检测 | 0 | 输入 |
| 电池 ADC | 1 | ADC1 channel 1，12 dB 衰减 |

GPIO 映射是该产品的板级连接，不是通用 ESP32-C3 开发板引脚。

## 电源与复位

启动屏幕前使用原固件的电源与复位顺序：

1. 将 GPIO20 设为输出并置 `POWER=1`，等待 2 ms。
2. `RESET=1`，等待 10 ms。
3. `RESET=0`，等待 10 ms。
4. `RESET=1`、`CS=1`，等待 10 ms。
5. 发送 `GET_STATUS (0x71)` 后采样 BUSY，等待其回到高电平。

屏幕完成刷新后再等待 2.7 秒，使全刷波形稳定；随后发送 deep-sleep `0x07 A5`，并把 GPIO20 切换为高阻输入。原固件不会在此路径中强制拉低 GPIO20。

## UC8251D 初始化

| 命令 | 数据 | 作用 |
| --- | --- | --- |
| `0x00` | `F3 0E` | Panel setting |
| `0x01` | `03 00 3F 3F 03` | Power setting |
| `0x06` | `17 17 17` | Booster soft start |
| `0x61` | `98 01 28` | Resolution：152×296 |
| `0x30` | `1B` | PLL |
| `0x60` | `22` | TCON |
| `0x82` | `00` | VCOM DC |
| `0x03` | `10` | Power saving |
| `0x50` | `97` | Border waveform |
| `0x04` | — | Power on |

Power on 后还需要写入 Quote/0 原厂的 376 字节全刷波形表：`0x20` 为 80 字节、`0x21` 为 56 字节，`0x22`、`0x23`、`0x24` 各 80 字节。缺少这组 LUT 时，控制器会在 `0x12` 后保持 BUSY 并持续刷新。

完整帧依次发送 `0x10`（旧图）、`0x13`（新图）、`0x12`（刷新），每次读取 BUSY 前先发送 `0x71`。BUSY 回到高电平且波形稳定后，使用 `0x07 A5` 进入 deep sleep。

## 局部刷新能力

精确模组规格 HINK-E0266A85 和 UC8251D 控制器手册都定义了硬件局部窗口：`0x91` 进入局刷、`0x90` 写入 7 字节窗口、`0x92` 退出。窗口横向源线以 8 像素对齐，纵向范围为 9-bit；最后一个字节使用 `PT_SCAN=0`，让控制器只扫描窗口内的 gate/source。

原厂 Quote/0 应用中没有调用这三个局刷命令，因此本项目采用保守路径：沿用已经验证的 376 字节波形，只限制扫描窗口，不使用来源不明的“快速 LUT”。固件保留上一帧，在 MCU 中计算真实变化边界，并在首帧、方向变化、变化过大、达到时间间隔或累计 10 次局刷时强制全刷。这样局刷的主要收益是减少无关区域闪动；单次用时不会像激进的快速波形那样大幅缩短。

参考资料：[HINK-E0266A85 模组规格](https://www.actron.de/wp-content/uploads/HINK-E0266A85-Spec-A0.pdf)、[UC8251D 控制器手册](https://www.buydisplay.com/download/ic/UC8251.pdf)、[Waveshare 2.66 英寸面板说明](https://www.waveshare.com/wiki/2.66inch_e-Paper_Module_Manual)。

## 坐标旋转

网页始终输出横向 `(x, y)`，范围 `x=0..295`、`y=0..151`。固件写屏前转成原生 `(nx, ny)`：

- 90°：`nx = y`，`ny = 295 - x`
- 270°：`nx = 151 - y`，`ny = x`

这样网页不需要知道面板内部的竖向存储方式。

## 传感器说明

- 电池电压通过 GPIO1 的 ADC 读取，固件按 2:1 分压估算；该比例来自原固件行为，尚未用万用表在测试点实测。
- 电量百分比按 3300–4200 mV 线性近似，仅用于界面提示。
- 芯片温度来自 ESP32-C3 内置温度传感器，是芯片结温趋势值。
- VBUS 来自 GPIO0，表示当前 USB 供电检测状态。

公开参考：[MindReset Quote/0](https://dot.mindreset.tech/product/quote)、[Quote/0 SDK](https://github.com/1set/quote0)、[Waveshare 2.66 英寸 e-Paper 驱动](https://github.com/waveshareteam/e-Paper/tree/master/Arduino/epd2in66)。
