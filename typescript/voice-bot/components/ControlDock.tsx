"use client";

import { useEffect, useRef } from "react";
import type { ConnectionStatus } from "@streamcore/js-sdk";

import type { AudioLevels } from "@/lib/bot/botScene";
import { HangUpIcon, MicIcon, MicOffIcon } from "./icons";

interface ControlDockProps {
  status: ConnectionStatus;
  muted: boolean;
  levels: { current: AudioLevels };
  onConnect: () => void;
  onDisconnect: () => void;
  onToggleMute: () => void;
}

export function ControlDock({
  status,
  muted,
  levels,
  onConnect,
  onDisconnect,
  onToggleMute,
}: ControlDockProps) {
  const live = status === "connected" || status === "reconnecting";
  const busy = status === "connecting";

  if (!live) {
    return (
      <button
        type="button"
        // While connecting this is the cancel button. A dial that cannot be
        // called off leaves the only way out as a page reload.
        onClick={busy ? onDisconnect : onConnect}
        className="group glass pointer-events-auto flex items-center gap-3 rounded-full py-3 pr-6 pl-3 text-[15px] font-medium transition hover:border-glow/35"
      >
        <span className="relative grid size-10 place-items-center rounded-full bg-glow/15 text-glow transition group-hover:bg-glow/25">
          {busy ? <Spinner /> : <MicIcon className="h-5 w-5" />}
        </span>
        {busy ? (
          <>
            <span className="group-hover:hidden">Connecting…</span>
            <span className="hidden group-hover:inline">Cancel</span>
          </>
        ) : (
          "Start conversation"
        )}
      </button>
    );
  }

  return (
    <div className="glass pointer-events-auto flex items-center gap-2 rounded-full p-2">
      <button
        type="button"
        onClick={onToggleMute}
        aria-pressed={muted}
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
        className={`relative grid size-11 place-items-center overflow-hidden rounded-full transition ${
          muted ? "bg-alert/15 text-alert" : "bg-white/5 text-white/80 hover:bg-white/10"
        }`}
      >
        {!muted && <LevelHalo levels={levels} />}
        <span className="relative">{muted ? <MicOffIcon /> : <MicIcon />}</span>
      </button>

      <div className="w-px self-stretch bg-white/10" />

      <button
        type="button"
        onClick={onDisconnect}
        aria-label="End conversation"
        className="grid size-11 place-items-center rounded-full bg-alert/15 text-alert transition hover:bg-alert/25"
      >
        <HangUpIcon />
      </button>
    </div>
  );
}

/** Mic level, painted straight from the ref so React never re-renders for it. */
function LevelHalo({ levels }: { levels: { current: AudioLevels } }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const element = ref.current;
      if (element) {
        const level = Math.min(1, levels.current.user * 2.4);
        element.style.transform = `scale(${0.4 + level * 0.75})`;
        element.style.opacity = `${0.12 + level * 0.55}`;
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [levels]);

  return (
    <span
      ref={ref}
      aria-hidden
      className="absolute inset-0 rounded-full bg-glow will-change-transform"
      style={{ transform: "scale(0.4)", opacity: 0.12 }}
    />
  );
}

function Spinner() {
  return (
    <span className="size-4 animate-spin rounded-full border border-glow/30 border-t-glow [animation-duration:0.9s]" />
  );
}
