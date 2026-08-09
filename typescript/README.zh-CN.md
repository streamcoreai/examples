# TypeScript 语音智能体示例

[English](./README.md) | **简体中文**

一个 Next.js 网页应用，使用 [TypeScript SDK](../../typescript-sdk/) 连接语音智能体服务端。提供带麦克风按钮、实时音频可视化和实时转写的浏览器 UI。

## 前置条件

- **Node.js 20+**
- 一个正在运行的语音智能体服务端（见 [server/](../../server/)）

## 运行

```bash
# Install dependencies
npm install

# Start the dev server
npm run dev
```

在浏览器中打开 [http://localhost:3000](http://localhost:3000)。

应用默认连接 `http://localhost:8080/whip`。要改端点，设置环境变量 `NEXT_PUBLIC_WHIP_URL`：

```bash
NEXT_PUBLIC_WHIP_URL=http://your-server:8080/whip npm run dev
```

## Docker

```bash
docker build -t streamcoreai-example-ts .
docker run -p 3000:3000 streamcoreai-example-ts
```

在构建时传入自定义 WHIP URL：

```bash
docker build --build-arg NEXT_PUBLIC_WHIP_URL=http://your-server:8080/whip -t streamcoreai-example-ts .
```

## 它做了什么

1. 打开一个带麦克风按钮和音频可视化的浏览器 UI。
2. 通过 WebRTC 采集麦克风音频并推流到语音智能体服务端。
3. 实时播放智能体的音频回复。
4. 在转写通过 data channel 到达时实时展示（用户与智能体双方）。

## 配置

| 环境变量       | 默认值                          | 说明                                                                 |
| -------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `NEXT_PUBLIC_WHIP_URL`     | `http://localhost:8080/whip`     | WHIP 信令端点                                                     |
| `NEXT_PUBLIC_TOKEN_URL`    |                                  | token 端点 URL（如 `http://localhost:8080/token`）。服务端启用 JWT 鉴权时必填。 |
| `NEXT_PUBLIC_API_KEY`      |                                  | 从 token URL 取 token 时作为 `Bearer` 头发送的 API key。   |

### JWT 鉴权

当服务端设置了 `jwt_secret` 时，所有 `/whip` 请求都需要有效的 JWT。在 `.env.local` 中加入：

```env
NEXT_PUBLIC_WHIP_URL=http://localhost:8080/whip
NEXT_PUBLIC_TOKEN_URL=http://localhost:8080/token
NEXT_PUBLIC_API_KEY=sk-streamcore-demo-key
```
