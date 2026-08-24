"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { BotStage, type BotStageHandle } from "./BotStage";
import { ControlDock } from "./ControlDock";
import { MetricsPanel } from "./MetricsPanel";
import { MovementPad } from "./MovementPad";
import { StatusPill } from "./StatusPill";
import { TranscriptPanel } from "./TranscriptPanel";
import { GaugeIcon, RoomIcon, TranscriptIcon } from "./icons";
import { neutralDrive, type DriveInput } from "@/lib/bot/driveInput";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useVoiceAgent } from "@/hooks/useVoiceAgent";

export function VoiceBot() {
  const agent = useVoiceAgent();
  const [showMetrics, setShowMetrics] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  /** A ref rather than state: the scene reads it every frame, React never does. */
  const drive = useRef<DriveInput>(neutralDrive());
  const stage = useRef<BotStageHandle>(null);
  const applyDrive = useCallback((input: DriveInput) => {
    drive.current = input;
  }, []);
  const recentre = useCallback(() => stage.current?.recentre(), []);
  /** What we have asked for; `roomShowing` is what the scene managed to do. */
  const [roomWanted, setRoomWanted] = useState(true);
  const [roomShowing, setRoomShowing] = useState(false);

  // Open by default where there is room beside the bot, closed where it would
  // sit on top of it — until the user says otherwise.
  const roomForPanel = useMediaQuery("(min-width: 1024px)");
  const [transcriptOverride, setTranscriptOverride] = useState<boolean | null>(null);
  const showTranscript = transcriptOverride ?? roomForPanel;

  const live = agent.status === "connected" || agent.status === "reconnecting";
  const error = stageError ?? agent.error;

  // Space toggles the mic, the way every other call app works.
  useEffect(() => {
    if (!live) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && /input|textarea|button/i.test(target.tagName)) return;
      event.preventDefault();
      agent.toggleMute();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, agent]);

  const handleRoomChange = useCallback((showing: boolean) => {
    setRoomShowing(showing);
    // The scan may be absent, or the scene may have dropped it to hold the
    // frame rate. Either way, stop asking for it.
    if (!showing) setRoomWanted(false);
  }, []);

  return (
    <main className="relative h-full w-full overflow-hidden">
      <BotStage
        ref={stage}
        levels={agent.levels}
        commands={agent.commands}
        drive={drive}
        expression={agent.expression}
        connected={live}
        muted={agent.muted}
        room={roomWanted}
        onRoomChange={handleRoomChange}
        onError={setStageError}
      />

      {/* Everything above the canvas is inert until a child opts back in. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4 sm:p-6">
        <header className="flex items-start justify-between gap-4">
          <div className="pointer-events-auto flex items-center gap-3">
            <span className="font-mono text-[13px] tracking-[0.2em] text-white/70 uppercase">
              StreamCore
            </span>
            <span className="h-4 w-px bg-white/15" />
            <StatusPill status={agent.status} agentState={agent.agentState} />
          </div>

          <div className="pointer-events-auto flex items-center gap-2">
            <ToggleButton
              active={roomShowing}
              busy={roomWanted !== roomShowing}
              onClick={() => setRoomWanted((v) => !v)}
              label={roomShowing ? "Hide the scanned room" : "Show the scanned room"}
            >
              <RoomIcon />
            </ToggleButton>
            <ToggleButton
              active={showMetrics}
              onClick={() => setShowMetrics((v) => !v)}
              label="Toggle pipeline timings"
            >
              <GaugeIcon />
            </ToggleButton>
            <ToggleButton
              active={showTranscript}
              onClick={() => setTranscriptOverride(!showTranscript)}
              label="Toggle transcript"
            >
              <TranscriptIcon />
            </ToggleButton>
          </div>
        </header>

        <div className="pointer-events-none flex min-h-0 flex-1 items-end justify-between gap-4 py-4 lg:items-start">
          <MovementPad onDrive={applyDrive} onRecentre={recentre} />

          <div className="flex w-full min-w-0 min-h-0 flex-col items-end gap-4 lg:max-w-[19rem]">
            {showMetrics && (
              <div className="rise">
                <MetricsPanel timings={agent.timings} reconnect={agent.reconnect} />
              </div>
            )}
            {showTranscript && (
              // A fixed box, not one that grows with the conversation. The cap
              // is what keeps it off the control dock on a short window.
              <div className="rise h-[38vh] max-h-[calc(100vh-13rem)] w-full lg:h-[26rem]">
                <TranscriptPanel transcript={agent.transcript} />
              </div>
            )}
          </div>
        </div>

        <footer className="flex flex-col items-center gap-3">
          {agent.slowConnect && !error && (
            <div className="glass pointer-events-auto max-w-md rounded-xl px-4 py-3 text-[13px] leading-relaxed text-white/60">
              Still waiting on <span className="font-mono text-white/80">{agent.whipUrl}</span>. Check
              that a StreamCore server is running there, and that no other app is holding the
              microphone.
            </div>
          )}

          {error && (
            <div className="glass pointer-events-auto flex max-w-md items-start gap-3 rounded-xl px-4 py-3 text-[13px] text-alert">
              <span className="mt-[3px] size-1.5 shrink-0 rounded-full bg-alert" />
              <p className="flex-1 leading-relaxed">{error}</p>
              <button
                type="button"
                onClick={() => {
                  setStageError(null);
                  agent.dismissError();
                }}
                className="text-white/40 transition hover:text-white/70"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          )}

          <ControlDock
            status={agent.status}
            muted={agent.muted}
            levels={agent.levels}
            onConnect={agent.connect}
            onDisconnect={agent.disconnect}
            onToggleMute={agent.toggleMute}
          />

          <p className="text-[11px] text-white/25">
            {live
              ? "Space to mute · WASD to walk · drag to orbit"
              : "WASD to walk · R to recentre · drag to orbit"}
          </p>
        </footer>
      </div>
    </main>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
  children,
  busy = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      aria-busy={busy}
      className={`glass relative grid size-9 place-items-center rounded-full transition ${
        active ? "text-glow" : "text-white/45 hover:text-white/75"
      }`}
    >
      {/* The room is a 12 MB download; without this the button looks broken. */}
      {busy && (
        <span className="absolute inset-0 animate-spin rounded-full border border-transparent border-t-glow/70 [animation-duration:1.1s]" />
      )}
      {children}
    </button>
  );
}
