import "@babylonjs/loaders/SPLAT";

import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";

import { ROOM } from "./config";

/**
 * The scanned room the bot stands in, as Gaussian splats.
 *
 * The file is SPZ v3 wrapped in gzip, which Babylon's built-in parser reads
 * without the WASM module it would otherwise fetch from unpkg — worth keeping
 * that way, since nothing else here depends on a CDN at runtime.
 *
 * Splats carry their own baked lighting and take no part in the scene's, so the
 * job here is only to place the scan: floor on the floor, roughly centred, at a
 * scale where the bot looks like it belongs in the room rather than towering
 * over it.
 */
export class SplatRoom {
  private constructor(
    private readonly container: AssetContainer,
    readonly root: TransformNode,
    readonly mesh: AbstractMesh
  ) {}

  static async load(
    scene: Scene,
    onProgress?: (fraction: number) => void
  ): Promise<SplatRoom | null> {
    let container: AssetContainer;
    try {
      container = await LoadAssetContainerAsync(ROOM.url, scene, {
        onProgress: (event) => {
          if (event.lengthComputable) onProgress?.(event.loaded / event.total);
        },
        pluginOptions: {
          splat: {
            // Force the built-in parser. The default reaches for @adobe/spz on
            // unpkg, which this file does not need.
            spzLibraryUrl: undefined,
            /**
             * Despite the name, this means "leave the data alone". With it
             * off — the default — the loader applies `scaling.y *= -1`,
             * because splats trained the usual way come out Y-down. This scan
             * is Z-up, so on it a Y flip is a mirror across the corridor, and
             * place() handles the orientation anyway.
             */
            flipY: true,
            /** The camera is framed on the bot here, not on the scan. */
            disableAutoCameraLimits: true,
          },
        },
      });
    } catch (error) {
      console.warn("[voice-bot] room scan unavailable:", error);
      return null;
    }

    const mesh = container.meshes.find((m) => m.getTotalVertices() > 0 || m.name !== "__root__");
    if (!mesh) {
      console.warn("[voice-bot] room scan contained no splats");
      return null;
    }

    container.addAllToScene();

    // Splats are unstructured point data; picking through 768k of them costs a
    // lot and can hit nothing useful.
    for (const m of container.meshes) m.isPickable = false;

    const root = new TransformNode("roomRoot", scene);
    const loaderRoot = container.meshes.find((m) => m.name === "__root__") ?? mesh;
    loaderRoot.setParent(root);

    return new SplatRoom(container, root, mesh);
  }

  /** Bounding box of the scan in world units, for placing it. */
  describe() {
    this.mesh.computeWorldMatrix(true);
    this.mesh.refreshBoundingInfo({});
    const info = this.mesh.getBoundingInfo().boundingBox;
    return {
      min: info.minimumWorld.asArray().map((v) => Number(v.toFixed(3))),
      max: info.maximumWorld.asArray().map((v) => Number(v.toFixed(3))),
      size: info.maximumWorld.subtract(info.minimumWorld).asArray().map((v) => Number(v.toFixed(3))),
      splats: this.mesh.getTotalVertices(),
    };
  }

  /**
   * Puts the scan under the bot: levelled, turned, scaled, and translated so
   * the chosen standing spot on its floor sits at the world origin.
   *
   * Built as an explicit matrix and decomposed rather than assigned as
   * scaling/rotation/position separately — the order these compose in is
   * exactly the sort of thing that silently plants a bot inside a desk.
   */
  place() {
    const level = new Quaternion();
    Quaternion.FromUnitVectorsToRef(
      new Vector3(...ROOM.floorNormal).normalize(),
      Vector3.Up(),
      level
    );

    const oriented = Matrix.Scaling(ROOM.scale, ROOM.scale, ROOM.scale)
      .multiply(Matrix.FromQuaternionToRef(level, new Matrix()))
      .multiply(Matrix.RotationY(ROOM.rotationY));

    const stand = Vector3.TransformCoordinates(new Vector3(...ROOM.stand), oriented);
    const placed = oriented.multiply(Matrix.Translation(-stand.x, -stand.y, -stand.z));

    this.root.rotationQuaternion ??= new Quaternion();
    placed.decompose(this.root.scaling, this.root.rotationQuaternion, this.root.position);
  }

  private enabled = true;

  get isEnabled() {
    return this.enabled;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.root.setEnabled(enabled);
  }

  dispose() {
    this.container.dispose();
    this.root.dispose();
  }
}
