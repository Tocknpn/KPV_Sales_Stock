// "My cases" chip and sheet (spec 4.17): take a free case, take over (manager),
// release or hand a case to a colleague. The server decides who may do what;
// the sheet only offers the actions that will be accepted.
import { api } from "../api.js";
import { state } from "../state.js";
import { openSheet, closeSheet, toast } from "../ui.js";
import { t, tf } from "../i18n.js";
import { escapeHtml, fmtClock, laosDateOf } from "../util.js";
import { isManager, isAdmin } from "../session.js";

// The admin has no cases of their own; the chip is for staff and managers.
export function casesChipHtml() {
  if (isAdmin(state.user)) return "";
  return `<button id="cases-chip" class="chip shrink-0 border-hairline bg-white text-gray-700">${tf("cases.chip", { n: "…" })}</button>`;
}

export async function refreshCasesChip(branchId) {
  const chip = document.getElementById("cases-chip");
  if (!chip) return;
  try {
    const { mine } = await api.myCases(branchId);
    chip.textContent = tf("cases.chip", { n: mine.length });
  } catch {
    chip.textContent = tf("cases.chip", { n: "–" });
  }
}

export function wireCasesChip(getBranchId, onChange) {
  document.getElementById("cases-chip")?.addEventListener("click", () => openCasesSheet(getBranchId(), onChange));
}

function holderLine(c, me) {
  if (!c.holder) return `<span class="text-gray-500">${t("cases.free")}</span>`;
  const who = c.holder.staffId === me ? t("cases.you") : escapeHtml(c.holder.name);
  return `<span class="break-words font-semibold text-gray-700">👤 ${tf("cases.heldBy", { name: who, time: fmtClock(c.holder.since) })}</span>`;
}

function actionsFor(c, me, manager, today) {
  const stale = !!c.holder && !!today && laosDateOf(c.holder.since) < today;
  const mine = c.holder?.staffId === me;
  const btn = (act, label, cls = "btn-secondary") => `<button data-act="${act}" data-desk="${escapeHtml(c.desk_id)}" class="${cls} px-3 py-2 text-xs">${label}</button>`;
  if (!c.holder) return btn("take", t("cases.take"), "btn-primary") + (manager ? btn("hand", t("cases.handTo")) : "");
  if (mine) return btn("release", t("cases.release")) + btn("hand", t("cases.handTo"));
  if (manager) return btn("takeover", t("cases.takeOver")) + btn("hand", t("cases.handTo"));
  // A holder from an earlier day is stale: staff may take the case over (not hand it on).
  if (stale) return btn("takeover", t("stock.takeCase"));
  // Staff cannot take over a colleague's case (the server refuses with NOT_HOLDER).
  return `<span class="text-[11px] text-gray-500">${tf("cases.onlyHolder", { name: escapeHtml(c.holder.name) })}</span>`;
}

export async function openCasesSheet(branchId, onChange) {
  const me = state.user.accountId;
  const manager = isManager(state.user);

  async function show() {
    openSheet(`<div class="py-10 text-center text-sm text-gray-600">${t("cases.loading")}</div>`, { title: t("cases.title") });
    let data;
    try {
      data = await api.myCases(branchId);
    } catch (err) {
      closeSheet();
      toast(err.message, "error");
      return;
    }
    const { cases } = data;
    const today = state.meta.today;
    const body = document.getElementById("sheet-body");
    if (!body) return;
    body.innerHTML = cases.length
      ? `<div class="flex flex-col gap-2.5">${cases
          .map(
            (c) => `
        <div class="card flex flex-col gap-2 p-3.5" data-case="${escapeHtml(c.desk_id)}">
          <div class="text-sm font-extrabold text-gray-900">${escapeHtml(c.display_name)}</div>
          <div class="text-[11px]">${holderLine(c, me)}</div>
          <div class="flex flex-wrap items-center gap-2">${actionsFor(c, me, manager, today)}</div>
        </div>`
          )
          .join("")}</div>`
      : `<div class="py-8 text-center text-sm text-gray-600">${t("cases.empty")}</div>`;

    body.querySelectorAll("[data-act]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const c = cases.find((x) => x.desk_id === btn.dataset.desk);
        const act = btn.dataset.act;
        if (act === "take") run(() => api.assignDesk(c.desk_id, me), tf("stock.takenToast", { case: c.display_name }));
        else if (act === "release") run(() => api.releaseDesk(c.desk_id), tf("cases.released", { case: c.display_name }));
        else if (act === "takeover") confirmTakeOver(c);
        else if (act === "hand") pickColleague(c);
      })
    );
  }

  async function run(fn, doneMessage) {
    try {
      await fn();
      toast(doneMessage, "success");
    } catch (err) {
      toast(err.message, "error");
    }
    await onChange?.();
    await show();
  }

  function confirmTakeOver(c) {
    const body = document.getElementById("sheet-body");
    body.innerHTML = `
      <p class="py-4 text-center text-sm font-bold text-gray-900">${escapeHtml(c.display_name)}: ${tf("cases.takeOverConfirm", { name: escapeHtml(c.holder.name) })}</p>
      <div class="flex gap-2">
        <button id="co-cancel" class="btn-secondary flex-1 py-3">${t("cases.cancel")}</button>
        <button id="co-ok" class="btn-primary flex-1 py-3">${t("cases.confirm")}</button>
      </div>`;
    body.querySelector("#co-cancel").addEventListener("click", show);
    body.querySelector("#co-ok").addEventListener("click", () => run(() => api.assignDesk(c.desk_id, me), tf("stock.takenToast", { case: c.display_name })));
  }

  async function pickColleague(c) {
    const body = document.getElementById("sheet-body");
    body.innerHTML = `<div class="py-8 text-center text-sm text-gray-600">${t("cases.loading")}</div>`;
    let accounts = [];
    try {
      // Active accounts of the case's branch (the login list already filters to active).
      ({ accounts } = await api.authAccounts(branchId ?? state.user.branchId));
    } catch (err) {
      toast(err.message, "error");
      return show();
    }
    const others = accounts.filter((a) => a.id !== c.holder?.staffId && (a.id !== me || manager));
    body.innerHTML = `
      <p class="mb-3 text-sm font-bold text-gray-900">${tf("cases.handToTitle", { case: escapeHtml(c.display_name) })}</p>
      <div class="flex flex-col gap-1.5">
        ${
          others.length
            ? others
                .map(
                  (a) => `<button data-staff="${escapeHtml(a.id)}" class="card tap-target flex items-center gap-3 p-3 text-left">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-extrabold text-brand-700">${escapeHtml(a.display_name.slice(0, 2).toUpperCase())}</span>
            <span class="text-sm font-bold text-gray-900">${escapeHtml(a.display_name)}</span>
          </button>`
                )
                .join("")
            : `<div class="py-6 text-center text-sm text-gray-500">${t("cases.noColleagues")}</div>`
        }
      </div>
      <button id="hand-cancel" class="btn-secondary mt-3 w-full py-3">${t("cases.cancel")}</button>`;
    body.querySelector("#hand-cancel").addEventListener("click", show);
    body.querySelectorAll("[data-staff]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const person = others.find((a) => a.id === btn.dataset.staff);
        run(() => api.assignDesk(c.desk_id, person.id), tf("cases.handed", { case: c.display_name, name: person.display_name }));
      })
    );
  }

  await show();
}
