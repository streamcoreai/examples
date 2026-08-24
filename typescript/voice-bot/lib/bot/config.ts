import { Color3 } from "@babylonjs/core/Maths/math.color";
import visor from "./visor.json";

/**
 * Where the visor sits, as fractions of the bot's own bounding box.
 *
 * Measured off the source mesh rather than eyeballed: the screen is the dark
 * region spanning x ±0.235, y 0.72–1.045, z > 0.08 on a model that is
 * 0.634 × 1.086 × 0.458. Fractions rather than absolute metres so a re-export
 * at a different scale still lands on the visor. Shared with
 * scripts/prepare-model.mjs, which uses the same box to scrub the painted-on
 * face out of the texture.
 */
export const VISOR = visor;

export const PALETTE = {
  /** The cyan the model is already painted with — everything matches it. */
  glow: new Color3(0.35, 0.92, 1.0),
  glowHex: "#22dcff",
  glowCoreHex: "#d8fbff",
  thinkingHex: "#c09eff",
  alertHex: "#ff7a5c",
  /** What the visor glass is reset to underneath the drawn face. */
  screen: new Color3(0.012, 0.018, 0.026),
} as const;

export const CAMERA = {
  /** Framed on the standing spot, at chest height. */
  target: [0, 0.56, 0] as const,
  /**
   * How far back the camera stands, world units.
   *
   * Nearly as far as the room allows. The open corridor on the camera's side
   * of the bot runs 6.9, but the last of it is the near desk row: past about
   * 5.5 the camera is standing among those desks, and splats a metre from the
   * lens are white smears across the bottom of the frame rather than furniture.
   *
   * From here the bot is a robot standing down an office rather than a portrait
   * with a room behind it, and the whole of the plaza it walks around in is in
   * shot. Scrolling still zooms in for a closer look at the face.
   */
  radius: 5.2,
  minRadius: 1.4,
  maxRadius: 7.0,
  alpha: Math.PI / 2,
  /**
   * Straight down the corridor from 2.05 m up — a head higher than standing,
   * which is what drops the near desk row out of the bottom of the frame. At
   * eye level those desks are dead ahead and the shot is looking through them.
   */
  beta: 1.28,
  /**
   * How far up and down a drag may take the camera. A small window either side
   * of `beta`, which in camera height is 2.8 m down to 1.45 m: a mild high
   * angle at one end, standing height at the other.
   *
   * The old limits ran past π/2, and past π/2 the camera is *below* what it is
   * aiming at — 0.3 m up, on the floor, looking along the aisle through the
   * near desks. Those desks are the worst splats in the scan and the framing
   * has nothing else going for it, so that shot is no longer reachable. Same
   * reasoning at the top of the range: much higher and the room reads as a
   * floor plan with a hat on it.
   */
  minBeta: 1.12,
  maxBeta: 1.4,
  /**
   * How far round the user may drag, radians. Narrow: the further back the
   * camera stands, the more ground a given angle covers sideways, and this
   * room is a corridor about 5 across. At 0.28 the camera swings 1.4 either
   * way, which is the aisle and no further.
   */
  alphaRange: 0.28,
  /**
   * The box the camera has to stay inside, world units.
   *
   * The camera does not move on its own, so this only has the user's drag and
   * zoom to catch — but the room is narrow enough, and the camera far enough
   * back, that a drag to the stops gets there on its own.
   *
   * Wider than the walkable floor, because the walls are further out than the
   * furniture: the camera may hang over a desk, it just may not hang through a
   * wall. This is the open floor measured around the standing spot (6.9 world
   * units toward the near end, 11.2 away, about 3 across) with a margin off.
   * Splats are unstructured points with nothing to raycast against, so the shot
   * is pulled in against this box rather than stopped by a collider.
   */
  bounds: { side: 2.8, front: 6.2, back: 9.0 },
} as const;

export const MODEL_URL = "/models/bot.glb";

/**
 * The scanned room, as Gaussian splats. Placement is measured rather than
 * guessed — see the comment on ROOM.scale.
 */
export const ROOM = {
  url: "/models/hightech-office.spz",
  scale: 1.25,
  /**
   * The scan is Z-up, not Y-up: projecting the cloud along Z gives the floor
   * plan, with the floor a slab at z ≈ -1.55 and the ceiling at z ≈ +2.6.
   * Assuming Y-up here is what once stood the bot on a wall.
   *
   * This is the floor plane, least-squares fitted over 116k splats in that
   * slab (interior only, walls excluded). It leans 2.8° off +Z, normal for a
   * handheld scan and obvious once a perfectly vertical bot stands on it, so
   * place() rotates the whole scan to bring this normal onto +Y.
   */
  floorNormal: [0.0075, 0.0478, 0.9988] as const,
  /**
   * Where the bot stands: a point on the fitted floor, in scan coordinates.
   * Scored from a 25 cm occupancy grid of everything 0.25–2.2 units above the
   * floor. This cell has 1.25 units of clear radius, 5.5 units of open
   * corridor on the side the camera pulls back into, and 9 behind the bot for
   * a backdrop with some depth. The desk rows flank it either side.
   */
  stand: [0, 0, -1.548] as const,
  /**
   * Quarter turn so the corridor's long axis (scan +X) runs away from the
   * camera. Without it the camera's pullback lands outside a side wall; the
   * room is only about 5 units across.
   */
  rotationY: Math.PI / 2,
} as const;

/**
 * How the bot moves when it is told to.
 *
 * These have to be read against the size of a single command: the model's
 * default `movement.forward` is 1500 ms at 80%, which is 0.74 m. Anything close to
 * that is not a boundary, it is a wall the bot reaches on its first or second
 * step — after which every further "come closer" moves it nothing at all and
 * the bot looks broken rather than penned in. Keep at least three commands of
 * room in every direction.
 *
 * The camera stands still while all this happens, so these are also how far the
 * bot may get from the middle of the shot. That is survivable because the
 * camera is 6 back and the plaza is 4.8 across: the bot stays in frame at every
 * corner of it. What limits them is the floor — the occupancy grid that picked
 * the standing spot found 1.25 scan units of clear radius across the aisle.
 */
export const WALK = {
  /**
   * The walkable floor is not a box, and treating it as one is what made the
   * bot look penned in. Around the standing spot the desk rows open out into a
   * plaza 5.3 across; beyond it, in both directions, the floor pinches to a
   * single-file aisle about 1.5 wide that runs most of the length of the room.
   *
   * Measured off the same occupancy grid as ROOM.stand, but by taking the
   * widest clear span at each step along the corridor rather than a ray down
   * the centre line. A ray threads between the desks and reports the aisle as
   * wide as the plaza, which walks the bot straight through the furniture.
   *
   * World units throughout: the grid is in scan units, so these are the
   * measurements already multiplied by ROOM.scale.
   */
  plazaHalfWidth: 2.4,
  plazaFrom: -1.0,
  plazaTo: 2.5,
  /** The gap between the desk rows past the plaza. */
  aisleHalfWidth: 0.45,
  /** How abruptly the plaza pinches into the aisle. */
  taper: 0.8,
  /** How far the aisle runs before it is not worth walking any further. */
  toward: 4.0,
  away: 7.5,
  /** Metres per "move forward" when the request does not say how far. */
  stepMetres: 0.6,
  /** Degrees per "turn left" when the request does not say how far. */
  turnDegrees: 90,
  /** Metres per second at a full walk. */
  speed: 0.62,
  accel: 2.2,
  /** What a held run modifier multiplies that by. */
  run: 1.7,
  /**
   * How far ahead a held key looks for furniture.
   *
   * A commanded step is trimmed to the available floor before it starts, so it
   * never reaches the desks. A key can be held into them for as long as the
   * user likes, and clamping the position alone leaves the bot walking on the
   * spot against a desk rather than stopping at it.
   */
  clearance: 0.25,
  /** Radians per second turning on the spot. */
  turnSpeed: 1.9,
  turnAccel: 2.6,
  /** Radians per metre on the curved pivots, so they read as an arc not a turn. */
  pivotCurvature: 1.4,
  /** Height of the step bounce, world units. */
  bob: 0.022,
  /** Roll amplitude as weight goes foot to foot. */
  sway: 0.035,
  /** Seconds of lean per metre/second² of acceleration. */
  lean: 0.02,
  /**
   * How much a turn on the spot counts toward the walk cycle, as a fraction of
   * a metre per radian. Without it the bot pirouettes with its feet welded
   * together.
   */
  turnStride: 0.16,
} as const;

/**
 * Where the limbs are, as fractions of the bot's own bounding box — height
 * from the floor, and distance across from the centre line where 1 is the
 * widest point.
 *
 * Measured off the mesh rather than eyeballed. Sliced by height, the legs run
 * up the middle out to about 0.62 across, and the hands hang *outside* them
 * from 0.17 up, with a clear gap between the two at 0.55–0.64. That overlap is
 * why the leg weights are gated on width as well as height: everything below
 * the hip is emphatically not leg.
 */
export const RIG = {
  /** The hip line. Leg weighting fades out over `legBlend` below it. */
  legTop: 0.27,
  legBlend: 0.09,
  /** Legs stay inside this; past it at the same height are the hands. */
  legSide: 0.62,
  /** Arms start outside this. */
  armSide: 0.62,
  /** Fingertips, and the shoulder the arm pivots from. */
  armBottom: 0.17,
  shoulder: 0.58,
  armBlend: 0.08,
  /** Softens both side gates, so the mesh does not tear along them. */
  sideBlend: 0.1,
  /** Where the hips and shoulders sit across the body. */
  hipSide: 0.3,
  shoulderSide: 0.72,
  /** The ankle line, below which the mesh is sole rather than shin. */
  footTop: 0.13,
  footBlend: 0.04,
  /** How much of the hip's swing the ankle gives back to keep the sole level. */
  ankleKeep: 0.65,
  /** Peak swing, radians. Stubby legs need less than a human gait suggests. */
  legSwing: 0.5,
  armSwing: 0.32,
  /**
   * The neck, and the band the head weighting ramps across. Sliced by height
   * the bot is narrowest at 0.58–0.63 and flares straight back out above it,
   * which is the join. Head weighting is not gated on width, unlike the arms:
   * the head is the widest part of the bot, so gating it would drop its own
   * sides back onto the body.
   */
  neck: 0.6,
  headFrom: 0.57,
  headTo: 0.66,
  /**
   * Gestures, in radians. Arms hang straight down at rest, so lifting one is a
   * large rotation about the same axis the walk swing uses, and abduction takes
   * it out sideways from the chest.
   */
  gesture: {
    /** How long a gesture takes to take over from the walk, and to give it back. */
    easeIn: 0.22,
    easeOut: 0.35,
    /**
     * Arms up. Abduction rather than swing: swinging them up forwards takes
     * them straight through the head, because the arms are nearly as long as
     * the gap between shoulder and crown on a bot built like this one.
     */
    raise: 1.95,
    waveAbduct: 1.75,
    waveSwing: 0.35,
    waveHz: 2.2,
    /** Pointing is mostly sideways, with a little lift so it clears the hip. */
    pointSwing: 0.55,
    pointAbduct: 1.15,
    lookYaw: 0.62,
    lookPitch: 0.38,
    nod: 0.3,
    nodHz: 1.5,
    shake: 0.45,
    shakeHz: 1.9,
    /**
     * Looking around: a wide, slow sweep, deliberately far from the head
     * shake's frequency so the two do not read as the same gesture at
     * different speeds. One full cycle takes about 3.6s, which is why the
     * gesture defaults to a longer hold than the beat-based ones.
     */
    sweep: 0.75,
    sweepHz: 0.28,
    sweepPitch: 0.13,
    sweepPitchHz: 0.19,
  },
} as const;
