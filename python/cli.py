"""Voice Agent CLI example with local audio (PyAudio).

Connects to a Voice Agent server via WHIP, uses system microphone/speaker
via PyAudio, and prints transcripts directly to the terminal.
"""

import asyncio
import logging
import os
import signal
import sys

# Allow importing the SDK from the sibling python-sdk directory when
# running this example directly (without pip-installing the SDK).
sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "..", "python-sdk", "src")
)

import numpy as np
import pyaudio

import streamcoreai

logging.basicConfig(level=logging.ERROR, format="%(message)s")


def terminal_listener(is_muted_ref, loop, stop_event):
    """Reads raw keystrokes from the terminal without breaking asyncio."""
    if sys.platform == "win32":
        import msvcrt

        while not stop_event.is_set():
            if msvcrt.kbhit():
                char = msvcrt.getch()
                if char == b" ":
                    is_muted_ref[0] = not is_muted_ref[0]
                    _print_mute(is_muted_ref[0])
                elif char in (b"\x03", b"c"):  # Ctrl+C
                    loop.call_soon_threadsafe(stop_event.set)
                    break
            else:
                import time

                time.sleep(0.05)
    else:
        import tty, termios

        fd = sys.stdin.fileno()
        old_settings = termios.tcgetattr(fd)
        try:
            tty.setcbreak(fd)
            while not stop_event.is_set():
                import select

                r, _, _ = select.select([sys.stdin], [], [], 0.1)
                if r:
                    char = sys.stdin.read(1)
                    if char == " ":
                        is_muted_ref[0] = not is_muted_ref[0]
                        _print_mute(is_muted_ref[0])
                    elif char == "\x03":  # Ctrl+C
                        loop.call_soon_threadsafe(stop_event.set)
                        break
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def _print_mute(muted: bool) -> None:
    if muted:
        print("\r\n[mic] 🔴 Muted. Press Space to talk...    ", end="", flush=True)
    else:
        print("\r\n[mic] 🟢 Unmuted. Agent is listening... ", end="", flush=True)


async def main() -> None:
    whip_url = os.environ.get("WHIP_URL", "http://localhost:8080/whip")

    # Keep track of the last length to clear "partial" outputs cleanly
    last_print_len = 0
    is_muted = [True]  # List so the background thread can mutate it

    def on_status(status: streamcoreai.ConnectionStatus) -> None:
        print(f"\n[status] {status.name}")

    def on_transcript(
        entry: streamcoreai.TranscriptEntry,
        _all: list[streamcoreai.TranscriptEntry],
    ) -> None:
        nonlocal last_print_len
        tag = "agent" if entry.role == "assistant" else "user"

        # Clear the current line
        print("\r" + " " * last_print_len + "\r", end="", flush=True)

        if entry.partial:
            msg = f"[{tag}] (partial) {entry.text}"
            print(msg, end="", flush=True)
            last_print_len = len(msg)
        else:
            print(f"[{tag}] {entry.text}")
            last_print_len = 0

    def on_error(err: Exception) -> None:
        print(f"\n[error] {err}")

    client = streamcoreai.Client(
        config=streamcoreai.Config(whip_endpoint=whip_url),
        events=streamcoreai.EventHandler(
            on_status_change=on_status,
            on_transcript=on_transcript,
            on_error=on_error,
        ),
    )

    print(f"Connecting to {whip_url} ...")
    await client.connect()
    print(
        "\nConnected! Microphone is 🔴 MUTED. Press Spacebar to talk. (Ctrl+C to quit)\n"
    )

    # Open mic and speaker streams via PyAudio
    pa = pyaudio.PyAudio()
    mic_stream = pa.open(
        format=pyaudio.paInt16,
        channels=streamcoreai.CHANNELS,
        rate=streamcoreai.SAMPLE_RATE,
        input=True,
        frames_per_buffer=streamcoreai.FRAME_SIZE,
        start=True,
    )
    speaker_stream = pa.open(
        format=pyaudio.paInt16,
        channels=streamcoreai.CHANNELS,
        rate=streamcoreai.SAMPLE_RATE,
        output=True,
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    async def mic_loop():
        while not stop.is_set():
            data = await loop.run_in_executor(
                None,
                lambda: mic_stream.read(
                    streamcoreai.FRAME_SIZE, exception_on_overflow=False
                ),
            )
            if is_muted[0]:
                pcm = np.zeros(streamcoreai.FRAME_SIZE, dtype=np.int16)
            else:
                pcm = np.frombuffer(data, dtype=np.int16)
            await client.send_pcm(pcm)

    async def speaker_loop():
        while not stop.is_set():
            try:
                pcm = await client.recv_pcm()
                await loop.run_in_executor(
                    None, lambda d=pcm.tobytes(): speaker_stream.write(d)
                )
            except Exception:
                break

    mic_task = asyncio.create_task(mic_loop())
    speaker_task = asyncio.create_task(speaker_loop())

    # Spawn terminal reader in a background thread to prevent blocking the async loop
    import threading

    t = threading.Thread(
        target=terminal_listener, args=(is_muted, loop, stop), daemon=True
    )
    t.start()

    await stop.wait()

    print("\nShutting down...")

    # On second Ctrl+C, force-exit immediately.
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: os._exit(0))

    # Cancel speaker (may block in recv_pcm forever).
    speaker_task.cancel()

    # Let mic exit naturally (~20 ms for the current read to finish).
    # Do NOT cancel it — we need the executor thread to complete its
    # mic_stream.read() call before we touch PyAudio, otherwise
    # PortAudio deadlocks on macOS.
    done, pending = await asyncio.wait([mic_task, speaker_task], timeout=0.5)
    for t in pending:
        t.cancel()
    await asyncio.gather(mic_task, speaker_task, return_exceptions=True)

    # Brief pause so any in-flight executor thread can finish.
    await asyncio.sleep(0.05)

    # Close PyAudio — safe now, executor is done.
    try:
        mic_stream.stop_stream()
        mic_stream.close()
        speaker_stream.stop_stream()
        speaker_stream.close()
        pa.terminate()
    except Exception:
        pass

    # Disconnect WebRTC.
    try:
        await asyncio.wait_for(client.disconnect(), timeout=5)
    except (asyncio.TimeoutError, Exception):
        pass


if __name__ == "__main__":
    asyncio.run(main())
