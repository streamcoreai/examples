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

If your Voice Agent SDK is running somewhere other than `localhost:8080`, simply set the `WHIP_URL` environment variable:

```bash
export WHIP_URL=http://your-server/whip
go run main.go
```

## Running
Navigate into the directory and launch the binary:
```bash
cd examples/golang-tui
go run main.go
```

Press **Spacebar** to hold/toggle the microphone and talk to your agent! Press `Ctrl+C` or `q` to quit securely at any time.
