import { api } from "../api.js";
import { state, branchName } from "../state.js";
import { toast, openSheet, closeSheet, openActionSheet } from "../ui.js";
import { fmtBaht, fmtInt, fmtDate, icon, statusPillClasses, escapeHtml } from "../util.js";
import { t, pickName } from "../i18n.js";
import { renderCalendar } from "../calendar.js";
import { isAdmin } from "../session.js";

const PURITY_OPTIONS = ["96.5%", "99.99%"];
const STOCK_CUTOFF_HOUR = 15;
const STOCK_CUTOFF_MINUTE = 30;

// Guards the final "Mark Done" submission — stores shouldn't normally lock in
// their closing count before the day's cutoff, so this prompts for an
// explicit confirm when it's run early rather than blocking it outright.
// Uses Laos time (UTC+7) rather than whatever the tablet's clock is set to.
function isBeforeStockCutoff() {
  const laos = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const h = laos.getUTCHours();
  return h < STOCK_CUTOFF_HOUR || (h === STOCK_CUTOFF_HOUR && laos.getUTCMinutes() < STOCK_CUTOFF_MINUTE);
}

// t() with {placeholders}.
function tf(key, vars) {
  return Object.entries(vars).reduce((text, [k, v]) => text.replace(`{${k}}`, v), t(key));
}

function setStockDate(date) {
  state.stock.date = date;
  const label = document.getElementById("date-label");
  if (label) label.textContent = fmtDate(date);
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
            setStockDate(date);
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
  const el = document.getElementById("stock-badges");
  if (!el) return;
  el.innerHTML = `
    ${counts.done ? `<span class="status-pill bg-success-bg text-success">${counts.done} ${t("stock.badgeDone")}</span>` : ""}
    ${counts.active ? `<span class="status-pill bg-brand-100 text-brand-700">${counts.active} ${t("stock.badgeActive")}</span>` : ""}
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
  // A new case is created with today's starting stock, so it only makes
  // sense while looking at today.
  host.classList.toggle("hidden", state.stock.date !== state.meta.today);
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

// A desk cannot start a new day while an earlier day is still not Done.
function blockedDate(desk) {
  return desk.status === "not_started" && desk.openEarlierDate ? desk.openEarlierDate : null;
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
              ? `<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-extrabold text-brand-700">${escapeHtml(d.lastActorName.slice(0, 2).toUpperCase())}</div>`
              : ""
          }
          <div class="min-w-0">
            <div class="truncate text-sm font-extrabold text-gray-900">${escapeHtml(d.display_name)}</div>
            ${d.lastActorName ? `<div class="truncate text-[10px] font-medium text-gray-600">${t("stock.lastActorPrefix")} ${escapeHtml(d.lastActorName)}</div>` : ""}
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
        ${d.lowStockCount > 0 ? `<span class="font-bold text-danger">⚠ ${d.lowStockCount} ${t("stock.lowShort")}</span>` : ""}
      </div>
      ${
        blockedDate(d)
          ? `<p class="rounded-lg bg-warning-bg px-2 py-1.5 text-[10px] font-bold leading-tight text-warning">${tf("stock.finishFirst", { date: fmtDate(d.openEarlierDate) })}</p>`
          : ""
      }

      <button data-action="${d.desk_id}" class="btn-${d.status === "done" ? "secondary" : "primary"} mt-1 w-full py-2 text-xs">
        ${blockedDate(d) ? tf("stock.goToDate", { date: fmtDate(d.openEarlierDate) }) : actionLabel(d.status)}
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
          <div class="truncate text-xs font-bold text-gray-900">${escapeHtml(pickName(r.name_en, r.name_lo))}</div>
          <div class="truncate text-[10px] text-gray-500">${escapeHtml([r.category, r.weight_name].filter(Boolean).join(" · ") || r.sku_id)}</div>
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
    ${detail.lastActorName ? `<p class="mb-3 text-center text-[11px] text-gray-500">${t("stock.lastActorPrefix")} ${escapeHtml(detail.lastActorName)}</p>` : ""}
    <div class="card divide-y divide-hairline p-0">
      ${rows || `<div class="py-6 text-center text-xs text-gray-500">—</div>`}
    </div>
    <button id="go-check-stock" class="btn-primary mt-4 w-full">${deskCard.status === "done" ? t("stock.viewDay") : t("stock.checkStock")}</button>
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
  if (blockedDate(desk)) {
    // Jump to the unfinished day so it can be counted and closed first.
    setStockDate(desk.openEarlierDate);
    toast(tf("stock.finishFirst", { date: fmtDate(desk.openEarlierDate) }));
    await refreshCards();
    return;
  }
  if (desk.status === "not_started") {
    try {
      await api.checkIn(desk.desk_id, state.stock.date);
    } catch (err) {
      if (err.code === "EARLIER_DAY_OPEN" && err.data.openDate) {
        setStockDate(err.data.openDate);
        await refreshCards();
      }
      throw err;
    }
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

// Reloads the desk page after something changed server-side (a transfer, an
// added SKU, a reopen) so every number on it is the saved one.
async function reloadDeskDetail(deskCard) {
  await syncCurrentCards();
  const updatedCard = currentCards.find((d) => d.desk_id === deskCard.desk_id) ?? deskCard;
  const detail = await api.deskDetail(deskCard.desk_id, state.stock.date);
  renderDeskDetailPage(updatedCard, detail);
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
const CELL_ERROR = ["bg-danger-bg", "ring-2", "ring-inset", "ring-danger"];

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
  return `<input data-field="${field}" type="number" min="0" max="999" step="1" inputmode="numeric" value="${value}" ${disabled}
           class="h-full w-full border-r border-hairline bg-transparent text-center text-[11px] font-bold ${extraCls} focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300 disabled:bg-gray-50 disabled:text-gray-400" />`;
}

function textCell(field, value, placeholder, disabled) {
  return `<input data-field="${field}" type="text" maxlength="200" value="${escapeHtml(value)}" placeholder="${placeholder ?? ""}" ${disabled}
           class="h-full w-full border-r border-hairline bg-transparent px-1 text-center text-[10px] font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300 disabled:bg-gray-50 disabled:text-gray-400" />`;
}

// Out (to another branch) and Move (to another desk in this branch) are not
// typed: tapping the cell opens the transfer sheet, which picks the
// destination desk so the gold arrives somewhere.
function transferCell(kind, value, disabled) {
  return `<button type="button" data-transfer="${kind}" ${disabled} aria-label="${kind === "move" ? t("stock.move") : t("stock.transferOut")}"
           class="h-full w-full border-r border-hairline text-center text-[11px] font-bold ${value > 0 ? "text-danger" : "text-gray-400"} underline decoration-dotted underline-offset-2 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300 disabled:bg-gray-50 disabled:no-underline">${value}</button>`;
}

function rowTemplate(row, status) {
  const readOnly = status === "done";
  const ro = readOnly ? "disabled" : "";
  const showCounted = status === "final_stock" || status === "done";
  const cols = showCounted ? ROW_COLS_COUNTED : ROW_COLS_BASE;
  const name = pickName(row.name_en, row.name_lo);

  return `
  <div class="grid ${cols} border-b border-hairline ${readOnly ? "opacity-80" : ""}" data-row="${escapeHtml(row.sku_id)}"
       data-opening="${row.opening_qty}" data-transfer-in="${row.transfer_in}" data-transfer-out="${row.transfer_out}" data-move="${row.move}"
       data-threshold="${row.threshold}" data-baht-each="${row.baht_weight_each}" data-gram-each="${row.gram_weight_each}"
       data-sku-name="${escapeHtml(name)}" data-sku-icon="${row.icon}"
       data-avg-daily-sales="${row.avg_daily_sales ?? ""}" data-lead-time="${row.order_lead_time_days ?? ""}">
    <div class="sticky left-0 z-10 flex min-w-0 items-center gap-1.5 border-r border-hairline bg-surface px-1.5 py-1">
      <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">${icon(row.icon, "h-3.5 w-3.5")}</span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[11px] font-bold text-gray-900">${escapeHtml(name)}</div>
        <div class="truncate text-[9px] text-gray-500">${escapeHtml([row.category, row.weight_name].filter(Boolean).join(" · ") || row.sku_id)}</div>
        <span data-low-chip class="status-pill mt-0.5 inline-flex px-1.5 py-0.5 text-[9px] ${row.low_stock ? "bg-danger-bg text-danger" : "hidden"}">&lt; ${row.threshold} pcs</span>
      </div>
      ${!readOnly ? `<button data-remove-sku="${escapeHtml(row.sku_id)}" aria-label="${t("stock.removeSku")}" class="tap-target shrink-0 text-gray-400 hover:text-danger">×</button>` : ""}
    </div>

    <div class="flex items-center justify-center border-r border-hairline text-center text-[11px] font-bold text-gray-700">${row.opening_qty}</div>
    <div class="relative h-full">
      ${numCell("stock_in", row.stock_in, "text-success", ro)}
      ${row.transfer_in > 0 ? `<span class="pointer-events-none absolute inset-x-0 bottom-0 text-center text-[8px] font-extrabold leading-tight text-success">+${row.transfer_in}⇄</span>` : ""}
    </div>
    ${numCell("retail_sale", row.retail_sale, "text-danger", ro)}
    ${numCell("wholesale", row.wholesale, "text-danger", ro)}
    ${transferCell("transfer", row.transfer_out, ro)}
    ${numCell("destock", row.destock, "text-danger", ro)}
    ${textCell("destock_note", row.destock_note ?? "", "", ro)}
    ${transferCell("move", row.move, ro)}

    <div data-closing-cell class="flex flex-col items-center justify-center border-r border-hairline bg-brand-50/40 text-center">
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
    ${numCell("counted_qty", row.counted_qty ?? "", "text-gray-800", ro)}
    <div data-variance-chip class="flex items-center justify-center border-r border-hairline text-center text-[11px] font-bold ${
      row.hasVariance ? (row.variance > 0 ? "text-success" : "text-danger") : "text-gray-400"
    }">${row.hasVariance ? (row.variance > 0 ? "+" : "") + row.variance : "—"}</div>
    ${textCell("counted_note", row.counted_note ?? "", t("stock.countedNote"), ro)}`
        : ""
    }
  </div>`;
}

function recomputeRow(rowEl) {
  const num = (field) => Number(rowEl.querySelector(`[data-field="${field}"]`)?.value || 0);
  const opening = Number(rowEl.dataset.opening || 0);
  const stockIn = num("stock_in");
  const sale = num("retail_sale");
  const wholesale = num("wholesale");
  const destock = num("destock");
  // Transfers are saved the moment they are sent/received, so these three
  // come from the row's saved values, not from an input.
  const transferIn = Number(rowEl.dataset.transferIn || 0);
  const transferOut = Number(rowEl.dataset.transferOut || 0);
  const move = Number(rowEl.dataset.move || 0);
  const closingQty = opening + stockIn + transferIn - sale - wholesale - transferOut - destock - move;
  const bahtEach = Number(rowEl.dataset.bahtEach);
  const gramEach = Number(rowEl.dataset.gramEach);
  rowEl.querySelector("[data-closing-qty]").textContent = `${closingQty} pcs`;
  rowEl.querySelector("[data-closing-baht]").textContent = fmtBaht(closingQty * bahtEach);
  rowEl.querySelector("[data-low-chip]")?.classList.toggle("hidden", closingQty >= Number(rowEl.dataset.threshold || 0));

  const countedInput = rowEl.querySelector('[data-field="counted_qty"]');
  const varianceChip = rowEl.querySelector("[data-variance-chip]");
  const counted = countedInput ? (countedInput.value === "" ? null : Number(countedInput.value)) : undefined;
  if (countedInput && varianceChip) {
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
    counted,
    destock,
    gramEach,
    bahtEach,
    estLifetimeDays,
    lifetimeAlert,
    skuName: rowEl.dataset.skuName,
    skuIcon: rowEl.dataset.skuIcon,
  };
}

// The same rules the server enforces before a day can be marked Done,
// checked on screen first so staff see exactly which cells to fix.
function findDayProblems(root) {
  const problems = [];
  root.querySelectorAll("[data-row]").forEach((rowEl) => {
    const { closingQty, counted, destock } = recomputeRow(rowEl);
    const cell = (field) => rowEl.querySelector(`[data-field="${field}"]`);
    if (closingQty < 0) problems.push({ el: rowEl.querySelector("[data-closing-cell]"), rule: "negative_closing" });
    if (destock > 0 && !cell("destock_note").value.trim()) problems.push({ el: cell("destock_note"), rule: "destock_note_missing" });
    if (counted === null) problems.push({ el: cell("counted_qty"), rule: "count_missing" });
    else if (counted !== undefined && counted !== closingQty && !cell("counted_note").value.trim()) {
      problems.push({ el: cell("counted_note"), rule: "variance_note_missing" });
    }
  });
  return problems;
}

function showDayProblems(root, problems) {
  root.querySelectorAll(".day-problem").forEach((el) => el.classList.remove("day-problem", ...CELL_ERROR));
  const box = root.querySelector("#day-problems");
  if (problems.length === 0) {
    box.classList.add("hidden");
    return;
  }
  problems.forEach((p) => p.el?.classList.add("day-problem", ...CELL_ERROR));
  const counts = {};
  problems.forEach((p) => (counts[p.rule] = (counts[p.rule] ?? 0) + 1));
  box.innerHTML = `
    <div class="font-extrabold">${t("stock.fixBeforeDone")}</div>
    <ul class="mt-1 list-disc pl-4">
      ${Object.entries(counts)
        .map(([rule, n]) => `<li>${t(`stock.rule.${rule}`)} (${n})</li>`)
        .join("")}
    </ul>`;
  box.classList.remove("hidden");
  problems[0].el?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
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

// Gold sent to this desk that nobody has confirmed yet.
function incomingBanner(detail) {
  if (detail.status === "done" || detail.incoming.length === 0) return "";
  return `
    <div class="mb-3 rounded-xl border border-success/30 bg-success-bg p-3">
      <div class="mb-1.5 text-[11px] font-extrabold uppercase tracking-wide text-success">${t("stock.incomingTitle")} (${detail.incoming.length})</div>
      <div class="flex flex-col gap-1.5">
        ${detail.incoming
          .map(
            (x) => `
          <div class="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-2">
            <div class="min-w-0">
              <div class="truncate text-xs font-bold text-gray-900">${x.qty} × ${escapeHtml(x.name_en)}</div>
              <div class="truncate text-[10px] text-gray-500">${t("stock.fromDesk")} ${escapeHtml(x.from)} · ${fmtDate(x.sent_date)}</div>
            </div>
            <button data-receive="${x.id}" class="btn-primary shrink-0 px-3 py-2 text-xs">${t("stock.confirmReceive")}</button>
          </div>`
          )
          .join("")}
      </div>
    </div>`;
}

function renderDeskDetailPage(deskCard, detail) {
  const readOnly = detail.status === "done";
  const content = `
    <div id="edit-view">
      <p class="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-center text-[11px] font-medium text-gray-500">${t("stock.closingFormula")}</p>
      ${
        state.stock.date !== state.meta.today
          ? `<p class="mb-3 rounded-lg bg-warning-bg px-3 py-2 text-center text-[11px] font-bold text-warning">${tf("stock.viewingDate", { date: fmtDate(state.stock.date) })}</p>`
          : ""
      }
      ${detail.lastActorName ? `<p class="mb-3 text-center text-[11px] text-gray-500">${t("stock.lastActorPrefix")} ${escapeHtml(detail.lastActorName)}</p>` : ""}
      ${incomingBanner(detail)}

      <div class="card overflow-x-auto p-1">
        <div class="min-w-[740px]">
          ${rowsTableHeader(detail.status === "final_stock" || readOnly)}
          <div id="rows" class="flex flex-col">
            ${detail.rows.map((r) => rowTemplate(r, detail.status)).join("") || `<div class="py-8 text-center text-xs text-gray-500">${t("stock.noRows")}</div>`}
          </div>
        </div>
      </div>

      ${!readOnly ? `<button id="add-sku" class="btn-secondary mt-3 w-full py-2.5 text-xs">${t("stock.addSku")}</button>` : ""}

      <div id="day-problems" class="mt-3 hidden rounded-xl bg-danger-bg px-3.5 py-3 text-xs font-semibold text-danger" role="alert"></div>

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
          <div id="alert-sku-list" class="flex flex-col gap-1"></div>
        </div>
      </div>

      <label for="safe-drop" class="mt-4 block text-xs font-bold text-gray-600">${t("stock.safeDropNotes")}</label>
      <textarea id="safe-drop" rows="2" maxlength="500" placeholder="${t("stock.safeDropPlaceholder")}" class="input-filled mt-1.5" ${readOnly ? "disabled" : ""}>${escapeHtml(
    detail.safe_drop_note ?? ""
  )}</textarea>

      <div class="h-4"></div>

      <div class="sticky bottom-0 -mx-4 border-t border-hairline bg-white/95 px-4 pb-2 pt-3 backdrop-blur">
        ${
          readOnly
            ? `<p class="pt-1 text-center text-xs font-semibold text-success">${t("stock.doneLocked")}</p>
               ${detail.canReopen ? `<button id="reopen-day" class="btn-secondary mt-2 w-full border-danger/30 text-danger">${t("stock.reopen")}</button>` : ""}`
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

  setDeskTopbar(`${escapeHtml(deskCard.display_name)} · ${escapeHtml(deskCard.branch_name)}`, backToGrid);
  hideFab();
  const root = document.getElementById("view-root");
  root.innerHTML = content;
  root.scrollTo({ top: 0 });

  root.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("input", () => {
      const rowEl = input.closest("[data-row]");
      if (input.type === "number" && input.value !== "") {
        // Whole pieces only, never negative.
        const n = Math.min(999, Math.max(0, Math.floor(Number(input.value) || 0)));
        if (String(n) !== input.value) input.value = String(n);
      }
      rowEl.dataset.dirty = "1";
      input.classList.remove("day-problem", ...CELL_ERROR);
      recomputeTotals(root);
    });
  });
  recomputeTotals(root);

  const save = () => persistRows(deskCard.desk_id, root, detail);

  root.querySelectorAll("[data-remove-sku]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await save();
      await api.removeDeskSku(deskCard.desk_id, btn.dataset.removeSku, state.stock.date);
      btn.closest("[data-row]").remove();
      recomputeTotals(root);
      await syncCurrentCards();
    });
  });

  root.querySelectorAll("[data-transfer]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await save();
      const rowEl = btn.closest("[data-row]");
      openTransferSheet(deskCard, detail, rowEl.dataset.row, btn.dataset.transfer, recomputeRow(rowEl).closingQty);
    });
  });

  root.querySelectorAll("[data-receive]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await save();
      try {
        await api.receiveTransfer(btn.dataset.receive, state.stock.date);
        toast(t("stock.receivedToast"), "success");
      } finally {
        await reloadDeskDetail(deskCard);
      }
    });
  });

  root.querySelector("#add-sku")?.addEventListener("click", async () => {
    await save();
    openSkuPickerSheet(
      detail.rows.map((r) => r.sku_id),
      async (sku) => {
        // On a desk's very first day the starting stock can be typed in.
        const opening = detail.isFirstDay ? await askOpeningQty(sku) : 0;
        if (opening === null) return;
        await api.addDeskSku(deskCard.desk_id, { date: state.stock.date, sku_id: sku.sku_id, opening_qty: opening });
        await reloadDeskDetail(deskCard);
      }
    );
  });

  root.querySelector("#save-checkin")?.addEventListener("click", async () => {
    await save();
    toast(t("stock.progressSaved"), "success");
    await syncCurrentCards();
  });

  root.querySelector("#move-final")?.addEventListener("click", async () => {
    await save();
    await api.transitionDesk(deskCard.desk_id, { date: state.stock.date, toStatus: "final_stock" });
    toast(t("stock.statusFinalStock"), "success");
    // Stay on the desk: the count columns appear now.
    await reloadDeskDetail(deskCard);
  });

  root.querySelector("#mark-done")?.addEventListener("click", async () => {
    const problems = findDayProblems(root);
    showDayProblems(root, problems);
    await save();
    if (problems.length > 0) return toast(t("stock.fixBeforeDone"), "error");
    showReview(root, deskCard, detail);
  });

  root.querySelector("#reopen-day")?.addEventListener("click", () => openReopenSheet(deskCard));
}

function showReview(body, deskCard, detail) {
  const rows = [...body.querySelectorAll("[data-row]")].map((rowEl) => {
    const { closingQty, counted, bahtEach } = recomputeRow(rowEl);
    const original = detail.rows.find((r) => r.sku_id === rowEl.dataset.row);
    // What the day settles at: the physical count.
    const finalQty = counted ?? closingQty;
    return {
      sku_id: rowEl.dataset.row,
      name: rowEl.dataset.skuName,
      icon: original?.icon ?? "ring",
      finalQty,
      variance: finalQty - closingQty,
      finalBaht: finalQty * bahtEach,
      lowStock: finalQty < Number(rowEl.dataset.threshold || 0),
    };
  });
  const lowStockRows = rows.filter((r) => r.lowStock);
  const totalPcs = rows.reduce((s, r) => s + r.finalQty, 0);
  const totalBaht = rows.reduce((s, r) => s + r.finalBaht, 0);

  const reviewView = body.querySelector("#review-view");
  reviewView.innerHTML = `
    <p class="mb-4 text-center text-sm font-semibold text-gray-700">${t("stock.reviewBeforeDone")}</p>
    <div class="flex flex-col gap-2">
      ${rows
        .map(
          (r) => `
        <div class="flex items-center justify-between rounded-xl border border-hairline p-2.5">
          <span class="flex min-w-0 items-center gap-2 text-xs font-bold text-gray-900">${icon(r.icon, "h-4 w-4 shrink-0 text-brand-600")}<span class="truncate">${escapeHtml(r.name)}</span></span>
          <span class="flex shrink-0 items-center gap-2">
            ${r.variance ? `<span class="status-pill ${r.variance > 0 ? "bg-success-bg text-success" : "bg-danger-bg text-danger"}">${r.variance > 0 ? "+" : ""}${r.variance}</span>` : ""}
            ${r.lowStock ? `<span class="status-pill bg-danger-bg text-danger">${t("stock.lowShort")}</span>` : ""}
            <span class="text-xs font-extrabold text-gray-900">${r.finalQty} pcs</span>
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
        ? `<p class="mt-3 rounded-lg bg-warning-bg px-3 py-2.5 text-xs font-semibold text-warning">${tf("stock.lowStockReview", { n: lowStockRows.length })}</p>`
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

  const backToEdit = () => {
    reviewView.classList.add("hidden");
    reviewView.innerHTML = "";
    body.querySelector("#edit-view").classList.remove("hidden");
  };

  body.querySelector("#edit-view").classList.add("hidden");
  reviewView.classList.remove("hidden");
  body.scrollTo({ top: 0 });
  reviewView.querySelector("#review-back").focus();
  reviewView.querySelector("#review-back").addEventListener("click", backToEdit);

  reviewView.querySelector("#review-confirm").addEventListener("click", async () => {
    const closingToday = state.stock.date === state.meta.today;
    if (closingToday && isBeforeStockCutoff() && !window.confirm(t("stock.earlySubmitConfirm"))) return;
    try {
      await api.transitionDesk(deskCard.desk_id, { date: state.stock.date, toStatus: "done" });
    } catch (err) {
      // The server found something the screen did not (e.g. another tablet
      // changed a row) — show the page again with fresh numbers.
      if (err.code === "DAY_INCOMPLETE") await reloadDeskDetail(deskCard);
      throw err;
    }
    toast(t("stock.finalClosingSubmitted"), "success");
    backToGrid();
  });
}

// Sends only the rows that were actually edited, and only the fields staff
// type: transfers are saved through their own sheet.
async function persistRows(deskId, body, detail) {
  const dirtyRows = [...body.querySelectorAll('[data-row][data-dirty="1"]')];
  const safeDropEl = body.querySelector("#safe-drop");
  const safeDrop = safeDropEl && !safeDropEl.disabled ? safeDropEl.value.trim() || null : undefined;
  const safeDropChanged = safeDrop !== undefined && safeDrop !== (detail.safe_drop_note ?? null);
  if (dirtyRows.length === 0 && !safeDropChanged) return;

  const val = (rowEl, field) => rowEl.querySelector(`[data-field="${field}"]`);
  const rows = dirtyRows.map((rowEl) => {
    const counted = val(rowEl, "counted_qty");
    const countedNote = val(rowEl, "counted_note");
    return {
      sku_id: rowEl.dataset.row,
      stock_in: Number(val(rowEl, "stock_in").value || 0),
      retail_sale: Number(val(rowEl, "retail_sale").value || 0),
      wholesale: Number(val(rowEl, "wholesale").value || 0),
      destock: Number(val(rowEl, "destock").value || 0),
      destock_note: val(rowEl, "destock_note").value.trim() || null,
      ...(counted ? { counted_qty: counted.value === "" ? null : Number(counted.value) } : {}),
      ...(countedNote ? { counted_note: countedNote.value.trim() || null } : {}),
    };
  });
  await api.saveEntries(deskId, { date: state.stock.date, rows, ...(safeDropChanged ? { safe_drop_note: safeDrop } : {}) });
  dirtyRows.forEach((rowEl) => delete rowEl.dataset.dirty);
  if (safeDropChanged) detail.safe_drop_note = safeDrop;
}

// --- Transfer-out / Move ---

let destinationsCache = null;
async function loadDestinations() {
  if (!destinationsCache) destinationsCache = (await api.transferDestinations()).desks;
  return destinationsCache;
}

async function openTransferSheet(deskCard, detail, skuId, kind, available) {
  const row = detail.rows.find((r) => r.sku_id === skuId);
  const all = await loadDestinations();
  // Move stays inside the branch; Out goes to a desk in another branch.
  const destinations = all.filter((d) => d.desk_id !== deskCard.desk_id && (kind === "move" ? d.branch_id === deskCard.branch_id : d.branch_id !== deskCard.branch_id));
  const sent = detail.outgoing.filter((x) => x.sku_id === skuId && x.kind === kind);

  openSheet(
    `
    <p class="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-[11px] font-medium text-gray-600">${t(kind === "move" ? "stock.moveHint" : "stock.transferHint")}</p>
    <div class="mb-3 flex items-center justify-between rounded-xl border border-hairline px-3 py-2.5">
      <span class="min-w-0 truncate text-xs font-bold text-gray-900">${escapeHtml(pickName(row.name_en, row.name_lo))}</span>
      <span class="shrink-0 text-[11px] font-semibold text-gray-600">${t("stock.available")}: <b class="text-gray-900">${available}</b> pcs</span>
    </div>
    ${
      sent.length
        ? `<div class="mb-3 flex flex-col gap-1.5">
            ${sent
              .map(
                (x) => `
              <div class="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-2.5 py-2">
                <div class="min-w-0">
                  <div class="truncate text-xs font-bold text-gray-900">${x.qty} pcs → ${escapeHtml(x.to)}</div>
                  <div class="text-[10px] font-semibold ${x.status === "received" ? "text-success" : "text-warning"}">${t(x.status === "received" ? "stock.transferReceived" : "stock.inTransit")}</div>
                </div>
                ${x.status === "in_transit" ? `<button data-cancel="${x.id}" class="btn-secondary shrink-0 px-3 py-2 text-xs text-danger">${t("stock.cancelTransfer")}</button>` : ""}
              </div>`
              )
              .join("")}
          </div>`
        : ""
    }
    ${
      destinations.length === 0
        ? `<p class="py-4 text-center text-xs text-gray-500">${t("stock.noDestinations")}</p>`
        : `
    <label for="transfer-to" class="mb-1.5 block text-xs font-bold text-gray-600">${t("stock.destination")}</label>
    <select id="transfer-to" class="input-filled">
      ${destinations.map((d) => `<option value="${d.desk_id}">${escapeHtml(`${pickName(d.branch_name, d.branch_name_lo)} · ${d.display_name}`)}</option>`).join("")}
    </select>
    <label for="transfer-qty" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("stock.transferQty")}</label>
    <input id="transfer-qty" type="number" min="1" max="${available}" step="1" inputmode="numeric" class="input-filled text-center text-base font-extrabold" />
    <button id="transfer-send" class="btn-primary mt-4 w-full" ${available <= 0 ? "disabled" : ""}>${t("stock.sendTransfer")}</button>`
    }
  `,
    {
      title: `${t(kind === "move" ? "stock.move" : "stock.transferOut")} · ${escapeHtml(deskCard.display_name)}`,
      onMount: (body) => {
        body.querySelectorAll("[data-cancel]").forEach((btn) =>
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            try {
              await api.cancelTransfer(btn.dataset.cancel);
              toast(t("stock.transferCancelled"), "success");
            } finally {
              closeSheet();
              await reloadDeskDetail(deskCard);
            }
          })
        );
        body.querySelector("#transfer-send")?.addEventListener("click", async (e) => {
          const qty = Math.floor(Number(body.querySelector("#transfer-qty").value));
          if (!(qty > 0)) return toast(t("stock.needQty"), "error");
          if (qty > available) return toast(tf("stock.onlyAvailable", { n: available }), "error");
          e.currentTarget.disabled = true;
          try {
            await api.createTransfer({
              date: state.stock.date,
              fromDeskId: deskCard.desk_id,
              toDeskId: body.querySelector("#transfer-to").value,
              skuId,
              qty,
            });
            toast(t("stock.transferSent"), "success");
          } finally {
            closeSheet();
            await reloadDeskDetail(deskCard);
          }
        });
      },
    }
  );
}

// --- Admin: reopen a Done day ---

function openReopenSheet(deskCard) {
  openSheet(
    `
    <p class="mb-3 rounded-lg bg-warning-bg px-3 py-2.5 text-xs font-semibold text-warning">${t("stock.reopenWarning")}</p>
    <label for="reopen-reason" class="mb-1.5 block text-xs font-bold text-gray-600">${t("stock.reopenReason")}</label>
    <textarea id="reopen-reason" rows="3" maxlength="300" class="input-filled"></textarea>
    <button id="reopen-confirm" class="btn-primary mt-4 w-full">${t("stock.reopen")}</button>
  `,
    {
      title: `${t("stock.reopen")} · ${fmtDate(state.stock.date)}`,
      onMount: (body) => {
        body.querySelector("#reopen-confirm").addEventListener("click", async () => {
          const reason = body.querySelector("#reopen-reason").value.trim();
          if (reason.length < 3) return toast(t("stock.reopenReasonNeeded"), "error");
          await api.reopenDesk(deskCard.desk_id, { date: state.stock.date, reason });
          closeSheet();
          toast(t("stock.reopenedToast"), "success");
          await reloadDeskDetail(deskCard);
        });
      },
    }
  );
}

// Resolves to the typed opening quantity, or null when the sheet is closed.
function askOpeningQty(sku) {
  return new Promise((resolve) => {
    let answered = false;
    openSheet(
      `
      <p class="mb-3 text-xs text-gray-600">${t("stock.firstDayOpeningHint")}</p>
      <label for="first-opening" class="mb-1.5 block text-xs font-bold text-gray-600">${t("stock.openingQtyLabel")}</label>
      <input id="first-opening" type="number" min="0" step="1" inputmode="numeric" value="0" class="input-filled text-center text-base font-extrabold" />
      <button id="first-opening-ok" class="btn-primary mt-4 w-full">${t("stock.addSku")}</button>
    `,
      {
        title: escapeHtml(pickName(sku.name_en, sku.name_lo)),
        onMount: (body) => {
          body.querySelector("#first-opening-ok").addEventListener("click", () => {
            answered = true;
            const qty = Math.max(0, Math.floor(Number(body.querySelector("#first-opening").value) || 0));
            closeSheet();
            resolve(qty);
          });
          document.querySelectorAll("#sheet-host [data-close]").forEach((el) =>
            el.addEventListener("click", () => {
              if (!answered) resolve(null);
            })
          );
        },
      }
    );
  });
}

// --- SKU picker (select existing / create new), reused by the desk-detail
// "Add SKU" flow and the create-Case flow's opening-balance step. Only an
// admin may create a brand-new SKU in the master list. ---

async function renderSkuPickerInto(container, excludeSkuIds, onPick, onCancel) {
  container.innerHTML = `<div class="py-10 text-center text-sm text-gray-600">${t("stock.loadingDesks")}</div>`;
  const { skus } = await api.skus();
  const available = skus.filter((s) => !excludeSkuIds.includes(s.sku_id));
  const canCreate = isAdmin(state.user);
  container.innerHTML = `
    <button id="sku-back" class="mb-2 text-xs font-bold text-gray-500">&larr; ${t("login.back")}</button>
    ${canCreate ? `<button id="create-new-sku" class="btn-primary mb-3 w-full py-2.5 text-xs">${t("stock.createNewSku")}</button>` : ""}
    <div class="flex flex-col gap-1.5">
      ${
        available.length
          ? available
              .map(
                (s) => `
        <button data-pick-sku="${escapeHtml(s.sku_id)}" class="card flex items-center gap-2.5 p-2.5 text-left">
          <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">${icon(s.icon, "h-4 w-4")}</span>
          <span class="min-w-0">
            <span class="block truncate text-xs font-bold text-gray-900">${escapeHtml(pickName(s.name_en, s.name_lo))}</span>
            <span class="block text-[10px] text-gray-500">${escapeHtml([s.type_name, s.weight_name].filter(Boolean).join(" · ") || s.sku_id)}</span>
          </span>
        </button>`
              )
              .join("")
          : `<div class="py-6 text-center text-xs text-gray-500">${canCreate ? "—" : t("stock.askAdminForSku")}</div>`
      }
    </div>`;
  container.querySelector("#sku-back").addEventListener("click", onCancel);
  container.querySelector("#create-new-sku")?.addEventListener("click", () => renderCreateSkuFormInto(container, onPick, onCancel));
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
        <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.purityLabel")}</label>
        <select id="sku-purity" class="input-filled">
          <option value="">—</option>
          ${PURITY_OPTIONS.map((p) => `<option value="${p}">${p}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.bahtWeightLabel")}</label>
        <input id="sku-baht" type="number" step="0.01" min="0" value="0" class="input-filled" />
      </div>
    </div>
    <label class="mt-3 mb-1.5 block text-xs font-bold text-gray-600">${t("settings.priceLabel")}</label>
    <input id="sku-price" type="number" min="0" value="0" class="input-filled" />
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
          rows.push({ sku_id: sku.sku_id, name: pickName(sku.name_en, sku.name_lo), icon: sku.icon, opening_qty: 0 });
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
      <input id="case-name" type="text" maxlength="60" placeholder="${t("stock.caseNumberPlaceholder")}" value="${escapeHtml(caseName)}" class="input-filled" />

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
          <span class="min-w-0 flex-1 truncate text-xs font-bold text-gray-900">${escapeHtml(r.name)}</span>
          <input data-opening-input type="number" min="0" step="1" inputmode="numeric" value="${r.opening_qty}" aria-label="${t("stock.openingQtyLabel")}" class="w-16 rounded-lg border border-hairline py-1.5 text-center text-xs font-bold" />
          <button data-remove-row aria-label="${t("documents.delete")}" class="tap-target text-gray-400 hover:text-danger">×</button>
        </div>`
          )
          .join("")
      : `<div class="py-4 text-center text-xs text-gray-500">—</div>`;

    rowsEl.querySelectorAll("[data-case-row]").forEach((rowEl) => {
      const idx = Number(rowEl.dataset.caseRow);
      rowEl.querySelector("[data-opening-input]").addEventListener("input", (e) => {
        rows[idx].opening_qty = Math.max(0, Math.floor(Number(e.target.value) || 0));
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
      // The new case must show up in every desk picker straight away.
      state.meta = await api.meta();
      destinationsCache = null;
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
