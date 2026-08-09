# Go 语音智能体示例

[English](./README.md) | **简体中文**

一个 CLI 示例，使用 [Go SDK](../../golang-sdk/) 连接语音智能体服务端，并带有**真实的麦克风采集与扬声器播放**。

## 前置条件

- **Go 1.22+**
- **PortAudio** 系统库（CGO —— 麦克风/扬声器 I/O 所必需）
- 一个正在运行的语音智能体服务端（见 [server/](../../server/)）

> **注意：** Opus 由 [`godeps/opus`](https://github.com/godeps/opus) 处理 —— 一个纯 Go 的
> WebAssembly 实现。无需 `libopus` 系统库。

### macOS

```bash
brew install portaudio
```

### Linux（Debian / Ubuntu）

```bash
sudo apt install portaudio19-dev
```

## 运行

```bash
# From this directory
go run main.go

# Or with a custom WHIP endpoint
WHIP_URL=http://your-server:8080/whip go run main.go
```

默认的 WHIP 端点是 `http://localhost:8080/whip`。

## 它做了什么
- 使用 **WHIP** 直接连接你的语音智能体服务端。
- 通过 PortAudio 访问操作系统默认的**麦克风和扬声器**。
- 用超低延迟的 **Opus 编解码器**实时转码音频。
- 通过 WebRTC Data Channel 无缝接收 **服务端推送事件**，实时打印智能体的思考过程/转写。
- **空格键按住说话**：由于原生 CLI 没有浏览器那样的声学回声消除，客户端启动时是完全静音的。你可以按住或切换空格键来向智能体传输音频，减少恼人的回声啸叫。
- 等待 `Ctrl+C`（SIGINT），然后干净地断开连接。

## 配置

| 环境变量 | 默认值                      | 说明                                                                 |
| -------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `WHIP_URL`           | `http://localhost:8080/whip` | WHIP 信令端点                                                     |
| `TOKEN_URL`          |                              | token 端点 URL（如 `http://localhost:8080/token`）。服务端启用 JWT 鉴权时必填。 |
| `API_KEY`            |                              | 从 `TOKEN_URL` 取 token 时作为 `Bearer` 头发送的 API key。     |

### JWT 鉴权

当服务端设置了 `jwt_secret` 时，所有 `/whip` 请求都需要有效的 JWT。设置 `TOKEN_URL`，客户端就会自动去取 token：

```bash
TOKEN_URL=http://localhost:8080/token WHIP_URL=http://localhost:8080/whip go run main.go
```

## 音频流水线

```
Microphone (PortAudio, 16 kHz mono)
    → client.SendPCM(pcm)
    → SDK: Opus encode → RTP packet
    → Voice Agent server

Voice Agent server
    → client.RecvPCM(pcm)
    → SDK: RTP parse → Opus decode → PCM int16
    → Speaker (PortAudio, 16 kHz mono)
```
