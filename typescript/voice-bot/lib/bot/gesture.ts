/**
 * Arm and head gestures arriving from the server.
 *
 * Same shape as the locomotion commands in movementCommand.ts, on their own topic:
 * the server exposes `bot.*` tools (server/internal/tools/bot.go), intercepts
 * the call, and pushes a base64-wrapped packet down the data channel without
 * waiting for anything back. Separate from `movement.command` so a device with a
 * drivetrain and no arms can ignore the topic wholesale rather than having to
 * know which actions it cannot perform.
 *
 * Left and right are the bot's own throughout, matching `movement.turn_left`.
 */

import type { GestureKind } from "./rig";

export const BOT_GESTURE_TOPIC = "bot.gesture";

export interface BotGesture {
  kind: GestureKind;
  seconds: number;
}

const KINDS = new Set<string>([
  "wave", "raise_arms", "raise_left_arm", "raise_right_arm",
  "point_left", "point_right",
  "look_left", "look_right", "look_up", "look_down", "look_around",
  "nod", "shake_head", "rest",
]);

/** Held poses outlast the beat-based ones, which read as one gesture and stop. */
function defaultSeconds(kind: GestureKind): number {
  switch (kind) {
    case "wave":
    case "nod":
    case "shake_head":
      return 1.8;
    case "rest":
      return 0.4;
    // Long enough for a full sweep and back; cut short it looks like the bot
    // turned to something and then thought better of it.
    case "look_around":
      return 4.5;
    default:
      return 2.5;
  }
}

export function parseGesture(payload: Uint8Array): BotGesture | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const { action, duration_ms: duration } = raw as Record<string, unknown>;
  if (typeof action !== "string" || !KINDS.has(action)) return null;

  const kind = action as GestureKind;
  const ms = typeof duration === "number" && Number.isFinite(duration) && duration > 0
    ? Math.min(10000, duration)
    : defaultSeconds(kind) * 1000;
  return { kind, seconds: ms / 1000 };
}
