# Rust Voice Agent Example

A minimal CLI example that connects to a Voice Agent server using the [Rust SDK](../../rust-sdk/).

## Prerequisites

- **Rust 1.87+** — install via [rustup](https://rustup.rs/)
- **libopus** system library (required at build time by `audiopus`)
- A running Voice Agent server (see [server/](../../server/))

### macOS

```bash
brew install opus
```

### Linux (Debian / Ubuntu)

```bash
sudo apt install libopus-dev
```

## Running

```bash
# From this directory
cargo run

# Or with a custom WHIP endpoint
WHIP_URL=http://your-server:8080/whip cargo run
```

The default WHIP endpoint is `http://localhost:8080/whip`.

## What It Does

- Connects directly to your Voice Agent Server using **WHIP**.
- Accesses your default OS **microphone and speaker** via pure Rust (`cpal`).
- Transcodes audio on‑the‑fly using the ultra‑low latency **Opus codec**.
- Listens seamlessly for **Server-Sent Events** via a WebRTC Data Channel to print the Agent's thought process/transcript in real time.
- **Spacebar Push-to-Talk**: Because native CLIs lack browser Acoustic Echo Cancellation, the client boots completely muted. You seamlessly press the Spacebar to toggle transmitting audio to the agent, eliminating annoying feedback loops!
- Waits for `Ctrl+C`, then disconnects cleanly.

## Audio Pipeline

```
Microphone (cpal, 48 kHz mono) -> mpsc channel
    → Opus encode (20 ms / 960-sample frames)
    → RTP packet (PT=111, 48 kHz clock)
    → client.local_track.write_rtp()
    → Voice Agent server

Voice Agent server
    → client.remote_track (RTP/Opus)
    → track.read() (parsed RTP)
    → Opus decode → PCM int16 -> mpsc channel
    → Speaker (cpal, 48 kHz mono)
```

## Configuration

| Environment Variable | Default                          | Description           |
| -------------------- | -------------------------------- | --------------------- |
| `WHIP_URL`           | `http://localhost:8080/whip`     | WHIP signaling endpoint |
