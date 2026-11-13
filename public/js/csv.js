// Minimal CSV reader for the SKU import (Excel "CSV UTF-8" files): quoted
// fields, doubled quotes, commas or semicolons, CRLF or LF.

export const CSV_COLUMNS = [
  "sku_id",
  "name_en",
  "name_lo",
  "type",
  "weight",
  "purity",
  "baht_weight",
  "unit_price_lak",
  "reorder_level",
  "avg_daily_sales",
  "order_lead_time_days",
  "group",
];

export const CSV_TEMPLATE = `${CSV_COLUMNS.join(",")}\r\n,Gold Bar 1 Baht,ທອງຄຳແທ່ງ 1 ບາດ,Gold Bars,1 Baht,99.99%,1,0,5,2.5,3,\r\n`;

export function parseCsv(text) {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Turns parsed lines into SKU objects keyed by the header row. Blank lines
// are kept as empty objects so reported line numbers match the file.
export function csvRowsToSkus(lines) {
  if (lines.length < 2) return { error: "The file has no data rows", rows: [] };
  const header = lines[0].map((h) => h.trim().toLowerCase());
  if (!header.includes("name_en") || !header.includes("type")) {
    return { error: "The first line must have the column names, including name_en and type", rows: [] };
  }
  const body = lines.slice(1);
  while (body.length && body[body.length - 1].every((cell) => cell.trim() === "")) body.pop();
  const rows = body.map((cells) => {
    const obj = {};
    header.forEach((name, i) => {
      const value = (cells[i] ?? "").trim();
      if (CSV_COLUMNS.includes(name) && value !== "") obj[name] = value;
    });
    return obj;
  });
  return { rows };
}
