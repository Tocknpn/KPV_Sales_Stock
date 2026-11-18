// Pure helpers of the day screen (no DOM), shared by index.js and the tests.
import { tf } from "../../i18n.js";
import { skuLabel } from "../../sku-groups.js";

// + Add SKU. In the opening step a new item takes its opening, except a SKU the
// day carried from its previous day (removed earlier, now restored): its
// opening is locked, so it is restored without asking. After check-in every
// item takes a stock-in quantity.
//   skus     the picked SKUs ({ sku_id, ... })
//   carried  sku_ids the day carries (detail.carriedSkus)
// Returns the SKUs to ask a quantity for, and the field the quantity goes to.
export function addPlan(skus, opening, carried = []) {
  if (!opening) return { ask: skus, field: "stock_in" };
  const locked = new Set(carried);
  return { ask: skus.filter((s) => !locked.has(s.sku_id)), field: "opening_qty" };
}

// The /sku request items: a SKU not asked about is sent with 0.
export function addItems(skus, field, qtys) {
  return skus.map((s) => ({ sku_id: s.sku_id, [field]: qtys.get(s.sku_id) ?? 0 }));
}

// Error codes meaning the day moved on elsewhere (another device confirmed,
// closed or reopened it): the screen reloads to show the right step.
export const STEP_CHANGED_CODES = new Set(["EARLIER_DAY_OPEN", "FIELD_NOT_IN_STEP", "BAD_TRANSITION"]);

// NEXT_DAY_NEGATIVE names the item and the date that would go below zero.
// `err.data` carries { sku_id, date, available }; `rows` are the day's rows,
// which hold the SKU's names (skuLabel -> productName, Lao first).
export function nextDayNegativeText(data, rows, fmtDate = (d) => d) {
  const row = rows.find((r) => r.sku_id === data?.sku_id);
  const name = row ? skuLabel(row) : data?.sku_id ?? "";
  return tf("day.nextDayNegative", { name, date: data?.date ? fmtDate(data.date) : "", n: Number(data?.available ?? 0) });
}

// The dates a reopen of `from` sends back to "not checked in": from the
// reopened date up to today (or up to `from` itself for today).
export function reopenRange(from, today) {
  return { from, to: today && today > from ? today : from };
}
