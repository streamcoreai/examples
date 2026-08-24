/**
 * The 82 MB authoring model is not what the browser downloads. Fail early and
 * loudly rather than letting the app boot and 404 on its own asset.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prepared = resolve(root, "public/models/bot.glb");
const source = resolve(root, "models/bot.glb");

if (existsSync(prepared)) {
  const size = (statSync(prepared).size / 1024 / 1024).toFixed(1);
  const scan = resolve(root, "public/models/hightech-office.spz");
  const room = existsSync(scan)
    ? `, room scan ready (${(statSync(scan).size / 1024 / 1024).toFixed(1)} MB)`
    : " — no room scan, the bot will use the studio stage";
  console.log(`  bot.glb ready (${size} MB)${room}`);
  process.exit(0);
}

console.error(
  existsSync(source)
    ? "\n  public/models/bot.glb is missing.\n  Run:  npm run prepare:model\n"
    : "\n  models/bot.glb is missing — drop the source model there, then run:\n  npm run prepare:model\n"
);
process.exit(1);
