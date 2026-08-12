**English** | [简体中文](./README.zh-CN.md)

# Bring your own agent

Every other example in this repo is a **client** — something that talks to a StreamCore server. This one is the other side: the **agent** the server talks to.

Set `llm.provider = "agent"` and StreamCore stops deciding what to say. It still does everything hard about voice — WebRTC, speech-to-text, turn-taking, barge-in, text-to-speech — and forwards each transcribed turn to an HTTP endpoint you own. Whatever text you return gets spoken.

Two implementations of that endpoint are here, identical in behaviour and both **dependency-free**:

| File | Run it |
|---|---|
| [`agent.mjs`](./agent.mjs) | `node agent.mjs` |
| [`agent.py`](./agent.py) | `python3 agent.py` |

## Run it

**1. Start the agent.** It listens on `:9000`.

```bash
node agent.mjs        # or: python3 agent.py
```

**2. Point the server at it.** In the server's `config.toml`:

```toml
[llm]
provider = "agent"

[agent]
url = "http://localhost:9000"
# api_key = "secret"   # sent as Authorization: Bearer; set AGENT_API_KEY to match
# timeout_ms = 60000   # whole-turn budget, including streaming the reply
```

**3. Start the server**, then connect any client — the [Next.js sample](../typescript), the [Python one](../python), or a phone call through [sip-server](../../sip-server).

You still need STT and TTS credentials in `config.toml`. This example replaces the LLM only.

**4. Say "my name is Jason", then hang up and call back.** The agent greets you by name on the second call. That is the whole point of the example — see below.

## Try it without a voice call

The endpoint is plain HTTP, so `curl` exercises the same contract the server uses:

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

Now use a **different** `session_id` — a new conversation — with the **same** `resource_id`:

```bash
curl -N -X POST http://localhost:9000 \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"B","resource_id":"user_8891","type":"chat","text":"hi again"}'
```

```
data: {"delta":"Welcome "} data: {"delta":"back, "} data: {"delta":"Jason. "} ...
```

## What the server sends

```json
{
  "session_id": "9f2c…",
  "resource_id": "user_8891",
  "type": "chat",
  "text": "what the caller said",
  "system": "skill text appended by the server, if any"
}
```

**`session_id` is the conversation. `resource_id` is the person.** That distinction is the thing this example exists to teach, and it is why it keeps two separate stores:

- `session_id` rotates when the conversation resets, so memory keyed on it dies with the call — right for *"what were we just talking about"*.
- `resource_id` is stable across separate calls — right for *"what do I know about you"*. It is what makes a caller recognised rather than re-introduced.

`resource_id` is **absent** when the deployment asserts no identity, so treat missing as anonymous, never as an empty user — keying memory on `undefined` pools every anonymous caller into one shared person. It arrives from a signed token claim or from sip-server passing the caller's number, never from the browser. See [Protocol → Caller identity](../../server/docs/protocol.md#caller-identity).

`type` is `"chat"` for a caller turn, or `"oneshot"` for a stateless background transform such as the rolling summary. A `oneshot` must not touch conversation memory — it is the server asking you to process text, not the caller speaking — and its result is used internally, never spoken.

## What you send back

Any 2xx response carrying text. The server dispatches on your `Content-Type`:

| `Content-Type` | Behaviour |
|---|---|
| `text/event-stream` | Streamed. `data:` lines, each `{"delta":"…"}` or raw text; `[DONE]` ends it. **What this example uses.** |
| `text/plain` | Streamed as it arrives. Lowest effort. |
| `application/json` | Buffered — `{"text":"…"}`. Nothing is spoken until the whole reply lands. |

Stream if you possibly can. Buffering means the caller sits in silence until your model finishes; streaming lets the server speak sentence one while sentence two is still being generated.

A non-2xx fails the turn — the caller hears nothing and the error body is logged.

Whatever you return is spoken verbatim, so reply in plain conversational words. No markdown, no bullet points, no emoji.

## Barge-in

When the caller interrupts, StreamCore cancels the HTTP request mid-stream. Both files watch for it (`req.on("close")` in Node, a broken pipe in Python) and stop generating. With a real model this matters for more than tidiness — you are billed for tokens nobody will ever hear.

## Making it real

Replace the `respond()` function. Everything around it — the contract, streaming, cancellation, the two memory scopes — stays exactly as it is. Call OpenAI, run a local model, hit your existing backend, or hand off to an agent framework.

For the full contract including the other integration options, see [Bring your own agent](../../server/docs/bring-your-own-agent.md).
