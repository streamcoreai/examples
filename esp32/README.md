# voiceagent-esp32 — example firmware

**English** | [简体中文](./README.zh-CN.md)

Three ready-to-flash binaries showing different ways to use the
[`voiceagent-esp32`](../../esp32) SDK. Pick the closest match to your
hardware and adapt.

| Binary          | What it shows                                                     | Hardware              |
| --------------- | ----------------------------------------------------------------- | --------------------- |
| `voice_agent`   | Comprehensive: PTT button, display UI, camera RPC, state callbacks | ESP32-S3 + display + camera + mic + speaker |
| `minimal_audio` | Smallest possible: mic-on-connect, speaker out, ~80 LOC            | ESP32-S3 + mic + speaker |
| `headless`      | No display/camera; `publish_data`, `on_data`, topic heartbeat      | ESP32-S3 + mic + speaker |

---

## Build & flash

```bash
# from this directory
export WIFI_SSID="my-wifi"
export WIFI_PASSWORD="my-password"
export WHIP_ENDPOINT="http://192.168.1.100:8080/whip"

cargo run --release                          # voice_agent (default)
cargo run --release --bin minimal_audio
cargo run --release --bin headless
```

`cargo run` flashes over USB and opens a serial monitor in one step
(via `espflash`).

> **Note on env vars** — the binaries read `WIFI_SSID`, `WIFI_PASSWORD`,
> `WHIP_ENDPOINT`, and `TOKEN_URL` at compile time via `option_env!()`.
> Set them in your shell before `cargo run`, or hardcode them at the top
> of the binary. The defaults will not work on your network.

---

## `voice_agent` — the LiveKit-style mental model

Demonstrates every callback and the canonical structure of a
production-style firmware:

```
1. Init → 2. WiFi → 3. Build pipeline → 4. Create agent →
5. Register RPC tools → 6. Connect → 7. Run main loop (PTT)
```

The agent thread handles all WebRTC; the main loop just polls the PTT
button and pokes the display state. Pressing **GPIO0** (boot button)
unmutes the mic; releasing mutes it. Press it whenever the assistant is
listening — the on-screen UI shows live transcripts and AI responses.

RPC handlers registered:
- `capture_photo` — captures a JPEG with the OV2640 and streams chunks
  back over `vision.image_chunk` topic. The AI calls this for vision.
- `get_device_info` — returns SDK version + model string.

---

## `minimal_audio` — smallest possible

No display, no camera, no buttons. Mic stays live the whole session.
Useful as a starting point or for headless installations where the
agent is always listening.

---

## `headless` — data-channel demo

Same hardware as `minimal_audio` but additionally:

- Subscribes to inbound `data` packets (any topic).
- Publishes a `heartbeat` packet every 30 s with uptime.
- Registers a `ping` RPC that returns `{"pong": true, "uptime_secs": …}`.
- Logs every raw data-channel frame at TRACE level for protocol debugging.

This is the model to copy when integrating a custom server-side
protocol that doesn't use the built-in transcript/response events.

---

## Hardware pinout (default)

The default pin numbers in all three binaries match the ESP32-S3
WROOM-1 reference layout. Override them by editing the `.downgrade()`
calls at the top of each binary.

| Function    | Pin    |
| ----------- | ------ |
| Mic BCLK    | GPIO41 |
| Mic DIN     | GPIO2  |
| Mic WS      | GPIO42 |
| Speaker BCLK| GPIO46 |
| Speaker DOUT| GPIO3  |
| Speaker WS  | GPIO1  |
| Display MOSI| GPIO47 |
| Display SCLK| GPIO21 |
| Display CS  | GPIO14 |
| Display DC  | GPIO45 |
| Display BL  | GPIO48 |
| PTT button  | GPIO0  |

Camera pins are wired in [`esp32/src/camera.rs`](../../esp32/src/camera.rs).
