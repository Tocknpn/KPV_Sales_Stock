import { api } from "../api.js";
import { state, branchName, deskById } from "../state.js";
import { renderDonut, renderCapacityBar, categoryColor } from "../charts.js";
import { openActionSheet } from "../ui.js";
import { fmtBaht, fmtInt, fmtLak, fmtLakSigned, fmtUsd, escapeHtml } from "../util.js";
import { t, tf, pickName } from "../i18n.js";
import { isAdmin } from "../session.js";

// The category filter lists the SKU types the admin maintains in Settings.
let categoryOptions = [];

function deskLabel(deskId) {
  const d = deskById(deskId);
  return d ? `${deskId} · ${d.display_name}` : deskId;
}

export async function mountDashboard() {
  try {
    categoryOptions = (await api.skuTypes()).types.filter((ty) => ty.active).map((ty) => ty.name_en);
  } catch {
    categoryOptions = [];
  }
  if (state.dashboard.category && !categoryOptions.includes(state.dashboard.category)) state.dashboard.category = null;
  renderTopbar();
  await refreshDashboard();
}

function renderTopbar() {
  const el = document.getElementById("topbar-slot");
  el.innerHTML = `
    <div>
      <h1 class="text-lg font-extrabold text-gray-900">${t("dashboard.title")}</h1>
      <p class="text-[11px] font-medium text-gray-600">${t("dashboard.subtitle")}</p>
    </div>
    <div class="mt-3 flex gap-2">
      <button id="period-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
        <span id="period-label">${state.dashboard.period === "mtd" ? t("dashboard.mtd") : t("dashboard.today")}</span>
        <svg class="h-3.5 w-3.5 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
      <button id="branch-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
        <span id="branch-label" class="truncate">${state.dashboard.branch ? branchName(state.dashboard.branch) : t("documents.allBranches")}</span>
        <svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
      <button id="desk-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
        <span id="desk-label" class="truncate">${state.dashboard.desk ? deskLabel(state.dashboard.desk) : t("documents.allDesks")}</span>
        <svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>
    <div class="mt-2 flex gap-2">
      <button id="category-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
        <span id="category-label" class="truncate">${state.dashboard.category || t("dashboard.allCategories")}</span>
        <svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
      <button id="stock-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
        <span id="stock-label" class="truncate">${state.dashboard.stockFlag === "over" ? t("dashboard.overstock") : state.dashboard.stockFlag === "low" ? t("dashboard.lowStockFlag") : t("dashboard.allStock")}</span>
        <svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>
  `;

  document.getElementById("period-select").addEventListener("click", () => {
    const options = [
      { label: t("dashboard.today"), value: "today", selected: state.dashboard.period === "today" },
      { label: t("dashboard.mtd"), value: "mtd", selected: state.dashboard.period === "mtd" },
    ];
    openActionSheet(t("dashboard.filterByPeriod"), options, (opt) => {
      state.dashboard.period = opt.value;
      document.getElementById("period-label").textContent = opt.label;
      refreshDashboard();
    });
  });

  document.getElementById("branch-select").addEventListener("click", () => {
    const options = [{ label: t("documents.allBranches"), value: null }, ...state.meta.branches.map((b) => ({ label: branchName(b.branch_id), value: b.branch_id }))];
    openActionSheet(
      t("documents.filterByBranch"),
      options.map((o) => ({ ...o, selected: o.value === state.dashboard.branch })),
      (opt) => {
        state.dashboard.branch = opt.value;
        state.dashboard.desk = null;
        document.getElementById("branch-label").textContent = opt.label;
        document.getElementById("desk-label").textContent = t("documents.allDesks");
        refreshDashboard();
      }
    );
  });

  document.getElementById("desk-select").addEventListener("click", () => {
    const pool = state.dashboard.branch ? state.meta.desks.filter((d) => d.branch_id === state.dashboard.branch) : state.meta.desks;
    const options = [{ label: t("documents.allDesks"), value: null }, ...pool.map((d) => ({ label: `${d.desk_id} · ${d.display_name}`, value: d.desk_id }))];
    openActionSheet(
      t("documents.filterByDesk"),
      options.map((o) => ({ ...o, selected: o.value === state.dashboard.desk })),
      (opt) => {
        state.dashboard.desk = opt.value;
        document.getElementById("desk-label").textContent = opt.label;
        refreshDashboard();
      }
    );
  });

  document.getElementById("category-select").addEventListener("click", () => {
    const options = [{ label: t("dashboard.allCategories"), value: null }, ...categoryOptions.map((c) => ({ label: c, value: c }))];
    openActionSheet(
      t("dashboard.filterByCategory"),
      options.map((o) => ({ ...o, selected: o.value === state.dashboard.category })),
      (opt) => {
        state.dashboard.category = opt.value;
        document.getElementById("category-label").textContent = opt.label;
        refreshDashboard();
      }
    );
  });

  document.getElementById("stock-select").addEventListener("click", () => {
    const options = [
      { label: t("dashboard.allStock"), value: null },
      { label: t("dashboard.lowStockFlag"), value: "low" },
      { label: t("dashboard.overstock"), value: "over" },
    ];
    openActionSheet(
      t("dashboard.filterByStock"),
      options.map((o) => ({ ...o, selected: o.value === state.dashboard.stockFlag })),
      (opt) => {
        state.dashboard.stockFlag = opt.value;
        document.getElementById("stock-label").textContent = opt.label;
        refreshDashboard();
      }
    );
  });
}

async function refreshDashboard() {
  const root = document.getElementById("view-root");
  root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">${t("dashboard.loading")}</div>`;
  const data = await api.dashboard({
    period: state.dashboard.period,
    branchId: state.dashboard.branch ?? undefined,
    deskId: state.dashboard.desk ?? undefined,
    category: state.dashboard.category ?? undefined,
    stockFlag: state.dashboard.stockFlag ?? undefined,
  });
  render(root, data);
}

// Admin "All branches": today's case checks per branch, worst first. Computed from the
// cards of every branch (spec 3.4) so it matches what each branch sees.
async function loadCaseHealth() {
  let desks;
  try {
    ({ desks } = await api.deskCards(undefined, undefined));
  } catch {
    return;
  }
  const el = document.getElementById("case-health");
  if (!el) return;
  const byBranch = new Map();
  for (const d of desks) {
    const s = byBranch.get(d.branch_id) ?? { branch_id: d.branch_id, cases: 0, checked: 0, behind: 0, overdue: 0 };
    s.cases++;
    if (d.tier === "done_today") s.checked++;
    if (d.tier === "behind_1") s.behind++;
    if (d.tier === "overdue") s.overdue++;
    byBranch.set(d.branch_id, s);
  }
  const ratio = (r) => r.checked / (r.cases || 1);
  const rows = [...byBranch.values()].sort((a, b) => b.overdue - a.overdue || b.behind - a.behind || ratio(a) - ratio(b));
  if (!rows.length) return;
  const worst = (r) =>
    r.overdue
      ? { label: t("dashboard.worstOverdue"), cls: "bg-danger-bg text-danger", bar: "border-l-danger" }
      : r.behind
      ? { label: t("dashboard.worstBehind"), cls: "bg-warning-bg text-warning", bar: "border-l-amber-500" }
      : { label: t("dashboard.worstOk"), cls: "bg-success-bg text-success", bar: "border-l-success" };
  el.innerHTML = `
    <h2 class="mb-3 mt-5 text-sm font-extrabold text-gray-900">${t("dashboard.caseHealth")}</h2>
    <div class="card divide-y divide-hairline p-0">
      ${rows
        .map((r) => {
          const w = worst(r);
          const detail = [tf("dashboard.checkedOfTotal", { c: r.checked, n: r.cases }), r.behind ? tf("dashboard.behindN", { n: r.behind }) : "", r.overdue ? tf("dashboard.overdueN", { n: r.overdue }) : ""]
            .filter(Boolean)
            .join(" · ");
          return `<div class="flex items-center justify-between gap-2 border-l-4 px-4 py-3 ${w.bar}">
            <div class="min-w-0">
              <div class="truncate text-sm font-extrabold text-gray-900">${escapeHtml(branchName(r.branch_id))}</div>
              <div class="text-[11px] font-semibold text-gray-600">${escapeHtml(detail)}</div>
            </div>
            <span class="status-pill shrink-0 ${w.cls}">${w.label}</span>
          </div>`;
        })
        .join("")}
    </div>`;
}

function watchlistRow(item, kind) {
  return `
    <div class="flex items-center justify-between gap-2 py-1.5">
      <div class="min-w-0">
        <div class="truncate text-xs font-bold text-gray-900">${escapeHtml(pickName(item.name_en, item.name_lo))}</div>
        <div class="truncate text-[10px] text-gray-500">${escapeHtml(item.category)} · ${escapeHtml(deskLabel(item.desk_id))}</div>
      </div>
      <span class="status-pill shrink-0 ${kind === "over" ? "bg-danger-bg text-danger" : "bg-warning-bg text-warning"}" title="${t("dashboard.stockVsReorder")}">${fmtInt(item.closing)} / ${fmtInt(item.reorder_level)}</span>
    </div>`;
}

function agingRow(item) {
  return `
    <div class="flex items-center justify-between gap-2 py-1.5">
      <div class="min-w-0">
        <div class="truncate text-xs font-bold text-gray-900">${escapeHtml(pickName(item.name_en, item.name_lo))}</div>
        <div class="truncate text-[10px] text-gray-500">${escapeHtml(item.category)} · ${escapeHtml(deskLabel(item.desk_id))}</div>
      </div>
      <span class="status-pill shrink-0 bg-gray-100 text-gray-600">${fmtInt(item.estDays)} ${t("dashboard.days")}</span>
    </div>`;
}

function transitRow(item) {
  return `
    <div class="flex items-center justify-between gap-2 py-1.5">
      <div class="min-w-0">
        <div class="truncate text-xs font-bold text-gray-900">${fmtInt(item.qty)} × ${escapeHtml(item.name_en)}</div>
        <div class="truncate text-[10px] text-gray-500">${escapeHtml(item.from_desk_id)} → ${escapeHtml(item.to_desk_id)}</div>
      </div>
      <span class="status-pill shrink-0 bg-warning-bg text-warning">${item.sent_date.slice(5)}</span>
    </div>`;
}

function render(root, data) {
  const { portfolio, transit, capacity, donut, branchCards, movement, watchlist, aging } = data;
  const allDone = portfolio.desksTotal > 0 && portfolio.desksDoneToday === portfolio.desksTotal;

  root.innerHTML = `
    <div class="card bg-gradient-to-br from-brand-600 to-brand-800 p-5 text-white shadow-pop">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-white/70">${t("dashboard.totalGold")}</span>
        <span class="status-pill ${allDone ? "bg-white text-brand-700" : "bg-white/15 text-white"}">${portfolio.desksDoneToday}/${portfolio.desksTotal} ${t("dashboard.desksDone")}</span>
      </div>
      <div class="mt-1.5 flex items-baseline gap-2">
        <span class="text-3xl font-extrabold">${fmtBaht(portfolio.total_baht_gold)}</span>
        <span class="text-sm font-semibold text-white/80">Baht</span>
      </div>
      <div class="text-xs font-medium text-white/70">${fmtInt(portfolio.total_pcs)} pcs</div>
      <div class="mt-3 flex items-center gap-4 border-t border-white/15 pt-3 text-sm font-bold">
        <span>${fmtLak(portfolio.lak_value)} LAK</span>
        ${portfolio.usdToLakRate > 0 ? `<span class="text-white/50">/</span><span>${fmtUsd(portfolio.usd_value)} USD</span>` : ""}
      </div>
      <div class="mt-3 flex items-center justify-between rounded-lg bg-white/10 px-3 py-2 text-[11px] font-semibold">
        <span class="text-white/70">${t("dashboard.goldPrice")}</span>
        <span>${portfolio.spotLakPerBaht > 0 ? `1 Baht = ${fmtInt(portfolio.spotLakPerBaht)} LAK` : t("dashboard.goldPriceMissing")}</span>
      </div>
    </div>

    ${
      transit.count > 0
        ? `<div class="card mt-4 p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="text-sm font-extrabold text-gray-900">${t("dashboard.inTransit")}</h2>
        <span class="text-[11px] font-bold text-warning">${fmtInt(transit.pcs)} pcs · ${fmtBaht(transit.baht)} Baht</span>
      </div>
      <p class="mb-1 text-[11px] text-gray-500">${t("dashboard.inTransitSubtitle")}</p>
      <div class="divide-y divide-hairline border-t border-hairline">${transit.items.map(transitRow).join("")}</div>
    </div>`
        : ""
    }

    <div class="card mt-4 p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-extrabold text-gray-900">${t("dashboard.movement")}</h2>
        <span class="text-[11px] text-gray-600">${state.dashboard.period === "mtd" ? t("dashboard.mtd") : t("dashboard.today")}</span>
      </div>
      <div class="grid grid-cols-2 gap-2.5">
        <div class="rounded-xl bg-gray-50 p-3">
          <div class="text-[10px] font-bold uppercase text-gray-600">${t("dashboard.stockIn")}</div>
          <div class="mt-1 text-base font-extrabold text-success">${fmtLakSigned(movement.inLak)}</div>
          <div class="text-[11px] text-success">+${fmtInt(movement.inPcs)} pcs</div>
        </div>
        <div class="rounded-xl bg-gray-50 p-3">
          <div class="text-[10px] font-bold uppercase text-gray-600">${t("dashboard.stockOut")}</div>
          <div class="mt-1 text-base font-extrabold text-warning">${fmtLakSigned(-movement.outLak)}</div>
          <div class="text-[11px] text-warning">-${fmtInt(movement.outPcs)} pcs</div>
        </div>
      </div>
    </div>

    <div class="card mt-4 p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="text-sm font-extrabold text-gray-900">${t("dashboard.watchlist")}</h2>
        <span class="text-[11px] text-gray-600">${watchlist.overCount + watchlist.lowCount}</span>
      </div>
      <p class="mb-2 text-[11px] text-gray-500">${t("dashboard.watchlistSubtitle")}</p>
      <div class="border-t border-hairline pt-2">
        <div class="mb-1 text-[10px] font-bold uppercase text-warning">${t("dashboard.lowStockFlag")} (${watchlist.lowCount})</div>
        ${watchlist.topLow.length ? watchlist.topLow.map((i) => watchlistRow(i, "low")).join("") : `<div class="py-1.5 text-[11px] text-gray-500">${t("dashboard.noLowStock")}</div>`}
      </div>
      <div class="mt-2 border-t border-hairline pt-2">
        <div class="mb-1 text-[10px] font-bold uppercase text-danger">${t("dashboard.overstock")} (${watchlist.overCount})</div>
        ${watchlist.topOver.length ? watchlist.topOver.map((i) => watchlistRow(i, "over")).join("") : `<div class="py-1.5 text-[11px] text-gray-500">${t("dashboard.noOverstock")}</div>`}
      </div>
    </div>

    <div class="card mt-4 p-4">
      <h2 class="text-sm font-extrabold text-gray-900">${t("dashboard.avgStockLife")}</h2>
      <p class="mb-2 text-[11px] text-gray-500">${t("dashboard.avgStockLifeSubtitle")}</p>
      <div class="flex items-baseline gap-1.5 border-b border-hairline pb-2">
        <span class="text-2xl font-extrabold text-gray-900">${aging.avgDays ? fmtInt(aging.avgDays) : "–"}</span>
        <span class="text-xs font-semibold text-gray-600">${t("dashboard.days")} ${t("dashboard.estimate")}</span>
      </div>
      <div class="pt-2">
        ${aging.topAged.length ? aging.topAged.map(agingRow).join("") : `<div class="py-1.5 text-[11px] text-gray-500">${t("dashboard.noAgingData")}</div>`}
      </div>
    </div>

    <div class="card mt-4 p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-extrabold text-gray-900">${t("dashboard.inventoryStatus")}</h2>
        <span class="text-[11px] text-gray-600">${fmtInt(capacity.reduce((s, c) => s + c.count, 0))} ${t("dashboard.lines")}</span>
      </div>
      <div id="capacity-bar"></div>
    </div>

    <div class="card mt-4 p-4">
      <h2 class="mb-3 text-sm font-extrabold text-gray-900">${t("dashboard.goldByType")}</h2>
      <div id="donut-chart"></div>
    </div>

    <div id="case-health"></div>

    <h2 class="mb-3 mt-5 text-sm font-extrabold text-gray-900">${t("dashboard.branches")}</h2>
    <div id="branch-cards" class="grid grid-cols-1 gap-3 md:grid-cols-2"></div>
  `;

  if (isAdmin(state.user) && !state.dashboard.branch) loadCaseHealth();

  const statusLabel = { in_stock: t("dashboard.inStock"), low_stock: t("dashboard.lowStockFlag"), depleted: t("dashboard.depleted") };
  renderCapacityBar(
    document.getElementById("capacity-bar"),
    capacity.map((c) => ({ label: statusLabel[c.key], pct: c.pct, count: c.count, color: { success: "#10b981", warning: "#f59e0b", danger: "#ee552b" }[c.color] })),
    t("dashboard.lines")
  );

  const donutEl = document.getElementById("donut-chart");
  if (donut.length === 0) {
    donutEl.innerHTML = `<div class="py-6 text-center text-xs text-gray-500">${t("dashboard.noGold")}</div>`;
  } else {
    renderDonut(
      donutEl,
      donut.map((d, i) => ({ label: d.category, pct: d.pct, value: d.baht, color: categoryColor(d.category, i) })),
      { centerLabel: "Baht", centerValue: fmtBaht(donut.reduce((s, d) => s + d.baht, 0)) }
    );
  }

  const cardsEl = document.getElementById("branch-cards");
  cardsEl.innerHTML = branchCards
    .map((b) => {
      const done = b.desksTotal > 0 && b.desksDoneToday === b.desksTotal;
      return `
      <div class="card p-4">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="truncate text-sm font-extrabold text-gray-900">${escapeHtml(b.name)}</div>
            <div lang="lo" class="lao truncate text-[10px] text-gray-600">${escapeHtml(b.name_lo ?? "")}</div>
          </div>
          <span class="status-pill shrink-0 ${done ? "bg-success-bg text-success" : "bg-gray-100 text-gray-600"}">${b.desksDoneToday}/${b.desksTotal} ${t("dashboard.desksDone")}</span>
        </div>
        <div class="mt-2.5 flex items-baseline gap-1">
          <span class="text-lg font-extrabold text-gray-900">${fmtBaht(b.baht)}</span>
          <span class="text-[11px] font-semibold text-gray-600">Baht · ${fmtInt(b.pcs)} pcs · ${fmtLak(b.lakValue)}</span>
        </div>
        ${b.lowCount > 0 ? `<div class="mt-1 text-[11px] font-bold text-danger">⚠ ${b.lowCount} ${t("dashboard.lowStockFlag")}</div>` : ""}
        <button data-review="${b.branch_id}" class="btn-secondary mt-3 w-full py-2 text-xs">${t("dashboard.viewDocuments")}</button>
      </div>`;
    })
    .join("");

  cardsEl.querySelectorAll("[data-review]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.documents.branch = btn.dataset.review;
      window.switchView("documents");
    })
  );
}
