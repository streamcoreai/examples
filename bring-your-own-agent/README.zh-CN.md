[English](./README.md) | **简体中文**

# 自带 agent

本仓库其他示例都是**客户端**——连到 StreamCore 服务端的一方。这个示例是另一侧：服务端要去调用的那个 **agent**。

设置 `llm.provider = "agent"` 后，StreamCore 不再决定说什么。语音里所有难的部分它照做不误——WebRTC、语音转文字、轮次判定、插话打断、文字转语音——然后把每一轮转写结果转发到你自己的 HTTP 端点。你返回什么文字，就会被读出来。

这里有该端点的两份实现，行为完全一致，且都**零依赖**：

| 文件 | 运行方式 |
|---|---|
| [`agent.mjs`](./agent.mjs) | `node agent.mjs` |
| [`agent.py`](./agent.py) | `python3 agent.py` |

## 运行

**1. 启动 agent。** 监听 `:9000`。

```bash
node agent.mjs        # 或：python3 agent.py
```

**2. 把服务端指过来。** 在服务端的 `config.toml` 里：

```toml
[llm]
provider = "agent"

[agent]
url = "http://localhost:9000"
# api_key = "secret"   # 以 Authorization: Bearer 发送；需与 AGENT_API_KEY 一致
# timeout_ms = 60000   # 整轮预算，含流式返回的时间
```

**3. 启动服务端**，然后用任意客户端连接——[Next.js 示例](../typescript)、[Python 示例](../python)，或经由 [sip-server](../../sip-server) 打进来的电话。

STT 与 TTS 的凭据仍需配在 `config.toml` 里。本示例只替换 LLM。

**4. 说一句「my name is Jason」，挂断后再打一次。** 第二通电话里 agent 会直接叫出你的名字。这正是本示例要讲的重点——见下文。

## 不打电话也能试

端点就是普通 HTTP，用 `curl` 即可跑通服务端所用的同一套约定：

```bash
curl -N -X POST http://localhost:9000 \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"A","resource_id":"user_8891","type":"chat","text":"my name is Jason"}'
```

```
data: {"delta":"Nice "}
data: {"delta":"to "}
...
data: [DONE]
```

再换一个**不同的** `session_id`（即新的一段对话），但用**相同的** `resource_id`：

```bash
curl -N -X POST http://localhost:9000 \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"B","resource_id":"user_8891","type":"chat","text":"hi again"}'
```

```
data: {"delta":"Welcome "} data: {"delta":"back, "} data: {"delta":"Jason. "} ...
```

## 服务端发来什么

```json
{
  "session_id": "9f2c…",
  "resource_id": "user_8891",
  "type": "chat",
  "text": "用户这一轮说的话",
  "system": "服务端追加的技能文本（如有）",
  "interrupted_text": "被打断时 agent 正在说的内容",
  "context": ["检索到的片段", "…"],
  "summary": "更早若干轮的滚动摘要"
}
```

`text` 永远只是用户实际说出的话——服务端不会把上下文塞进去，因此你可以直接存下它。从 `interrupted_text` 往下都是可选上下文，与语音并列传来而非嵌在其中。两份实现都会把它们打印出来，方便你观察何时出现。

**`session_id` 是这段对话，`resource_id` 是这个人。** 这一区分正是本示例要教的东西，也是它维护两个独立存储的原因：

- `session_id` 会在对话重置时轮换，因此以它为键的记忆随通话一起消失——适合放*「我们刚才在聊什么」*。
- `resource_id` 跨多次通话保持稳定——适合放*「我对你了解什么」*。正是它让来电者被认出来，而不是每次重新自我介绍。

当部署未提供身份时，`resource_id` 会**整个不存在**，因此请把「缺失」当作匿名，绝不要当作空用户——以 `undefined` 为键会把所有匿名来电者并成同一个人。它来自签名 token 的 claim，或由 sip-server 传入的来电号码，绝不会来自浏览器。参见[协议 → 通话方身份](../../server/docs/protocol.zh-CN.md#通话方身份)。

`type` 为 `"chat"` 表示一轮用户对话，`"oneshot"` 表示无状态的后台变换（如滚动摘要）。`oneshot` 绝不能碰对话记忆——那是服务端请你处理一段文本，而非用户在说话——其结果只作内部使用，不会被读出来。

## 你该返回什么

任意带文本的 2xx 响应。服务端按你的 `Content-Type` 分派：

| `Content-Type` | 行为 |
|---|---|
| `text/event-stream` | 流式。`data:` 行，每行为 `{"delta":"…"}` 或纯文本；`[DONE]` 结束。**本示例采用这种。** |
| `text/plain` | 边到边流式播报。最省事。 |
| `application/json` | 缓冲——`{"text":"…"}`。整段回复到齐前不会出声。 |

能流式就流式。缓冲意味着用户要在沉默中等你的模型跑完；流式则让服务端在第二句还在生成时就把第一句读出去。

非 2xx 会让这一轮失败——用户什么也听不到，错误响应体会被记进日志。

你返回什么就会被原样读出，所以请用口语化的纯文字。不要 markdown，不要列表符号，不要 emoji。

## 插话打断

当用户插话时，StreamCore 会在流式过程中取消这个 HTTP 请求。两份实现都会监听它（Node 用 `req.on("close")`，Python 靠管道断开）并停止生成。接上真实模型后这不只是整洁问题——没人会听到的 token 你照样要付钱。

## 接入真实模型

替换 `respond()` 函数即可。它周围的一切——约定、流式、取消、两层记忆作用域——原封不动。你可以调用 OpenAI、跑本地模型、打到你现有的后端，或者交给某个 agent 框架。

完整约定与其他集成方式，参见[自带 agent](../../server/docs/bring-your-own-agent.zh-CN.md)。
