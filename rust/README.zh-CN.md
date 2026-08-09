# Rust 语音智能体示例

[English](./README.md) | **简体中文**

一个极简 CLI 示例，使用 [Rust SDK](../../rust-sdk/) 连接语音智能体服务端。

## 前置条件

- **Rust 1.87+** —— 通过 [rustup](https://rustup.rs/) 安装
- **libopus** 系统库（`audiopus` 在构建时需要）
- 一个正在运行的语音智能体服务端（见 [server/](../../server/)）

### macOS

```bash
brew install opus
```

### Linux（Debian / Ubuntu）

```bash
sudo apt install libopus-dev
```

## 运行

```bash
# From this directory
cargo run

# Or with a custom WHIP endpoint
WHIP_URL=http://your-server:8080/whip cargo run
```

默认的 WHIP 端点是 `http://localhost:8080/whip`。

## 它做了什么

- 使用 **WHIP** 直接连接你的语音智能体服务端。
- 通过纯 Rust（`cpal`）访问操作系统默认的**麦克风和扬声器**。
- 用超低延迟的 **Opus 编解码器**实时转码音频。
- 通过 WebRTC Data Channel 无缝接收 **服务端推送事件**，实时打印智能体的思考过程/转写。
- **空格键按住说话**：由于原生 CLI 没有浏览器那样的声学回声消除，客户端启动时是完全静音的。按空格键即可切换是否向智能体传输音频，消除恼人的回声啸叫！
- 等待 `Ctrl+C`，然后干净地断开连接。

## 音频流水线

```
Microphone (cpal, 48 kHz mono) -> mpsc channel
    → Opus encode (20 ms / 960-sample frames)
    → RTP packet (PT=111, 48 kHz clock)
    → client.local_track.write_rtp()
    → Voice Agent server

Voice Agent server
    → client.remote_track (RTP/Opus)
    → track.read() (parsed RTP)
    → Opus decode → PCM int16 -> mpsc channel
    → Speaker (cpal, 48 kHz mono)
```

## 配置

| 环境变量 | 默认值                          | 说明                                                                 |
| -------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `WHIP_URL`           | `http://localhost:8080/whip`     | WHIP 信令端点                                                     |
| `TOKEN_URL`          |                                  | token 端点 URL（如 `http://localhost:8080/token`）。服务端启用 JWT 鉴权时必填。 |
| `API_KEY`            |                                  | 从 `TOKEN_URL` 取 token 时作为 `Bearer` 头发送的 API key。     |

### JWT 鉴权

当服务端设置了 `jwt_secret` 时，所有 `/whip` 请求都需要有效的 JWT：

```bash
TOKEN_URL=http://localhost:8080/token API_KEY=sk-streamcore-demo-key cargo run
```
