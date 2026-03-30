# Go Voice Agent Example

A CLI example that connects to a Voice Agent server using the [Go SDK](../../golang-sdk/)
with **real microphone capture and speaker playback**.

## Prerequisites

- **Go 1.22+**
- **PortAudio** system library (CGO — required for mic/speaker I/O)
- A running Voice Agent server (see [server/](../../server/))

> **Note:** Opus is handled by [`godeps/opus`](https://github.com/godeps/opus) — a pure-Go
> WebAssembly implementation. No `libopus` system library required.

### macOS

```bash
brew install portaudio
```

### Linux (Debian / Ubuntu)

```bash
sudo apt install portaudio19-dev
```

## Running

```bash
# From this directory
go run main.go

# Or with a custom WHIP endpoint
WHIP_URL=http://your-server:8080/whip go run main.go
```

The default WHIP endpoint is `http://localhost:8080/whip`.

## What It Does
- Connects directly to your Voice Agent Server using **WHIP**.
- Accesses your default OS **microphone and speaker** via PortAudio.
- Transcodes audio on‑the‑fly using the ultra‑low latency **Opus codec**.
- Listens seamlessly for **Server-Sent Events** via a WebRTC Data Channel to print the Agent's thought process/transcript in real time.
- **Spacebar Push-to-Talk**: Because native CLIs lack browser Acoustic Echo Cancellation, the client boots completely muted. You seamlessly hold or toggle the Spacebar to transmit audio to the agent, reducing annoying feedback loops.
- Waits for `Ctrl+C` (SIGINT), then disconnects cleanly.

## Configuration

| Environment Variable | Default                      | Description             |
| -------------------- | ---------------------------- | ----------------------- |
| `WHIP_URL`           | `http://localhost:8080/whip` | WHIP signaling endpoint |

## Audio Pipeline

```
Microphone (PortAudio, 16 kHz mono)
    → client.SendPCM(pcm)
    → SDK: Opus encode → RTP packet
    → Voice Agent server

Voice Agent server
    → client.RecvPCM(pcm)
    → SDK: RTP parse → Opus decode → PCM int16
    → Speaker (PortAudio, 16 kHz mono)
```
