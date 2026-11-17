// SKU .xlsx export / import (decided 2026-11-17). The sheet layout lives here;
// SheetJS (public/js/vendor/xlsx.full.min.js) reads and writes the file and is
// loaded only when the import / export sheet needs it. The Worker gets and
// returns plain rows (POST /skus/import, GET /skus/export).
//
// Each header is "<Lao> / <key>". Columns are found by the key after " / ", so
// a sheet with its columns moved still imports. Starred columns are required.

export const SKU_COLUMNS = [
  { key: "sku_id", lo: "ລະຫັດ SKU" },
  { key: "name", lo: "ຊື່ສິນຄ້າ*" },
  { key: "type", lo: "ປະເພດ*" },
  { key: "grams", lo: "ນ້ຳໜັກ (ກຣາມ)*" },
  { key: "avg_daily_sell", lo: "ຂາຍສະເລ່ຍ/ມື້" },
  { key: "lead_time_days", lo: "ໄລຍະສັ່ງ (ມື້)" },
  { key: "branch_id", lo: "ສາຂາ" },
  // Export only: the size in Lao words, for checking. Ignored on import.
  { key: "size_lo", lo: "ນ້ຳໜັກ (ລາວ)" },
];
export const SKU_HEADERS = SKU_COLUMNS.map((c) => `${c.lo} / ${c.key}`);
const IMPORT_KEYS = ["sku_id", "name", "type", "grams", "avg_daily_sell", "lead_time_days", "branch_id"];
const REQUIRED = ["name", "type", "grams"];

// Export rows (GET /skus/export) -> array of arrays, header first.
export function exportRowsToSheet(rows, sizeLabel) {
  return [
    SKU_HEADERS,
    ...rows.map((r) => [r.sku_id, r.name, r.type, r.grams, r.avg_daily_sell, r.lead_time_days, r.branch_id, r.grams == null ? null : sizeLabel(r.grams) || null]),
  ];
}

// One cell: a number stays a number; text is trimmed, a non-breaking space is
// a space and runs of spaces are one; a rich-text cell object gives its value.
function cell(v) {
  if (v && typeof v === "object") v = v.v ?? v.w ?? null;
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  return String(v).replace(/ /g, " ").replace(/\s+/g, " ").trim();
}
const isBlank = (v) => v === null || v === "";

// The column key of a header: the text after the last " / ", else the whole header.
function headerKey(h) {
  const text = String(cell(h) ?? "").toLowerCase();
  const i = text.lastIndexOf("/");
  return (i >= 0 ? text.slice(i + 1) : text).trim();
}

// Array of arrays -> import rows with their sheet line. The header is the first
// row (of the first 20) that has the required columns; blank rows above it are
// fine. firstRow = the sheet row of aoa[0] (1 unless the used range starts lower).
export function sheetRowsToImport(aoa, firstRow = 1) {
  const keysOf = (r) => (r ?? []).map(headerKey);
  let h = aoa.slice(0, 20).findIndex((r) => REQUIRED.every((k) => keysOf(r).includes(k)));
  if (h < 0) h = aoa.findIndex((r) => (r ?? []).some((c) => !isBlank(cell(c))));
  if (h < 0) h = 0;
  const header = keysOf(aoa[h]);
  const colOf = new Map();
  header.forEach((k, i) => {
    if (k && !colOf.has(k)) colOf.set(k, i);
  });
  for (const k of REQUIRED) if (!colOf.has(k)) return { rows: [], error: `missing column ${k}` };
  const rows = [];
  for (let i = h + 1; i < aoa.length; i++) {
    const src = aoa[i] ?? [];
    const row = { line: firstRow + i };
    for (const k of IMPORT_KEYS) row[k] = colOf.has(k) ? cell(src[colOf.get(k)]) : null;
    if (IMPORT_KEYS.every((k) => isBlank(row[k]))) continue;
    rows.push(row);
  }
  return { rows, error: null };
}

// Loads SheetJS once (about 1 MB, so only when a file is read or written).
let loading = null;
export function loadXlsx() {
  if (globalThis.XLSX) return Promise.resolve(globalThis.XLSX);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/js/vendor/xlsx.full.min.js";
    s.onload = () => resolve(globalThis.XLSX);
    s.onerror = () => {
      loading = null;
      reject(new Error("Could not load the Excel reader"));
    };
    document.head.appendChild(s);
  });
  return loading;
}
