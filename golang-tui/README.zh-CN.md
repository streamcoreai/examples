# StreamCoreAI 原生 Go TUI

[English](./README.md) | **简体中文**

> 一个横向构建在 StreamCoreAI 语音智能体 Go SDK 之上的、精美的 60FPS 终端用户界面。

这个示例完全绕开浏览器，直接在你的机器上运行零延迟的音频采集和 Opus 转码。借助 `charmbracelet/bubbletea` 和 `lipgloss` 的魔法，所有信令状态、麦克风静音配置（通过空格键）和实时 AI 转写都直接渲染在一个漂亮的帧缓冲终端布局中。

<img width="765" alt="golang_tui" src="https://github.com/user-attachments/assets/ae099b21-ad94-4b53-b097-f58c7380cdb9">

## 它做了什么
- 使用 **WHIP** 直接连接你的语音智能体服务端。
- 立即启动一个样式精美的**终端用户界面（TUI）**，在后台管理异步 WebRTC 信令而不会卡顿。
- 通过 PortAudio 访问操作系统默认的**麦克风和扬声器**。
- 用超低延迟的 **Opus 编解码器**实时转码音频。
- **实时 ASCII 音频波形**：以每秒 50 次的频率精确测量麦克风和扬声器 PCM 的均方根（RMS）能量，把幅度浮点值直接送入 TUI，渲染出色彩绚丽、随音量伸展的 Unicode 均衡器波形！
- 通过 WebRTC Data Channel 无缝接收 **服务端推送事件**，把智能体的思考过程/转写绘制进一个带样式的滚动对话框。
- **空格键按住说话**：由于原生 CLI 没有浏览器那样的声学回声消除，客户端启动时是完全静音的。你可以按住或切换**空格键**来向智能体传输音频，巨大的 TUI 指示框会即时更新！

## 配置

请确保已安装 `portaudio` 依赖（例如 Mac 上执行 `brew install portaudio`）。

| 环境变量 | 默认值                      | 说明                                                                 |
| -------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `WHIP_URL`           | `http://localhost:8080/whip` | WHIP 信令端点                                                     |
| `TOKEN_URL`          |                              | token 端点 URL（如 `http://localhost:8080/token`）。服务端启用 JWT 鉴权时必填。 |
| `API_KEY`            |                              | 从 `TOKEN_URL` 取 token 时作为 `Bearer` 头发送的 API key。     |

### JWT 鉴权

当服务端设置了 `jwt_secret` 时，所有 `/whip` 请求都需要有效的 JWT。推荐做法是设置 `TOKEN_URL`，让客户端在连接前自动取一个短时效 token：

```bash
export WHIP_URL=http://localhost:8080/whip
export TOKEN_URL=http://localhost:8080/token
# If the server has an api_key configured:
export API_KEY=your-api-key
go run main.go
```

## 运行
进入目录并启动：
```bash
cd examples/golang-tui
go run main.go
```

按**空格键**按住/切换麦克风即可与智能体对话！随时按 `Ctrl+C` 或 `q` 安全退出。
