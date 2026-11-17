// Guidebook screenshot tooling: a phone-sized Chrome, masked screenshots and
// read-only API helpers. Used by the stage scripts in this folder.
//
//   KPV_URL          site to drive (default: local `npm run dev`)
//   KPV_GUIDE_STATE  folder for saved sign-ins (keep it outside the repo)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SHOTS_DIR = join(ROOT, "docs/guidebook/shots");
export const BASE_URL = (process.env.KPV_URL || "http://localhost:8787").replace(/\/$/, "");
export const STATE_DIR = process.env.KPV_GUIDE_STATE || join(tmpdir(), "kpv-guide-state");

export const TEST_BRANCH = "B-VT";
export const NAMES = {
  caseA: "TEST ຕູ້ A",
  caseB: "TEST ຕູ້ B",
  sku: "TEST ສິນຄ້າຄູ່ມື",
  user: "TEST ພະນັກງານຄູ່ມື",
  username: "test.guide",
  destockReason: "TEST ເສຍຫາຍ",
  varianceNote: "TEST ນັບຂາດ 1",
  docTitle: "TEST ຂໍ້ສະເໜີສັ່ງຊື້",
};
// Day 1 opening (case creation). REAL1/REAL2 are filled in once the branch's SKUs are known.
export const OPENING = { A: { TEST_SKU: 10, REAL1: 5, REAL2: 5 }, B: { TEST_SKU: 4 } };
// Day 2 on the TEST SKU: A in +3, retail 2, wholesale 1, destock 1, move −2, count 6; B move +2, count 6.
export const EXPECT = { A_closing: 7, A_count: 6, A_variance: -1, B_closing: 6, B_count: 6 };

// What mask() does. `unless`: leave the element alone when its text contains this.
export const MASK_RULES = [
  { sel: "[data-card]", unless: "TEST", style: "filter: blur(6px)" },
  { sel: "[data-pw-text]", style: "filter: blur(6px)" },
  { sel: "#mode-banner", style: "display: none !important" },
];

export async function openPhone(role = "anon") {
  mkdirSync(STATE_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: "lo-LA",
    isMobile: true,
    hasTouch: true,
    storageState: role === "anon" ? undefined : join(STATE_DIR, `${role}.json`),
  });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function saveState(context, role) {
  mkdirSync(STATE_DIR, { recursive: true });
  await context.storageState({ path: join(STATE_DIR, `${role}.json`) });
}

export async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForFunction(() => !document.querySelector(".skeleton, [data-skel-item], [aria-busy='true']"), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
}

export async function mask(page, rules = MASK_RULES) {
  return page.evaluate((rules) => {
    let n = 0;
    for (const r of rules) {
      for (const el of document.querySelectorAll(r.sel)) {
        if (r.unless && (el.textContent || "").includes(r.unless)) continue;
        el.setAttribute("style", `${el.getAttribute("style") || ""};${r.style}`);
        n++;
      }
    }
    return n;
  }, rules);
}

export async function shot(page, name, opts = {}) {
  await settle(page);
  const masked = opts.mask === false ? 0 : await mask(page, opts.rules);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const path = join(SHOTS_DIR, `${name}.jpg`);
  await page.screenshot({ path, type: "jpeg", quality: 78, fullPage: Boolean(opts.fullPage) });
  console.log(`shot ${name} (masked ${masked})`);
  return { path, masked };
}

export async function api(page, path) {
  const res = await page.request.get(`${BASE_URL}/api${path}`);
  if (!res.ok()) throw new Error(`GET ${path} → ${res.status()} ${await res.text()}`);
  return res.json();
}

export async function login(page, username, password) {
  await page.goto(`${BASE_URL}/`);
  await page.fill("#login-username", username);
  await page.fill("#login-password", password);
  await page.click("#login-submit");
  await page.waitForFunction(() => !document.querySelector("#login-form"), null, { timeout: 15000 });
  await settle(page);
}

export async function findTestDesks(page) {
  const data = await api(page, `/stock/desks?branchId=${TEST_BRANCH}`);
  const desks = data.desks ?? data.cards ?? data;
  const out = {};
  for (const d of Array.isArray(desks) ? desks : []) {
    if (d.display_name === NAMES.caseA) out.A = d.desk_id;
    if (d.display_name === NAMES.caseB) out.B = d.desk_id;
  }
  return out;
}
