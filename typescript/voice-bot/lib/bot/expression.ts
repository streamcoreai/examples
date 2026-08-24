/**
 * The bot's face has no bones and no blend shapes — the mesh is a single frozen
 * lump of 150k triangles. Everything expressive it does comes from these
 * numbers, which get painted onto its visor each frame.
 */
export type Expression =
  | "boot"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "happy"
  | "surprised"
  | "muted"
  | "error"
  | "offline";

export interface FaceParams {
  /** Vertical eye scale. 0 is shut, 1 is resting, above that is wide-eyed. */
  eyeOpen: number;
  /** Bows the eye upward into a crescent. This is what reads as a smile. */
  eyeCurve: number;
  eyeWidth: number;
  eyeSpacing: number;
  browRaise: number;
  /** Positive tilts the inner ends down (stern), negative up (worried). */
  browAngle: number;
  browOpacity: number;
  mouthOpen: number;
  mouthWidth: number;
  mouthCurve: number;
  gazeX: number;
  gazeY: number;
  /** Multiplier on emissive strength, for the whole face and the bot's rings. */
  glow: number;
  /** 0 = cyan, 1 = the violet used while thinking. */
  hueShift: number;
  /** 0 = cyan, 1 = the amber-red used for errors. */
  alert: number;
}

const REST: FaceParams = {
  eyeOpen: 1,
  eyeCurve: 0.12,
  eyeWidth: 1,
  eyeSpacing: 1,
  browRaise: 0,
  browAngle: 0,
  browOpacity: 0,
  mouthOpen: 0,
  mouthWidth: 1,
  mouthCurve: 0.55,
  gazeX: 0,
  gazeY: 0,
  glow: 1,
  hueShift: 0,
  alert: 0,
};

const EXPRESSIONS: Record<Expression, Partial<FaceParams>> = {
  // Powering up: squinting, dim, mouth flat.
  boot: { eyeOpen: 0.12, eyeCurve: 0, mouthCurve: 0, mouthWidth: 0.6, glow: 0.35 },
  idle: {},
  // Leaning in. Wide eyes, brows just lifted, a small ready smile.
  listening: {
    eyeOpen: 1.16,
    eyeCurve: 0.06,
    eyeWidth: 1.04,
    browRaise: 0.32,
    browOpacity: 0.55,
    mouthCurve: 0.45,
    mouthWidth: 0.92,
    glow: 1.15,
  },
  // Looking off and up, one brow working, eyes narrowed.
  thinking: {
    eyeOpen: 0.72,
    eyeCurve: 0.02,
    eyeWidth: 0.94,
    browRaise: 0.18,
    browAngle: -0.45,
    browOpacity: 0.7,
    mouthCurve: 0.1,
    mouthWidth: 0.78,
    gazeX: 0.45,
    gazeY: -0.5,
    glow: 0.92,
    hueShift: 1,
  },
  speaking: {
    eyeOpen: 1.02,
    eyeCurve: 0.18,
    browRaise: 0.12,
    browOpacity: 0.3,
    mouthCurve: 0.3,
    glow: 1.2,
  },
  happy: {
    eyeOpen: 0.78,
    eyeCurve: 0.95,
    eyeWidth: 1.1,
    browRaise: 0.45,
    browOpacity: 0.35,
    mouthCurve: 0.95,
    mouthWidth: 1.12,
    mouthOpen: 0.18,
    glow: 1.35,
  },
  surprised: {
    eyeOpen: 1.5,
    eyeCurve: -0.15,
    eyeWidth: 1.12,
    browRaise: 0.9,
    browOpacity: 0.8,
    mouthOpen: 0.55,
    mouthWidth: 0.72,
    mouthCurve: 0.1,
    glow: 1.4,
  },
  // Eyes averted, mouth clamped shut and narrow.
  muted: {
    eyeOpen: 0.78,
    eyeCurve: 0.05,
    browRaise: -0.2,
    browAngle: 0.3,
    browOpacity: 0.6,
    mouthCurve: -0.1,
    mouthWidth: 0.66,
    glow: 0.7,
  },
  error: {
    eyeOpen: 0.62,
    eyeCurve: -0.1,
    browAngle: 0.85,
    browRaise: -0.1,
    browOpacity: 0.9,
    mouthCurve: -0.6,
    mouthWidth: 0.8,
    glow: 1.1,
    alert: 1,
  },
  offline: { eyeOpen: 0.06, eyeCurve: 0, browOpacity: 0, mouthCurve: 0, mouthWidth: 0.5, glow: 0.22 },
};

/** How fast each parameter chases its target, in units per second. */
const RATES: Partial<Record<keyof FaceParams, number>> = {
  eyeOpen: 9,
  eyeCurve: 7,
  eyeWidth: 7,
  browRaise: 8,
  browAngle: 8,
  browOpacity: 6,
  mouthCurve: 7,
  mouthWidth: 8,
  gazeX: 5,
  gazeY: 5,
  glow: 4,
  hueShift: 3.5,
  alert: 5,
};

const KEYS = Object.keys(REST) as (keyof FaceParams)[];

export interface FaceInputs {
  expression: Expression;
  /** 0–1 envelope of the agent's voice. Drives the mouth. */
  agentLevel: number;
  /** 0–1 envelope of the user's microphone. */
  userLevel: number;
  /** Where to look, in visor-relative units. Roughly ±1 at the screen edge. */
  gaze: { x: number; y: number };
}

function damp(current: number, target: number, rate: number, dt: number): number {
  // Frame-rate independent exponential approach. A plain lerp would move
  // further per second on a 144 Hz display than on a 60 Hz one.
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export class FaceSolver {
  readonly params: FaceParams = { ...REST };

  private time = 0;
  private nextBlink = 2.5;
  private blinkStart = -1;
  private blinkQueue = 0;

  private nextSaccade = 1.8;
  private saccade = { x: 0, y: 0 };

  /**
   * Rolling ceiling on the agent's audio envelope. TTS output level varies a
   * lot between voices and providers; without normalising, a quiet voice barely
   * moves the mouth and a loud one pins it open.
   */
  private loudest = 0.12;
  private mouthEnvelope = 0;
  private articulation = 0;
  private articulationTarget = 0;
  private nextArticulation = 0;

  update(dt: number, inputs: FaceInputs): FaceParams {
    this.time += dt;
    const p = this.params;
    const target = { ...REST, ...EXPRESSIONS[inputs.expression] };

    this.updateGaze(dt, inputs, target);
    this.updateMouth(dt, inputs, target);

    for (const key of KEYS) {
      if (key === "eyeOpen" || key === "mouthOpen") continue;
      p[key] = damp(p[key], target[key], RATES[key] ?? 8, dt);
    }

    p.mouthOpen = damp(p.mouthOpen, target.mouthOpen, 14, dt);
    p.eyeOpen = damp(p.eyeOpen, target.eyeOpen, RATES.eyeOpen!, dt) * this.blink(dt, inputs);

    // A held glance at the user reads as attention; add a slow breathing pulse
    // to the glow so the face is never completely static.
    p.glow *= 1 + Math.sin(this.time * 1.7) * 0.035 + inputs.userLevel * 0.12;

    return p;
  }

  /** Multiplier applied to eye openness, 1 when open and 0 mid-blink. */
  private blink(dt: number, inputs: FaceInputs): number {
    if (inputs.expression === "offline" || inputs.expression === "boot") return 1;

    if (this.blinkStart < 0 && this.time >= this.nextBlink) {
      this.blinkStart = this.time;
      // People mostly blink once, sometimes twice in quick succession.
      this.blinkQueue = Math.random() < 0.22 ? 1 : 0;
    }

    if (this.blinkStart < 0) return 1;

    const DURATION = 0.13;
    const t = (this.time - this.blinkStart) / DURATION;
    if (t >= 1) {
      this.blinkStart = -1;
      if (this.blinkQueue > 0) {
        this.blinkQueue--;
        this.nextBlink = this.time + 0.09;
      } else {
        // Thinking suppresses blinking a little, staring does the opposite.
        const base = inputs.expression === "thinking" ? 4.5 : 2.6;
        this.nextBlink = this.time + base + Math.random() * 3.6;
      }
      return 1;
    }
    // Down fast, up slower — a symmetric blink looks mechanical.
    return t < 0.4 ? 1 - t / 0.4 : (t - 0.4) / 0.6;
  }

  private updateGaze(dt: number, inputs: FaceInputs, target: FaceParams) {
    if (this.time >= this.nextSaccade) {
      this.nextSaccade = this.time + 1.4 + Math.random() * 3;
      const reach = inputs.expression === "thinking" ? 0.5 : 0.22;
      this.saccade.x = (Math.random() * 2 - 1) * reach;
      this.saccade.y = (Math.random() * 2 - 1) * reach * 0.6;
    }
    // While thinking the bot looks away, so the pointer stops pulling on it.
    const follow = inputs.expression === "thinking" ? 0.15 : 0.85;
    target.gazeX = target.gazeX + inputs.gaze.x * follow + this.saccade.x;
    target.gazeY = target.gazeY + inputs.gaze.y * follow + this.saccade.y;
    void dt;
  }

  private updateMouth(dt: number, inputs: FaceInputs, target: FaceParams) {
    const speaking = inputs.expression === "speaking";
    if (!speaking) {
      this.mouthEnvelope = damp(this.mouthEnvelope, 0, 9, dt);
      this.loudest = Math.max(0.12, this.loudest * 0.995);
      return;
    }

    this.loudest = Math.max(inputs.agentLevel, this.loudest * (1 - dt * 0.35), 0.05);
    const normalised = Math.min(1, inputs.agentLevel / this.loudest);
    // Fast attack, slower release: consonants snap the mouth open, vowels decay.
    const rate = normalised > this.mouthEnvelope ? 26 : 11;
    this.mouthEnvelope = damp(this.mouthEnvelope, normalised, rate, dt);

    // Speech is not a sine wave. Re-rolling a width target a few times a second
    // keeps the mouth from pumping like a metronome.
    if (this.time >= this.nextArticulation) {
      this.nextArticulation = this.time + 0.075 + Math.random() * 0.08;
      this.articulationTarget = 0.7 + Math.random() * 0.55;
    }
    this.articulation = damp(this.articulation, this.articulationTarget, 18, dt);

    const shaped = Math.pow(this.mouthEnvelope, 0.7);
    target.mouthOpen = shaped * 0.85;
    target.mouthWidth = 0.86 + shaped * 0.2 * this.articulation;
    target.mouthCurve = 0.35 - shaped * 0.25;
    // Eyes narrow slightly on loud syllables, the way a face does under emphasis.
    target.eyeOpen -= shaped * 0.14;
  }
}
