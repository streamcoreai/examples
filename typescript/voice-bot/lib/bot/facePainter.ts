import { PALETTE } from "./config";
import type { FaceParams } from "./expression";

export interface FaceExtras {
  /** 0–1 microphone envelope, shown as a meter along the bottom of the visor. */
  userLevel: number;
  muted: boolean;
  connected: boolean;
}

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgba([r, g, b]: RGB, alpha: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

const GLOW = hexToRgb(PALETTE.glowHex);
const CORE = hexToRgb(PALETTE.glowCoreHex);
const THINKING = hexToRgb(PALETTE.thinkingHex);
const ALERT = hexToRgb(PALETTE.alertHex);

/**
 * Draws the bot's face into a canvas, which a shader then projects onto the
 * visor. Everything is laid out in units of canvas width so the same code works
 * whatever resolution the face is rendered at.
 *
 * Glow is faked with three passes of decreasing width rather than canvas
 * shadowBlur, which is slow enough to show up in a frame budget at 60fps. The
 * scene's bloom does the rest.
 */
export class FacePainter {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly w: number;
  private readonly h: number;
  private readonly u: number;
  private time = 0;

  constructor(ctx: CanvasRenderingContext2D, width: number, height: number) {
    this.ctx = ctx;
    this.w = width;
    this.h = height;
    this.u = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
  }

  draw(p: FaceParams, extras: FaceExtras, dt: number) {
    this.time += dt;
    const { ctx, w, h, u } = this;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);

    const tint = mix(mix(GLOW, THINKING, p.hueShift), ALERT, p.alert);
    const core = mix(CORE, tint, 0.68 + p.alert * 0.25);
    const glow = Math.max(0.15, p.glow);

    const gazeX = p.gazeX * u * 0.022;
    const gazeY = p.gazeY * u * 0.016;

    this.eyes(p, tint, core, glow, gazeX, gazeY);
    this.brows(p, tint, glow, gazeX, gazeY);
    this.mouth(p, tint, core, glow, gazeX * 0.4);
    if (extras.connected) this.meter(extras, tint, glow);

    ctx.restore();
  }

  private eyes(p: FaceParams, tint: RGB, core: RGB, glow: number, gx: number, gy: number) {
    const u = this.u;
    const eyeY = -u * 0.058 + gy;
    const spacing = u * 0.185 * p.eyeSpacing;
    const width = u * 0.168 * p.eyeWidth;
    // Blinks squash the eye rather than clipping it, so the lid reads as a lid.
    const height = u * 0.074 * Math.max(0.04, p.eyeOpen);

    for (const side of [-1, 1] as const) {
      const x = side * spacing + gx;
      this.lens(x, eyeY, width, height, p.eyeCurve, tint, core, glow, u * 0.018);
    }
  }

  private brows(p: FaceParams, tint: RGB, glow: number, gx: number, gy: number) {
    if (p.browOpacity <= 0.02) return;
    const { ctx, u } = this;
    const y = -u * 0.052 + gy - u * 0.086 - p.browRaise * u * 0.026;
    const spacing = u * 0.185 * p.eyeSpacing;
    const halfW = u * 0.07;

    for (const side of [-1, 1] as const) {
      const x = side * spacing + gx * 0.6;
      // browAngle tilts the inner end; the outer end pivots the other way.
      const inner = p.browAngle * u * 0.022;
      const x0 = x - side * halfW;
      const x1 = x + side * halfW;

      ctx.beginPath();
      ctx.moveTo(x0, y - inner);
      ctx.quadraticCurveTo(x, y - u * 0.012 - p.browRaise * u * 0.006, x1, y + inner);

      for (const [width, alpha] of this.glowPasses(u * 0.017, glow)) {
        ctx.lineWidth = width;
        ctx.strokeStyle = rgba(tint, alpha * p.browOpacity);
        ctx.stroke();
      }
    }
  }

  private mouth(p: FaceParams, tint: RGB, core: RGB, glow: number, gx: number) {
    const u = this.u;
    const y = u * 0.108;
    const width = u * 0.24 * p.mouthWidth;
    const height = u * 0.056 * p.mouthOpen + u * 0.009;

    // While thinking, the mouth gives way to a row of pulsing dots.
    const dots = Math.max(0, p.hueShift - 0.25) / 0.75;
    if (dots < 0.98) {
      this.lens(gx, y, width, height, p.mouthCurve, tint, core, glow * (1 - dots), u * 0.017);
    }
    if (dots > 0.02) this.dots(gx, y, tint, glow * dots, dots);
  }

  private dots(cx: number, cy: number, tint: RGB, glow: number, alpha: number) {
    const { ctx, u } = this;
    const radius = u * 0.013;
    for (let i = 0; i < 3; i++) {
      const phase = this.time * 3.4 - i * 0.55;
      const pulse = 0.35 + 0.65 * Math.max(0, Math.sin(phase));
      ctx.beginPath();
      ctx.arc(cx + (i - 1) * u * 0.046, cy, radius * (0.7 + pulse * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = rgba(tint, Math.min(1, alpha * pulse * glow));
      ctx.fill();
    }
  }

  /**
   * The one primitive both eyes and mouth are made of: the area between two
   * quadratic curves. Raising `curve` bows both edges upward until the shape
   * becomes a crescent, which is what a smiling robot eye actually is.
   */
  private lens(
    cx: number,
    cy: number,
    width: number,
    height: number,
    curve: number,
    tint: RGB,
    core: RGB,
    glow: number,
    tip: number
  ) {
    const { ctx } = this;
    const half = width / 2;

    ctx.beginPath();
    ctx.moveTo(cx - half, cy);
    ctx.quadraticCurveTo(cx, cy - height * (1 + curve * 1.15), cx + half, cy);
    ctx.quadraticCurveTo(cx, cy + height * (1 - curve * 2.0), cx - half, cy);
    ctx.closePath();

    for (const [pass, alpha] of this.glowPasses(tip, glow)) {
      ctx.lineWidth = pass;
      ctx.strokeStyle = rgba(tint, alpha);
      ctx.stroke();
      ctx.fillStyle = rgba(tint, alpha);
      ctx.fill();
    }

    // An inner highlight, not a wash over the whole shape: filling the lot with
    // near-white is what turns a cyan eye into a white blob once the emissive
    // gain and bloom have had their turn.
    const innerW = width * 0.58;
    const innerH = height * 0.5;
    ctx.beginPath();
    ctx.moveTo(cx - innerW / 2, cy);
    ctx.quadraticCurveTo(cx, cy - innerH * (1 + curve * 1.15), cx + innerW / 2, cy);
    ctx.quadraticCurveTo(cx, cy + innerH * (1 - curve * 2.0), cx - innerW / 2, cy);
    ctx.closePath();
    ctx.lineWidth = tip * 0.5;
    ctx.strokeStyle = rgba(core, Math.min(1, 0.34 * glow));
    ctx.stroke();
    ctx.fillStyle = rgba(core, Math.min(1, 0.34 * glow));
    ctx.fill();
  }

  /** Widths and alphas for the fake outer glow, widest and faintest first.
   * Kept deliberately low: the scene's bloom supplies most of the halo, and
   * doubling up on it just smears the shape away. */
  private glowPasses(tip: number, glow: number): [number, number][] {
    const g = Math.min(1.4, glow);
    return [
      [tip * 2.8, 0.045 * g],
      [tip * 1.7, 0.11 * g],
      [tip, Math.min(1, 0.95 * g)],
    ];
  }

  /** A slim spectrum along the bottom of the visor, fed by the user's mic. */
  private meter(extras: FaceExtras, tint: RGB, glow: number) {
    const { ctx, u, h } = this;
    const y = h / 2 - u * 0.038;
    const bars = 13;
    const gap = u * 0.0175;
    const barW = u * 0.0075;
    const colour = extras.muted ? ALERT : tint;

    for (let i = 0; i < bars; i++) {
      const offset = (i - (bars - 1) / 2) * gap;
      // Bell-shaped falloff so the middle bars move most, plus a per-bar phase
      // so it looks like a spectrum instead of a row of pistons.
      const weight = Math.cos(((i - (bars - 1) / 2) / bars) * Math.PI) ** 2;
      const wobble = 0.6 + 0.4 * Math.sin(this.time * 9 + i * 1.7);
      const level = extras.muted ? 0 : extras.userLevel * weight * wobble;
      const height = u * (0.004 + level * 0.05);

      ctx.beginPath();
      ctx.roundRect(offset - barW / 2, y - height / 2, barW, height, barW / 2);
      ctx.fillStyle = rgba(colour, (extras.muted ? 0.3 : 0.22 + level * 1.1) * Math.min(1, glow));
      ctx.fill();
    }
  }
}
