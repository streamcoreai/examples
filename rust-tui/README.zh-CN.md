# StreamCoreAI 原生 Rust Ratatui TUI

[English](./README.md) | **简体中文**

> 面向 StreamCoreAI 语音智能体的高性能精品终端仪表盘。

本项目用 **`ratatui`** 和 **`crossterm`** 实现了一个独立的终端用户界面。它提供实时视觉反馈，包括连接状态、转写历史和动态音频均衡器脉冲。

## 特性
- **Ratatui 仪表盘**：现代化、带样式、分区布局的终端界面。
- **对称音频可视化**：用 RMS 幅度计算实时响应你的声音和智能体的声音。
- **空格键按住说话**：无缝切换麦克风，并有可视状态指示。
- **异步架构**：由 `tokio` 驱动，UI 与音频处理均不阻塞。

## 前置条件
请确保系统已安装 `libopus`。
macOS：
```bash
brew install opus
```

Linux（Debian/Ubuntu）：
```bash
sudo apt install libopus-dev
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

## 运行
进入目录并启动应用：
```bash
cd examples/rust-tui
cargo run
```

按**空格键**说话。按 **`q`** 或 **Esc** 退出。
