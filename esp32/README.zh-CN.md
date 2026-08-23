# voiceagent-esp32 —— 示例固件

[English](./README.md) | **简体中文**

三个可直接烧录的二进制程序，展示使用 [`voiceagent-esp32`](../../esp32) SDK 的不同方式。
挑一个最接近你硬件的来改。

| 二进制          | 展示了什么                                                     | 硬件              |
| --------------- | ----------------------------------------------------------------- | --------------------- |
| `voice_agent`   | 全面：PTT 按键、显示屏 UI、摄像头 RPC、状态回调 | ESP32-S3 + 显示屏 + 摄像头 + 麦克风 + 扬声器 |
| `minimal_audio` | 最精简：连接即开麦、扬声器输出，约 80 行代码            | ESP32-S3 + 麦克风 + 扬声器 |
| `headless`      | 无显示屏/摄像头；`publish_data`、`on_data`、topic 心跳      | ESP32-S3 + 麦克风 + 扬声器 |

本 crate 只包含应用层代码。`Agent::create` 之下的一切 —— WHIP 信令、`esp_peer`、Opus、
I2S、AFE —— 都在 [`esp32/`](../../esp32) 的 SDK crate 里，通过 path 依赖引入。

---

## 分步指南：构建与烧录

### 1. 安装工具链

Xtensa 目标需要 Espressif 的 Rust 分支，由 `espup` 安装。本目录下的
`rust-toolchain.toml` 已经把工具链通道钉在 `esp`，装好之后 cargo 会自动使用它。

```bash
cargo install espup ldproxy espflash
espup install                  # 下载 Xtensa Rust + LLVM 工具链
. $HOME/export-esp.sh          # 导出 LIBCLANG_PATH 等 —— 每个 shell 都需要
```

把 `. $HOME/export-esp.sh` 加进你的 shell 配置文件，否则每开一个新终端都会遇到
`libclang not found`。

`PATH` 上还需要 Python 3 和 `git` —— ESP-IDF 构建系统两个都要用。macOS：
`brew install python git`；Debian/Ubuntu：`sudo apt install python3 python3-venv git`。

### 2. 拉取源码，包括子模块

SDK 通过 git 子模块引入 Espressif 的 `esp_peer`。没有它，构建会在 ESP-IDF 组件解析
阶段失败，而不是在编译阶段，所以报错很容易被误读。

```bash
git clone https://github.com/streamcoreai/examples.git
cd examples/esp32

# esp_peer 在 SDK 目录下，不在这里：
git -C ../../esp32 submodule update --init --recursive
```

验证：`ls ../../esp32/components/esp-webrtc-solution/components/esp_peer` 应该列出
源文件，而不是空目录。

### 3. 配置 WiFi 和服务端地址

```bash
cp .env.example .env
```

编辑 `.env`：

```ini
WIFI_SSID=my-wifi
WIFI_PASSWORD=my-password
WHIP_ENDPOINT=http://192.168.1.100:8080/whip
TOKEN_URL=http://192.168.1.100:8080/token   # 可选 —— 服务端不鉴权时留空
API_KEY=sk-streamcore-demo-key              # 取 token 时作为 Bearer 发送
```

`build.rs` 会在编译期通过 `cargo:rustc-env` 把这些值烘进固件，二进制用
`option_env!()` 读取。shell 环境变量优先级高于 `.env`，所以你可以只为某一次构建
覆盖某个值：

```bash
WHIP_ENDPOINT=http://10.0.0.5:8080/whip cargo build --release
```

因为值是编译进去的，**改了 `.env` 就必须重新构建**。`build.rs` 对它设了
`rerun-if-changed`，直接 `cargo build` 就够了。

请填运行 `streamcore-server` 那台机器的局域网 IP，不要用 `localhost` —— ESP32 是在
你的网络里解析它，不是在你的笔记本上。

### 4. 检查开发板配置

三个文件描述了目标板。默认值针对 8 MB flash + 八线 PSRAM 的 ESP32-S3 WROOM-1。

| 文件 | 要检查什么 |
| ---- | ------------- |
| [`.cargo/config.toml`](.cargo/config.toml) | `target` 和 `MCU` —— 普通 ESP32 要改成 `xtensa-esp32-espidf` / `esp32` |
| [`sdkconfig.defaults`](sdkconfig.defaults) | `CONFIG_IDF_TARGET`、flash 大小、PSRAM 模式 |
| [`partitions.csv`](partitions.csv) | 3 MB 的 `factory` 应用分区 —— 需要 ≥ 4 MB flash |

引脚号在 [`src/bin/`](src/bin/) 里每个二进制的顶部 —— 见下方
[引脚表](#硬件引脚默认)。

### 5. 构建

```bash
cargo build --release                        # voice_agent（default-run）
cargo build --release --bin minimal_audio
cargo build --release --bin headless
```

**第一次构建会下载并编译 ESP-IDF v5.4** 到 `.embuild/`，连同托管组件
（`esp_audio_codec`、`esp-sr`、`esp32-camera`）。预留 15–30 分钟和几 GB 磁盘。之后
是增量构建，几秒钟就好。

产物在 `target/xtensa-esp32s3-espidf/release/<二进制名>`。

### 6. 烧录与串口监视

用 USB 接上板子，确认主机能看到它：

```bash
espflash board-info
```

如果什么都没有，按住 **BOOT** 键，点一下 **RESET**，再松开 BOOT —— 这会强制进入
ROM 下载模式。macOS 上端口通常是 `/dev/cu.usbmodem*`；Linux 上是 `/dev/ttyACM0` 或
`/dev/ttyUSB0`（把自己加进 `dialout` 组可以免 `sudo`）。

```bash
espflash flash --monitor target/xtensa-esp32s3-espidf/release/voice_agent
```

`--monitor` 会在烧录后立刻打开串口控制台，让你看到启动日志。接了多块板子时用
`--port /dev/cu.usbmodem1101` 指定。`Ctrl-]` 退出监视器。

要连接一块已经在跑的板子：`espflash monitor`。

### 7. 正常启动长什么样

```
I (512)  voice_agent: Connecting WiFi...
I (1180) voiceagent_esp32::wifi: WiFi started, scanning...
I (3120) voiceagent_esp32::wifi: WiFi connected, waiting for IP...
I (3900) voiceagent_esp32::wifi: WiFi got IP: 192.168.1.57
I (4020) voice_agent: agent state: Connecting
I (5400) voiceagent_esp32::whip: WHIP offer accepted, session: http://192.168.1.100:8080/whip/abc123
I (6100) voice_agent: agent state: Connected
```

在 `voice_agent` 上，按住 **GPIO0**（BOOT 键）说话 —— 屏幕会显示实时转写和助手的
回复。`minimal_audio` 和 `headless` 连上之后会自动开麦，直接说话即可。

### 可选：让 `cargo run` 自动烧录

取消 [`.cargo/config.toml`](.cargo/config.toml) 里 `runner` 那行的注释：

```toml
[target.xtensa-esp32s3-espidf]
linker = "ldproxy"
runner = "espflash flash --monitor"
```

之后构建、烧录、监视就合成一条命令：

```bash
cargo run --release                          # voice_agent
cargo run --release --bin minimal_audio
cargo run --release --bin headless
```

---

## 排障

| 现象 | 原因 / 解法 |
| ------- | ----------- |
| `libclang not found` / `Unable to find libclang` | 在当前 shell 里执行 `. $HOME/export-esp.sh` |
| `error: linker 'ldproxy' not found` | `cargo install ldproxy` |
| `Failed to resolve component 'esp_peer'` | 子模块没初始化 —— 见[第 2 步](#2-拉取源码包括子模块) |
| `toolchain 'esp' is not installed` | `espup install` |
| 构建成功，但板子反复重启 | 通常是 PSRAM 配置不匹配。对照模组核对 `CONFIG_SPIRAM_MODE_OCT`（四线 PSRAM 要用 `CONFIG_SPIRAM_MODE_QUAD`） |
| `E (…) esp_image: image size too large` | 应用超过了 3 MB 的 `factory` 分区 —— 用 `--release` 构建，或调大 `partitions.csv` |
| 串口被占用 / 权限不足 | 关掉其他监视器；Linux 上 `sudo usermod -aG dialout $USER` 后重新登录 |
| WiFi 连上了，但 WHIP 超时 | `WHIP_ENDPOINT` 指向了 `localhost` 或不可达的 IP。用服务端的局域网 IP，并检查防火墙 |
| 连上了但两个方向都没声音 | I2S 引脚接错 —— 接错的 I2S 引脚只会静音，不报错。对照原理图核对 |
| 麦克风没声音，扬声器正常 | 有些板子把 INMP441 的 L/R 脚接到了 VCC。SDK 默认用 LEFT 声道，把 [`esp32/src/capture.rs`](../../esp32/src/capture.rs) 里的 `StdSlotMask::Left` 改成 `Right` |
| 烧了坏镜像后 flash 状态异常 | `espflash erase-flash`，然后重新烧录 |

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

如果设置了 `TOKEN_URL`，固件会向它 POST（用 `API_KEY` 作为 bearer token），并把返回的
JWT 用于 WHIP 请求。`TOKEN_URL` 为空时以免鉴权方式连接。

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
`.degrade_input_output()` 调用即可覆盖。

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

---

## 在你自己的 crate 里使用 SDK

这些示例通过 path 依赖 SDK，因为它们在同一个仓库里。在你自己的项目里应该依赖已发布的
crate —— 一个二进制 crate 需要的全部脚手架（`.cargo/config.toml`、`sdkconfig.defaults`、
`idf_component.yml`、`partitions.csv`、`build.rs` 以及 `binstart` feature）见
[**在你自己的项目中使用 SDK**](../../esp32/README.zh-CN.md#在你自己的项目中使用-sdk)。
