# Python Voice Agent Example

A minimal CLI example that connects to a Voice Agent server, prints live transcript events, and reads remote audio using the Python SDK with [aiortc](https://github.com/aiortc/aiortc).

### Prerequisites

- Python 3.10+
- (Optional but recommended) a virtual environment
- `fastrtc`, `gradio>=5.0.0`, `streamcoreai` (via pip)
- A running Voice Agent server (see root [README](../../README.md))

## Setup

```bash
cd examples/python

# Create a virtual environment (recommended)
python -m venv .venv
source .venv/bin/activate   # macOS/Linux
# .venv\Scripts\activate    # Windows

# Install the SDK (from the local python-sdk package)
pip install -e ../../python-sdk
```

## Run

```bash
python main.py
```

This will launch a local web server at `http://127.0.0.1:7860`.
It provides a rich graphical interface with a conversational chatbot view, while using your terminal's PyAudio integration to manage the microphone and speakers.

### 2. Terminal CLI

```bash
python cli.py

# Or with a custom WHIP endpoint
WHIP_URL=http://your-server:8080/whip python cli.py
```

This runs a lightweight script entirely within your terminal, identical in architecture to the Go and Rust examples. It prints transcripts directly to standard output as you speak.

## Environment Variables

| Variable   | Default                        | Description              |
| ---------- | ------------------------------ | ------------------------ |
| `WHIP_URL` | `http://localhost:8080/whip`   | WHIP signaling endpoint  |

## What It Does

1. Connects to the Voice Agent server via WebRTC + WHIP signaling.
2. Uses **FastRTC** behind the scenes to capture your local microphone through the browser securely.
3. Uses **FastRTC** to stream the agent's remote audio track directly to your browser's WebRTC engine automatically.
4. Benefits natively from the browser's built-in Acoustic Echo Cancellation (AEC) and hardware Noise Suppression.
5. Displays connection status changes and live transcripts via a browser chatbot in `main.py` (or prints them locally in `cli.py`).

## Extending

- Pass an aiortc `MediaStreamTrack` to `client.connect(track)` to send microphone audio
- Access `client.remote_track` after connection to process the agent's audio
- Use `client.transcript` to access the full conversation history
