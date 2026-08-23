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

This crate holds only the application code. Everything below `Agent::create`
— WHIP signaling, `esp_peer`, Opus, I2S, AFE — lives in the SDK crate at
[`esp32/`](../../esp32), pulled in as a path dependency.

---

## Step-by-step: build and flash

### 1. Install the toolchain

The Xtensa target needs Espressif's Rust fork, installed by `espup`. The
`rust-toolchain.toml` in this directory already pins the toolchain channel
to `esp`, so once it's installed cargo picks it up automatically.

```bash
cargo install espup ldproxy espflash
espup install                  # downloads the Xtensa Rust + LLVM toolchain
. $HOME/export-esp.sh          # exports LIBCLANG_PATH etc. — needed every shell
```

Add `. $HOME/export-esp.sh` to your shell rc file, or you'll get a
`libclang not found` error on every fresh terminal.

You also need Python 3 and `git` on `PATH` — the ESP-IDF build system uses
both. On macOS: `brew install python git`. On Debian/Ubuntu:
`sudo apt install python3 python3-venv git`.

### 2. Get the sources, including the submodule

The SDK pulls Espressif's `esp_peer` in as a git submodule. Without it the
build fails at the ESP-IDF component resolution step, not at compile time,
so the error is easy to misread.

```bash
git clone https://github.com/streamcoreai/examples.git
cd examples/esp32

# esp_peer lives under the SDK, not here:
git -C ../../esp32 submodule update --init --recursive
```

Verify: `ls ../../esp32/components/esp-webrtc-solution/components/esp_peer`
should list source files, not be empty.

### 3. Point the firmware at your WiFi and server

```bash
cp .env.example .env
```

Edit `.env`:

```ini
WIFI_SSID=my-wifi
WIFI_PASSWORD=my-password
WHIP_ENDPOINT=http://192.168.1.100:8080/whip
TOKEN_URL=http://192.168.1.100:8080/token   # optional — omit for an open server
API_KEY=sk-streamcore-demo-key              # sent as Bearer when fetching a token
```

`build.rs` bakes these into the firmware at compile time via
`cargo:rustc-env`, and the binaries read them with `option_env!()`. Shell
environment variables win over `.env`, so you can override one value for a
single build:

```bash
WHIP_ENDPOINT=http://10.0.0.5:8080/whip cargo build --release
```

Because the values are compiled in, **changing `.env` requires a rebuild**.
`build.rs` has a `rerun-if-changed` on it, so a plain `cargo build` is enough.

Use the LAN IP of the machine running `streamcore-server`, not `localhost` —
the ESP32 resolves it on your network, not on your laptop.

### 4. Check the board configuration

Three files describe the target. The defaults are for an ESP32-S3 WROOM-1
with 8 MB flash and octal PSRAM.

| File | What to check |
| ---- | ------------- |
| [`.cargo/config.toml`](.cargo/config.toml) | `target` and `MCU` — change both to `xtensa-esp32-espidf` / `esp32` for a plain ESP32 |
| [`sdkconfig.defaults`](sdkconfig.defaults) | `CONFIG_IDF_TARGET`, flash size, PSRAM mode |
| [`partitions.csv`](partitions.csv) | 3 MB `factory` app partition — needs ≥ 4 MB flash |

Pin numbers live at the top of each binary in [`src/bin/`](src/bin/) — see
the [pinout table](#hardware-pinout-default) below.

### 5. Build

```bash
cargo build --release                        # voice_agent (default-run)
cargo build --release --bin minimal_audio
cargo build --release --bin headless
```

The **first build downloads and compiles ESP-IDF v5.4** into `.embuild/`
along with the managed components (`esp_audio_codec`, `esp-sr`,
`esp32-camera`). Budget 15–30 minutes and a few GB of disk. Later builds are
incremental and take seconds.

Artifacts land in `target/xtensa-esp32s3-espidf/release/<binary-name>`.

### 6. Flash and monitor

Plug the board in over USB and confirm the host sees it:

```bash
espflash board-info
```

If nothing shows up, hold the **BOOT** button, tap **RESET**, then release
BOOT — that forces the ROM download mode. On macOS the port is usually
`/dev/cu.usbmodem*`; on Linux `/dev/ttyACM0` or `/dev/ttyUSB0` (add yourself
to the `dialout` group to avoid `sudo`).

```bash
espflash flash --monitor target/xtensa-esp32s3-espidf/release/voice_agent
```

`--monitor` opens the serial console right after flashing so you see the
boot log. Pass `--port /dev/cu.usbmodem1101` if more than one board is
attached. Exit the monitor with `Ctrl-]`.

To attach to a board that's already running: `espflash monitor`.

### 7. What a good boot looks like

```
I (512)  voice_agent: Connecting WiFi...
I (1180) voiceagent_esp32::wifi: WiFi started, scanning...
I (3120) voiceagent_esp32::wifi: WiFi connected, waiting for IP...
I (3900) voiceagent_esp32::wifi: WiFi got IP: 192.168.1.57
I (4020) voice_agent: agent state: Connecting
I (5400) voiceagent_esp32::whip: WHIP offer accepted, session: http://192.168.1.100:8080/whip/abc123
I (6100) voice_agent: agent state: Connected
```

On `voice_agent`, hold **GPIO0** (the BOOT button) and speak — the display
shows the live transcript and the assistant's reply. `minimal_audio` and
`headless` unmute the mic automatically once connected; just talk.

### Optional: make `cargo run` flash for you

Uncomment the `runner` line in [`.cargo/config.toml`](.cargo/config.toml):

```toml
[target.xtensa-esp32s3-espidf]
linker = "ldproxy"
runner = "espflash flash --monitor"
```

Then build, flash, and monitor collapse into one command:

```bash
cargo run --release                          # voice_agent
cargo run --release --bin minimal_audio
cargo run --release --bin headless
```

---

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| `libclang not found` / `Unable to find libclang` | `. $HOME/export-esp.sh` in this shell |
| `error: linker 'ldproxy' not found` | `cargo install ldproxy` |
| `Failed to resolve component 'esp_peer'` | Submodule not initialised — see [step 2](#2-get-the-sources-including-the-submodule) |
| `toolchain 'esp' is not installed` | `espup install` |
| Build succeeds, board reboots in a loop | Usually PSRAM config mismatch. Check `CONFIG_SPIRAM_MODE_OCT` against your module (quad PSRAM needs `CONFIG_SPIRAM_MODE_QUAD`) |
| `E (…) esp_image: image size too large` | App exceeds the 3 MB `factory` partition — build `--release`, or grow `partitions.csv` |
| Serial port busy / permission denied | Close other monitors; on Linux `sudo usermod -aG dialout $USER` and re-login |
| WiFi connects, WHIP fails with a timeout | `WHIP_ENDPOINT` points at `localhost` or an unreachable IP. Use the server's LAN IP and check the firewall |
| Connected but silence both ways | Wrong I2S pins — a mis-wired I2S pin produces silence with no error. Verify against your schematic |
| Mic silent, speaker works | Some boards tie the INMP441 L/R pin to VCC. The SDK assumes the LEFT slot; flip `StdSlotMask::Left` to `Right` in [`esp32/src/capture.rs`](../../esp32/src/capture.rs) |
| Flash in a weird state after a bad image | `espflash erase-flash`, then flash again |

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

If `TOKEN_URL` is set, the firmware POSTs to it (with `API_KEY` as a bearer
token) and uses the returned JWT for the WHIP request. With `TOKEN_URL`
empty it connects unauthenticated.

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
WROOM-1 reference layout. Override them by editing the
`.degrade_input_output()` calls at the top of each binary.

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

---

## Using the SDK in your own crate

These examples depend on the SDK by path because they live in the same
repo. In your own project, depend on the published crate instead — see
[**Using the SDK in your own project**](../../esp32/README.md#using-the-sdk-in-your-own-project)
for the full list of scaffolding a binary crate needs (`.cargo/config.toml`,
`sdkconfig.defaults`, `idf_component.yml`, `partitions.csv`, `build.rs`, and
the `binstart` feature).
