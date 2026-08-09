# voiceagent-esp32 —— 示例固件

[English](./README.md) | **简体中文**

三个可直接烧录的二进制程序，展示使用 [`voiceagent-esp32`](../../esp32) SDK 的不同方式。
挑一个最接近你硬件的来改。

| 二进制          | 展示了什么                                                     | 硬件              |
| --------------- | ----------------------------------------------------------------- | --------------------- |
| `voice_agent`   | 全面：PTT 按键、显示屏 UI、摄像头 RPC、状态回调 | ESP32-S3 + 显示屏 + 摄像头 + 麦克风 + 扬声器 |
| `minimal_audio` | 最精简：连接即开麦、扬声器输出，约 80 行代码            | ESP32-S3 + 麦克风 + 扬声器 |
| `headless`      | 无显示屏/摄像头；`publish_data`、`on_data`、topic 心跳      | ESP32-S3 + 麦克风 + 扬声器 |

---

## 构建与烧录

```bash
# from this directory
export WIFI_SSID="my-wifi"
export WIFI_PASSWORD="my-password"
export WHIP_ENDPOINT="http://192.168.1.100:8080/whip"

cargo run --release                          # voice_agent (default)
cargo run --release --bin minimal_audio
cargo run --release --bin headless
```

`cargo run` 会一步完成 USB 烧录并打开串口监视器（通过 `espflash`）。

> **关于环境变量** —— 这些二进制在编译期通过 `option_env!()` 读取 `WIFI_SSID`、
> `WIFI_PASSWORD`、`WHIP_ENDPOINT` 和 `TOKEN_URL`。请在 `cargo run` 之前于 shell 中
> 设置它们，或者在二进制文件顶部写死。默认值在你的网络里不会生效。

---

## `voice_agent` —— LiveKit 风格的心智模型

演示所有回调，以及生产级固件的规范结构：

```
1. Init → 2. WiFi → 3. Build pipeline → 4. Create agent →
5. Register RPC tools → 6. Connect → 7. Run main loop (PTT)
```

agent 线程处理所有 WebRTC；主循环只负责轮询 PTT 按键并更新显示状态。按下
**GPIO0**（boot 按键）取消麦克风静音，松开即静音。助手在聆听时随时可以按 —— 屏幕
UI 会显示实时转写和 AI 回复。

已注册的 RPC handler：
- `capture_photo` —— 用 OV2640 拍一张 JPEG，并通过 `vision.image_chunk` topic 分片
  回传。AI 调用它来实现视觉能力。
- `get_device_info` —— 返回 SDK 版本 + 型号字符串。

---

## `minimal_audio` —— 最精简

无显示屏、无摄像头、无按键。整个会话期间麦克风始终开启。适合作为起点，或用于智能体
始终在听的无人值守安装场景。

---

## `headless` —— data-channel 演示

硬件与 `minimal_audio` 相同，但额外：

- 订阅入站 `data` 包（任意 topic）。
- 每 30 秒发布一个带运行时长的 `heartbeat` 包。
- 注册一个返回 `{"pong": true, "uptime_secs": …}` 的 `ping` RPC。
- 以 TRACE 级别记录每一个原始 data-channel 帧，便于协议调试。

当你要接入一套不使用内置 transcript/response 事件的自定义服务端协议时，照抄这个模型。

---

## 硬件引脚（默认）

三个二进制中的默认引脚号都对应 ESP32-S3 WROOM-1 参考布局。编辑各二进制顶部的
`.downgrade()` 调用即可覆盖。

| 功能    | 引脚    |
| ----------- | ------ |
| 麦克风 BCLK    | GPIO41 |
| 麦克风 DIN     | GPIO2  |
| 麦克风 WS      | GPIO42 |
| 扬声器 BCLK| GPIO46 |
| 扬声器 DOUT| GPIO3  |
| 扬声器 WS  | GPIO1  |
| 显示屏 MOSI| GPIO47 |
| 显示屏 SCLK| GPIO21 |
| 显示屏 CS  | GPIO14 |
| 显示屏 DC  | GPIO45 |
| 显示屏 BL  | GPIO48 |
| PTT 按键  | GPIO0  |

摄像头引脚在 [`esp32/src/camera.rs`](../../esp32/src/camera.rs) 中接线。
