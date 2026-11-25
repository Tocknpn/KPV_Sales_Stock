// The size of a SKU: up to 4 rows of amount + unit (decided 2026-11-25),
// "4 ບາດ 2 ສະຫຼຶງ". Each unit's grams come from Settings > SKU > Units; the
// server finds or makes the size with the same label. Used by the SKU form
// (Settings) and the new-SKU form in Daily stock.
import { escapeHtml } from "./util.js";
import { t, tf } from "./i18n.js";

export const MAX_SIZE_PARTS = 4;
const num = (n) => String(Math.round(Number(n) * 1000) / 1000);

/** The parts of a size: its own, else its one qty + unit. */
export function partsOfSize(w) {
  if (!w) return [];
  if (Array.isArray(w.parts) && w.parts.length) return w.parts.map((p) => ({ unit: p.unit, qty: Number(p.qty) }));
  return w.unit && Number(w.qty) > 0 ? [{ unit: w.unit, qty: Number(w.qty) }] : [];
}

/** "4 ບາດ 2 ສະຫຼຶງ", biggest unit first (as the server stores it). */
export function partsLabel(parts, units) {
  const grams = (u) => Number(units.find((x) => x.unit === u)?.gram_value ?? 0);
  return [...parts].sort((a, b) => grams(b.unit) - grams(a.unit)).map((p) => `${num(p.qty)} ${p.unit}`).join(" ");
}

const X_ICON = `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>`;
const PLUS_ICON = `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>`;

/** The builder's markup; mount it with mountSizeBuilder(). */
export function sizeBuilderHtml(prefix) {
  return `
    <fieldset id="${prefix}-size" class="min-w-0">
      <legend class="mb-1.5 flex w-full items-baseline justify-between gap-2 text-xs font-bold text-gray-600">
        <span>${t("settings.skuWeightLabel")}</span>
        <span id="${prefix}-size-grams" class="font-semibold tabular-nums text-gray-500"></span>
      </legend>
      <div id="${prefix}-size-rows" class="space-y-2"></div>
      <button type="button" id="${prefix}-size-add"
        class="focus-ring mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-gray-300 text-xs font-bold text-brand-700 active:bg-brand-50 disabled:hidden">
        ${PLUS_ICON}<span>${t("settings.sizeAddUnit")}</span><span id="${prefix}-size-count" class="font-semibold text-gray-500"></span>
      </button>
      <p id="${prefix}-size-preview" role="status" class="mt-2 hidden rounded-xl bg-gray-50 px-3 py-2 text-xs font-bold text-gray-900"></p>
      <p id="${prefix}-size-error" role="alert" class="mt-1.5 hidden text-xs font-semibold text-danger"></p>
    </fieldset>`;
}

/**
 * Wires the builder. units: the unit list (active ones are offered; a unit
 * already in `start` stays offered even when turned off). nameOf(): the
 * product name, for the preview line. Returns { read() -> parts | null }:
 * null after showing the problem under the rows.
 */
export function mountSizeBuilder(root, prefix, units, { start = [], disabled = false, nameOf = () => "" } = {}) {
  const $ = (sel) => root.querySelector(sel);
  const rowsEl = $(`#${prefix}-size-rows`);
  const addBtn = $(`#${prefix}-size-add`);
  const errEl = $(`#${prefix}-size-error`);
  const offered = units.filter((u) => u.active !== false || start.some((p) => p.unit === u.unit));
  // A unit in the size that is not in the list at all (should not happen): still shown.
  for (const p of start) if (!offered.some((u) => u.unit === p.unit)) offered.push({ unit: p.unit, gram_value: 0 });
  const gramsOf = (unit) => Number(offered.find((u) => u.unit === unit)?.gram_value ?? 0);

  // A new size starts on ບາດ (what most jewelry is counted in), else the first unit.
  const firstUnit = offered.find((u) => u.unit === "ບາດ")?.unit ?? offered[0]?.unit ?? "";
  let rows = start.length ? start.map((p) => ({ unit: p.unit, qty: num(p.qty) })) : [{ unit: firstUnit, qty: "" }];

  // The next unit for a new row: the biggest one smaller than the last row's, not yet used.
  const nextUnit = () => {
    const used = new Set(rows.map((r) => r.unit));
    const last = gramsOf(rows[rows.length - 1]?.unit);
    return (offered.find((u) => !used.has(u.unit) && Number(u.gram_value) < last) ?? offered.find((u) => !used.has(u.unit)))?.unit ?? "";
  };

  const showError = (msg) => {
    errEl.textContent = msg || "";
    errEl.classList.toggle("hidden", !msg);
  };

  const summary = () => {
    const filled = rows.filter((r) => r.unit && Number(r.qty) > 0);
    const grams = filled.reduce((sum, r) => sum + Number(r.qty) * gramsOf(r.unit), 0);
    $(`#${prefix}-size-grams`).textContent = grams > 0 ? `= ${num(grams)} ${t("settings.gramShort")}` : "";
    const label = partsLabel(filled.map((r) => ({ unit: r.unit, qty: Number(r.qty) })), offered);
    const preview = $(`#${prefix}-size-preview`);
    const text = [nameOf().trim(), label].filter(Boolean).join(" ");
    preview.textContent = label ? text : "";
    preview.classList.toggle("hidden", !label);
    addBtn.disabled = disabled || rows.length >= MAX_SIZE_PARTS || rows.length >= offered.length;
    $(`#${prefix}-size-count`).textContent = `${rows.length}/${MAX_SIZE_PARTS}`;
  };

  const paint = () => {
    rowsEl.innerHTML = rows
      .map((r, i) => {
        const taken = new Set(rows.filter((_, j) => j !== i).map((x) => x.unit));
        return `
        <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_2.75rem] items-center gap-2" data-row="${i}">
          <input data-qty type="number" step="any" min="0" inputmode="decimal" ${disabled ? "disabled" : ""}
            aria-label="${escapeHtml(tf("settings.sizeAmountN", { n: i + 1 }))}" placeholder="${t("settings.weightAmountLabel")}"
            value="${escapeHtml(r.qty)}" class="input-filled px-3 tabular-nums" />
          <select data-unit lang="lo" ${disabled ? "disabled" : ""} aria-label="${escapeHtml(tf("settings.sizeUnitN", { n: i + 1 }))}" class="input-filled lao px-2.5">
            ${offered
              .map((u) => `<option value="${escapeHtml(u.unit)}" ${u.unit === r.unit ? "selected" : ""} ${taken.has(u.unit) ? "disabled" : ""}>${escapeHtml(u.unit)}</option>`)
              .join("")}
          </select>
          ${
            rows.length > 1 && !disabled
              ? `<button type="button" data-remove aria-label="${escapeHtml(tf("settings.sizeRemoveN", { n: i + 1 }))}"
                  class="focus-ring flex h-11 w-11 items-center justify-center rounded-xl text-gray-500 active:bg-gray-100 active:text-danger">${X_ICON}</button>`
              : `<span aria-hidden="true"></span>`
          }
        </div>`;
      })
      .join("");
    rowsEl.querySelectorAll("[data-row]").forEach((rowEl) => {
      const i = Number(rowEl.dataset.row);
      rowEl.querySelector("[data-qty]").addEventListener("input", (e) => {
        rows[i].qty = e.target.value;
        showError("");
        summary();
      });
      rowEl.querySelector("[data-unit]").addEventListener("change", (e) => {
        rows[i].unit = e.target.value;
        showError("");
        paint();
      });
      rowEl.querySelector("[data-remove]")?.addEventListener("click", () => {
        rows.splice(i, 1);
        paint();
        rowsEl.querySelector(`[data-row="${Math.max(0, i - 1)}"] [data-qty]`)?.focus();
      });
    });
    summary();
  };

  addBtn.addEventListener("click", () => {
    if (rows.length >= MAX_SIZE_PARTS) return;
    rows.push({ unit: nextUnit(), qty: "" });
    paint();
    rowsEl.querySelector(`[data-row="${rows.length - 1}"] [data-qty]`)?.focus();
  });
  paint();

  return {
    refresh: summary,
    read() {
      if (!offered.length) return showError(t("settings.needUnits")), null;
      if (rows.some((r) => !(Number(r.qty) > 0))) return showError(t("settings.needSizeQty")), null;
      if (new Set(rows.map((r) => r.unit)).size !== rows.length) return showError(t("settings.sizeUnitOnce")), null;
      showError("");
      return rows.map((r) => ({ unit: r.unit, qty: Number(r.qty) }));
    },
  };
}
