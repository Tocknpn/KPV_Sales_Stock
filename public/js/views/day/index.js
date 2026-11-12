// The day screen: one case, one date, one vertical list. No horizontal scroll.
//
//   sticky top bar   back · Case · date · status · who · ⋯
//   sticky totals    pcs · Baht · low count · save state
//   groups of SKU cards (row.js), search, "only rows with activity"
//   sticky footer    [Start count] [✓ Close day]   (Done: [Reopen])
//
// stock.js owns the case cards and opens this with mountDay(deskCard, date, hooks).
import { api } from "../../api.js";
import { state } from "../../state.js";
import { toast, openActionSheet } from "../../ui.js";
import { fmtBaht, fmtInt, fmtDate, escapeHtml, statusPillClasses } from "../../util.js";
import { t } from "../../i18n.js";
import { closingOf, hasActivity, groupKeyOf, renderRow, skuName } from "./row.js";
import { createSaveQueue, clampQty } from "./save-queue.js";
import {
  tf,
  openInSheet,
  openOutSheet,
  openCountNoteSheet,
  openSafeDropSheet,
  openReopenSheet,
  openConflictSheet,
  openRemoveItemSheet,
} from "./sheets.js";
import { openMoveSheet } from "./move-sheet.js";

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

export async function mountDay(deskCard, date, hooks = {}) {
  await unmountDay();
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
    search: "",
    onlyActivity: false,
    collapsed: new Set(),
    problems: new Map(),
    saveState: "",
    closing: false,
    queue: null,
    ctx: null,
  };
  S = screen;

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
      if (res.code === "NEGATIVE_CLOSING") toast(tf("day.onlyAvailable", { n: res.available }), "error");
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
    screen.queue.dispose();
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
    if (closing < Number(r.threshold ?? 0)) low++;
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
      ${
        done
          ? ""
          : `<button id="day-menu" aria-label="${t("day.menu")}" class="focus-ring tap-target flex shrink-0 items-center justify-center rounded-full text-xl font-extrabold text-gray-600 active:bg-gray-100">⋯</button>`
      }
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
      ${S.saveState ? `<span class="text-gray-600" role="status">${S.saveState === "saving" ? t("day.saving") : S.saveState === "offline" ? `<b class="text-danger">${t("day.offline")}</b>` : t("day.saved")}</span>` : ""}
      ${low ? `<span class="font-extrabold text-danger">■ ${tf("day.lowCount", { n: low })}</span>` : ""}
    </span>`;
}

function renderScreen() {
  const root = $("#view-root");
  root.scrollTo({ top: 0 });
  root.innerHTML = `
    <div id="day-screen" class="min-w-0">
      <div id="day-notices"></div>
      ${
        S.rows.length
          ? `<div class="mb-3 flex flex-col gap-2">
               <input id="day-search" type="search" placeholder="${t("day.search")}" aria-label="${t("day.search")}" class="input-filled text-base" />
               <label class="flex min-h-[44px] items-center gap-2.5 text-sm font-semibold text-gray-700">
                 <input id="day-activity" type="checkbox" class="h-5 w-5 shrink-0 accent-brand-600" />
                 <span class="min-w-0">${t("day.onlyActivity")}</span>
               </label>
             </div>`
          : ""
      }
      <div id="day-list" class="flex flex-col gap-3"></div>
    </div>`;
  renderNotices();
  renderList();

  const screen = $("#day-screen");
  screen.addEventListener("click", onClick);
  screen.addEventListener("pointerdown", onPointerDown);
  screen.addEventListener("change", onChange);
  screen.addEventListener("input", onInput);
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
  if (!S.readOnly && detail.incoming.length) {
    parts.push(`
      <div class="mb-3 rounded-xl border border-success/30 bg-success-bg p-3">
        <div class="mb-1.5 text-xs font-extrabold uppercase tracking-wide text-success">${t("stock.incomingTitle")} (${detail.incoming.length})</div>
        <div class="flex flex-col gap-1.5">
          ${detail.incoming
            .map(
              (x) => `
            <div class="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-2">
              <div class="min-w-0">
                <div class="truncate text-sm font-bold text-gray-900">${x.qty} × ${escapeHtml(x.name_en)}</div>
                <div class="truncate text-xs text-gray-600">${t("stock.fromDesk")} ${escapeHtml(x.from)} · ${fmtDate(x.sent_date)}</div>
              </div>
              <button data-act="receive" data-id="${x.id}" class="btn-primary shrink-0 px-3 py-2 text-sm">${t("stock.confirmReceive")}</button>
            </div>`
            )
            .join("")}
        </div>
      </div>`);
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

function matches(r) {
  const q = S.search.trim().toLowerCase();
  if (q) {
    const hay = `${r.name_en} ${r.name_lo ?? ""} ${r.weight_name ?? ""} ${r.sku_id}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return !S.onlyActivity || hasActivity(r);
}

// Rows grouped by group_name (when the API has it), else by type; sizes by grams.
function groupRows() {
  const groups = new Map();
  for (const r of S.rows) {
    const key = groupKeyOf(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.gram_weight_each ?? 0) - (b.gram_weight_each ?? 0) || skuName(a).localeCompare(skuName(b)));
  }
  return [...groups.entries()].sort(([a], [b]) => (a || "￿").localeCompare(b || "￿"));
}

function groupMeta(list) {
  const pcs = list.reduce((s, r) => s + closingOf(r), 0);
  return `${tf("day.sizes", { n: list.length })} · ${fmtInt(pcs)} pcs`;
}

function rowHtml(r) {
  return renderRow(r, { readOnly: S.readOnly, countMode: S.countMode, problems: S.problems.get(r.sku_id) });
}

function renderList() {
  const list = $("#day-list");
  if (!list) return;
  if (S.rows.length === 0) {
    list.innerHTML = `<div class="py-8 text-center text-sm text-gray-600">${t("stock.noRows")}</div>`;
    return;
  }
  const html = groupRows()
    .map(([key, all]) => {
      const visible = all.filter(matches);
      if (visible.length === 0) return "";
      const open = !S.collapsed.has(key);
      return `
      <section data-group="${escapeHtml(key)}">
        <button type="button" data-act="group" aria-expanded="${open}" class="focus-ring tap-target flex w-full min-w-0 items-center gap-2 rounded-lg px-1 text-left">
          <span aria-hidden="true" class="shrink-0 text-gray-600">${open ? "▾" : "▸"}</span>
          <span class="min-w-0 flex-1 truncate text-sm font-extrabold text-gray-900">${escapeHtml(key || t("day.groupOther"))}</span>
          <span data-group-meta class="shrink-0 text-xs font-semibold tabular-nums text-gray-600">${groupMeta(all)}</span>
        </button>
        ${open ? `<div class="mt-1 flex flex-col gap-2.5">${visible.map(rowHtml).join("")}</div>` : ""}
      </section>`;
    })
    .join("");
  list.innerHTML = html || `<div class="py-8 text-center text-sm text-gray-600">${t("day.noMatches")}</div>`;
}

function refreshRow(sku) {
  if (!S) return;
  const el = document.querySelector(`#day-list [data-sku="${CSS.escape(sku)}"]`);
  const row = S.rows.find((r) => r.sku_id === sku);
  if (el && row) el.outerHTML = rowHtml(row);
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
    case "in":
      return openInSheet(S.ctx, sku);
    case "out":
      return openOutSheet(S.ctx, sku);
    case "move":
      return (async () => {
        const ctx = S.ctx;
        try {
          await ctx.queue.flushAll();
        } catch (err) {
          return toast(err.message || t("err.SERVER_ERROR"), "error");
        }
        openMoveSheet({
          desk: ctx.deskCard,
          date: ctx.date,
          detail: ctx.detail,
          rows: ctx.rows(),
          hooks: ctx.hooks,
          onDone: () => ctx.hooks.reload?.(),
          skuId: sku,
        });
      })();
    case "note":
      return openCountNoteSheet(S.ctx, sku);
    case "match": {
      const row = S.ctx.row(sku);
      const to = closingOf(row);
      row.counted_qty = to;
      S.ctx.rowChanged(sku);
      S.queue.set(sku, "counted_qty", to, { kind: "typed" });
      return;
    }
    case "group": {
      const key = btn.closest("[data-group]").dataset.group;
      if (S.collapsed.has(key)) S.collapsed.delete(key);
      else S.collapsed.add(key);
      return renderList();
    }
    case "count-mode":
      S.countMode = !S.countMode;
      renderList();
      return renderFooter();
    case "receive":
      return receiveIncoming(btn);
    case "reopen":
      return openReopenSheet(S.ctx);
    case "close":
      return closeDay();
  }
}

function onChange(e) {
  const input = e.target.closest("[data-count]");
  if (!input || !S) return;
  const sku = input.closest("[data-sku]").dataset.sku;
  const row = S.ctx.row(sku);
  const raw = input.value.trim();
  const to = raw === "" ? null : clampQty(raw);
  if (to === row.counted_qty) return refreshRow(sku);
  row.counted_qty = to;
  S.ctx.rowChanged(sku);
  S.queue.set(sku, "counted_qty", to, { kind: "typed" });
}

function onInput(e) {
  if (!S) return;
  if (e.target.id === "day-search") {
    S.search = e.target.value;
    renderList();
  } else if (e.target.id === "day-activity") {
    S.onlyActivity = e.target.checked;
    renderList();
  } else if (e.target.matches("[data-count]")) {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 5);
  }
}

function openMenu() {
  const options = [
    { label: t("stock.addSku"), value: "add" },
    { label: t("day.removeItem"), value: "remove" },
    { label: t("day.safeDrop"), value: "safe" },
  ];
  openActionSheet(t("day.menu"), options, async (opt) => {
    if (!S) return;
    if (opt.value === "safe") return openSafeDropSheet(S.ctx);
    if (opt.value === "remove") return openRemoveItemSheet(S.ctx);
    await S.queue.flushAll();
    const { deskCard, date, detail, hooks } = S;
    hooks.openSkuPicker?.(
      S.rows.map((r) => r.sku_id),
      async (sku) => {
        // On a desk's very first day the starting stock can be typed in.
        const opening = detail.isFirstDay ? await hooks.askOpeningQty(sku) : 0;
        if (opening === null) return;
        await api.addDeskSku(deskCard.desk_id, { date, sku_id: sku.sku_id, opening_qty: opening });
        await hooks.reload?.();
      }
    );
  });
}

async function receiveIncoming(btn) {
  btn.disabled = true;
  const { date, hooks } = S;
  await S.queue.flushAll();
  try {
    await api.receiveTransfer(btn.dataset.id, date);
    toast(t("stock.receivedToast"), "success");
  } finally {
    await hooks.reload?.();
  }
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
