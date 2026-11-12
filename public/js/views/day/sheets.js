// Bottom sheets opened from the day screen. Each takes `ctx`, built by
// index.js:  { deskCard, date, detail, hooks, queue, row(sku), rowChanged(sku) }
import { api } from "../../api.js";
import { toast, openSheet, closeSheet, openActionSheet } from "../../ui.js";
import { fmtDate, escapeHtml } from "../../util.js";
import { t } from "../../i18n.js";
import { clampQty } from "./save-queue.js";
import { closingOf, outOf, skuName } from "./row.js";

// t() with {placeholders}.
export function tf(key, vars) {
  return Object.entries(vars).reduce((text, [k, v]) => text.replace(`{${k}}`, v), t(key));
}

// --- numeric stepper -------------------------------------------------------

function stepperHtml(field, label, value) {
  return `
    <div class="mb-4" data-stepper="${field}">
      <label for="step-${field}" class="mb-1.5 block text-sm font-bold text-gray-700">${label}</label>
      <div class="flex items-stretch gap-2">
        <button type="button" data-step="-1" aria-label="${t("day.decrease")} ${label}" class="btn-secondary w-12 shrink-0 px-0 text-xl">−</button>
        <input id="step-${field}" data-input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="${value}"
          class="input-filled min-w-0 flex-1 text-center text-base font-extrabold tabular-nums" />
        <button type="button" data-step="1" aria-label="${t("day.increase")} ${label}" class="btn-secondary w-12 shrink-0 px-0 text-xl">+</button>
      </div>
    </div>`;
}

// Wires a group of steppers. Changing one calls change(field, to, kind).
// The next value is based on the row's value, never on what the input shows:
// on iOS a tapped button keeps focus off the input, so the input can lag.
function wireSteppers(body, get, change) {
  body.querySelectorAll("[data-stepper]").forEach((box) => {
    const field = box.dataset.stepper;
    const input = box.querySelector("[data-input]");
    box.querySelectorAll("[data-step]").forEach((btn) =>
      btn.addEventListener("click", () => change(field, clampQty(get(field) + Number(btn.dataset.step)), "step"))
    );
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 5);
    });
    input.addEventListener("change", () => change(field, clampQty(input.value || 0), "typed"));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    });
  });
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

// A conflict on a field with no sheet open (a count typed on the card).
export function openConflictSheet(ctx, res) {
  const row = ctx.row(res.skuId);
  openSheet(`${messageSlot()}`, {
    title: `${escapeHtml(skuName(row))} · ${t("day.conflictTitle")}`,
    onMount: (body) => {
      showConflict(body, ctx, res, () => {});
      // Either answer ends the question.
      body.querySelectorAll("[data-keep], [data-theirs]").forEach((b) => b.addEventListener("click", closeSheet));
    },
  });
}

// --- shared "edit quantities" sheet used by In and Out --------------------

// `fields`: [{field, label, sign}]  sign +1 adds to closing, -1 takes away.
function openQtySheet(ctx, skuId, { title, fields, extra = "", focus, onMount: extraMount }) {
  const row = ctx.row(skuId);
  const signOf = Object.fromEntries(fields.map((f) => [f.field, f.sign]));

  openSheet(
    `
    <div class="mb-4 flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2.5 text-sm">
      <span class="font-semibold text-gray-600">${t("day.open")} <b class="tabular-nums text-gray-900" data-open>${row.opening_qty}</b></span>
      <span class="font-semibold text-gray-600">${t("day.closingAfter")} <b class="text-lg tabular-nums text-brand-700" data-closing>${closingOf(row)}</b></span>
    </div>
    ${messageSlot()}
    ${fields.map((f) => stepperHtml(f.field, f.label, row[f.field])).join("")}
    ${extra}
    <button type="button" data-done class="btn-primary mt-2 w-full">${t("day.done")}</button>
  `,
    {
      title: `${escapeHtml(skuName(row))} · ${title}`,
      onMount: (body) => {
        body.__row = row;
        const refresh = () => {
          fields.forEach((f) => {
            const input = body.querySelector(`[data-stepper="${f.field}"] [data-input]`);
            if (input) input.value = row[f.field];
          });
          body.querySelector("[data-closing]").textContent = closingOf(row);
          extraMount?.refresh?.(body);
        };

        const handle = (field) => (res) => {
          if (!body.isConnected) return false; // sheet already closed: shared handler reports it
          if (res.ok) return true;
          refresh();
          if (res.code === "NEGATIVE_CLOSING") {
            showMessage(body, tf("day.onlyAvailable", { n: res.available }));
            return true;
          }
          if (res.code === "ROW_CHANGED") {
            showConflict(body, ctx, res, refresh);
            return true;
          }
          return false;
        };

        const change = (field, to, kind) => {
          const input = body.querySelector(`[data-stepper="${field}"] [data-input]`);
          const delta = to - row[field];
          if (delta === 0) {
            if (input) input.value = row[field];
            return;
          }
          // Check here first so the cashier sees the reason without a round trip;
          // the server still has the last word (NEGATIVE_CLOSING).
          const after = closingOf(row) + delta * signOf[field];
          if (after < 0) {
            const available = signOf[field] < 0 ? closingOf(row) + row[field] : closingOf(row);
            if (input) input.value = row[field];
            showMessage(body, tf("day.onlyAvailable", { n: available }));
            return;
          }
          showMessage(body, "");
          row[field] = to;
          ctx.rowChanged(skuId);
          refresh();
          ctx.queue.set(skuId, field, to, { kind, cb: handle(field) });
        };

        wireSteppers(body, (field) => row[field], change);
        body.querySelector("[data-done]").addEventListener("click", () => {
          document.activeElement?.blur?.();
          closeSheet();
        });
        extraMount?.mount?.(body, { change, refresh, showMessage: (m) => showMessage(body, m), handle });
        setTimeout(() => {
          const el = body.querySelector(`[data-stepper="${focus ?? fields[0].field}"] [data-input]`);
          el?.focus();
          el?.select();
        }, 0);
      },
    }
  );
}

export function openInSheet(ctx, skuId) {
  const row = ctx.row(skuId);
  openQtySheet(ctx, skuId, {
    title: t("day.in"),
    fields: [{ field: "stock_in", label: t("day.in"), sign: 1 }],
    extra: row.transfer_in > 0 ? `<p class="mb-2 text-sm text-gray-600">${t("day.receivedByTransfer")}: <b>+${row.transfer_in}</b></p>` : "",
  });
}

// Destock needs a reason: mark the field and hold the Done button until it is filled.
function validateReason(body, typed) {
  const note = body.querySelector("[data-reason]");
  const done = body.querySelector("[data-done]");
  if (!note || !done) return;
  const row = body.__row;
  const text = typed !== undefined ? typed : note.value;
  const invalid = row.destock > 0 && !text.trim();
  note.setAttribute("aria-invalid", String(invalid));
  note.classList.toggle("bg-danger-bg", invalid);
  note.classList.toggle("ring-2", invalid);
  note.classList.toggle("ring-danger", invalid);
  done.disabled = invalid;
}

export function openOutSheet(ctx, skuId) {
  const row = ctx.row(skuId);
  openQtySheet(ctx, skuId, {
    title: t("day.out"),
    focus: "retail_sale",
    fields: [
      { field: "retail_sale", label: t("day.retail"), sign: -1 },
      { field: "wholesale", label: t("day.wholesale"), sign: -1 },
      { field: "destock", label: t("day.destock"), sign: -1 },
    ],
    extra: `
      <div data-reason-box>
        <label for="destock-note" class="mb-1.5 block text-sm font-bold text-gray-700">${t("day.destockReason")}</label>
        <input id="destock-note" data-reason type="text" maxlength="200" value="${escapeHtml(row.destock_note ?? "")}"
          class="input-filled text-base" />
      </div>
      <p class="mt-3 text-sm font-semibold text-gray-600">${t("day.outTotal")}: <b data-out-total class="tabular-nums text-gray-900">${outOf(row)}</b></p>`,
    onMount: {
      refresh(body) {
        body.querySelector("[data-out-total]").textContent = outOf(row);
        validateReason(body);
      },
      mount(body, { handle }) {
        const note = body.querySelector("[data-reason]");
        note.addEventListener("input", () => validateReason(body, note.value));
        validateReason(body);
        const commit = () => {
          const to = note.value.trim() || null;
          if (to === (row.destock_note ?? null)) return;
          row.destock_note = to;
          ctx.rowChanged(skuId);
          ctx.queue.set(skuId, "destock_note", to, { kind: "typed", cb: handle("destock_note") });
        };
        note.addEventListener("change", commit);
        // Closing the sheet with the reason still focused must not lose it.
        body.querySelector("[data-done]").addEventListener("click", commit);
        note.addEventListener("keydown", (e) => {
          if (e.key === "Enter") note.blur();
        });
      },
    },
  });
}

// --- count note -----------------------------------------------------------

export function openCountNoteSheet(ctx, skuId) {
  const row = ctx.row(skuId);
  const variance = (row.counted_qty ?? 0) - closingOf(row);
  openSheet(
    `
    <p class="mb-3 rounded-lg bg-gray-50 px-3 py-2.5 text-sm text-gray-700">
      ${t("day.closing")} <b class="tabular-nums">${closingOf(row)}</b> · ${t("day.count")} <b class="tabular-nums">${row.counted_qty ?? "—"}</b> · ${t("day.diff")} <b class="tabular-nums text-danger">${variance > 0 ? "+" : variance < 0 ? "−" : ""}${Math.abs(variance)}</b>
    </p>
    ${messageSlot()}
    <label for="count-note" class="mb-1.5 block text-sm font-bold text-gray-700">${t("day.countNoteHint")}</label>
    <textarea id="count-note" rows="3" maxlength="200" class="input-filled text-base">${escapeHtml(row.counted_note ?? "")}</textarea>
    <button type="button" data-save class="btn-primary mt-4 w-full">${t("day.save")}</button>
  `,
    {
      title: `${escapeHtml(skuName(row))} · ${t("day.countNoteTitle")}`,
      onMount: (body) => {
        body.querySelector("[data-save]").addEventListener("click", () => {
          const to = body.querySelector("#count-note").value.trim() || null;
          if (to !== (row.counted_note ?? null)) {
            row.counted_note = to;
            ctx.rowChanged(skuId);
            ctx.queue.set(skuId, "counted_note", to, { kind: "typed" });
          }
          closeSheet();
        });
        setTimeout(() => body.querySelector("#count-note")?.focus(), 0);
      },
    }
  );
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

// --- reopen a Done day ----------------------------------------------------

export function openReopenSheet(ctx) {
  openSheet(
    `
    <p class="mb-3 rounded-lg bg-warning-bg px-3 py-2.5 text-sm font-semibold text-warning">${t("stock.reopenWarning")}</p>
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
          e.currentTarget.disabled = true;
          try {
            await api.reopenDesk(ctx.deskCard.desk_id, { date: ctx.date, reason });
          } catch (err) {
            e.currentTarget.disabled = false;
            throw err;
          }
          closeSheet();
          toast(t("stock.reopenedToast"), "success");
          await ctx.hooks.reload?.();
        });
        setTimeout(() => body.querySelector("#reopen-reason")?.focus(), 0);
      },
    }
  );
}

// --- the ⇄ cell -----------------------------------------------------------

// Task 9 replaces this body with the real move sheet. Until then the cell opens
// the existing transfer sheet (kept in stock.js), after asking which kind.
export async function openMoveSheet(ctx, skuId) {
  await ctx.queue.flushAll();
  const row = ctx.row(skuId);
  openActionSheet(
    t("day.chooseMove"),
    [
      { label: t("stock.move"), value: "move" },
      { label: t("stock.transferOut"), value: "transfer" },
    ],
    (opt) => ctx.hooks.openTransfer?.(ctx.deskCard, ctx.detail, skuId, opt.value, closingOf(row))
  );
}

// --- remove an item -------------------------------------------------------

export function openRemoveItemSheet(ctx) {
  openActionSheet(
    t("day.removeItem"),
    ctx.rows().map((r) => ({ label: escapeHtml(skuName(r)), value: r.sku_id })),
    async (opt) => {
      await ctx.queue.flushAll();
      await api.removeDeskSku(ctx.deskCard.desk_id, opt.value, ctx.date);
      await ctx.hooks.reload?.();
    }
  );
}

