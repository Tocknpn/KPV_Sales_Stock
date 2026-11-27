// The day screen: one case, one date, one stock grid.
//
//   sticky top bar   back · Case · date · status · who · ⋯
//   sticky totals    pcs · Baht · low count · save state
//   stock grid       sticky column header, slim group labels, one row per SKU
//                    (row.js); numbers are typed straight into the cells
//   sticky footer    opening step:  [+ Add SKU] [✓ Confirm check-in]
//                    check-in step: [+ Add SKU] [✓ Close day]
//                    Done:          [Reopen]
//                    view mode:     none (the case card's body was tapped,
//                                   not its Check in / Close day button)
//
// Opening a case paints the top bar and a skeleton of the grid at once, from
// the card's data, so the tap answers before the day has loaded.
//
// The single-mode grid fits a phone; the dynamic one (retail / wholesale /
// return / withdraw) scrolls sideways with the SKU column pinned.
//
// stock.js owns the case cards and opens this with mountDay(deskCard, date, hooks).
import { api } from "../../api.js";
import { state } from "../../state.js";
import { toast, openActionSheet, openSheet, closeSheet, successOverlay } from "../../ui.js";
import { fmtBaht, fmtInt, fmtDate, escapeHtml, statusPillClasses } from "../../util.js";
import { t } from "../../i18n.js";
import { closingOf, groupKeyOf, renderRow, patchRow, headerHtml, gridTemplate, gridMinWidth, columnsFor, skuName } from "./row.js";
import { createSaveQueue, clampQty } from "./save-queue.js";
import {
  tf,
  openSafeDropSheet,
  openCaseInfoSheet,
  openReopenSheet,
  openConflictSheet,
  openRemoveItemSheet,
} from "./sheets.js";
import { renderHistory } from "./history.js";
import { addPlan, addItems, STEP_CHANGED_CODES, nextDayNegativeText } from "./day-rules.js";
import { replaceQuery } from "../../router.js";

// After Undo on the History tab the day reloads; this brings the tab back.
let resumeTab = null;

const STOCK_CUTOFF_HOUR = 15;
const STOCK_CUTOFF_MINUTE = 30;
// Fields copied from a server row onto the on-screen row.
const SYNC_FIELDS = [
  "opening_qty",
  "stock_in",
  "transfer_in",
  "retail_sale",
  "wholesale",
  "transfer_out",
  "destock",
  "withdraw",
  "destock_note",
  "move",
  "stock_out_single",
  "move_qty",
  "counted_qty",
  "counted_note",
];

// Closing before the day's cutoff asks for confirmation rather than blocking.
// Uses Laos time (UTC+7), not the tablet's clock.
export function isBeforeStockCutoff() {
  const laos = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const h = laos.getUTCHours();
  return h < STOCK_CUTOFF_HOUR || (h === STOCK_CUTOFF_HOUR && laos.getUTCMinutes() < STOCK_CUTOFF_MINUTE);
}

function laosClock(iso) {
  const d = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Same rule the server enforces on close (no count needed), so staff see what to fix first. */
export function findProblems(rows) {
  const problems = new Map();
  for (const r of rows) if (closingOf(r) < 0) problems.set(r.sku_id, new Set(["negative_closing"]));
  return problems;
}

// The steps in which the grid takes input (the rest is read-only).
const isEntryStep = (status) => status === "opening" || status === "check_in" || status === "final_stock";
const canClose = (status) => status === "check_in" || status === "final_stock";

// ---------------------------------------------------------------------------
// Screen state (one day screen at a time)
// ---------------------------------------------------------------------------
let S = null;
// Bumped on every unmount, so a load that finishes after the user has left
// (or opened another case) is dropped instead of painting over that screen.
let mountSeq = 0;

// Reloads the day once (several cells may fail with the same code at once).
function reloadForStep(screen) {
  if (S !== screen || screen.reloading) return;
  screen.reloading = true;
  Promise.resolve(screen.hooks.reload?.()).catch(() => {});
}

// opts: { detail?, load?: () => Promise<detail>, view?, tab?, step? }
export async function mountDay(deskCard, date, hooks = {}, opts = {}) {
  await unmountDay();
  const token = mountSeq;
  if (opts.tab) resumeTab = opts.tab;
  // First open of a case: its top bar and the grid's shape straight away. A
  // reload keeps the current screen instead, so numbers do not flash away.
  const fresh = !document.getElementById("day-screen");
  if (fresh) showDayShell(deskCard, date, hooks);
  let detail;
  try {
    detail = opts.detail ?? (await (opts.load ? opts.load() : api.deskDetail(deskCard.desk_id, date)));
  } catch (err) {
    if (token === mountSeq && fresh) hooks.onBack?.();
    throw err;
  }
  if (token !== mountSeq) return;
  const view = Boolean(opts.view);
  const rows = detail.rows.map((r) => ({ ...r }));
  const screen = {
    deskCard,
    date,
    detail,
    hooks,
    rows,
    stored: new Map(rows.map((r) => [r.sku_id, { ...r }])),
    status: detail.status,
    // View mode: the same screen, read-only, without the action footer.
    view,
    // A case not checked in on this date shows its last recorded day instead.
    shownDate: view && detail.date && detail.date !== date ? detail.date : null,
    readOnly: view || !isEntryStep(detail.status),
    // The mode the day was opened in (the company setting at that moment).
    mode: detail.stock_out_mode === "single" ? "single" : "dynamic",
    tab: resumeTab ?? "stock",
    problems: new Map(),
    saveState: "",
    closing: false,
    busy: false,
    // The home card's "② Close day" opens the screen with step=close: the close
    // sheet opens once the day has loaded (see consumeAutoClose).
    autoClose: !view && opts.step === "close",
    queue: null,
    ctx: null,
  };
  S = screen;
  resumeTab = null;

  screen.queue = createSaveQueue({
    deskId: deskCard.desk_id,
    date,
    getStored: (sku) => screen.stored.get(sku),
    onStored: (sku, serverRow) => {
      if (S !== screen) return;
      const stored = screen.stored.get(sku);
      const row = screen.rows.find((r) => r.sku_id === sku);
      for (const f of SYNC_FIELDS) {
        if (serverRow[f] === undefined) continue;
        stored[f] = serverRow[f];
        if (row && !screen.queue.isPending(sku, f)) row[f] = serverRow[f];
      }
      refreshRow(sku);
      refreshTotals();
    },
    onStatus: (s) => {
      screen.saveState = s;
      if (S === screen) refreshTotals();
    },
    onResult: (res) => {
      if (S !== screen) return;
      if (res.code === "NEGATIVE_CLOSING") {
        toast(tf("day.onlyAvailable", { n: res.available }), "error");
        refreshRow(res.skuId, { force: true });
      } else if (res.final) {
        // The step does not take this field (the day moved on elsewhere): show the saved value.
        toast(res.message || t(`err.${res.code}`), "error");
        refreshRow(res.skuId, { force: true });
      }
      else if (res.code === "ROW_CHANGED") openConflictSheet(screen.ctx, res);
      else toast(res.message || t("err.SERVER_ERROR"), "error");
      // The day moved on (or back) on another device: show its real step.
      if (STEP_CHANGED_CODES.has(res.code)) reloadForStep(screen);
    },
  });

  screen.ctx = {
    deskCard,
    date,
    detail,
    hooks,
    queue: screen.queue,
    row: (sku) => screen.rows.find((r) => r.sku_id === sku),
    rows: () => screen.rows,
    rowChanged: (sku) => {
      screen.problems.delete(sku);
      refreshRow(sku);
      refreshTotals();
      renderNotices();
    },
  };

  renderTopbar();
  renderScreen({ reveal: fresh });
  renderFooter();
  consumeAutoClose();
}

// The case's top bar (from the card) and a skeleton in the grid's own
// columns, painted before the day loads. Back works straight away.
export function showDayShell(deskCard, date, hooks = {}) {
  $("#topbar-slot").innerHTML = topbarHtml(deskCard, date, `<span class="skeleton inline-block h-5 w-24 rounded-full"></span>`);
  $("#day-back").addEventListener("click", () => (hooks.onBack ? hooks.onBack() : unmountDay()));
  $("#day-totals").innerHTML = `<span class="skeleton inline-block h-4 w-40"></span>`;
  const root = $("#view-root");
  root.scrollTo({ top: 0 });
  root.innerHTML = skeletonDay();
}

function skeletonDay() {
  const mode = state.meta.config?.stock_out_mode === "single" ? "single" : "dynamic";
  const cols = gridTemplate(mode);
  const minW = gridMinWidth(mode);
  const n = columnsFor(mode).length + 3;
  const repeat = (k, html) => html.repeat(k);
  const row = `<div class="grid gap-1.5 px-1 py-1" style="grid-template-columns:${cols}">${repeat(n, `<div class="skeleton h-[52px] rounded-xl"></div>`)}</div>`;
  const group = (k) => `<div class="px-2 pb-1 pt-2.5"><div class="skeleton h-3 w-32"></div></div>${repeat(k, row)}`;
  return `
    <div role="status" aria-busy="true">
      <span class="sr-only">${t("settings.loading")}</span>
      <div class="mb-3 flex gap-1 rounded-xl bg-gray-100 p-1"><div class="skeleton h-11 flex-1 bg-white"></div><div class="h-11 flex-1"></div></div>
      <div class="card overflow-hidden px-1.5 pb-2">
        <div style="${minW ? `min-width:${minW}px` : ""}">
          <div class="grid gap-1.5 border-b border-hairline px-1 pb-2 pt-3" style="grid-template-columns:${cols}">${repeat(n, `<div class="skeleton h-3"></div>`)}</div>
          ${group(3)}${group(2)}
        </div>
      </div>
    </div>`;
}

// step=close from the home card: open the close sheet once, then drop the flag
// and the URL parameter so a reload does not open it again.
function consumeAutoClose() {
  if (!S?.autoClose) return;
  S.autoClose = false;
  replaceQuery({ step: null });
  if (canClose(S.status)) closeDay();
}

export async function unmountDay() {
  const screen = S;
  S = null;
  mountSeq++;
  document.getElementById("day-footer")?.remove();
  if (screen) {
    await screen.queue.flushAll().catch(() => {});
    // Still unsent after the last try (offline, or a failing server): leaving
    // drops them, so say so clearly instead of losing them silently.
    const left = screen.queue.hasUnsaved() ? Math.max(1, screen.queue.unsavedCount()) : 0;
    screen.queue.dispose();
    if (left > 0) toast(tf("day.unsavedLeft", { n: left }), "error", 9000);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

function totals() {
  let pcs = 0;
  let baht = 0;
  let low = 0;
  for (const r of S.rows) {
    const closing = closingOf(r);
    pcs += closing;
    baht += closing * (r.baht_weight_each || 0);
    if (r.branch_status === "order_now" || r.branch_status === "late") low++;
  }
  return { pcs, baht, low };
}

// The top bar; `statusHtml` is the status line under the title (a skeleton
// while the day loads).
function topbarHtml(deskCard, date, statusHtml, { menu = false } = {}) {
  return `
    <div class="flex items-center gap-2">
      <button id="day-back" aria-label="${t("login.back")}" class="focus-ring tap-target -ml-1.5 flex shrink-0 items-center justify-center rounded-full text-gray-600 active:bg-gray-100">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
      </button>
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-base font-extrabold text-gray-900">${escapeHtml(deskCard.display_name)} · ${fmtDate(date)}</h1>
        <div class="flex min-h-[22px] min-w-0 items-center gap-2 text-xs text-gray-600">${statusHtml}</div>
      </div>
      ${
        menu
          ? `<button id="day-menu" aria-label="${t("day.menu")}" class="focus-ring tap-target flex shrink-0 items-center justify-center rounded-full text-xl font-extrabold text-gray-600 active:bg-gray-100">⋯</button>`
          : `<span class="tap-target shrink-0" aria-hidden="true"></span>`
      }
    </div>
    <div id="day-totals" class="mt-2 flex min-h-[20px] items-center justify-between gap-2 text-sm"></div>`;
}

function renderTopbar() {
  const { deskCard, date, detail } = S;
  // A case not checked in on this date (view mode) reads "Not checked in",
  // whatever the last recorded day it shows was.
  const pill = S.shownDate ? "opening" : S.status === "done" ? "done" : S.status === "opening" ? "opening" : "check_in";
  const label = { done: t("stock.statusDone"), opening: t("stock.statusOpening"), check_in: t("day.statusOpen") }[pill];
  const actor = !S.shownDate && detail.lastActorName ? `<span class="min-w-0 truncate">👤 ${escapeHtml(detail.lastActorName)}</span>` : "";
  $("#topbar-slot").innerHTML = topbarHtml(deskCard, date, `<span class="status-pill shrink-0 px-2 py-0.5 ${statusPillClasses(pill)}">${label}</span>${actor}`, { menu: true });
  $("#day-back").addEventListener("click", () => (S?.hooks.onBack ? S.hooks.onBack() : unmountDay()));
  $("#day-menu")?.addEventListener("click", openMenu);
  refreshTotals();
}

function refreshTotals() {
  const el = $("#day-totals");
  if (!el || !S) return;
  const { pcs, baht, low } = totals();
  el.innerHTML = `
    <span class="min-w-0 truncate font-extrabold tabular-nums text-gray-900">${fmtInt(pcs)} pcs · ${fmtBaht(baht, 2)} Baht</span>
    <span class="flex shrink-0 items-center gap-2 text-xs font-semibold">
      ${S.saveState ? `<span class="text-gray-600" role="status">${S.saveState === "saving" ? t("day.saving") : S.saveState === "offline" ? `<b class="text-danger">${t("day.offline")}</b>` : S.saveState === "error" ? `<b class="text-danger">${t("day.saveFailed")}</b>` : t("day.saved")}</span>` : ""}
      ${low ? `<span class="font-extrabold text-danger">■ ${tf("day.lowCount", { n: low })}</span>` : ""}
    </span>`;
}

// reveal: the first paint after the skeleton fades in instead of popping.
function renderScreen({ reveal = false } = {}) {
  const root = $("#view-root");
  root.scrollTo({ top: 0 });
  root.innerHTML = `
    <div id="day-screen" class="min-w-0 ${reveal ? "day-reveal" : ""}">
      <div role="tablist" aria-label="${t("day.menu")}" class="mb-3 flex gap-1 rounded-xl bg-gray-100 p-1">
        ${["stock", "history"]
          .map(
            (id) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${S.tab === id}" class="focus-ring tap-target min-w-0 flex-1 rounded-lg px-2 text-sm font-extrabold ${S.tab === id ? "bg-white text-brand-700 shadow-card" : "text-gray-600"}">${t(id === "stock" ? "history.tabStock" : "history.tab")}</button>`
          )
          .join("")}
      </div>
      <div id="day-history" class="${S.tab === "history" ? "" : "hidden"}"></div>
      <div id="day-stock" class="${S.tab === "stock" ? "" : "hidden"}">
      <div id="day-notices"></div>
      <div id="day-list"></div>
      </div>
    </div>`;
  renderNotices();
  renderList();
  if (S.tab === "history") showHistory();

  const screen = $("#day-screen");
  screen.addEventListener("click", onClick);
  screen.addEventListener("change", onChange);
  screen.addEventListener("input", onInput);
  screen.addEventListener("keydown", onKeyDown);
  screen.addEventListener("focusin", onFocusIn);
}

function showHistory() {
  const screen = S;
  renderHistory(document.getElementById("day-history"), {
    deskId: screen.deskCard.desk_id,
    date: screen.date,
    onUndone: async () => {
      resumeTab = "history";
      await screen.hooks.reload?.();
    },
  });
}

function setTab(tab) {
  if (!S || S.tab === tab) return;
  S.tab = tab;
  replaceQuery({ tab: tab === "stock" ? null : tab });
  document.querySelectorAll("#day-screen [data-tab]").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.setAttribute("aria-selected", String(on));
    b.classList.toggle("bg-white", on);
    b.classList.toggle("text-brand-700", on);
    b.classList.toggle("shadow-card", on);
    b.classList.toggle("text-gray-600", !on);
  });
  document.getElementById("day-stock").classList.toggle("hidden", tab !== "stock");
  document.getElementById("day-history").classList.toggle("hidden", tab !== "history");
  if (tab === "history") showHistory();
}

function renderNotices() {
  const el = $("#day-notices");
  if (!el || !S) return;
  const { detail } = S;
  const parts = [];

  if (S.view && (S.shownDate || S.status !== "done")) {
    const text = S.shownDate ? tf("day.viewLatest", { date: fmtDate(S.shownDate) }) : tf("day.viewOnly", { checkIn: t("step.checkIn"), close: t("step.close") });
    parts.push(`<p class="mb-3 rounded-lg bg-gray-100 px-3 py-2.5 text-sm font-semibold text-gray-700">${escapeHtml(text)}</p>`);
  } else if (S.status === "opening") {
    parts.push(`<p class="mb-3 rounded-lg bg-brand-50 px-3 py-2.5 text-sm font-semibold text-brand-700">${t("day.openingHint")}</p>`);
  }
  if (S.status === "done" && !S.shownDate) {
    parts.push(`
      <p class="mb-3 rounded-lg bg-success-bg px-3 py-2.5 text-center text-sm font-bold text-success">
        ${
          detail.closed_at
            ? tf("day.closedBanner", { time: laosClock(detail.closed_at), name: escapeHtml(detail.closed_by_name ?? "—") })
            : t("stock.doneLocked")
        }
      </p>`);
  }
  if (state.stock.date !== state.meta.today) {
    parts.push(`<p class="mb-3 rounded-lg bg-warning-bg px-3 py-2 text-center text-xs font-bold text-warning">${tf("stock.viewingDate", { date: fmtDate(S.date) })}</p>`);
  }
  if (S.problems.size) {
    const counts = {};
    for (const rules of S.problems.values()) for (const rule of rules) counts[rule] = (counts[rule] ?? 0) + 1;
    parts.push(`
      <div role="alert" class="mb-3 rounded-xl bg-danger-bg px-3.5 py-3 text-sm font-semibold text-danger">
        <div class="font-extrabold">${t("stock.fixBeforeDone")}</div>
        <ul class="mt-1 list-disc pl-4">${Object.entries(counts)
          .map(([rule, n]) => `<li>${t(`stock.rule.${rule}`)} (${n})</li>`)
          .join("")}</ul>
      </div>`);
  }
  el.innerHTML = parts.join("");
}

// SKUs added today (not carried from the previous day) sit in their own
// section on top, so staff find them again at close among up to 50 rows.
const NEW_KEY = "new";
const sectionKeyOf = (r) => (r.added_today ? NEW_KEY : `t:${groupKeyOf(r)}`);

// Rows grouped by Type (Lao label, in the Types' order); sizes by grams.
function groupRows() {
  const groups = new Map();
  const order = new Map();
  for (const r of S.rows) {
    const key = sectionKeyOf(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
    const rank = key === NEW_KEY ? -Infinity : groupKeyOf(r) ? r.type_order ?? 999 : Infinity;
    order.set(key, Math.min(order.get(key) ?? Infinity, rank));
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.gram_weight_each ?? 0) - (b.gram_weight_each ?? 0) || skuName(a).localeCompare(skuName(b)));
  }
  return [...groups.entries()].sort(([a], [b]) => order.get(a) - order.get(b) || (a === "t:" ? "￿" : a).localeCompare(b === "t:" ? "￿" : b));
}

// A group's pieces and gold weight, on the same basis as the totals in the top bar.
export function groupMeta(list) {
  let pcs = 0;
  let baht = 0;
  for (const r of list) {
    const closing = closingOf(r);
    pcs += closing;
    baht += closing * (r.baht_weight_each || 0);
  }
  return `${fmtInt(pcs)} pcs · ${fmtBaht(baht, 2)} Baht`;
}

function rowView(r) {
  // View mode: no cell takes input, whatever the day's step.
  return { status: S.view ? "view" : S.status, mode: S.mode, problems: S.problems.get(r.sku_id) };
}

function rowHtml(r) {
  return renderRow(r, rowView(r));
}

function renderList() {
  const list = $("#day-list");
  if (!list) return;
  if (S.rows.length === 0) {
    list.innerHTML = `<div class="py-8 text-center text-sm text-gray-600">${t("stock.noRows")}</div>`;
    return;
  }
  const cols = gridTemplate(S.mode);
  const minW = gridMinWidth(S.mode);
  const width = minW ? `min-width:${minW}px;` : "";
  // Slim, fixed group labels: no collapsing, the rows are always shown.
  const groups = groupRows()
    .map(
      ([key, rows]) => `
      <section data-group="${escapeHtml(key)}">
        <div class="sticky left-0 flex w-fit max-w-[calc(100vw-4rem)] items-center gap-2 px-2 pb-1 pt-2.5 text-xs">
          <span class="min-w-0 truncate font-extrabold ${key === NEW_KEY ? "text-brand-700" : "text-gray-900"}">${escapeHtml(key === NEW_KEY ? t("day.addedToday") : key.slice(2) || t("day.groupOther"))}</span>
          <span data-group-meta class="shrink-0 font-semibold tabular-nums text-gray-500">${groupMeta(rows)}</span>
        </div>
        <div class="flex flex-col gap-1">${rows.map(rowHtml).join("")}</div>
      </section>`
    )
    .join("");
  // The header sits outside the sideways scroller so it can stick to the top
  // of the page, and follows the body's horizontal scroll.
  list.innerHTML = `
    <div class="card px-1.5 pb-2">
      <div id="grid-head-wrap" class="sticky -top-4 z-[2] -mx-1.5 overflow-hidden rounded-t-2xl border-b border-hairline bg-white px-1.5">
        <div class="grid items-end gap-1.5 px-1 pb-1.5 pt-2.5 text-center text-[11px] font-bold leading-tight text-gray-600" style="grid-template-columns:${cols};${width}">
          ${headerHtml(S.mode)}
        </div>
      </div>
      <div id="grid-body" class="overflow-x-auto overscroll-x-contain">
        <div style="${width}">${groups}</div>
      </div>
    </div>`;
  const head = $("#grid-head-wrap");
  $("#grid-body").addEventListener("scroll", (e) => (head.scrollLeft = e.currentTarget.scrollLeft), { passive: true });
}

function refreshRow(sku, opts) {
  if (!S) return;
  const el = document.querySelector(`#day-list [data-sku="${CSS.escape(sku)}"]`);
  const row = S.rows.find((r) => r.sku_id === sku);
  if (el && row) patchRow(el, row, rowView(row), opts);
  const group = row && document.querySelector(`#day-list [data-group="${CSS.escape(sectionKeyOf(row))}"] [data-group-meta]`);
  if (group) group.textContent = groupMeta(S.rows.filter((r) => sectionKeyOf(r) === sectionKeyOf(row)));
}

function renderFooter() {
  let host = document.getElementById("day-footer");
  if (!host) {
    host = document.createElement("div");
    host.id = "day-footer";
    host.className = "fixed inset-x-0 z-20 mx-auto max-w-[430px] md:max-w-xl lg:max-w-2xl";
    document.body.appendChild(host);
  }
  // View mode has no actions: no footer at all.
  if (S.view) {
    host.remove();
    return;
  }
  // Sit directly above the bottom nav, whatever its height on this device.
  host.style.bottom = `${document.getElementById("bottom-nav")?.offsetHeight ?? 0}px`;
  const busy = S.closing || S.busy ? "disabled" : "";
  const bar = (primary) => `<div class="flex gap-2.5 border-t border-hairline bg-white/95 px-4 py-2 backdrop-blur">
         <button data-act="add-sku" class="btn-secondary min-w-0 flex-1 px-2" ${busy}>${t("stock.addSku")}</button>
         ${primary}
       </div>`;
  if (S.status === "opening") {
    host.innerHTML = bar(`<button data-act="confirm-check-in" class="btn-primary min-w-0 flex-1 px-2" ${busy}>${t("day.confirmCheckIn")}</button>`);
  } else if (canClose(S.status)) {
    host.innerHTML = bar(`<button data-act="close" class="btn-primary min-w-0 flex-1 px-2" ${busy}>${t("day.closeDay")}</button>`);
  } else {
    host.innerHTML = S.detail.canReopen
      ? `<div class="border-t border-hairline bg-white/95 px-4 py-2 backdrop-blur">
           <button id="day-reopen" data-act="reopen" class="btn-secondary w-full border-danger/30 text-danger">${t("stock.reopen")}</button>
         </div>`
      : "";
  }
  host.onclick = (e) => {
    const btn = e.target.closest("[data-act]");
    if (btn) onAction(btn.dataset.act, btn);
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function onClick(e) {
  const tab = e.target.closest("[data-tab]");
  if (tab) return setTab(tab.dataset.tab);
  const btn = e.target.closest("[data-act]");
  if (btn) onAction(btn.dataset.act);
}

function onAction(act) {
  if (!S) return;
  switch (act) {
    case "reopen":
      return openReopenSheet(S.ctx);
    case "close":
      return closeDay();
    case "confirm-check-in":
      return confirmCheckIn();
    case "add-sku":
      return addSkus();
  }
}

// One typed value: check it locally (closing may not drop below zero), show it,
// then queue it. The server has the last word (NEGATIVE_CLOSING).
function saveField(sku, field, to) {
  const row = S.ctx.row(sku);
  if (to === (row[field] ?? 0)) return refreshRow(sku);
  const before = closingOf(row);
  const after = closingOf({ ...row, [field]: to });
  if (after < 0 && after < before) {
    // How much this cell could take out at most, given everything else on the row.
    const available = field === "stock_in" || field === "opening_qty" ? before : before + (row[field] ?? 0);
    toast(tf("day.onlyAvailable", { n: Math.max(available, 0) }), "error");
    return refreshRow(sku, { force: true });
  }
  row[field] = to;
  S.ctx.rowChanged(sku);
  S.queue.set(sku, field, to, { kind: "typed" });
}

function onChange(e) {
  if (!S) return;
  const input = e.target;
  const sku = input.closest("[data-sku]")?.dataset.sku;
  const field = input.dataset.field;
  if (!sku || !field) return;
  saveField(sku, field, clampQty(input.value.trim() || 0));
}

function onInput(e) {
  if (!S) return;
  if (e.target.matches("[data-field]")) e.target.value = e.target.value.replace(/\D/g, "").slice(0, 5);
}

// Enter / "next" on the keypad moves on to the next cell, row by row.
function onKeyDown(e) {
  if (e.key !== "Enter" || !e.target.matches("[data-field]")) return;
  e.preventDefault();
  const cells = [...document.querySelectorAll("#day-list [data-field]")];
  const next = cells[cells.indexOf(e.target) + 1];
  if (next) next.focus();
  else e.target.blur();
}

// Select the whole number on focus so typing replaces it.
function onFocusIn(e) {
  if (!e.target.matches("[data-field]")) return;
  const el = e.target;
  setTimeout(() => el.select?.(), 0);
}

function openMenu() {
  const info = { label: t("day.caseInfo"), value: "info" };
  // A Done day is read-only: only Case info is offered there.
  const options = S?.readOnly
    ? [info]
    : [info, { label: t("stock.addSku"), value: "add" }, { label: t("day.removeItem"), value: "remove" }, { label: t("day.safeDrop"), value: "safe" }];
  openActionSheet(t("day.menu"), options, async (opt) => {
    if (!S) return;
    if (opt.value === "info") return openCaseInfoSheet(S.ctx);
    if (opt.value === "safe") return openSafeDropSheet(S.ctx);
    if (opt.value === "remove") return openRemoveItemSheet(S.ctx);
    if (opt.value === "add") return addSkus();
  });
}

// + Add SKU: in the opening step each new item takes its opening; after
// check-in it takes a stock-in quantity instead.
async function addSkus() {
  if (!S || S.readOnly) return;
  const screen = S;
  await screen.queue.flushAll();
  const { deskCard, date, hooks } = screen;
  const opening = screen.status === "opening";
  hooks.openSkuPicker?.(
    screen.rows.map((r) => r.sku_id),
    async (skus, meta) => {
      // A SKU the day carried (removed earlier today) keeps its carried opening:
      // it is restored without asking for one.
      const { ask, field } = addPlan(skus, opening, screen.detail.carriedSkus);
      const qtys = ask.length ? await hooks.askOpeningQtys(ask, meta, opening ? {} : { label: t("day.stockInQty") }) : new Map();
      if (qtys === null) return;
      let ok = false;
      try {
        await api.addDeskSkus(deskCard.desk_id, { date, items: addItems(skus, field, qtys) });
        toast(tf("picker.addedN", { n: skus.length }), "success");
        ok = true;
      } catch (err) {
        // Another device added it first (SKU_ALREADY_ON_DAY), or the day moved
        // on: say why, then show what is saved.
        toast(err.message || t("err.SERVER_ERROR"), "error");
      } finally {
        await hooks.reload?.();
      }
      if (ok) showAdded(skus.map((s) => s.sku_id));
    }
  );
}

// Takes staff straight to the first row they just added: scrolled into view,
// flashed once, its first open input focused.
function showAdded(ids) {
  const el = ids.map((id) => document.querySelector(`#day-list [data-sku="${CSS.escape(id)}"]`)).find(Boolean);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  el.classList.remove("card-flash");
  void el.offsetWidth;
  el.classList.add("card-flash");
  el.querySelector("input:not([disabled]):not([readonly])")?.focus({ preventScroll: true });
}

// ✓ Confirm check-in: the opening review is done; selling may start.
async function confirmCheckIn() {
  if (!S || S.busy || S.status !== "opening") return;
  const screen = S;
  screen.busy = true;
  renderFooter();
  try {
    await screen.queue.flushAll();
    if (screen.queue.hasUnsaved()) return toast(t("day.unsaved"), "error");
    try {
      await api.transitionDesk(screen.deskCard.desk_id, { date: screen.date, toStatus: "check_in" });
    } catch (err) {
      // A refusal (EARLIER_DAY_OPEN, BAD_TRANSITION ...): stay here and show what is saved.
      toast(err.message || t("err.SERVER_ERROR"), "error");
      await screen.hooks.reload?.();
      return;
    }
    // Done: confirm it, and go back to the case list underneath so the next case is one tap away.
    await finishStep(screen, "checkIn");
  } finally {
    screen.busy = false;
    if (S === screen) renderFooter();
  }
}

// After a successful check-in or close: the success overlay plays while the
// case list loads behind it, so the user lands on the list ready for the next case.
async function finishStep(screen, kind) {
  const title = t(kind === "close" ? "done.closeTitle" : "done.checkInTitle");
  const back = screen.hooks.onDone ? screen.hooks.onDone(kind) : screen.hooks.onBack ? screen.hooks.onBack() : screen.hooks.reload?.();
  await Promise.all([successOverlay(title, screen.deskCard.display_name), Promise.resolve(back).catch(() => {})]);
}

// Day totals for the close sheet, in pieces.
export function dayTotals(rows) {
  const sum = (f) => rows.reduce((n, r) => n + (r[f] ?? 0), 0);
  return {
    stock_in: sum("stock_in"),
    retail_sale: sum("retail_sale"),
    wholesale: sum("wholesale"),
    destock: sum("destock"),
    withdraw: sum("withdraw"),
    stock_out_single: sum("stock_out_single"),
    closing: rows.reduce((n, r) => n + closingOf(r), 0),
  };
}

// ✓ Close day: save everything, check for negative closings, then confirm
// with the day's totals before the server marks it Done. No count is needed.
async function closeDay() {
  if (!S || S.closing || !canClose(S.status)) return;
  const screen = S;
  screen.closing = true;
  renderFooter();
  try {
    await screen.queue.flushAll();
    if (screen.queue.hasUnsaved()) return toast(t("day.unsaved"), "error");
    const problems = findProblems(screen.rows);
    if (problems.size) return showProblems(problems);
    openCloseSheet(screen);
  } finally {
    screen.closing = false;
    if (S === screen) renderFooter();
  }
}

const TOTAL_LABEL = {
  stock_in: "grid.in",
  retail_sale: "grid.retail",
  wholesale: "grid.wholesale",
  destock: "grid.destock",
  withdraw: "grid.withdraw",
  stock_out_single: "grid.out",
};

function openCloseSheet(screen) {
  const tot = dayTotals(screen.rows);
  const outs = screen.mode === "single" ? ["stock_out_single"] : ["retail_sale", "wholesale", "destock", "withdraw"];
  const line = (label, n, cls) =>
    `<div class="flex justify-between gap-4 py-2"><dt class="text-gray-600">${label}</dt><dd class="font-extrabold tabular-nums ${cls}">${fmtInt(n)}</dd></div>`;
  const early = screen.date === state.meta.today && isBeforeStockCutoff();
  openSheet(
    `
    ${early ? `<p class="mb-3 rounded-lg bg-warning-bg px-3 py-2.5 text-sm font-semibold text-warning">${t("stock.earlySubmitConfirm")}</p>` : ""}
    <p class="mb-1 text-xs font-bold text-gray-500">${t("day.closeTotalsHint")}</p>
    <dl class="divide-y divide-hairline text-sm">
      ${line(t(TOTAL_LABEL.stock_in), tot.stock_in, "text-success")}
      ${outs.map((f) => line(t(TOTAL_LABEL[f]), tot[f], "text-danger")).join("")}
      ${line(t("grid.closing"), tot.closing, "text-brand-700")}
    </dl>
    <button type="button" data-confirm class="btn-primary mt-4 w-full">${t("day.closeConfirm")}</button>
  `,
    {
      title: `${t("day.closeDay")} · ${escapeHtml(screen.deskCard.display_name)} · ${fmtDate(screen.date)}`,
      onMount: (body) => {
        body.querySelector("[data-confirm]").addEventListener("click", (e) => {
          e.currentTarget.disabled = true;
          closeSheet();
          submitClose(screen);
        });
      },
    }
  );
}

async function submitClose(screen) {
  if (screen.closing) return;
  screen.closing = true;
  if (S === screen) renderFooter();
  try {
    try {
      await api.closeDay(screen.deskCard.desk_id, { date: screen.date });
    } catch (err) {
      // The server found something this screen did not (another tablet changed a row).
      if (err.code === "DAY_INCOMPLETE") {
        const failed = new Map();
        for (const f of err.data?.failures ?? []) failed.set(f.sku_id, (failed.get(f.sku_id) ?? new Set()).add(f.rule));
        if (S === screen) showProblems(failed);
        return;
      }
      // Which item would go below zero on which later day.
      if (err.code === "NEXT_DAY_NEGATIVE") return toast(nextDayNegativeText(err.data, screen.rows, fmtDate), "error");
      if (STEP_CHANGED_CODES.has(err.code)) {
        toast(err.message || t(`err.${err.code}`), "error");
        return reloadForStep(screen);
      }
      throw err;
    }
    await finishStep(screen, "close");
  } finally {
    screen.closing = false;
    if (S === screen) renderFooter();
  }
}

function showProblems(problems) {
  S.problems = problems;
  renderNotices();
  renderList();
  renderFooter();
  toast(t("stock.fixBeforeDone"), "error");
  const first = document.querySelector(`#day-list [data-sku="${CSS.escape([...problems.keys()][0] ?? "")}"]`);
  first?.scrollIntoView({ block: "center" });
}
