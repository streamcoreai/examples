"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import type { AudioLevels, BotAction, BotScene, Expression } from "@/lib/bot/botScene";
import type { DriveInput } from "@/lib/bot/driveInput";

/** The scene is imperative; this is the one thing the UI has to reach in and do. */
export interface BotStageHandle {
  recentre(): void;
}

interface BotStageProps {
  ref?: Ref<BotStageHandle>;
  levels: { current: AudioLevels };
  /** Movement from the agent, drained by the scene each frame. */
  commands: { current: BotAction[] };
  /** Keys and on-screen pad, read by the scene each frame. */
  drive: { current: DriveInput };
  expression: Expression;
  connected: boolean;
  muted: boolean;
  /** Null while the scan is still loading, so the control can show progress. */
  room: boolean | null;
  onRoomChange: (showing: boolean) => void;
  onError: (message: string) => void;
}

export function BotStage({
  ref,
  levels,
  commands,
  drive,
  expression,
  connected,
  muted,
  room,
  onRoomChange,
  onError,
}: BotStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<BotScene | null>(null);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);

  useImperativeHandle(ref, () => ({ recentre: () => sceneRef.current?.recentre() }), []);

  // Babylon is loaded on demand: it is by far the largest thing this page
  // pulls, and importing it at module scope would put it in the server bundle
  // as well as the first-load JS.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let scene: BotScene | null = null;

    void (async () => {
      const { BotScene: Ctor } = await import("@/lib/bot/botScene");
      if (disposed) return;

      scene = new Ctor({
        canvas,
        levels,
        commands,
        drive,
        onProgress: setProgress,
        onError: (error) => onError(error.message),
        onRoomAuto: onRoomChange,
      });
      sceneRef.current = scene;
      if (process.env.NODE_ENV === "development") {
        // Lets you drive expressions, audio levels and movement from the
        // console without a server on the other end:
        //   __voiceBot.scene.react("happy", 3)
        //   __voiceBot.scene.drive({ action: "forward", durationMs: 1500, speedPercent: 80 })
        //   __voiceBot.scene.gesture({ kind: "wave", seconds: 2 })
        //   __voiceBot.drive.current.forward = 1
        (window as unknown as Record<string, unknown>).__voiceBot = { scene, levels, commands, drive };
      }
      await scene.load();
      if (disposed) return;
      setReady(true);
    })();

    const observer = new ResizeObserver(() => sceneRef.current?.resize());
    observer.observe(canvas);

    return () => {
      disposed = true;
      observer.disconnect();
      sceneRef.current?.dispose();
      sceneRef.current = null;
      scene = null;
    };
    // Mount-only on purpose: the scene is imperative and takes its updates
    // through setSignals below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sceneRef.current?.setSignals({ expression, connected, muted });
  }, [expression, connected, muted, ready]);

  useEffect(() => {
    if (room === null) return;
    let cancelled = false;
    void sceneRef.current?.setRoom(room).then((showing) => {
      if (!cancelled) onRoomChange(showing);
    });
    return () => {
      cancelled = true;
    };
  }, [room, ready, onRoomChange]);

  return (
    <div className="absolute inset-0">
      <canvas ref={canvasRef} className="stage-canvas" />
      {!ready && <BootOverlay progress={progress} />}
    </div>
  );
}

function BootOverlay({ progress }: { progress: number }) {
  const percent = Math.round(progress * 100);
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center bg-void/80 backdrop-blur-sm">
      <div className="flex w-56 flex-col items-center gap-4">
        <div className="relative size-12">
          <div className="absolute inset-0 rounded-full border border-glow/25" />
          <div className="absolute inset-0 animate-spin rounded-full border-t border-glow [animation-duration:1.4s]" />
        </div>
        <div className="h-px w-full overflow-hidden bg-white/10">
          <div
            className="h-full bg-glow transition-[width] duration-200 ease-out"
            style={{ width: `${Math.max(4, percent)}%` }}
          />
        </div>
        <p className="font-mono text-[11px] tracking-widest text-white/40 uppercase">
          {percent < 100 ? `Loading bot ${percent}%` : "Waking up"}
        </p>
      </div>
    </div>
  );
}
