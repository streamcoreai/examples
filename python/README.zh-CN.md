# Python 语音智能体示例

[English](./README.md) | **简体中文**

一个极简 CLI 示例，连接语音智能体服务端、打印实时转写事件，并用 Python SDK 配合 [aiortc](https://github.com/aiortc/aiortc) 读取远端音频。

### 前置条件

- Python 3.10+
- （可选但推荐）虚拟环境
- 一个正在运行的语音智能体服务端（见根目录 [README](../../README.md)）

## 环境准备

```bash
cd examples/python

# Create a virtual environment (recommended)
python -m venv .venv
source .venv/bin/activate   # macOS/Linux
# .venv\Scripts\activate    # Windows

# Install the SDK and dependencies
pip install -r requirements.txt
```

## 运行

### 1. Gradio 网页 UI

```bash
python main.py
```

这会在 `http://127.0.0.1:7860` 启动一个本地 Web 服务。
它提供带对话式聊天视图的丰富图形界面，使用浏览器 WebRTC 访问麦克风和扬声器，并自带原生声学回声消除。

### 2. 终端 CLI

```bash
python cli.py

# Or with a custom WHIP endpoint
WHIP_URL=http://your-server:8080/whip python cli.py
```

这会在终端内运行一个轻量脚本，架构与 Go 和 Rust 示例完全一致。你说话时它会把转写直接打印到标准输出。

## 环境变量

| 变量     | 默认值                        | 说明                                                                 |
| ------------ | ------------------------------ | --------------------------------------------------------------------------- |
| `WHIP_URL`   | `http://localhost:8080/whip`   | WHIP 信令端点                                                     |
| `TOKEN_URL`  |                                | token 端点 URL（如 `http://localhost:8080/token`）。服务端启用 JWT 鉴权时必填。 |
| `API_KEY`    |                                | 从 `TOKEN_URL` 取 token 时作为 `Bearer` 头发送的 API key。     |

### JWT 鉴权

当服务端设置了 `jwt_secret` 时，所有 `/whip` 请求都需要有效的 JWT：

```bash
TOKEN_URL=http://localhost:8080/token API_KEY=sk-streamcore-demo-key python cli.py
```

## 它做了什么

1. 通过 WebRTC + WHIP 信令连接语音智能体服务端。
2. 在幕后使用 **FastRTC** 安全地通过浏览器采集你的本地麦克风。
3. 使用 **FastRTC** 自动把智能体的远端音频 track 直接推给浏览器的 WebRTC 引擎。
4. 原生受益于浏览器内建的声学回声消除（AEC）和硬件降噪。
5. 在 `main.py` 中通过浏览器聊天框展示连接状态变化和实时转写（在 `cli.py` 中则打印到本地）。

## 扩展

- 向 `client.connect(track)` 传入 aiortc 的 `MediaStreamTrack` 即可发送麦克风音频
- 连接之后访问 `client.remote_track` 即可处理智能体的音频
- 使用 `client.transcript` 获取完整对话历史
