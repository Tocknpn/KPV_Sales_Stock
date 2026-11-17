// One SKU on the day screen: one row of the stock grid.
//
//   single mode   SKU | Opening | Stock-in | Stock-out | Move in/out | Closing
//   dynamic mode  SKU | Opening | Stock-in | Retail | Wholesale | Destock | Move in/out | Closing
//
// Editable cells are plain inputs (numeric keypad) holding the DAY'S TOTAL for
// that field: typing replaces it and it saves on change. Move in/out is signed;
// its input holds the size and a ± strip under it holds the direction, because
// the iPhone number pad has no minus key. In count mode the Closing column
// becomes the Count input, with the expected closing above it (tap = matches).
import { t, productName } from "../../i18n.js";
import { escapeHtml, fmtRunway } from "../../util.js";
import { skuSizeLabel } from "../../sku-groups.js";

// Same formula as the database's generated closing_qty (migration 11).
export const stockOutOf = (r) => r.retail_sale + r.wholesale + r.destock + (r.stock_out_single ?? 0);
export const closingOf = (r) =>
  r.opening_qty + r.stock_in + r.transfer_in - r.transfer_out - r.move - stockOutOf(r) + (r.move_qty ?? 0);
// Old linked moves/transfers still on a row (past days): transfer_in − transfer_out − move.
export const linkedMoveOf = (r) => r.transfer_in - r.transfer_out - r.move;

export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");

export function skuName(r) {
  return productName(r.name_en, r.name_lo);
}

export function groupKeyOf(r) {
  return (r.group_name || r.category || "").trim();
}

/** The editable quantity columns for a stock-out mode, in screen order. */
export function columnsFor(mode) {
  return mode === "single"
    ? ["stock_in", "stock_out_single", "move_qty"]
    : ["stock_in", "retail_sale", "wholesale", "destock", "move_qty"];
}

const LABEL = {
  stock_in: "grid.in",
  stock_out_single: "grid.out",
  retail_sale: "grid.retail",
  wholesale: "grid.wholesale",
  destock: "grid.destock",
  move_qty: "grid.move",
};
const OUT_FIELDS = new Set(["stock_out_single", "retail_sale", "wholesale", "destock"]);

// Name column + Opening + editable columns + Closing. Single mode fits a phone;
// dynamic mode has a minimum width and scrolls sideways with the name pinned.
export function gridTemplate(mode) {
  const n = columnsFor(mode).length + 2;
  return mode === "single"
    ? `minmax(0,1.7fr) repeat(${n},minmax(0,1fr))`
    : `minmax(92px,1.6fr) repeat(${n},minmax(54px,1fr))`;
}
export const gridMinWidth = (mode) => (mode === "single" ? 0 : 520);

const BOX = "flex min-h-[52px] min-w-0 flex-col items-center justify-center rounded-xl border border-gray-200 bg-gray-100";
const NUM = "w-full min-w-0 bg-transparent text-center text-lg font-extrabold tabular-nums leading-tight outline-none";
// The first column stays put while the numbers scroll sideways.
export const STICKY = "sticky left-0 z-[1] bg-white";

export function headerHtml(mode, { countMode }) {
  const cols = [
    `<div class="${STICKY} px-1 text-left">${t("grid.sku")}</div>`,
    `<div>${t("grid.open")}</div>`,
    ...columnsFor(mode).map((f) => `<div class="${OUT_FIELDS.has(f) ? "text-danger" : f === "stock_in" ? "text-success" : ""}">${t(LABEL[f])}</div>`),
    `<div class="text-brand-700">${t(countMode ? "grid.count" : "grid.closing")}</div>`,
  ];
  return cols.join("");
}

function toneOf(field, value) {
  if (field === "stock_in") return "text-success";
  if (OUT_FIELDS.has(field)) return "text-danger";
  if (field === "move_qty") return value > 0 ? "text-success" : value < 0 ? "text-danger" : "text-gray-900";
  return "text-gray-900";
}

const label = (r, field) => `${skuName(r)} · ${t(LABEL[field])}`;

function moveCell(r, readOnly) {
  const v = r.move_qty ?? 0;
  const linked = linkedMoveOf(r);
  const legacy = linked ? `<span class="block text-[10px] font-semibold leading-none text-gray-500">⇄ ${signed(linked)}</span>` : "";
  if (readOnly) {
    return `<div class="${BOX}"><span class="${NUM} ${toneOf("move_qty", v)}">${signed(v)}</span>${legacy}</div>`;
  }
  const neg = v < 0;
  return `
    <div class="${BOX} overflow-hidden" data-move-cell>
      <input data-field="move_qty" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" enterkeyhint="next" autocomplete="off"
        value="${Math.abs(v)}" aria-label="${escapeHtml(label(r, "move_qty"))}"
        class="${NUM} focus-ring pt-1 ${toneOf("move_qty", v)}" />
      <button type="button" data-act="sign" aria-pressed="${neg}" aria-label="${t("grid.signToggle")}"
        class="w-full shrink-0 py-0.5 text-[10px] font-extrabold leading-tight ${neg ? "bg-danger-bg text-danger" : "bg-success-bg text-success"}">${neg ? t("grid.moveOut") : t("grid.moveIn")}</button>
      ${legacy}
    </div>`;
}

function qtyCell(r, field, readOnly) {
  const v = r[field] ?? 0;
  if (readOnly) return `<div class="${BOX}"><span class="${NUM} ${toneOf(field, v)}">${v}</span></div>`;
  return `
    <label class="${BOX} focus-within:border-brand-500 focus-within:bg-white">
      <input data-field="${field}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" enterkeyhint="next" autocomplete="off"
        value="${v}" aria-label="${escapeHtml(label(r, field))}" class="${NUM} focus-ring ${toneOf(field, v)}" />
    </label>`;
}

function closingCell(r, { readOnly, countMode }) {
  const closing = closingOf(r);
  if (countMode && !readOnly) {
    return `
      <div class="${BOX} border-brand-200 bg-brand-50 focus-within:border-brand-500">
        <button type="button" data-act="match" aria-label="${escapeHtml(`${t("day.matches")} ${closing}`)}"
          class="w-full text-[10px] font-bold leading-tight text-gray-600"><span data-expected class="tabular-nums">${closing}</span> ✓</button>
        <input data-count type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" enterkeyhint="next" autocomplete="off"
          value="${r.counted_qty ?? ""}" placeholder="—" aria-label="${escapeHtml(`${skuName(r)} · ${t("day.count")}`)}"
          class="${NUM} focus-ring text-brand-700" />
      </div>`;
  }
  const counted = readOnly && r.counted_qty != null && r.counted_qty !== closing
    ? `<span class="block text-[10px] font-bold leading-none text-danger">${t("day.count")} ${r.counted_qty}</span>`
    : "";
  return `<div class="${BOX} border-brand-200 bg-brand-50"><span data-closing class="${NUM} text-brand-700">${closing}</span>${counted}</div>`;
}

// Critical / Warning rows: status in words plus the branch-wide runway ("Critical ≈ 3.5 d").
function runwayChip(r) {
  const critical = r.branch_status === "critical";
  const text = [t(`replen.status.${r.branch_status}`), fmtRunway(r.runway_days)].filter(Boolean).join(" ");
  return `<span class="status-pill mt-0.5 max-w-full truncate px-1.5 py-0 text-[10px] ${critical ? "bg-danger-bg text-danger" : "bg-warning-bg text-warning"}">${escapeHtml(text)}</span>`;
}

const RULE_TEXT = (rule) => t(`stock.rule.${rule}`);

// The line under a row: variance and its note, the destock reason, rule problems.
export function extrasHtml(r, { readOnly, countMode, mode, problems }) {
  const parts = [];
  const closing = closingOf(r);
  const variance = r.counted_qty == null ? 0 : r.counted_qty - closing;
  if (variance && (countMode || readOnly)) {
    const note = readOnly
      ? r.counted_note ? `<span class="min-w-0 truncate text-gray-700">${escapeHtml(r.counted_note)}</span>` : ""
      : `<button type="button" data-act="note" class="focus-ring min-w-0 truncate underline ${r.counted_note ? "text-gray-800" : "font-bold text-danger"}">${r.counted_note ? escapeHtml(r.counted_note) : t("day.addNote")}</button>`;
    parts.push(`<span class="flex min-w-0 items-center gap-1.5"><b class="shrink-0 text-danger">${t("day.diff")} ${signed(variance)}</b>${note}</span>`);
  }
  if (mode !== "single" && r.destock > 0) {
    const note = readOnly
      ? `<span class="min-w-0 truncate text-gray-700">${escapeHtml(r.destock_note ?? "—")}</span>`
      : `<button type="button" data-act="destock-note" class="focus-ring min-w-0 truncate underline ${r.destock_note ? "text-gray-800" : "font-bold text-danger"}">${r.destock_note ? escapeHtml(r.destock_note) : t("grid.addDestockReason")}</button>`;
    parts.push(`<span class="flex min-w-0 items-center gap-1.5"><b class="shrink-0 text-gray-600">${t("grid.destock")}:</b>${note}</span>`);
  }
  if (problems && problems.size) {
    parts.push(`<span role="alert" class="font-bold text-danger">${[...problems].map(RULE_TEXT).join(" · ")}</span>`);
  }
  return parts.join("");
}

/** @param {{readOnly:boolean, countMode:boolean, mode:"single"|"dynamic", problems?:Set<string>}} view */
export function renderRow(r, view) {
  const { readOnly, mode, problems } = view;
  const bad = Boolean(problems && problems.size > 0);
  const low = r.branch_status === "critical" || r.branch_status === "warning";
  const sub = [skuSizeLabel(r), r.purity].filter(Boolean).join(" · ");
  const extras = extrasHtml(r, view);
  return `
  <div data-sku="${escapeHtml(r.sku_id)}" class="rounded-xl px-1 py-1 ${bad ? "bg-danger-bg ring-2 ring-danger" : ""}">
    <div class="grid items-stretch gap-1.5" style="grid-template-columns:${gridTemplate(mode)}">
      <div class="${bad ? "bg-danger-bg" : "bg-white"} sticky left-0 z-[1] flex min-w-0 flex-col justify-center rounded-xl border border-gray-200 px-2 py-1">
        <span class="line-clamp-2 break-words text-[13px] font-extrabold leading-tight text-gray-900">${escapeHtml(skuName(r))}</span>
        <span class="truncate text-[10px] leading-tight text-gray-600">${escapeHtml(sub || r.sku_id)}</span>
        ${low ? runwayChip(r) : ""}
      </div>
      <div class="${BOX} bg-gray-50"><span class="${NUM} text-gray-700">${r.opening_qty}</span></div>
      ${columnsFor(mode)
        .map((f) => (f === "move_qty" ? moveCell(r, readOnly) : qtyCell(r, f, readOnly)))
        .join("")}
      ${closingCell(r, view)}
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
    const field = input.dataset.field;
    const v = r[field] ?? 0;
    if (input !== active) input.value = field === "move_qty" ? Math.abs(v) : v;
    if (field === "move_qty") {
      input.classList.remove("text-success", "text-danger", "text-gray-900");
      input.classList.add(toneOf("move_qty", v));
    }
  });
  const sign = el.querySelector('[data-act="sign"]');
  if (sign) {
    const neg = (r.move_qty ?? 0) < 0 || sign.dataset.pendingNeg === "1";
    sign.setAttribute("aria-pressed", String(neg));
    sign.textContent = neg ? t("grid.moveOut") : t("grid.moveIn");
    sign.className = `w-full shrink-0 py-0.5 text-[10px] font-extrabold leading-tight ${neg ? "bg-danger-bg text-danger" : "bg-success-bg text-success"}`;
  }
  const closing = closingOf(r);
  const closingEl = el.querySelector("[data-closing]");
  if (closingEl) closingEl.textContent = closing;
  const expected = el.querySelector("[data-expected]");
  if (expected) expected.textContent = closing;
  const count = el.querySelector("[data-count]");
  if (count && count !== active) count.value = r.counted_qty ?? "";
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
