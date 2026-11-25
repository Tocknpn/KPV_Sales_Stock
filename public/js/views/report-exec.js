// Report tabs built on the executive overview: stock position (every branch x
// SKU line with runway, status and reorder action), stock out (every SKU that
// went out in the period) and cases. Sortable, filterable, exportable.
import { state, branchName } from "../state.js";
import { fmtBaht, fmtInt, fmtLak, escapeHtml as esc, debounce } from "../util.js";
import { t, tf, productName } from "../i18n.js";
import { skuLabel } from "../sku-groups.js";
import { loadXlsx } from "../sku-xlsx.js";
import { toast } from "../ui.js";
import { bandFill } from "../charts.js";
import { skeletonTable } from "../skeleton.js";
import { loadExecutive, execFiltersHtml, bindExecFilters, fmtDays } from "./exec-data.js";

export const REPORT_TABS = ["position", "out", "cases", "movement"];

export function reportTabsHtml() {
  return `<div class="mt-3 flex gap-1 overflow-x-auto rounded-xl bg-gray-100 p-1 no-scrollbar" role="tablist">
    ${REPORT_TABS.map((tab) => {
      const on = state.report.tab === tab;
      return `<button type="button" role="tab" aria-selected="${on}" data-report-tab="${tab}" class="focus-ring flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-bold ${
        on ? "bg-white text-brand-700 shadow-card" : "text-gray-600"
      }">${t(`rep.tab.${tab}`)}</button>`;
    }).join("")}
  </div>`;
}

export function bindReportTabs(onSwitch) {
  document.querySelectorAll("[data-report-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.report.tab === b.dataset.reportTab) return;
      state.report.tab = b.dataset.reportTab;
      onSwitch();
    })
  );
}

// ---------------------------------------------------------------------------
const dash = "–";
const num = (v, f = fmtInt) => (v == null ? dash : f(v));
const days1 = (v) => (v == null ? dash : fmtDays(v));
const POSITION_FILTERS = ["all", "decide", "noAction", "critical", "warning", "ok", "slow", "long", "no_sales", "unknown"];

function bandChip(band, slowDays) {
  return `<span class="inline-flex items-center gap-1.5 whitespace-nowrap"><span class="h-2.5 w-2.5 rounded-sm" style="background:${bandFill(band)}" aria-hidden="true"></span>${esc(tf(`exec.band.${band}`, { d: slowDays }))}</span>`;
}

function actionCell(r) {
  if (!r.action) return dash;
  const cls = r.action === "none" ? "text-danger" : r.action === "pending" ? "text-warning" : "text-success";
  return `<span class="whitespace-nowrap font-bold ${cls}">${t(`exec.action.${r.action}`)}</span>${r.action_doc ? `<span class="block text-[10px] text-gray-500">${esc(r.action_doc)}</span>` : ""}`;
}

function typeNameOf(d) {
  const m = new Map(d.byType.map((x) => [x.type_key, productName(x.name_en, x.name_lo)]));
  return (key) => m.get(key) ?? key;
}

// Column spec: key, label, value (sort / export), html (cell), num (right-aligned), sum (total row).
function columnsFor(tab, d) {
  const typeName = typeNameOf(d);
  const multiBranch = d.byBranch.length > 1;
  if (tab === "position") {
    return [
      { key: "sku", label: t("rep.col.sku"), value: (r) => skuLabel(r), html: (r) => `<span class="block truncate font-bold text-gray-900">${esc(skuLabel(r))}</span>${multiBranch ? `<span class="block truncate text-[10px] text-gray-500">${esc(branchName(r.branch_id))}</span>` : ""}`, sticky: true },
      { key: "band", label: t("rep.col.status"), value: (r) => tf(`exec.band.${r.band}`, { d: d.slowDays }), sortValue: (r) => ["critical", "warning", "ok", "long", "no_sales", "unknown"].indexOf(r.band), html: (r) => bandChip(r.band, d.slowDays) },
      { key: "runway_days", label: t("rep.col.days"), num: true, value: (r) => r.runway_days, html: (r) => days1(r.runway_days) },
      { key: "value_lak", label: t("rep.col.value"), num: true, sum: true, value: (r) => r.value_lak, html: (r) => fmtLak(r.value_lak) },
      { key: "action", label: t("rep.col.action"), value: (r) => (r.action ? t(`exec.action.${r.action}`) : ""), sortValue: (r) => ({ none: 0, pending: 1, approved: 2 })[r.action] ?? 3, html: actionCell },
      { key: "suggested_qty", label: t("rep.col.suggest"), num: true, sum: true, value: (r) => r.suggested_qty, html: (r) => (r.suggested_qty ? `<span class="font-bold text-gray-900">${fmtInt(r.suggested_qty)}</span>` : dash) },
      { key: "on_hand", label: t("rep.col.onHand"), num: true, sum: true, value: (r) => r.on_hand, html: (r) => num(r.on_hand) },
      ...(multiBranch ? [{ key: "branch", label: t("rep.col.branch"), value: (r) => branchName(r.branch_id), html: (r) => esc(branchName(r.branch_id)) }] : []),
      { key: "type", label: t("rep.col.type"), value: (r) => typeName(r.type_key), html: (r) => `<span lang="lo">${esc(typeName(r.type_key))}</span>` },
      { key: "inbound", label: t("rep.col.inbound"), num: true, sum: true, value: (r) => r.inbound, html: (r) => (r.inbound ? num(r.inbound) : dash) },
      { key: "avg_daily", label: t("rep.col.avg"), num: true, value: (r) => r.avg_daily, html: (r) => days1(r.avg_daily) },
      { key: "lead_days", label: t("rep.col.lead"), num: true, value: (r) => r.lead_days, html: (r) => num(r.lead_days) },
      { key: "sold", label: t("rep.col.sold"), num: true, sum: true, value: (r) => r.sold, html: (r) => num(r.sold) },
      { key: "excess_lak", label: t("rep.col.excess"), num: true, sum: true, value: (r) => r.excess_lak, html: (r) => (r.excess_lak ? fmtLak(r.excess_lak) : dash) },
      { key: "baht", label: t("rep.col.baht"), num: true, sum: true, value: (r) => r.baht, html: (r) => fmtBaht(r.baht, 2) },
    ];
  }
  if (tab === "out") {
    return [
      { key: "rank", label: t("rep.col.rank"), num: true, value: (r) => r.rank, html: (r) => `<span class="font-bold text-gray-400">${r.rank}</span>` },
      { key: "sku", label: t("rep.col.sku"), value: (r) => skuLabel(r), html: (r) => `<span class="font-bold text-gray-900">${esc(skuLabel(r))}</span>`, sticky: true },
      { key: "sold", label: t("rep.col.sold"), num: true, sum: true, value: (r) => r.sold, html: (r) => `<span class="font-bold text-gray-900">${fmtInt(r.sold)}</span>` },
      { key: "sold_lak", label: t("rep.col.outValue"), num: true, sum: true, value: (r) => r.sold_lak, html: (r) => fmtLak(r.sold_lak) },
      { key: "per_day", label: t("rep.col.perDay"), num: true, value: (r) => r.per_day, html: (r) => days1(r.per_day) },
      { key: "prev_sold", label: t("rep.col.prev"), num: true, sum: true, value: (r) => r.prev_sold, html: (r) => num(r.prev_sold) },
      { key: "retail", label: t("grid.retail"), num: true, sum: true, value: (r) => r.retail, html: (r) => num(r.retail) },
      { key: "wholesale", label: t("grid.wholesale"), num: true, sum: true, value: (r) => r.wholesale, html: (r) => num(r.wholesale) },
      { key: "withdraw", label: t("grid.withdraw"), num: true, sum: true, value: (r) => r.withdraw, html: (r) => num(r.withdraw) },
      { key: "returned", label: t("grid.destock"), num: true, sum: true, value: (r) => r.returned, html: (r) => num(r.returned) },
      { key: "sold_baht", label: t("rep.col.baht"), num: true, sum: true, value: (r) => r.sold_baht, html: (r) => fmtBaht(r.sold_baht, 2) },
      { key: "stock_in", label: t("rep.col.stockIn"), num: true, sum: true, value: (r) => r.stock_in, html: (r) => num(r.stock_in) },
      { key: "holding", label: t("rep.col.holding"), num: true, sum: true, value: (r) => r.holding, html: (r) => num(r.holding) },
    ];
  }
  return [
    { key: "case", label: t("rep.col.case"), value: (r) => `${r.display_name} ${r.desk_id}`, html: (r) => `<span class="font-bold text-gray-900">${esc(r.display_name)}</span> <span class="text-gray-500">${esc(r.desk_id)}</span>`, sticky: true },
    ...(multiBranch ? [{ key: "branch", label: t("rep.col.branch"), value: (r) => branchName(r.branch_id), html: (r) => esc(branchName(r.branch_id)) }] : []),
    { key: "sold", label: t("rep.col.sold"), num: true, sum: true, value: (r) => r.sold, html: (r) => `<span class="font-bold text-gray-900">${fmtInt(r.sold)}</span>` },
    { key: "sold_lak", label: t("rep.col.outValue"), num: true, sum: true, value: (r) => r.sold_lak, html: (r) => fmtLak(r.sold_lak) },
    { key: "held_lak", label: t("rep.col.held"), num: true, sum: true, value: (r) => r.held_lak, html: (r) => fmtLak(r.held_lak) },
    { key: "turn_pct", label: t("rep.col.turn"), num: true, value: (r) => r.turn_pct, html: (r) => `${Math.round(r.turn_pct)}%` },
    { key: "retail", label: t("grid.retail"), num: true, sum: true, value: (r) => r.retail, html: (r) => num(r.retail) },
    { key: "wholesale", label: t("grid.wholesale"), num: true, sum: true, value: (r) => r.wholesale, html: (r) => num(r.wholesale) },
    { key: "withdraw", label: t("grid.withdraw"), num: true, sum: true, value: (r) => r.withdraw, html: (r) => num(r.withdraw) },
    { key: "returned", label: t("grid.destock"), num: true, sum: true, value: (r) => r.returned, html: (r) => num(r.returned) },
    { key: "stock_in", label: t("rep.col.stockIn"), num: true, sum: true, value: (r) => r.stock_in, html: (r) => num(r.stock_in) },
    { key: "held_pcs", label: t("rep.col.holding"), num: true, sum: true, value: (r) => r.held_pcs, html: (r) => num(r.held_pcs) },
    { key: "last_date", label: t("rep.col.lastDay"), value: (r) => r.last_date ?? "", html: (r) => esc(r.last_date ? r.last_date.slice(5) : dash) },
  ];
}

function rowsFor(tab, d) {
  if (tab === "out") return d.stockOut.map((r, i) => ({ ...r, rank: i + 1 }));
  if (tab === "cases") return d.cases;
  const f = state.report.posFilter;
  return d.positions.filter((r) => {
    if (f === "all") return true;
    if (f === "decide") return r.band === "critical" || r.band === "warning";
    if (f === "noAction") return r.action === "none";
    if (f === "slow") return (r.band === "long" || r.band === "no_sales") && r.position > 0;
    return r.band === f;
  });
}

function filterCount(d, f) {
  const saved = state.report.posFilter;
  state.report.posFilter = f;
  const n = rowsFor("position", d).length;
  state.report.posFilter = saved;
  return n;
}

function filterLabel(f, slowDays) {
  if (f === "all") return t("rep.filter.all");
  if (f === "decide") return t("rep.filter.decide");
  if (f === "noAction") return t("rep.filter.noAction");
  if (f === "slow") return t("exec.q.slow").replace(/\?$/, "");
  return tf(`exec.band.${f}`, { d: slowDays });
}

function sorted(rows, cols, tab) {
  const s = state.report.sort[tab];
  if (!s) return rows;
  const col = cols.find((c) => c.key === s.key);
  if (!col) return rows;
  const val = col.sortValue ?? col.value;
  const dir = s.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}

function tableHtml(cols, rows, tab) {
  const s = state.report.sort[tab];
  const totals = cols.map((c) => (c.sum ? rows.reduce((acc, r) => acc + (Number(c.value(r)) || 0), 0) : null));
  const fmtTotal = (c, v) => (c.key.endsWith("_lak") ? fmtLak(v) : c.key.includes("baht") ? fmtBaht(v, 2) : fmtInt(v));
  const sticky = "sticky left-0 z-10";
  return `<div class="max-w-full overflow-x-auto rounded-xl border border-hairline bg-white">
    <table class="min-w-full border-collapse text-[11px] md:text-xs">
      <thead class="bg-gray-50 text-gray-600"><tr>
        ${cols
          .map((c) => {
            const on = s?.key === c.key;
            const aria = on ? (s.dir === "asc" ? "ascending" : "descending") : "none";
            return `<th scope="col" aria-sort="${aria}" class="${c.sticky ? `${sticky} bg-gray-50` : ""} whitespace-nowrap px-2.5 py-2 font-semibold ${c.num ? "text-right" : "text-left"}">
              <button type="button" data-sort="${c.key}" aria-label="${esc(tf("rep.sortBy", { col: c.label }))}" class="focus-ring inline-flex items-center gap-1 ${on ? "text-brand-700" : ""}">${esc(c.label)}${on ? (s.dir === "asc" ? " ↑" : " ↓") : ""}</button>
            </th>`;
          })
          .join("")}
      </tr></thead>
      <tbody class="divide-y divide-hairline text-gray-700">
        ${rows
          .map(
            (r) => `<tr>${cols
              .map((c) => `<td class="${c.sticky ? `${sticky} max-w-[150px] truncate bg-white` : ""} px-2.5 py-2 ${c.num ? "text-right tnum" : ""} ${c.sticky ? "" : "whitespace-nowrap"}">${c.html(r)}</td>`)
              .join("")}</tr>`
          )
          .join("")}
      </tbody>
      ${
        rows.length > 1
          ? `<tfoot class="border-t-2 border-gray-200 bg-gray-50 font-extrabold text-gray-900"><tr>
        ${cols.map((c, i) => `<td class="${c.sticky ? `${sticky} bg-gray-50` : ""} whitespace-nowrap px-2.5 py-2 ${c.num ? "text-right tnum" : ""}">${c.sticky ? t("rep.total") : totals[i] != null ? fmtTotal(c, totals[i]) : ""}</td>`).join("")}
      </tr></tfoot>`
          : ""
      }
    </table></div>`;
}

async function exportXlsx(tab, cols, rows, d) {
  try {
    const XLSX = await loadXlsx();
    const aoa = [cols.map((c) => c.label), ...rows.map((r) => cols.map((c) => c.value(r) ?? ""))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, t(`rep.tab.${tab}`).slice(0, 31));
    const scope = state.exec.branch ?? "all";
    XLSX.writeFile(wb, `kpv-${tab}-${scope}-${d.period.from}_${d.period.to}.xlsx`);
    toast(t("rep.exported"), "success");
  } catch (err) {
    toast(err?.message || t("err.SERVER_ERROR"), "danger");
  }
}

// ---------------------------------------------------------------------------
export async function mountExecReport(onSwitch) {
  const tab = state.report.tab;
  const el = document.getElementById("topbar-slot");
  el.innerHTML = `
    <div>
      <h1 class="text-lg font-extrabold text-gray-900">${t("rep.title")}</h1>
      <p class="text-[11px] font-medium text-gray-600">${t("rep.subtitle")}</p>
    </div>
    ${reportTabsHtml()}
    ${execFiltersHtml()}
    ${
      tab !== "cases"
        ? `<div class="relative mt-2">
      <svg class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path stroke-linecap="round" d="M21 21l-4.3-4.3"/></svg>
      <input id="exec-search" type="search" aria-label="${t("rep.search")}" placeholder="${t("rep.search")}" value="${esc(state.report.search)}" class="input-filled pl-9" />
    </div>`
        : ""
    }`;
  bindReportTabs(onSwitch);
  bindExecFilters(() => refresh());
  document.getElementById("exec-search")?.addEventListener(
    "input",
    debounce((e) => {
      state.report.search = e.target.value;
      paint();
    }, 200)
  );

  const root = document.getElementById("view-root");
  let data = null;

  async function refresh() {
    root.innerHTML = skeletonTable(8, 5);
    try {
      data = await loadExecutive();
    } catch (err) {
      root.innerHTML = `<div class="card px-4 py-8 text-center"><p class="text-sm font-semibold text-gray-700">${t("exec.loadError")}</p>
        <button id="rep-retry" class="btn-secondary mt-4">${t("exec.retry")}</button></div>`;
      document.getElementById("rep-retry").addEventListener("click", refresh);
      return;
    }
    if (root.isConnected) paint();
  }

  function paint() {
    if (!data) return;
    const d = data;
    const cols = columnsFor(tab, d);
    const q = state.report.search.trim().toLowerCase();
    let rows = rowsFor(tab, d);
    if (q && tab !== "cases") rows = rows.filter((r) => skuLabel(r).toLowerCase().includes(q) || r.sku_id.toLowerCase().includes(q) || (r.name_en ?? "").toLowerCase().includes(q));
    rows = sorted(rows, cols, tab);
    const chips =
      tab === "position"
        ? `<div class="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 no-scrollbar">
          ${POSITION_FILTERS.map((f) => {
            const n = filterCount(d, f);
            if (n === 0 && f !== "all" && f !== state.report.posFilter) return "";
            const on = state.report.posFilter === f;
            return `<button type="button" data-pos-filter="${f}" aria-pressed="${on}" class="chip shrink-0 whitespace-nowrap ${on ? "border-brand-600 bg-brand-600 text-white" : "border-hairline bg-white text-gray-700"}">${esc(filterLabel(f, d.slowDays))} <span class="ml-1 tnum ${on ? "text-white/80" : "text-gray-500"}">${n}</span></button>`;
          }).join("")}
        </div>`
        : "";
    root.innerHTML = `
      ${chips}
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="text-[11px] font-medium text-gray-600">${esc(tf("rep.periodNote", { from: d.period.from, to: d.period.to }))} <span class="font-bold text-gray-800">${esc(tf("rep.rows", { n: rows.length }))}</span></p>
        <button id="rep-export" class="btn-secondary shrink-0 px-3 py-2 text-xs" ${rows.length ? "" : "disabled"}>${t("rep.export")}</button>
      </div>
      ${rows.length ? tableHtml(cols, rows, tab) : `<div class="card py-10 text-center text-sm text-gray-600">${t("rep.empty")}</div>`}
      <div class="h-8"></div>`;
    root.querySelectorAll("[data-pos-filter]").forEach((b) =>
      b.addEventListener("click", () => {
        state.report.posFilter = b.dataset.posFilter;
        paint();
      })
    );
    root.querySelectorAll("[data-sort]").forEach((b) =>
      b.addEventListener("click", () => {
        const cur = state.report.sort[tab];
        const col = cols.find((c) => c.key === b.dataset.sort);
        const firstDir = col?.num ? "desc" : "asc";
        state.report.sort[tab] = cur?.key === b.dataset.sort ? { key: cur.key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key: b.dataset.sort, dir: firstDir };
        paint();
      })
    );
    root.querySelector("#rep-export")?.addEventListener("click", () => exportXlsx(tab, cols, rows, d));
  }

  await refresh();
}
