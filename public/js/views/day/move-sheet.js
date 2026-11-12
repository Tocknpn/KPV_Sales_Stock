// The move sheet: 1 piece to another case of the same branch in two taps
// (open the sheet, tap the case). "+ Add another item" turns it into a ticket.
import { api } from "../../api.js";
import { toast, toastAction, openSheet, closeSheet } from "../../ui.js";
import { escapeHtml } from "../../util.js";
import { t } from "../../i18n.js";
import { closingOf, skuName } from "./row.js";

const tf = (key, vars) => Object.entries(vars).reduce((text, [k, v]) => text.replace(`{${k}}`, v), t(key));
const lastKey = (branchId) => `kpv.move.last.${branchId}`;

// Most-recently-used destination ids for a branch, newest first.
function readMru(branchId) {
  try {
    const v = JSON.parse(localStorage.getItem(lastKey(branchId)) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeMru(branchId, deskId) {
  try {
    const next = [deskId, ...readMru(branchId).filter((x) => x !== deskId)].slice(0, 8);
    localStorage.setItem(lastKey(branchId), JSON.stringify(next));
  } catch {}
}

export async function openMoveSheet({ desk, date, detail, rows, hooks, onDone, skuId }) {
  // One ref per distinct payload: an identical retry reuses it (server replays),
  // a changed destination or quantity gets a new one.
  const attempt = { sig: null, ref: null };
  const all = (await hooks.loadDestinations?.()) ?? [];
  const mru = readMru(desk.branch_id);
  const rank = (id) => (mru.includes(id) ? mru.indexOf(id) : mru.length);
  const cases = all
    .filter((d) => d.desk_id !== desk.desk_id && d.branch_id === desk.branch_id)
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d.desk_id) - rank(b.d.desk_id) || a.i - b.i)
    .map((x) => x.d);
  const byId = new Map(rows.map((r) => [r.sku_id, r]));
  const avail = (id) => Math.max(0, closingOf(byId.get(id)));
  const lines = [{ skuId, qty: Math.min(1, avail(skuId)) }];
  let ticket = false;
  let busy = false;
  let toDesk = cases[0]?.desk_id ?? null;
  let msg = "";

  const caseName = (id) => cases.find((d) => d.desk_id === id)?.display_name ?? "";
  const holder = (d) => (d.holder_name ? ` · ${escapeHtml(d.holder_name)}` : "");

  function lineHtml(l, i) {
    const r = byId.get(l.skuId);
    return `
      <div class="mb-3 rounded-xl border border-hairline p-3" data-line="${i}">
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="min-w-0 truncate text-sm font-bold text-gray-900">${escapeHtml(skuName(r))}</span>
          <span class="shrink-0 text-xs font-semibold text-gray-600">${tf("move.ofN", { n: avail(l.skuId) })}</span>
        </div>
        <div class="flex items-stretch gap-2">
          <button type="button" data-step="-1" ${busy ? "disabled" : ""} aria-label="${t("day.decrease")}" class="btn-secondary w-12 shrink-0 px-0 text-xl">−</button>
          <input data-qty ${busy ? "disabled" : ""} inputmode="numeric" pattern="[0-9]*" maxlength="5" aria-label="${t("move.qty")}" value="${l.qty}" class="input-filled min-w-0 flex-1 text-center text-base font-extrabold tabular-nums" />
          <button type="button" data-step="1" ${busy ? "disabled" : ""} aria-label="${t("day.increase")}" class="btn-secondary w-12 shrink-0 px-0 text-xl">+</button>
          ${i > 0 ? `<button type="button" data-remove="${i}" ${busy ? "disabled" : ""} class="btn-secondary shrink-0 px-3 text-xs">${t("move.remove")}</button>` : ""}
        </div>
      </div>`;
  }

  function html() {
    const tabs = `
      <div class="mb-4 grid grid-cols-2 gap-2" role="tablist">
        <button type="button" role="tab" aria-selected="true" class="chip tap-target justify-center border-brand-600 bg-brand-600 text-white">${t("move.sameBranch")}</button>
        <button type="button" role="tab" aria-selected="false" data-tab="other" ${busy ? "disabled" : ""} class="chip tap-target justify-center border-hairline bg-white text-gray-600">${t("move.otherBranch")}</button>
      </div>`;
    if (cases.length === 0) return `${tabs}<p class="py-4 text-center text-sm text-gray-500">${t("move.noCases")}</p>`;
    const noStock = avail(skuId) <= 0;
    if (noStock) msg = t("move.noStock");
    const m = `<div role="alert" class="mb-3 ${msg ? "" : "hidden"} rounded-xl bg-danger-bg px-3 py-2.5 text-sm font-semibold text-danger">${escapeHtml(msg)}</div>`;
    const free = rows.filter((r) => avail(r.sku_id) > 0 && !lines.some((l) => l.skuId === r.sku_id));
    let out = tabs + m + lines.map(lineHtml).join("");
    if (!ticket) {
      out += `<p class="mb-2 text-sm font-bold text-gray-700">${t("move.pickCase")}</p>
        <div class="flex flex-col gap-2">${cases
          .map(
            (d) =>
              `<button type="button" data-case="${escapeHtml(d.desk_id)}" ${busy || noStock ? "disabled" : ""} class="btn-primary w-full text-left">${escapeHtml(d.display_name)}${holder(d)}</button>`
          )
          .join("")}</div>
        <button type="button" data-add class="btn-secondary mt-3 w-full" ${free.length && !busy ? "" : "disabled"}>${t("move.addItem")}</button>`;
    } else {
      out += `<label for="move-add" class="mb-1.5 block text-sm font-bold text-gray-700">${t("move.addPick")}</label>
        <select id="move-add" class="input-filled mb-4" ${free.length && !busy ? "" : "disabled"}>
          <option value="">${t("move.addPick")}</option>
          ${free.map((r) => `<option value="${escapeHtml(r.sku_id)}">${escapeHtml(skuName(r))} (${avail(r.sku_id)})</option>`).join("")}
        </select>
        <label for="move-to" class="mb-1.5 block text-sm font-bold text-gray-700">${t("move.to")}</label>
        <select id="move-to" ${busy ? "disabled" : ""} class="input-filled">
          ${cases.map((d) => `<option value="${escapeHtml(d.desk_id)}" ${d.desk_id === toDesk ? "selected" : ""}>${escapeHtml(d.display_name)}${holder(d)}</option>`).join("")}
        </select>
        <button type="button" data-confirm class="btn-primary mt-4 w-full" ${busy || noStock ? "disabled" : ""}>${tf("move.confirmN", { n: lines.length, to: escapeHtml(caseName(toDesk)) })}</button>`;
    }
    return out;
  }

  async function commit(toDeskId) {
    if (busy) return;
    if (lines.some((l) => !(l.qty > 0))) {
      msg = t("err.BAD_QTY");
      return render();
    }
    const sig = `${toDeskId}|${lines.map((l) => `${l.skuId}:${l.qty}`).join(",")}`;
    if (attempt.sig !== sig) {
      attempt.sig = sig;
      attempt.ref = crypto.randomUUID();
    }
    busy = true;
    msg = "";
    render();
    let res;
    try {
      res = await api.move({
        date,
        fromDeskId: desk.desk_id,
        toDeskId,
        lines: lines.map((l) => ({ skuId: l.skuId, qty: l.qty })),
        clientRef: attempt.ref,
      });
    } catch (err) {
      busy = false;
      if (err.code === "NOT_ENOUGH_STOCK") msg = tf("move.available", { n: err.data?.available ?? 0 });
      else if (err.code === "DEST_NOT_OPEN") msg = tf("move.destNotOpen", { date: err.data?.openDate ?? "" });
      else msg = err.message;
      return render();
    }
    // Committed. Show Undo first; a failed reload must not hide it.
    writeMru(desk.branch_id, toDeskId);
    const to = caseName(toDeskId);
    const text =
      lines.length === 1
        ? tf("move.movedOne", { n: lines[0].qty, name: skuName(byId.get(lines[0].skuId)), to })
        : tf("move.movedMany", { n: lines.length, to });
    closeSheet();
    toastAction(text, t("move.undo"), async () => {
      try {
        await api.undoMove(res.ticketId, crypto.randomUUID());
        toast(t("move.undone"), "success");
      } catch (err) {
        return toast(err.message, "error");
      }
      try {
        await onDone?.();
      } catch (err) {
        toast(err.message, "error");
      }
    });
    try {
      await onDone?.();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  let body = null;
  function render() {
    body.innerHTML = html();
    wire();
  }

  function setQty(i, to) {
    lines[i].qty = Math.max(0, Math.min(Number(to) || 0, avail(lines[i].skuId)));
    render();
  }

  function wire() {
    body.querySelector("[data-tab]")?.addEventListener("click", () => {
      closeSheet();
      hooks.openTransfer?.(desk, detail, skuId, "transfer", avail(skuId));
    });
    body.querySelectorAll("[data-line]").forEach((el) => {
      const i = Number(el.dataset.line);
      el.querySelectorAll("[data-step]").forEach((b) =>
        b.addEventListener("click", () => setQty(i, lines[i].qty + Number(b.dataset.step)))
      );
      const input = el.querySelector("[data-qty]");
      input.addEventListener("input", () => (input.value = input.value.replace(/\D/g, "").slice(0, 5)));
      input.addEventListener("change", () => setQty(i, input.value));
      el.querySelector("[data-remove]")?.addEventListener("click", () => {
        lines.splice(i, 1);
        render();
      });
    });
    body.querySelectorAll("[data-case]").forEach((b) => b.addEventListener("click", () => commit(b.dataset.case)));
    body.querySelector("[data-add]")?.addEventListener("click", () => {
      ticket = true;
      render();
    });
    body.querySelector("#move-add")?.addEventListener("change", (e) => {
      if (!e.target.value) return;
      lines.push({ skuId: e.target.value, qty: Math.min(1, avail(e.target.value)) });
      render();
    });
    body.querySelector("#move-to")?.addEventListener("change", (e) => {
      toDesk = e.target.value;
      render();
    });
    body.querySelector("[data-confirm]")?.addEventListener("click", () => commit(toDesk));
  }

  openSheet("", {
    title: `${t("move.title")} · ${escapeHtml(desk.display_name)}`,
    onMount: (el) => {
      body = el;
      render();
    },
  });
}
