// History tab of the day screen: the moves of this case on this date (with Undo
// while both days are open) and the case's audit entries, newest first.
//
// auditSentence() is shared with the manager audit screen (settings/audit.js).
// Audit values are arbitrary user text: everything here is escaped on the way
// into innerHTML, and auditSentence() returns plain text for the caller to escape.
import { api } from "../../api.js";
import { t, tf } from "../../i18n.js";
import { toast } from "../../ui.js";
import { deskById } from "../../state.js";
import { escapeHtml, fmtClock, fmtDate } from "../../util.js";

// Columns that are bookkeeping for the row, not something a person changed.
const HIDDEN_FIELDS = new Set(["id", "desk_id", "sku_id", "ledger_date", "is_seed", "created_at", "updated_at", "performed_by", "closing_qty", "branch_id"]);

function fieldLabel(key) {
  const label = t(`audit.field.${key}`);
  return label === `audit.field.${key}` ? key : label;
}

function fmtValue(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "✓" : "✗";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function caseName(id) {
  if (!id) return "";
  const d = deskById(id);
  return d ? d.display_name : id;
}

// "{actor} · {HH:mm} · {case} · {sku} · {field} {old} → {new}" (spec 4.9).
// Plain text; the caller escapes it.
export function auditSentence(e) {
  const head = [e.actor_name || "—", fmtClock(e.created_at)];
  const ctx = e.context ?? {};
  const where = e.table_name ? caseName(e.desk_id ?? ctx.desk_id) : "";
  if (where) head.push(where);
  if (ctx.sku_id) head.push(ctx.sku_id);

  // Entries the Worker wrote itself (settings, reopen, ...): action and target.
  if (!e.table_name) {
    const detail = e.detail && typeof e.detail === "object" && "reason" in e.detail ? ` (${fmtValue(e.detail.reason)})` : "";
    return [...head, `${e.action}${e.target ? ` ${e.target}` : ""}${detail}`].join(" · ");
  }

  if (e.table_name === "transfers") {
    const nv = e.new_values ?? {};
    const ov = e.old_values ?? {};
    if (e.op === "INSERT") {
      const kind = ctx.kind ?? nv.kind ?? "transfer";
      return [...head, `${t(`audit.kind.${kind}`) === `audit.kind.${kind}` ? kind : t(`audit.kind.${kind}`)} ${fmtValue(nv.qty)} → ${caseName(e.to_desk_id) || e.to_desk_id || "—"}`].join(" · ");
    }
    const parts = Object.keys(e.op === "DELETE" ? ov : nv).filter((k) => !HIDDEN_FIELDS.has(k)).map((k) => `${fieldLabel(k)} ${fmtValue(ov[k])} → ${fmtValue(nv[k])}`);
    return [...head, parts.join("; ") || t("audit.op.UPDATE")].join(" · ");
  }

  const ov = e.old_values ?? {};
  const nv = e.new_values ?? {};
  const keys = [...new Set([...Object.keys(ov), ...Object.keys(nv)])].filter((k) => !HIDDEN_FIELDS.has(k));
  let parts;
  if (e.op === "UPDATE") parts = keys.map((k) => `${fieldLabel(k)} ${fmtValue(ov[k])} → ${fmtValue(nv[k])}`);
  else {
    // A new or removed row lists only the values that carry something.
    const src = e.op === "INSERT" ? nv : ov;
    parts = keys
      .filter((k) => src[k] !== 0 && src[k] !== null && src[k] !== "" && src[k] !== false && src[k] !== undefined)
      .map((k) => (e.op === "INSERT" ? `${fieldLabel(k)} — → ${fmtValue(nv[k])}` : `${fieldLabel(k)} ${fmtValue(ov[k])} → —`));
    if (parts.length === 0) parts = [t(`audit.op.${e.op}`)];
  }
  return [...head, parts.join("; ")].join(" · ");
}

function moveCard(m) {
  const items = m.lines.map((l) => `${l.qty} × ${l.name_en}`).join(", ");
  const status = m.reversal ? t("history.isUndo") : m.reversed ? t("history.undone") : "";
  return `
    <div class="card min-w-0 p-3" data-ticket="${escapeHtml(m.ticketId)}">
      <div class="flex min-w-0 items-start justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div class="break-words text-sm font-bold text-gray-900">${escapeHtml(tf("history.movedLine", { items, from: m.from, to: m.to }))}</div>
          <div class="mt-0.5 break-words text-xs text-gray-600">${escapeHtml(fmtClock(m.created_at))}${m.by ? ` · ${escapeHtml(m.by)}` : ""}${m.note ? ` · ${escapeHtml(m.note)}` : ""}</div>
          ${status ? `<span class="status-pill mt-1.5 inline-flex bg-gray-100 text-gray-600">${escapeHtml(status)}</span>` : ""}
        </div>
        ${m.canUndo ? `<button type="button" data-undo="${escapeHtml(m.ticketId)}" class="btn-secondary tap-target shrink-0 px-3 text-sm">${t("move.undo")}</button>` : ""}
      </div>
    </div>`;
}

function entryRow(e) {
  return `<li class="min-w-0 break-words px-3 py-2.5 text-sm text-gray-800">${escapeHtml(auditSentence(e))}</li>`;
}

// host: element to fill. detail: the desk detail (moves). onUndone: reload the day.
export async function renderHistory(host, { deskId, date, detail, onUndone }) {
  const moves = detail.moves ?? [];
  host.innerHTML = `
    <section aria-labelledby="hist-moves">
      <h2 id="hist-moves" class="mb-2 text-xs font-extrabold uppercase tracking-wide text-gray-600">${t("history.moves")} · ${escapeHtml(fmtDate(date))}</h2>
      <div class="flex flex-col gap-2">${moves.length ? moves.map(moveCard).join("") : `<p class="rounded-lg bg-gray-50 px-3 py-4 text-center text-sm text-gray-600">${t("history.noMoves")}</p>`}</div>
    </section>
    <section class="mt-5" aria-labelledby="hist-entries">
      <h2 id="hist-entries" class="mb-2 text-xs font-extrabold uppercase tracking-wide text-gray-600">${t("history.entries")}</h2>
      <ul id="hist-list" class="card divide-y divide-hairline p-0"></ul>
      <p id="hist-status" class="py-4 text-center text-sm text-gray-600" role="status">${t("settings.loading")}</p>
      <button type="button" id="hist-more" class="btn-secondary mt-2 hidden w-full">${t("history.more")}</button>
    </section>`;

  host.querySelectorAll("[data-undo]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api.undoMove(btn.dataset.undo, crypto.randomUUID());
        toast(t("move.undone"), "success");
      } catch (err) {
        btn.disabled = false;
        return toast(err.message, "error");
      }
      try {
        await onUndone?.();
      } catch (err) {
        toast(err.message, "error");
      }
    })
  );

  const list = host.querySelector("#hist-list");
  const status = host.querySelector("#hist-status");
  const more = host.querySelector("#hist-more");
  let next = null;
  async function load() {
    more.disabled = true;
    try {
      const res = await api.audit({ deskId, ...(date ? { from: date, to: date } : {}), before: next });
      list.insertAdjacentHTML("beforeend", res.entries.map(entryRow).join(""));
      next = res.next;
      status.textContent = list.children.length ? "" : t("history.empty");
      status.classList.toggle("hidden", list.children.length > 0);
      more.classList.toggle("hidden", !next);
    } catch (err) {
      status.classList.remove("hidden");
      status.textContent = err.message || t("err.SERVER_ERROR");
    } finally {
      more.disabled = false;
    }
  }
  more.addEventListener("click", load);
  await load();
}
