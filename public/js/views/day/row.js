// One SKU on the day screen: one row of the stock grid.
//
//   single mode   SKU | Opening | Stock-in | Stock-out | Closing          (legacy)
//   dynamic mode  SKU | Opening | Stock-in | Retail | Wholesale | Return | Withdraw | Closing
//
// Which cells take input follows the day's step (editableFor, mirroring the
// server's stepFields): the opening review step takes stock-in (and the
// opening of a newly added item); after check-in, stock-in and the four outs.
// Every other cell is a grey read-only box. Typing replaces the day's total
// for that field and it saves on change. Old days may still carry a linked
// move (shown as "⇄ −3" under Closing) and a count (shown as a note).
import { t, productName } from "../../i18n.js";
import { escapeHtml, fmtRunway, fmtRunwayLine } from "../../util.js";
import { skuSizeLabel, skuLabel } from "../../sku-groups.js";

// Same formula as the database's generated closing_qty.
export const stockOutOf = (r) =>
  r.retail_sale + r.wholesale + r.destock + (r.withdraw ?? 0) + (r.stock_out_single ?? 0);
export const closingOf = (r) =>
  r.opening_qty + r.stock_in + r.transfer_in - r.transfer_out - r.move - stockOutOf(r) + (r.move_qty ?? 0);
// Old moves/transfers still on a row (past days): the server's legacy_move.
export const legacyMoveOf = (r) =>
  r.legacy_move ?? (r.transfer_in ?? 0) - (r.transfer_out ?? 0) - (r.move ?? 0) + (r.move_qty ?? 0);

export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");

export function skuName(r) {
  return productName(r.name_en, r.name_lo);
}

// Rows are grouped by Type, labelled in Lao (product groups are gone, 2026-11-17).
export function groupKeyOf(r) {
  return (r.type_label || r.category || "").trim();
}

/** The quantity columns between Opening and Closing for a stock-out mode, in screen order. */
export function columnsFor(mode) {
  return mode === "single"
    ? ["stock_in", "stock_out_single"]
    : ["stock_in", "retail_sale", "wholesale", "destock", "withdraw"];
}

/**
 * The fields this row takes input for in this step. Mirrors the server's
 * stepFields: opening -> stock_in (+ opening_qty on a newly added row);
 * check_in / final_stock -> the mode's columns; anything else -> none.
 */
export function editableFor(status, mode, row) {
  if (status === "opening") return new Set(row?.opening_editable ? ["stock_in", "opening_qty"] : ["stock_in"]);
  if (status === "check_in" || status === "final_stock") return new Set(columnsFor(mode));
  return new Set();
}

const LABEL = {
  opening_qty: "grid.open",
  stock_in: "grid.in",
  stock_out_single: "grid.out",
  retail_sale: "grid.retail",
  wholesale: "grid.wholesale",
  destock: "grid.destock",
  withdraw: "grid.withdraw",
};
const OUT_FIELDS = new Set(["stock_out_single", "retail_sale", "wholesale", "destock", "withdraw"]);

// Name column + Opening + quantity columns + Closing. Single mode fits a phone;
// dynamic mode has a minimum width and scrolls sideways with the name pinned.
export function gridTemplate(mode) {
  const n = columnsFor(mode).length + 2;
  return mode === "single"
    ? `minmax(0,1.7fr) repeat(${n},minmax(0,1fr))`
    : `minmax(92px,1.6fr) repeat(${n},minmax(50px,1fr))`;
}
export const gridMinWidth = (mode) => (mode === "single" ? 0 : 520);

const BOX = "flex min-h-[52px] min-w-0 flex-col items-center justify-center rounded-xl border border-gray-200 bg-gray-100";
const NUM = "w-full min-w-0 bg-transparent text-center text-lg font-extrabold tabular-nums leading-tight outline-none";
// The first column stays put while the numbers scroll sideways.
export const STICKY = "sticky left-0 z-[1] bg-white";

export function headerHtml(mode) {
  const cols = [
    `<div class="${STICKY} px-1 text-left">${t("grid.sku")}</div>`,
    `<div>${t("grid.open")}</div>`,
    ...columnsFor(mode).map((f) => `<div class="${OUT_FIELDS.has(f) ? "text-danger" : f === "stock_in" ? "text-success" : ""}">${t(LABEL[f])}</div>`),
    `<div class="text-brand-700">${t("grid.closing")}</div>`,
  ];
  return cols.join("");
}

function toneOf(field) {
  if (field === "stock_in") return "text-success";
  if (OUT_FIELDS.has(field)) return "text-danger";
  if (field === "opening_qty") return "text-gray-700";
  return "text-gray-900";
}

const label = (r, field) => `${skuLabel(r)} · ${t(LABEL[field])}`;

function qtyCell(r, field, editable, boxClass = BOX) {
  const v = r[field] ?? 0;
  if (!editable) return `<div class="${boxClass}"><span class="${NUM} ${toneOf(field)}">${v}</span></div>`;
  return `
    <label class="${BOX} border-brand-200 bg-white focus-within:border-brand-500">
      <input data-field="${field}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" enterkeyhint="next" autocomplete="off"
        value="${v}" aria-label="${escapeHtml(label(r, field))}" class="${NUM} focus-ring ${toneOf(field)}" />
    </label>`;
}

// What sits under the closing number: an old day's linked move, and an old count that differed.
function closingNotes(r) {
  const parts = [];
  const legacy = legacyMoveOf(r);
  if (legacy) parts.push(`<span class="block text-[10px] font-semibold leading-none text-gray-500">⇄ ${signed(legacy)}</span>`);
  if (r.counted_qty != null && r.counted_qty !== closingOf(r)) {
    parts.push(`<span class="block text-[10px] font-bold leading-none text-danger">${t("day.count")} ${r.counted_qty}</span>`);
  }
  return parts.join("");
}

function closingCell(r) {
  return `<div class="${BOX} border-brand-200 bg-brand-50"><span data-closing class="${NUM} text-brand-700">${closingOf(r)}</span><span data-closing-notes>${closingNotes(r)}</span></div>`;
}

// Critical / Warning rows: status in words plus the branch-wide runway ("Critical ≈ 3.5 d").
function runwayChip(r) {
  const critical = r.branch_status === "critical";
  const text = [t(`replen.status.${r.branch_status}`), fmtRunway(r.runway_days)].filter(Boolean).join(" ");
  return `<span class="status-pill mt-0.5 max-w-full truncate px-1.5 py-0 text-[10px] ${critical ? "bg-danger-bg text-danger" : "bg-warning-bg text-warning"}">${escapeHtml(text)}</span>`;
}

// One small line under the SKU name: avg/day, lead time, how long the stock lasts.
function runwayLine(r) {
  const text = fmtRunwayLine(r.avg_daily_sales, r.order_lead_time_days, r.runway_days);
  return text ? `<span data-runway class="block truncate text-[10px] leading-tight text-gray-500">${escapeHtml(text)}</span>` : "";
}

const RULE_TEXT = (rule) => t(`stock.rule.${rule}`);

// The line under a row: an old day's count note and destock reason, rule problems.
export function extrasHtml(r, { problems }) {
  const parts = [];
  const variance = r.counted_qty == null ? 0 : r.counted_qty - closingOf(r);
  if (variance) {
    const note = r.counted_note ? `<span class="min-w-0 truncate text-gray-700">${escapeHtml(r.counted_note)}</span>` : "";
    parts.push(`<span class="flex min-w-0 items-center gap-1.5"><b class="shrink-0 text-danger">${t("day.diff")} ${signed(variance)}</b>${note}</span>`);
  }
  if (r.destock_note) {
    parts.push(`<span class="flex min-w-0 items-center gap-1.5"><b class="shrink-0 text-gray-600">${t("grid.destock")}:</b><span class="min-w-0 truncate text-gray-700">${escapeHtml(r.destock_note)}</span></span>`);
  }
  if (problems && problems.size) {
    parts.push(`<span role="alert" class="font-bold text-danger">${[...problems].map(RULE_TEXT).join(" · ")}</span>`);
  }
  return parts.join("");
}

/** @param {{status:string, mode:"single"|"dynamic", problems?:Set<string>}} view */
export function renderRow(r, view) {
  const { status, mode, problems } = view;
  const editable = editableFor(status, mode, r);
  const bad = Boolean(problems && problems.size > 0);
  const low = r.branch_status === "critical" || r.branch_status === "warning";
  const sub = skuSizeLabel(r);
  const extras = extrasHtml(r, view);
  return `
  <div data-sku="${escapeHtml(r.sku_id)}" class="rounded-xl px-1 py-1 ${bad ? "bg-danger-bg ring-2 ring-danger" : ""}">
    <div class="grid items-stretch gap-1.5" style="grid-template-columns:${gridTemplate(mode)}">
      <div class="${bad ? "bg-danger-bg" : "bg-white"} sticky left-0 z-[1] flex min-w-0 flex-col justify-center rounded-xl border border-gray-200 px-2 py-1">
        <span class="line-clamp-2 break-words text-[13px] font-extrabold leading-tight text-gray-900">${escapeHtml(skuName(r))}</span>
        <span class="truncate text-[10px] leading-tight text-gray-600">${escapeHtml(sub || r.sku_id)}</span>
        ${runwayLine(r)}
        ${low ? runwayChip(r) : ""}
      </div>
      ${qtyCell(r, "opening_qty", editable.has("opening_qty"), `${BOX} bg-gray-50`)}
      ${columnsFor(mode)
        .map((f) => qtyCell(r, f, editable.has(f)))
        .join("")}
      ${closingCell(r)}
    </div>
    <div data-extra class="${extras ? "" : "hidden"} ${STICKY} mt-1 flex max-w-[calc(100vw-3rem)] flex-wrap items-center gap-x-3 gap-y-0.5 bg-transparent px-1 text-xs">${extras}</div>
  </div>`;
}

/**
 * Updates a rendered row in place after a save, never touching the input that
 * has focus, so the keypad stays up while staff move from cell to cell.
 */
export function patchRow(el, r, view, { force = false } = {}) {
  // force: also reset the focused input (a value that was just refused).
  const active = force ? null : document.activeElement;
  el.querySelectorAll("[data-field]").forEach((input) => {
    if (input !== active) input.value = r[input.dataset.field] ?? 0;
  });
  const closingEl = el.querySelector("[data-closing]");
  if (closingEl) closingEl.textContent = closingOf(r);
  const notes = el.querySelector("[data-closing-notes]");
  if (notes) notes.innerHTML = closingNotes(r);
  // Boolean: classList.toggle(cls, undefined) would flip the class instead.
  const bad = Boolean(view.problems && view.problems.size > 0);
  el.classList.toggle("bg-danger-bg", bad);
  el.classList.toggle("ring-2", bad);
  el.classList.toggle("ring-danger", bad);
  const extra = el.querySelector("[data-extra]");
  const html = extrasHtml(r, view);
  extra.innerHTML = html;
  extra.classList.toggle("hidden", !html);
}
