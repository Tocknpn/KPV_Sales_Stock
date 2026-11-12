import { api } from "../api.js";
import { state, branchName, deskById } from "../state.js";
import { renderDonut, renderCapacityBar, renderBranchClusterChart, CATEGORY_COLORS } from "../charts.js";
import { openActionSheet } from "../ui.js";
import { fmtBaht, fmtInt, fmtLak, fmtLakSigned, fmtUsd, fmtPct, healthClasses, escapeHtml } from "../util.js";
import { t } from "../i18n.js";

const CATEGORY_OPTIONS = ["Gold Bars", "Necklaces", "Bracelets", "Rings & Accessories"];

function deskLabel(deskId) {
  const d = deskById(deskId);
  return d ? `${deskId} · ${d.display_name}` : deskId;
}

export async function mountDashboard() {
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
    const options = [{ label: t("documents.allBranches"), value: null }, ...state.meta.branches.map((b) => ({ label: b.name_en, value: b.branch_id }))];
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
    const options = [{ label: t("dashboard.allCategories"), value: null }, ...CATEGORY_OPTIONS.map((c) => ({ label: c, value: c }))];
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
  root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">Crunching portfolio numbers…</div>`;
  const data = await api.dashboard({
    period: state.dashboard.period,
    branchId: state.dashboard.branch ?? undefined,
    deskId: state.dashboard.desk ?? undefined,
    category: state.dashboard.category ?? undefined,
    stockFlag: state.dashboard.stockFlag ?? undefined,
  });
  render(root, data);
}

function watchlistRow(item) {
  const over = item.closing > item.reorder_level;
  return `
    <div class="flex items-center justify-between gap-2 py-1.5">
      <div class="min-w-0">
        <div class="truncate text-xs font-bold text-gray-900">${escapeHtml(item.name_en)}</div>
        <div class="text-[10px] text-gray-500">${escapeHtml(item.category)}</div>
      </div>
      <span class="status-pill shrink-0 ${over ? "bg-danger-bg text-danger" : "bg-warning-bg text-warning"}">${fmtInt(item.closing)} / ${fmtInt(item.reorder_level)}</span>
    </div>`;
}

function agingRow(item) {
  return `
    <div class="flex items-center justify-between gap-2 py-1.5">
      <div class="min-w-0">
        <div class="truncate text-xs font-bold text-gray-900">${escapeHtml(item.name_en)}</div>
        <div class="text-[10px] text-gray-500">${escapeHtml(item.category)} · ${escapeHtml(item.branch_id)}</div>
      </div>
      <span class="status-pill shrink-0 bg-gray-100 text-gray-600">${fmtInt(item.estDays)} ${t("dashboard.days")}</span>
    </div>`;
}

function render(root, data) {
  const { portfolio, capacity, donut, branchCluster, branchCards, movement, watchlist, aging } = data;

  root.innerHTML = `
    <div class="card bg-gradient-to-br from-brand-600 to-brand-800 p-5 text-white shadow-pop">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-white/70">Total Physical Gold Stock</span>
        <span class="status-pill bg-white/15 text-white">${fmtPct(portfolio.audit_balanced_pct, 0)} Balanced</span>
      </div>
      <div class="mt-1.5 flex items-baseline gap-2">
        <span class="text-3xl font-extrabold">${fmtBaht(portfolio.total_baht_gold)}</span>
        <span class="text-sm font-semibold text-white/80">Baht Gold</span>
      </div>
      <div class="text-xs font-medium text-white/70">${fmtInt(portfolio.total_pcs)} Pcs across all branches</div>
      <div class="mt-3 flex items-center gap-4 border-t border-white/15 pt-3 text-sm font-bold">
        <span>${fmtUsd(portfolio.usd_value)} USD</span>
        <span class="text-white/50">/</span>
        <span>${fmtLak(portfolio.lak_value)} LAK</span>
      </div>
      <div class="mt-3 flex items-center justify-between rounded-lg bg-white/10 px-3 py-2 text-[11px] font-semibold">
        <span class="text-white/70">Spot Price</span>
        <span>1 Baht Gold = ${fmtInt(portfolio.spotLakPerBaht)} LAK</span>
      </div>
    </div>

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
        <span class="text-[11px] text-gray-600">${watchlist.overCount + watchlist.lowCount} flagged</span>
      </div>
      <p class="mb-2 text-[11px] text-gray-500">${t("dashboard.watchlistSubtitle")}</p>
      <div class="border-t border-hairline pt-2">
        <div class="mb-1 text-[10px] font-bold uppercase text-danger">${t("dashboard.overstock")} (${watchlist.overCount})</div>
        ${watchlist.topOver.length ? watchlist.topOver.map(watchlistRow).join("") : `<div class="py-1.5 text-[11px] text-gray-500">${t("dashboard.noOverstock")}</div>`}
      </div>
      <div class="mt-2 border-t border-hairline pt-2">
        <div class="mb-1 text-[10px] font-bold uppercase text-warning">${t("dashboard.lowStockFlag")} (${watchlist.lowCount})</div>
        ${watchlist.topLow.length ? watchlist.topLow.map(watchlistRow).join("") : `<div class="py-1.5 text-[11px] text-gray-500">${t("dashboard.noLowStock")}</div>`}
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
        <h2 class="text-sm font-extrabold text-gray-900">Inventory Status</h2>
        <span class="text-[11px] text-gray-600">${fmtInt(capacity.reduce((s, c) => s + c.count, 0))} SKUs</span>
      </div>
      <div id="capacity-bar"></div>
    </div>

    <div class="card mt-4 p-4">
      <h2 class="mb-3 text-sm font-extrabold text-gray-900">Category Breakdown</h2>
      <div id="donut-chart"></div>
    </div>

    <div class="card mt-4 p-4">
      <h2 class="mb-3 text-sm font-extrabold text-gray-900">Branch Stock vs. Safety Target</h2>
      <div id="cluster-chart"></div>
    </div>

    <h2 class="mb-3 mt-5 text-sm font-extrabold text-gray-900">Branch Operations</h2>
    <div id="branch-cards" class="grid grid-cols-1 gap-3 md:grid-cols-2"></div>
  `;

  renderCapacityBar(
    document.getElementById("capacity-bar"),
    capacity.map((c) => ({ label: c.label, pct: c.pct, count: c.count, color: { success: "#10b981", warning: "#f59e0b", danger: "#ee552b" }[c.color] }))
  );

  renderDonut(
    document.getElementById("donut-chart"),
    donut.map((d) => ({ label: d.category, pct: d.pct, value: d.count, color: CATEGORY_COLORS[d.category] })),
    { centerLabel: "SKUs", centerValue: fmtInt(donut.reduce((s, d) => s + d.count, 0)) }
  );

  renderBranchClusterChart(
    document.getElementById("cluster-chart"),
    branchCluster.map((b) => ({ label: b.name, pct: b.pct }))
  );

  const cardsEl = document.getElementById("branch-cards");
  cardsEl.innerHTML = branchCards
    .map((b) => {
      const h = healthClasses(b.health);
      return `
      <div class="card p-4">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm font-extrabold text-gray-900">${escapeHtml(b.name)}</div>
            <div lang="lo" class="lao text-[10px] text-gray-600">${escapeHtml(b.name_lo ?? "")}</div>
          </div>
          <span class="status-pill ${h.chip}">${b.health}</span>
        </div>
        <div class="mt-2.5 flex items-center gap-3">
          <div class="flex-1">
            <div class="flex items-baseline gap-1">
              <span class="text-lg font-extrabold text-gray-900">${fmtBaht(b.remainingBaht)}</span>
              <span class="text-[11px] font-semibold text-gray-600">Baht remaining</span>
            </div>
            <div class="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-gray-100">
              <div class="h-full rounded-full" style="width:${Math.min(100, b.pct)}%;background:${h.bar}"></div>
            </div>
          </div>
          <span class="text-sm font-extrabold" style="color:${h.bar}">${fmtPct(b.pct, 0)}</span>
        </div>
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
