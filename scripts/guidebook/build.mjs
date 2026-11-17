// Builds the single-file Lao guidebook: docs/guidebook/head.html (fonts + style)
// + docs/guidebook/guide.src.html (body), with every shots/NAME.jpg inlined.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";
import { OUT_PATH } from "./paths.mjs";

const dir = join(ROOT, "docs/guidebook");
const head = readFileSync(join(dir, "head.html"), "utf8");
const body = readFileSync(join(dir, "guide.src.html"), "utf8");
const missing = [];
const built = body.replace(/src="shots\/([\w.-]+\.jpg)"/g, (_, name) => {
  const file = join(dir, "shots", name);
  if (!existsSync(file)) { missing.push(name); return _; }
  return `src="data:image/jpeg;base64,${readFileSync(file).toString("base64")}"`;
});
if (missing.length) {
  console.error(`missing screenshots: ${missing.join(", ")}`);
  process.exit(1);
}
writeFileSync(OUT_PATH, `${head}\n${built}`);
console.log(`built ${OUT_PATH}`);
