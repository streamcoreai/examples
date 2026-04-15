# StreamCoreAI Native Rust Ratatui TUI
> A premium, high-performance terminal dashboard for the StreamCoreAI Voice Agent.

This project implements a standalone Terminal User Interface using **`ratatui`** and **`crossterm`**. It provides real-time visual feedback, including connection status, transcript history, and a dynamic audio equalizer pulse.

## Features
- **Ratatui Dashboard**: A modern, styled terminal interface with partitioned layouts.
- **Symmetric Audio Visualizer**: Real-time reaction to your voice and the agent's voice using RMS amplitude calculation.
- **Spacebar Push-to-Talk**: Seamless microphone toggling with visual status indicators.
- **Async Architecture**: Powered by `tokio` for non-blocking UI and audio processing.

## Prerequisites
Ensure you have `libopus` installed on your system.
On macOS:
```bash
brew install opus
```

On Linux (Debian/Ubuntu):
```bash
sudo apt install libopus-dev
```

## Configuration

| Environment Variable | Default                          | Description                                                                 |
| -------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `WHIP_URL`           | `http://localhost:8080/whip`     | WHIP signaling endpoint                                                     |
| `TOKEN_URL`          |                                  | Token endpoint URL (e.g. `http://localhost:8080/token`). Required when the server has JWT auth enabled. |
| `API_KEY`            |                                  | API key sent as `Bearer` header when fetching a token from `TOKEN_URL`.     |

### JWT Authentication

When the server has `jwt_secret` set, all `/whip` requests require a valid JWT:

```bash
TOKEN_URL=http://localhost:8080/token API_KEY=sk-streamcore-demo-key cargo run
```

## Running
Navigate into the directory and launch the application:
```bash
cd examples/rust-tui
cargo run
```

Press **Spacebar** to talk. Press **'q'** or **Esc** to quit.
