"""Voice Agent UI example with Browser WebRTC.

Connects to a Voice Agent server via WHIP using the Python SDK,
while taking microphone audio from the user's browser natively using
fastrtc (WebRTC), avoiding local Python PyAudio bindings and
enabling native browser Noise Cancellation.
"""

import asyncio
import logging
import os
import sys

# Allow importing the SDK from the sibling python-sdk directory when
# running this example directly (without pip-installing the SDK).
sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "..", "python-sdk", "src")
)

import gradio as gr
import numpy as np
import streamcoreai
from fastrtc import WebRTC
from fastrtc.tracks import AsyncStreamHandler

logging.basicConfig(level=logging.ERROR, format="%(message)s")


# Global State to track UI safely across FastRTC cloned streams
GLOBAL_STATE = {"status": "Disconnected", "transcript": []}


class AgentWebRTCRelay(AsyncStreamHandler):
    """
    Middle-man between browser audio (FastRTC) and the Voice Agent (WHIP SDK).
    1) Browser mic audio → client.send_pcm()
    2) client.recv_pcm() → browser speakers
    """

    def __init__(self):
        # We expect and emit 48kHz mono
        super().__init__(
            expected_layout="mono",
            output_sample_rate=streamcoreai.SAMPLE_RATE,
            input_sample_rate=streamcoreai.SAMPLE_RATE,
        )
        self.whip_client = None
        self.agent_audio_task = None
        self.playback_queue = asyncio.Queue()

    def copy(self):
        return AgentWebRTCRelay()

    async def start_up(self):
        whip_url = os.environ.get("WHIP_URL", "http://localhost:8080/whip")

        def on_status(status: streamcoreai.ConnectionStatus):
            GLOBAL_STATE["status"] = status.name

        def on_transcript(
            entry: streamcoreai.TranscriptEntry,
            _all: list[streamcoreai.TranscriptEntry],
        ):
            GLOBAL_STATE["transcript"] = _all

        self.whip_client = streamcoreai.Client(
            config=streamcoreai.Config(whip_endpoint=whip_url),
            events=streamcoreai.EventHandler(
                on_status_change=on_status,
                on_transcript=on_transcript,
            ),
        )

        asyncio.create_task(self.whip_client.connect())
        self.agent_audio_task = asyncio.create_task(self._pull_agent_audio())

    async def _pull_agent_audio(self):
        """Continuously pull decoded PCM from the SDK and queue it for the browser."""
        try:
            while True:
                pcm = await self.whip_client.recv_pcm()
                # recv_pcm returns int16; reshape to (1, samples) for FastRTC
                await self.playback_queue.put(
                    (streamcoreai.SAMPLE_RATE, pcm.reshape(1, -1))
                )
        except Exception:
            pass

    async def receive(self, frame: tuple[int, np.ndarray]) -> None:
        """Called whenever the browser microphone sends audio via WebRTC."""
        if (
            self.whip_client
            and self.whip_client.status == streamcoreai.ConnectionStatus.CONNECTED
        ):
            sr, audio_data = frame
            if audio_data.dtype != np.int16:
                audio_data = (audio_data * 32767).astype(np.int16)
            await self.whip_client.send_pcm(audio_data.flatten())

    async def emit(self):
        """Called to fetch audio to play on the browser speakers via WebRTC."""
        try:
            return await asyncio.wait_for(self.playback_queue.get(), timeout=0.01)
        except asyncio.TimeoutError:
            return None


def get_ui_state():
    """Reads the current connection parameters safely to drive the UI"""
    chat = []
    for entry in GLOBAL_STATE["transcript"]:
        role = "assistant" if entry.role == "assistant" else "user"
        text = entry.text
        if entry.partial:
            text += " ..."
        chat.append({"role": role, "content": text})

    return f"Status: {GLOBAL_STATE['status']}", chat


# --- Gradio UI Definitions ---

custom_css = """
body, .gradio-container { overflow-x: hidden !important; }
canvas {
    max-width: 100% !important;
    max-height: 150px !important;
    object-fit: contain !important;
    margin: 0 auto;
}
"""

handler = AgentWebRTCRelay()

with gr.Blocks(title="Voice Agent (Native WebRTC)", css=custom_css) as demo:
    gr.Markdown("# Voice Agent (Browser WebRTC)")
    gr.Markdown(
        "Click the phone icon below to initiate a native browser-to-browser WebRTC connection."
    )

    with gr.Row():
        with gr.Column(scale=8):
            chatbot = gr.Chatbot(
                label="Conversation", height=400, type="messages", allow_tags=False
            )
        with gr.Column(scale=4):
            status_box = gr.Textbox(
                label="Connection Status", value="Status: Idle", interactive=False
            )

            webrtc = WebRTC(
                modality="audio", mode="send-receive", label="WebRTC Voice Connection"
            )

            webrtc.stream(
                fn=handler, inputs=[webrtc], outputs=[webrtc], time_limit=3600
            )

    timer = gr.Timer(0.5, active=True)

    timer.tick(fn=get_ui_state, outputs=[status_box, chatbot])

if __name__ == "__main__":
    demo.launch()
