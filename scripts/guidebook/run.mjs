// Guidebook test scenario, one step per run against the devclock demo server:
//   KPV_URL=http://localhost:8790 node scripts/guidebook/run.mjs <step>
// Steps read state first and skip work already done, so a re-run is safe.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openPhone, login, saveState, shot, settle, api, findTestDesks, BASE_URL, STATE_DIR, NAMES, TEST_BRANCH, EXPECT } from "./lib.mjs";

const plan = () => JSON.parse(readFileSync(join(STATE_DIR, "plan.json"), "utf8"));
const closingOf = (r) => r.opening_qty + r.stock_in + r.transfer_in - r.transfer_out - r.move - (r.retail_sale + r.wholesale + r.destock + (r.stock_out_single ?? 0)) + (r.move_qty ?? 0);
const pick = (r) => ({ opening: r.opening_qty, in: r.stock_in, retail: r.retail_sale, wholesale: r.wholesale, destock: r.destock, move: r.move_qty, closing: closingOf(r), counted: r.counted_qty, note: r.counted_note, destockNote: r.destock_note });
async function deskDetail(page, deskId) {
  const d = await api(page, `/stock/desk/${deskId}`);
  const rows = d.rows ?? d.ledger ?? d.lines ?? [];
  return { ...d, rows, status: d.status ?? d.day?.status ?? d.deskDay?.status ?? "not_started" };
}
const rowOf = (d, skuId) => d.rows.find((r) => r.sku_id === skuId);
async function openCase(page, deskId) {
  await page.goto(`${BASE_URL}/daily_stock/${deskId}`);
  await page.waitForSelector("#day-screen, #grid-body, #day-list", { timeout: 15000 });
  await settle(page);
}
async function setField(page, skuId, field, value) {
  const input = page.locator(`[data-sku="${skuId}"] [data-field="${field}"]`);
  await input.click();
  await input.fill(String(value));
  await input.press("Tab");
  await page.waitForTimeout(700);
}

const USER_FILE = join(STATE_DIR, "test-user.json");
const testUser = () => JSON.parse(readFileSync(USER_FILE, "utf8"));
const clock = async (days) => (await fetch(`${BASE_URL}/api/__clock${days === undefined ? "" : `?days=${days}`}`)).json();
const log = (...a) => console.log("•", ...a);

async function as(role, fn) {
  const { browser, context, page } = await openPhone(role === "admin-login" || role === "staff-login" ? "anon" : role);
  page.on("dialog", (d) => { console.log("• dialog:", d.message()); d.accept(); });
  try {
    if (role === "admin-login") {
      await login(page, "owner", "9999");
      await saveState(context, "admin");
    }
    if (role === "staff-login") {
      const u = testUser();
      await login(page, u.username, u.password);
      await saveState(context, "staff");
    }
    return await fn(page);
  } catch (e) {
    await page.screenshot({ path: join(STATE_DIR, "error.png") }).catch(() => {});
    throw e;
  } finally {
    await browser.close();
  }
}

const sheetOpen = (page, sel) => page.locator(sel).waitFor({ state: "visible", timeout: 10000 });

const steps = {
  // ---------------------------------------------------------------- Day 1 (admin)
  async users() {
    await as("admin-login", async (page) => {
      await page.goto(`${BASE_URL}/settings/users`);
      await settle(page);
      await shot(page, "04-users-list");
      const exists = (await page.content()).includes(NAMES.username);
      if (exists) return log("test user already exists");
      const password = `Guide-${Math.random().toString(36).slice(2, 8)}`;
      writeFileSync(USER_FILE, JSON.stringify({ username: NAMES.username, password }));
      await page.click("#add-user");
      await sheetOpen(page, "#user-name");
      await page.fill("#user-name", NAMES.user);
      await page.fill("#user-username", NAMES.username);
      await page.selectOption("#user-role", "staff");
      await page.selectOption("#user-branch", TEST_BRANCH);
      await page.fill("#user-password", password);
      await shot(page, "05-users-new", { rules: [{ sel: "#user-password", style: "color: transparent; text-shadow: 0 0 8px #000" }] });
      await page.click("#user-save");
      await page.waitForSelector("#user-name", { state: "detached" });
      await settle(page);
      assert.ok((await page.content()).includes(NAMES.username), "new user not in the list");
      await shot(page, "06-users-created");
    });
  },

  async sku() {
    await as("admin", async (page) => {
      await page.goto(`${BASE_URL}/settings/sku`);
      await settle(page);
      if (await page.locator("#sku-branch").count()) {
        await page.selectOption("#sku-branch", TEST_BRANCH);
        await settle(page);
      }
      await shot(page, "07-sku-list");
      const skus = await api(page, `/skus?branchId=${TEST_BRANCH}`);
      const list = skus.skus ?? skus;
      if (list.some((s) => s.name_lo === NAMES.sku)) log("test SKU already exists");
      else await createSku(page);
      const testSku = (await api(page, `/skus?branchId=${TEST_BRANCH}`)).skus.find((s) => s.name_lo === NAMES.sku);
      const toggle = page.locator(`[data-type-toggle="${testSku.type_id}"]`);
      if (await toggle.count()) await toggle.first().click();
      await page.locator(`[data-edit-sku="${testSku.sku_id}"]`).first().scrollIntoViewIfNeeded().catch(() => {});
      await shot(page, "09-sku-values");
      await page.click("#import-xlsx");
      await page.waitForSelector("#xl-export", { timeout: 10000 });
      await shot(page, "10-sku-import");
    });
  },
};

async function createSku(page) {
  {
    {
      await page.click("#add-sku");
      await sheetOpen(page, "#new-sku-name");
      await page.fill("#new-sku-name", NAMES.sku);
      const typeOpts = await page.$$eval("#new-sku-type option", (o) => o.map((x) => ({ v: x.value, t: x.textContent })));
      const weightOpts = await page.$$eval("#new-sku-weight option", (o) => o.map((x) => ({ v: x.value, t: x.textContent })));
      log("types", JSON.stringify(typeOpts), "weights", JSON.stringify(weightOpts));
      await page.selectOption("#new-sku-type", typeOpts.find((o) => o.v)?.v);
      await page.selectOption("#new-sku-weight", (weightOpts.find((o) => o.t.includes("1 ສະຫຼຶງ")) ?? weightOpts.find((o) => o.v)).v);
      if (await page.locator("#new-sku-avg").count()) await page.fill("#new-sku-avg", "1");
      if (await page.locator("#new-sku-lead").count()) await page.fill("#new-sku-lead", "3");
      await shot(page, "08-sku-new");
      await page.click("#save-sku");
      await page.waitForSelector("#new-sku-name", { state: "detached" });
      await settle(page);
      const after = await api(page, `/skus?branchId=${TEST_BRANCH}`);
      assert.ok((after.skus ?? after).some((s) => s.name_lo === NAMES.sku), "test SKU not saved");
    }
  }
}

Object.assign(steps, {
  // ---------------------------------------------------------------- Day 1 (test staff)
  async cases() {
    await as("staff-login", async (page) => {
      const have = await findTestDesks(page);
      const skus = (await api(page, `/skus?branchId=${TEST_BRANCH}`));
      const list = (skus.skus ?? skus).filter((s) => s.active !== false);
      const testSku = list.find((s) => s.name_lo === NAMES.sku);
      assert.ok(testSku, "run the sku step first");
      const reals = list.filter((s) => s.sku_id !== testSku.sku_id && (s.baht_weight ?? 0) > 0).slice(0, 2);
      const plan = { A: [[testSku, 10], [reals[0], 5], [reals[1], 5]], B: [[testSku, 4]] };
      for (const key of ["A", "B"]) {
        if (have[key]) { log(`case ${key} exists`); continue; }
        await page.goto(`${BASE_URL}/daily_stock`);
        await settle(page);
        await page.click("#new-case");
        await sheetOpen(page, "#case-name");
        await page.fill("#case-name", key === "A" ? NAMES.caseA : NAMES.caseB);
        await page.click("#case-add-sku");
        await sheetOpen(page, "#pick-search");
        for (const [s] of plan[key]) {
          await page.fill("#pick-search", s.sku_id);
          await page.click(`[data-pick-sku="${s.sku_id}"]`);
        }
        await page.click("#pick-add");
        await sheetOpen(page, "#case-name");
        for (const [s, q] of plan[key]) await page.fill(`[data-opening-row="${s.sku_id}"] [data-opening-input]`, String(q));
        if (key === "A") await shot(page, "11-case-new-form");
        await page.click("#create-case-submit");
        await page.waitForSelector("#case-name", { state: "detached", timeout: 15000 });
        await settle(page);
      }
      await page.goto(`${BASE_URL}/daily_stock`);
      await shot(page, "12-case-cards", { mask: false });
      const now = await findTestDesks(page);
      assert.ok(now.A && now.B, "both TEST cases should exist");
      writeFileSync(join(STATE_DIR, "plan.json"), JSON.stringify({ desks: now, testSku: testSku.sku_id, reals: reals.map((r) => r.sku_id) }));
    });
  },

  // Day 1 evening: count both TEST cases (count = closing) and mark them done.
  async close1() {
    await as("staff", async (page) => {
      const { desks } = plan();
      for (const key of ["A", "B"]) {
        const before = await deskDetail(page, desks[key]);
        if (before.status === "done") { log(`case ${key} already done`); continue; }
        await openCase(page, desks[key]);
        await page.click('[data-act="count-mode"]');
        for (const b of await page.$$('[data-act="match"]')) await b.click();
        await page.waitForTimeout(800);
        if (key === "A") await shot(page, "13-day1-count");
        await page.click('[data-act="close"]');
        await page.waitForTimeout(1500);
        await settle(page);
        const after = await deskDetail(page, desks[key]);
        assert.equal(after.status, "done", `case ${key} should be done`);
      }
    });
  },

  // Day 2: the test staff signs in, checks in, works the day.
  async day2() {
    const c = await clock();
    assert.equal(c.shift, 1, "move the clock first: run.mjs clock 1");
    const { desks, testSku } = plan();
    await as("anon", async (page) => {
      await page.goto(`${BASE_URL}/`);
      await page.evaluate(() => localStorage.clear());
      await page.goto(`${BASE_URL}/`);
      await settle(page);
      await shot(page, "01-login-empty");
      const u = testUser();
      await page.fill("#login-username", u.username);
      await page.fill("#login-password", u.password);
      await shot(page, "02-login-filled");
      await page.click("#login-submit");
      await page.waitForFunction(() => !document.querySelector("#login-form"), null, { timeout: 15000 });
      await settle(page);
      await shot(page, "03-after-login", { mask: false });

      // Check-in
      await page.goto(`${BASE_URL}/daily_stock`);
      await shot(page, "14-cards-not-started");
      for (const key of ["A", "B"]) {
        const d = await deskDetail(page, desks[key]);
        if (d.status && d.status !== "not_started") { log(`case ${key} already checked in (${d.status})`); continue; }
        await page.goto(`${BASE_URL}/daily_stock`);
        await settle(page);
        await page.click(`[data-action="${desks[key]}"]`);
        await page.waitForTimeout(1500);
        await settle(page);
      }
      await openCase(page, desks.A);
      await shot(page, "15-checkin-opening", { left: true });
      const openA = rowOf(await deskDetail(page, desks.A), testSku);
      assert.equal(openA.opening_qty, 10, "Day 2 opening must equal Day 1 closing");

      // Stock tracking on A
      await setField(page, testSku, "stock_in", 3);
      await setField(page, testSku, "retail_sale", 2);
      await setField(page, testSku, "wholesale", 1);
      await shot(page, "16-grid-entries", { left: true });
      // Move out of A
      await setField(page, testSku, "move_qty", -2);
      await shot(page, "17-move-out-A");
      // Destock with a reason
      await setField(page, testSku, "destock", 1);
      await page.click(`[data-sku="${testSku}"] [data-act="destock-note"]`);
      await page.fill("#destock-note", NAMES.destockReason);
      await shot(page, "19-destock-reason");
      await page.keyboard.press("Enter");
      await page.locator("#destock-note").waitFor({ state: "detached", timeout: 5000 }).catch(async () => {
        await page.getByRole("button", { name: /ບັນທຶກ|ຕົກລົງ|OK/ }).last().click();
      });
      await page.waitForTimeout(800);
      // Count: 6 found, expected 7 → variance −1 with a note
      await page.click('[data-act="count-mode"]');
      for (const b of await page.$$(`[data-sku]:not([data-sku="${testSku}"]) [data-act="match"]`)) await b.click();
      await page.fill(`[data-sku="${testSku}"] [data-count]`, "6");
      await page.keyboard.press("Tab");
      await page.waitForTimeout(800);
      await page.click(`[data-sku="${testSku}"] [data-act="note"]`);
      await page.fill("#count-note", NAMES.varianceNote);
      await page.keyboard.press("Enter");
      await page.locator("#count-note").waitFor({ state: "detached", timeout: 5000 }).catch(async () => {
        await page.getByRole("button", { name: /ບັນທຶກ|ຕົກລົງ|OK/ }).last().click();
      });
      await page.waitForTimeout(800);
      await shot(page, "20-count-variance");
      await page.click('[data-act="close"]');
      await page.waitForTimeout(1500);
      await settle(page);

      // Case B: receive the move, count, close
      await openCase(page, desks.B);
      await setField(page, testSku, "move_qty", 2);
      await shot(page, "18-move-in-B");
      await page.click('[data-act="count-mode"]');
      for (const b of await page.$$('[data-act="match"]')) await b.click();
      await page.waitForTimeout(800);
      await page.click('[data-act="close"]');
      await page.waitForTimeout(1500);
      await settle(page);

      await openCase(page, desks.A);
      await shot(page, "21-done-locked");
      const A = await deskDetail(page, desks.A);
      const B = await deskDetail(page, desks.B);
      const a = rowOf(A, testSku);
      const b = rowOf(B, testSku);
      log("A", JSON.stringify({ status: A.status, ...pick(a) }), "B", JSON.stringify({ status: B.status, ...pick(b) }));
      assert.equal(A.status, "done");
      assert.equal(B.status, "done");
      assert.equal(closingOf(a), EXPECT.A_closing);
      assert.equal(a.counted_qty, EXPECT.A_count);
      assert.equal(closingOf(b), EXPECT.B_closing);
      assert.equal(b.counted_qty, EXPECT.B_count);
    });
  },

  // Admin reopens case A's Done day, then closes it again unchanged.
  async reopen() {
    const { desks } = plan();
    await as("admin-login", async (page) => {
      await openCase(page, desks.A);
      await page.click("#day-reopen");
      await sheetOpen(page, "#reopen-reason");
      await page.fill("#reopen-reason", "TEST ກວດຄືນ");
      await shot(page, "22-reopen");
      await page.locator("#reopen-reason").locator("xpath=ancestor::*[.//button][1]").locator("button").last().click();
      await page.waitForSelector("#reopen-reason", { state: "detached", timeout: 10000 });
      await settle(page);
      const mid = await deskDetail(page, desks.A);
      assert.notEqual(mid.status, "done", "reopen should leave the day open");
      log("after reopen:", mid.status);
      await page.click('[data-act="close"]');
      await page.waitForTimeout(1500);
      await settle(page);
      const end = await deskDetail(page, desks.A);
      assert.equal(end.status, "done", "closed again");
      assert.equal(closingOf(rowOf(end, plan().testSku)), EXPECT.A_closing);
    });
  },

  async reports() {
    const { desks } = plan();
    const pickDesk = async (page) => {
      if (!(await page.locator("#desk-select").count())) return;
      await page.click("#desk-select");
      await page.locator("#sheet-host").getByText(NAMES.caseA).first().click();
      await settle(page);
    };
    await as("staff", async (page) => {
      await page.goto(`${BASE_URL}/dashboard`);
      await settle(page);
      await shot(page, "23-dashboard", { mask: false });
      await page.locator("#reorder-panel, #case-health").first().scrollIntoViewIfNeeded().catch(() => {});
      await shot(page, "24-dashboard-watch", { mask: false, scrollTo: "ຈຸດທີ່ຕ້ອງເບິ່ງ" });

      await page.goto(`${BASE_URL}/report`);
      await settle(page);
      await pickDesk(page);
      await shot(page, "25-report-summary", { mask: false, gridDay: "18" });
      await page.locator("#grid-body, #cards-view").first().scrollIntoViewIfNeeded().catch(() => {});
      await shot(page, "26-report-rows", { mask: false, scrollTo: "ລາຍລະອຽດແຕ່ລະລາຍການ" });

      await page.goto(`${BASE_URL}/daily_stock/${desks.A}?tab=history`);
      await settle(page);
      await shot(page, "27-case-history", { mask: false });

      await page.goto(`${BASE_URL}/settings/audit`);
      await settle(page);
      await shot(page, "28-audit", { mask: false });

      await page.goto(`${BASE_URL}/settings`);
      await settle(page);
      await shot(page, "30-settings-menu", { mask: false });

      await page.goto(`${BASE_URL}/documents`);
      await settle(page);
      await page.click("#new-proposal");
      await settle(page);
      if (await page.locator("#desk-pick").count()) {
        const tag = await page.locator("#desk-pick").evaluate((el) => el.tagName);
        if (tag === "SELECT") await page.selectOption("#desk-pick", desks.A);
        else { await page.click("#desk-pick"); await page.locator("#sheet-host").getByText(NAMES.caseA).first().click(); }
        await settle(page);
      }
      await shot(page, "29-proposal", { mask: false });
    });
  },

  async clock() {
    log(JSON.stringify(await clock(process.argv[3] === undefined ? undefined : Number(process.argv[3]))));
  },
});

const name = process.argv[2];
if (!steps[name]) {
  console.log(`steps: ${Object.keys(steps).join(", ")}`);
  process.exit(1);
}
await steps[name]();
console.log(`STEP ${name} OK`);
