// Row-level audit trail as seen through the API (DemoStore mirrors the
// Postgres trigger) plus the pure diff rules.
import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_STAFF } from "../src/demoData";
import { auditDiff } from "../src/audit";
import { parseAuditCursor } from "../src/auditParams";
import { actorHeaders } from "../src/actor";
import { getStore } from "../src/store";
import { addDays, laosDate } from "../src/time";
import { TODAY, freshApp, call, asAdmin, asStaff, asManager } from "./helpers";

beforeEach(freshApp);

const rowAudit = async (admin: any) => (await call(admin, "GET", "/audit?limit=500")).json.entries.filter((e: any) => e.table_name);

describe("audit trail", () => {
  it("a ledger entry writes an audit row with the session actor, desk and old → new", async () => {
    const staff = await asStaff("B-MM");
    const admin = await asAdmin();
    const before = (await call(staff, "GET", `/stock/desk/MM-D01?date=${TODAY}`)).json.rows.find((r: any) => r.sku_id === "GB-001");
    const res = await call(staff, "POST", "/stock/desk/MM-D01/entries", { date: TODAY, changes: [{ sku_id: "GB-001", field: "retail_sale", to: 2 }] });
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
    expect(await store.auditLog({ limit: 10 })).toHaveLength(0);
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

describe("GET /api/audit", () => {
  const today = laosDate();
  // The demo store stamps audit rows with the real clock, so these tests run
  // on the real Laos date.
  const write = (staff: any, sku = "GB-001", n = 1) => call(staff, "POST", "/stock/desk/MM-D01/entries", { date: today, changes: [{ sku_id: sku, field: "retail_sale", to: n }] }, today);

  it("staff sees today's entries of a case in their branch only", async () => {
    const staff = await asStaff("B-MM", today);
    expect((await write(staff)).status).toBe(200);

    const mine = await call(staff, "GET", "/audit?deskId=MM-D01", undefined, today);
    expect(mine.status).toBe(200);
    expect(mine.json.entries.length).toBeGreaterThan(0);
    for (const e of mine.json.entries) expect([e.desk_id, e.to_desk_id]).toContain("MM-D01");

    // no case → 403; another branch's case → 403; the filters cannot widen the scope
    expect((await call(staff, "GET", "/audit", undefined, today)).status).toBe(403);
    expect((await call(staff, "GET", "/audit?branchId=B-MM", undefined, today)).status).toBe(403);
    expect((await call(staff, "GET", "/audit?deskId=IT-D01", undefined, today)).status).toBe(403);
    expect((await call(staff, "GET", "/audit?deskId=MM-D01&actorId=00000000-0000-4000-8000-0000000000aa", undefined, today)).status).toBe(403);
    const widened = await call(staff, "GET", "/audit?deskId=MM-D01&from=2000-01-01", undefined, today);
    expect(widened.json.entries.length).toBe(mine.json.entries.length);

    // tomorrow, today's entries are no longer "today's"
    const next = await call(staff, "GET", "/audit?deskId=MM-D01", undefined, addDays(today, 1));
    expect(next.json.entries).toHaveLength(0);
  });

  it("an entry shows at both ends of a move", async () => {
    const staff = await asStaff("B-MM", today);
    await call(staff, "POST", "/stock/desk/MM-D02/checkin", { date: today }, today);
    const moved = await call(staff, "POST", "/moves", { date: today, fromDeskId: "MM-D01", toDeskId: "MM-D02", lines: [{ skuId: "GB-001", qty: 1 }], clientRef: "00000000-0000-4000-8000-0000000000aa" }, today);
    expect(moved.status).toBe(200);
    const dest = await call(staff, "GET", "/audit?deskId=MM-D02", undefined, today);
    expect(dest.json.entries.some((e: any) => e.table_name === "transfers" && e.to_desk_id === "MM-D02" && e.desk_id === "MM-D01")).toBe(true);
  });

  it("manager cannot read another branch → 403", async () => {
    const manager = await asManager("B-MM", today);
    expect((await call(manager, "GET", "/audit?branchId=B-IT", undefined, today)).status).toBe(403);
    expect((await call(manager, "GET", "/audit?deskId=IT-D01", undefined, today)).status).toBe(403);
    const staff = await asStaff("B-MM", today);
    await write(staff);
    const own = await call(manager, "GET", "/audit", undefined, today);
    expect(own.status).toBe(200);
    expect(own.json.entries.length).toBeGreaterThan(0);
    for (const e of own.json.entries) expect([e.branch_id, e.to_branch_id]).toContain("B-MM");
  });

  it("admin sees everything and can filter by actor", async () => {
    const staff = await asStaff("B-MM", today);
    await write(staff);
    const admin = await asAdmin(today);
    const all = await call(admin, "GET", "/audit", undefined, today);
    expect(all.status).toBe(200);
    const byActor = await call(admin, "GET", `/audit?actorId=${DEMO_STAFF["B-MM"]}`, undefined, today);
    expect(byActor.json.entries.length).toBeGreaterThan(0);
    for (const e of byActor.json.entries) expect(e.actor_id).toBe(DEMO_STAFF["B-MM"]);
    expect((await call(admin, "GET", "/audit?from=2999-01-01", undefined, today)).json.entries).toHaveLength(0);
    expect((await call(admin, "GET", "/audit?from=nope", undefined, today)).status).toBe(400);
  });

  it("paging with before returns older entries", async () => {
    const staff = await asStaff("B-MM", today);
    for (let n = 1; n <= 4; n++) await write(staff, "GB-001", n);
    const admin = await asAdmin(today);
    const first = (await call(admin, "GET", "/audit?limit=2", undefined, today)).json;
    expect(first.entries).toHaveLength(2);
    expect(first.next).toBe(`${first.entries[1].created_at}|${first.entries[1].id}`);
    const second = (await call(admin, "GET", `/audit?limit=2&before=${encodeURIComponent(first.next)}`, undefined, today)).json;
    expect(second.entries.length).toBeGreaterThan(0);
    const ids = new Set(first.entries.map((e: any) => e.id));
    for (const e of second.entries) expect(ids.has(e.id)).toBe(false);
    expect((await call(admin, "GET", "/audit?before=nope", undefined, today)).status).toBe(400);
    // the last page has no cursor
    const all = (await call(admin, "GET", "/audit?limit=500", undefined, today)).json;
    expect(all.next).toBeNull();
  });

  it("there is no route that updates or deletes audit entries", async () => {
    const admin = await asAdmin(today);
    for (const method of ["PATCH", "PUT", "DELETE", "POST"]) {
      expect((await call(admin, method, "/audit/x", {}, today)).status, method).toBe(404);
    }
    expect((await call(admin, "DELETE", "/audit", undefined, today)).status).toBe(404);
  });
});

describe("audit parameter validation (F1)", () => {
  const today = laosDate();
  it("refuses a cursor or filter that could alter the PostgREST filter", async () => {
    const admin = await asAdmin(today);
    const uuid = "00000000-0000-4000-8000-0000000000aa";
    const inject = encodeURIComponent(`2026-11-12T03:00:00.000Z),or(actor_id.not.is.null|${uuid}`);
    const bad = await call(admin, "GET", `/audit?before=${inject}`, undefined, today);
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("BAD_CURSOR");
    const badId = await call(admin, "GET", `/audit?before=${encodeURIComponent("2026-11-12T03:00:00.000Z|x),or(a.eq.b")}`, undefined, today);
    expect(badId.json.code).toBe("BAD_CURSOR");
    const good = await call(admin, "GET", `/audit?before=${encodeURIComponent(`2026-11-12T03:00:00.000Z|${uuid}`)}`, undefined, today);
    expect(good.status).toBe(200);
    for (const q of [`actorId=${encodeURIComponent("x),or(a.eq.b")}`, "actorId=x", `deskId=${encodeURIComponent("MM-D01),or(a.eq.b")}`, `branchId=${encodeURIComponent("B-MM,x")}`]) {
      const res = await call(admin, "GET", `/audit?${q}`, undefined, today);
      expect(res.status, q).toBe(400);
      expect(res.json.code, q).toBe("BAD_FILTER");
    }
  });

  it("the cursor validator accepts PostgREST microseconds and +00:00 and round-trips them", () => {
    const uuid = "00000000-0000-4000-8000-0000000000aa";
    for (const at of ["2026-11-12T03:00:00.123456+00:00", "2026-11-12T03:00:00.123Z", "2026-11-12T03:00:00Z", "2026-11-12T10:00:00.5-07:00"]) {
      expect(parseAuditCursor(`${at}|${uuid}`)).toEqual({ createdAt: at, id: uuid });
    }
    for (const bad of ["nope", `|${uuid}`, "2026-11-12T03:00:00Z|x", `2026-11-12 03:00:00Z|${uuid}`, `2026-11-12T03:00:00Z),or(a|${uuid}`]) {
      expect(parseAuditCursor(bad), bad).toBeNull();
    }
  });
});

describe("audit paging cursor", () => {
  it("rows with identical created_at page correctly: every row exactly once", async () => {
    const store: any = getStore({ DEMO_DATE: TODAY } as any, { id: DEMO_STAFF["B-MM"] });
    const stamp = "2026-11-12T03:00:00.000Z";
    const ids = ["a", "d", "b", "e", "c"].map((c) => `${c}0000000-0000-4000-8000-000000000000`);
    for (const id of ids) store.db.audit.push({ id, created_at: stamp, actor_id: null, actor_name: "x", action: "t", target: "t", detail: null });
    store.db.audit.push({ id: "z0000000-0000-4000-8000-000000000000", created_at: "2026-11-12T02:00:00.000Z", actor_id: null, actor_name: "x", action: "t", target: "t", detail: null });

    const seen: string[] = [];
    let before: { createdAt: string; id: string } | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await store.auditLog({ limit: 2, before });
      if (page.length === 0) break;
      seen.push(...page.map((e: any) => e.id));
      before = { createdAt: page[page.length - 1].created_at, id: page[page.length - 1].id };
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect(seen.slice(0, 5)).toEqual([...ids].sort().reverse());
  });

  it("SupabaseStore sends a keyset query with an encoded timestamp", async () => {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as any;
    try {
      const store = getStore({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" } as any);
      await store.auditLog({ deskId: "MM-D01", limit: 51, before: { createdAt: "2026-11-12T10:00:00.123456+00:00", id: "abc" } });
    } finally {
      globalThis.fetch = real;
    }
    const q = decodeURIComponent(urls[0].split("?")[1].replace(/%2B/g, "%252B"));
    expect(urls[0]).toContain("order=created_at.desc,id.desc");
    expect(urls[0]).toContain("limit=51");
    expect(urls[0]).toContain("2026-11-12T10%3A00%3A00.123456%2B00%3A00");
    expect(urls[0]).not.toContain("+");
    expect(q).toContain("and=(or(created_at.lt.2026-11-12T10:00:00.123456%2B00:00,and(created_at.eq.2026-11-12T10:00:00.123456%2B00:00,id.lt.abc)),or(desk_id.eq.MM-D01,to_desk_id.eq.MM-D01))");
  });
});

describe("semantic entries carry their branch", () => {
  it("a manager sees the reopen entry for their branch; another branch's manager does not", async () => {
    const today = laosDate();
    const manager = await asManager("B-MM", today);
    expect((await call(manager, "POST", "/stock/desk/MM-D02/reopen", { date: addDays(today, -1), reason: "wrong count" }, today)).status).toBe(200);
    const seen = (await call(manager, "GET", "/audit", undefined, today)).json.entries;
    expect(seen.find((e: any) => e.action === "desk_day.reopen")).toMatchObject({ branch_id: "B-MM", desk_id: "MM-D02", detail: { reason: "wrong count" } });
    const admin = await asAdmin(today);
    expect((await call(admin, "GET", "/audit?branchId=B-IT", undefined, today)).json.entries.some((e: any) => e.action === "desk_day.reopen")).toBe(false);
  });
});
