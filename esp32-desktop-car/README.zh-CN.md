# esp32-desktop-car

[English](./README.md) | **简体中文**

语音控制的双轮桌面机器人，几乎完全用 Rust 写成，构建在 `voiceagent-esp32` SDK 之上。

底盘是一个小巧的 ESP32-S3 桌面玩具，包含：

- INMP441 I2S 麦克风（单工）
- MAX98357A I2S 功放驱动小扬声器（24 kHz）
- SSD1306 OLED（128×32）用于显示状态
- TC1508 双 H 桥驱动两个 N20 轮毂电机
- BOOT 按键（按住说话）和一个电容触摸片（静音切换）

传动系统以一组原生 Go 工具的形式暴露给 LLM，位于 `server/internal/tools/car.go`。当 LLM
调用其中之一时，服务端流水线会发出一个按 topic 寻址的 data-channel 包
（`{"type":"data","topic":"car.command","payload":"<base64 JSON>"}`），固件的 `on_data`
回调解码它，然后由电机工作线程执行动作。整个过程不涉及子进程插件。

## 引脚表

| 功能           | GPIO            |
| ------------------ | --------------- |
| 麦克风 `WS`         | 4               |
| 麦克风 `BCLK`       | 5               |
| 麦克风 `DIN`        | 6               |
| 扬声器 `DOUT`     | 7               |
| 扬声器 `BCLK`     | 15              |
| 扬声器 `WS/LRCK`  | 16              |
| OLED  `SDA`        | 41              |
| OLED  `SCL`        | 42              |
| 电机 `LF`         | 12              |
| 电机 `LB`         | 13              |
| 电机 `RF`         | 14              |
| 电机 `RB`         | 21              |
| BOOT 按键（PTT）  | 0               |
| 触摸按键       | 47              |
| 音量 +           | 40              |
| 音量 −           | 39              |
| 板载 LED        | 48              |

GPIO 12/13/14/21 由共享一个 5 kHz、10 位定时器的四个 LEDC 通道驱动。

## 构建

一次性准备：

```bash
rustup install nightly
cargo install espup espflash ldproxy
espup install
. ~/export-esp.sh
```

然后在本目录：

```bash
cp .env.example .env
$EDITOR .env          # WIFI_SSID / WIFI_PASSWORD / WHIP_ENDPOINT
cargo build --release
```

## 烧录与监视

`--release` 是 Cargo 的参数，不是 espflash 的 —— `cargo build --release` 产出 release
二进制；把生成的 ELF 直接交给 espflash：

```bash
cargo build --release
espflash flash --monitor target/xtensa-esp32s3-espidf/release/desktop_car
```

或者取消 `.cargo/config.toml` 中 `runner = "espflash flash --monitor"` 那行的注释，
然后直接跑 `cargo run --release` —— Cargo 会替你用正确的二进制路径调用 espflash。

## 运行时行为

- 开机时麦克风为**静音**。按住 BOOT 按键即可按住说话，或轻触触摸片来锁定麦克风开/关。
- OLED 显示 `ONLINE / OFFLINE`、麦克风状态和最近一句用户发言。
- 所有电机 RPC 都接受两个可选参数：
  - `duration_ms` —— 上限 10 秒
  - `speed_percent` —— 0–100，默认取每个动作各自合理的值

### 服务端工具（可被 LLM 调用）

在 `server/main.go` 中注册为原生 Go 工具。每个都接受可选的 `duration_ms`（100–10000）
和 `speed_percent`（0–100）：

| 名称                       | 作用                              |
| -------------------------- | ----------------------------------------- |
| `car.forward`              | 双轮前进                       |
| `car.backward`             | 双轮后退                      |
| `car.turn_left`            | 原地逆时针旋转          |
| `car.turn_right`           | 原地顺时针旋转                  |
| `car.pivot_forward_left`   | 仅右轮前进                 |
| `car.pivot_forward_right`  | 仅左轮前进                 |
| `car.pivot_back_left`      | 仅右轮后退                |
| `car.pivot_back_right`     | 仅左轮后退                 |
| `car.stop`                 | 立即切断双电机               |
| `car.dance`                | 编排好的扭动动作                      |
| `car.shake`                | 快速左右摇摆                     |

流水线在 `server/internal/pipeline/pipeline.go`（`handleCarToolCall`）中拦截每一次
`car.*` 调用，并向设备写出单个 data-channel 包 —— 与 `vision.analyze` 是同一套模式。

### 设备端

只保留了一个可被服务端调用的 RPC：

| 名称              | 返回                                  |
| ----------------- | ---------------------------------------- |
| `get_device_info` | `model`、`wheels`、`sdk` 版本         |

电机动作不通过 `rpc_register` 暴露 —— 它们由 SDK 监听 `car.command` topic 的 `on_data`
回调驱动。

## 项目结构

```
src/
  main.rs              # WiFi + audio + agent + RPC wiring + buttons
  motor_controller.rs  # LEDC-PWM drivetrain + worker thread
  oled_display.rs      # SSD1306 status panel
```

SDK 边界以下的一切都是纯粹的 `esp-idf-hal` Rust —— 没有 C 垫片，也没有额外的 IDF 组件。
