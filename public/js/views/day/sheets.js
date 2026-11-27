// Bottom sheets opened from the day screen. Each takes `ctx`, built by
// index.js:  { deskCard, date, detail, hooks, queue, row(sku), rowChanged(sku) }
import { api } from "../../api.js";
import { toast, openSheet, closeSheet, openActionSheet } from "../../ui.js";
import { fmtDate, fmtLaosFull, fmtInt, fmtBaht, escapeHtml, SHOW_VALUE } from "../../util.js";
import { t } from "../../i18n.js";
import { skuLabel } from "../../sku-groups.js";
import { reopenRange } from "./day-rules.js";

// t() with {placeholders}.
export function tf(key, vars) {
  return Object.entries(vars).reduce((text, [k, v]) => text.replace(`{${k}}`, v), t(key));
}

// --- result messages inside a sheet ---------------------------------------

function messageSlot() {
  return `<div data-msg role="alert" class="mb-3 hidden rounded-xl bg-danger-bg px-3 py-2.5 text-sm font-semibold text-danger"></div>`;
}

function showMessage(body, text) {
  const el = body.querySelector("[data-msg]");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("hidden", !text);
}

function conflictText(ctx, res) {
  const name = ctx.detail.actors?.[res.byId] ?? t("day.anotherDevice");
  return tf("day.changedBy", { name, n: res.theirs ?? 0 });
}

// "Changed by Noy to 4: keep yours?" with the two answers.
function showConflict(body, ctx, res, refresh) {
  const el = body.querySelector("[data-msg]");
  if (!el) return;
  el.classList.remove("hidden");
  el.innerHTML = `
    <p>${escapeHtml(conflictText(ctx, res))}</p>
    <div class="mt-2 flex gap-2">
      <button type="button" data-keep class="btn-primary flex-1 px-3 py-2">${t("day.keepMine")}</button>
      <button type="button" data-theirs class="btn-secondary flex-1 px-3 py-2">${t("day.useTheirs")}</button>
    </div>`;
  el.querySelector("[data-keep]").addEventListener("click", () => {
    ctx.row(res.skuId)[res.field] = res.mine;
    ctx.rowChanged(res.skuId);
    showMessage(body, "");
    refresh();
    res.keepMine();
  });
  el.querySelector("[data-theirs]").addEventListener("click", () => showMessage(body, ""));
}

// A conflict on a field with no sheet open (a number typed on the grid).
export function openConflictSheet(ctx, res) {
  const row = ctx.row(res.skuId);
  openSheet(`${messageSlot()}`, {
    title: `${escapeHtml(skuLabel(row))} · ${t("day.conflictTitle")}`,
    onMount: (body) => {
      showConflict(body, ctx, res, () => {});
      // Either answer ends the question.
      body.querySelectorAll("[data-keep], [data-theirs]").forEach((b) => b.addEventListener("click", closeSheet));
    },
  });
}

// --- safe drop note -------------------------------------------------------

export function openSafeDropSheet(ctx) {
  openSheet(
    `
    <label for="safe-drop" class="mb-1.5 block text-sm font-bold text-gray-700">${t("stock.safeDropNotes")}</label>
    <textarea id="safe-drop" rows="3" maxlength="500" placeholder="${t("stock.safeDropPlaceholder")}" class="input-filled text-base">${escapeHtml(
      ctx.detail.safe_drop_note ?? ""
    )}</textarea>
    <button type="button" data-save class="btn-primary mt-4 w-full">${t("day.save")}</button>
  `,
    {
      title: t("day.safeDrop"),
      onMount: (body) => {
        body.querySelector("[data-save]").addEventListener("click", async () => {
          const note = body.querySelector("#safe-drop").value.trim() || null;
          await api.saveChanges(ctx.deskCard.desk_id, { date: ctx.date, changes: [], safe_drop_note: note });
          ctx.detail.safe_drop_note = note;
          closeSheet();
          toast(t("stock.progressSaved"), "success");
        });
      },
    }
  );
}

// --- case info ------------------------------------------------------------

export function openCaseInfoSheet(ctx) {
  const dash = "—";
  openSheet(`<p class="py-6 text-center text-sm text-gray-600">…</p>`, {
    title: t("day.caseInfo"),
    onMount: async (body) => {
      let info;
      try {
        info = await api.deskInfo(ctx.deskCard.desk_id);
      } catch (e) {
        closeSheet();
        toast(e.message, "error");
        return;
      }
      const init = info.initial;
      const skuRows = init
        ? Object.entries(init.skus)
            .map(([id, qty]) => {
              const named = init.names?.[id];
              return `<li class="flex justify-between gap-3"><span class="min-w-0 truncate">${escapeHtml(id)}${named ? ` · ${escapeHtml(skuLabel(named))}` : ""}</span><span class="font-bold tabular-nums">${fmtInt(qty)}</span></li>`;
            })
            .join("")
        : "";
      const total = init ? `${fmtBaht(init.total_baht, 2)} Baht · ${fmtInt(init.total_pcs)} ${t("day.caseInfoPcs")}${SHOW_VALUE ? ` · ≈ ₭${fmtInt(init.valueLak)}` : ""}` : dash;
      const item = (label, value) =>
        `<div class="flex justify-between gap-4 py-2"><dt class="text-gray-600">${label}</dt><dd class="text-right font-semibold text-gray-900">${value}</dd></div>`;
      body.innerHTML = `
        <dl class="divide-y divide-hairline text-sm">
          ${item(t("day.caseInfoCreatedBy"), info.createdBy?.name ? escapeHtml(info.createdBy.name) : dash)}
          ${item(t("day.caseInfoCreated"), info.createdAt ? fmtLaosFull(info.createdAt) : dash)}
          <div class="py-2"><dt class="mb-1 text-gray-600">${t("day.caseInfoOriginal")}</dt>
            <dd>${skuRows ? `<ul class="flex flex-col gap-1 font-semibold text-gray-900">${skuRows}</ul>` : dash}</dd></div>
          ${item(t("day.caseInfoTotal"), total)}
        </dl>`;
    },
  });
}

// --- reopen a Done day ----------------------------------------------------

// Reopening a day also reopens every later day of the case (back to "not
// checked in"); the warning names that range, the toast the dates the server reopened.
function reopenWarning(ctx) {
  const range = reopenRange(ctx.date, ctx.detail.today);
  return range.to === range.from
    ? tf("stock.reopenWarningOne", { date: fmtDate(range.from) })
    : tf("stock.reopenWarning", { from: fmtDate(range.from), to: fmtDate(range.to) });
}

export function openReopenSheet(ctx) {
  openSheet(
    `
    <p class="mb-3 rounded-lg bg-warning-bg px-3 py-2.5 text-sm font-semibold text-warning">${escapeHtml(reopenWarning(ctx))}</p>
    <label for="reopen-reason" class="mb-1.5 block text-sm font-bold text-gray-700">${t("stock.reopenReason")}</label>
    <textarea id="reopen-reason" rows="3" maxlength="300" class="input-filled text-base"></textarea>
    <button type="button" data-confirm class="btn-primary mt-4 w-full">${t("stock.reopen")}</button>
  `,
    {
      title: `${t("stock.reopen")} · ${fmtDate(ctx.date)}`,
      onMount: (body) => {
        body.querySelector("[data-confirm]").addEventListener("click", async (e) => {
          const reason = body.querySelector("#reopen-reason").value.trim();
          if (reason.length < 3) return toast(t("stock.reopenReasonNeeded"), "error");
          // currentTarget is gone after the await below; keep the button.
          const btn = e.currentTarget;
          btn.disabled = true;
          let res;
          try {
            res = await api.reopenDesk(ctx.deskCard.desk_id, { date: ctx.date, reason });
          } catch (err) {
            btn.disabled = false;
            throw err;
          }
          closeSheet();
          const dates = Array.isArray(res?.dates) ? res.dates : [];
          toast(dates.length ? tf("stock.reopenedToastDates", { dates: dates.map((d) => fmtDate(d)).join(", ") }) : t("stock.reopenedToast"), "success");
          await ctx.hooks.reload?.();
        });
        setTimeout(() => body.querySelector("#reopen-reason")?.focus(), 0);
      },
    }
  );
}

// --- remove an item -------------------------------------------------------

export function openRemoveItemSheet(ctx) {
  openActionSheet(
    t("day.removeItem"),
    ctx.rows().map((r) => ({ label: escapeHtml(skuLabel(r)), value: r.sku_id })),
    async (opt) => {
      await ctx.queue.flushAll();
      await api.removeDeskSku(ctx.deskCard.desk_id, opt.value, ctx.date);
      await ctx.hooks.reload?.();
    }
  );
}

