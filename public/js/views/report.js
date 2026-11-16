import { api } from "../api.js";
import { state, branchName, deskById } from "../state.js";
import { openActionSheet } from "../ui.js";
import { fmtInt, fmtLak, fmtLakSigned, fmtBaht, icon, escapeHtml, debounce } from "../util.js";
import { renderFillBar } from "../charts.js";
import { t, productName } from "../i18n.js";
import { openDeskDay } from "./stock.js";

function deskLabel(deskId) {
  const d = deskById(deskId);
  return d ? `${deskId} · ${d.display_name}` : deskId;
}

function monthLabel(period) {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export async function mountReport() {
  gridCache = { key: null, data: null };
  renderTopbar();
  await refreshReport();
}

function renderTopbar() {
  const el = document.getElementById("topbar-slot");
  el.innerHTML = `
    <div>
      <h1 class="text-lg font-extrabold text-gray-900">${t("report.title")}</h1>
      <p class="text-[11px] font-medium text-gray-600">${t("report.subtitle")}</p>
    </div>
    <div class="mt-3 flex gap-2">
      <button id="period-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
        <span id="period-label">${monthLabel(state.report.period)}</span>
        <svg class="h-3.5 w-3.5 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
      <button id="branch-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
        <span id="branch-label" class="truncate">${state.report.branch ? branchName(state.report.branch) : t("documents.allBranches")}</span>
        <svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
      <button id="desk-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
        <span id="desk-label" class="truncate">${state.report.desk ? deskLabel(state.report.desk) : t("documents.allDesks")}</span>
        <svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>
    <div class="relative mt-2.5">
      <svg class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path stroke-linecap="round" d="M21 21l-4.3-4.3"/></svg>
      <input id="search-input" type="search" placeholder="${t("report.searchPlaceholder")}" value="${escapeHtml(state.report.q)}"
        class="input-filled pl-9" />
    </div>
  `;

  document.getElementById("period-select").addEventListener("click", () => {
    const options = [0, -1, -2, -3].map((offset) => {
      const base = new Date(`${state.meta.today}T00:00:00`);
      base.setMonth(base.getMonth() + offset);
      const period = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}`;
      return { label: monthLabel(period), value: period, selected: period === state.report.period };
    });
    openActionSheet(t("report.selectPeriod"), options, (opt) => {
      state.report.period = opt.value;
      document.getElementById("period-label").textContent = opt.label;
      refreshReport();
    });
  });

  document.getElementById("branch-select").addEventListener("click", () => {
    const options = [{ label: t("documents.allBranches"), value: null }, ...state.meta.branches.map((b) => ({ label: branchName(b.branch_id), value: b.branch_id }))];
    openActionSheet(
      t("documents.filterByBranch"),
      options.map((o) => ({ ...o, selected: o.value === state.report.branch })),
      (opt) => {
        state.report.branch = opt.value;
        state.report.desk = null;
        document.getElementById("branch-label").textContent = opt.label;
        document.getElementById("desk-label").textContent = t("documents.allDesks");
        refreshReport();
      }
    );
  });

  document.getElementById("desk-select").addEventListener("click", () => {
    const pool = state.report.branch ? state.meta.desks.filter((d) => d.branch_id === state.report.branch) : state.meta.desks;
    const options = [{ label: t("documents.allDesks"), value: null }, ...pool.map((d) => ({ label: `${d.desk_id} · ${d.display_name}`, value: d.desk_id }))];
    openActionSheet(
      t("documents.filterByDesk"),
      options.map((o) => ({ ...o, selected: o.value === state.report.desk })),
      (opt) => {
        state.report.desk = opt.value;
        document.getElementById("desk-label").textContent = opt.label;
        refreshReport();
      }
    );
  });

  document.getElementById("search-input").addEventListener(
    "input",
    debounce((e) => {
      state.report.q = e.target.value;
      refreshReport();
    }, 350)
  );
}

async function refreshReport() {
  const root = document.getElementById("view-root");
  root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">${t("report.loading")}</div>`;
  const data = await api.report({
    period: state.report.period,
    branchId: state.report.branch ?? undefined,
    deskId: state.report.desk ?? undefined,
    q: state.report.q || undefined,
  });
  render(root, data);
  renderGrid(root);
}

// The grid depends only on branch + month, not on the search box, so a typed
// search reuses the last answer.
let gridCache = { key: null, data: null };
async function loadGrid(branch, month) {
  const key = `${branch}|${month}`;
  if (gridCache.key === key) return gridCache.data;
  const data = await api.reportGrid(branch, month);
  gridCache = { key, data };
  return data;
}

// Issue grid (spec decision 8): cases x days of the selected month.
function gridCell(c) {
  if (!c) return "";
  if (c.kind === "ok") return `<span class="font-bold text-success" title="OK">✓</span>`;
  if (c.kind === "diff") return `<span class="font-bold text-danger">${escapeHtml(fmtBaht(c.diffBaht ?? 0, 2))}</span>`;
  if (c.kind === "warn") return `<span class="font-bold text-warning">⚠</span>`;
  return `<span class="text-gray-500">·</span>`;
}

function gridTable(grid) {
  return `<div class="max-w-full overflow-x-auto rounded-xl border border-hairline bg-white">
      <table class="min-w-full border-collapse text-[11px]">
        <thead><tr>
          <th class="sticky left-0 z-10 bg-gray-50 px-2 py-2 text-left font-semibold text-gray-600"></th>
          ${grid.dates.map((d) => `<th class="bg-gray-50 px-1.5 py-2 text-center font-semibold text-gray-600">${Number(d.slice(8))}</th>`).join("")}
        </tr></thead>
        <tbody class="divide-y divide-hairline">
          ${grid.rows
            .map(
              (r) => `<tr>
            <th class="sticky left-0 z-10 max-w-[110px] truncate whitespace-nowrap bg-white px-2 py-2 text-left font-semibold text-gray-900">${escapeHtml(r.name)}</th>
            ${r.cells.map((c, i) => `<td class="whitespace-nowrap px-1.5 py-2 text-center ${c ? "cursor-pointer" : ""}" ${c ? `data-desk="${escapeHtml(r.deskId)}" data-date="${escapeHtml(grid.dates[i])}"` : ""}>${gridCell(c)}</td>`).join("")}
          </tr>`
            )
            .join("")}
        </tbody>
      </table></div>`;
}

async function renderGrid(root) {
  const section = document.createElement("section");
  section.className = "mt-4";
  section.innerHTML = `<h2 class="text-sm font-extrabold text-gray-900">${t("report.grid")}</h2>
    <p class="mt-0.5 text-[11px] text-gray-600">${t("report.gridLegend")}</p>
    <div id="grid-body" class="mt-2 min-w-0"><p class="py-6 text-center text-sm text-gray-600">${t("report.loading")}</p></div>`;
  // Right under the month picker: first thing in the view.
  root.prepend(section);
  const host = section.querySelector("#grid-body");
  // One grid per branch: the chosen one, or every branch under "All branches".
  const all = state.meta.branches ?? [];
  const branches = state.report.branch ? all.filter((b) => b.branch_id === state.report.branch) : all;
  const list = branches.length ? branches : [{ branch_id: state.report.branch ?? undefined }];
  try {
    const grids = await Promise.all(list.map((b) => loadGrid(b.branch_id, state.report.period)));
    if (!host.isConnected) return;
    host.innerHTML = grids
      .map((grid, i) => {
        const b = list[i];
        const name = b.branch_id ? branchName(b.branch_id) : "";
        return `<div class="${i > 0 ? "mt-4" : ""}">
          ${name ? `<h3 class="mb-1.5 text-xs font-extrabold text-gray-800">${escapeHtml(name)}</h3>` : ""}
          ${grid.rows.length ? gridTable(grid) : `<p class="py-6 text-center text-sm text-gray-600">${t("report.gridEmpty")}</p>`}
        </div>`;
      })
      .join("");
    host.querySelectorAll("td[data-desk]").forEach((td) => td.addEventListener("click", () => openDeskDay(td.dataset.desk, td.dataset.date)));
  } catch (err) {
    host.innerHTML = `<p class="py-6 text-center text-sm text-danger">${escapeHtml(err.message || t("err.SERVER_ERROR"))}</p>`;
  }
}

function render(root, data) {
  const { kpi, items, ledgerRows, audit, netClosingLak } = data;

  root.innerHTML = `
    <div class="grid grid-cols-2 gap-2.5 md:grid-cols-4">
      <div class="card p-3">
        <div class="text-[10px] font-bold uppercase text-gray-600">${t("report.opening")}</div>
        <div class="mt-1 text-base font-extrabold text-gray-900">${fmtLak(kpi.opening.lak)}</div>
        <div class="text-[11px] text-gray-600">${fmtInt(kpi.opening.pcs)} pcs</div>
      </div>
      <div class="card p-3">
        <div class="text-[10px] font-bold uppercase text-gray-600">${t("report.closing")}</div>
        <div class="mt-1 text-base font-extrabold text-gray-900">${fmtLak(kpi.closing.lak)}</div>
        <div class="text-[11px] text-gray-600">${fmtInt(kpi.closing.pcs)} pcs</div>
      </div>
      <div class="card p-3">
        <div class="text-[10px] font-bold uppercase text-gray-600">${t("report.stockIn")}</div>
        <div class="mt-1 text-base font-extrabold text-success">${fmtLakSigned(kpi.in.lak)}</div>
        <div class="text-[11px] text-success">+${fmtInt(kpi.in.pcs)} pcs</div>
      </div>
      <div class="card p-3">
        <div class="text-[10px] font-bold uppercase text-gray-600">${t("report.stockOut")}</div>
        <div class="mt-1 text-base font-extrabold text-warning">${fmtLakSigned(-kpi.out.lak)}</div>
        <div class="text-[11px] text-warning">-${fmtInt(kpi.out.pcs)} pcs</div>
      </div>
    </div>
    ${
      kpi.adjust.pcs !== 0
        ? `<div class="mt-2.5 flex items-center justify-between rounded-xl bg-warning-bg px-3.5 py-2.5 text-xs font-bold text-warning">
             <span>${t("report.countAdjust")}</span>
             <span>${kpi.adjust.pcs > 0 ? "+" : ""}${fmtInt(kpi.adjust.pcs)} pcs · ${fmtLakSigned(kpi.adjust.lak)}</span>
           </div>`
        : ""
    }

    <div class="mt-4 flex items-center justify-between">
      <h2 class="text-sm font-extrabold text-gray-900">${t("report.itemBreakdown")}</h2>
      <div class="flex rounded-lg bg-gray-100 p-0.5">
        <button data-toggle="cards" class="view-toggle rounded-md px-2.5 py-1 text-[11px] font-bold">${t("documents.cardView")}</button>
        <button data-toggle="table" class="view-toggle rounded-md px-2.5 py-1 text-[11px] font-bold">${t("documents.tableView")}</button>
      </div>
    </div>

    <div id="cards-view" class="mt-3 flex flex-col gap-2.5"></div>
    <div id="table-view" class="mt-3 hidden overflow-x-auto rounded-xl border border-hairline"></div>

    <div class="mt-4 flex items-center gap-2 rounded-xl bg-gray-50 px-3.5 py-2.5">
      <span class="flex h-6 w-6 items-center justify-center rounded-full ${audit.verified ? "bg-success-bg text-success" : "bg-warning-bg text-warning"}">
        <svg class="h-3.5 w-3.5 md:h-4 md:w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
      </span>
      <span class="text-xs font-semibold text-gray-600">${audit.verified ? t("report.allDaysDone") : t("report.daysNotDone")} · ${audit.doneDays}/${audit.totalDays}</span>
    </div>

    <div class="h-20"></div>
  `;

  if (items.length === 0) {
    document.getElementById("cards-view").innerHTML = `<div class="card py-10 text-center text-sm text-gray-600">${t("report.noMovement")}</div>`;
    document.getElementById("table-view").innerHTML = `<div class="py-10 text-center text-sm text-gray-600">${t("report.noMovement")}</div>`;
  } else {
    document.getElementById("cards-view").innerHTML = items
      .map((it) => {
        const deltaUp = it.delta >= 0;
        return `
      <div class="card flex items-center gap-3 p-3">
        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">${icon(it.icon, "h-5 w-5")}</span>
        <div class="flex-1">
          <div class="flex items-center justify-between gap-2">
            <span class="truncate text-xs font-bold text-gray-900">${escapeHtml(productName(it.name_en, it.name_lo))}</span>
            <span class="status-pill shrink-0 ${deltaUp ? "bg-success-bg text-success" : "bg-danger-bg text-danger"}">${deltaUp ? "+" : ""}${it.delta}</span>
          </div>
          <div class="mt-1 flex items-center justify-between text-[11px] text-gray-600">
            <span>${it.closing_qty} pcs · ${fmtLak(it.value_lak)}</span><span>${escapeHtml(it.desk_id)}</span>
          </div>
          ${renderFillBar(it.fillPct, deltaUp ? "#10b981" : "#f59e0b")}
        </div>
      </div>`;
      })
      .join("");

    document.getElementById("table-view").innerHTML = `
      <table class="w-full text-left text-[11px] md:text-sm">
        <thead class="bg-gray-50 text-gray-600">
          <tr>
            <th class="px-3 py-2 font-semibold">${t("documents.date")}</th>
            <th class="px-3 py-2 font-semibold">${t("documents.desk")}</th>
            <th class="px-3 py-2 font-semibold">${t("documents.item")}</th>
            <th class="px-3 py-2 text-right font-semibold">${t("stock.colOpen")}</th>
            <th class="px-3 py-2 text-right font-semibold">${t("stock.colIn")}</th>
            <th class="px-3 py-2 text-right font-semibold">${t("report.outShort")}</th>
            <th class="px-3 py-2 text-right font-semibold">${t("stock.colClose")}</th>
            <th class="px-3 py-2 text-right font-semibold">${t("stock.colCounted")}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-hairline">
          ${ledgerRows
            .map(
              (r) => `
            <tr>
              <td class="whitespace-nowrap px-3 py-2 text-gray-500">${r.ledger_date.slice(5)}</td>
              <td class="px-3 py-2 text-gray-500">${r.desk_id}</td>
              <td class="px-3 py-2 font-semibold text-gray-800">${escapeHtml(productName(r.name_en, r.name_lo))}</td>
              <td class="px-3 py-2 text-right text-gray-500">${r.opening_qty}</td>
              <td class="px-3 py-2 text-right text-success">+${r.stock_in + r.transfer_in + Math.max(r.move_qty ?? 0, 0)}</td>
              <td class="px-3 py-2 text-right text-warning">-${(r.stock_out ?? r.retail_sale + r.wholesale + r.destock) + r.transfer_out + r.move + Math.max(-(r.move_qty ?? 0), 0)}</td>
              <td class="px-3 py-2 text-right font-bold text-gray-900">${r.closing_qty}</td>
              <td class="px-3 py-2 text-right ${r.counted_qty != null && r.counted_qty !== r.closing_qty ? "font-bold text-danger" : "text-gray-500"}">${r.counted_qty ?? "—"}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  }

  const applyToggle = (which) => {
    root.querySelectorAll(".view-toggle").forEach((btn) => {
      const active = btn.dataset.toggle === which;
      btn.classList.toggle("bg-white", active);
      btn.classList.toggle("shadow-card", active);
      btn.classList.toggle("text-brand-700", active);
      btn.classList.toggle("text-gray-600", !active);
    });
    document.getElementById("cards-view").classList.toggle("hidden", which !== "cards");
    document.getElementById("table-view").classList.toggle("hidden", which !== "table");
  };
  root.querySelectorAll(".view-toggle").forEach((btn) => btn.addEventListener("click", () => applyToggle(btn.dataset.toggle)));
  applyToggle(state.report.view ?? "cards");
  root.querySelectorAll(".view-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.report.view = btn.dataset.toggle;
    })
  );

  renderFooter(netClosingLak);
}

function renderFooter(netClosingLak) {
  let footer = document.getElementById("report-footer");
  if (!footer) {
    footer = document.createElement("div");
    footer.id = "report-footer";
    footer.className = "fixed inset-x-0 bottom-[72px] z-20 mx-auto max-w-[430px] px-4";
    document.body.appendChild(footer);
  }
  footer.innerHTML = `
    <div class="flex items-center justify-between rounded-2xl bg-gray-900 px-4 py-3 text-white shadow-pop">
      <div>
        <div class="text-[10px] font-semibold uppercase text-white/50">${t("report.netClosing")}</div>
        <div class="text-base font-extrabold">${fmtLak(netClosingLak)}</div>
      </div>
    </div>`;
}

// The sticky footer lives outside #view-root (so it floats above the bottom
// nav), so app.js calls this before mounting any other view.
export function unmountReport() {
  document.getElementById("report-footer")?.remove();
}
