import { api } from "../api.js";
import { state, branchName } from "../state.js";
import { toast, openSheet, closeSheet, openActionSheet } from "../ui.js";
import { fmtBaht, fmtInt, fmtDate, icon, statusPillClasses, escapeHtml } from "../util.js";
import { t } from "../i18n.js";
import { renderCalendar } from "../calendar.js";
import { isAdmin } from "../session.js";

const PURITY_OPTIONS = ["96.5%", "99.99%"];
const STOCK_CUTOFF_HOUR = 15;
const STOCK_CUTOFF_MINUTE = 30;

// Guards the final "Mark Done" submission — stores shouldn't normally lock in
// their closing count before the day's cutoff, so this prompts for an
// explicit confirm when it's run early rather than blocking it outright.
function isBeforeStockCutoff() {
  const now = new Date();
  return now.getHours() < STOCK_CUTOFF_HOUR || (now.getHours() === STOCK_CUTOFF_HOUR && now.getMinutes() < STOCK_CUTOFF_MINUTE);
}

function statusLabel(status) {
  return (
    {
      not_started: t("stock.statusNotStarted"),
      check_in: t("stock.statusCheckIn"),
      final_stock: t("stock.statusFinalStock"),
      done: t("stock.statusDone"),
    }[status] ?? status
  );
}

function actionLabel(status) {
  return (
    {
      not_started: t("stock.actionCheckIn"),
      check_in: t("stock.actionOpen"),
      final_stock: t("stock.actionOpen"),
      done: t("stock.statusDone"),
    }[status] ?? status
  );
}

export async function mountStock() {
  renderTopbar();
  await refreshCards();
}

function renderTopbar() {
  const branches = state.meta.branches;
  const staffLocked = !isAdmin(state.user);
  const el = document.getElementById("topbar-slot");
  el.innerHTML = `
    <div class="flex items-start justify-between">
      <div>
        <h1 class="text-lg font-extrabold text-gray-900">${t("stock.title")}</h1>
        <p class="text-[11px] font-medium text-gray-600">${t("stock.subtitle")}</p>
      </div>
      <div id="stock-badges" class="flex gap-1.5"></div>
    </div>
    <div class="mt-3 flex gap-2">
      <button id="date-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
        <span id="date-label">${fmtDate(state.stock.date)}</span>
        <svg class="h-3.5 w-3.5 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
      ${
        staffLocked
          ? `<span class="chip flex-1 justify-between border-hairline bg-gray-50 text-gray-500"><span class="truncate">${branchName(state.stock.branch)}</span></span>`
          : `<button id="branch-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
          <span id="branch-label" class="truncate">${branchName(state.stock.branch)}</span>
          <svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
        </button>`
      }
    </div>`;

  if (!staffLocked) {
    document.getElementById("branch-select").addEventListener("click", () => {
      openActionSheet(
        t("stock.selectBranch"),
        branches.map((b) => ({ label: branchName(b.branch_id), value: b.branch_id, selected: b.branch_id === state.stock.branch })),
        (opt) => {
          state.stock.branch = opt.value;
          document.getElementById("branch-label").textContent = opt.label;
          refreshCards();
        }
      );
    });
  }

  document.getElementById("date-select").addEventListener("click", (e) => openCalendarSheet(e.currentTarget));
}

// Desk detail ("Check Stock") is a full page, not a modal, so it needs its
// own back-arrow topbar — same pattern settings/index.js uses for sub-pages.
function setDeskTopbar(title, onBack) {
  document.getElementById("topbar-slot").innerHTML = `
    <div class="flex items-center gap-2.5">
      <button id="desk-back" aria-label="${t("login.back")}" class="tap-target -ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 active:bg-gray-100">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
      </button>
      <h1 class="min-w-0 truncate text-lg font-extrabold text-gray-900">${title}</h1>
    </div>`;
  document.getElementById("desk-back").addEventListener("click", onBack);
}

function backToGrid() {
  renderTopbar();
  refreshCards();
}

// Keeps currentCards fresh in the background while the user stays on the
// desk detail page — unlike refreshCards(), it never touches #view-root, so
// it won't blow away the page the user is looking at.
async function syncCurrentCards() {
  try {
    const { desks } = await api.deskCards(state.stock.date, state.stock.branch);
    currentCards = desks;
  } catch {}
}

function openCalendarSheet(anchorEl) {
  let month = state.stock.date.slice(0, 7);
  openSheet(`<div id="cal-root"></div>`, {
    title: t("stock.selectDate"),
    anchorEl,
    onMount: (body) => {
      const calRoot = body.querySelector("#cal-root");
      const load = async () => {
        calRoot.innerHTML = `<div class="py-10 text-center text-sm text-gray-600">${t("stock.loadingDesks")}</div>`;
        const { days } = await api.calendar(state.stock.branch, month);
        const completionByDate = Object.fromEntries(days.map((d) => [d.date, d]));
        renderCalendar(calRoot, {
          monthDate: month,
          selectedDate: state.stock.date,
          completionByDate,
          onSelect: (date) => {
            state.stock.date = date;
            document.getElementById("date-label").textContent = fmtDate(date);
            closeSheet();
            refreshCards();
          },
          onMonthChange: (m) => {
            month = m;
            load();
          },
        });
      };
      load();
    },
  });
}

let currentCards = [];

async function refreshCards() {
  const root = document.getElementById("view-root");
  root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">${t("stock.loadingDesks")}</div>`;
  const { desks } = await api.deskCards(state.stock.date, state.stock.branch);
  currentCards = desks;
  renderBadges(desks);
  renderBody(desks);
}

function renderBadges(desks) {
  const counts = { done: 0, active: 0 };
  desks.forEach((d) => {
    if (d.status === "done") counts.done++;
    else if (d.status !== "not_started") counts.active++;
  });
  document.getElementById("stock-badges").innerHTML = `
    ${counts.done ? `<span class="status-pill bg-success-bg text-success">${counts.done} Done</span>` : ""}
    ${counts.active ? `<span class="status-pill bg-brand-100 text-brand-700">${counts.active} Active</span>` : ""}
  `;
}

function renderBody(desks) {
  const root = document.getElementById("view-root");
  root.innerHTML = `
    <div id="desk-grid" class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4"></div>
  `;
  renderFab();
  renderGrid(desks);
}

// Lives outside #view-root (like report.js's sticky footer) so it floats
// above the bottom nav near the Settings gear instead of scrolling with the
// desk grid. app.js calls unmountStock() before mounting any other view.
function renderFab() {
  let host = document.getElementById("fab-new-case");
  if (!host) {
    host = document.createElement("div");
    host.id = "fab-new-case";
    host.className = "fixed inset-x-0 bottom-[72px] z-20 mx-auto flex max-w-[430px] justify-end px-4";
    document.body.appendChild(host);
  }
  host.classList.remove("hidden");
  host.innerHTML = `
    <button id="new-case" aria-label="${t("stock.newCase")}" class="tap-target flex h-14 w-14 items-center justify-center rounded-full bg-brand-700 text-white shadow-pop active:scale-95">
      <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>
    </button>`;
  host.querySelector("#new-case").addEventListener("click", openCreateCaseSheet);
}

// Hidden (not removed, so renderFab() can just un-hide it) while the user is
// on the desk-detail page — a "+ New Case" FAB floating over a single desk's
// edit screen doesn't make sense there.
function hideFab() {
  document.getElementById("fab-new-case")?.classList.add("hidden");
}

export function unmountStock() {
  document.getElementById("fab-new-case")?.remove();
}

function renderGrid(desks) {
  const grid = document.getElementById("desk-grid");
  if (desks.length === 0) {
    grid.innerHTML = `<div class="col-span-full py-10 text-center text-sm text-gray-600">${t("stock.noDesks")}</div>`;
    return;
  }

  grid.innerHTML = desks
    .map(
      (d) => `
    <div class="card flex flex-col gap-2.5 p-3.5" data-card="${d.desk_id}">
      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          ${
            d.lastActorName
              ? `<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-extrabold text-brand-700">${d.lastActorName.slice(0, 2).toUpperCase()}</div>`
              : ""
          }
          <div class="min-w-0">
            <div class="truncate text-sm font-extrabold text-gray-900">${d.display_name}</div>
            ${d.lastActorName ? `<div class="truncate text-[10px] font-medium text-gray-600">${t("stock.lastActorPrefix")} ${d.lastActorName}</div>` : ""}
          </div>
        </div>
        <span class="status-pill shrink-0 ${statusPillClasses(d.status)}">${statusLabel(d.status)}</span>
      </div>

      <div class="flex items-baseline gap-1">
        <span class="text-xl font-extrabold text-gray-900">${fmtBaht(d.totalBaht)}</span>
        <span class="text-[11px] font-semibold text-gray-600">Baht</span>
      </div>
      <div class="flex items-center justify-between text-[11px] text-gray-600">
        <span>${fmtInt(d.totalPcs)} pcs</span>
        ${d.lowStockCount > 0 ? `<span class="font-bold text-danger">⚠ ${d.lowStockCount} low</span>` : ""}
      </div>

      <button data-action="${d.desk_id}" class="btn-${d.status === "done" ? "secondary" : "primary"} mt-1 w-full py-2 text-xs">
        ${actionLabel(d.status)}
      </button>
    </div>`
    )
    .join("");

  grid.querySelectorAll("[data-card]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action]")) return;
      const desk = currentCards.find((d) => d.desk_id === card.dataset.card);
      // Not started today has no opening-balance row to show yet (it's only
      // materialized on check-in), so tapping the card falls back to the
      // same check-in + edit flow as the action button in that case.
      if (desk.status === "not_started") handleCardAction(desk);
      else openOpeningBalanceSheet(desk);
    });
  });
  grid.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const desk = currentCards.find((d) => d.desk_id === btn.dataset.action);
      handleCardAction(desk);
    });
  });
}

// Read-only snapshot shown when the card itself is tapped — just today's
// opening balance per SKU, no inputs. "Check Stock" (the card's action
// button) is the only way into the editable table.
async function openOpeningBalanceSheet(deskCard) {
  const detail = await api.deskDetail(deskCard.desk_id, state.stock.date);
  const rows = detail.rows
    .map(
      (r) => `
      <div class="flex items-center gap-2.5 px-4 py-3">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">${icon(r.icon, "h-4 w-4")}</span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-xs font-bold text-gray-900">${r.name_en}</div>
          <div class="truncate text-[10px] text-gray-500">${[r.category, r.weight_name].filter(Boolean).join(" · ") || r.sku_id}</div>
        </div>
        <div class="shrink-0 text-right">
          <div class="text-sm font-extrabold text-gray-900">${r.opening_qty}</div>
          <div class="text-[9px] font-semibold uppercase text-gray-500">${t("stock.opening")}</div>
        </div>
      </div>`
    )
    .join("");

  openSheet(
    `
    <p class="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-center text-[11px] font-medium text-gray-500">${t("stock.openingBalanceHint")}</p>
    ${detail.lastActorName ? `<p class="mb-3 text-center text-[11px] text-gray-500">${t("stock.lastActorPrefix")} ${detail.lastActorName}</p>` : ""}
    <div class="card divide-y divide-hairline p-0">
      ${rows || `<div class="py-6 text-center text-xs text-gray-500">—</div>`}
    </div>
    ${deskCard.status !== "done" ? `<button id="go-check-stock" class="btn-primary mt-4 w-full">${t("stock.checkStock")}</button>` : ""}
  `,
    {
      title: `${deskCard.display_name} · ${deskCard.branch_name}`,
      onMount: (body) => {
        body.querySelector("#go-check-stock")?.addEventListener("click", () => {
          closeSheet();
          handleCardAction(deskCard);
        });
      },
    }
  );
}

async function handleCardAction(desk) {
  if (desk.status === "not_started") {
    await api.checkIn(desk.desk_id, state.stock.date);
    toast(`${desk.display_name} ${t("stock.checkedInToast")}`, "success");
    await refreshCards();
    const updated = currentCards.find((d) => d.desk_id === desk.desk_id);
    openDeskDetail(updated);
  } else {
    openDeskDetail(desk);
  }
}

async function openDeskDetail(deskCard) {
  if (deskCard.status === "not_started") return handleCardAction(deskCard);
  const detail = await api.deskDetail(deskCard.desk_id, state.stock.date);
  renderDeskDetailPage(deskCard, detail);
}

// Excel-style grid: every SKU is exactly one row, every field lines up in
// the same column for every SKU, and cells are plain bordered grid cells —
// no per-field "boxes" or gaps — so a value always lands in a predictable
// spot and typing into the wrong field is harder to do by accident. Needs
// horizontal scroll on a phone (many columns), so the SKU column is frozen
// (sticky), like a spreadsheet's frozen pane, so you never lose track of
// which row you're on while scrolled right. The Counted/Variance/Note
// columns only exist once the desk reaches final_stock/done, so the grid
// needs two different (fully literal, for Tailwind's content scan) column
// templates rather than a computed one.
const ROW_COLS_BASE = "grid-cols-[152px_40px_40px_40px_40px_40px_40px_60px_40px_56px_44px]";
const ROW_COLS_COUNTED = "grid-cols-[152px_40px_40px_40px_40px_40px_40px_60px_40px_56px_44px_40px_40px_60px]";

function headerCell(label) {
  return `<span class="flex items-center justify-center border-r border-hairline px-0.5 py-1.5 text-center">${label}</span>`;
}

function rowsTableHeader(showCounted) {
  return `
  <div class="grid ${showCounted ? ROW_COLS_COUNTED : ROW_COLS_BASE} border-b border-hairline bg-gray-50 text-[8px] font-extrabold uppercase tracking-wide text-gray-500">
    <span class="sticky left-0 z-10 border-r border-hairline bg-gray-50 px-1.5 py-1.5">${t("settings.skuColumn")}</span>
    ${headerCell(t("stock.colOpen"))}
    ${headerCell(t("stock.colIn"))}
    ${headerCell(t("stock.colSale"))}
    ${headerCell(t("stock.colWs"))}
    ${headerCell(t("stock.colOut"))}
    ${headerCell(t("stock.colDestock"))}
    ${headerCell(t("stock.colNote"))}
    ${headerCell(t("stock.colMove"))}
    ${headerCell(t("stock.colClose"))}
    ${headerCell(t("stock.colLifetime"))}
    ${
      showCounted
        ? `${headerCell(t("stock.colCounted"))}${headerCell(t("stock.colVariance"))}${headerCell(t("stock.colCountedNote"))}`
        : ""
    }
  </div>`;
}

function numCell(field, value, extraCls, disabled) {
  return `<input data-field="${field}" type="number" min="0" max="999" inputmode="numeric" value="${value}" ${disabled}
           class="h-full w-full border-r border-hairline bg-transparent text-center text-[11px] font-bold ${extraCls} focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300 disabled:bg-gray-50 disabled:text-gray-400" />`;
}

function textCell(field, value, placeholder, disabled) {
  return `<input data-field="${field}" type="text" value="${value}" placeholder="${placeholder ?? ""}" ${disabled}
           class="h-full w-full border-r border-hairline bg-transparent px-1 text-center text-[10px] font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300 disabled:bg-gray-50 disabled:text-gray-400" />`;
}

function rowTemplate(row, status) {
  const readOnly = status === "done";
  const ro = readOnly ? "disabled" : "";
  const showCounted = status === "final_stock" || status === "done";
  const countedRo = readOnly ? "disabled" : "";
  const cols = showCounted ? ROW_COLS_COUNTED : ROW_COLS_BASE;

  return `
  <div class="grid ${cols} border-b border-hairline ${readOnly ? "opacity-80" : ""}" data-row="${row.sku_id}"
       data-opening="${row.opening_qty}" data-baht-each="${row.baht_weight_each}" data-gram-each="${row.gram_weight_each}" data-price="${row.unit_price_lak}"
       data-sku-name="${escapeHtml(row.name_en)}" data-sku-icon="${row.icon}"
       data-avg-daily-sales="${row.avg_daily_sales ?? ""}" data-lead-time="${row.order_lead_time_days ?? ""}">
    <div class="sticky left-0 z-10 flex min-w-0 items-center gap-1.5 border-r border-hairline bg-surface px-1.5 py-1">
      <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">${icon(row.icon, "h-3.5 w-3.5")}</span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[11px] font-bold text-gray-900">${row.name_en}</div>
        <div class="truncate text-[9px] text-gray-500">${[row.category, row.weight_name].filter(Boolean).join(" · ") || row.sku_id}</div>
        <span data-low-chip class="status-pill mt-0.5 inline-flex px-1.5 py-0.5 text-[9px] ${row.low_stock ? "bg-danger-bg text-danger" : "hidden"}">&lt; ${row.threshold} pcs</span>
      </div>
      ${!readOnly ? `<button data-remove-sku="${row.sku_id}" aria-label="${t("stock.removeSku")}" class="tap-target shrink-0 text-gray-400 hover:text-danger">×</button>` : ""}
    </div>

    <div class="flex items-center justify-center border-r border-hairline text-center text-[11px] font-bold text-gray-700">${row.opening_qty}</div>
    ${numCell("stock_in", row.stock_in, "text-success", ro)}
    ${numCell("retail_sale", row.retail_sale, "text-danger", ro)}
    ${numCell("wholesale", row.wholesale, "text-danger", ro)}
    ${numCell("transfer_out", row.transfer_out, "text-danger", ro)}
    ${numCell("destock", row.destock, "text-danger", ro)}
    ${textCell("destock_note", row.destock_note ?? "", "", ro)}
    ${numCell("move", row.move, "text-danger", ro)}

    <div class="flex flex-col items-center justify-center border-r border-hairline bg-brand-50/40 text-center">
      <div data-closing-qty class="text-[11px] font-extrabold text-brand-700">${row.closing_qty} pcs</div>
      <div data-closing-baht class="text-[9px] font-semibold text-brand-600">${fmtBaht(row.closing_baht)}</div>
    </div>

    <div data-lifetime-cell class="flex items-center justify-center border-r border-hairline text-center text-[11px] font-bold ${
      row.lifetime_alert ? "bg-danger-bg text-danger" : row.est_lifetime_days === null ? "text-gray-400" : "text-gray-700"
    }">
      <span data-lifetime>${row.est_lifetime_days === null ? "—" : `${row.est_lifetime_days}${t("stock.daysShort")}`}</span>
    </div>

    ${
      showCounted
        ? `
    ${numCell("counted_qty", row.counted_qty ?? "", "text-gray-800", countedRo)}
    <div data-variance-chip class="flex items-center justify-center border-r border-hairline text-center text-[11px] font-bold ${
      row.hasVariance ? (row.variance > 0 ? "text-success" : "text-danger") : "text-gray-400"
    }">${row.hasVariance ? (row.variance > 0 ? "+" : "") + row.variance : "—"}</div>
    ${textCell("counted_note", row.counted_note ?? "", t("stock.countedNote"), countedRo)}`
        : ""
    }
  </div>`;
}

function recomputeRow(rowEl) {
  const opening = Number(rowEl.dataset.opening || 0);
  const stockIn = Number(rowEl.querySelector('[data-field="stock_in"]')?.value || 0);
  const sale = Number(rowEl.querySelector('[data-field="retail_sale"]')?.value || 0);
  const wholesale = Number(rowEl.querySelector('[data-field="wholesale"]')?.value || 0);
  const transfer = Number(rowEl.querySelector('[data-field="transfer_out"]')?.value || 0);
  const destock = Number(rowEl.querySelector('[data-field="destock"]')?.value || 0);
  const move = Number(rowEl.querySelector('[data-field="move"]')?.value || 0);
  const closingQty = opening + stockIn - sale - wholesale - transfer - destock - move;
  const bahtEach = Number(rowEl.dataset.bahtEach);
  const gramEach = Number(rowEl.dataset.gramEach);
  rowEl.querySelector("[data-closing-qty]").textContent = `${closingQty} pcs`;
  rowEl.querySelector("[data-closing-baht]").textContent = fmtBaht(closingQty * bahtEach);
  const lowChip = rowEl.querySelector("[data-low-chip]");
  if (lowChip) {
    const threshold = Number(lowChip.textContent.match(/\d+/)?.[0] ?? 5);
    lowChip.classList.toggle("hidden", closingQty >= threshold);
  }
  const countedInput = rowEl.querySelector('[data-field="counted_qty"]');
  const varianceChip = rowEl.querySelector("[data-variance-chip]");
  if (countedInput && varianceChip) {
    const counted = countedInput.value === "" ? null : Number(countedInput.value);
    const variance = counted === null ? null : counted - closingQty;
    varianceChip.textContent = !variance ? "—" : (variance > 0 ? "+" : "") + variance;
    varianceChip.className = `flex items-center justify-center border-r border-hairline text-center text-[11px] font-bold ${
      variance ? (variance > 0 ? "text-success" : "text-danger") : "text-gray-400"
    }`;
  }

  // Est. days of stock left at this SKU's avg sell rate, recomputed live so
  // it tracks whatever closing qty is currently on the screen — flagged
  // when it's shorter than the SKU's own order lead time (it would run out
  // before a reorder placed today could arrive).
  const avgDailySales = Number(rowEl.dataset.avgDailySales || 0);
  const leadTimeDays = rowEl.dataset.leadTime === "" ? null : Number(rowEl.dataset.leadTime);
  const estLifetimeDays = avgDailySales > 0 ? Math.round((closingQty / avgDailySales) * 10) / 10 : null;
  const lifetimeAlert = estLifetimeDays !== null && leadTimeDays !== null && estLifetimeDays < leadTimeDays;
  const lifetimeText = rowEl.querySelector("[data-lifetime]");
  const lifetimeCell = rowEl.querySelector("[data-lifetime-cell]");
  if (lifetimeText && lifetimeCell) {
    lifetimeText.textContent = estLifetimeDays === null ? "—" : `${estLifetimeDays}${t("stock.daysShort")}`;
    lifetimeCell.className = `flex items-center justify-center border-r border-hairline text-center text-[11px] font-bold ${
      lifetimeAlert ? "bg-danger-bg text-danger" : estLifetimeDays === null ? "text-gray-400" : "text-gray-700"
    }`;
  }

  return {
    closingQty,
    gramEach,
    bahtEach,
    estLifetimeDays,
    lifetimeAlert,
    skuName: rowEl.dataset.skuName,
    skuIcon: rowEl.dataset.skuIcon,
  };
}

function renderAlertSkuList(alertSkus) {
  if (!alertSkus.length) {
    return `<div class="text-[11px] font-medium text-gray-500">${t("stock.noAlerts")}</div>`;
  }
  return alertSkus
    .map(
      (s) => `
    <div class="flex items-center justify-between gap-2 rounded-lg bg-white/70 px-2 py-1.5">
      <span class="flex min-w-0 items-center gap-1.5">
        ${icon(s.icon, "h-3.5 w-3.5 shrink-0 text-danger")}
        <span class="truncate text-[11px] font-bold text-gray-900">${escapeHtml(s.name)}</span>
      </span>
      <span class="shrink-0 text-[10px] font-bold text-danger">${s.estLifetimeDays}${t("stock.daysShort")}</span>
    </div>`
    )
    .join("");
}

function recomputeTotals(sheetBody) {
  let pcs = 0,
    gram = 0;
  const lifetimes = [];
  const alertSkus = [];
  sheetBody.querySelectorAll("[data-row]").forEach((rowEl) => {
    const { closingQty, gramEach, estLifetimeDays, lifetimeAlert, skuName, skuIcon } = recomputeRow(rowEl);
    pcs += closingQty;
    gram += closingQty * gramEach;
    if (estLifetimeDays !== null) lifetimes.push(estLifetimeDays);
    if (lifetimeAlert) alertSkus.push({ name: skuName, icon: skuIcon, estLifetimeDays });
  });
  alertSkus.sort((a, b) => a.estLifetimeDays - b.estLifetimeDays);
  const avgLifetime = lifetimes.length ? Math.round((lifetimes.reduce((s, n) => s + n, 0) / lifetimes.length) * 10) / 10 : null;

  sheetBody.querySelector("#sum-weight").textContent = fmtBaht(gram, 1);
  sheetBody.querySelector("#sum-pcs").textContent = fmtInt(pcs);
  sheetBody.querySelector("#sum-avg-lifetime").textContent = avgLifetime === null ? "—" : `${avgLifetime}${t("stock.daysShort")}`;
  sheetBody.querySelector("#alert-sku-list").innerHTML = renderAlertSkuList(alertSkus);
}

function renderDeskDetailPage(deskCard, detail) {
  const content = `
    <div id="edit-view">
      <p class="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-center text-[11px] font-medium text-gray-500">${t("stock.closingFormula")}</p>
      ${detail.lastActorName ? `<p class="mb-3 text-center text-[11px] text-gray-500">${t("stock.lastActorPrefix")} ${detail.lastActorName}</p>` : ""}

      <div class="card overflow-x-auto p-1">
        <div class="min-w-[740px]">
          ${rowsTableHeader(detail.status === "final_stock" || detail.status === "done")}
          <div id="rows" class="flex flex-col">
            ${detail.rows.map((r) => rowTemplate(r, detail.status)).join("")}
          </div>
        </div>
      </div>

      ${detail.status !== "done" ? `<button id="add-sku" class="btn-secondary mt-3 w-full py-2.5 text-xs">${t("stock.addSku")}</button>` : ""}

      <div class="mt-4 card bg-brand-50/60 p-3.5">
        <div class="mb-2 text-[11px] font-bold uppercase tracking-wide text-brand-700">${t("stock.stockHealthTitle")}</div>
        <div class="grid grid-cols-3 gap-2 text-center">
          <div>
            <div id="sum-weight" class="text-sm font-extrabold text-gray-900">${fmtBaht(detail.totals.gram, 1)}</div>
            <div class="text-[9px] text-gray-500">${t("settings.weightGramLabel")}</div>
          </div>
          <div>
            <div id="sum-pcs" class="text-sm font-extrabold text-gray-900">${fmtInt(detail.totals.pcs)}</div>
            <div class="text-[9px] text-gray-500">${t("stock.totalQtyShort")}</div>
          </div>
          <div>
            <div id="sum-avg-lifetime" class="text-sm font-extrabold text-gray-900">${
              detail.stockHealth.avgLifetimeDays === null ? "—" : `${detail.stockHealth.avgLifetimeDays}${t("stock.daysShort")}`
            }</div>
            <div class="text-[9px] text-gray-500">${t("stock.avgLifetimeShort")}</div>
          </div>
        </div>
        <div class="mt-3 border-t border-brand-100 pt-2.5">
          <div class="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-brand-700">${t("stock.skuOnAlert")}</div>
          <div id="alert-sku-list" class="flex flex-col gap-1">
            ${renderAlertSkuList(detail.stockHealth.alertSkus.map((s) => ({ name: s.name_en, icon: s.icon, estLifetimeDays: s.est_lifetime_days })))}
          </div>
        </div>
      </div>

      <label for="safe-drop" class="mt-4 block text-xs font-bold text-gray-600">${t("stock.safeDropNotes")}</label>
      <textarea id="safe-drop" rows="2" placeholder="${t("stock.safeDropPlaceholder")}" class="input-filled mt-1.5" ${detail.status === "done" ? "disabled" : ""}>${
    detail.rows.find((r) => r.safe_drop_note)?.safe_drop_note ?? ""
  }</textarea>

      <div class="h-4"></div>

      <div class="sticky bottom-0 -mx-4 border-t border-hairline bg-white/95 px-4 pb-2 pt-3 backdrop-blur">
        ${
          detail.status === "done"
            ? `<p class="pt-2 text-center text-xs font-semibold text-success">${t("stock.doneLocked")}</p>`
            : detail.status === "final_stock"
            ? `<div class="flex gap-2.5">
                 <button id="save-checkin" class="btn-secondary flex-1">${t("stock.saveProgress")}</button>
                 <button id="mark-done" class="btn-primary flex-1">${t("stock.markDone")}</button>
               </div>`
            : `<div class="flex gap-2.5">
                 <button id="save-checkin" class="btn-secondary flex-1">${t("stock.saveProgress")}</button>
                 <button id="move-final" class="btn-primary flex-1">${t("stock.moveToFinalStock")}</button>
               </div>`
        }
      </div>
    </div>

    <div id="review-view" class="hidden"></div>
  `;

  setDeskTopbar(`${deskCard.display_name} · ${deskCard.branch_name}`, backToGrid);
  hideFab();
  const root = document.getElementById("view-root");
  root.innerHTML = content;
  root.scrollTo({ top: 0 });

  root.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("input", () => {
      const isNumeric = input.type === "number";
      if (isNumeric && input.value !== "" && Number(input.value) > 999) input.value = "999";
      recomputeRow(input.closest("[data-row]"));
      recomputeTotals(root);
    });
  });
  recomputeTotals(root);

  root.querySelectorAll("[data-remove-sku]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api.removeDeskSku(deskCard.desk_id, btn.dataset.removeSku, state.stock.date);
      btn.closest("[data-row]").remove();
      recomputeTotals(root);
      await syncCurrentCards();
    });
  });

  root.querySelector("#add-sku")?.addEventListener("click", async () => {
    await persistRows(deskCard.desk_id, root, detail);
    openSkuPickerSheet(
      detail.rows.map((r) => r.sku_id),
      async (sku) => {
        await api.addDeskSku(deskCard.desk_id, { date: state.stock.date, sku_id: sku.sku_id });
        await syncCurrentCards();
        const updatedCard = currentCards.find((d) => d.desk_id === deskCard.desk_id) ?? deskCard;
        const updatedDetail = await api.deskDetail(deskCard.desk_id, state.stock.date);
        renderDeskDetailPage(updatedCard, updatedDetail);
      }
    );
  });

  root.querySelector("#save-checkin")?.addEventListener("click", async () => {
    await persistRows(deskCard.desk_id, root, detail);
    toast(t("stock.progressSaved"), "success");
    await syncCurrentCards();
  });

  root.querySelector("#move-final")?.addEventListener("click", async () => {
    await persistRows(deskCard.desk_id, root, detail);
    await api.transitionDesk(deskCard.desk_id, { date: state.stock.date, toStatus: "final_stock" });
    toast(t("stock.statusFinalStock"), "success");
    backToGrid();
  });

  root.querySelector("#mark-done")?.addEventListener("click", async () => {
    await persistRows(deskCard.desk_id, root, detail);
    showReview(root, deskCard, detail);
  });
}

function showReview(body, deskCard, detail) {
  const rows = [...body.querySelectorAll("[data-row]")].map((rowEl) => {
    const { closingQty, bahtEach } = recomputeRow(rowEl);
    const original = detail.rows.find((r) => r.sku_id === rowEl.dataset.row);
    return {
      sku_id: rowEl.dataset.row,
      name_en: original?.name_en ?? rowEl.dataset.row,
      icon: original?.icon ?? "ring",
      closingQty,
      closingBaht: closingQty * bahtEach,
      lowStock: !rowEl.querySelector("[data-low-chip]")?.classList.contains("hidden"),
    };
  });
  const lowStockRows = rows.filter((r) => r.lowStock);
  const totalPcs = rows.reduce((s, r) => s + r.closingQty, 0);
  const totalBaht = rows.reduce((s, r) => s + r.closingBaht, 0);

  const reviewView = body.querySelector("#review-view");
  reviewView.innerHTML = `
    <p class="mb-4 text-center text-sm font-semibold text-gray-700">${t("stock.reviewBeforeDone")}</p>
    <div class="flex flex-col gap-2">
      ${rows
        .map(
          (r) => `
        <div class="flex items-center justify-between rounded-xl border border-hairline p-2.5">
          <span class="flex items-center gap-2 text-xs font-bold text-gray-900">${icon(r.icon, "h-4 w-4 text-brand-600")}${r.name_en}</span>
          <span class="flex items-center gap-2">
            ${r.lowStock ? '<span class="status-pill bg-danger-bg text-danger">low</span>' : ""}
            <span class="text-xs font-extrabold text-gray-900">${r.closingQty} pcs</span>
          </span>
        </div>`
        )
        .join("")}
    </div>
    <div class="mt-4 flex items-center justify-between rounded-xl bg-brand-50 px-3.5 py-3">
      <span class="text-xs font-bold text-brand-700">${t("stock.closingTotal")}</span>
      <span class="text-sm font-extrabold text-brand-700">${totalPcs} pcs · ${fmtBaht(totalBaht)} Baht</span>
    </div>
    ${
      lowStockRows.length > 0
        ? `<p class="mt-3 rounded-lg bg-warning-bg px-3 py-2.5 text-xs font-semibold text-warning">
             ${lowStockRows.length} item${lowStockRows.length > 1 ? "s are" : " is"} below the low-stock threshold. ${t("stock.notesPrompt")}
           </p>`
        : ""
    }
    <div class="h-4"></div>
    <div class="sticky bottom-0 -mx-4 border-t border-hairline bg-white/95 px-4 pb-2 pt-3 backdrop-blur">
      <div class="flex gap-2.5">
        <button id="review-back" class="btn-secondary flex-1">${t("stock.goBack")}</button>
        <button id="review-confirm" class="btn-primary flex-1">${t("stock.confirmSubmit")}</button>
      </div>
    </div>
  `;

  body.querySelector("#edit-view").classList.add("hidden");
  reviewView.classList.remove("hidden");
  body.scrollTo({ top: 0 });
  reviewView.querySelector("#review-back").focus();

  reviewView.querySelector("#review-back").addEventListener("click", () => {
    reviewView.classList.add("hidden");
    reviewView.innerHTML = "";
    body.querySelector("#edit-view").classList.remove("hidden");
  });

  reviewView.querySelector("#review-confirm").addEventListener("click", async () => {
    if (isBeforeStockCutoff() && !window.confirm(t("stock.earlySubmitConfirm"))) return;
    await api.transitionDesk(deskCard.desk_id, { date: state.stock.date, toStatus: "done" });
    toast(t("stock.finalClosingSubmitted"), "success");
    backToGrid();
  });
}

async function persistRows(deskId, body, detail) {
  const rows = [...body.querySelectorAll("[data-row]")];
  const safeDropEl = body.querySelector("#safe-drop");
  const safeDropNote = safeDropEl && !safeDropEl.disabled ? safeDropEl.value || null : undefined;
  for (const rowEl of rows) {
    const skuId = rowEl.dataset.row;
    const original = detail.rows.find((r) => r.sku_id === skuId);
    const countedInput = rowEl.querySelector('[data-field="counted_qty"]');
    const countedNoteInput = rowEl.querySelector('[data-field="counted_note"]');
    await api.saveEntry(deskId, {
      date: state.stock.date,
      sku_id: skuId,
      opening_qty: original.opening_qty,
      stock_in: Number(rowEl.querySelector('[data-field="stock_in"]').value || 0),
      retail_sale: Number(rowEl.querySelector('[data-field="retail_sale"]').value || 0),
      wholesale: Number(rowEl.querySelector('[data-field="wholesale"]').value || 0),
      transfer_out: Number(rowEl.querySelector('[data-field="transfer_out"]').value || 0),
      destock: Number(rowEl.querySelector('[data-field="destock"]').value || 0),
      destock_note: rowEl.querySelector('[data-field="destock_note"]')?.value || null,
      move: Number(rowEl.querySelector('[data-field="move"]').value || 0),
      counted_qty: countedInput ? (countedInput.value === "" ? null : Number(countedInput.value)) : undefined,
      counted_note: countedNoteInput ? countedNoteInput.value || null : undefined,
      safe_drop_note: safeDropNote,
    });
  }
}

// --- SKU picker (select existing / create new), reused by the desk-detail
// "Add SKU" flow and the create-Case flow's opening-balance step. ---

async function renderSkuPickerInto(container, excludeSkuIds, onPick, onCancel) {
  container.innerHTML = `<div class="py-10 text-center text-sm text-gray-600">${t("stock.loadingDesks")}</div>`;
  const { skus } = await api.skus();
  const available = skus.filter((s) => !excludeSkuIds.includes(s.sku_id));
  container.innerHTML = `
    <button id="sku-back" class="mb-2 text-xs font-bold text-gray-500">&larr; ${t("login.back")}</button>
    <button id="create-new-sku" class="btn-primary mb-3 w-full py-2.5 text-xs">${t("stock.createNewSku")}</button>
    <div class="flex flex-col gap-1.5">
      ${
        available.length
          ? available
              .map(
                (s) => `
        <button data-pick-sku="${s.sku_id}" class="card flex items-center gap-2.5 p-2.5 text-left">
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">${icon(s.icon, "h-4 w-4")}</span>
          <span class="min-w-0">
            <span class="block truncate text-xs font-bold text-gray-900">${s.name_en}</span>
            <span class="block text-[10px] text-gray-500">${[s.type_name, s.weight_name].filter(Boolean).join(" · ") || s.sku_id}</span>
          </span>
        </button>`
              )
              .join("")
          : `<div class="py-6 text-center text-xs text-gray-500">—</div>`
      }
    </div>`;
  container.querySelector("#sku-back").addEventListener("click", onCancel);
  container.querySelector("#create-new-sku").addEventListener("click", () => renderCreateSkuFormInto(container, onPick, onCancel));
  container.querySelectorAll("[data-pick-sku]").forEach((btn) => {
    btn.addEventListener("click", () => onPick(available.find((s) => s.sku_id === btn.dataset.pickSku)));
  });
}

async function renderCreateSkuFormInto(container, onPick, onCancel) {
  container.innerHTML = `<div class="py-10 text-center text-sm text-gray-600">${t("stock.loadingDesks")}</div>`;
  const [{ types }, { weights }] = await Promise.all([api.skuTypes(), api.skuWeights()]);
  const activeTypes = types.filter((ty) => ty.active);
  const activeWeights = weights.filter((w) => w.active);
  container.innerHTML = `
    <button id="sku-back" class="mb-2 text-xs font-bold text-gray-500">&larr; ${t("login.back")}</button>
    <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("stock.skuNameLabel")}</label>
    <input id="sku-name" type="text" class="input-filled" />
    <div class="mt-3 grid grid-cols-2 gap-2">
      <div>
        <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.skuTypeLabel")}</label>
        <select id="sku-type" class="input-filled">
          ${activeTypes.map((ty) => `<option value="${ty.type_id}">${escapeHtml(ty.name_en)}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.skuWeightLabel")}</label>
        <select id="sku-weight" class="input-filled">
          ${activeWeights.map((w) => `<option value="${w.weight_id}">${escapeHtml(w.name_en)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="mt-3 grid grid-cols-2 gap-2">
      <div>
        <label class="mb-1.5 block text-xs font-bold text-gray-600">Purity</label>
        <select id="sku-purity" class="input-filled">
          <option value="">—</option>
          ${PURITY_OPTIONS.map((p) => `<option value="${p}">${p}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-bold text-gray-600">Baht weight</label>
        <input id="sku-baht" type="number" step="0.01" value="0" class="input-filled" />
      </div>
    </div>
    <label class="mt-3 mb-1.5 block text-xs font-bold text-gray-600">Price (LAK)</label>
    <input id="sku-price" type="number" value="0" class="input-filled" />
    <button id="create-sku-submit" class="btn-primary mt-4 w-full">${t("stock.createNewSku")}</button>
  `;
  container.querySelector("#sku-back").addEventListener("click", onCancel);
  container.querySelector("#create-sku-submit").addEventListener("click", async () => {
    const name_en = container.querySelector("#sku-name").value.trim();
    if (!name_en) return toast(t("stock.needSkuName"), "error");
    if (!activeTypes.length || !activeWeights.length) return toast(t("settings.needTypeAndWeight"), "error");
    const sku = await api.createSku({
      name_en,
      type_id: container.querySelector("#sku-type").value,
      weight_id: container.querySelector("#sku-weight").value,
      purity: container.querySelector("#sku-purity").value || null,
      baht_weight: Number(container.querySelector("#sku-baht").value || 0),
      unit_price_lak: Number(container.querySelector("#sku-price").value || 0),
    });
    onPick(sku);
  });
}

function openSkuPickerSheet(excludeSkuIds, onPick) {
  openSheet(`<div id="sku-picker-root"></div>`, {
    title: t("stock.addSku"),
    onMount: (body) => {
      const root = body.querySelector("#sku-picker-root");
      renderSkuPickerInto(
        root,
        excludeSkuIds,
        (sku) => {
          closeSheet();
          onPick(sku);
        },
        closeSheet
      );
    },
  });
}

// --- Create Case ---

async function openCreateCaseSheet() {
  let caseName = "";
  let mode = "form"; // "form" | "picker"
  let rows = [];

  const render = (body) => {
    if (mode === "picker") {
      renderSkuPickerInto(
        body,
        rows.map((r) => r.sku_id),
        (sku) => {
          rows.push({ sku_id: sku.sku_id, name_en: sku.name_en, icon: sku.icon, purity: sku.purity, opening_qty: 0 });
          mode = "form";
          render(body);
        },
        () => {
          mode = "form";
          render(body);
        }
      );
      return;
    }

    body.innerHTML = `
      <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("stock.caseNumberLabel")}</label>
      <input id="case-name" type="text" placeholder="${t("stock.caseNumberPlaceholder")}" value="${caseName}" class="input-filled" />

      <div class="mt-4 mb-1.5">
        <label class="text-xs font-bold text-gray-600">${t("stock.openingSkuSectionTitle")}</label>
      </div>
      <div id="case-sku-rows" class="flex flex-col gap-2"></div>
      <button id="case-add-sku" class="btn-secondary mt-2.5 w-full py-2 text-xs">${t("stock.addSku")}</button>

      <button id="create-case-submit" class="btn-primary mt-5 mb-2 w-full">${t("stock.createCaseButton")}</button>
    `;

    const rowsEl = body.querySelector("#case-sku-rows");
    rowsEl.innerHTML = rows.length
      ? rows
          .map(
            (r, i) => `
        <div class="flex items-center gap-2 rounded-xl border border-hairline p-2" data-case-row="${i}">
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">${icon(r.icon, "h-4 w-4")}</span>
          <span class="min-w-0 flex-1 truncate text-xs font-bold text-gray-900">${r.name_en}</span>
          <input data-opening-input type="number" min="0" value="${r.opening_qty}" aria-label="${t("stock.openingQtyLabel")}" class="w-16 rounded-lg border border-hairline py-1.5 text-center text-xs font-bold" />
          <button data-remove-row aria-label="${t("documents.delete")}" class="tap-target text-gray-400 hover:text-danger">×</button>
        </div>`
          )
          .join("")
      : `<div class="py-4 text-center text-xs text-gray-500">—</div>`;

    rowsEl.querySelectorAll("[data-case-row]").forEach((rowEl) => {
      const idx = Number(rowEl.dataset.caseRow);
      rowEl.querySelector("[data-opening-input]").addEventListener("input", (e) => {
        rows[idx].opening_qty = Number(e.target.value || 0);
      });
      rowEl.querySelector("[data-remove-row]").addEventListener("click", () => {
        rows.splice(idx, 1);
        render(body);
      });
    });

    body.querySelector("#case-name").addEventListener("input", (e) => {
      caseName = e.target.value;
    });
    body.querySelector("#case-add-sku").addEventListener("click", () => {
      mode = "picker";
      render(body);
    });

    body.querySelector("#create-case-submit").addEventListener("click", async () => {
      if (!caseName.trim()) return toast(t("stock.needCaseNumber"), "error");
      if (rows.length === 0) return toast(t("stock.needOneSku"), "error");
      await api.createDesk({
        branchId: state.stock.branch,
        displayName: caseName.trim(),
        openingSkus: rows.map((r) => ({ sku_id: r.sku_id, opening_qty: r.opening_qty })),
      });
      toast(t("stock.caseCreatedToast"), "success");
      closeSheet();
      await refreshCards();
    });
  };

  openSheet(`<div id="case-body"></div>`, {
    title: t("stock.createCaseTitle"),
    onMount: (body) => render(body.querySelector("#case-body")),
  });
}
