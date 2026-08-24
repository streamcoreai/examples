"use client";

import { useEffect, useRef } from "react";

interface AudioVisualizerProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  active: boolean;
}

export function AudioVisualizer({ localStream, remoteStream, active }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if ((!localStream && !remoteStream) || !active || !canvasRef.current) {
      if (!active && canvasRef.current) {
         const ctx = canvasRef.current.getContext("2d");
         if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
      return;
    }

    const audioCtx = new window.AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;

    if (localStream && localStream.getAudioTracks().length > 0) {
      const source1 = audioCtx.createMediaStreamSource(localStream);
      source1.connect(analyser);
    }

    if (remoteStream && remoteStream.getAudioTracks().length > 0) {
      // Connect agent audio stream into the same visual analyser
      const source2 = audioCtx.createMediaStreamSource(remoteStream);
      source2.connect(analyser);
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const canvas = canvasRef.current;
    const canvasCtx = canvas.getContext("2d");

    if (!canvasCtx) return;

    const draw = () => {
      const WIDTH = canvas.width;
      const HEIGHT = canvas.height;

      analyser.getByteTimeDomainData(dataArray);

      // We clear with a slightly transparent black to let the glow breathe or just clear rect
      canvasCtx.clearRect(0, 0, WIDTH, HEIGHT);

      canvasCtx.lineWidth = 2.5;
      canvasCtx.strokeStyle = "rgba(249, 115, 22, 0.9)"; // Orange to match fastrtc vibe
      canvasCtx.shadowBlur = 10;
      canvasCtx.shadowColor = "rgba(249, 115, 22, 0.8)";

      canvasCtx.beginPath();

      const sliceWidth = (WIDTH * 1.0) / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * HEIGHT) / 2;

        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }
        x += sliceWidth;
      }

      canvasCtx.lineTo(canvas.width, canvas.height / 2);
      canvasCtx.stroke();

      animFrameRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      audioCtx.close().catch(() => {});
    };
  }, [localStream, remoteStream, active]);

  return (
    <div className="w-full flex justify-center items-center h-16">
      <canvas
        ref={canvasRef}
        width={400}
        height={64}
        className="w-full h-full object-contain"
      />
    </div>
  );
}
