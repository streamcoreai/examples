/**
 * Turns the authoring GLB in models/ into something a browser can actually
 * download: 82 MB of 4K PNGs and 1.5M triangles becomes a few MB.
 *
 * Three passes, in this order for a reason:
 *   1. weld + simplify   — most of the size is the index buffer, so this first.
 *   2. texture compress  — WebP at 2K; the bot has no fine surface detail that
 *                          survives 4K anyway.
 *   3. quantize          — KHR_mesh_quantization, which Babylon reads natively.
 *                          Deliberately not meshopt/Draco: those need a decoder
 *                          shipped and wired up, and buy little once quantized.
 *
 * It also derives an emissive mask from the base colour texture by isolating the
 * cyan of the eyes, ear rings and chest badge, so those parts can be driven by
 * the agent's voice at runtime instead of being flat paint.
 *
 *   npm run prepare:model -- --ratio 0.1 --texture 2048
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup,
  prune,
  quantize,
  simplify,
  textureCompress,
  weld,
} from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const VISOR = JSON.parse(readFileSync(new URL("../lib/bot/visor.json", import.meta.url), "utf8"));

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const SOURCE = resolve(root, arg("in", "models/bot.glb"));
const TARGET = resolve(root, arg("out", "public/models/bot.glb"));
const RATIO = Number(arg("ratio", "0.1"));
const TEXTURE_SIZE = Number(arg("texture", "2048"));
const MASK_SIZE = Number(arg("mask", "1024"));

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

if (!existsSync(SOURCE)) {
  console.error(`\n  Source model not found: ${SOURCE}\n`);
  process.exit(1);
}

/**
 * The glowing parts of the bot are painted into the base colour texture as
 * saturated cyan. Isolating them by hue gives an emissive map for free, with no
 * second authoring pass on the model.
 */
async function buildEmissiveMask(imageBytes) {
  const { data, info } = await sharp(imageBytes)
    .resize(MASK_SIZE, MASK_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const mask = Buffer.alloc(info.width * info.height, 0);
  let lit = 0;
  for (let i = 0, p = 0; i < data.length; i += 3, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Cyan reads as "both greens above red". The -30 floor keeps the bot's warm
    // white shell (where the channels sit close together) out of the mask.
    const cyan = Math.min(g, b) - r - 30;
    if (cyan <= 0) continue;
    const v = Math.min(1, cyan / 60) * Math.min(1, Math.max(g, b) / 140);
    mask[p] = Math.round(v * 255);
    if (mask[p] > 8) lit++;
  }

  console.log(
    `  emissive mask: ${((lit / (info.width * info.height)) * 100).toFixed(2)}% of texels lit`
  );

  return sharp(mask, {
    raw: { width: info.width, height: info.height, channels: 1 },
  })
    .toColorspace("srgb")
    .webp({ quality: 90, effort: 6 })
    .toBuffer();
}

/**
 * Scrubs the face that is painted into the base colour texture.
 *
 * The model ships with its eyes and smile baked in as cyan pixels, which would
 * sit underneath anything we draw at runtime. Rather than cover them with
 * geometry, find every texel belonging to a triangle inside the visor box and
 * flatten it back to the glass colour — but only where that texel is currently
 * dark or cyan, so the white bezel around the screen survives a box that is a
 * touch too generous.
 */
async function cleanVisor(document) {
  const material = document.getRoot().listMaterials()[0];
  const baseColor = material?.getBaseColorTexture();
  if (!baseColor) return;

  const node = document
    .getRoot()
    .listNodes()
    .find((n) => n.getMesh());
  const prim = node?.getMesh()?.listPrimitives()[0];
  if (!prim) return;

  const position = prim.getAttribute("POSITION");
  const texcoord = prim.getAttribute("TEXCOORD_0");
  const indices = prim.getIndices();
  if (!position || !texcoord || !indices) return;

  const m = node.getWorldMatrix();
  const scratch = [0, 0, 0];
  const toWorld = (i) => {
    const [px, py, pz] = position.getElement(i, scratch);
    return [
      m[0] * px + m[4] * py + m[8] * pz + m[12],
      m[1] * px + m[5] * py + m[9] * pz + m[13],
      m[2] * px + m[6] * py + m[10] * pz + m[14],
    ];
  };

  const count = position.getCount();
  const world = new Float32Array(count * 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const p = toWorld(i);
    world[i * 3] = p[0];
    world[i * 3 + 1] = p[1];
    world[i * 3 + 2] = p[2];
    for (let a = 0; a < 3; a++) {
      if (p[a] < min[a]) min[a] = p[a];
      if (p[a] > max[a]) max[a] = p[a];
    }
  }

  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const cx = (min[0] + max[0]) / 2;
  const box = {
    x0: cx - VISOR.halfWidth * size[0],
    x1: cx + VISOR.halfWidth * size[0],
    y0: min[1] + VISOR.bottom * size[1],
    y1: min[1] + VISOR.top * size[1],
    z0: min[2] + VISOR.frontFrom * size[2],
  };

  const inBox = (i) => {
    const x = world[i * 3];
    const y = world[i * 3 + 1];
    const z = world[i * 3 + 2];
    return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0;
  };

  const image = baseColor.getImage();
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const mask = new Uint8Array(width * height);

  const uv = (i) => texcoord.getElement(i, [0, 0]);
  let triangles = 0;
  for (let t = 0; t < indices.getCount(); t += 3) {
    const a = indices.getScalar(t);
    const b = indices.getScalar(t + 1);
    const c = indices.getScalar(t + 2);
    if (!inBox(a) || !inBox(b) || !inBox(c)) continue;
    triangles++;
    rasteriseUV(mask, width, height, uv(a), uv(b), uv(c));
  }

  if (!triangles) {
    console.warn("  visor box matched no triangles — texture left untouched");
    return;
  }

  dilate(mask, width, height, 3);

  // The glass colour is whatever the darkest half of the visor already is.
  const darks = [];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 3;
    const luma = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
    if (luma < 0.2) darks.push(i);
  }
  if (!darks.length) {
    console.warn("  visor box found no dark texels — texture left untouched");
    return;
  }
  const glass = [0, 1, 2].map((c) => {
    const values = darks.map((i) => data[i + c]).sort((x, y) => x - y);
    return values[values.length >> 1];
  });

  let painted = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 3;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
    const cyan = Math.min(g, b) - r;
    // Leave the bezel alone; only glass and the cyan painted onto it.
    if (luma > 0.34 && cyan < 25) continue;
    data[i] = glass[0];
    data[i + 1] = glass[1];
    data[i + 2] = glass[2];
    painted++;
  }

  baseColor.setImage(
    await sharp(data, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer()
  );
  baseColor.setMimeType("image/png");

  console.log(
    `  visor: cleared painted face from ${triangles.toLocaleString()} triangles ` +
      `(${painted.toLocaleString()} texels → rgb(${glass.join(", ")}))`
  );
}

function rasteriseUV(mask, width, height, a, b, c) {
  const ax = a[0] * width;
  const ay = a[1] * height;
  const bx = b[0] * width;
  const by = b[1] * height;
  const cx = c[0] * width;
  const cy = c[1] * height;

  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1);
  const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)) + 1);
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)) - 1);
  const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)) + 1);

  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (area === 0) return;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
      const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
      const w2 = 1 - w0 - w1;
      // A small negative tolerance closes the cracks between adjacent texels.
      if (w0 < -0.04 || w1 < -0.04 || w2 < -0.04) continue;
      mask[y * width + x] = 1;
    }
  }
}

/** Grows the mask so UV seams and bilinear filtering do not leak old pixels back in. */
function dilate(mask, width, height, radius) {
  for (let pass = 0; pass < radius; pass++) {
    const previous = mask.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (previous[y * width + x]) continue;
        const left = x > 0 && previous[y * width + x - 1];
        const right = x < width - 1 && previous[y * width + x + 1];
        const up = y > 0 && previous[(y - 1) * width + x];
        const down = y < height - 1 && previous[(y + 1) * width + x];
        if (left || right || up || down) mask[y * width + x] = 1;
      }
    }
  }
}

/**
 * Gaussian splat scans are already compressed and there is nothing useful to do
 * to them offline, but they still have to live under public/ for Next to serve
 * them. Copy rather than ask people to remember.
 */
function copyScans() {
  const source = dirname(SOURCE);
  const target = dirname(TARGET);
  const scans = readdirSync(source).filter((name) => /\.(spz|ply)$/i.test(name));
  for (const name of scans) {
    // The .ply that comes out of a scanning app alongside the splats is the
    // collider mesh, not splats — nothing here renders it.
    if (name.toLowerCase().endsWith(".ply")) continue;
    const to = resolve(target, name);
    copyFileSync(resolve(source, name), to);
    console.log(`  scan: ${name} → public/models/ (${mb(statSync(to).size)})`);
  }
}

function countTriangles(document) {
  let tris = 0;
  let verts = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      tris += (indices ? indices.getCount() : prim.getAttribute("POSITION").getCount()) / 3;
      verts += prim.getAttribute("POSITION").getCount();
    }
  }
  return { tris, verts };
}

async function main() {
  const before = statSync(SOURCE).size;
  console.log(`\n  bot.glb  ${mb(before)}  →  optimising\n`);

  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(SOURCE);

  const source = countTriangles(document);
  console.log(`  source: ${source.tris.toLocaleString()} tris, ${source.verts.toLocaleString()} verts`);

  await document.transform(
    dedup(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: RATIO, error: 0.0015 })
  );

  const simplified = countTriangles(document);
  console.log(
    `  simplified: ${simplified.tris.toLocaleString()} tris ` +
      `(${((simplified.tris / source.tris) * 100).toFixed(1)}%), ` +
      `${simplified.verts.toLocaleString()} verts` +
      (simplified.verts <= 65535 ? " — fits 16-bit indices" : "")
  );

  await cleanVisor(document);

  await document.transform(
    textureCompress({
      encoder: sharp,
      targetFormat: "webp",
      resize: [TEXTURE_SIZE, TEXTURE_SIZE],
      quality: 88,
      effort: 80,
    })
  );

  const material = document.getRoot().listMaterials()[0];
  const baseColor = material?.getBaseColorTexture();
  if (baseColor) {
    const emissive = document
      .createTexture("bot_emissive")
      .setImage(await buildEmissiveMask(baseColor.getImage()))
      .setMimeType("image/webp");
    material.setEmissiveTexture(emissive);
    material.setEmissiveFactor([1, 1, 1]);
  } else {
    console.warn("  no base colour texture — skipping emissive mask");
  }

  // Quantization goes last: everything above assumes float attributes.
  await document.transform(
    quantize({
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
      quantizationVolume: "mesh",
    }),
    prune()
  );

  mkdirSync(dirname(TARGET), { recursive: true });
  await io.write(TARGET, document);

  copyScans();

  const after = statSync(TARGET).size;
  console.log(
    `\n  ${TARGET.replace(root + "/", "")}  ${mb(after)}  ` +
      `(${(before / after).toFixed(1)}× smaller)\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
