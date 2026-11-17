// Opens a visible Chrome at KPV_URL so a person can sign in by hand, then
// saves that sign-in for the stage scripts:  node scripts/guidebook/login.mjs admin
import { chromium } from "playwright-core";
import { createInterface } from "node:readline/promises";
import { BASE_URL, saveState } from "./lib.mjs";

const role = process.argv[2] || "admin";
const browser = await chromium.launch({ channel: "chrome", headless: false });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
await page.goto(`${BASE_URL}/`);
if (process.env.KPV_WAIT_FOR_LOGIN) {
  // Non-interactive: wait until the login form is gone (up to 10 minutes).
  console.log(`Sign in as ${role} in the Chrome window…`);
  await page.waitForFunction(() => !document.querySelector("#login-form") && document.querySelector("nav, header"), null, { timeout: 600000, polling: 1000 });
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`Sign in as ${role} in the Chrome window, then press Enter here… `);
  rl.close();
}
await saveState(context, role);
console.log(`saved ${role} sign-in`);
await browser.close();
