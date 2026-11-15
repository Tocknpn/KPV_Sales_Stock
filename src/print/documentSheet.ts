// Printable document / proposal sheet in the shop's case-sheet layout
// (the "ລາຍລະອຽດເຄື່ອງຕູ້" form): rows grouped by product and weight per piece,
// the type and weight cells merged down the left, a "ລວມ" subtotal per group
// and a grand total. Columns the document does not hold (counted, order,
// sender, goldsmith, approver) are left blank to fill in by hand.
import type { DocumentRow, MasterSku, SkuType } from "../types";

export interface SheetRow {
  pattern: string; // ລາຍ — the row's item text
  size: string; // ຂະໜາດ — the row's note
  qty: number | null;
  grams: number | null;
}

export interface SheetGroup {
  label: string; // ປະເພດ — the product without its size, e.g. "ສາຍຄໍ"
  gramEach: number | null; // ນ້ຳໜັກ — grams per piece
  rows: SheetRow[];
  totalQty: number;
  totalGrams: number;
}

export interface Sheet {
  groups: SheetGroup[];
  totalQty: number;
  totalGrams: number;
}

const OTHER = "ອື່ນໆ";

// "ສາຍຄໍ 1 ບາດ" -> "ສາຍຄໍ", "ປີເຊຍ 0.18 g" -> "ປີເຊຍ".
export function productBase(nameLo: string): string {
  const base = nameLo.replace(/\s+[\d.,]+\s*(ບາດ|ສະຫຼຶງ|ຫຸນ|ກຣາມ|kg|g)?\s*$/i, "").trim();
  return base || nameLo.trim();
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function groupSheetRows(rows: DocumentRow[], skus: MasterSku[], types: SkuType[]): Sheet {
  const skuById = new Map(skus.map((s) => [s.sku_id, s]));
  const typeOrder = new Map(types.map((t) => [t.type_id, t.sort_order]));
  const groups = new Map<string, SheetGroup & { order: [number, number, number] }>();
  const firstSeen = new Map<string, number>();

  [...rows]
    .sort((a, b) => a.sort_order - b.sort_order)
    .forEach((r, i) => {
      const sku = r.sku_id ? skuById.get(r.sku_id) : undefined;
      const label = sku ? productBase(sku.name_lo || sku.name_en || sku.sku_id) : OTHER;
      const gramEach = sku ? (sku.std_gram_weight ?? (sku.baht_weight ? sku.baht_weight * 15 : null)) : null;
      if (!firstSeen.has(label)) firstSeen.set(label, i);
      const key = `${label}|${gramEach ?? ""}`;
      let g = groups.get(key);
      if (!g) {
        // product type order, then the order the product first appears, heavier first
        const typeRank = sku ? (sku.type_id ? typeOrder.get(sku.type_id) : undefined) ?? 999 : 10_000;
        g = { label, gramEach, rows: [], totalQty: 0, totalGrams: 0, order: [typeRank, firstSeen.get(label)!, -(gramEach ?? 0)] };
        groups.set(key, g);
      }
      const qty = r.qty === null || r.qty === undefined ? null : Number(r.qty);
      const grams =
        r.weight_g !== null && r.weight_g !== undefined ? Number(r.weight_g) : qty !== null && gramEach !== null ? round3(qty * gramEach) : null;
      g.rows.push({ pattern: r.item, size: r.note ?? "", qty, grams });
      g.totalQty += qty ?? 0;
      g.totalGrams = round3(g.totalGrams + (grams ?? 0));
    });

  const sorted = [...groups.values()].sort((a, b) => {
    for (let k = 0; k < 3; k++) if (a.order[k] !== b.order[k]) return a.order[k] - b.order[k];
    return 0;
  });
  return {
    groups: sorted.map(({ order: _order, ...g }) => g),
    totalQty: sorted.reduce((s, g) => s + g.totalQty, 0),
    totalGrams: round3(sorted.reduce((s, g) => s + g.totalGrams, 0)),
  };
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

const STATUS_LABEL: Record<string, string> = {
  pending: "ລໍຖ້າອະນຸມັດ · Pending approval",
  approved: "ອະນຸມັດແລ້ວ · Approved",
  rejected: "ບໍ່ອະນຸມັດ · Rejected",
};

export interface SheetDocument {
  doc_no: string;
  title: string;
  doc_date: string;
  branch_name: string;
  branch_name_lo?: string | null;
  desk_id: string | null;
  desk_name: string | null;
  created_by: string;
  created_at: string;
  notes: string | null;
  status: string | null;
  decided_by: string | null;
  decided_at: string | null;
  rows: DocumentRow[];
}

const BLANK_CELLS = 7; // counted x2, order x2, sender, goldsmith, approver

export function renderDocumentSheet({ doc, skus, types }: { doc: SheetDocument; skus: MasterSku[]; types: SkuType[] }): string {
  const sheet = groupSheetRows(doc.rows, skus, types);
  const blanks = '<td class="w"></td>'.repeat(BLANK_CELLS);
  const vientiane = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Vientiane" });

  const body = sheet.groups.length
    ? sheet.groups
        .map((g) => {
          const lines = g.rows
            .map(
              (r, i) => `<tr>
        ${i === 0 ? `<td class="type" rowspan="${g.rows.length}">${esc(g.label)}</td><td class="type c" rowspan="${g.rows.length}">${num(g.gramEach)}</td>` : ""}
        <td>${esc(r.pattern)}</td><td>${esc(r.size)}</td>
        <td class="n">${num(r.qty)}</td><td class="n">${num(r.grams)}</td>${blanks}
      </tr>`
            )
            .join("");
          return `${lines}
      <tr class="sub"><td colspan="2" class="c">ລວມ</td><td></td><td></td><td class="n">${num(g.totalQty)}</td><td class="n">${num(g.totalGrams)}</td>${blanks}</tr>`;
        })
        .join("")
    : `<tr><td colspan="${6 + BLANK_CELLS}" class="c muted">—</td></tr>`;

  const deskLabel = doc.desk_name ?? doc.desk_id;
  const branch = doc.branch_name_lo ? `${doc.branch_name} · ${doc.branch_name_lo}` : doc.branch_name;
  const status = doc.status
    ? `<span class="pill">${STATUS_LABEL[doc.status] ?? esc(doc.status)}</span>${
        doc.decided_by ? ` ${esc(doc.decided_by)}${doc.decided_at ? ` · ${vientiane(doc.decided_at)}` : ""}` : ""
      }`
    : "";

  return `<!doctype html>
<html lang="lo"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Lao:wght@400;600;700&display=swap" rel="stylesheet" />
<title>${esc(doc.doc_no)} — ${esc(doc.title)}</title>
<style>
  @page{size:A4 portrait;margin:10mm}
  *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font-family:'Noto Sans Lao',Arial,sans-serif;color:#000;margin:0;padding:16px;background:#fff}
  .page{max-width:190mm;margin:auto}
  .meta{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:11px;color:#333;margin-bottom:8px}
  .meta strong{color:#000}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;background:#ffebeb;color:#990000;font-weight:700}
  .scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:9.5px;table-layout:fixed;min-width:640px}
  th,td{border:1px solid #000;padding:3px 4px;height:22px;vertical-align:middle;word-wrap:break-word}
  thead tr:first-child th{border-top:3px solid #000}
  th{background:#ffc000;font-weight:600;text-align:center}
  td.type{background:#c5e4f3;font-weight:700;text-align:center}
  td.n{text-align:center}
  .c{text-align:center}
  tr.sub td{background:#fce4d6}
  tr.total td{background:#1f5f7a;color:#fff;font-weight:600;border-color:#000}
  .muted{color:#888}
  .notes{margin-top:10px;font-size:11px;color:#333}
  .actions{margin-top:20px}
  .actions button{font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#990000;color:#fff;font-weight:700;cursor:pointer}
  @media print{.actions{display:none} body{padding:0} .scroll{overflow:visible} table{min-width:0}}
</style></head>
<body><div class="page">
  <div class="meta">
    <span><strong>${esc(doc.doc_no)}</strong></span>
    <span>${esc(doc.doc_date)}</span>
    <span>${esc(branch)}${deskLabel ? ` · ${esc(deskLabel)}` : ""}</span>
    <span>ໂດຍ ${esc(doc.created_by)} · ${vientiane(doc.created_at)}</span>
    ${status ? `<span>${status}</span>` : ""}
  </div>
  <div class="scroll"><table>
    <colgroup>
      <col style="width:7%"><col style="width:6%"><col style="width:17%"><col style="width:14%">
      <col style="width:6.5%"><col style="width:7%"><col style="width:5.5%"><col style="width:5.5%">
      <col style="width:5.5%"><col style="width:5.5%"><col style="width:6.5%"><col style="width:6.5%"><col style="width:7%">
    </colgroup>
    <thead>
      <tr>
        <th colspan="4">${esc(doc.title)}</th>
        <th colspan="2">ຫົວໜ່ວຍ</th>
        <th colspan="2">ນັບໄດ້</th>
        <th colspan="2">ອໍເດີ</th>
        <th colspan="2">ຊື່ຜູ້ສົ່ງ ແລະ ຊື່ຊ່າງ</th>
        <th>ຊື່ ຫຼື ລາຍເຊັນ</th>
      </tr>
      <tr>
        <th>ປະເພດ</th><th>ນ້ຳໜັກ</th><th>ລາຍ</th><th>ຂະໜາດ</th>
        <th>ຈຳນວນຢ່າງ</th><th>ນ້ຳໜັກ g</th>
        <th>ຢ່າງ</th><th>g</th>
        <th>ອໍເດີຢ່າງ</th><th>ອໍເດີ g</th>
        <th>ຜູ້ສົ່ງ</th><th>ຊ່າງ</th>
        <th>ຜູ້ອານຸມັດ</th>
      </tr>
    </thead>
    <tbody>
      ${body}
      <tr class="total"><td colspan="4" class="c">ລວມນ້ຳໜັກ+ຈຳນວນ</td><td class="n">${num(sheet.totalQty)}</td><td class="n">${num(sheet.totalGrams)}</td>${'<td></td>'.repeat(BLANK_CELLS)}</tr>
    </tbody>
  </table></div>
  ${doc.notes ? `<p class="notes">ໝາຍເຫດ: ${esc(doc.notes)}</p>` : ""}
  <p class="actions"><button onclick="window.print()">ພິມ / ບັນທຶກເປັນ PDF · Print / Save as PDF</button></p>
</div></body></html>`;
}
