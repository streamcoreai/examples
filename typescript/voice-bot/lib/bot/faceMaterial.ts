import { Constants } from "@babylonjs/core/Engines/constants";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

import { PALETTE, VISOR } from "./config";
import { FacePainter, type FaceExtras } from "./facePainter";
import type { FaceParams } from "./expression";

const VERTEX = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 world;
uniform mat4 worldViewProjection;
uniform mat4 invRoot;

varying vec2 vUV;
varying vec3 vLocal;

void main(void) {
  vUV = uv;
  // Bot-local space: the frame the visor box was measured in, and the one the
  // bot's idle sway is applied on top of.
  vLocal = (invRoot * (world * vec4(position, 1.0))).xyz;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

varying vec2 vUV;
varying vec3 vLocal;

uniform sampler2D albedoSampler;
uniform sampler2D faceSampler;

uniform vec3 boxMin;
uniform vec3 boxSize;
uniform vec2 feather;
uniform vec3 screenColor;
uniform float intensity;

void main(void) {
  vec3 t = (vLocal - boxMin) / boxSize;

  // z is one-sided on purpose: the back of the skull occupies the same x/y
  // span as the visor and must never be drawn on.
  if (t.z < 0.0 || t.x < -0.05 || t.x > 1.05 || t.y < -0.05 || t.y > 1.05) discard;

  vec2 edge = smoothstep(vec2(0.0), feather, t.xy) * smoothstep(vec2(0.0), feather, 1.0 - t.xy);
  float inBox = edge.x * edge.y;
  if (inBox <= 0.002) discard;

  vec3 base = texture2D(albedoSampler, vUV).rgb;
  float luma = dot(base, vec3(0.2126, 0.7152, 0.0722));
  float cyan = min(base.g, base.b) - base.r;

  // The glass is near black and the bezel around it is near white, so this
  // threshold holds whether the sampler hands back sRGB or linear values.
  float glass = 1.0 - smoothstep(0.14, 0.32, luma);
  // Only matters if the model still has its face painted on, i.e. someone
  // pointed this at the raw export instead of the prepared one.
  float painted = smoothstep(0.10, 0.24, cyan);
  float visor = max(glass, painted) * inBox;
  if (visor <= 0.004) discard;

  vec4 face = texture2D(faceSampler, vec2(t.x, 1.0 - t.y));

  // Premultiplied: alpha erases what is underneath, rgb adds the live face on
  // top. Where the face draws nothing, alpha is zero and the visor keeps its
  // own specular highlight instead of being flattened to a black rectangle.
  float cover = max(face.a, painted * inBox) * visor;
  vec3 lit = face.rgb * face.a * intensity + screenColor * max(0.0, cover - face.a);

  gl_FragColor = vec4(lit * visor, cover);
}
`;

/** Longest edge of the face canvas. The visor never covers many pixels on
 * screen, and every frame of this gets uploaded to the GPU. */
const CANVAS_WIDTH = 512;

/**
 * The canvas hands back ordinary 0–1 sRGB colours, which land somewhere around
 * mid-grey once ACES tone mapping is done with them. Pushing well past 1 is
 * what makes the visor read as a lit display rather than a printed sticker, and
 * is what gets it over the bloom threshold.
 */
const EMISSIVE_GAIN = 1.6;

/**
 * The bot's face.
 *
 * The mesh has no bones and no morph targets, so there is nothing to pose. What
 * this does instead is clone the body (sharing its geometry — no extra vertex
 * memory), and draw a canvas over the exact texels the visor occupies. The mask
 * comes from the base colour texture itself, which means it follows the curve
 * of the glass perfectly and cannot drift out of alignment.
 */
export class FaceScreen {
  private readonly painter: FacePainter;
  private readonly texture: DynamicTexture;
  private readonly material: ShaderMaterial;
  private readonly mesh: Mesh;
  private readonly root: TransformNode;
  private readonly invRoot = Matrix.Identity();

  constructor(body: Mesh, root: TransformNode, albedo: BaseTexture, scene: Scene) {
    this.root = root;

    const { min, size } = boundsInRootSpace(body, root);
    const centreX = min.x + size.x / 2;
    const boxMin = new Vector3(
      centreX - VISOR.halfWidth * size.x,
      min.y + VISOR.bottom * size.y,
      min.z + VISOR.frontFrom * size.z
    );
    const boxSize = new Vector3(
      VISOR.halfWidth * 2 * size.x,
      (VISOR.top - VISOR.bottom) * size.y,
      size.z * (1 - VISOR.frontFrom)
    );

    const height = Math.round((CANVAS_WIDTH * boxSize.y) / boxSize.x);
    this.texture = new DynamicTexture(
      "botFace",
      { width: CANVAS_WIDTH, height },
      scene,
      false,
      Texture.BILINEAR_SAMPLINGMODE
    );
    this.texture.hasAlpha = true;
    this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;

    const ctx = this.texture.getContext() as unknown as CanvasRenderingContext2D;
    this.painter = new FacePainter(ctx, CANVAS_WIDTH, height);

    this.material = new ShaderMaterial(
      "botFace",
      scene,
      { vertexSource: VERTEX, fragmentSource: FRAGMENT },
      {
        attributes: ["position", "uv"],
        uniforms: ["world", "worldViewProjection", "invRoot", "boxMin", "boxSize", "feather", "screenColor", "intensity"],
        samplers: ["albedoSampler", "faceSampler"],
        needAlphaBlending: true,
        needAlphaTesting: false,
      }
    );
    this.material.setTexture("albedoSampler", albedo);
    this.material.setTexture("faceSampler", this.texture);
    this.material.setVector3("boxMin", boxMin);
    this.material.setVector3("boxSize", boxSize);
    this.material.setColor3("screenColor", PALETTE.screen);
    this.material.setFloat("intensity", EMISSIVE_GAIN);
    this.material.setArray2("feather", [VISOR.feather, VISOR.feather * (boxSize.x / boxSize.y)]);

    this.material.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    this.material.backFaceCulling = false;
    // The clone sits on exactly the same triangles as the body, so without a
    // depth bias the two fight for every pixel.
    this.material.zOffset = -4;
    this.material.disableDepthWrite = true;

    // Shares geometry with the body; this costs a draw call, not a mesh.
    this.mesh = body.clone("botFaceScreen", body.parent, true);
    this.mesh.material = this.material;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
  }

  update(dt: number, params: FaceParams, extras: FaceExtras) {
    this.painter.draw(params, extras, dt);
    // invertY false: the shader flips v itself, so the canvas top stays the
    // top of the visor.
    this.texture.update(false);

    this.root.getWorldMatrix().invertToRef(this.invRoot);
    this.material.setMatrix("invRoot", this.invRoot);
    this.material.setFloat("intensity", Math.max(0.12, params.glow) * EMISSIVE_GAIN);
  }

  dispose() {
    this.mesh.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/** Axis-aligned bounds of `mesh` in `root`'s local frame. */
function boundsInRootSpace(mesh: Mesh, root: TransformNode) {
  const toRoot = mesh
    .computeWorldMatrix(true)
    .multiply(Matrix.Invert(root.computeWorldMatrix(true)));
  const box = mesh.getBoundingInfo().boundingBox;

  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const corner of box.vectors) {
    const p = Vector3.TransformCoordinates(corner, toRoot);
    min.minimizeInPlace(p);
    max.maximizeInPlace(p);
  }
  return { min, size: max.subtract(min) };
}
