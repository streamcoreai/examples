# esp32-desktop-car

**English** | [简体中文](./README.zh-CN.md)

Voice-controlled two-wheel desktop robot, written almost entirely in Rust on
top of the `voiceagent-esp32` SDK.

The chassis is a tiny ESP32-S3 desk toy with:

- INMP441 I2S microphone (simplex)
- MAX98357A I2S amplifier driving a small speaker (24 kHz)
- SSD1306 OLED (128×32) for status
- TC1508 dual H-bridge driving two N20 wheel motors
- BOOT button (push-to-talk) and a capacitive touch pad (mute toggle)

The drivetrain is exposed to the LLM as a set of native Go tools in
`server/internal/tools/movement.go`. When the LLM calls one, the server
pipeline emits a topic-addressed data-channel packet
(`{"type":"data","topic":"movement.command","payload":"<base64 JSON>"}`),
the firmware's `on_data` callback decodes it, and the motor worker
thread executes the action. No subprocess plugin is involved.

## Pin map

| Function           | GPIO            |
| ------------------ | --------------- |
| Mic   `WS`         | 4               |
| Mic   `BCLK`       | 5               |
| Mic   `DIN`        | 6               |
| Speaker `DOUT`     | 7               |
| Speaker `BCLK`     | 15              |
| Speaker `WS/LRCK`  | 16              |
| OLED  `SDA`        | 41              |
| OLED  `SCL`        | 42              |
| Motor `LF`         | 12              |
| Motor `LB`         | 13              |
| Motor `RF`         | 14              |
| Motor `RB`         | 21              |
| BOOT button (PTT)  | 0               |
| Touch button       | 47              |
| Volume +           | 40              |
| Volume −           | 39              |
| Onboard LED        | 48              |

GPIO 12/13/14/21 are driven by four LEDC channels on a shared 5 kHz,
10-bit timer.

## Build

Prereqs (one time):

```bash
rustup install nightly
cargo install espup espflash ldproxy
espup install
. ~/export-esp.sh
```

Then in this directory:

```bash
cp .env.example .env
$EDITOR .env          # WIFI_SSID / WIFI_PASSWORD / WHIP_ENDPOINT
cargo build --release
```

## Flash + monitor

`--release` is a Cargo flag, not an espflash flag — `cargo build --release`
produces the release binary; pass the resulting ELF directly to espflash:

```bash
cargo build --release
espflash flash --monitor target/xtensa-esp32s3-espidf/release/desktop_car
```

Or uncomment the `runner = "espflash flash --monitor"` line in
`.cargo/config.toml` and just run `cargo run --release` — Cargo invokes
espflash with the right binary path for you.

## Runtime behaviour

- On boot, mic is **muted**. Hold the BOOT button to push-to-talk, or
  tap the touch pad to latch mic on/off.
- The OLED shows `ONLINE / OFFLINE`, mic state, and the last user
  utterance.
- All motor RPCs accept two optional parameters:
  - `duration_ms` — capped at 10 s
  - `speed_percent` — 0–100, defaults to a per-action sensible value

### Server-side tools (LLM-callable)

Registered as native Go tools in `server/main.go`. Each accepts optional
`duration_ms` (100–10000) and `speed_percent` (0–100):

| Name                           | What it does                     |
| ------------------------------ | -------------------------------- |
| `movement.forward`             | Both wheels forward              |
| `movement.backward`            | Both wheels backward             |
| `movement.turn_left`           | Spin in place, counter-clockwise |
| `movement.turn_right`          | Spin in place, clockwise         |
| `movement.pivot_forward_left`  | Right wheel only, forward        |
| `movement.pivot_forward_right` | Left wheel only, forward         |
| `movement.pivot_back_left`     | Right wheel only, backward       |
| `movement.pivot_back_right`    | Left wheel only, backward        |
| `movement.stop`                | Cut both motors immediately      |
| `movement.fancy`               | Choreographed wiggle             |
| `movement.shake`               | Quick left/right shake           |

The pipeline intercepts every `movement.*` call in
`server/internal/pipeline/pipeline.go` (`handleMovementToolCall`) and writes
a single data-channel packet to the device — same pattern as
`vision.analyze`.

They are named for the action rather than the device. The same tools walk the
rigged character in [`examples/voice-bot`](../voice-bot), and the server never
learns which client is connected, so a name like `car.forward` would have that
client narrating itself as a car. Anything that can go forward and turn can
subscribe to `movement.command`; this firmware happens to answer with motors.

One field this firmware ignores on purpose: `continuous: true` means "keep
going until told to stop", which suits a character that stops at a wall and
does not suit a car on a desk. It falls back to a normal timed move.

### Device-side

Only one server-callable RPC remains:

| Name              | Returns                                  |
| ----------------- | ---------------------------------------- |
| `get_device_info` | `model`, `wheels`, `sdk` version         |

Motor actions are not exposed via `rpc_register` — they're driven by the
SDK's `on_data` callback listening on the `movement.command` topic.

## Project layout

```
src/
  main.rs              # WiFi + audio + agent + RPC wiring + buttons
  motor_controller.rs  # LEDC-PWM drivetrain + worker thread
  oled_display.rs      # SSD1306 status panel
```

Everything below the SDK boundary is plain `esp-idf-hal` Rust — no C
shims, no extra IDF components.
