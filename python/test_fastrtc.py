import asyncio
import numpy as np
from fastrtc.tracks import AsyncStreamHandler
from fastrtc import Stream

class RelayHandler(AsyncStreamHandler):
    def __init__(self, expected_layout="mono", output_sample_rate=24000, output_frame_size=None, input_sample_rate=48000):
        super().__init__(expected_layout, output_sample_rate, output_frame_size, input_sample_rate)
        # We will loop audio back for testing
        self.q = asyncio.Queue()

    def copy(self):
        return RelayHandler(
            expected_layout=self.expected_layout,
            output_sample_rate=self.output_sample_rate,
            output_frame_size=self.output_frame_size,
            input_sample_rate=self.input_sample_rate
        )

    async def receive(self, frame: tuple[int, np.ndarray]) -> None:
        # frame is (sr, audio_data)
        await self.q.put(frame)

    async def emit(self):
        try:
            # wait 10ms for audio, else return None
            frame = await asyncio.wait_for(self.q.get(), timeout=0.01)
            return frame
        except asyncio.TimeoutError:
            return None

print("Starting stream UI test...")
stream = Stream(RelayHandler(), modality="audio", mode="send-receive")
print("Done!")
