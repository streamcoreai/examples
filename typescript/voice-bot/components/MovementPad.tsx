"use client";

import { useCallback, useEffect, useState } from "react";

import { neutralDrive, type DriveInput } from "@/lib/bot/driveInput";
import { ArrowIcon, RecentreIcon } from "./icons";

type Direction = "forward" | "back" | "left" | "right";

/**
 * Both layouts. WASD is what anyone who has played a game reaches for; the
 * arrows are what everyone else finds. The camera's own arrow-key input is
 * removed in `stage.ts` so the two do not fight over them.
 */
const KEYS: Record<string, Direction> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "back",
  ArrowDown: "back",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
};

interface MovementPadProps {
  /** Called on press and release, not per frame. The scene polls the result. */
  onDrive: (input: DriveInput) => void;
  onRecentre: () => void;
}

/**
 * Driving the bot by hand.
 *
 * Left and right turn on the spot rather than strafe, because that is what the
 * bot can do — the same four wheels-worth of vocabulary the agent's
 * `movement.*` tools have — and with the camera sitting behind its shoulders
 * they read as steering.
 *
 * The pressed keys are React state and the drive input is a ref: the state is
 * only for lighting the buttons up, and it changes on a keypress rather than
 * on a frame.
 */
export function MovementPad({ onDrive, onRecentre }: MovementPadProps) {
  const [held, setHeld] = useState<ReadonlySet<Direction>>(() => new Set());
  const [boost, setBoost] = useState(false);

  const hold = useCallback((direction: Direction, down: boolean) => {
    setHeld((current) => {
      if (current.has(direction) === down) return current;
      const next = new Set(current);
      if (down) next.add(direction);
      else next.delete(direction);
      return next;
    });
  }, []);

  useEffect(() => {
    onDrive({
      forward: (held.has("forward") ? 1 : 0) - (held.has("back") ? 1 : 0),
      turn: (held.has("left") ? 1 : 0) - (held.has("right") ? 1 : 0),
      boost,
    });
    // Nothing else lets go of the keys, so a pad that unmounts mid-press would
    // leave the bot walking off on its own.
    return () => onDrive(neutralDrive());
  }, [held, boost, onDrive]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const down = event.type === "keydown";
      if (event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && /input|textarea/i.test(target.tagName)) return;

      if (event.key === "Shift") {
        setBoost(down);
        return;
      }
      if (event.code === "KeyR") {
        if (down) onRecentre();
        return;
      }
      const direction = KEYS[event.code];
      if (!direction) return;
      // Or the arrows scroll the page out from under the canvas.
      event.preventDefault();
      hold(direction, down);
    };

    const release = () => {
      setHeld(new Set());
      setBoost(false);
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    // A key held while the tab goes away never gets its keyup.
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", release);
    };
  }, [hold, onRecentre]);

  const key = (direction: Direction, label: string, rotation: string) => (
    <PadButton
      active={held.has(direction)}
      label={label}
      onDown={() => hold(direction, true)}
      onUp={() => hold(direction, false)}
    >
      <ArrowIcon className={`h-[17px] w-[17px] ${rotation}`} />
    </PadButton>
  );

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-2 self-end">
      <div className="glass grid touch-none grid-cols-3 gap-1 rounded-2xl p-1.5">
        <span />
        {key("forward", "Walk forward", "")}
        <span />
        {key("left", "Turn left", "-rotate-90")}
        <button
          type="button"
          onClick={onRecentre}
          aria-label="Walk back to the middle of the room"
          className="grid size-9 place-items-center rounded-lg text-white/35 transition hover:bg-white/5 hover:text-white/70"
        >
          <RecentreIcon className="h-[15px] w-[15px]" />
        </button>
        {key("right", "Turn right", "rotate-90")}
        <span />
        {key("back", "Walk backward", "rotate-180")}
        <span />
      </div>
      <p className="hidden font-mono text-[10px] tracking-[0.16em] text-white/25 uppercase sm:block">
        WASD · shift runs
      </p>
    </div>
  );
}

function PadButton({
  active,
  label,
  onDown,
  onUp,
  children,
}: {
  active: boolean;
  label: string;
  onDown: () => void;
  onUp: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onPointerDown={(event) => {
        // Capture so a thumb that slides off the button still releases it, and
        // no focus, so the space bar keeps muting the microphone.
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        onDown();
      }}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={(event) => event.preventDefault()}
      className={`grid size-9 select-none place-items-center rounded-lg transition ${
        active ? "bg-glow/20 text-glow" : "text-white/45 hover:bg-white/5 hover:text-white/80"
      }`}
    >
      {children}
    </button>
  );
}
