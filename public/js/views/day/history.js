// History tab of the day screen: one row per day of the case, newest first (30 days, then "Load more").
// Tap a row for that day's SKUs, moves (with Undo while both days are open) and changes.
//
// auditSentence() is shared with the manager audit screen (settings/audit.js).
// Audit values are arbitrary user text: everything here is escaped on the way
// into innerHTML, and auditSentence() returns plain text for the caller to escape.
import { api } from "../../api.js";
import { t, tf, pickName } from "../../i18n.js";
import { toast } from "../../ui.js";
import { deskById } from "../../state.js";
import { escapeHtml, fmtBaht, fmtClock, fmtDate } from "../../util.js";

// Columns that are bookkeeping for the row, not something a person changed.
const HIDDEN_FIELDS = new Set(["id", "desk_id", "sku_id", "ledger_date", "is_seed", "created_at", "updated_at", "performed_by", "closing_qty", "branch_id"]);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// id -> display name for people. Filled from the audit entries on screen (actor_id
// + actor_name) and from the branch's staff list; anything unknown prints as "—".
const staffNames = new Map();

export function learnStaffNames(pairs) {
  for (const [id, name] of pairs) if (id && name && !staffNames.has(id)) staffNames.set(id, name);
}

function learnFromEntries(entries) {
  learnStaffNames(entries.map((e) => [e.actor_id, e.actor_name]));
}

async function learnFromAccounts(deskId) {
  try {
    const branchId = deskById(deskId)?.branch_id;
    const res = await api.authAccounts(branchId);
    learnStaffNames((res.accounts ?? []).map((a) => [a.id, a.display_name]));
  } catch {
    // Names are a nicety; a failed lookup leaves "—".
  }
}

function fieldLabel(key) {
  const label = t(`audit.field.${key}`);
  return label === `audit.field.${key}` ? key.replace(/_/g, " ") : label;
}

// Replaces every UUID in a text with the person's name, or "—" when unknown.
function scrubIds(text) {
  return String(text).replace(UUID_RE, (id) => staffNames.get(id.toLowerCase()) ?? staffNames.get(id) ?? "—");
}

function fmtValue(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "✓" : "✗";
  // Never show a raw id: people become names, any other id becomes a dash.
  const s = scrubIds(typeof v === "object" ? JSON.stringify(v) : String(v));
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function caseName(id) {
  if (!id) return "";
  const d = deskById(id);
  return d ? d.display_name : fmtValue(id);
}

// "{actor} · {HH:mm} · {case} · {sku} · {field} {old} → {new}" (spec 4.9).
// Plain text; the caller escapes it.
export function auditSentence(e) {
  return scrubIds(buildSentence(e));
}

function buildSentence(e) {
  const head = [fmtValue(e.actor_name || staffNames.get(e.actor_id)), fmtClock(e.created_at)];
  const ctx = e.context ?? {};
  const where = e.table_name ? caseName(e.desk_id ?? ctx.desk_id) : "";
  if (where) head.push(where);
  if (ctx.sku_id) head.push(fmtValue(ctx.sku_id));

  // Entries the Worker wrote itself (settings, reopen, ...): action and target.
  if (!e.table_name) {
    const detail = e.detail && typeof e.detail === "object" && "reason" in e.detail ? ` (${fmtValue(e.detail.reason)})` : "";
    return [...head, `${e.action}${e.target ? ` ${fmtValue(e.target)}` : ""}${detail}`].join(" · ");
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
      .map((k) => (e.op === "INSERT" ? `${fieldLabel(k)} → ${fmtValue(nv[k])}` : `${fieldLabel(k)} ${fmtValue(ov[k])} → —`));
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

// ---------------------------------------------------------------------------
// Day table (spec decision 7)
// ---------------------------------------------------------------------------
const FLAG_LABEL = {
  count_diff: "history.flag.count_diff",
  chain_break: "history.flag.chain_break",
  missed: "history.flag.missed",
  reopened: "history.flag.reopened",
};

const num = (n) => (n === null || n === undefined ? "—" : fmtBaht(n, 2));
const TD = "whitespace-nowrap px-2 py-2 text-right tabular-nums";

function dayRow(r) {
  const has = r.state === "done" || r.state === "open";
  const flagged = (f) => r.flags.includes(f);
  const red = "font-bold text-danger";
  const flags = r.flags.map((f) => `<span class="block text-[10px] font-bold text-danger">⚑ ${escapeHtml(t(FLAG_LABEL[f]))}</span>`).join("");
  const stateNote = r.state === "open" ? `<span class="block text-[10px] font-bold text-warning">${t("history.state.open")}</span>` : r.state === "closed" ? `<span class="block text-[10px] text-gray-500">${t("history.state.closed")}</span>` : "";
  const cell = (v, cls = "") => `<td class="${TD} ${cls}">${has ? num(v) : "—"}</td>`;
  return `
    <tr data-date="${escapeHtml(r.date)}" class="cursor-pointer ${r.state === "closed" ? "bg-gray-50 text-gray-500" : ""} ${r.state === "missed" ? "bg-danger-bg" : ""}" tabindex="0" role="button" aria-expanded="false">
      <td class="whitespace-nowrap px-2 py-2 text-left font-semibold ${flagged("missed") ? "text-danger" : "text-gray-900"}">${escapeHtml(fmtDate(r.date))}${stateNote}${flags}</td>
      ${cell(r.openBaht, flagged("chain_break") ? red : "")}
      ${cell(r.inBaht)}
      ${cell(r.outBaht)}
      ${cell(r.closeBaht, "font-bold")}
      ${cell(r.countBaht, flagged("count_diff") ? red : "")}
      ${cell(r.diffBaht, flagged("count_diff") ? red : "")}
      <td class="whitespace-nowrap px-2 py-2 text-left text-xs">${r.by ? escapeHtml(r.by) : "—"}</td>
    </tr>`;
}

function skuTable(rows) {
  const body = rows
    .filter((r) => r.opening_qty || r.stock_in || r.transfer_in || r.closing_qty || r.counted_qty != null || r.retail_sale || r.wholesale || r.transfer_out || r.destock || r.move)
    .map((r) => {
      const inQ = (r.stock_in ?? 0) + (r.transfer_in ?? 0);
      const outQ = (r.retail_sale ?? 0) + (r.wholesale ?? 0) + (r.transfer_out ?? 0) + (r.destock ?? 0) + (r.move ?? 0);
      const off = r.counted_qty != null && r.counted_qty !== r.closing_qty;
      return `<tr>
        <td class="px-2 py-1.5 text-left font-semibold text-gray-800">${escapeHtml(pickName(r.name_en, r.name_lo))}</td>
        <td class="${TD}">${r.opening_qty ?? 0}</td><td class="${TD}">${inQ}</td><td class="${TD}">${outQ}</td>
        <td class="${TD} font-bold">${r.closing_qty ?? 0}</td>
        <td class="${TD} ${off ? "font-bold text-danger" : ""}">${r.counted_qty ?? "—"}</td></tr>`;
    })
    .join("");
  if (!body) return `<p class="py-2 text-center text-xs text-gray-600">${t("history.noSkus")}</p>`;
  return `<div class="overflow-x-auto"><table class="w-full text-xs">
    <thead class="text-gray-600"><tr>
      <th class="px-2 py-1.5 text-left font-semibold">${t("history.sku")}</th>
      <th class="px-2 py-1.5 text-right font-semibold">${t("stock.colOpen")}</th><th class="px-2 py-1.5 text-right font-semibold">${t("stock.colIn")}</th>
      <th class="px-2 py-1.5 text-right font-semibold">${t("stock.colOut")}</th><th class="px-2 py-1.5 text-right font-semibold">${t("stock.colClose")}</th>
      <th class="px-2 py-1.5 text-right font-semibold">${t("stock.colCounted")}</th>
    </tr></thead><tbody class="divide-y divide-hairline">${body}</tbody></table></div>`;
}

// Fills one expanded day: SKU table, that day's moves and its changes.
async function fillDayDetail(box, { deskId, date, onUndone }) {
  box.innerHTML = `<p class="py-3 text-center text-sm text-gray-600" role="status">${t("settings.loading")}</p>`;
  const [detailRes, entriesRes] = await Promise.allSettled([api.deskDetail(deskId, date), api.audit({ deskId, from: date, to: date })]);
  if (detailRes.status === "rejected") {
    box.innerHTML = `<p class="py-3 text-center text-sm text-danger">${escapeHtml(detailRes.reason?.message || t("err.SERVER_ERROR"))}</p>`;
    return;
  }
  const detail = detailRes.value;
  const moves = detail.moves ?? [];
  let changes;
  if (entriesRes.status === "fulfilled") {
    const list = entriesRes.value.entries;
    learnFromEntries(list);
    changes = list.length ? `<ul class="card divide-y divide-hairline p-0">${list.map(entryRow).join("")}</ul>` : `<p class="text-sm text-gray-600">${t("history.empty")}</p>`;
  } else {
    // Staff may read today's changes only; a refusal is a note, not an error.
    const denied = entriesRes.reason?.status === 403;
    changes = `<p class="text-sm ${denied ? "text-gray-600" : "text-danger"}">${t(denied ? "history.notAvailable" : "err.SERVER_ERROR")}</p>`;
  }
  box.innerHTML = `
    ${skuTable(detail.rows ?? [])}
    <h3 class="mb-1.5 mt-3 text-xs font-extrabold uppercase tracking-wide text-gray-600">${t("history.moves")}</h3>
    <div class="flex flex-col gap-2">${moves.length ? moves.map(moveCard).join("") : `<p class="text-sm text-gray-600">${t("history.noMoves")}</p>`}</div>
    <h3 class="mb-1.5 mt-3 text-xs font-extrabold uppercase tracking-wide text-gray-600">${t("history.entries")}</h3>
    ${changes}`;
  wireUndo(box, onUndone);
}

function wireUndo(scope, onUndone) {
  scope.querySelectorAll("[data-undo]").forEach((btn) =>
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
}

// host: element to fill. date: the day on screen, where the table starts.
// onUndone: reload the day after a move was undone.
export async function renderHistory(host, { deskId, date, onUndone }) {
  host.innerHTML = `
    <section aria-labelledby="hist-days">
      <h2 id="hist-days" class="mb-2 text-xs font-extrabold uppercase tracking-wide text-gray-600">${t("history.days")}</h2>
      <div id="hist-wrap" class="card max-h-[70vh] min-w-0 overflow-auto p-0">
        <table class="w-full min-w-[560px] border-collapse text-xs">
          <thead class="sticky top-0 z-10 bg-gray-50 text-gray-600">
            <tr>
              <th class="px-2 py-2 text-left font-semibold">${t("documents.date")}</th>
              <th class="px-2 py-2 text-right font-semibold">${t("stock.colOpen")}</th>
              <th class="px-2 py-2 text-right font-semibold">${t("stock.colIn")}</th>
              <th class="px-2 py-2 text-right font-semibold">${t("stock.colOut")}</th>
              <th class="px-2 py-2 text-right font-semibold">${t("stock.colClose")}</th>
              <th class="px-2 py-2 text-right font-semibold">${t("history.count")}</th>
              <th class="px-2 py-2 text-right font-semibold">${t("history.diff")}</th>
              <th class="px-2 py-2 text-left font-semibold">${t("history.by")}</th>
            </tr>
          </thead>
          <tbody id="hist-body" class="divide-y divide-hairline"></tbody>
        </table>
      </div>
      <p id="hist-status" class="py-4 text-center text-sm text-gray-600" role="status">${t("settings.loading")}</p>
      <button type="button" id="hist-more" class="btn-secondary mt-2 hidden w-full">${t("history.more")}</button>
    </section>`;

  const body = host.querySelector("#hist-body");
  const status = host.querySelector("#hist-status");
  const more = host.querySelector("#hist-more");
  let nextTo = date || null;

  learnFromAccounts(deskId);

  async function toggle(tr) {
    const open = tr.getAttribute("aria-expanded") === "true";
    const next = tr.nextElementSibling;
    if (open) {
      tr.setAttribute("aria-expanded", "false");
      if (next?.dataset.detailFor === tr.dataset.date) next.remove();
      return;
    }
    tr.setAttribute("aria-expanded", "true");
    const d = document.createElement("tr");
    d.dataset.detailFor = tr.dataset.date;
    d.innerHTML = `<td colspan="8" class="bg-gray-50 p-3"><div class="min-w-0 max-w-[calc(100vw-56px)] whitespace-normal break-words"></div></td>`;
    tr.after(d);
    await fillDayDetail(d.querySelector("div"), { deskId, date: tr.dataset.date, onUndone });
  }
  body.addEventListener("click", (e) => {
    if (e.target.closest("[data-undo]")) return;
    const tr = e.target.closest("tr[data-date]");
    if (tr) toggle(tr);
  });
  body.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-date]");
    if (tr && e.target === tr) {
      e.preventDefault();
      toggle(tr);
    }
  });

  async function load() {
    more.disabled = true;
    try {
      const res = await api.deskHistory(deskId, nextTo || undefined, 30);
      body.insertAdjacentHTML("beforeend", res.rows.map(dayRow).join(""));
      nextTo = res.nextTo;
      status.textContent = body.children.length ? "" : t("history.empty");
      status.classList.toggle("hidden", body.children.length > 0);
      more.classList.toggle("hidden", !nextTo);
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
