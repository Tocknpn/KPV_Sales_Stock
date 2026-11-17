import { beforeEach, describe, expect, it } from "vitest";
import { freshApp, call, asStaff, asAdmin } from "./helpers";

beforeEach(freshApp);

describe("document print (case-sheet layout)", () => {
  it("saves each row's product and prints rows grouped with subtotals and a total", async () => {
    const staff = await asStaff("B-MM");
    const created = await call(staff, "POST", "/documents", {
      branchId: "B-MM",
      deskId: "MM-D01",
      title: "ລາຍລະອຽດເຄື່ອງຕູ້ 1",
      rows: [
        { sku_id: "NK-010", item: "ໂສ້", qty: 2 },
        { sku_id: "NK-010", item: "ປ້ອງອ້ອຍ", qty: 1, note: "ຍາວ 18" },
        { sku_id: "NOPE-1", item: "unknown product", qty: 1, weight_g: 3 },
        { item: "free text", qty: 1, weight_g: 1.5 },
      ],
    });
    expect(created.status).toBe(200);
    expect(created.json.rows.map((r: any) => r.sku_id)).toEqual(["NK-010", "NK-010", null, null]);

    const print = await call(staff, "GET", `/documents/${created.json.id}/print`);
    expect(print.status).toBe(200);
    const html = print.text;
    expect(html).toContain("ລາຍລະອຽດເຄື່ອງຕູ້ 1");
    expect(html).toContain('rowspan="2"'); // the two NK-010 rows share one type cell
    expect(html).toContain("ອື່ນໆ"); // rows without a known product
    expect((html.match(/class="sub"/g) ?? []).length).toBe(2);
    expect(html).toContain("ລວມນ້ຳໜັກ+ຈຳນວນ");
    expect(html).toContain("ຍາວ 18");
  });

  it("another branch cannot print it", async () => {
    const admin = await asAdmin();
    const created = await call(admin, "POST", "/documents", { branchId: "B-VTC", title: "x", rows: [] });
    const staff = await asStaff("B-MM");
    expect((await call(staff, "GET", `/documents/${created.json.id}/print`)).status).toBe(403);
    expect((await call(admin, "GET", `/documents/${created.json.id}/print`)).text).toContain("—");
  });
});
