# StreamCoreAI Native Go TUI
> A beautiful 60FPS Terminal User Interface built horizontally on top of the StreamCoreAI Voice Agent Go SDK.

This example completely bypasses the browser, running a zero-latency audio capture and Opus transcoder directly on your machine. Through the magic of `charmbracelet/bubbletea` and `lipgloss`, all signaling states, microphone mute configurations (via Spacebar), and live AI transcripts are rendered directly inside a stunning frame-buffered terminal layout.

<img width="765" alt="golang_tui" src="https://github.com/user-attachments/assets/ae099b21-ad94-4b53-b097-f58c7380cdb9">

## What It Does
- Connects directly to your Voice Agent Server using **WHIP**.
- Instantly launches a gorgeously styled **Terminal User Interface (TUI)** that manages asynchronous WebRTC signaling in the background without freezing.
- Accesses your default OS **microphone and speaker** via PortAudio.
- Transcodes audio on‑the‑fly using the ultra‑low latency **Opus codec**.
- **Real-Time ASCII Audio Wave**: Measures exact microphone and speaker PCM Root Mean Square (RMS) energy at 50 updates per second, channeling magnitude floats directly into the TUI to render beautifully colored expanding Unicode equalizer waves! 
- Listens seamlessly for **Server-Sent Events** via a WebRTC Data Channel to paint the Agent's thought process/transcript into a stylized scrolling dialogue box.
- **Spacebar Push-to-Talk**: Because native CLIs lack browser Acoustic Echo Cancellation, the client boots completely muted. You seamlessly hold or toggle the **Spacebar** to transmit audio to the agent, instantly updating the gigantic TUI indicator box!

## Configuration

Ensure your `portaudio` dependencies are installed (e.g. `brew install portaudio` on Mac).

| Environment Variable | Default                      | Description                                                                 |
| -------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `WHIP_URL`           | `http://localhost:8080/whip` | WHIP signaling endpoint                                                     |
| `TOKEN_URL`          |                              | Token endpoint URL (e.g. `http://localhost:8080/token`). Required when the server has JWT auth enabled. |
| `API_KEY`            |                              | API key sent as `Bearer` header when fetching a token from `TOKEN_URL`.     |

### JWT Authentication

When the server has `jwt_secret` set, all `/whip` requests require a valid JWT. The recommended approach is to set `TOKEN_URL` so the client automatically fetches a short-lived token before connecting:

```bash
export WHIP_URL=http://localhost:8080/whip
export TOKEN_URL=http://localhost:8080/token
# If the server has an api_key configured:
export API_KEY=your-api-key
go run main.go
```

## Running
Navigate into the directory and launch the binary:
```bash
cd examples/golang-tui
go run main.go
```

Press **Spacebar** to hold/toggle the microphone and talk to your agent! Press `Ctrl+C` or `q` to quit securely at any time.
