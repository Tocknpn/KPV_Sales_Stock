// Self-test for lib.mjs against the local demo (`npm run dev`, no .dev.vars).
import assert from "node:assert/strict";
import { statSync, unlinkSync } from "node:fs";
import { openPhone, login, saveState, shot, BASE_URL } from "./lib.mjs";

assert.match(BASE_URL, /localhost|127\.0\.0\.1/, "selftest only runs against the local demo");
const { browser, context, page } = await openPhone("anon");
try {
  await login(page, "owner", "9999");
  await saveState(context, "selftest");
  await page.goto(`${BASE_URL}/daily_stock`);
  const a = await shot(page, "_selftest");
  assert.ok(statSync(a.path).size > 20000, "screenshot is too small");
  assert.ok(a.masked > 0, "demo case cards should be masked");
  await page.reload();
  const b = await shot(page, "_selftest_nomask", { mask: false });
  assert.equal(b.masked, 0);
  if (!process.env.KEEP) { unlinkSync(a.path); unlinkSync(b.path); }
  console.log("SELFTEST OK");
} finally {
  await browser.close();
}
