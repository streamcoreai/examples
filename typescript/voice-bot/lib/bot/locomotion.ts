/**
 * Driving the bot around the floor on command.
 *
 * The model is a single rigid mesh with no skeleton, so there is no walk cycle
 * to play back. What sells locomotion is the body itself: a bob on every step,
 * a lean into acceleration, and a roll that alternates with the bob so weight
 * reads as transferring from one foot to the other.
 *
 * Steps queue rather than replace. A single spoken sentence often carries two
 * of them ("go forward and turn left"), and running them in order is the only
 * reading that matches what was asked. `stop` is the exception: it clears
 * whatever is pending and brakes.
 *
 * Held keys bypass the queue entirely — see setDrive.
 */

import { WALK } from "./config";
import type { DriveInput } from "./driveInput";

export interface LocomotionPose {
  /** Offset from the standing spot, world units. */
  x: number;
  z: number;
  /** Facing. 0 is toward the camera, which is how the bot starts. Positive is
   *  counter-clockwise seen from above, so it is the bot's own left. */
  heading: number;
  /** Bounce from the walk cycle. */
  bob: number;
  /** Pitch: leaning into acceleration, and back when braking. */
  lean: number;
  /** Roll: weight shifting foot to foot. */
  sway: number;
  /** Walk cycle position in radians, for the rig to swing the limbs from. */
  phase: number;
  /** 0–1, how much of a full walk this is. Fades the limb swing in and out. */
  gait: number;
  moving: boolean;
}

export interface WalkResult {
  /** Metres actually available, after the furniture had its say. */
  metres: number;
  /** Set when the room got in the way before the full distance was travelled. */
  blocked: boolean;
}

interface Step {
  kind: "move" | "turn";
  /** Metres or radians still to travel, signed. */
  remaining: number;
  /** Radians per metre, for the curved pivots. Only meaningful on a move. */
  curvature: number;
}

/** Metres per step of the walk cycle, so the bob keeps pace with the ground. */
const STRIDE = 0.32;

export class Locomotion {
  private readonly queue: Step[] = [];
  private pos = { x: 0, z: 0 };
  private heading = 0;

  private readonly drive: DriveInput = { forward: 0, turn: 0, boost: false };
  private manual = false;

  private speed = 0;
  private turnRate = 0;
  /** Advances with distance travelled, not with time, so a slow walk bobs slowly. */
  private cycle = 0;

  private readonly pose: LocomotionPose = {
    x: 0, z: 0, heading: 0, bob: 0, lean: 0, sway: 0, phase: 0, gait: 0, moving: false,
  };

  get isMoving() {
    return this.manual
      || this.queue.length > 0
      || Math.abs(this.speed) > 0.01
      || Math.abs(this.turnRate) > 0.01;
  }

  /** Where the bot is, for the floor decals to follow. */
  get position() {
    return this.pos;
  }

  /**
   * Queues a walk. Negative metres reverse; `curvature` in radians per metre
   * bends the path, which is what the pivot commands are.
   *
   * The distance is clamped here rather than as the bot walks, so the caller
   * gets a truthful answer instead of the bot quietly stopping short of what
   * it agreed to.
   */
  walk(metres: number, curvature = 0): WalkResult {
    // The cap is only a sanity bound. "Keep going until I say stop" asks for a
    // distance longer than the room, and clampTravel below trims it to whatever
    // floor is actually there, so the bot walks to the wall and halts.
    const asked = clamp(Math.abs(metres), 0, 30) * Math.sign(metres);
    const allowed = this.clampTravel(asked);
    if (Math.abs(allowed) > 0.001) {
      this.queue.push({ kind: "move", remaining: allowed, curvature });
    }
    return { metres: Math.abs(allowed), blocked: Math.abs(allowed) < Math.abs(asked) - 0.05 };
  }

  /** Queues a turn on the spot. Positive is the bot's own left. */
  turn(radians: number) {
    this.queue.push({ kind: "turn", remaining: radians, curvature: 0 });
  }

  /**
   * Hands the feet to whoever is holding a key.
   *
   * Called every frame from the render loop, so the queue stays empty for as
   * long as anything is held — not just at the moment it goes down. Clearing
   * only on the transition would leave a command queued during the drive to
   * play out afterwards, from a position and a heading it was never computed
   * for.
   */
  setDrive({ forward, turn, boost }: DriveInput) {
    this.manual = Math.abs(forward) > 0.02 || Math.abs(turn) > 0.02;
    if (this.manual) this.queue.length = 0;
    this.drive.forward = forward;
    this.drive.turn = turn;
    this.drive.boost = boost;
  }

  /** Drops everything pending; the ramp in update() does the braking. */
  stop() {
    this.queue.length = 0;
  }

  /** Walks back to the standing spot and squares up to the camera. */
  home() {
    this.queue.length = 0;
    const distance = Math.hypot(this.pos.x, this.pos.z);
    if (distance > 0.05) {
      // Turn to face the origin, walk to it, then turn back to face the camera.
      const bearing = Math.atan2(-this.pos.x, -this.pos.z);
      this.turn(wrapAngle(bearing - this.heading));
      this.queue.push({ kind: "move", remaining: distance, curvature: 0 });
      this.turn(wrapAngle(-bearing));
    } else if (Math.abs(wrapAngle(this.heading)) > 0.02) {
      this.turn(wrapAngle(-this.heading));
    }
  }

  update(dt: number): LocomotionPose {
    const step = this.manual ? undefined : this.queue[0];

    const movingStep = step?.kind === "move";
    let moveTarget = movingStep
      ? Math.sign(step.remaining) * WALK.speed * approach(step.remaining, WALK.speed, WALK.accel)
      : 0;
    let turnTarget = step?.kind === "turn"
      ? Math.sign(step.remaining) * WALK.turnSpeed * approach(step.remaining, WALK.turnSpeed, WALK.turnAccel)
      // A curved walk turns as a consequence of moving, so its rate follows the
      // ground speed instead of ramping on its own.
      : movingStep ? moveTarget * step.curvature : 0;

    if (this.manual) {
      moveTarget = this.heldSpeed();
      turnTarget = this.drive.turn * WALK.turnSpeed;
    }

    const previousSpeed = this.speed;
    this.speed = ramp(this.speed, moveTarget, WALK.accel, dt);
    this.turnRate = ramp(this.turnRate, turnTarget, WALK.turnAccel, dt);

    const travelled = this.speed * dt;
    const turned = this.turnRate * dt;

    this.heading = wrapAngle(this.heading + turned);
    this.pos.x += Math.sin(this.heading) * travelled;
    this.pos.z += Math.cos(this.heading) * travelled;
    this.confine();

    if (step) {
      const progress = step.kind === "move" ? travelled : turned;
      const before = Math.sign(step.remaining);
      step.remaining -= progress;
      // A sign flip means it overshot; either way this step is finished.
      const threshold = step.kind === "move" ? 0.02 : 0.015;
      if (Math.abs(step.remaining) < threshold || Math.sign(step.remaining) !== before) {
        this.queue.shift();
      }
    }

    // Turning on the spot covers no ground but the feet still move, so it
    // advances the cycle too.
    this.cycle += (Math.abs(travelled) + Math.abs(turned) * WALK.turnStride) / STRIDE;

    // Each footfall is one half-cycle, so the bob runs at twice the sway.
    const gait = Math.min(1, (Math.abs(this.speed) + Math.abs(this.turnRate) * WALK.turnStride) / WALK.speed);
    this.pose.bob = Math.abs(Math.sin(this.cycle * Math.PI)) * WALK.bob * gait;
    this.pose.sway = Math.sin(this.cycle * Math.PI * 0.5) * WALK.sway * gait;
    this.pose.phase = this.cycle * Math.PI;
    this.pose.gait = gait;
    // Lean comes from acceleration, not speed: upright at a steady walk, tipped
    // forward pulling away, tipped back braking.
    const accel = (this.speed - previousSpeed) / Math.max(dt, 1e-4);
    this.pose.lean = clamp(accel * WALK.lean, -0.09, 0.09);

    this.pose.x = this.pos.x;
    this.pose.z = this.pos.z;
    this.pose.heading = this.heading;
    this.pose.moving = this.isMoving;
    return this.pose;
  }

  /** Ground speed the keys are asking for, or nothing if a desk is in the way. */
  private heldSpeed(): number {
    const speed = this.drive.forward * WALK.speed * (this.drive.boost ? WALK.run : 1);
    if (Math.abs(speed) < 0.001) return 0;
    return this.inBounds(this.projected(Math.sign(speed) * WALK.clearance)) ? speed : 0;
  }

  /** How much of `metres` is available before the bot is in the furniture. */
  private clampTravel(metres: number): number {
    if (this.inBounds(this.projected(metres))) return metres;

    // Walk the request back until it fits. Cheaper than intersecting the
    // heading with the bounds box, and 5 cm is finer than the bot's footprint.
    const stride = 0.05 * Math.sign(metres);
    let best = 0;
    for (let d = stride; Math.abs(d) <= Math.abs(metres); d += stride) {
      if (!this.inBounds(this.projected(d))) break;
      best = d;
    }
    return best;
  }

  /** Where a straight walk of `metres` from here would end up. */
  private projected(metres: number) {
    return {
      x: this.pos.x + Math.sin(this.heading) * metres,
      z: this.pos.z + Math.cos(this.heading) * metres,
    };
  }

  /**
   * How far off the centre line the bot may be at this point down the room.
   * Wide in the plaza, narrow once the desk rows close in, with a short taper
   * so the bot is eased into the aisle rather than stopped dead at its mouth.
   */
  private halfWidthAt(z: number): number {
    const beyond = z > WALK.plazaTo ? z - WALK.plazaTo : z < WALK.plazaFrom ? WALK.plazaFrom - z : 0;
    if (beyond <= 0) return WALK.plazaHalfWidth;
    const t = Math.min(1, beyond / WALK.taper);
    return WALK.plazaHalfWidth + (WALK.aisleHalfWidth - WALK.plazaHalfWidth) * t;
  }

  private inBounds({ x, z }: { x: number; z: number }): boolean {
    return z <= WALK.toward && z >= -WALK.away && Math.abs(x) <= this.halfWidthAt(z);
  }

  /** Stops a curved walk from drifting into the desks mid-step. */
  private confine() {
    this.pos.z = clamp(this.pos.z, -WALK.away, WALK.toward);
    const half = this.halfWidthAt(this.pos.z);
    this.pos.x = clamp(this.pos.x, -half, half);
  }
}

/**
 * Speed limit for the tail of a step, as a fraction of full speed.
 *
 * Braking distance at full speed is v²/2a; scaling the target down once the
 * remaining distance falls inside that is what stops the bot overshooting and
 * jittering back onto the mark.
 */
function approach(remaining: number, full: number, decel: number): number {
  const left = Math.abs(remaining);
  const braking = (full * full) / (2 * decel);
  if (left >= braking) return 1;
  return Math.max(0.12, Math.sqrt(left / braking));
}

function ramp(current: number, target: number, rate: number, dt: number): number {
  const delta = target - current;
  const most = rate * dt;
  if (Math.abs(delta) <= most) return target;
  return current + Math.sign(delta) * most;
}

function wrapAngle(radians: number): number {
  let a = radians;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
