// Checks the built Lao guidebook: structure, embedded images, size, key words.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

export const OUT = join(ROOT, "ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ.html");
const SECTIONS = ["about", "roles", "login", "workflow", "checkin", "tracking", "newcase", "move", "adjust", "sku", "users", "reports", "documents", "routine", "trouble"];
const WORDS = ["ເຂົ້າວຽກ", "ປິດມື້", "ເລີ່ມນັບ", "ຕັດສະຕັອກ", "ປັບຕາມການນັບຈິງ", "ຍ້າຍ ເຂົ້າ/ອອກ", "ເປີດມື້ນີ້ຄືນ"];

const html = readFileSync(OUT, "utf8");
const fails = [];
const need = (ok, msg) => { if (!ok) fails.push(msg); };

need(/<html lang="lo">/.test(html), 'missing <html lang="lo">');
need(html.includes("<title>ຄູ່ມືນຳໃຊ້ — KPV ສະຕັອກ</title>"), "title changed");
for (const id of SECTIONS) {
  need(html.includes(`id="${id}"`), `section #${id} missing`);
  need(html.includes(`href="#${id}"`), `TOC link #${id} missing`);
}
const imgs = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((m) => m[1]).filter((s) => s !== "");
need(imgs.length > 0 && imgs.every((s) => s.startsWith("data:image/jpeg;base64,")), "every <img> must be an embedded JPEG");
const figures = [...html.matchAll(/<figure>([\s\S]*?)<\/figure>/g)].map((m) => m[1]);
need(figures.length >= 26, `only ${figures.length} figures (need ≥ 26)`);
need(figures.every((f) => /<figcaption>[^<\s][\s\S]*?<\/figcaption>/.test(f)), "a figure has an empty caption");
need(!html.includes('src="shots/'), "unbuilt shots/ reference left");
need(!/\(demo\)/.test(html), "old 'demo' note left");
for (const w of WORDS) need(html.includes(w), `word missing: ${w}`);
const mb = statSync(OUT).size / 1024 / 1024;
need(mb <= 6, `file is ${mb.toFixed(1)} MB (max 6)`);

if (fails.length) {
  console.error(`GUIDE CHECK FAILED (${fails.length}):\n- ${fails.join("\n- ")}`);
  process.exit(1);
}
console.log(`GUIDE CHECK OK — ${figures.length} figures, ${mb.toFixed(2)} MB`);
