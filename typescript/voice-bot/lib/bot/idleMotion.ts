/**
 * Idle body motion.
 *
 * The bot is one rigid mesh, so every movement is whole-body — it cannot turn
 * its head without turning its feet. That rules out big gestures and makes the
 * small ones carry everything, which in turn makes regularity fatal: a single
 * sine is read as machinery within about two cycles.
 *
 * So motion comes from three layers that never line up with each other:
 *
 *   1. Breathing, on its own slow clock with a drifting depth.
 *   2. Continuous noise — a low-frequency wander on every axis at once.
 *   3. Discrete gestures — weight shifts, glances, tilts, nods — fired on a
 *      random schedule and overlapping each other.
 *
 * Because the model's origin sits between its feet, rotations pivot there,
 * which is what a standing body actually does when it shifts its weight.
 */

export interface IdlePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  /** Added to the face's gaze, so the eyes lead a turn instead of trailing it. */
  gazeX: number;
  gazeY: number;
}

export interface IdleContext {
  /** Where the bot's attention is, in -1..1 screen units, or null to let it wander. */
  attention: { x: number; y: number } | null;
  speaking: boolean;
  /** 0–1 envelope of the agent's voice. */
  agentLevel: number;
}

type GestureKind = "weightShift" | "glance" | "tilt" | "nod" | "settle";

interface Gesture {
  kind: GestureKind;
  elapsed: number;
  duration: number;
  /** Signed magnitude, so the same gesture goes either way. */
  amount: number;
  /** Fraction of the duration spent at full extent. */
  hold: number;
}

const IDLE_WEIGHTS: [GestureKind, number][] = [
  ["weightShift", 0.32],
  ["glance", 0.28],
  ["tilt", 0.2],
  ["nod", 0.12],
  ["settle", 0.08],
];

// People move more while they talk, and mostly with their head.
const SPEAKING_WEIGHTS: [GestureKind, number][] = [
  ["nod", 0.34],
  ["glance", 0.24],
  ["tilt", 0.22],
  ["weightShift", 0.14],
  ["settle", 0.06],
];

const MAX_CONCURRENT = 2;

function smoothstep(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
}

/** Trapezoid: ramp up, hold, ramp down. */
function envelope(t: number, hold: number): number {
  const ramp = (1 - hold) / 2;
  if (ramp <= 0) return 1;
  if (t < ramp) return smoothstep(t / ramp);
  if (t < ramp + hold) return 1;
  return smoothstep(1 - (t - ramp - hold) / ramp);
}

/** Cheap deterministic value noise. Smooth, unlike Math.random, and seedable. */
function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const hash = (n: number) => {
    const s = Math.sin((n + seed * 57.31) * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  };
  const u = f * f * (3 - 2 * f);
  return (hash(i) + (hash(i + 1) - hash(i)) * u) * 2 - 1;
}

/** Two octaves is enough to stop it sounding like a single wobble. */
function drift(x: number, seed: number): number {
  return valueNoise(x, seed) * 0.68 + valueNoise(x * 2.31, seed + 11) * 0.32;
}

export class IdleMotion {
  private time = 0;
  private gestures: Gesture[] = [];
  private nextGesture = 2.5;

  /** Where the bot looks when nothing is asking for its attention. */
  private wander = { x: 0, y: 0 };
  private nextWander = 1.5;

  private readonly pose: IdlePose = {
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, gazeX: 0, gazeY: 0,
  };

  /** Smoothed heading, so gestures pull the body rather than snapping it. */
  private yaw = 0;
  private pitch = 0;
  private roll = 0;

  update(dt: number, context: IdleContext): IdlePose {
    this.time += dt;
    this.advanceWander(context);
    this.advanceGestures(dt, context);

    const t = this.time;

    // Breathing: roughly eleven a minute, with the depth wandering so no two
    // breaths are quite the same size.
    const depth = 0.007 + drift(t * 0.07, 5) * 0.0022;
    const breath = Math.sin(t * 1.06) * depth;

    // Continuous low-frequency drift. Each axis gets its own frequency and
    // seed, so they never come back into phase.
    let yaw = drift(t * 0.13, 1) * 0.030;
    let pitch = drift(t * 0.11, 2) * 0.012 + breath * 0.35;
    let roll = drift(t * 0.09, 3) * 0.012;
    let x = drift(t * 0.10, 6) * 0.004;
    let y = breath;
    const z = drift(t * 0.08, 7) * 0.003;
    let gazeX = 0;
    let gazeY = 0;

    for (const gesture of this.gestures) {
      const progress = gesture.elapsed / gesture.duration;
      const env = envelope(progress, gesture.hold);
      const a = gesture.amount;

      switch (gesture.kind) {
        case "weightShift":
          // Sway onto one foot: roll, drift sideways, and drop a little.
          roll += env * a * 0.030;
          x += env * a * 0.013;
          y -= env * Math.abs(a) * 0.004;
          break;
        case "glance":
          yaw += env * a * 0.15;
          // Eyes get there first — they lead the turn by a good margin.
          gazeX += envelope(Math.min(1, progress * 1.6), gesture.hold) * a * 0.8;
          break;
        case "tilt":
          roll += env * a * 0.055;
          gazeY += env * a * 0.12;
          break;
        case "nod": {
          // A decaying bob rather than a held pose.
          const decay = Math.sin(progress * Math.PI * 2) * (1 - progress);
          pitch += decay * a * 0.055;
          y -= Math.abs(decay) * Math.abs(a) * 0.006;
          break;
        }
        case "settle":
          y -= env * Math.abs(a) * 0.010;
          pitch += env * a * 0.018;
          break;
      }
    }

    // Emphasis on loud syllables, which is what makes a talking head look like
    // it means what it is saying.
    if (context.speaking) {
      const emphasis = Math.pow(context.agentLevel, 1.4);
      pitch += emphasis * 0.016;
      y += emphasis * 0.004;
    }

    const attention = context.attention ?? this.wander;
    // The body follows the eyes part of the way, never the whole way.
    yaw += attention.x * 0.26;
    pitch += -attention.y * 0.07;
    gazeX += attention.x;
    gazeY += attention.y;

    const chase = (current: number, target: number, rate: number) =>
      current + (target - current) * (1 - Math.exp(-rate * dt));

    // Turning is slower than looking, and pitching slower still.
    this.yaw = chase(this.yaw, yaw, 2.6);
    this.pitch = chase(this.pitch, pitch, 3.2);
    this.roll = chase(this.roll, roll, 2.2);

    this.pose.x = x;
    this.pose.y = y;
    this.pose.z = z;
    this.pose.yaw = this.yaw;
    this.pose.pitch = this.pitch;
    this.pose.roll = this.roll;
    this.pose.gazeX = gazeX;
    this.pose.gazeY = gazeY;
    return this.pose;
  }

  private advanceWander(context: IdleContext) {
    if (context.attention) {
      // Something has its attention; park the wander target where it is
      // looking so there is no jump when attention is released.
      this.wander.x = context.attention.x;
      this.wander.y = context.attention.y;
      this.nextWander = this.time + 1.2;
      return;
    }
    if (this.time < this.nextWander) return;
    this.nextWander = this.time + 2.2 + Math.random() * 4.5;
    // Mostly small shifts of attention, occasionally a proper look away.
    const far = Math.random() < 0.3;
    this.wander.x = (Math.random() * 2 - 1) * (far ? 0.85 : 0.35);
    this.wander.y = (Math.random() * 2 - 1) * (far ? 0.5 : 0.22);
  }

  private advanceGestures(dt: number, context: IdleContext) {
    for (const gesture of this.gestures) gesture.elapsed += dt;
    this.gestures = this.gestures.filter((g) => g.elapsed < g.duration);

    if (this.time < this.nextGesture) return;
    const gap = context.speaking ? 1.4 + Math.random() * 2.2 : 2.8 + Math.random() * 4.4;
    this.nextGesture = this.time + gap;
    if (this.gestures.length >= MAX_CONCURRENT) return;

    const kind = this.pick(context.speaking ? SPEAKING_WEIGHTS : IDLE_WEIGHTS);
    // Two of the same at once reads as a glitch, not a gesture.
    if (this.gestures.some((g) => g.kind === kind)) return;

    this.gestures.push(this.build(kind));
  }

  private pick(weights: [GestureKind, number][]): GestureKind {
    let roll = Math.random() * weights.reduce((sum, [, w]) => sum + w, 0);
    for (const [kind, weight] of weights) {
      roll -= weight;
      if (roll <= 0) return kind;
    }
    return weights[weights.length - 1][0];
  }

  private build(kind: GestureKind): Gesture {
    const sign = Math.random() < 0.5 ? -1 : 1;
    const strength = 0.55 + Math.random() * 0.45;

    switch (kind) {
      case "weightShift":
        // Long and held: this is a posture, not a movement.
        return { kind, elapsed: 0, duration: 4 + Math.random() * 3.5, amount: sign * strength, hold: 0.55 };
      case "glance":
        return { kind, elapsed: 0, duration: 1.6 + Math.random() * 1.6, amount: sign * strength, hold: 0.35 };
      case "tilt":
        return { kind, elapsed: 0, duration: 2.4 + Math.random() * 2.2, amount: sign * strength, hold: 0.45 };
      case "nod":
        return { kind, elapsed: 0, duration: 0.85 + Math.random() * 0.5, amount: strength, hold: 0 };
      case "settle":
        return { kind, elapsed: 0, duration: 0.7 + Math.random() * 0.4, amount: strength, hold: 0.2 };
    }
  }
}
