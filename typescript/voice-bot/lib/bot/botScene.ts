import "@babylonjs/loaders/glTF/glTFFileLoader";
import "@babylonjs/loaders/glTF/2.0";

import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";

import { applyMovementCommand, type MovementCommand } from "./movementCommand";
import type { BotGesture } from "./gesture";
import type { DriveInput } from "./driveInput";
import { MODEL_URL, PALETTE } from "./config";
import { FaceScreen } from "./faceMaterial";
import { FaceSolver, type Expression } from "./expression";
import { IdleMotion } from "./idleMotion";
import { Locomotion } from "./locomotion";
import { BotRig } from "./rig";
import { SplatRoom } from "./room";
import { createStage, type Quality, type Stage } from "./stage";

export interface BotSignals {
  expression: Expression;
  connected: boolean;
  muted: boolean;
}

export interface AudioLevels {
  /** Envelope of the user's microphone, 0–1. */
  user: number;
  /** Envelope of the agent's voice, 0–1. */
  agent: number;
}

export interface BotSceneOptions {
  canvas: HTMLCanvasElement;
  /** Read every frame rather than passed through React, which cannot re-render at 60fps. */
  levels: { current: AudioLevels };
  /**
   * Everything the agent has asked the bot to do, drained every frame. A queue
   * rather than a callback so a sentence carrying two of them ("forward, then
   * left") keeps its order no matter when React hands them over — and driving
   * and gesturing share it, because "turn left and wave" has an order too.
   */
  commands?: { current: BotAction[] };
  /**
   * The keys and the on-screen pad, read every frame like the audio levels.
   * A held key is a state, not an event, and it outranks the queue above.
   */
  drive?: { current: DriveInput };
  modelUrl?: string;
  onProgress?: (fraction: number) => void;
  onError?: (error: Error) => void;
  /** Called when the scene drops the room by itself to keep the frame rate up. */
  onRoomAuto?: (showing: boolean) => void;
}

/** One thing the agent asked for: drive the feet, or pose the arms and head. */
export type BotAction =
  | { type: "drive"; command: MovementCommand }
  | { type: "gesture"; gesture: BotGesture };

const IDLE_SIGNALS: BotSignals = { expression: "offline", connected: false, muted: false };

export class BotScene {
  private readonly stage: Stage;
  private readonly options: BotSceneOptions;
  private readonly solver = new FaceSolver();
  private readonly motion = new IdleMotion();
  private readonly locomotion = new Locomotion();
  private readonly root: TransformNode;

  private container: AssetContainer | null = null;
  private body: Mesh | null = null;
  private bodyMaterial: PBRMaterial | null = null;
  private face: FaceScreen | null = null;
  private rig: BotRig | null = null;
  private room: SplatRoom | null = null;
  private roomLoading: Promise<SplatRoom | null> | null = null;

  private signals: BotSignals = IDLE_SIGNALS;
  private pointer = { x: 0, y: 0 };
  private gaze = { x: 0, y: 0 };
  /** Long ago, so a bot nobody has touched starts out looking around. */
  private lastPointerAt = -999;
  private time = 0;
  private bootedAt = -1;
  private override: { expression: Expression; until: number } | null = null;
  private disposed = false;

  /** Seconds spent below the frame budget, used to step quality down once. */
  private struggling = 0;

  constructor(options: BotSceneOptions) {
    this.options = options;
    this.stage = createStage(options.canvas);
    this.root = new TransformNode("botRoot", this.stage.scene);
    this.stage.scene.onBeforeRenderObservable.add(() => this.tick());
    this.watchPointer();
  }

  async load() {
    const url = this.options.modelUrl ?? MODEL_URL;
    try {
      this.container = await LoadAssetContainerAsync(url, this.stage.scene, {
        onProgress: (event) => {
          if (!event.lengthComputable) return;
          this.options.onProgress?.(event.loaded / event.total);
        },
      });
    } catch (error) {
      const message =
        error instanceof Error && /404|not found/i.test(error.message)
          ? `Could not load ${url}. Run "npm run prepare:model" first.`
          : `Could not load ${url}: ${error instanceof Error ? error.message : error}`;
      this.options.onError?.(new Error(message));
      return;
    }
    if (this.disposed) return;

    this.container.addAllToScene();

    const loaderRoot = this.container.meshes.find((mesh) => mesh.name === "__root__");
    (loaderRoot ?? this.container.meshes[0])?.setParent(this.root);

    const body = this.container.meshes.find((mesh) => mesh.getTotalVertices() > 0) as Mesh | undefined;
    if (!body) {
      this.options.onError?.(new Error(`${url} contains no renderable mesh.`));
      return;
    }
    this.body = body;
    this.bodyMaterial = body.material as PBRMaterial;

    // Everything the bot glows with — ear rings, chest badge — comes from the
    // emissive mask baked by scripts/prepare-model.mjs.
    if (this.bodyMaterial) {
      this.bodyMaterial.emissiveColor = PALETTE.glow.scale(0.35);
      this.bodyMaterial.environmentIntensity = 0.85;
    }

    // The model ships unrigged, so the skeleton is built here from the mesh's
    // own proportions. Without it the bot slides around with its legs still.
    this.rig = BotRig.attach(body, this.stage.scene);
    if (!this.rig) console.warn("[voice-bot] could not rig the model; it will walk stiffly.");

    const albedo = this.bodyMaterial?.albedoTexture;
    if (albedo) {
      this.face = new FaceScreen(body, this.root, albedo, this.stage.scene);
    } else {
      this.options.onError?.(new Error("Model has no base colour texture; the face needs one to find the visor."));
    }

    this.bootedAt = this.time;
    this.stage.engine.runRenderLoop(() => this.stage.scene.render());

    // The scan is an order of magnitude bigger than the bot and nothing waits
    // on it, so it streams in behind an already-interactive scene. Low-end
    // hardware does not get it at all unless it is asked for.
    if (this.stage.quality !== "low") void this.setRoom(true);
  }

  /**
   * Shows or hides the scanned room, loading it on first use.
   * Resolves with whether the room is actually on screen afterwards.
   */
  async setRoom(enabled: boolean): Promise<boolean> {
    if (enabled && !this.room) {
      this.roomLoading ??= SplatRoom.load(this.stage.scene);
      this.room = await this.roomLoading;
      if (this.disposed) return false;
      this.room?.place();
    }
    const showing = enabled && !!this.room;
    this.room?.setEnabled(showing);
    this.stage.setRoomMode(showing);
    return showing;
  }

  setSignals(signals: BotSignals) {
    // Arriving on a call is worth a reaction.
    if (signals.connected && !this.signals.connected) this.react("surprised", 1.1);
    this.signals = signals;
  }

  /** Plays a one-off expression on top of whatever the agent state says. */
  react(expression: Expression, seconds: number) {
    this.override = { expression, until: this.time + seconds };
  }

  /**
   * Runs one locomotion command. The data channel feeds this through the
   * command queue; the dev console hook calls it directly.
   */
  drive(command: MovementCommand) {
    const reaction = applyMovementCommand(this.locomotion, command);
    if (reaction.expression) this.react(reaction.expression, reaction.seconds ?? 1);
  }

  /**
   * Poses the arms or head. Unlike driving, this holds and then releases
   * itself, so nothing has to remember to put the arms back down.
   */
  gesture({ kind, seconds }: BotGesture) {
    this.rig?.play(kind, seconds);
    // A wave without a face to go with it looks like a malfunction.
    if (kind === "wave" || kind === "raise_arms") this.react("happy", seconds);
  }

  /** Walks back to the standing spot and squares up to the camera. */
  recentre() {
    this.locomotion.home();
  }

  resize() {
    this.stage.engine.resize();
    this.stage.frame();
  }

  get fps() {
    return this.stage.engine.getFps();
  }

  get quality(): Quality {
    return this.stage.quality;
  }

  dispose() {
    this.disposed = true;
    this.stage.engine.stopRenderLoop();
    this.face?.dispose();
    this.rig?.dispose();
    this.room?.dispose();
    this.container?.dispose();
    this.stage.scene.dispose();
    this.stage.engine.dispose();
  }

  private tick() {
    const dt = Math.min(0.05, this.stage.engine.getDeltaTime() / 1000);
    this.time += dt;
    const levels = this.options.levels.current;

    this.drainCommands();

    if (this.override && this.time > this.override.until) this.override = null;
    const expression = this.resolveExpression();

    this.applyMotion(dt, levels, expression);

    const params = this.solver.update(dt, {
      expression,
      agentLevel: levels.agent,
      userLevel: levels.user,
      gaze: this.gaze,
    });

    this.face?.update(dt, params, {
      userLevel: levels.user,
      muted: this.signals.muted,
      connected: this.signals.connected,
    });

    if (this.bodyMaterial) {
      // The shell's rings and badge breathe with the agent's voice.
      const heat = 0.28 + levels.agent * 0.85 + (this.signals.connected ? 0.12 : 0);
      this.bodyMaterial.emissiveColor = tint(params.hueShift, params.alert).scale(heat * params.glow);
    }

    const ringHeat = 0.18 + levels.agent * 0.7 + levels.user * 0.12;
    this.stage.ringMaterial.emissiveColor = tint(params.hueShift, params.alert).scale(ringHeat);
    const ringScale = 1 + levels.agent * 0.06 + Math.sin(this.time * 1.3) * 0.008;
    this.stage.ring.scaling.x = ringScale;
    this.stage.ring.scaling.z = ringScale * 0.62;

    this.adaptQuality(dt);
  }

  private resolveExpression(): Expression {
    // The wake-up plays out before anything else gets a say.
    if (this.bootedAt >= 0 && this.time - this.bootedAt < 0.5) return "boot";
    if (this.override) return this.override.expression;
    if (this.signals.muted && this.signals.connected) return "muted";
    return this.signals.expression;
  }

  /** Runs whatever the agent has asked for since the last frame. */
  private drainCommands() {
    const queue = this.options.commands?.current;
    if (!queue?.length) return;
    for (const action of queue.splice(0)) {
      if (action.type === "drive") this.drive(action.command);
      else this.gesture(action.gesture);
    }
  }

  private applyMotion(dt: number, levels: AudioLevels, expression: Expression) {
    if (this.options.drive) this.locomotion.setDrive(this.options.drive.current);
    const walk = this.locomotion.update(dt);
    this.rig?.update(walk.phase, walk.gait, dt);

    // Attention goes stale: a pointer that has not moved for a few seconds is
    // no longer something the bot is being asked to look at, so it goes back to
    // looking around the room.
    const attention = this.time - this.lastPointerAt < 2.5 ? this.pointer : null;

    const pose = this.motion.update(dt, {
      attention,
      speaking: expression === "speaking",
      agentLevel: levels.agent,
    });

    // The solver damps gaze itself, so hand it the raw target.
    this.gaze.x = clamp(pose.gazeX, -1.2, 1.2);
    this.gaze.y = clamp(pose.gazeY, -1.2, 1.2);

    const boot = this.bootedAt < 0 ? 0 : Math.min(1, (this.time - this.bootedAt) / 1.1);
    // Slight overshoot on the way in so it arrives with some weight.
    const settle = boot < 1 ? 1 - Math.cos(boot * Math.PI * 1.5) * (1 - boot) * 0.14 : 1;

    // Idle fidgeting is a standing body's, so it fades out while the bot is
    // walking; leaving it in makes the walk look like a stagger.
    const stillness = walk.moving ? 0.25 : 1;

    this.root.position.set(
      walk.x + pose.x * stillness,
      pose.y * stillness + walk.bob + (1 - boot) * -0.05,
      walk.z + pose.z * stillness
    );
    this.root.rotation.set(
      pose.pitch * stillness + walk.lean,
      pose.yaw * stillness + walk.heading,
      pose.roll * stillness + walk.sway
    );
    this.root.scaling.setAll(settle * (0.9 + boot * 0.1));

    this.stage.ground.position.x = walk.x;
    this.stage.ground.position.z = walk.z;
    this.stage.hold();
  }

  private watchPointer() {
    const scene = this.stage.scene;
    scene.onPointerObservable.add((info) => {
      if (info.type === PointerEventTypes.POINTERMOVE) {
        const engine = this.stage.engine;
        const width = engine.getRenderWidth();
        const height = engine.getRenderHeight();
        // Clamped well inside ±1: a bot whose eyes hit the stops looks broken.
        this.pointer.x = clamp(((scene.pointerX / width) * 2 - 1) * 1.1, -1, 1);
        this.pointer.y = clamp(((scene.pointerY / height) * 2 - 1) * 0.9, -1, 1);
        this.lastPointerAt = this.time;
      } else if (info.type === PointerEventTypes.POINTERPICK) {
        if (info.pickInfo?.pickedMesh === this.body) this.react("happy", 1.6);
      }
    });
  }

  private adaptQuality(dt: number) {
    if (this.time < 3) return;
    const fps = this.stage.engine.getFps();
    this.struggling = fps < 40 ? this.struggling + dt : 0;
    if (this.struggling <= 2.5) return;
    this.struggling = 0;

    if (this.stage.quality !== "low") {
      this.stage.setQuality(this.stage.quality === "high" ? "medium" : "low");
      return;
    }
    // Post-processing is already as cheap as it gets, so the 768k splats are
    // what is left to give up. Better a plain stage at 60fps than a scanned
    // room at fifteen.
    if (this.room?.isEnabled) {
      void this.setRoom(false);
      this.options.onRoomAuto?.(false);
    }
  }
}

function tint(hueShift: number, alert: number): Color3 {
  const thinking = new Color3(0.66, 0.5, 1);
  const alarm = new Color3(1, 0.42, 0.28);
  return Color3.Lerp(Color3.Lerp(PALETTE.glow, thinking, hueShift), alarm, alert);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export type { Expression };
