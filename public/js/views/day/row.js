// One SKU on the day screen: a card of 2 rows (3 in count mode).
//   row 1  size + purity            Closing (large)
//   row 2  Open | In | Out | ⇄      four equal cells, each a tap target
//   row 3  Count [ ] ✓ matches      count mode only
// Everything is `min-w-0` / `truncate` / `grid-cols-4`: there is no fixed pixel
// width, so five-digit values shrink the text box, never widen the page.
import { t, pickName } from "../../i18n.js";
import { escapeHtml } from "../../util.js";

export const closingOf = (r) =>
  r.opening_qty + r.stock_in + r.transfer_in - r.retail_sale - r.wholesale - r.transfer_out - r.destock - r.move;
export const outOf = (r) => r.retail_sale + r.wholesale + r.destock;
// transfer_in − transfer_out − move, signed.
export const netMoveOf = (r) => r.transfer_in - r.transfer_out - r.move;
export const hasActivity = (r) =>
  r.stock_in + r.transfer_in + r.retail_sale + r.wholesale + r.transfer_out + r.destock + r.move > 0;

export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");

export function skuName(r) {
  return pickName(r.name_en, r.name_lo);
}

// group_name arrives with Task 13; until then the type/category groups rows.
export function groupKeyOf(r) {
  return (r.group_name || r.category || "").trim();
}

const CELL = "min-h-[44px] min-w-0 rounded-lg px-1 py-1 text-center";

function cell(label, value, { act, tone = "text-gray-900", disabled, aria }) {
  const inner = `
    <span class="block truncate text-[11px] font-semibold leading-tight text-gray-600">${label}</span>
    <span class="block truncate text-base font-extrabold leading-tight tabular-nums ${tone}">${value}</span>`;
  if (!act) return `<div class="${CELL} bg-gray-50">${inner}</div>`;
  return `<button type="button" data-act="${act}" ${disabled ? "disabled" : ""} aria-label="${escapeHtml(aria ?? label)}"
    class="${CELL} focus-ring border border-hairline bg-white active:bg-brand-50 disabled:border-transparent disabled:bg-gray-50">${inner}</button>`;
}

function countBlock(r, closing, { readOnly, countMode }) {
  const counted = r.counted_qty;
  if (!countMode && !(readOnly && counted != null)) return "";
  const variance = counted == null ? null : counted - closing;
  const noteBtn =
    variance && !readOnly
      ? `<button type="button" data-act="note" class="focus-ring tap-target min-w-0 flex-1 truncate rounded-lg border border-hairline px-2 text-left text-sm ${
          r.counted_note ? "text-gray-800" : "font-semibold text-danger"
        }">${r.counted_note ? escapeHtml(r.counted_note) : t("day.addNote")}</button>`
      : variance && r.counted_note
      ? `<span class="min-w-0 flex-1 truncate text-sm text-gray-700">${escapeHtml(r.counted_note)}</span>`
      : "";
  return `
    <div class="mt-2 flex items-center gap-2">
      <label class="shrink-0 text-xs font-bold text-gray-700" for="count-${escapeHtml(r.sku_id)}">${t("day.count")}</label>
      ${
        readOnly
          ? `<span class="min-w-0 flex-1 text-base font-extrabold tabular-nums">${counted ?? "—"}</span>`
          : `<input id="count-${escapeHtml(r.sku_id)}" data-count type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="${counted ?? ""}"
               class="input-filled min-w-0 flex-1 px-2 py-2 text-center text-base font-extrabold tabular-nums" />
             <button type="button" data-act="match" class="btn-secondary shrink-0 px-3 py-2 text-sm">${t("day.matches")}</button>`
      }
    </div>
    ${
      variance
        ? `<div class="mt-1.5 flex items-center gap-2">
             <span class="shrink-0 text-xs font-extrabold text-danger">${t("day.diff")} ${signed(variance)}</span>${noteBtn}
           </div>`
        : ""
    }`;
}

const RULE_TEXT = (rule) => t(`stock.rule.${rule}`);

/** @param {{readOnly:boolean, countMode:boolean, problems?:Set<string>}} view */
export function renderRow(r, view) {
  const { readOnly, countMode, problems } = view;
  const closing = closingOf(r);
  const out = outOf(r);
  const net = netMoveOf(r);
  const low = closing < Number(r.threshold ?? 0);
  const sub = [r.weight_name, r.purity].filter(Boolean).join(" · ");
  const bad = problems && problems.size > 0;
  return `
  <article data-sku="${escapeHtml(r.sku_id)}" class="card p-3 ${bad ? "ring-2 ring-danger" : ""}">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="truncate text-sm font-extrabold text-gray-900">${escapeHtml(skuName(r))}</div>
        <div class="flex min-w-0 items-center gap-1.5 text-xs text-gray-600">
          <span class="truncate">${escapeHtml(sub || r.sku_id)}</span>
          ${low ? `<span class="status-pill shrink-0 bg-danger-bg px-1.5 py-0.5 text-[11px] text-danger">${t("stock.lowShort")}</span>` : ""}
        </div>
      </div>
      <div class="shrink-0 text-right">
        <div class="text-[11px] font-semibold leading-tight text-gray-600">${t("day.closing")}</div>
        <div data-closing class="text-2xl font-extrabold leading-tight tabular-nums text-brand-700">${closing}</div>
      </div>
    </div>
    <div class="mt-2 grid grid-cols-4 gap-1.5">
      ${cell(t("day.open"), r.opening_qty, { tone: "text-gray-700" })}
      ${cell(t("day.in"), signed(r.stock_in), { act: "in", disabled: readOnly, tone: r.stock_in ? "text-success" : "text-gray-900" })}
      ${cell(t("day.out"), out ? `−${out}` : "0", { act: "out", disabled: readOnly, tone: out ? "text-danger" : "text-gray-900" })}
      ${cell("⇄", signed(net), { act: "move", disabled: readOnly, aria: t("day.move"), tone: net ? (net > 0 ? "text-success" : "text-danger") : "text-gray-900" })}
    </div>
    ${countBlock(r, closing, { readOnly, countMode })}
    ${
      bad
        ? `<p role="alert" class="mt-2 text-xs font-bold text-danger">${[...problems].map(RULE_TEXT).join(" · ")}</p>`
        : ""
    }
  </article>`;
}
