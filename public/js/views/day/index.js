// The day screen: one case, one date, one stock grid.
//
//   sticky top bar   back · Case · date · status · who · ⋯
//   sticky totals    pcs · Baht · low count · save state
//   stock grid       sticky column header, slim group labels, one row per SKU
//                    (row.js); numbers are typed straight into the cells
//   sticky footer    [Start count] [✓ Close day]   (Done: [Reopen])
//
// The single-mode grid fits a phone; the dynamic one (retail / wholesale /
// destock) scrolls sideways with the SKU column pinned.
//
// stock.js owns the case cards and opens this with mountDay(deskCard, date, hooks).
import { api } from "../../api.js";
import { state } from "../../state.js";
import { toast, openActionSheet } from "../../ui.js";
import { fmtBaht, fmtInt, fmtDate, escapeHtml, statusPillClasses } from "../../util.js";
import { t } from "../../i18n.js";
import { closingOf, groupKeyOf, renderRow, patchRow, headerHtml, gridTemplate, gridMinWidth, skuName } from "./row.js";
import { createSaveQueue, clampQty, clampSigned } from "./save-queue.js";
import {
  tf,
  openCountNoteSheet,
  openDestockNoteSheet,
  openSafeDropSheet,
  openCaseInfoSheet,
  openReopenSheet,
  openConflictSheet,
  openRemoveItemSheet,
} from "./sheets.js";
import { renderHistory } from "./history.js";
import { replaceQuery } from "../../router.js";
import { skeletonTable } from "../../skeleton.js";

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

/** Same rules the server enforces on close, so staff see what to fix first. */
export function findProblems(rows) {
  const problems = new Map();
  const add = (sku, rule) => problems.set(sku, (problems.get(sku) ?? new Set()).add(rule));
  for (const r of rows) {
    const closing = closingOf(r);
    if (closing < 0) add(r.sku_id, "negative_closing");
    if (r.destock > 0 && !r.destock_note?.trim()) add(r.sku_id, "destock_note_missing");
    if (r.counted_qty == null) add(r.sku_id, "count_missing");
    else if (r.counted_qty !== closing && !r.counted_note?.trim()) add(r.sku_id, "variance_note_missing");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Screen state (one day screen at a time)
// ---------------------------------------------------------------------------
let S = null;

export async function mountDay(deskCard, date, hooks = {}, opts = {}) {
  await unmountDay();
  if (opts.tab) resumeTab = opts.tab;
  // First open of a case: show its shape while loading. A reload keeps the
  // current screen instead, so numbers do not flash away after a save.
  if (!document.getElementById("day-screen")) document.getElementById("view-root").innerHTML = skeletonTable(8, 4);
  const detail = await api.deskDetail(deskCard.desk_id, date);
  const rows = detail.rows.map((r) => ({ ...r }));
  const screen = {
    deskCard,
    date,
    detail,
    hooks,
    rows,
    stored: new Map(rows.map((r) => [r.sku_id, { ...r }])),
    readOnly: detail.status === "done",
    countMode: rows.some((r) => r.counted_qty != null),
    // The mode the day was opened in (the company setting at that moment).
    mode: detail.stock_out_mode === "single" ? "single" : "dynamic",
    tab: resumeTab ?? "stock",
    problems: new Map(),
    saveState: "",
    closing: false,
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
      }
      else if (res.code === "ROW_CHANGED") openConflictSheet(screen.ctx, res);
      else toast(res.message || t("err.SERVER_ERROR"), "error");
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
  renderScreen();
  renderFooter();
}

export async function unmountDay() {
  const screen = S;
  S = null;
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
    if (r.branch_status === "critical") low++;
  }
  return { pcs, baht, low };
}

function renderTopbar() {
  const { deskCard, date, detail } = S;
  const done = S.readOnly;
  $("#topbar-slot").innerHTML = `
    <div class="flex items-center gap-2">
      <button id="day-back" aria-label="${t("login.back")}" class="focus-ring tap-target -ml-1.5 flex shrink-0 items-center justify-center rounded-full text-gray-600 active:bg-gray-100">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
      </button>
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-base font-extrabold text-gray-900">${escapeHtml(deskCard.display_name)} · ${fmtDate(date)}</h1>
        <div class="flex min-w-0 items-center gap-2 text-xs text-gray-600">
          <span class="status-pill shrink-0 px-2 py-0.5 ${statusPillClasses(done ? "done" : "check_in")}">${done ? t("stock.statusDone") : t("day.statusOpen")}</span>
          ${detail.lastActorName ? `<span class="min-w-0 truncate">👤 ${escapeHtml(detail.lastActorName)}</span>` : ""}
        </div>
      </div>
      <button id="day-menu" aria-label="${t("day.menu")}" class="focus-ring tap-target flex shrink-0 items-center justify-center rounded-full text-xl font-extrabold text-gray-600 active:bg-gray-100">⋯</button>
    </div>
    <div id="day-totals" class="mt-2 flex items-center justify-between gap-2 text-sm"></div>`;
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

function renderScreen() {
  const root = $("#view-root");
  root.scrollTo({ top: 0 });
  root.innerHTML = `
    <div id="day-screen" class="min-w-0">
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
  screen.addEventListener("pointerdown", onPointerDown);
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

  if (S.readOnly) {
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

// Rows grouped by Type (Lao label, in the Types' order); sizes by grams.
function groupRows() {
  const groups = new Map();
  const order = new Map();
  for (const r of S.rows) {
    const key = groupKeyOf(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
    order.set(key, Math.min(order.get(key) ?? Infinity, key ? r.type_order ?? 999 : Infinity));
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.gram_weight_each ?? 0) - (b.gram_weight_each ?? 0) || skuName(a).localeCompare(skuName(b)));
  }
  return [...groups.entries()].sort(([a], [b]) => order.get(a) - order.get(b) || (a || "￿").localeCompare(b || "￿"));
}

function groupMeta(list) {
  const pcs = list.reduce((s, r) => s + closingOf(r), 0);
  return `${fmtInt(pcs)} pcs`;
}

function rowView(r) {
  return { readOnly: S.readOnly, countMode: S.countMode, mode: S.mode, problems: S.problems.get(r.sku_id) };
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
          <span class="min-w-0 truncate font-extrabold text-gray-900">${escapeHtml(key || t("day.groupOther"))}</span>
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
          ${headerHtml(S.mode, { countMode: S.countMode && !S.readOnly })}
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
  const group = row && document.querySelector(`#day-list [data-group="${CSS.escape(groupKeyOf(row))}"] [data-group-meta]`);
  if (group) group.textContent = groupMeta(S.rows.filter((r) => groupKeyOf(r) === groupKeyOf(row)));
}

function renderFooter() {
  let host = document.getElementById("day-footer");
  if (!host) {
    host = document.createElement("div");
    host.id = "day-footer";
    host.className = "fixed inset-x-0 z-20 mx-auto max-w-[430px] md:max-w-xl lg:max-w-2xl";
    document.body.appendChild(host);
  }
  // Sit directly above the bottom nav, whatever its height on this device.
  host.style.bottom = `${document.getElementById("bottom-nav")?.offsetHeight ?? 0}px`;
  host.innerHTML = S.readOnly
    ? S.detail.canReopen
      ? `<div class="border-t border-hairline bg-white/95 px-4 py-2 backdrop-blur">
           <button id="day-reopen" data-act="reopen" class="btn-secondary w-full border-danger/30 text-danger">${t("stock.reopen")}</button>
         </div>`
      : ""
    : `<div class="flex gap-2.5 border-t border-hairline bg-white/95 px-4 py-2 backdrop-blur">
         <button data-act="count-mode" aria-pressed="${S.countMode}" class="btn-secondary min-w-0 flex-1 px-2">${S.countMode ? t("day.stopCount") : t("day.startCount")}</button>
         <button data-act="close" class="btn-primary min-w-0 flex-1 px-2" ${S.closing ? "disabled" : ""}>${t("day.closeDay")}</button>
       </div>`;
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
  if (!btn) return;
  // "✓ matches" runs on pointerdown (see onPointerDown); only a keyboard
  // activation (click with no pointer, detail 0) comes through here.
  if (btn.dataset.act === "match" && e.detail !== 0) return;
  onAction(btn.dataset.act, btn);
}

// A focused count input fires change on blur, which re-renders the card and
// would swallow the click. Acting on pointerdown, without moving focus, keeps
// the first tap.
function onPointerDown(e) {
  const btn = e.target.closest('[data-act="match"]');
  if (!btn || btn.disabled) return;
  e.preventDefault();
  onAction("match", btn);
}

function onAction(act, btn) {
  if (!S) return;
  const sku = btn.closest("[data-sku]")?.dataset.sku;
  switch (act) {
    case "note":
      return openCountNoteSheet(S.ctx, sku);
    case "destock-note":
      return openDestockNoteSheet(S.ctx, sku);
    case "match": {
      const row = S.ctx.row(sku);
      const to = closingOf(row);
      row.counted_qty = to;
      S.ctx.rowChanged(sku);
      S.queue.set(sku, "counted_qty", to, { kind: "typed" });
      return;
    }
    case "sign":
      return flipMoveSign(sku, btn);
    case "count-mode":
      S.countMode = !S.countMode;
      renderList();
      return renderFooter();
    case "reopen":
      return openReopenSheet(S.ctx);
    case "close":
      return closeDay();
  }
}

// Move in/out: ± flips the sign of what is there. With nothing typed yet, the
// direction is remembered for the number typed next.
function flipMoveSign(sku, btn) {
  const row = S.ctx.row(sku);
  const strip = btn.closest("[data-move-strip]");
  const input = btn.closest("[data-move-cell]")?.querySelector('[data-field="move_qty"]');
  const current = row.move_qty ?? 0;
  const size = Math.abs(current) || Math.abs(clampSigned(parseSigned(input?.value)));
  const neg = !(current < 0 || strip?.dataset.pendingNeg === "1");
  if (!size) {
    if (strip) strip.dataset.pendingNeg = neg ? "1" : "";
    refreshRow(sku);
    input?.focus();
    return;
  }
  if (strip) strip.dataset.pendingNeg = "";
  saveField(sku, "move_qty", neg ? -size : size);
}

// "-5", "−5", "5", "-" or "" as a number (blank or a lone minus = 0).
function parseSigned(raw) {
  const v = String(raw ?? "").trim().replace(/[−–]/g, "-");
  if (v === "" || v === "-") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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
    const available = field === "move_qty" ? before - (row.move_qty ?? 0) : field === "stock_in" ? before : before + (row[field] ?? 0);
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
  if (!sku) return;
  const raw = input.value.trim();
  if (input.matches("[data-count]")) {
    const row = S.ctx.row(sku);
    const to = raw === "" ? null : clampQty(raw);
    if (to === row.counted_qty) return refreshRow(sku);
    row.counted_qty = to;
    S.ctx.rowChanged(sku);
    S.queue.set(sku, "counted_qty", to, { kind: "typed" });
    return;
  }
  const field = input.dataset.field;
  if (!field) return;
  if (field === "move_qty") {
    // The sign typed decides the direction; ± pressed before typing a plain number makes it an out.
    const strip = input.closest("[data-move-cell]")?.querySelector("[data-move-strip]");
    const pendingNeg = strip?.dataset.pendingNeg === "1";
    if (strip) strip.dataset.pendingNeg = "";
    let to = clampSigned(parseSigned(raw));
    if (pendingNeg && to > 0 && !/^\s*[-−–]/.test(raw)) to = -to;
    return saveField(sku, field, to);
  }
  saveField(sku, field, clampQty(raw || 0));
}

function onInput(e) {
  if (!S) return;
  if (e.target.matches('[data-field="move_qty"]')) {
    // Signed: one leading minus (any dash counts), then up to 5 digits.
    const v = e.target.value.replace(/[−–]/g, "-");
    const neg = v.trimStart().startsWith("-");
    e.target.value = (neg ? "-" : "") + v.replace(/\D/g, "").slice(0, 5);
  } else if (e.target.matches("[data-count], [data-field]")) {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 5);
  }
}

// Enter / "next" on the keypad moves on to the next cell, row by row.
function onKeyDown(e) {
  if (e.key !== "Enter" || !e.target.matches("[data-count], [data-field]")) return;
  e.preventDefault();
  const cells = [...document.querySelectorAll("#day-list [data-count], #day-list [data-field]")];
  const next = cells[cells.indexOf(e.target) + 1];
  if (next) next.focus();
  else e.target.blur();
}

// Select the whole number on focus so typing replaces it.
function onFocusIn(e) {
  if (!e.target.matches("[data-count], [data-field]")) return;
  const el = e.target;
  setTimeout(() => el.select?.(), 0);
}

function openMenu() {
  const info = { label: t("day.caseInfo"), value: "info" };
  // A Done day is read-only: only Case info is offered there.
  const options = S?.detail?.status === "done"
    ? [info]
    : [info, { label: t("stock.addSku"), value: "add" }, { label: t("day.removeItem"), value: "remove" }, { label: t("day.safeDrop"), value: "safe" }];
  openActionSheet(t("day.menu"), options, async (opt) => {
    if (!S) return;
    if (opt.value === "info") return openCaseInfoSheet(S.ctx);
    if (opt.value === "safe") return openSafeDropSheet(S.ctx);
    if (opt.value === "remove") return openRemoveItemSheet(S.ctx);
    await S.queue.flushAll();
    const { deskCard, date, detail, hooks } = S;
    hooks.openSkuPicker?.(
      S.rows.map((r) => r.sku_id),
      async (skus, meta) => {
        // On a desk's very first day the starting stock can be typed in.
        const openings = detail.isFirstDay ? await hooks.askOpeningQtys(skus, meta) : new Map();
        if (openings === null) return;
        try {
          await api.addDeskSkus(deskCard.desk_id, { date, items: skus.map((s) => ({ sku_id: s.sku_id, opening_qty: openings.get(s.sku_id) ?? 0 })) });
          toast(tf("picker.addedN", { n: skus.length }), "success");
        } finally {
          // Even after an error, show what was saved.
          await hooks.reload?.();
        }
      }
    );
  });
}

async function closeDay() {
  if (S.closing) return;
  const screen = S;
  screen.closing = true;
  renderFooter();
  try {
    await screen.queue.flushAll();
    const problems = findProblems(screen.rows);
    if (screen.queue.hasUnsaved()) return toast(t("day.unsaved"), "error");
    if (problems.size) return showProblems(problems);
    const closingToday = screen.date === state.meta.today;
    if (closingToday && isBeforeStockCutoff() && !window.confirm(t("stock.earlySubmitConfirm"))) return;
    try {
      await api.closeDay(screen.deskCard.desk_id, { date: screen.date });
    } catch (err) {
      // The server found something this screen did not (another tablet changed a row).
      if (err.code === "DAY_INCOMPLETE") {
        const failed = new Map();
        for (const f of err.data?.failures ?? []) failed.set(f.sku_id, (failed.get(f.sku_id) ?? new Set()).add(f.rule));
        return showProblems(failed);
      }
      throw err;
    }
    toast(t("stock.finalClosingSubmitted"), "success");
    await (screen.hooks.onBack ? screen.hooks.onBack() : screen.hooks.reload?.());
  } finally {
    screen.closing = false;
    if (S === screen) renderFooter();
  }
}

function showProblems(problems) {
  S.problems = problems;
  // A missing count or note is fixed in count mode.
  if ([...problems.values()].some((rules) => rules.has("count_missing") || rules.has("variance_note_missing"))) S.countMode = true;
  renderNotices();
  renderList();
  renderFooter();
  toast(t("stock.fixBeforeDone"), "error");
  const first = document.querySelector(`#day-list [data-sku="${CSS.escape([...problems.keys()][0] ?? "")}"]`);
  first?.scrollIntoView({ block: "center" });
}
