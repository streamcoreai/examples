/**
 * Locomotion commands arriving from the server.
 *
 * The server exposes the `movement.*` tools to the model
 * (server/internal/tools/movement.go), intercepts the tool call, and pushes a
 * topic-addressed packet down the data channel rather than executing anything
 * itself. The firmware in examples/esp32-desktop-car decodes exactly this
 * payload into motor PWM; here the same actions drive a mesh around a floor
 * instead, so a browser tab and a two-wheel robot answer the same sentence the
 * same way. That is why the tools are named for the action rather than the
 * device.
 *
 * Defaults and clamps are repeated from the firmware's `parse_movement_command`
 * rather than assumed: the server omits `duration_ms` and `speed_percent`
 * entirely when the model did not name them.
 */

import { WALK } from "./config";
import type { Expression } from "./expression";
import type { Locomotion } from "./locomotion";

export const MOVEMENT_COMMAND_TOPIC = "movement.command";

export type MovementAction =
  | "forward"
  | "backward"
  | "turn_left"
  | "turn_right"
  | "pivot_forward_left"
  | "pivot_forward_right"
  | "pivot_back_left"
  | "pivot_back_right"
  | "stop"
  | "fancy"
  | "shake";

export interface MovementCommand {
  action: MovementAction;
  durationMs: number;
  speedPercent: number;
  /**
   * "Keep going until I say stop." The duration stops meaning anything and the
   * bot walks until the floor runs out or a `stop` arrives.
   */
  continuous: boolean;
}

/** How the bot should react to a command, over and above moving. */
export interface MovementReaction {
  expression?: Expression;
  seconds?: number;
}

const ACTIONS = new Set<string>([
  "forward", "backward", "turn_left", "turn_right",
  "pivot_forward_left", "pivot_forward_right", "pivot_back_left", "pivot_back_right",
  "stop", "fancy", "shake",
]);

/** Same table as the firmware's, so an omitted argument means the same thing here. */
function defaultsFor(action: MovementAction): { durationMs: number; speedPercent: number } {
  switch (action) {
    case "stop":
      return { durationMs: 0, speedPercent: 0 };
    case "fancy":
      return { durationMs: 3000, speedPercent: 80 };
    case "shake":
      return { durationMs: 1200, speedPercent: 90 };
    default:
      return { durationMs: 1500, speedPercent: 80 };
  }
}

export function parseMovementCommand(payload: Uint8Array): MovementCommand | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const {
    action, duration_ms: duration, speed_percent: speed, continuous,
  } = raw as Record<string, unknown>;
  if (typeof action !== "string" || !ACTIONS.has(action)) return null;

  const fallback = defaultsFor(action as MovementAction);
  return {
    action: action as MovementAction,
    durationMs: Math.min(10000, numberOr(duration, fallback.durationMs)),
    speedPercent: Math.min(100, numberOr(speed, fallback.speedPercent)),
    continuous: continuous === true,
  };
}

/**
 * Runs a command against the bot's locomotion.
 *
 * The car varies wheel duty cycle; this bot always walks at one comfortable
 * pace, so `speed_percent` is folded into how far it goes rather than how fast.
 * Over a fixed duration the two come to the same distance, which is what the
 * model was reasoning about when it picked the numbers.
 */
export function applyMovementCommand(locomotion: Locomotion, command: MovementCommand): MovementReaction {
  const seconds = command.durationMs / 1000;
  const effort = command.speedPercent / 100;
  // A continuous walk asks for more floor than the room has; Locomotion trims
  // it to what is actually there, so the bot walks to the far end and stops
  // rather than stopping after a step and claiming it is still going.
  const metres = command.continuous ? 30 : WALK.speed * seconds * effort;
  const radians = WALK.turnSpeed * seconds * effort;

  switch (command.action) {
    case "forward":
      return blockedIfShort(locomotion.walk(metres));
    case "backward":
      return blockedIfShort(locomotion.walk(-metres));
    case "turn_left":
      locomotion.turn(radians);
      return {};
    case "turn_right":
      locomotion.turn(-radians);
      return {};
    case "pivot_forward_left":
      return blockedIfShort(locomotion.walk(metres, WALK.pivotCurvature));
    case "pivot_forward_right":
      return blockedIfShort(locomotion.walk(metres, -WALK.pivotCurvature));
    case "pivot_back_left":
      return blockedIfShort(locomotion.walk(-metres, -WALK.pivotCurvature));
    case "pivot_back_right":
      return blockedIfShort(locomotion.walk(-metres, WALK.pivotCurvature));
    case "stop":
      locomotion.stop();
      return {};
    case "shake":
      shake(locomotion, seconds * effort);
      return { expression: "happy", seconds: 1.4 };
    case "fancy":
      fancy(locomotion, seconds * effort);
      return { expression: "happy", seconds: Math.max(2, seconds) };
  }
}

/** A wiggle that ends where it started: out, back through, and return. */
function shake(locomotion: Locomotion, seconds: number) {
  const swing = Math.min(0.42, WALK.turnSpeed * seconds * 0.22);
  locomotion.turn(swing);
  locomotion.turn(-swing * 2);
  locomotion.turn(swing);
}

/**
 * The little show. A wiggle to start, a full spin, then a wiggle to finish —
 * a routine with a shape, rather than a random walk that happens to stop.
 */
function fancy(locomotion: Locomotion, seconds: number) {
  shake(locomotion, seconds * 0.25);
  locomotion.turn(Math.PI);
  locomotion.turn(Math.PI);
  shake(locomotion, seconds * 0.25);
}

function blockedIfShort({ blocked }: { blocked: boolean }): MovementReaction {
  // Walking into a desk is worth a face, since the bot cannot say so itself:
  // the model has already been told the move succeeded.
  return blocked ? { expression: "surprised", seconds: 0.9 } : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
