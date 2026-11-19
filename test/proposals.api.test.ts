// Reorder proposals (decided 2026-11-19): managers create and edit, staff
// view; several cases saved together share a group; one live proposal per
// case per day; the balance follows the day's step.
import { beforeEach, describe, expect, it } from "vitest";
import { freshApp, call, asStaff, asAdmin, asManager, TODAY, YESTERDAY, TOMORROW } from "./helpers";

beforeEach(freshApp);

const rowsOf = (qty: number) => [
  { sku_id: "GB-001", item: "Gold bar", qty, note: "ຍາວ 18", balance: 5 },
  { sku_id: "GB-002", item: "Gold bar 2", qty: null },
];

describe("reorder proposals", () => {
  it("staff cannot create, edit or delete; they can list and print", async () => {
    const staff = await asStaff("B-MM");
    const manager = await asManager("B-MM");
    expect((await call(staff, "POST", "/documents/proposals", { branchId: "B-MM", cases: [{ deskId: "MM-D01", rows: rowsOf(1) }] })).status).toBe(403);
    expect((await call(staff, "POST", "/documents", { branchId: "B-MM", deskId: "MM-D01", title: "x", rows: rowsOf(1) })).status).toBe(403);
    const made = (await call(manager, "POST", "/documents/proposals", { branchId: "B-MM", cases: [{ deskId: "MM-D01", rows: rowsOf(1) }] })).json;
    const id = made.documents[0].id;
    expect((await call(staff, "PUT", `/documents/${id}`, { rows: rowsOf(2) })).status).toBe(403);
    expect((await call(staff, "DELETE", `/documents/${id}`)).status).toBe(403);
    expect((await call(staff, "GET", "/documents")).json.documents.map((d: any) => d.id)).toContain(id);
    expect((await call(staff, "GET", `/documents/${id}/print`)).status).toBe(200);
  });

  it("several cases: one proposal each, own numbers, shared group, merged print", async () => {
    const manager = await asManager("B-MM");
    const res = await call(manager, "POST", "/documents/proposals", {
      branchId: "B-MM",
      cases: [
        { deskId: "MM-D01", title: "A", rows: rowsOf(2) },
        { deskId: "MM-D02", title: "B", rows: [{ sku_id: "NK-011", item: "Necklace", qty: 3, weight_g: 45 }] },
      ],
    });
    expect(res.status).toBe(200);
    const [a, b] = res.json.documents;
    expect(a.doc_no).not.toBe(b.doc_no);
    expect(a.group_id).toBe(res.json.groupId);
    expect(b.group_id).toBe(res.json.groupId);
    // Every row is kept, ordered or not; totals count the ordered lines.
    expect(a.rows).toHaveLength(2);
    expect(a.rows[0].balance).toBe(5);
    expect(a.skuCount).toBe(1);
    expect(a.totalQty).toBe(2);

    const list = (await call(manager, "GET", `/documents?groupId=${res.json.groupId}`)).json.documents;
    expect(list).toHaveLength(2);
    expect(list[0].group_size).toBe(2);

    const html = (await call(manager, "GET", `/documents/print?groupId=${res.json.groupId}`)).text;
    expect(html).toContain(a.doc_no);
    expect(html).toContain(b.doc_no);
    expect((html.match(/<section class="sheet">/g) ?? []).length).toBe(2);
    expect(html).toContain("break-before:page");
    expect(html).toContain("ຍາວ 18"); // the note prints under ຂະໜາດ
  });

  it("one live proposal per case per day; a rejected or deleted one frees the case", async () => {
    const manager = await asManager("B-MM");
    const admin = await asAdmin();
    const make = () => call(manager, "POST", "/documents/proposals", { branchId: "B-MM", cases: [{ deskId: "MM-D01", rows: rowsOf(1) }] });
    const first = (await make()).json.documents[0];
    const again = await make();
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("PROPOSAL_EXISTS");
    expect(again.json.docNo).toBe(first.doc_no);
    const taken = (await call(manager, "GET", `/documents/proposal-taken?branchId=B-MM&date=${TODAY}`)).json.taken;
    expect(taken.map((x: any) => x.desk_id)).toContain("MM-D01");

    await call(admin, "POST", `/documents/${first.id}/decision`, { decision: "rejected" });
    const second = await make();
    expect(second.status).toBe(200);
    expect((await call(manager, "DELETE", `/documents/${second.json.documents[0].id}`)).status).toBe(200);
    expect((await make()).status).toBe(200);

    // Another day is a different slot.
    const yesterday = await call(manager, "POST", "/documents/proposals", { branchId: "B-MM", date: YESTERDAY, cases: [{ deskId: "MM-D01", rows: rowsOf(1) }] });
    expect(yesterday.status).toBe(200);
  });

  it("refuses a future date, an empty case and another branch", async () => {
    const manager = await asManager("B-MM");
    const future = await call(manager, "POST", "/documents/proposals", { branchId: "B-MM", date: TOMORROW, cases: [{ deskId: "MM-D01", rows: rowsOf(1) }] });
    expect(future.json.code).toBe("FUTURE_DATE");
    const empty = await call(manager, "POST", "/documents/proposals", { branchId: "B-MM", cases: [{ deskId: "MM-D01", rows: rowsOf(0) }] });
    expect(empty.json.code).toBe("PROPOSAL_EMPTY_CASE");
    expect(empty.json.deskId).toBe("MM-D01");
    const other = await call(manager, "POST", "/documents/proposals", { branchId: "B-VTC", cases: [{ deskId: "VTC-D01", rows: rowsOf(1) }] });
    expect(other.status).toBe(403);
  });

  it("a pending proposal is edited; a decided one is not", async () => {
    const manager = await asManager("B-MM");
    const admin = await asAdmin();
    const doc = (await call(manager, "POST", "/documents/proposals", { branchId: "B-MM", cases: [{ deskId: "MM-D01", rows: rowsOf(1) }] })).json.documents[0];
    const edited = await call(manager, "PUT", `/documents/${doc.id}`, { title: "New title", rows: rowsOf(4) });
    expect(edited.status).toBe(200);
    expect(edited.json.title).toBe("New title");
    expect(edited.json.totalQty).toBe(4);
    await call(admin, "POST", `/documents/${doc.id}/decision`, { decision: "approved" });
    expect((await call(manager, "PUT", `/documents/${doc.id}`, { rows: rowsOf(5) })).json.code).toBe("NOT_EDITABLE");
    expect((await call(manager, "DELETE", `/documents/${doc.id}`)).status).toBe(403);
    expect((await call(admin, "DELETE", `/documents/${doc.id}`)).status).toBe(200);
  });

  it("the balance is the opening before the final count, the closing after, else the last closing", async () => {
    const manager = await asManager("B-MM");
    const admin = await asAdmin();
    // MM-D01 is checked in today: opening.
    const open = (await call(manager, "GET", `/documents/proposal-source?deskId=MM-D01&date=${TODAY}`)).json;
    expect(open.balance_source).toBe("opening");
    expect(open.rows.length).toBeGreaterThan(0);
    expect(open.rows[0].lead_days).toBeTypeOf("number");
    expect(open.lead_days["GB-001"]).toBeTypeOf("number");
    // MM-D02 has no day today: yesterday's closing.
    const prev = (await call(manager, "GET", `/documents/proposal-source?deskId=MM-D02&date=${TODAY}`)).json;
    expect(prev.balance_source).toBe("previous_closing");
    expect(prev.balance_date).toBe(YESTERDAY);
    // VT-D01 is in its final count today: closing.
    const closing = (await call(admin, "GET", `/documents/proposal-source?deskId=VT-D01&date=${TODAY}`)).json;
    expect(closing.balance_source).toBe("closing");
    // Another branch's case is refused.
    expect((await call(manager, "GET", `/documents/proposal-source?deskId=VT-D01&date=${TODAY}`)).status).toBe(403);
  });

  it("filters by creator and date range, newest first", async () => {
    const manager = await asManager("B-MM");
    await call(manager, "POST", "/documents/proposals", { branchId: "B-MM", cases: [{ deskId: "MM-D01", rows: rowsOf(1) }] });
    const creators = (await call(manager, "GET", "/documents/creators")).json.creators;
    expect(creators).toContain("Manivone M.");
    const mine = (await call(manager, "GET", `/documents?createdBy=${encodeURIComponent("Manivone M.")}`)).json.documents;
    expect(mine.length).toBe(1);
    const today = (await call(manager, "GET", `/documents?dateFrom=${TODAY}&dateTo=${TODAY}`)).json.documents;
    expect(today.length).toBeGreaterThan(0);
    expect(today.every((d: any) => d.doc_date === TODAY)).toBe(true);
    const all = (await call(manager, "GET", "/documents")).json.documents;
    const stamps = all.map((d: any) => d.created_at);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });
});
