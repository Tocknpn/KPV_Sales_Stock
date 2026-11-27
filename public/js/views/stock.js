import { api } from "../api.js";
import { state, branchName } from "../state.js";
import { toast, openSheet, closeSheet, openActionSheet } from "../ui.js";
import { fmtBaht, fmtInt, fmtDate, escapeHtml, fmtClock, fmtLaosStamp, laosDateOf, flameIcon, SHOW_VALUE } from "../util.js";
import { t, tf } from "../i18n.js";
import { renderCalendar } from "../calendar.js";
import { isAdmin } from "../session.js";
import { mountDay, unmountDay, showDayShell } from "./day/index.js";
import { go, pathFor, backTo } from "../router.js";
import { renderSkuPickerInto, openingRowsHtml, bindOpeningInputs } from "./sku-picker.js";
import { skeletonCards, skeletonCalendar } from "../skeleton.js";
import { caseSteps, cardBodyAction, statusIcon } from "../case-steps.js";

function setStockDate(date) {
  state.stock.date = date;
  const label = document.getElementById("date-label");
  if (label) label.textContent = fmtDate(date);
}

// route.sub is a desk id when the URL names one case: /daily_stock/<deskId>?date=…&tab=…
export async function mountStock(route = {}) {
  await unmountDay();
  const deskId = route.sub;
  if (deskId) {
    const date = route.params?.date;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) state.stock.date = date;
    const desk = state.meta.desks?.find((d) => d.desk_id === deskId);
    if (desk) state.stock.branch = desk.branch_id;
  }
  renderTopbar();
  await refreshCards();
  if (!deskId) return;
  const card = currentCards.find((d) => d.desk_id === deskId);
  const view = route.params?.view === "1";
  // Opening a case that was never checked in that day would check it in: show
  // the cards instead (view mode only looks, so it may open).
  if (card && (view || card.status !== "not_started")) await openDeskDetail(card, { fromRoute: true, tab: route.params?.tab, view });
  else go(pathFor("stock"), { replace: true });
}

function renderTopbar() {
  const branches = state.meta.branches;
  const admin = isAdmin(state.user);
  const el = document.getElementById("topbar-slot");
  const caret = `<svg class="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>`;
  // Row 1: title, date chip, overdue/active badges. Row 2: the branch, as small grey
  // text (a tappable chip only for an admin, who can switch branches).
  el.innerHTML = `
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <h1 class="text-lg font-extrabold text-gray-900">${t("stock.title")}</h1>
      <button id="date-select" class="chip shrink-0 gap-1 border-hairline bg-white py-1 text-gray-700">
        <span id="date-label">${fmtDate(state.stock.date)}</span>${caret}
      </button>
      <div id="stock-badges" class="ml-auto flex flex-wrap justify-end gap-1.5"></div>
    </div>
    <div class="mt-1">
      ${
        admin
          ? `<button id="branch-select" class="chip max-w-full gap-1 border-hairline bg-white py-0.5 text-[11px] text-gray-600"><span id="branch-label" class="truncate">${escapeHtml(branchName(state.stock.branch))}</span>${caret}</button>`
          : `<p id="branch-label" class="truncate text-[11px] font-medium text-gray-500">${escapeHtml(branchName(state.stock.branch))}</p>`
      }
    </div>`;

  if (admin) {
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

async function backToGrid() {
  await backTo(pathFor("stock"), async () => {
    await unmountDay();
    renderTopbar();
    await refreshCards();
  });
}

// Keeps currentCards fresh in the background while the user stays on the
// desk detail page — unlike refreshCards(), it never touches #view-root, so
// it won't blow away the page the user is looking at.
async function syncCurrentCards() {
  try {
    const { desks, today } = await api.deskCards(state.stock.date, state.stock.branch);
    currentCards = desks;
    currentToday = today;
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
        calRoot.innerHTML = skeletonCalendar();
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

let currentToday = null;

// The last case list shown, per branch and date. Coming back from a case
// paints it at once and then swaps in the fresh list (only if it changed), so
// Back never shows skeleton cards for a list the user just saw.
let cardsCache = null; // { key, sig, desks, branchSummary, today }
// Where the list was scrolled when a case was opened; restored on the way back.
let listScroll = null;

function paintCards({ desks, branchSummary, today }) {
  currentCards = desks;
  currentToday = today;
  renderBadges(desks, branchSummary);
  renderBody(desks, branchSummary);
  if (listScroll != null) {
    document.getElementById("view-root").scrollTop = listScroll;
    listScroll = null;
  }
}

// showLoading=false re-renders in place without the skeleton flash.
async function refreshCards(showLoading = true) {
  const root = document.getElementById("view-root");
  const key = `${state.stock.branch}|${state.stock.date}`;
  const cached = cardsCache?.key === key ? cardsCache : null;
  if (cached) paintCards(cached);
  else if (showLoading) root.innerHTML = skeletonCards();
  const data = await api.deskCards(state.stock.date, state.stock.branch);
  // The user may have switched date or branch while this loaded.
  if (key !== `${state.stock.branch}|${state.stock.date}`) return;
  const sig = JSON.stringify(data);
  const unchanged = cached?.sig === sig && document.getElementById("desk-list");
  cardsCache = { key, sig, ...data };
  if (!unchanged) paintCards(data);
  flashFinishedCard(data.desks);
}

// The day's data starts loading on pointerdown, 100–300 ms before the click
// fires; opening the case picks it up while it is still fresh.
const PREFETCH_MS = 5000;
let prefetched = null; // { key, promise, at }

function prefetchDetail(deskId, date) {
  const key = `${deskId}|${date}`;
  if (prefetched?.key === key && Date.now() - prefetched.at < PREFETCH_MS) return;
  const promise = api.deskDetail(deskId, date);
  promise.catch(() => {}); // the opener reports a failure, not this
  prefetched = { key, promise, at: Date.now() };
}

function loadDetail(deskId, date) {
  const p = prefetched;
  prefetched = null;
  if (p?.key === `${deskId}|${date}` && Date.now() - p.at < PREFETCH_MS) return p.promise;
  return api.deskDetail(deskId, date);
}

// View mode of a case not checked in on this date shows its last recorded day.
const detailDate = (desk, view) => (view && desk.status === "not_started" ? "latest" : state.stock.date);

// Set by a finished check-in / close; consumed by the next card render.
let pendingFlash = null;

function flashFinishedCard(desks) {
  if (!pendingFlash) return;
  const { deskId, kind } = pendingFlash;
  pendingFlash = null;
  const el = document.querySelector(`[data-card="${CSS.escape(deskId)}"]`);
  if (el) {
    el.scrollIntoView({ block: "center" });
    el.classList.add("card-flash");
    el.addEventListener("animationend", () => el.classList.remove("card-flash"), { once: true });
  }
  if (kind === "close" && desks.length > 1 && desks.every((d) => d.status === "done")) toast(t("done.allClosed"), "success", 3000);
}

function renderBadges(desks, summary) {
  const active = desks.filter((d) => d.status !== "done" && d.status !== "not_started").length;
  const el = document.getElementById("stock-badges");
  if (!el) return;
  el.innerHTML = `
    ${summary?.overdue ? `<span class="status-pill bg-danger-bg text-danger">⚠ ${summary.overdue} ${t("stock.badgeOverdue")}</span>` : ""}
    ${active ? `<span class="status-pill bg-brand-100 text-brand-700">${active} ${t("stock.badgeActive")}</span>` : ""}
  `;
}

function renderBody(desks, summary) {
  const root = document.getElementById("view-root");
  root.innerHTML = `
    ${
      summary
        ? `<p id="branch-line" class="mb-3 text-xs font-bold ${summary.overdue ? "text-danger" : "text-gray-700"}">${tf("stock.branchLine", { cases: summary.cases, checked: summary.checkedToday, overdue: summary.overdue })}</p>`
        : ""
    }
    <div id="desk-list"></div>
  `;
  renderFab();
  renderGrid(desks);
}

// Lives outside #view-root (like report.js's sticky footer) so it floats
// above the bottom nav near the Settings gear instead of scrolling with the
// case list. app.js calls unmountStock() before mounting any other view.
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
  unmountDay();
  document.getElementById("fab-new-case")?.remove();
}

// A desk cannot be worked while an earlier day is still not Done.
function blockedDate(desk) {
  return caseSteps(desk).goToDate;
}

const BADGE_LABEL = {
  alert: () => t("stock.statusOpening"),
  pending: () => t("step.badgePending"),
  done: () => t("step.badgeDone"),
};
const TONE_CLS = { red: "bg-danger-bg text-danger", amber: "bg-warning-bg text-warning", green: "bg-success-bg text-success" };
const ICON_PATH = {
  triangle: '<path d="M12 4 3 20h18L12 4Z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
};

// The case status as a 36 px icon (display only, not a button).
function statusIconHtml(badge) {
  const { icon, tone } = statusIcon(badge);
  return `<span role="img" aria-label="${escapeHtml(BADGE_LABEL[badge]())}" data-badge="${badge}" class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${TONE_CLS[tone]}"><svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATH[icon]}</svg></span>`;
}

// One step button: the active step is the primary button; done and locked steps are grey and disabled.
// The two share the card's width; the label sits in its own span so a long
// one ("Go to 18th Nov") ends in "…" instead of being cut off.
function stepButton(step, stepState, label) {
  if (stepState === "active") return `<button data-step="${step}" title="${escapeHtml(label)}" class="btn-primary min-w-0 overflow-hidden px-1.5 py-2 text-[11px]"><span class="min-w-0 truncate">${escapeHtml(label)}</span></button>`;
  const text = `${label}${stepState === "done" ? " ✓" : ""}`;
  return `<button data-step="${step}" disabled aria-disabled="true" title="${escapeHtml(text)}" class="btn-secondary min-w-0 cursor-not-allowed overflow-hidden bg-gray-100 px-1.5 py-2 text-[11px] text-gray-400"><span class="min-w-0 truncate">${escapeHtml(text)}</span></button>`;
}

// The warning line under an overdue card; other tiers say nothing extra.
function tierText(d) {
  const last = d.lastDoneDate ? fmtDate(d.lastDoneDate) : null;
  return last ? tf("stock.tierOverdue", { n: d.daysBehind, date: last }) : tf("stock.tierOverdueNever", { n: d.daysBehind });
}

// One compact row for every case. Overdue cases are sorted first by the server and
// only add a red left bar and the warning line; the card is never bigger.
// "Last: name · HH:mm"; with the date when the action was not on the viewed day; no time when unknown.
function lastStamp(d) {
  if (!d.lastActorAt) return tf("stock.lastStampNoTime", { name: d.lastActorName });
  const time = laosDateOf(d.lastActorAt) === state.stock.date ? fmtClock(d.lastActorAt) : fmtLaosStamp(d.lastActorAt);
  return tf("stock.lastStamp", { name: d.lastActorName, time });
}

const fmtGram = (n) => Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Two cards a row (one on very narrow phones). Weight in grams leads; Baht,
// pieces (and the value in LAK while SHOW_VALUE) follow; the two step buttons share the bottom.
function renderCard(d) {
  const overdue = d.tier === "overdue";
  const streak = d.streak > 365 ? "365+" : d.streak;
  const blocked = blockedDate(d);
  const steps = caseSteps(d);
  return `
    <div class="card flex min-w-0 flex-col border-l-4 px-2.5 py-2.5 ${overdue ? "border-l-danger" : "border-l-transparent"}" data-card="${d.desk_id}" data-tier="${d.tier}">
      <div class="flex items-start gap-1.5">
        <div class="min-w-0 flex-1 truncate text-sm font-extrabold leading-7 text-gray-900">${escapeHtml(d.display_name)}</div>
        ${statusIconHtml(steps.badge)}
      </div>
      <div class="truncate text-[15px] font-extrabold tabular-nums text-gray-900">${fmtGram(d.totalGram)} <span class="text-xs font-bold text-gray-600">g</span></div>
      <div class="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] font-bold text-gray-700">
        <span class="min-w-0 truncate tabular-nums">${fmtBaht(d.totalBaht)} Baht · ${fmtInt(d.totalPcs)} pcs</span>
        ${d.streak > 0 ? `<span class="inline-flex shrink-0 items-center gap-0.5 font-extrabold text-brand-700">${flameIcon()}${streak}<span class="sr-only"> ${t("stock.streakDays")}</span></span>` : ""}
        ${d.criticalCount > 0 ? `<span class="shrink-0 rounded-full bg-danger-bg px-1.5 font-extrabold text-danger" title="${escapeHtml(tf("replen.caseOrderCount", { n: d.criticalCount }))}">${t("replen.orderShort")} ${d.criticalCount}<span class="sr-only"> ${t("stock.criticalShort")}</span></span>` : ""}
      </div>
      ${SHOW_VALUE ? `<div class="truncate text-[11px] tabular-nums text-gray-500">≈ ${fmtInt(d.valueLak ?? 0)} LAK</div>` : ""}
      ${d.lastActorName ? `<div class="truncate text-[11px] text-gray-500">${escapeHtml(lastStamp(d))}</div>` : ""}
      ${overdue ? `<p class="mt-0.5 text-[11px] font-bold leading-snug text-danger">⚠ ${escapeHtml(tierText(d))}</p>` : ""}
      ${blocked ? `<p class="mt-0.5 text-[11px] font-bold leading-snug text-warning">${tf("stock.finishFirst", { date: fmtDate(d.openEarlierDate) })}</p>` : ""}
      <div class="mt-auto grid grid-cols-2 gap-1.5 pt-2">
        ${stepButton("checkIn", steps.checkIn, blocked ? tf("stock.goToDate", { date: fmtDate(blocked) }) : t("step.checkIn"))}
        ${stepButton("close", steps.close, t("step.close"))}
      </div>
    </div>`;
}

const GRID_CLS = "grid grid-cols-2 gap-2 max-[359px]:grid-cols-1";

// "My cases" (the viewer's main cases, set in Settings > Users) first, then
// the rest. Without main cases the list is one grid, as before.
function casesSection(title, desks, first) {
  return `
    <section class="${first ? "" : "mt-4"}">
      <h2 class="mb-2 flex items-center gap-1.5 text-xs font-extrabold text-gray-700">${escapeHtml(title)}<span class="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-bold text-gray-700">${fmtInt(desks.length)}</span></h2>
      <div class="${GRID_CLS}">${desks.map((d) => renderCard(d)).join("")}</div>
    </section>`;
}

function renderGrid(desks) {
  const list = document.getElementById("desk-list");
  if (desks.length === 0) {
    list.innerHTML = `<div class="py-10 text-center text-sm text-gray-600">${t("stock.noDesks")}</div>`;
    return;
  }
  const mine = desks.filter((d) => d.mine);
  const others = desks.filter((d) => !d.mine);
  list.innerHTML = mine.length
    ? casesSection(t("stock.myCases"), mine, true) + (others.length ? casesSection(t("stock.otherCases"), others, false) : "")
    : `<div class="${GRID_CLS}">${desks.map((d) => renderCard(d)).join("")}</div>`;

  const root = document.getElementById("view-root");
  root.querySelectorAll("[data-card]").forEach((card) => {
    const deskOf = () => currentCards.find((d) => d.desk_id === card.dataset.card);
    card.addEventListener("pointerdown", (e) => {
      const desk = deskOf();
      if (!desk) return;
      const btn = e.target.closest("[data-step]");
      if (!btn) return prefetchDetail(desk.desk_id, detailDate(desk, cardBodyAction(desk.status) === "view"));
      // A step button that checks in, or jumps to an earlier day, loads something else.
      if (btn.disabled || blockedDate(desk) || desk.status === "not_started") return;
      prefetchDetail(desk.desk_id, state.stock.date);
    });
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-step]")) return;
      const desk = deskOf();
      // The card body only looks: the same day screen, without the action footer.
      openDeskDetail(desk, { view: cardBodyAction(desk.status) === "view" });
    });
  });
  root.querySelectorAll("[data-step]:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => {
      const desk = currentCards.find((d) => d.desk_id === btn.closest("[data-card]").dataset.card);
      // ① checks in (or opens the day, or jumps to the earlier open day); ② opens the
      // day's grid to finish entering it — the footer's Close day then confirms.
      if (btn.dataset.step === "close") openDeskDetail(desk);
      else handleCardAction(desk);
    });
  });
}

// Remembers the list's scroll so Back lands where the user was.
function rememberListScroll() {
  if (document.getElementById("desk-list")) listScroll = document.getElementById("view-root").scrollTop;
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
    // The tap answers at once: the case's top bar and grid skeleton show while
    // the server opens the day.
    const path = pathFor("stock", desk.desk_id, { date: state.stock.date });
    rememberListScroll();
    go(path, { parent: pathFor("stock") });
    hideFab();
    showDayShell(desk, state.stock.date, dayHooks(desk));
    const stillHere = () => window.location.pathname + window.location.search === path;
    let res;
    try {
      res = await api.checkIn(desk.desk_id, state.stock.date);
    } catch (err) {
      if (err.code === "EARLIER_DAY_OPEN" && err.data.openDate) setStockDate(err.data.openDate);
      if (stillHere()) await backToGrid();
      throw err;
    }
    toast(`${desk.display_name} ${t("stock.checkedInToast")}`, "success");
    // Went back while it opened: the list just needs the new status.
    if (!stillHere()) return refreshCards(false);
    // The response carries the day: open it directly. The list refreshes when the user goes back.
    openDeskDetail({ ...desk, status: res.detail.status }, { detail: res.detail, fromRoute: true });
  } else {
    openDeskDetail(desk);
  }
}

// Opens one case on one date from elsewhere (the report grid). A case that was
// never checked in that day just shows the cards for the date: opening it here
// would check it in.
export async function openDeskDay(deskId, date) {
  await window.switchView("stock", { sub: deskId, params: { date } });
}

// view: opened from the card body: the same day screen, read-only, no footer.
async function openDeskDetail(deskCard, { fromRoute = false, tab, detail, view = false } = {}) {
  if (deskCard.status === "not_started" && !detail && !view) return handleCardAction(deskCard);
  if (!fromRoute) {
    rememberListScroll();
    go(pathFor("stock", deskCard.desk_id, { date: state.stock.date, view: view ? "1" : undefined }), { parent: pathFor("stock") });
  }
  hideFab();
  const date = detailDate(deskCard, view);
  await mountDay(deskCard, state.stock.date, dayHooks(deskCard, view), {
    tab: tab === "history" ? "history" : undefined,
    view,
    detail,
    load: () => loadDetail(deskCard.desk_id, date),
  });
}

// What the day screen needs from this file: the SKU picker (shared with
// "New case") and a way back to the cards.
function dayHooks(deskCard, view = false) {
  return {
    onBack: backToGrid,
    // A finished check-in / close: back to the cards, then flash that card.
    onDone: (kind) => {
      pendingFlash = { deskId: deskCard.desk_id, kind };
      return backToGrid();
    },
    reload: () => reloadDeskDetail(deskCard, view),
    openSkuPicker: (excludeSkuIds, onAdd) => openSkuPickerSheet(excludeSkuIds, onAdd, deskCard.branch_id),
    askOpeningQtys,
  };
}

// Reloads the day screen after something changed server-side (a transfer, an
// added SKU, a reopen) so every number on it is the saved one.
async function reloadDeskDetail(deskCard, view = false) {
  const date = detailDate(deskCard, view);
  await Promise.all([
    syncCurrentCards(),
    mountDay(deskCard, state.stock.date, dayHooks(deskCard, view), { view, load: () => api.deskDetail(deskCard.desk_id, date) }),
  ]);
}


// A quantity per newly added SKU: the opening while the day is in its opening
// step, or `label` (e.g. "Stock-in qty") after check-in. Resolves to a Map
// sku_id -> qty, or null when the sheet is closed without confirming.
function askOpeningQtys(skus, { types, weights }, { label } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const qty = new Map(skus.map((s) => [s.sku_id, 0]));
    const qtyLabel = label ?? t("stock.openingQtyLabel");
    openSheet(
      `
      ${label ? "" : `<p class="mb-3 text-xs text-gray-600">${t("stock.firstDayOpeningHint")}</p>`}
      <div id="opening-rows">${openingRowsHtml(skus.map((sku) => ({ sku, qty: 0 })), types, weights, { qtyLabel })}</div>
      <button id="opening-ok" class="btn-primary mt-3 mb-2 w-full">${tf("picker.addN", { n: fmtInt(skus.length) })}</button>
    `,
      {
        title: label ? escapeHtml(label) : t("picker.openingTitle"),
        onMount: (body) => {
          bindOpeningInputs(body, (id, q) => qty.set(id, q));
          body.querySelector("[data-opening-input]")?.focus();
          body.querySelector("#opening-ok").addEventListener("click", () => {
            answered = true;
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

// --- SKU picker sheet for a case's "Add SKU" ---

function openSkuPickerSheet(excludeSkuIds, onAdd, branchId) {
  openSheet(`<div id="sku-picker-root"></div>`, {
    title: t("stock.addSku"),
    onMount: (body) => {
      renderSkuPickerInto(body.querySelector("#sku-picker-root"), {
        excludeSkuIds,
        branchId,
        onAdd: (skus, meta) => {
          closeSheet();
          onAdd(skus, meta);
        },
        onCancel: closeSheet,
      });
    },
  });
}

// --- Create Case ---

async function openCreateCaseSheet() {
  let caseName = "";
  let mode = "form"; // "form" | "picker"
  let rows = []; // [{ sku, qty }]
  let meta = { types: [], weights: [] };
  let saving = false;

  const render = (body) => {
    if (mode === "picker") {
      renderSkuPickerInto(body, {
        excludeSkuIds: rows.map((r) => r.sku.sku_id),
        branchId: state.stock.branch,
        onAdd: (skus, loaded) => {
          meta = loaded;
          const firstNew = skus[0]?.sku_id;
          rows.push(...skus.map((sku) => ({ sku, qty: 0 })));
          mode = "form";
          render(body);
          body.querySelector(`[data-opening-row="${CSS.escape(firstNew ?? "")}"] [data-opening-input]`)?.focus();
        },
        onCancel: () => {
          mode = "form";
          render(body);
        },
      });
      return;
    }

    const summary = () => tf("picker.skuCount", { n: fmtInt(rows.length), pcs: fmtInt(rows.reduce((a, r) => a + r.qty, 0)) });
    body.innerHTML = `
      <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("stock.caseNumberLabel")}</label>
      <input id="case-name" type="text" maxlength="60" placeholder="${t("stock.caseNumberPlaceholder")}" value="${escapeHtml(caseName)}" class="input-filled" />

      <div class="mt-4 mb-1.5 flex items-baseline justify-between gap-2">
        <label class="text-xs font-bold text-gray-600">${t("stock.openingSkuSectionTitle")}</label>
        ${rows.length ? `<span id="case-sku-summary" class="text-[11px] font-semibold text-gray-500">${summary()}</span>` : ""}
      </div>
      <div id="case-sku-rows">${rows.length ? openingRowsHtml(rows, meta.types, meta.weights, { removable: true }) : `<div class="py-4 text-center text-xs text-gray-500">—</div>`}</div>
      <button id="case-add-sku" class="btn-secondary mt-1 w-full py-2 text-xs">${t("stock.addSku")}</button>

      <button id="create-case-submit" class="btn-primary mt-5 mb-2 w-full" ${saving ? "disabled" : ""}>${saving ? t("stock.creatingCase") : t("stock.createCaseButton")}</button>
    `;

    const rowsEl = body.querySelector("#case-sku-rows");
    bindOpeningInputs(rowsEl, (id, q) => {
      rows.find((r) => r.sku.sku_id === id).qty = q;
      const el = body.querySelector("#case-sku-summary");
      if (el) el.textContent = summary();
    });
    rowsEl.querySelectorAll("[data-remove-row]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = btn.closest("[data-opening-row]").dataset.openingRow;
        rows = rows.filter((r) => r.sku.sku_id !== id);
        render(body);
      })
    );

    body.querySelector("#case-name").addEventListener("input", (e) => {
      caseName = e.target.value;
    });
    body.querySelector("#case-add-sku").addEventListener("click", () => {
      mode = "picker";
      render(body);
    });

    const submit = body.querySelector("#create-case-submit");
    submit.addEventListener("click", async () => {
      if (saving) return;
      if (!caseName.trim()) return toast(t("stock.needCaseNumber"), "error");
      if (rows.length === 0) return toast(t("stock.needOneSku"), "error");
      saving = true;
      submit.disabled = true;
      submit.textContent = t("stock.creatingCase");
      try {
        await api.createDesk({
          branchId: state.stock.branch,
          displayName: caseName.trim(),
          openingSkus: rows.map((r) => ({ sku_id: r.sku.sku_id, opening_qty: r.qty })),
        });
      } catch (err) {
        saving = false;
        submit.disabled = false;
        submit.textContent = t("stock.createCaseButton");
        throw err;
      }
      // The new case must show up in every desk picker straight away.
      state.meta = await api.meta();
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
