// Minimal CSV reader for the SKU import (Excel "CSV UTF-8" files): quoted
// fields, doubled quotes, commas or semicolons, CRLF or LF.

// The template's columns (decided 2026-11-17). Old files still import: their
// name_lo / name_en become the name, avg_daily_sales / order_lead_time_days
// the planning numbers, and purity, price, reorder level and group are ignored.
export const CSV_COLUMNS = ["sku_id", "name", "type", "weight", "avg_daily_sell", "lead_time_days"];
const ALIASES = { name_lo: "name", avg_daily_sales: "avg_daily_sell", order_lead_time_days: "lead_time_days" };
const NAME_COLUMNS = ["name", "name_lo", "name_en"];

export const CSV_TEMPLATE = `${CSV_COLUMNS.join(",")}
,ທອງຄຳແທ່ງ 1 ບາດ,Gold Bars,1 Baht,2.5,3
`;

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
  if (!header.some((h) => NAME_COLUMNS.includes(h)) || !header.includes("type")) {
    return { error: "The first line must have the column names, including name and type", rows: [] };
  }
  const body = lines.slice(1);
  while (body.length && body[body.length - 1].every((cell) => cell.trim() === "")) body.pop();
  const rows = body.map((cells) => {
    const obj = {};
    header.forEach((raw, i) => {
      const value = (cells[i] ?? "").trim();
      if (value === "") return;
      if (raw === "name_en") {
        if (obj.name === undefined) obj.name = value; // only when there is no Lao name
        return;
      }
      const name = ALIASES[raw] ?? raw;
      if (CSV_COLUMNS.includes(name)) obj[name] = value;
    });
    return obj;
  });
  return { rows };
}
