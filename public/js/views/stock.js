import { api } from "../api.js";
import { state, branchName } from "../state.js";
import { toast, openSheet, closeSheet, openActionSheet } from "../ui.js";
import { fmtBaht, fmtInt, fmtDate, icon, statusPillClasses, escapeHtml, fmtClock, laosDateOf, flameIcon } from "../util.js";
import { t, tf, pickName } from "../i18n.js";
import { renderCalendar } from "../calendar.js";
import { isAdmin } from "../session.js";
import { casesChipHtml, refreshCasesChip, wireCasesChip } from "./cases-switcher.js";
import { switchUser } from "./login.js";
import { mountDay, unmountDay } from "./day/index.js";

const PURITY_OPTIONS = ["96.5%", "99.99%"];

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
      <div id="stock-badges" class="flex flex-wrap justify-end gap-1.5"></div>
    </div>
    <div class="mt-3 flex items-center gap-2">
      ${casesChipHtml()}
      <button id="switch-user" class="chip ml-auto shrink-0 border-hairline bg-white text-gray-700">${t("switchUser.button")}</button>
    </div>
    <div class="mt-2 flex gap-2">
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
  document.getElementById("switch-user").addEventListener("click", () => switchUser(state.user.branchId));
  wireCasesChip(() => state.stock.branch, () => refreshCards(false));
  refreshCasesChip(state.stock.branch);
}

async function backToGrid() {
  await unmountDay();
  renderTopbar();
  refreshCards();
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

let currentToday = null;

// showLoading=false re-renders in place (after a take/release) without the spinner flash.
async function refreshCards(showLoading = true) {
  const root = document.getElementById("view-root");
  if (showLoading) root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">${t("stock.loadingDesks")}</div>`;
  const { desks, branchSummary, today } = await api.deskCards(state.stock.date, state.stock.branch);
  currentCards = desks;
  currentToday = today;
  renderBadges(desks, branchSummary);
  renderBody(desks, branchSummary);
  refreshCasesChip(state.stock.branch);
}

function renderBadges(desks, summary) {
  const active = desks.filter((d) => d.status !== "done" && d.status !== "not_started").length;
  const el = document.getElementById("stock-badges");
  if (!el) return;
  el.innerHTML = `
    ${summary?.overdue ? `<span class="status-pill bg-danger-bg text-danger">⚠ ${summary.overdue} ${t("stock.badgeOverdue")}</span>` : ""}
    ${summary?.behind1 ? `<span class="status-pill bg-warning-bg text-warning">${summary.behind1} ${t("stock.badgeBehind")}</span>` : ""}
    ${summary?.checkedToday ? `<span class="status-pill bg-success-bg text-success">${summary.checkedToday} ${t("stock.badgeDone")}</span>` : ""}
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
    <div id="overdue-strip" class="mb-3 hidden flex-col gap-3"></div>
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
  unmountDay();
  document.getElementById("fab-new-case")?.remove();
}

// A desk cannot start a new day while an earlier day is still not Done.
function blockedDate(desk) {
  return desk.status === "not_started" && desk.openEarlierDate ? desk.openEarlierDate : null;
}

// Tier look (spec CR3): left bar + tint + a text line that always names the tier.
const TIER_STYLE = {
  done_today: { bar: "border-l-success", tint: "", text: "text-success" },
  on_track: { bar: "border-l-gray-300", tint: "", text: "text-gray-600" },
  behind_1: { bar: "border-l-amber-500", tint: "bg-warning-bg", text: "text-warning" },
  overdue: { bar: "border-l-danger", tint: "bg-danger-bg", text: "text-danger" },
};

function tierText(d) {
  const last = d.lastDoneDate ? fmtDate(d.lastDoneDate) : null;
  switch (d.tier) {
    case "done_today":
      return d.lastDoneByName
        ? tf("stock.tierDoneToday", { time: d.lastDoneAt ? fmtClock(d.lastDoneAt) : "", name: d.lastDoneByName })
        : tf("stock.tierDoneTodayNoName", { time: d.lastDoneAt ? fmtClock(d.lastDoneAt) : "" });
    case "behind_1":
      return tf("stock.tierBehind1", { date: last ?? "—" });
    case "overdue":
      return last ? tf("stock.tierOverdue", { n: d.daysBehind, date: last }) : tf("stock.tierOverdueNever", { n: d.daysBehind });
    default:
      return d.openedAt ? tf("stock.tierOnTrackOpen", { time: fmtClock(d.openedAt) }) : t("stock.tierOnTrackIdle");
  }
}

// A free case, or one whose holder is stale (took it on an earlier day), can be taken.
// A same-day holder needs a manager (the server answers NOT_HOLDER).
function canTake(d) {
  if (isAdmin(state.user)) return false;
  if (!d.assignee) return true;
  return d.assignee.stale && d.assignee.staffId !== state.user.accountId;
}

function holderLine(d) {
  const a = d.assignee;
  if (!a) return `<span class="text-gray-500">${t("stock.noHolder")}</span>`;
  const name = escapeHtml(a.name ?? "");
  if (!a.stale) return `<span class="font-semibold text-gray-800">👤 ${tf("stock.holderSince", { name, time: fmtClock(a.since) })}</span>`;
  const sinceDate = laosDateOf(a.since);
  const yesterday = currentToday ? new Date(Date.parse(`${currentToday}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : null;
  const when = sinceDate === yesterday ? t("stock.yesterday") : fmtDate(sinceDate);
  return `<span class="text-gray-500">${tf("stock.lastHolder", { name, when })}</span>`;
}

function renderCard(d) {
  const ts = TIER_STYLE[d.tier] ?? TIER_STYLE.on_track;
  const streak = d.streak > 365 ? "365+" : d.streak;
  return `
    <div class="card flex flex-col gap-2.5 border-l-4 p-3.5 ${ts.bar} ${ts.tint}" data-card="${d.desk_id}" data-tier="${d.tier}">
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

      <div class="flex items-start justify-between gap-2">
        <p class="min-w-0 text-[11px] font-bold leading-snug ${ts.text}">${escapeHtml(tierText(d))}</p>
        ${
          d.streak > 0
            ? `<span class="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-extrabold text-brand-700">${flameIcon()}${streak}<span class="sr-only"> ${t("stock.streakDays")}</span></span>`
            : ""
        }
      </div>

      <div class="flex items-baseline gap-1">
        <span class="text-xl font-extrabold text-gray-900">${fmtBaht(d.totalBaht)}</span>
        <span class="text-[11px] font-semibold text-gray-600">Baht</span>
      </div>
      <div class="flex items-center justify-between text-[11px] text-gray-600">
        <span>${fmtInt(d.totalPcs)} pcs</span>
        ${d.criticalCount > 0 ? `<span class="font-bold text-danger">⚠ ${d.criticalCount} ${t("stock.criticalShort")}</span>` : ""}
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div class="min-w-0">${holderLine(d)}</div>
        ${canTake(d) ? `<button data-take="${d.desk_id}" class="tap-target rounded-full border border-brand-600 px-3 text-[11px] font-bold text-brand-700 active:bg-brand-50">${t("stock.takeCase")}</button>` : ""}
      </div>
      ${
        blockedDate(d)
          ? `<p class="rounded-lg bg-warning-bg px-2 py-1.5 text-[10px] font-bold leading-tight text-warning">${tf("stock.finishFirst", { date: fmtDate(d.openEarlierDate) })}</p>`
          : ""
      }

      <button data-action="${d.desk_id}" class="btn-${d.status === "done" ? "secondary" : "primary"} mt-1 w-full py-2 text-xs">
        ${blockedDate(d) ? tf("stock.goToDate", { date: fmtDate(d.openEarlierDate) }) : actionLabel(d.status)}
      </button>
    </div>`;
}

function renderGrid(desks) {
  const grid = document.getElementById("desk-grid");
  const strip = document.getElementById("overdue-strip");
  if (desks.length === 0) {
    strip.classList.add("hidden");
    grid.innerHTML = `<div class="col-span-full py-10 text-center text-sm text-gray-600">${t("stock.noDesks")}</div>`;
    return;
  }

  // Overdue cases are pinned in a full-width strip above the grid.
  const overdue = desks.filter((d) => d.tier === "overdue");
  const rest = desks.filter((d) => d.tier !== "overdue");
  strip.classList.toggle("hidden", overdue.length === 0);
  strip.classList.toggle("flex", overdue.length > 0);
  strip.innerHTML = overdue.length
    ? `<h2 class="text-xs font-extrabold uppercase tracking-wide text-danger">⚠ ${tf("stock.overdueStrip", { n: overdue.length })}</h2>${overdue.map((d) => renderCard(d)).join("")}`
    : "";
  grid.innerHTML = rest.map((d) => renderCard(d)).join("");

  const root = document.getElementById("view-root");
  root.querySelectorAll("[data-card]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action], [data-take]")) return;
      const desk = currentCards.find((d) => d.desk_id === card.dataset.card);
      // Not started today has no opening-balance row to show yet (it's only
      // materialized on check-in), so tapping the card falls back to the
      // same check-in + edit flow as the action button in that case.
      if (desk.status === "not_started") handleCardAction(desk);
      else openOpeningBalanceSheet(desk);
    });
  });
  root.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const desk = currentCards.find((d) => d.desk_id === btn.dataset.action);
      handleCardAction(desk);
    });
  });
  root.querySelectorAll("[data-take]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const desk = currentCards.find((d) => d.desk_id === btn.dataset.take);
      btn.disabled = true;
      try {
        await api.assignDesk(desk.desk_id, state.user.accountId);
        toast(tf("stock.takenToast", { case: desk.display_name }), "success");
      } catch (err) {
        toast(err.message, "error");
      }
      await refreshCards(false);
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
  hideFab();
  await mountDay(deskCard, state.stock.date, dayHooks(deskCard));
}

// What the day screen needs from this file: the SKU picker (shared with
// "New case"), the existing transfer sheet (Task 9 replaces it with the move
// sheet) and a way back to the cards.
function dayHooks(deskCard) {
  return {
    onBack: backToGrid,
    reload: () => reloadDeskDetail(deskCard),
    openSkuPicker: openSkuPickerSheet,
    askOpeningQty,
    openTransfer: openTransferSheet,
    loadDestinations,
  };
}

// Reloads the day screen after something changed server-side (a transfer, an
// added SKU, a reopen) so every number on it is the saved one.
async function reloadDeskDetail(deskCard) {
  await syncCurrentCards();
  const updatedCard = currentCards.find((d) => d.desk_id === deskCard.desk_id) ?? deskCard;
  await mountDay(updatedCard, state.stock.date, dayHooks(updatedCard));
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
