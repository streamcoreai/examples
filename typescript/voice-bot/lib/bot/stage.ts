import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Layer } from "@babylonjs/core/Layers/layer";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { RawCubeTexture } from "@babylonjs/core/Materials/Textures/rawCubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { Scene } from "@babylonjs/core/scene";
import { Constants } from "@babylonjs/core/Engines/constants";

import { CAMERA, PALETTE } from "./config";

export type Quality = "high" | "medium" | "low";

export interface Stage {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
  pipeline: DefaultRenderingPipeline;
  /** Ring on the floor; its emissive colour is driven by the agent's voice. */
  ring: Mesh;
  ringMaterial: StandardMaterial;
  /**
   * Parent of the floor decals. The bot walks, so its contact shadow and ring
   * have to walk with it or it slides off its own shadow.
   */
  ground: TransformNode;
  quality: Quality;
  setQuality(quality: Quality): void;
  /** Re-frames the bot for the current viewport shape. */
  frame(): void;
  /**
   * Holds the shot: takes on board whatever the user has dragged or zoomed, and
   * shortens the pullback if that has put the camera through a wall.
   *
   * The camera does not chase the bot at all — not its position and not its
   * heading. It stands in the room and the bot walks around inside the frame,
   * which is what makes this a room you are watching rather than a thing you
   * are steering. Every metre of the walkable floor is in shot from here.
   */
  hold(): void;
  /**
   * Switches between the black studio and the scanned room. The stage dressing
   * and the light rig both have to move: a key light sized for a void blows the
   * bot out against a scan that carries its own baked lighting.
   */
  setRoomMode(enabled: boolean): void;
}

export function detectQuality(): Quality {
  if (typeof navigator === "undefined") return "medium";
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile || cores <= 4) return "low";
  return cores >= 8 ? "high" : "medium";
}

export function createStage(canvas: HTMLCanvasElement): Stage {
  const engine = new Engine(canvas, true, {
    antialias: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
    stencil: false,
    // Chrome throttles hard when the tab is hidden; without this the first
    // frame back can be a multi-second delta.
    doNotHandleContextLost: false,
  });

  const scene = new Scene(engine);
  // Everything downstream — the visor box, the light rig, the camera framing —
  // is expressed in glTF's own coordinates. Not flipping the scene keeps them
  // honest.
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.008, 0.012, 0.02, 1);
  scene.ambientColor = new Color3(0.08, 0.1, 0.13);
  scene.environmentTexture = createStudioEnvironment(scene);
  scene.environmentIntensity = 0.7;

  const backdrop = new Layer("backdrop", null, scene, true);
  backdrop.texture = createBackdropTexture(scene);

  const camera = new ArcRotateCamera(
    "camera",
    CAMERA.alpha,
    CAMERA.beta,
    CAMERA.radius,
    new Vector3(...CAMERA.target),
    scene
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = CAMERA.minRadius;
  camera.upperRadiusLimit = CAMERA.maxRadius;
  camera.lowerBetaLimit = CAMERA.minBeta;
  camera.upperBetaLimit = CAMERA.maxBeta;
  // Orbiting round the back would show a face-less head, so the user only ever
  // turns so far. The bot itself turns freely; the camera stays put and watches
  // it do so.
  camera.lowerAlphaLimit = camera.alpha - CAMERA.alphaRange;
  camera.upperAlphaLimit = camera.alpha + CAMERA.alphaRange;
  // The arrow keys drive the bot, so the camera does not get them.
  camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");
  camera.wheelDeltaPercentage = 0.012;
  camera.pinchDeltaPercentage = 0.012;
  camera.panningSensibility = 0;
  camera.inertia = 0.86;
  camera.minZ = 0.05;
  camera.maxZ = 40;

  const lights = lightRig(scene);
  const pool = lightPool(scene);
  const contact = floor(scene);
  const { ring, ringMaterial } = glowRing(scene);

  // The pool stays put: it is stage lighting for the void, not something the
  // bot carries around with it.
  const ground = new TransformNode("ground", scene);
  contact.setParent(ground);
  ring.setParent(ground);

  const pipeline = new DefaultRenderingPipeline("post", true, scene, [camera]);
  pipeline.fxaaEnabled = true;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.62;
  pipeline.bloomWeight = 0.72;
  pipeline.bloomKernel = 64;
  pipeline.bloomScale = 0.5;
  pipeline.imageProcessingEnabled = true;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.exposure = 1.15;
  pipeline.imageProcessing.contrast = 1.25;
  pipeline.imageProcessing.vignetteEnabled = true;
  pipeline.imageProcessing.vignetteWeight = 2.6;
  pipeline.imageProcessing.vignetteColor = new Color4(0, 0.01, 0.03, 1);
  pipeline.imageProcessing.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;

  // What the framing wants the radius to be, before the room shortens it —
  // and, once the user reaches for the wheel, whatever they left it at.
  let framedRadius = camera.radius;
  let userZoomed = false;
  // The radius follow() last wrote. Anything that has moved it since is the
  // user at the wheel, rather than the room shortening the shot.
  let appliedRadius = camera.radius;
  /** Whether there are walls to keep the camera out of. The void has none. */
  let confined = false;

  const stage: Stage = {
    engine,
    scene,
    camera,
    pipeline,
    ring,
    ringMaterial,
    ground,
    quality: "high",
    setRoomMode(enabled) {
      confined = enabled;
      // The void dressing exists to give the bot somewhere to be. In a real
      // room it is just haze on the floor.
      backdrop.isEnabled = !enabled;
      pool.setEnabled(!enabled);
      // The contact shadow earns its keep either way — more so on a bright
      // scanned floor, where a floating bot is obvious.
      contact.visibility = enabled ? 0.85 : 1;

      lights.ambient.intensity = enabled ? 0.42 : 0.68;
      // Bounce comes off whatever the floor is made of, so this tracks the
      // scan: cool grey for the blue-lit office. A warm room wants a warm fill
      // here, or the bot reads as composited in rather than standing there.
      lights.ambient.groundColor = enabled
        ? new Color3(0.16, 0.19, 0.24)
        : new Color3(0.05, 0.07, 0.12);
      lights.key.intensity = enabled ? 1.15 : 2.6;
      lights.rimCool.intensity = enabled ? 3.6 : 9;
      lights.rimWarm.intensity = enabled ? 1.8 : 5;
      scene.environmentIntensity = enabled ? 0.55 : 0.7;

      pipeline.imageProcessing.exposure = enabled ? 0.95 : 1.15;
      pipeline.imageProcessing.contrast = enabled ? 1.1 : 1.25;
      pipeline.imageProcessing.vignetteWeight = enabled ? 3.4 : 2.6;
      // Splats are already noisy; grain on top just muddies them.
      pipeline.grainEnabled = !enabled && stage.quality !== "low";
    },
    frame() {
      const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());

      // The field of view is vertical, so on an ultrawide window the horizontal
      // angle runs away — 83° at 21:9, which bends the walls of a narrow room
      // into something that reads as broken. Narrow the vertical angle to keep
      // the horizontal one civil.
      const BASE_FOV = 0.8;
      const fov = aspect > 1.8 ? Math.max(0.58, BASE_FOV * (1.8 / aspect)) : BASE_FOV;
      camera.fov = fov;

      // A narrower angle would otherwise make the bot loom, so back off by the
      // same factor and it stays the same size in frame whatever the window
      // shape. Portrait gets the opposite treatment: the vertical angle is
      // fixed, so without pulling back the bot's head leaves the screen.
      const zoom = Math.tan(BASE_FOV / 2) / Math.tan(fov / 2);
      const fit = aspect < 1 ? 1 + (1 - aspect) * 0.78 : 1;
      // ... unless the user has zoomed, in which case the radius is theirs and
      // a window resize does not get to overrule it.
      if (!userZoomed) framedRadius = Math.min(CAMERA.maxRadius, CAMERA.radius * fit * zoom);
    },
    hold() {
      const zoomed = camera.radius - appliedRadius;
      if (Math.abs(zoomed) > 0.001) {
        userZoomed = true;
        framedRadius = clamp(framedRadius + zoomed, CAMERA.minRadius, CAMERA.maxRadius);
      }
      camera.radius = confined ? fitRadius(camera, framedRadius) : framedRadius;
      appliedRadius = camera.radius;
    },
    setQuality(quality) {
      stage.quality = quality;
      const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
      // Rendering above 2× costs a lot and buys almost nothing on a scene this
      // dark and this soft.
      const cap = quality === "high" ? 2 : quality === "medium" ? 1.5 : 1;
      engine.setHardwareScalingLevel(1 / Math.min(dpr, cap));

      pipeline.bloomKernel = quality === "low" ? 32 : 64;
      pipeline.bloomScale = quality === "high" ? 0.5 : 0.35;
      pipeline.grainEnabled = quality !== "low";
      pipeline.grain.intensity = 5;
      pipeline.grain.animated = true;
      pipeline.chromaticAberrationEnabled = quality === "high";
      pipeline.chromaticAberration.aberrationAmount = 2.5;
      pipeline.samples = quality === "high" ? 4 : 1;
    },
  };

  stage.setQuality(detectQuality());
  stage.frame();
  return stage;
}

/**
 * Shortens the shot when the full pullback would put the camera through a wall.
 *
 * A game would raycast the geometry. The room here is 768k splats — nothing to
 * hit — so the test is against the room's box instead, and the camera does what
 * a game camera does at a wall: comes in closer rather than through. Never past
 * CAMERA.minRadius, which is also Babylon's own lower limit: going under it
 * would have the camera controls clamp the radius back on the next frame, and
 * hold() would read that as the user reaching for the wheel.
 */
function fitRadius(camera: ArcRotateCamera, wanted: number): number {
  // Only the horizontal component of the pullback can meet a wall.
  const spread = Math.sin(camera.beta);
  const dx = Math.cos(camera.alpha) * spread;
  const dz = Math.sin(camera.alpha) * spread;

  let radius = wanted;
  if (Math.abs(dx) > 1e-4) {
    radius = Math.min(radius, (Math.sign(dx) * CAMERA.bounds.side - camera.target.x) / dx);
  }
  if (Math.abs(dz) > 1e-4) {
    const wall = dz > 0 ? CAMERA.bounds.front : -CAMERA.bounds.back;
    radius = Math.min(radius, (wall - camera.target.z) / dz);
  }
  return clamp(radius, CAMERA.minRadius, wanted);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lightRig(scene: Scene) {
  // Soft sky/ground fill so nothing goes fully black.
  const ambient = new HemisphericLight("ambient", new Vector3(0, 1, 0), scene);
  ambient.diffuse = new Color3(0.62, 0.7, 0.85);
  ambient.groundColor = new Color3(0.05, 0.07, 0.12);
  ambient.intensity = 0.68;

  const key = new DirectionalLight("key", new Vector3(-0.45, -0.8, -0.6), scene);
  key.position = new Vector3(1.6, 2.6, 2.2);
  key.diffuse = new Color3(1, 0.98, 0.94);
  key.intensity = 2.6;

  // Two rims from behind pick the white shell off a near-black background.
  const rimCool = new PointLight("rimCool", new Vector3(-1.5, 1.5, -1.4), scene);
  rimCool.diffuse = PALETTE.glow;
  rimCool.intensity = 9;
  rimCool.radius = 0.6;

  const rimWarm = new PointLight("rimWarm", new Vector3(1.7, 1.1, -1.3), scene);
  rimWarm.diffuse = new Color3(1, 0.72, 0.5);
  rimWarm.intensity = 5;
  rimWarm.radius = 0.6;

  return { ambient, key, rimCool, rimWarm };
}

/**
 * A tiny gradient cube standing in for an HDRI.
 *
 * The bot is glossy white plastic, which looks like chalk without something to
 * reflect. Generating the environment costs 6 KB and no network request, and at
 * this size the difference from a real studio probe is not visible.
 */
function createStudioEnvironment(scene: Scene): RawCubeTexture {
  const SIZE = 32;
  const faces: Uint8Array[] = [];

  // +X, -X, +Y, -Y, +Z, -Z
  const tints: [number, number, number][] = [
    [140, 150, 166],
    [112, 136, 162],
    [196, 206, 224],
    [14, 18, 26],
    [132, 144, 164],
    [84, 102, 126],
  ];

  for (let face = 0; face < 6; face++) {
    const data = new Uint8Array(SIZE * SIZE * 4);
    const [tr, tg, tb] = tints[face];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        // Side faces fall off toward the floor; the poles stay flat.
        const vertical = face === 2 || face === 3 ? 1 : 1 - y / SIZE;
        const falloff = 0.25 + vertical * 0.85;
        const i = (y * SIZE + x) * 4;
        data[i] = Math.min(255, tr * falloff);
        data[i + 1] = Math.min(255, tg * falloff);
        data[i + 2] = Math.min(255, tb * falloff);
        data[i + 3] = 255;
      }
    }
    faces.push(data);
  }

  const texture = new RawCubeTexture(
    scene,
    faces,
    SIZE,
    Constants.TEXTUREFORMAT_RGBA,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE
  );
  texture.gammaSpace = true;
  texture.coordinatesMode = Texture.CUBIC_MODE;
  return texture;
}

function createBackdropTexture(scene: Scene): DynamicTexture {
  const SIZE = 512;
  const texture = new DynamicTexture("backdrop", { width: SIZE, height: SIZE }, scene, false);
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;

  const glow = ctx.createRadialGradient(SIZE / 2, SIZE * 0.42, 0, SIZE / 2, SIZE * 0.42, SIZE * 0.62);
  glow.addColorStop(0, "#101a26");
  glow.addColorStop(0.45, "#0a1119");
  glow.addColorStop(1, "#020407");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SIZE, SIZE);

  texture.update(false);
  return texture;
}

/**
 * A pool of light on the floor.
 *
 * Without it the contact shadow has nothing to darken — black on black — and
 * the bot reads as floating in a void rather than standing on something.
 */
function lightPool(scene: Scene): Mesh {
  const SIZE = 256;
  const texture = new DynamicTexture("pool", { width: SIZE, height: SIZE }, scene, false);
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
  const gradient = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
  gradient.addColorStop(0, "rgba(96,150,180,0.5)");
  gradient.addColorStop(0.35, "rgba(50,84,110,0.22)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SIZE, SIZE);
  texture.update(false);

  const material = new StandardMaterial("pool", scene);
  material.disableLighting = true;
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveTexture = texture;
  material.opacityTexture = texture;
  material.alphaMode = Constants.ALPHA_ADD;

  const disc = CreateDisc("pool", { radius: 2.4, tessellation: 64 }, scene);
  disc.rotation.x = Math.PI / 2;
  disc.position.y = 0.001;
  disc.scaling.z = 0.55;
  disc.isPickable = false;
  disc.alphaIndex = 0;
  disc.material = material;
  return disc;
}

/** Soft contact shadow. A real shadow map on a black floor would be invisible. */
function floor(scene: Scene): Mesh {
  const SIZE = 256;
  const texture = new DynamicTexture("contact", { width: SIZE, height: SIZE }, scene, false);
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
  const gradient = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
  gradient.addColorStop(0, "rgba(255,255,255,0.92)");
  gradient.addColorStop(0.42, "rgba(255,255,255,0.34)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SIZE, SIZE);
  texture.update(false);

  const material = new StandardMaterial("contact", scene);
  material.disableLighting = true;
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = Color3.Black();
  material.opacityTexture = texture;
  material.alphaMode = Constants.ALPHA_COMBINE;

  const disc = CreateDisc("contact", { radius: 0.52, tessellation: 48 }, scene);
  disc.rotation.x = Math.PI / 2;
  disc.position.y = 0.003;
  disc.scaling.z = 0.62;
  disc.isPickable = false;
  disc.alphaIndex = 1;
  disc.material = material;
  return disc;
}

/** Thin ring under the bot, brightening with whatever the agent is saying. */
function glowRing(scene: Scene) {
  const SIZE = 512;
  const texture = new DynamicTexture("ring", { width: SIZE, height: SIZE }, scene, false);
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE * 0.42, 0, Math.PI * 2);
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.globalAlpha = 0.16;
  ctx.lineWidth = 16;
  ctx.stroke();
  texture.update(false);

  const ringMaterial = new StandardMaterial("ring", scene);
  ringMaterial.disableLighting = true;
  ringMaterial.diffuseColor = Color3.Black();
  ringMaterial.specularColor = Color3.Black();
  ringMaterial.emissiveColor = PALETTE.glow.scale(0.45);
  ringMaterial.opacityTexture = texture;
  ringMaterial.alphaMode = Constants.ALPHA_ADD;

  const ring = CreateDisc("ring", { radius: 0.52, tessellation: 64 }, scene);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.005;
  ring.alphaIndex = 2;
  ring.scaling.z = 0.62;
  ring.isPickable = false;
  ring.material = ringMaterial;

  return { ring, ringMaterial };
}
