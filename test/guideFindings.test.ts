// The four problems the 2026-11-17 guidebook test run found
// (docs/guidebook/2026-11-17-live-test-run.md, "Bugs and surprises").
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain browser ES module without types
import { t } from "../public/js/i18n.js";
// @ts-expect-error plain browser ES module without types
import { auditValue, changedKeys } from "../public/js/audit-value.js";
// @ts-expect-error plain browser ES module without types
import { state } from "../public/js/state.js";
// @ts-expect-error plain browser ES module without types
import { profileCardHtml } from "../public/js/views/settings/profile.js";
import { freshApp, call, asStaff, YESTERDAY } from "./helpers";

describe("1. close-day wording", () => {
  it("the reopen warning names the button people actually press", () => {
    expect(t("stock.reopenWarning")).toContain("ປິດມື້");
    expect(t("stock.reopenWarning")).not.toContain("ຢືນຢັນວ່າແລ້ວ");
  });

  it("the toast after closing a day uses the same words as the button", () => {
    expect(t("stock.finalClosingSubmitted")).toContain("ປິດມື້");
    expect(t("stock.finalClosingSubmitted")).not.toContain("ຢືນຢັນວ່າແລ້ວ");
  });
});

describe("2. audit values in words", () => {
  it("translates a day status", () => {
    expect(auditValue("status", "check_in")).toBe("ເຂົ້າວຽກ");
    expect(auditValue("status", "done")).toBe("✓ ແລ້ວ");
    expect(auditValue("status", "final_stock")).toBe("ກວດສະຕັອກສຸດທ້າຍ");
    expect(auditValue("status", "not_started")).toBe("ຍັງບໍ່ເລີ່ມ");
  });

  it("shows a timestamp as Laos DD/MM HH:mm", () => {
    expect(auditValue("done_at", "2026-11-17T09:27:35.432Z")).toBe("17/11 16:27");
  });

  it("leaves other values to the caller", () => {
    expect(auditValue("retail_sale", 2)).toBe(null);
    expect(auditValue("note", "2026-11-17 is a date in text")).toBe(null);
  });

  it("lists only the fields whose value changed", () => {
    const ov = { status: "check_in", done_by: null, done_at: null, safe_drop_note: "x" };
    const nv = { status: "done", done_by: null, done_at: "2026-11-17T09:27:35.432Z", safe_drop_note: "x" };
    expect(changedKeys(Object.keys(nv), ov, nv)).toEqual(["status", "done_at"]);
  });
});

describe("3. a case card before check-in", () => {
  beforeEach(() => freshApp());

  it("shows the stock the case closed with, not 0", async () => {
    const staff = await asStaff("B-MM");
    const cards = (await call(staff, "GET", "/stock/desks?branchId=B-MM")).json.desks;
    const card = cards.find((d: any) => d.desk_id === "MM-D02");
    expect(card.status).toBe("not_started");

    const before = (await call(staff, "GET", `/stock/desk/MM-D02?date=${YESTERDAY}`)).json;
    const carried = before.rows.reduce((n: number, r: any) => n + (r.counted_qty ?? r.closing_qty), 0);
    expect(carried).toBeGreaterThan(0);
    expect(card.totalPcs).toBe(carried);
    expect(card.totalBaht).toBeGreaterThan(0);
  });

  it("an earlier date never borrows a later day's stock", async () => {
    const staff = await asStaff("B-MM");
    const cards = (await call(staff, "GET", "/stock/desks?branchId=B-MM&date=2026-10-01")).json.desks;
    for (const card of cards) expect(card.totalPcs).toBe(0);
  });
});

describe("4. profile card in Lao", () => {
  it("shows the branch and the role in the screen's language", () => {
    state.meta = { branches: [{ branch_id: "B-VT", name_en: "Vangthong", name_lo: "ວັງທອງ" }] };
    const html = profileCardHtml({ displayName: "TEST", branchId: "B-VT", role: "staff" });
    expect(html).toContain("ວັງທອງ");
    expect(html).not.toContain("Vangthong");
    expect(html).toContain(t("settings.staffRole"));
    expect(html).not.toMatch(/>\s*staff\s*</);
  });

  it("is the card the Settings screen shows", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("public/js/views/settings/index.js", "utf8");
    expect(src).toContain("profileCardHtml(");
    expect(src).not.toContain("branch.name_en");
  });
});
