/**
 * A skeleton for a model that does not have one, and the gestures it can play.
 *
 * The bot is exported as a single welded mesh — one node, one primitive, no
 * skin, no animations — so until now every movement had to be whole-body. That
 * is fine for standing still and obviously wrong once it walks somewhere: the
 * legs just slid along underneath it.
 *
 * So the rig is built at load time instead of in the asset. Eight bones (a root
 * that never moves, two hips, two shoulders, two ankles and a head), and each
 * vertex weighted to one of them by where it sits in the mesh's own bounding
 * box. It costs one pass over 136k vertices and no change to the model
 * pipeline, which means it also survives a re-export of the bot at a different
 * scale.
 *
 * The awkward part is that none of this can be written in world coordinates.
 * Skinning happens in mesh-local space, and this model's local space is
 * Z-up-and-backwards — the glTF node carries a +90° X rotation, so local -Z is
 * world up. Rather than hard-code that, `deriveAxes` reads it back off the
 * mesh's world matrix, so a re-export with a different convention still rigs
 * correctly.
 */

import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Scene } from "@babylonjs/core/scene";

import { RIG } from "./config";

/** Everything a gesture can move, in radians. Zero is the resting pose. */
interface Pose {
  armLSwing: number;
  armLAbduct: number;
  armRSwing: number;
  armRAbduct: number;
  headYaw: number;
  headPitch: number;
}

type Channel = keyof Pose;

export type GestureKind =
  | "wave"
  | "raise_arms"
  | "raise_left_arm"
  | "raise_right_arm"
  | "point_left"
  | "point_right"
  | "look_left"
  | "look_right"
  | "look_up"
  | "look_down"
  | "look_around"
  | "nod"
  | "shake_head"
  | "rest";

interface GestureSpec {
  /** Only the channels named here are taken over; the rest keep walking. */
  pose: Partial<Pose>;
  /**
   * Channels that oscillate around their posed value, for waves and nods.
   * More than one, on frequencies that do not divide into each other, is what
   * keeps a slow gesture like looking around from reading as a metronome.
   */
  wobble?: { channel: Channel; amplitude: number; hz: number }[];
}

/**
 * Arms hang down at rest, so lifting one is a large rotation about the same
 * axis the walk swing uses. Abduction takes it out sideways from the body.
 */
function specFor(kind: GestureKind): GestureSpec {
  const g = RIG.gesture;
  switch (kind) {
    case "wave":
      return {
        pose: { armRAbduct: g.waveAbduct },
        wobble: [{ channel: "armRAbduct", amplitude: g.waveSwing, hz: g.waveHz }],
      };
    case "raise_arms":
      return { pose: { armLAbduct: g.raise, armRAbduct: g.raise } };
    case "raise_left_arm":
      return { pose: { armLAbduct: g.raise } };
    case "raise_right_arm":
      return { pose: { armRAbduct: g.raise } };
    case "point_left":
      return { pose: { armLSwing: g.pointSwing, armLAbduct: g.pointAbduct } };
    case "point_right":
      return { pose: { armRSwing: g.pointSwing, armRAbduct: g.pointAbduct } };
    case "look_left":
      return { pose: { headYaw: g.lookYaw } };
    case "look_right":
      return { pose: { headYaw: -g.lookYaw } };
    case "look_up":
      return { pose: { headPitch: -g.lookPitch } };
    case "look_down":
      return { pose: { headPitch: g.lookPitch } };
    case "nod":
      return { pose: {}, wobble: [{ channel: "headPitch", amplitude: g.nod, hz: g.nodHz }] };
    case "shake_head":
      return { pose: {}, wobble: [{ channel: "headYaw", amplitude: g.shake, hz: g.shakeHz }] };
    case "look_around":
      // Wider and far slower than a head shake, and the pitch drifts on its own
      // frequency so the two never come back into phase — the same reason the
      // idle motion layers three clocks instead of one.
      return {
        pose: {},
        wobble: [
          { channel: "headYaw", amplitude: g.sweep, hz: g.sweepHz },
          { channel: "headPitch", amplitude: g.sweepPitch, hz: g.sweepPitchHz },
        ],
      };
    case "rest":
      return { pose: {} };
  }
}

/** Which local axis is which, once the node's own rotation is taken out. */
interface Axes {
  up: number;
  upSign: number;
  side: number;
  sideSign: number;
  forward: number;
  forwardSign: number;
}

function deriveAxes(mesh: Mesh): Axes {
  const world = mesh.computeWorldMatrix(true);
  const pick = (component: "x" | "y" | "z") => {
    let best = 0;
    let bestDot = -Infinity;
    let sign = 1;
    for (let axis = 0; axis < 3; axis++) {
      const local = new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
      // Direction only: translation would swamp the comparison.
      const mapped = Vector3.TransformNormal(local, world);
      const value = mapped[component];
      if (Math.abs(value) > bestDot) {
        bestDot = Math.abs(value);
        best = axis;
        sign = Math.sign(value) || 1;
      }
    }
    return { axis: best, sign };
  };
  const up = pick("y");
  const side = pick("x");
  const forward = pick("z");
  return {
    up: up.axis, upSign: up.sign,
    side: side.axis, sideSign: side.sign,
    forward: forward.axis, forwardSign: forward.sign,
  };
}

/**
 * Smooth 0→1 ramp. Weights have to blend rather than switch, or the mesh tears
 * open along whatever line the threshold happened to fall on.
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const ROOT = 0;
const HIP_L = 1;
const HIP_R = 2;
const SHOULDER_L = 3;
const SHOULDER_R = 4;
const FOOT_L = 5;
const FOOT_R = 6;
const HEAD = 7;

interface Active {
  spec: GestureSpec;
  elapsed: number;
  duration: number;
}

/**
 * More than one gesture can be in flight, because a single turn often produces
 * more than one tool call — "put both hands up" tends to come back as a left
 * and a right, and "wave and look left" as two. Replacing the previous gesture
 * each time means the second silently cancels the first and only half the
 * request happens.
 */
const MAX_ACTIVE = 4;

export class BotRig {
  /** Oldest first, so a later gesture wins on any channel they share. */
  private gestures: Active[] = [];
  private readonly pose: Pose = {
    armLSwing: 0, armLAbduct: 0, armRSwing: 0, armRAbduct: 0, headYaw: 0, headPitch: 0,
  };

  private constructor(
    private readonly skeleton: Skeleton,
    private readonly bones: Bone[],
    private readonly axes: Axes,
    private readonly swingAxis: Vector3,
    private readonly abductAxis: Vector3,
    private readonly upAxis: Vector3
  ) {}

  /**
   * Weights the mesh and hangs a skeleton off it. Returns null if the mesh has
   * no position data to measure, which leaves the bot rigid rather than broken.
   */
  static attach(mesh: Mesh, scene: Scene): BotRig | null {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) return null;

    const axes = deriveAxes(mesh);
    const count = positions.length / 3;

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      for (let a = 0; a < 3; a++) {
        const v = positions[i * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    if (size[axes.up] <= 0 || size[axes.side] <= 0) return null;

    /** 0 at the feet, 1 at the top of the head. */
    const heightAt = (i: number) => {
      const t = (positions[i * 3 + axes.up] - min[axes.up]) / size[axes.up];
      return axes.upSign > 0 ? t : 1 - t;
    };
    /** -1 on the bot's left, +1 on its right. */
    const sideAt = (i: number) => {
      const t = (positions[i * 3 + axes.side] - min[axes.side]) / size[axes.side];
      return (t * 2 - 1) * axes.sideSign;
    };

    const indices = new Float32Array(count * 4);
    const weights = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
      const h = heightAt(i);
      const s = sideAt(i);
      const across = Math.abs(s);

      // Everything above the neck is head, whatever its width — the head is the
      // widest part of the bot, so gating this one on `across` would drop its
      // sides back onto the body.
      const head = smoothstep(RIG.headFrom, RIG.headTo, h);

      // Legs run up the middle; the hands hang outside them at the same height,
      // which is the whole reason these are gated on `across` and not just h.
      const leg =
        smoothstep(RIG.legTop, RIG.legTop - RIG.legBlend, h) *
        smoothstep(RIG.legSide, RIG.legSide - RIG.sideBlend, across);

      const arm =
        smoothstep(RIG.armSide - RIG.sideBlend, RIG.armSide, across) *
        smoothstep(RIG.armBottom - RIG.armBlend, RIG.armBottom, h) *
        smoothstep(RIG.shoulder, RIG.shoulder - RIG.armBlend, h);

      // The sole, which rides on the ankle rather than the hip.
      const foot = leg * smoothstep(RIG.footTop, RIG.footTop - RIG.footBlend, h);

      // Sides are the bot's own, not the viewer's, matching movement.turn_left. The
      // bot faces the camera, so its left hand is the one on the right of the
      // screen — which is +side.
      const botLeft = s > 0;

      // The gates are disjoint by construction, so whichever is largest wins
      // outright rather than the set being mixed.
      let bone = ROOT;
      let weight = 0;
      if (head > 0.001 && head >= arm) {
        bone = HEAD;
        weight = head;
      } else if (foot > 0.5) {
        bone = botLeft ? FOOT_L : FOOT_R;
        weight = leg;
      } else if (leg > arm) {
        bone = botLeft ? HIP_L : HIP_R;
        weight = leg;
      } else if (arm > 0) {
        bone = botLeft ? SHOULDER_L : SHOULDER_R;
        weight = arm;
      }

      indices[i * 4] = weight > 0 ? bone : ROOT;
      indices[i * 4 + 1] = ROOT;
      weights[i * 4] = weight > 0 ? weight : 1;
      weights[i * 4 + 1] = weight > 0 ? 1 - weight : 0;
    }

    const skeleton = new Skeleton("botRig", "botRig", scene);
    const local = (h: number, s: number) => {
      const point = [0, 0, 0];
      const up = axes.upSign > 0 ? h : 1 - h;
      point[axes.up] = min[axes.up] + up * size[axes.up];
      point[axes.side] = min[axes.side] + ((s * axes.sideSign + 1) / 2) * size[axes.side];
      point[axes.forward] = (min[axes.forward] + max[axes.forward]) / 2;
      return new Vector3(point[0], point[1], point[2]);
    };

    // +side is the bot's left, so the L pivots sit on the positive side.
    const pivots = [
      Vector3.Zero(),
      local(RIG.legTop, RIG.hipSide),
      local(RIG.legTop, -RIG.hipSide),
      local(RIG.shoulder, RIG.shoulderSide),
      local(RIG.shoulder, -RIG.shoulderSide),
      local(RIG.footTop, RIG.hipSide),
      local(RIG.footTop, -RIG.hipSide),
      local(RIG.neck, 0),
    ];

    // Creation order IS the index Babylon writes into the transform array, and
    // the vertex weights above address bones by the constants. Build them in
    // constant order or the mesh is skinned by the wrong bones — which looks
    // like a rigging problem rather than an off-by-two, because at rest every
    // bone is identity and only moving reveals it.
    const root = new Bone("root", skeleton, null, Matrix.Identity());
    const bones = [root];
    for (const [index, name] of [
      [HIP_L, "hipL"], [HIP_R, "hipR"],
      [SHOULDER_L, "shoulderL"], [SHOULDER_R, "shoulderR"],
    ] as const) {
      const rest = Matrix.Translation(pivots[index].x, pivots[index].y, pivots[index].z);
      bones[index] = new Bone(name, skeleton, root, rest, rest);
    }
    // Ankles hang off their hip, so a bone matrix relative to the parent is the
    // offset between the two joints rather than the joint itself.
    for (const [index, name, parent] of [[FOOT_L, "footL", HIP_L], [FOOT_R, "footR", HIP_R]] as const) {
      const offset = pivots[index].subtract(pivots[parent]);
      const rest = Matrix.Translation(offset.x, offset.y, offset.z);
      bones[index] = new Bone(name, skeleton, bones[parent], rest, rest);
    }
    const neck = Matrix.Translation(pivots[HEAD].x, pivots[HEAD].y, pivots[HEAD].z);
    bones[HEAD] = new Bone("head", skeleton, root, neck, neck);

    if (skeleton.bones.some((bone, i) => bone !== bones[i])) {
      console.error("[voice-bot] rig bone order does not match its indices; skinning will be wrong.");
    }

    mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, indices, false);
    mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, weights, false);
    // Two is all this rig ever uses — the limb and the root it blends back into.
    mesh.numBoneInfluencers = 2;
    mesh.skeleton = skeleton;

    const unit = (axis: number, sign: number) => {
      const v = new Vector3(0, 0, 0);
      v[(["x", "y", "z"] as const)[axis]] = sign;
      return v;
    };
    // Limbs swing about the axis through the hips, lift sideways about the one
    // running out of the bot's chest, and the head turns about its own spine.
    const rig = new BotRig(
      skeleton,
      bones,
      axes,
      unit(axes.side, axes.sideSign),
      unit(axes.forward, axes.forwardSign),
      unit(axes.up, axes.upSign)
    );
    rig.update(0, 0, 0);
    return rig;
  }

  /**
   * Starts a gesture, replacing whatever was playing. `seconds` is how long it
   * holds before easing back; a wave that outlives the sentence that asked for
   * it is worse than one that finishes early.
   */
  play(kind: GestureKind, seconds: number) {
    if (kind === "rest") {
      this.gestures.length = 0;
      return;
    }
    this.gestures.push({ spec: specFor(kind), elapsed: 0, duration: Math.max(0.4, seconds) });
    if (this.gestures.length > MAX_ACTIVE) this.gestures.shift();
  }

  get isGesturing() {
    return this.gestures.length > 0;
  }

  /**
   * Poses the limbs for a point in the walk cycle, then lays any gesture over
   * the top.
   *
   * `phase` is in radians and comes off the distance travelled, so the legs
   * keep pace with the ground instead of with the clock. `gait` fades the whole
   * thing out as the bot slows, which is what stops a stationary bot doing a
   * tiny permanent shuffle.
   */
  update(phase: number, gait: number, dt: number) {
    const swing = Math.sin(phase) * gait;

    this.pose.armLSwing = -swing * RIG.armSwing;
    this.pose.armRSwing = swing * RIG.armSwing;
    this.pose.armLAbduct = 0;
    this.pose.armRAbduct = 0;
    this.pose.headYaw = 0;
    this.pose.headPitch = 0;

    this.applyGestures(dt);

    this.pose1(HIP_L, this.swingAxis, swing * RIG.legSwing);
    this.pose1(HIP_R, this.swingAxis, -swing * RIG.legSwing);
    // Ankles give most of the hip's swing back, so the soles stay near flat.
    // Without this the bot tip-toes: the foot is welded to the shin, so it
    // tilts through the full swing angle.
    this.pose1(FOOT_L, this.swingAxis, -swing * RIG.legSwing * RIG.ankleKeep);
    this.pose1(FOOT_R, this.swingAxis, swing * RIG.legSwing * RIG.ankleKeep);

    // Abduction is "away from the chest" for both arms, so the mirror lives
    // here rather than in every gesture that lifts one.
    this.pose2(SHOULDER_L, this.pose.armLSwing, this.pose.armLAbduct);
    this.pose2(SHOULDER_R, this.pose.armRSwing, -this.pose.armRAbduct);

    this.bones[HEAD].setRotationQuaternion(
      Quaternion.RotationAxis(this.upAxis, this.pose.headYaw).multiply(
        Quaternion.RotationAxis(this.swingAxis, this.pose.headPitch)
      ),
      Space.LOCAL
    );
  }

  /** Eases each live gesture in over the walk pose, and back out again. */
  private applyGestures(dt: number) {
    if (!this.gestures.length) return;
    const { easeIn, easeOut } = RIG.gesture;

    for (const active of this.gestures) {
      active.elapsed += dt;
      const left = active.duration - active.elapsed;
      // Ramp in, hold, ramp out. The tail runs past `duration`, which is why a
      // gesture is only dropped once its ease-out has finished.
      const blend = Math.min(
        smoothstep(0, easeIn, active.elapsed),
        left >= 0 ? 1 : smoothstep(-easeOut, 0, left)
      );

      for (const [channel, value] of Object.entries(active.spec.pose) as [Channel, number][]) {
        this.pose[channel] = this.pose[channel] * (1 - blend) + value * blend;
      }
      for (const wobble of active.spec.wobble ?? []) {
        this.pose[wobble.channel] +=
          Math.sin(active.elapsed * wobble.hz * Math.PI * 2) * wobble.amplitude * blend;
      }
    }

    this.gestures = this.gestures.filter((g) => g.duration - g.elapsed > -easeOut);
  }

  private pose1(index: number, axis: Vector3, angle: number) {
    // setAxisAngle and not updateMatrix: the latter overwrites the bone's bind
    // matrix as well as its local one, so every pose cancels itself out and the
    // mesh never moves.
    this.bones[index].setAxisAngle(axis, angle, Space.LOCAL);
  }

  private pose2(index: number, swing: number, abduct: number) {
    this.bones[index].setRotationQuaternion(
      Quaternion.RotationAxis(this.swingAxis, swing).multiply(
        Quaternion.RotationAxis(this.abductAxis, abduct)
      ),
      Space.LOCAL
    );
  }

  dispose() {
    this.skeleton.dispose();
  }
}
