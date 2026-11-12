// Row-level audit trail as seen through the API (DemoStore mirrors the
// Postgres trigger) plus the pure diff rules.
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_STAFF } from "../src/demoData";
import { auditDiff } from "../src/audit";
import { actorHeaders } from "../src/actor";
import { getStore } from "../src/store";
import { TODAY, freshApp, call, asAdmin, asStaff } from "./helpers";

beforeEach(freshApp);

const rowAudit = async (admin: any) => (await call(admin, "GET", "/audit?limit=500")).json.entries.filter((e: any) => e.table_name);

describe("audit trail", () => {
  it("a ledger entry writes an audit row with the session actor, desk and old → new", async () => {
    const staff = await asStaff("B-MM");
    const admin = await asAdmin();
    const before = (await call(staff, "GET", `/stock/desk/MM-D01?date=${TODAY}`)).json.rows.find((r: any) => r.sku_id === "GB-001");
    const res = await call(staff, "POST", "/stock/desk/MM-D01/entries", { date: TODAY, rows: [{ sku_id: "GB-001", retail_sale: 2 }] });
    expect(res.status).toBe(200);

    const entry = (await rowAudit(admin)).find((e: any) => e.table_name === "daily_stock_ledger" && e.context?.sku_id === "GB-001" && e.context?.desk_id === "MM-D01");
    expect(entry).toMatchObject({
      op: "UPDATE",
      action: "update:daily_stock_ledger",
      actor_id: DEMO_STAFF["B-MM"],
      source: "api",
      desk_id: "MM-D01",
      branch_id: "B-MM",
      old_values: { retail_sale: before.retail_sale },
      new_values: { retail_sale: 2 },
    });
    expect(entry.actor_name).toBeTruthy();
    expect(entry.actor_role).toBe("staff");
    expect(entry.context).toMatchObject({ desk_id: "MM-D01", sku_id: "GB-001", ledger_date: TODAY });
    expect(entry.new_values).not.toHaveProperty("closing_qty");
    expect(entry.new_values).not.toHaveProperty("performed_by");
  });

  it("login failures write nothing; a lockout writes locked_until with source system:login", async () => {
    const admin = await asAdmin();
    const id = DEMO_STAFF["B-MM"];
    for (let i = 0; i < 4; i++) await call(null, "POST", "/auth/login", { accountId: id, pin: "0000" });
    expect((await rowAudit(admin)).filter((e: any) => e.table_name === "staff_accounts")).toHaveLength(0);

    await call(null, "POST", "/auth/login", { accountId: id, pin: "0000" });
    const locks = (await rowAudit(admin)).filter((e: any) => e.table_name === "staff_accounts");
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ source: "system:login", actor_id: null, op: "UPDATE", row_key: { id } });
    expect(Object.keys(locks[0].new_values)).toEqual(["locked_until"]);
  });

  it("a mutation without an actor throws AUDIT_ACTOR_MISSING and changes nothing", async () => {
    const store = getStore({ DEMO_DATE: TODAY } as any);
    await expect(store.updateConfig({ safety_buffer_days: 9 } as any)).rejects.toMatchObject({ code: "AUDIT_ACTOR_MISSING" });
    expect((await store.config()).safety_buffer_days).not.toBe(9);
    expect(await store.auditLog(10)).toHaveLength(0);
  });
});

describe("auditDiff", () => {
  it("ignores updated_at and redacts pin_hash", () => {
    const o = { id: "a", pin_hash: "x", updated_at: "1", failed_attempts: 1, display_name: "A" };
    const n = { id: "a", pin_hash: "y", updated_at: "2", failed_attempts: 2, display_name: "A" };
    expect(auditDiff("staff_accounts", "UPDATE", o, n)).toEqual({ old_values: { pin_hash: "changed" }, new_values: { pin_hash: "changed" } });
    expect(auditDiff("staff_accounts", "UPDATE", o, { ...o, updated_at: "3", failed_attempts: 5 })).toBeNull();
  });

  it("logs the full row minus ignored keys on insert and delete", () => {
    const row = { sku_id: "X", qty: 1, created_at: "t", closing_qty: 3 };
    expect(auditDiff("daily_stock_ledger", "INSERT", null, row)).toEqual({ old_values: null, new_values: { sku_id: "X", qty: 1 } });
    expect(auditDiff("daily_stock_ledger", "DELETE", row, null)).toEqual({ old_values: { sku_id: "X", qty: 1 }, new_values: null });
  });

  it("maps actors to headers", () => {
    expect(actorHeaders({ id: "u" })).toEqual({ "X-KPV-Actor-Id": "u" });
    expect(actorHeaders({ system: "login" })).toEqual({ "X-KPV-Actor-System": "login" });
    expect(actorHeaders(undefined)).toEqual({});
  });
});
