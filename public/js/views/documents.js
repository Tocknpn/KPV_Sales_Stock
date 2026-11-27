// Documents = reorder proposals. A branch manager (own branch) or an admin
// creates and edits them from the "+" button; staff only view and print.
// One proposal per case per day; several cases saved together share a group
// and print as one PDF, each case on its own pages.
import { api, openDocumentPrint, openPrintTab, fillPrintTabMany, openGroupPrint } from "../api.js";
import { isAdmin, isManager } from "../session.js";
import { state, branchName, setStoredDocView } from "../state.js";
import { toast, openSheet, closeSheet, openActionSheet } from "../ui.js";
import { fmtDate, fmtDateTime, escapeHtml, icon, fmtInt, reorderChip, needsOrder } from "../util.js";
import { t, tf } from "../i18n.js";
import { skuLabel } from "../sku-groups.js";
import { skeletonCards, skeletonTable } from "../skeleton.js";
import { renderSkuPickerInto } from "./sku-picker.js";

const PAGE_SIZE = 20;
const CHEVRON = `<svg class="h-3 w-3 shrink-0 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>`;

const canEdit = () => isManager(state.user);
const round2 = (n) => Math.round(n * 100) / 100;

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(Number(n) || 0));
  return d.toISOString().slice(0, 10);
}

function deskLabel(deskId) {
  const desk = state.meta.desks.find((d) => d.desk_id === deskId);
  return desk ? `${desk.desk_id} · ${desk.display_name}` : deskId ?? "—";
}

export async function mountDocuments() {
  renderTopbar();
  renderFab();
  await refreshDocuments();
}

export function unmountDocuments() {
  document.getElementById("fab-new-proposal")?.remove();
}

// ---------------------------------------------------------------------------
// The "+" button: managers only, floating above the bottom nav.
// ---------------------------------------------------------------------------
function renderFab() {
  let host = document.getElementById("fab-new-proposal");
  if (!canEdit()) {
    host?.remove();
    return;
  }
  if (!host) {
    host = document.createElement("div");
    host.id = "fab-new-proposal";
    host.className = "pointer-events-none fixed inset-x-0 bottom-[72px] z-20 mx-auto flex max-w-[430px] justify-end px-4";
    document.body.appendChild(host);
  }
  host.classList.remove("hidden");
  host.innerHTML = `
    <button id="new-proposal" aria-label="${t("documents.newProposal")}" class="pointer-events-auto tap-target flex h-14 w-14 items-center justify-center rounded-full bg-brand-700 text-white shadow-pop active:scale-95">
      <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>
    </button>`;
  host.querySelector("#new-proposal").addEventListener("click", () => openProposalEditor());
}

function hideFab() {
  document.getElementById("fab-new-proposal")?.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Filters: Branch · Case · Date from–to · Created by, on one line.
// ---------------------------------------------------------------------------
function dateRangeLabel() {
  const { dateFrom, dateTo } = state.documents;
  if (!dateFrom && !dateTo) return t("documents.dateRange");
  if (dateFrom && dateTo && dateFrom === dateTo) return fmtDate(dateFrom);
  return `${dateFrom ? fmtDate(dateFrom) : "…"} – ${dateTo ? fmtDate(dateTo) : "…"}`;
}

function filterButton(id, label, active) {
  return `<button id="${id}" class="flex min-w-0 items-center justify-between gap-1 rounded-xl border px-2 py-2 text-[11px] font-semibold ${
    active ? "border-brand-300 bg-brand-50 text-brand-700" : "border-hairline bg-white text-gray-700"
  }"><span class="truncate">${escapeHtml(label)}</span>${CHEVRON}</button>`;
}

function renderTopbar() {
  const el = document.getElementById("topbar-slot");
  const f = state.documents;
  el.innerHTML = `
    <div class="flex items-start justify-between">
      <div>
        <h1 class="text-lg font-extrabold text-gray-900">${t("documents.title")}</h1>
        <p class="text-[11px] font-medium text-gray-600">${t("documents.subtitle")}</p>
      </div>
      <div class="flex rounded-lg bg-gray-100 p-0.5">
        <button data-view-toggle="cards" class="doc-view-toggle rounded-md px-2.5 py-1 text-[11px] font-bold">${t("documents.cardView")}</button>
        <button data-view-toggle="table" class="doc-view-toggle rounded-md px-2.5 py-1 text-[11px] font-bold">${t("documents.tableView")}</button>
      </div>
    </div>
    <div class="mt-3 grid grid-cols-4 gap-1.5">
      ${filterButton("branch-select", f.branch ? branchName(f.branch) : t("documents.allBranches"), !!f.branch)}
      ${filterButton("desk-select", f.desk ?? t("documents.allCases"), !!f.desk)}
      ${filterButton("date-select", dateRangeLabel(), !!(f.dateFrom || f.dateTo))}
      ${filterButton("creator-select", f.createdBy ?? t("documents.filterByCreator"), !!f.createdBy)}
    </div>
  `;

  const changed = () => {
    state.documents.page = 1;
    renderTopbar();
    refreshDocuments();
  };

  document.getElementById("branch-select").addEventListener("click", (e) => {
    const options = [{ label: t("documents.allBranches"), value: null }, ...state.meta.branches.map((b) => ({ label: branchName(b.branch_id), value: b.branch_id }))];
    openActionSheet(
      t("documents.filterByBranch"),
      options.map((o) => ({ ...o, selected: o.value === state.documents.branch })),
      (opt) => {
        state.documents.branch = opt.value;
        state.documents.desk = null;
        state.documents.createdBy = null;
        changed();
      },
      { anchorEl: e.currentTarget }
    );
  });

  document.getElementById("desk-select").addEventListener("click", (e) => {
    const pool = state.documents.branch ? state.meta.desks.filter((d) => d.branch_id === state.documents.branch) : state.meta.desks;
    const options = [{ label: t("documents.allCases"), value: null }, ...pool.map((d) => ({ label: `${d.desk_id} · ${d.display_name}`, value: d.desk_id }))];
    openActionSheet(
      t("documents.filterByDesk"),
      options.map((o) => ({ ...o, selected: o.value === state.documents.desk })),
      (opt) => {
        state.documents.desk = opt.value;
        changed();
      },
      { anchorEl: e.currentTarget }
    );
  });

  document.getElementById("date-select").addEventListener("click", (e) => {
    openSheet(
      `
      <label class="mb-1 block text-xs font-bold text-gray-600">${t("documents.dateFrom")}</label>
      <input id="range-from" type="date" value="${state.documents.dateFrom ?? ""}" max="${state.meta.today}" class="input-filled mb-3 w-full text-sm" />
      <label class="mb-1 block text-xs font-bold text-gray-600">${t("documents.dateTo")}</label>
      <input id="range-to" type="date" value="${state.documents.dateTo ?? ""}" max="${state.meta.today}" class="input-filled mb-4 w-full text-sm" />
      <div class="flex gap-2 pb-2">
        <button id="range-clear" class="btn-secondary flex-1">${t("documents.clear")}</button>
        <button id="range-apply" class="btn-primary flex-1">${t("documents.apply")}</button>
      </div>`,
      {
        title: t("documents.dateRange"),
        anchorEl: e.currentTarget,
        onMount: (body) => {
          body.querySelector("#range-clear").addEventListener("click", () => {
            state.documents.dateFrom = null;
            state.documents.dateTo = null;
            closeSheet();
            changed();
          });
          body.querySelector("#range-apply").addEventListener("click", () => {
            let from = body.querySelector("#range-from").value || null;
            let to = body.querySelector("#range-to").value || null;
            if (from && to && from > to) [from, to] = [to, from];
            state.documents.dateFrom = from;
            state.documents.dateTo = to;
            closeSheet();
            changed();
          });
        },
      }
    );
  });

  document.getElementById("creator-select").addEventListener("click", async (e) => {
    const anchorEl = e.currentTarget;
    let creators = [];
    try {
      ({ creators } = await api.documentCreators(state.documents.branch));
    } catch {}
    const options = [{ label: t("documents.allCreators"), value: null }, ...creators.map((name) => ({ label: escapeHtml(name), value: name }))];
    openActionSheet(
      t("documents.filterByCreator"),
      options.map((o) => ({ ...o, selected: o.value === state.documents.createdBy })),
      (opt) => {
        state.documents.createdBy = opt.value;
        changed();
      },
      { anchorEl }
    );
  });

  document.querySelectorAll(".doc-view-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.documents.view = btn.dataset.viewToggle;
      setStoredDocView(state.documents.view);
      applyViewToggleStyles();
      renderList(lastData);
    })
  );
  applyViewToggleStyles();
}

function applyViewToggleStyles() {
  document.querySelectorAll(".doc-view-toggle").forEach((btn) => {
    const active = btn.dataset.viewToggle === state.documents.view;
    btn.classList.toggle("bg-white", active);
    btn.classList.toggle("shadow-card", active);
    btn.classList.toggle("text-brand-700", active);
    btn.classList.toggle("text-gray-600", !active);
  });
}

let lastData = { documents: [], total: 0, page: 1, pageSize: PAGE_SIZE };

const STATUS_STYLE = {
  pending: "bg-warning-bg text-warning",
  approved: "bg-success-bg text-success",
  rejected: "bg-danger-bg text-danger",
};

function statusChip(doc) {
  if (!doc.status) return "";
  return `<span class="status-pill shrink-0 ${STATUS_STYLE[doc.status]}">${t(`documents.status.${doc.status}`)}</span>`;
}

function deskLabelOf(doc) {
  return doc.desk_id ? ` · ${escapeHtml(doc.desk_name ? `${doc.desk_id} ${doc.desk_name}` : doc.desk_id)}` : "";
}

// A manager edits or deletes a pending proposal of their branch; an admin deletes anything.
const mayEditDoc = (doc) => canEdit() && doc.kind === "proposal" && doc.status === "pending";
const mayDeleteDoc = (doc) => isAdmin(state.user) || mayEditDoc(doc);

async function refreshDocuments() {
  const root = document.getElementById("view-root");
  root.innerHTML = skeletonCards(4);
  const f = state.documents;
  const data = await api.documents({
    branchId: f.branch,
    deskId: f.desk,
    dateFrom: f.dateFrom,
    dateTo: f.dateTo,
    createdBy: f.createdBy,
    page: f.page,
    pageSize: PAGE_SIZE,
  });
  lastData = data;
  if (state.view === "documents" && !document.getElementById("proposal-back")) renderList(data);
}

function totalsLine(d) {
  return `<span><b class="text-gray-800">${fmtInt(d.skuCount ?? 0)}</b> ${t("documents.skuCount")}</span>
    <span><b class="text-gray-800">${fmtInt(d.totalQty ?? 0)}</b> ${t("documents.pcs")}</span>
    <span><b class="text-gray-800">${round2(d.totalWeightG ?? 0)}</b> g</span>`;
}

function renderList(data) {
  const root = document.getElementById("view-root");
  root.innerHTML = `
    <div id="doc-list"></div>
    <div id="doc-pagination" class="mt-4 flex items-center justify-between"></div>
    <div class="h-20"></div>
  `;
  const listEl = document.getElementById("doc-list");
  if (data.documents.length === 0) {
    listEl.innerHTML = `<div class="card py-10 text-center text-sm text-gray-600">${t("documents.noDocuments")}</div>`;
  } else if (state.documents.view === "table") {
    renderTable(listEl, data.documents);
  } else {
    renderCards(listEl, data.documents);
  }
  renderPagination(data);
}

function groupLink(d) {
  return d.group_id && d.group_size > 1
    ? `<button data-print-group="${escapeHtml(d.group_id)}" class="font-bold text-brand-600">${tf("documents.groupOf", { n: d.group_size })} · ${t("documents.printAll")}</button>`
    : "";
}

function renderCards(listEl, docs) {
  listEl.className = "flex flex-col gap-2.5";
  listEl.innerHTML = docs
    .map(
      (d) => `
    <div class="card cursor-pointer p-2.5" data-doc="${d.id}">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="truncate text-xs font-extrabold text-gray-900">${escapeHtml(d.title)}</div>
          <div class="text-[10px] text-gray-500">${escapeHtml(d.doc_no)}</div>
        </div>
        ${statusChip(d)}
      </div>
      <div class="mt-1.5 text-[11px] text-gray-600">${escapeHtml(branchName(d.branch_id))}${deskLabelOf(d)} · ${fmtDate(d.doc_date)} · ${escapeHtml(d.created_by)}</div>
      <div class="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-gray-500">${totalsLine(d)}</div>
      <div class="mt-2 flex items-center justify-between gap-2 border-t border-hairline pt-2 text-[11px]">
        <span class="text-gray-400">${fmtDateTime(d.created_at)}</span>
        <span class="flex items-center gap-3">
          ${groupLink(d)}
          <button data-print="${d.id}" class="font-bold text-brand-600">${t("documents.printPdf")} ↗</button>
        </span>
      </div>
    </div>`
    )
    .join("");
  wireCardActions(listEl, docs);
}

function renderTable(listEl, docs) {
  listEl.className = "overflow-x-auto rounded-xl border border-hairline bg-white";
  listEl.innerHTML = `
    <table class="w-full text-left text-[11px] md:text-sm">
      <thead class="bg-gray-50 text-gray-600">
        <tr>
          <th class="px-3 py-2 font-semibold">${t("documents.docNo")}</th>
          <th class="px-3 py-2 font-semibold">${t("documents.desk")}</th>
          <th class="px-3 py-2 font-semibold">${t("documents.date")}</th>
          <th class="px-3 py-2 font-semibold">${t("documents.createdBy")}</th>
          <th class="px-3 py-2 text-right font-semibold">${t("documents.skuCount")}</th>
          <th class="px-3 py-2 text-right font-semibold">${t("documents.totalQty")}</th>
          <th class="px-3 py-2 text-right font-semibold">${t("documents.totalWeight")}</th>
          <th class="px-3 py-2"></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-hairline">
        ${docs
          .map(
            (d) => `
          <tr data-doc="${d.id}" class="cursor-pointer">
            <td class="whitespace-nowrap px-3 py-2 font-semibold text-gray-800">${escapeHtml(d.doc_no)} ${statusChip(d)}</td>
            <td class="whitespace-nowrap px-3 py-2 text-gray-600">${escapeHtml(d.desk_id ?? "—")}</td>
            <td class="whitespace-nowrap px-3 py-2 text-gray-500">${d.doc_date}</td>
            <td class="whitespace-nowrap px-3 py-2 text-gray-500">${escapeHtml(d.created_by)}</td>
            <td class="px-3 py-2 text-right text-gray-700">${fmtInt(d.skuCount ?? 0)}</td>
            <td class="px-3 py-2 text-right text-gray-700">${fmtInt(d.totalQty ?? 0)}</td>
            <td class="whitespace-nowrap px-3 py-2 text-right text-gray-700">${round2(d.totalWeightG ?? 0)} g</td>
            <td class="whitespace-nowrap px-3 py-2 text-right">
              <button data-print="${d.id}" class="font-bold text-brand-600">${t("documents.printPdf")}</button>
              ${d.group_id && d.group_size > 1 ? `<button data-print-group="${escapeHtml(d.group_id)}" class="ml-2 font-bold text-brand-600">${t("documents.printAll")}</button>` : ""}
            </td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
  wireCardActions(listEl, docs);
}

function wireCardActions(listEl, docs) {
  listEl.querySelectorAll("[data-doc]").forEach((row) =>
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-print],[data-print-group]")) return;
      openDocumentDetail(docs.find((d) => d.id === row.dataset.doc));
    })
  );
  listEl.querySelectorAll("[data-print]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDocumentPrint(btn.dataset.print);
    })
  );
  listEl.querySelectorAll("[data-print-group]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openGroupPrint(btn.dataset.printGroup);
    })
  );
}

function renderPagination(data) {
  const el = document.getElementById("doc-pagination");
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  if (data.total <= data.pageSize) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <button id="page-prev" class="btn-secondary px-4 py-2 text-xs" ${data.page <= 1 ? "disabled" : ""}>${t("documents.prev")}</button>
    <span class="text-xs font-semibold text-gray-600">${t("documents.page")} ${data.page} / ${totalPages}</span>
    <button id="page-next" class="btn-secondary px-4 py-2 text-xs" ${data.page >= totalPages ? "disabled" : ""}>${t("documents.next")}</button>
  `;
  document.getElementById("page-prev")?.addEventListener("click", () => {
    if (state.documents.page > 1) {
      state.documents.page -= 1;
      refreshDocuments();
    }
  });
  document.getElementById("page-next")?.addEventListener("click", () => {
    if (state.documents.page < totalPages) {
      state.documents.page += 1;
      refreshDocuments();
    }
  });
}

function confirmDelete(id) {
  openActionSheet(
    t("documents.confirmDelete"),
    [
      { label: t("documents.delete"), value: true },
      { label: t("documents.cancel"), value: false },
    ],
    async (opt) => {
      if (!opt.value) return;
      try {
        await api.deleteDocument(id);
        toast(t("documents.deletedToast"), "success");
        await refreshDocuments();
      } catch (err) {
        toast(err.message || t("documents.deleteFailedToast"), "error");
      }
    }
  );
}

function openDocumentDetail(doc) {
  const ordered = doc.rows.filter((r) => Number(r.qty ?? 0) > 0);
  const rest = doc.rows.filter((r) => !(Number(r.qty ?? 0) > 0));
  const rowHtml = (r, dim) => `
        <div class="rounded-xl border border-hairline p-2.5 ${dim ? "opacity-60" : ""}">
          <div class="flex items-center justify-between gap-2">
            <span class="min-w-0 truncate text-xs font-bold text-gray-900" lang="lo">${escapeHtml(r.item)}</span>
            <span class="shrink-0 text-xs font-extrabold text-gray-900">${r.qty ?? "—"}</span>
          </div>
          <div class="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-gray-500">
            <span class="min-w-0 truncate">${r.balance != null ? `${t("documents.colBalance")} ${r.balance} · ` : ""}${r.note ? escapeHtml(r.note) : ""}</span>
            <span class="shrink-0">${r.weight_g ?? "—"} g</span>
          </div>
        </div>`;
  openSheet(
    `
    <div class="mb-1 text-[11px] text-gray-600">${escapeHtml(doc.doc_no)} · ${fmtDate(doc.doc_date)} · ${fmtDateTime(doc.created_at)}</div>
    <div class="mb-2 text-xs text-gray-500">${escapeHtml(branchName(doc.branch_id))}${deskLabelOf(doc)} · ${t("documents.createdBy")} ${escapeHtml(doc.created_by)}</div>
    <div class="mb-3 flex flex-wrap gap-x-3 text-[11px] text-gray-500">${totalsLine(doc)}</div>
    ${
      doc.status
        ? `<div class="mb-4 flex items-center gap-2">${statusChip(doc)}${
            doc.decided_by ? `<span class="text-[11px] text-gray-500">${escapeHtml(doc.decided_by)} · ${fmtDateTime(doc.decided_at)}</span>` : ""
          }</div>`
        : ""
    }
    <div class="flex flex-col gap-2">
      ${ordered.map((r) => rowHtml(r, false)).join("")}
      ${rest.map((r) => rowHtml(r, true)).join("")}
    </div>
    ${doc.notes ? `<p class="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">${escapeHtml(doc.notes)}</p>` : ""}
    ${
      doc.status === "pending" && isAdmin(state.user)
        ? `<div class="mt-5 flex gap-2.5">
             <button id="reject-btn" class="btn-secondary flex-1 border-danger/30 text-danger">${t("documents.reject")}</button>
             <button id="approve-btn" class="btn-primary flex-1">${t("documents.approve")}</button>
           </div>`
        : ""
    }
    <div class="mt-3 flex flex-wrap gap-2.5 pb-2">
      ${mayEditDoc(doc) ? `<button id="edit-btn" class="btn-primary flex-1">${t("documents.edit")}</button>` : ""}
      <button id="print-btn" class="btn-secondary flex-1">${t("documents.printPdf")}</button>
      ${doc.group_id && doc.group_size > 1 ? `<button id="print-group-btn" class="btn-secondary flex-1">${t("documents.printAll")}</button>` : ""}
      ${mayDeleteDoc(doc) ? `<button id="delete-btn" class="btn-secondary flex-1 text-danger">${t("documents.delete")}</button>` : ""}
    </div>
  `,
    {
      title: doc.title,
      onMount: (body) => {
        body.querySelector("#print-btn").addEventListener("click", () => openDocumentPrint(doc.id));
        body.querySelector("#print-group-btn")?.addEventListener("click", () => openGroupPrint(doc.group_id));
        body.querySelector("#edit-btn")?.addEventListener("click", () => {
          closeSheet();
          openProposalEditor({ edit: doc });
        });
        body.querySelector("#delete-btn")?.addEventListener("click", () => {
          closeSheet();
          confirmDelete(doc.id);
        });
        const decide = async (decision) => {
          await api.decideDocument(doc.id, decision);
          closeSheet();
          toast(t(`documents.status.${decision}`), "success");
          refreshDocuments();
        };
        body.querySelector("#approve-btn")?.addEventListener("click", () => decide("approved"));
        body.querySelector("#reject-btn")?.addEventListener("click", () => decide("rejected"));
      },
    }
  );
}

// Opens the live proposal a case already has on a date (from the case picker's link).
async function openExistingProposal(docId, deskId, date) {
  try {
    const { documents } = await api.documents({ deskId, dateFrom: date, dateTo: date, kind: "proposal", pageSize: 20 });
    const doc = documents.find((d) => d.id === docId);
    if (doc) openDocumentDetail(doc);
  } catch {}
}

// ---------------------------------------------------------------------------
// Reorder proposal editor — a full page. Several cases at once: each case is
// one swipeable pane listing every SKU on that case's sheet for the date, with
// the balance the manager orders against (opening before the final count,
// closing after). Saving shows a check sheet grouped by expected arrival, then
// creates one proposal per case (or updates the one being edited) and prints.
// ---------------------------------------------------------------------------
function setEditorTopbar(title, onBack) {
  document.getElementById("topbar-slot").innerHTML = `
    <div class="flex items-center gap-2.5">
      <button id="proposal-back" aria-label="${t("login.back")}" class="tap-target -ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 active:bg-gray-100">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
      </button>
      <h1 class="min-w-0 truncate text-lg font-extrabold text-gray-900">${title}</h1>
    </div>`;
  document.getElementById("proposal-back").addEventListener("click", onBack);
}

const ROW_COLS = "grid-cols-[140px_52px_52px_60px_minmax(90px,1fr)_24px]";

// At / below the branch minimum: "Order now · short 3" (or Ordered / Late).
const reasonFor = (r) => reorderChip(r)?.text ?? null;
// A new proposal starts each "order now" / late line at what brings it back to its minimum.
const suggestedQty = (r) => (needsOrder(r.branch_status) && r.short_by > 0 ? String(r.short_by) : "");

function sourceLabel(src) {
  if (!src) return "";
  if (src.balance_source === "opening") return tf("documents.balanceOpening", { date: fmtDate(src.balance_date) });
  if (src.balance_source === "closing") return tf("documents.balanceClosing", { date: fmtDate(src.balance_date) });
  if (src.balance_source === "previous_closing") return tf("documents.balancePrevious", { date: fmtDate(src.balance_date) });
  return t("documents.balanceNone");
}

const orderedCount = (k) => k.rows.filter((r) => Number(r.qty) > 0).length;

async function openProposalEditor({ edit } = {}) {
  const editing = Boolean(edit);
  const today = state.meta.today;
  let branchId = editing ? edit.branch_id : state.documents.branch ?? state.user?.branchId ?? state.meta.branches[0]?.branch_id;
  let date = editing ? edit.doc_date : today;
  // cases: [{ deskId, title, docId?, loading, source, leadDays, defaultLead, rows: [...] }]
  let cases = [];
  let active = 0;
  let saving = false;

  hideFab();
  const backOut = () => {
    renderTopbar();
    renderFab();
    refreshDocuments();
  };
  setEditorTopbar(editing ? t("documents.editProposal") : t("documents.newProposal"), backOut);

  const root = document.getElementById("view-root");
  root.scrollTop = 0;

  // Turns the server's source rows into editable rows. `saved`: rows to carry
  // over — a proposal being edited (keepBalance: its saved balance wins) or
  // what was typed before the date changed (the new date's balance wins).
  function buildRows(src, saved, keepBalance) {
    const savedBySku = new Map((saved ?? []).filter((r) => r.sku_id).map((r) => [r.sku_id, r]));
    const rows = (src?.rows ?? []).map((r) => {
      const s = savedBySku.get(r.sku_id);
      savedBySku.delete(r.sku_id);
      const gramEach = r.gram_each ?? r.std_gram_weight ?? 0;
      const prefill = s || keepBalance ? "" : suggestedQty(r);
      return {
        sku_id: r.sku_id,
        item: skuLabel(r),
        skuIcon: r.icon,
        gramEach,
        leadDays: r.lead_days,
        balance: s && keepBalance ? s.balance ?? null : r.balance,
        attention: needsOrder(r.branch_status) || r.branch_status === "ordered",
        reason: reasonFor(r),
        qty: s ? s.qty ?? "" : prefill,
        weight_g: s ? s.weight_g ?? "" : prefill && gramEach ? round2(Number(prefill) * gramEach) : "",
        weightTouched: s ? s.weightTouched ?? (s.weight_g != null && Number(s.weight_g) !== round2(Number(s.qty ?? 0) * gramEach)) : false,
        note: s?.note ?? "",
        manual: false,
      };
    });
    // Lines not on the case's sheet that day (added from the picker, or free text) stay.
    for (const s of saved ?? []) {
      if (s.sku_id && !savedBySku.has(s.sku_id)) continue;
      rows.push({
        sku_id: s.sku_id ?? null,
        item: s.item,
        skuIcon: s.skuIcon ?? "box",
        gramEach: s.gramEach ?? 0,
        leadDays: s.leadDays ?? (s.sku_id ? src?.lead_days?.[s.sku_id] ?? null : null),
        balance: keepBalance ? s.balance ?? null : null,
        attention: false,
        reason: null,
        qty: s.qty ?? "",
        weight_g: s.weight_g ?? "",
        weightTouched: s.weightTouched ?? true,
        note: s.note ?? "",
        manual: true,
      });
    }
    return rows;
  }

  async function loadCase(k, saved, keepBalance = false) {
    k.loading = true;
    try {
      k.source = await api.proposalSource(k.deskId, date);
      k.rows = buildRows(k.source, saved ?? k.rows.filter((r) => r.manual || r.qty !== "" || r.note), keepBalance);
    } catch (err) {
      toast(err.message || t("documents.proposalLoadFailed"), "error");
      k.source = null;
    }
    k.loading = false;
  }

  function newCase(deskId) {
    return { deskId, title: `${t("documents.proposalTitlePrefix")} — ${deskLabel(deskId)}`, loading: true, source: null, rows: [] };
  }

  // ---- rendering ----
  function render() {
    const desksOfBranch = state.meta.desks.filter((d) => d.branch_id === branchId);
    const caseText = cases.length === 0 ? t("documents.pickCases") : cases.length <= 2 ? cases.map((k) => k.deskId).join(", ") : tf("documents.casesN", { n: cases.length });
    root.innerHTML = `
      <p class="mb-3 text-[11px] text-gray-500">${t("documents.proposalIntro")}</p>
      <div class="mb-2 grid grid-cols-2 gap-2">
        <button id="branch-pick" ${editing ? "disabled" : ""} class="chip justify-between border-hairline bg-white text-gray-700 disabled:opacity-60">
          <span class="truncate">${escapeHtml(branchName(branchId))}</span>${editing ? "" : CHEVRON}
        </button>
        <button id="case-pick" ${editing || desksOfBranch.length === 0 ? "disabled" : ""} class="chip justify-between ${cases.length ? "border-brand-300 bg-brand-50 text-brand-700" : "border-hairline bg-white text-gray-700"} disabled:opacity-60">
          <span class="truncate">${escapeHtml(caseText)}</span>${editing ? "" : CHEVRON}
        </button>
      </div>
      <input id="doc-date" type="date" value="${date}" max="${today}" ${editing ? "disabled" : ""} class="input-filled mb-3 w-full text-xs disabled:opacity-60" />

      <div id="case-strip" class="no-scrollbar sticky top-0 z-20 -mx-4 mb-2 flex gap-1.5 overflow-x-auto bg-surface/95 px-4 py-2 backdrop-blur ${cases.length > 1 ? "" : "hidden"}"></div>
      <div id="panes" class="no-scrollbar -mx-4 flex snap-x snap-mandatory items-start overflow-x-auto overscroll-x-contain scroll-smooth"></div>
      <div id="pane-dots" class="mt-2 flex justify-center gap-1.5 ${cases.length > 1 ? "" : "hidden"}"></div>

      <div class="h-4"></div>
      <div class="sticky bottom-0 z-20 -mx-4 border-t border-hairline bg-white/95 px-4 pb-2 pt-3 backdrop-blur">
        <button id="save-doc" class="btn-primary w-full" ${cases.length === 0 ? "disabled" : ""}>${t("documents.proposalSave")}</button>
      </div>
    `;

    const panes = root.querySelector("#panes");
    if (cases.length === 0) {
      panes.innerHTML = `
        <div class="w-full shrink-0 px-4">
          <button id="empty-pick" class="card flex w-full flex-col items-center gap-2 py-10 text-center text-sm font-semibold text-gray-600">
            ${icon("box", "h-6 w-6 text-brand-600")}${t("documents.pickCases")}
          </button>
        </div>`;
      panes.querySelector("#empty-pick").addEventListener("click", () => openCasePicker(root.querySelector("#case-pick")));
    } else {
      panes.innerHTML = cases.map((_, i) => `<section data-pane="${i}" class="w-full shrink-0 snap-center snap-always px-4"></section>`).join("");
      cases.forEach((_, i) => renderPane(i));
      paintStrip();
      panes.addEventListener("scroll", () => {
        const i = Math.round(panes.scrollLeft / Math.max(1, panes.clientWidth));
        if (i !== active && i >= 0 && i < cases.length) {
          active = i;
          paintStrip();
        }
      });
      if (active > 0) {
        panes.style.scrollBehavior = "auto";
        panes.scrollLeft = active * panes.clientWidth;
        panes.style.scrollBehavior = "";
      }
    }

    root.querySelector("#branch-pick").addEventListener("click", (e) => {
      if (editing) return;
      openActionSheet(
        t("documents.branch"),
        state.meta.branches.map((b) => ({ label: branchName(b.branch_id), value: b.branch_id, selected: b.branch_id === branchId })),
        (opt) => {
          if (opt.value === branchId) return;
          branchId = opt.value;
          cases = [];
          active = 0;
          render();
        },
        { anchorEl: e.currentTarget }
      );
    });
    root.querySelector("#case-pick").addEventListener("click", (e) => openCasePicker(e.currentTarget));
    root.querySelector("#doc-date").addEventListener("change", async (e) => {
      const next = e.target.value && e.target.value <= today ? e.target.value : today;
      e.target.value = next;
      if (next === date) return;
      date = next;
      cases.forEach((k) => (k.loading = true));
      render();
      await Promise.all(cases.map((k) => loadCase(k)));
      render();
    });
    root.querySelector("#save-doc").addEventListener("click", startSave);
  }

  function paintStrip() {
    const strip = root.querySelector("#case-strip");
    const dots = root.querySelector("#pane-dots");
    if (!strip || cases.length < 2) return;
    strip.innerHTML = cases
      .map((k, i) => {
        const on = i === active;
        const n = orderedCount(k);
        return `<button type="button" data-goto="${i}" class="shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[11px] font-bold ${
          on ? "border-brand-600 bg-brand-600 text-white" : "border-hairline bg-white text-gray-700"
        }">${escapeHtml(k.deskId)}${n ? ` · ${tf("documents.toOrderN", { n })}` : ""}</button>`;
      })
      .join("");
    dots.innerHTML = cases.map((_, i) => `<span class="h-1.5 rounded-full ${i === active ? "w-4 bg-brand-600" : "w-1.5 bg-gray-300"}"></span>`).join("");
    strip.querySelectorAll("[data-goto]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.goto);
        const panes = root.querySelector("#panes");
        panes.scrollTo({ left: i * panes.clientWidth, behavior: "smooth" });
        active = i;
        paintStrip();
      })
    );
    strip.querySelector(`[data-goto="${active}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
  }

  function headerHtml() {
    return `
    <div class="grid ${ROW_COLS} border-b border-hairline bg-gray-50 text-[8px] font-extrabold uppercase tracking-wide text-gray-500">
      <span class="sticky left-0 z-10 border-r border-hairline bg-gray-50 px-1.5 py-1.5">${t("settings.skuColumn")}</span>
      <span class="flex items-center justify-center border-r border-hairline px-0.5 py-1.5 text-center">${t("documents.colBalance")}</span>
      <span class="flex items-center justify-center border-r border-hairline px-0.5 py-1.5 text-center">${t("documents.qty")}</span>
      <span class="flex items-center justify-center border-r border-hairline px-0.5 py-1.5 text-center">${t("documents.weightG")}</span>
      <span class="flex items-center justify-center border-r border-hairline px-0.5 py-1.5 text-center">${t("documents.note")}</span>
      <span></span>
    </div>`;
  }

  function rowHtml(r, i) {
    const balanceText = r.balance === null || r.balance === undefined ? "—" : `${fmtInt(r.balance)}`;
    return `
    <div class="grid ${ROW_COLS} border-b border-hairline ${r.attention ? "bg-danger-bg" : ""}" data-row-index="${i}">
      <div class="sticky left-0 z-10 flex items-center border-r border-hairline ${r.attention ? "bg-danger-bg" : "bg-surface"} px-1.5 py-1.5">
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">${icon(r.skuIcon || "ring", "h-3.5 w-3.5")}</span>
          <div class="min-w-0 flex-1">
            <div class="truncate text-[11px] font-bold text-gray-900" lang="lo">${escapeHtml(r.item)}</div>
            ${r.reason ? `<span class="status-pill mt-0.5 inline-flex px-1 py-0.5 text-[8px] leading-tight bg-danger-bg text-danger">${escapeHtml(r.reason)}</span>` : ""}
          </div>
        </div>
      </div>
      <div class="flex items-center justify-center border-r border-hairline text-center text-[11px] font-bold text-gray-700">${balanceText}</div>
      <input data-field="qty" type="number" min="0" inputmode="numeric" placeholder="0" value="${r.qty}"
             class="h-full w-full border-r border-hairline bg-transparent text-center text-[11px] font-bold focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300" />
      <input data-field="weight_g" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0" value="${r.weight_g}"
             class="h-full w-full border-r border-hairline bg-transparent text-center text-[11px] font-semibold focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300" />
      <input data-field="note" type="text" maxlength="300" placeholder="${t("documents.note")}" value="${escapeHtml(r.note)}"
             class="h-full w-full border-r border-hairline bg-transparent px-1.5 text-[10px] font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300" />
      ${
        r.manual
          ? `<button type="button" data-remove-row="${i}" aria-label="${t("documents.delete")}" class="flex items-center justify-center text-gray-400 hover:text-danger">×</button>`
          : "<span></span>"
      }
    </div>`;
  }

  function renderPane(i) {
    const k = cases[i];
    const pane = root.querySelector(`[data-pane="${i}"]`);
    if (!pane) return;
    const attention = k.rows.filter((r) => r.attention).length;
    const existing = k.source?.existing && k.source.existing.id !== k.docId ? k.source.existing : null;
    pane.innerHTML = `
      <div class="mb-1.5 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="truncate text-xs font-extrabold text-gray-900">${escapeHtml(deskLabel(k.deskId))}</div>
          <div class="text-[10px] text-gray-500">${k.loading ? "…" : escapeHtml(sourceLabel(k.source))}</div>
        </div>
        ${
          !k.loading
            ? `<span class="status-pill shrink-0 px-1.5 py-0.5 text-[9px] ${attention > 0 ? "bg-danger-bg text-danger" : "bg-gray-100 text-gray-500"}">${attention} ${t("documents.proposalNeedsReorder")}</span>`
            : ""
        }
      </div>
      ${
        existing
          ? `<button type="button" data-open-existing class="mb-2 w-full rounded-lg bg-warning-bg px-3 py-2 text-left text-[11px] font-bold text-warning">${escapeHtml(
              tf("documents.caseTaken", { doc: existing.doc_no })
            )} ↗</button>`
          : ""
      }
      <div class="card overflow-x-auto p-1">
        <div class="min-w-[420px]" data-table></div>
      </div>
      <button type="button" data-add-other class="btn-secondary mt-3 w-full py-2.5 text-xs">${t("documents.addOtherItem")}</button>`;

    const table = pane.querySelector("[data-table]");
    if (k.loading) {
      table.innerHTML = skeletonTable(5, 3);
    } else if (k.rows.length === 0) {
      table.innerHTML = `<div class="py-10 text-center text-xs text-gray-500">${t("documents.proposalEmptyCase")}</div>`;
    } else {
      table.innerHTML = headerHtml() + k.rows.map(rowHtml).join("");
      wireRows(table, k, i);
    }
    pane.querySelector("[data-open-existing]")?.addEventListener("click", () => openExistingProposal(existing.id, k.deskId, date));
    pane.querySelector("[data-add-other]").addEventListener("click", () => openAddOther(i));
  }

  function wireRows(table, k, paneIndex) {
    table.querySelectorAll("[data-row-index]").forEach((rowEl) => {
      const idx = Number(rowEl.dataset.rowIndex);
      const row = k.rows[idx];
      rowEl.querySelectorAll("[data-field]").forEach((input) => {
        input.addEventListener("input", (e) => {
          const field = e.target.dataset.field;
          row[field] = e.target.value;
          // Weight follows qty × grams per piece until the user types a weight.
          if (field === "qty" && row.gramEach && !row.weightTouched) {
            const computed = e.target.value === "" ? "" : round2(Number(e.target.value || 0) * row.gramEach);
            row.weight_g = computed;
            const w = rowEl.querySelector('[data-field="weight_g"]');
            if (w) w.value = computed;
          }
          if (field === "weight_g") row.weightTouched = e.target.value !== "";
          if (field === "qty") paintStrip();
        });
      });
      rowEl.querySelector("[data-remove-row]")?.addEventListener("click", () => {
        k.rows.splice(idx, 1);
        renderPane(paneIndex);
        paintStrip();
      });
    });
  }

  // "+ Add Other Item": the same grouped card picker as adding SKUs to a case.
  function openAddOther(i) {
    const k = cases[i];
    openSheet(`<div id="proposal-sku-picker"></div>`, {
      title: t("documents.pickSkuTitle"),
      onMount: (body) => {
        renderSkuPickerInto(body.querySelector("#proposal-sku-picker"), {
          excludeSkuIds: k.rows.map((r) => r.sku_id).filter(Boolean),
          branchId,
          allowCreate: false,
          onCancel: closeSheet,
          onAdd: (skus) => {
            closeSheet();
            for (const sku of skus) {
              k.rows.push({
                sku_id: sku.sku_id,
                item: skuLabel(sku),
                skuIcon: sku.icon,
                gramEach: sku.std_gram_weight ?? (sku.baht_weight ? sku.baht_weight * 15 : 0),
                leadDays: k.source?.lead_days?.[sku.sku_id] ?? k.source?.default_lead_days ?? null,
                balance: null,
                attention: false,
                reason: null,
                qty: "",
                weight_g: "",
                weightTouched: false,
                note: "",
                manual: true,
              });
            }
            renderPane(i);
            root.querySelector(`[data-pane="${i}"] [data-row-index="${k.rows.length - skus.length}"] [data-field="qty"]`)?.focus();
          },
        });
      },
    });
  }

  // Multi-select case picker, opened level with the case box.
  async function openCasePicker(anchorEl) {
    if (editing) return;
    const pool = state.meta.desks.filter((d) => d.branch_id === branchId && d.active !== false);
    let taken = new Map();
    try {
      const res = await api.proposalTaken(branchId, date);
      taken = new Map(res.taken.map((x) => [x.desk_id, x]));
    } catch {}
    const picked = new Set(cases.map((k) => k.deskId).filter((id) => !taken.has(id)));
    const CHECK = `<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`;
    const itemHtml = (d) => {
      const tk = taken.get(d.desk_id);
      const on = picked.has(d.desk_id);
      return `
        <div class="flex items-center gap-2 rounded-xl px-2 py-2 ${tk ? "opacity-60" : "active:bg-gray-50"}">
          <button type="button" data-case="${escapeHtml(d.desk_id)}" ${tk ? "disabled" : ""} class="flex min-w-0 flex-1 items-center gap-3 text-left">
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${on ? "border-brand-600 bg-brand-600 text-white" : "border-gray-300 bg-white"}">${on ? CHECK : ""}</span>
            <span class="min-w-0 truncate text-sm font-semibold text-gray-800">${escapeHtml(d.desk_id)} · ${escapeHtml(d.display_name)}</span>
          </button>
          ${tk ? `<button type="button" data-taken="${escapeHtml(d.desk_id)}" class="shrink-0 text-[10px] font-bold text-brand-600 underline">${escapeHtml(tf("documents.caseTaken", { doc: tk.doc_no }))}</button>` : ""}
        </div>`;
    };
    openSheet(
      `<div id="case-list" class="flex flex-col gap-0.5"></div>
       <div class="sticky -bottom-4 z-10 -mx-5 -mb-4 mt-2 border-t border-hairline bg-white px-5 py-3">
         <button id="cases-done" class="btn-primary w-full"></button>
       </div>`,
      {
        title: t("documents.pickCases"),
        anchorEl,
        onMount: (body) => {
          const list = body.querySelector("#case-list");
          const paint = () => {
            list.innerHTML = pool.map(itemHtml).join("");
            const done = body.querySelector("#cases-done");
            done.textContent = tf("documents.doneN", { n: picked.size });
            done.disabled = picked.size === 0;
          };
          paint();
          list.addEventListener("click", (e) => {
            const takenBtn = e.target.closest("[data-taken]");
            if (takenBtn) {
              const tk = taken.get(takenBtn.dataset.taken);
              closeSheet();
              openExistingProposal(tk.id, tk.desk_id, date);
              return;
            }
            const btn = e.target.closest("[data-case]");
            if (!btn || btn.disabled) return;
            const id = btn.dataset.case;
            if (picked.has(id)) picked.delete(id);
            else picked.add(id);
            paint();
          });
          body.querySelector("#cases-done").addEventListener("click", async () => {
            closeSheet();
            // Keep what was typed for cases still picked, in the desk order.
            const keep = new Map(cases.map((k) => [k.deskId, k]));
            cases = pool.filter((d) => picked.has(d.desk_id)).map((d) => keep.get(d.desk_id) ?? newCase(d.desk_id));
            active = Math.min(active, Math.max(0, cases.length - 1));
            render();
            const fresh = cases.filter((k) => !keep.has(k.deskId));
            await Promise.all(fresh.map((k) => loadCase(k, [])));
            if (fresh.length) render();
          });
        },
      }
    );
  }

  // ---- saving ----
  function payloadRows(k) {
    return k.rows
      .filter((r) => r.item.trim() !== "")
      .map((r) => ({
        sku_id: r.sku_id ?? null,
        item: r.item.trim(),
        qty: r.qty === "" ? null : Number(r.qty),
        weight_g: r.weight_g === "" ? null : Number(r.weight_g),
        note: String(r.note ?? "").trim() || null,
        balance: r.balance ?? null,
      }));
  }

  function goToCase(i) {
    active = i;
    const panes = root.querySelector("#panes");
    panes?.scrollTo({ left: i * panes.clientWidth, behavior: "smooth" });
    paintStrip();
  }

  function startSave() {
    if (saving || cases.length === 0) return;
    if (cases.some((k) => k.loading)) return;
    const empty = cases.findIndex((k) => orderedCount(k) === 0);
    if (empty >= 0) {
      goToCase(empty);
      return toast(tf("documents.caseEmptyQty", { desk: cases[empty].deskId }), "error");
    }
    openConfirm();
  }

  // The check before saving: ordered lines grouped by expected arrival date
  // (proposal date + each SKU's lead time), then by case.
  function openConfirm() {
    const fallbackLead = cases.find((k) => k.source)?.source?.default_lead_days ?? 0;
    const byDate = new Map();
    for (const k of cases) {
      for (const r of k.rows) {
        if (!(Number(r.qty) > 0)) continue;
        const lead = r.leadDays ?? fallbackLead;
        const arrive = addDays(date, lead);
        if (!byDate.has(arrive)) byDate.set(arrive, { lead, cases: new Map(), qty: 0, grams: 0, skus: 0 });
        const g = byDate.get(arrive);
        if (!g.cases.has(k.deskId)) g.cases.set(k.deskId, []);
        g.cases.get(k.deskId).push(r);
        g.qty += Number(r.qty);
        g.grams += Number(r.weight_g || 0);
        g.skus += 1;
      }
    }
    const groups = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const all = groups.reduce((acc, [, g]) => ({ skus: acc.skus + g.skus, qty: acc.qty + g.qty, grams: acc.grams + g.grams }), { skus: 0, qty: 0, grams: 0 });
    const html = `
      <p class="mb-3 text-[11px] text-gray-500">${t("documents.confirmIntro")}</p>
      ${groups
        .map(
          ([arrive, g]) => `
        <div class="mb-3 rounded-xl border border-hairline">
          <div class="flex items-center justify-between gap-2 rounded-t-xl bg-brand-50 px-3 py-2">
            <span class="text-xs font-extrabold text-brand-700">📦 ${escapeHtml(tf("documents.arrives", { date: fmtDate(arrive), n: g.lead }))}</span>
            <span class="shrink-0 text-[10px] font-bold text-gray-600">${g.skus} ${t("documents.skuCount")} · ${fmtInt(g.qty)} ${t("documents.pcs")} · ${round2(g.grams)} g</span>
          </div>
          ${[...g.cases.entries()]
            .map(
              ([deskId, rows]) => `
            <div class="border-t border-hairline px-3 py-2">
              <div class="mb-1 text-[10px] font-extrabold uppercase tracking-wide text-gray-500">${escapeHtml(deskLabel(deskId))}</div>
              ${rows
                .map(
                  (r) => `
                <div class="flex items-center justify-between gap-2 py-0.5 text-[11px]">
                  <span class="min-w-0 truncate font-semibold text-gray-800" lang="lo">${escapeHtml(r.item)}${r.note ? ` <span class="font-normal text-gray-500">· ${escapeHtml(r.note)}</span>` : ""}</span>
                  <span class="shrink-0 font-bold text-gray-900">${fmtInt(Number(r.qty))} · ${r.weight_g === "" ? "—" : round2(Number(r.weight_g))} g</span>
                </div>`
                )
                .join("")}
            </div>`
            )
            .join("")}
        </div>`
        )
        .join("")}
      <div class="mb-3 flex justify-between rounded-xl bg-gray-50 px-3 py-2 text-xs font-extrabold text-gray-900">
        <span>${t("documents.totalQty")}</span>
        <span>${all.skus} ${t("documents.skuCount")} · ${fmtInt(all.qty)} ${t("documents.pcs")} · ${round2(all.grams)} g</span>
      </div>
      <div class="flex gap-2 pb-2">
        <button id="confirm-back" class="btn-secondary flex-1">${t("documents.backToEdit")}</button>
        <button id="confirm-save" class="btn-primary flex-1">${t("documents.confirmSave")}</button>
      </div>`;
    openSheet(html, {
      title: t("documents.confirmTitle"),
      onMount: (body) => {
        body.querySelector("#confirm-back").addEventListener("click", closeSheet);
        body.querySelector("#confirm-save").addEventListener("click", (e) => {
          e.currentTarget.disabled = true;
          save();
        });
      },
    });
  }

  async function save() {
    if (saving) return;
    saving = true;
    // Opened now, while this is still a tap, so the browser allows the tab.
    const printTab = openPrintTab();
    try {
      let printParams;
      if (editing) {
        const updated = await Promise.all(cases.map((k) => api.updateDocument(k.docId, { title: k.title, rows: payloadRows(k) })));
        printParams = { ids: updated.map((d) => d.id).join(",") };
        toast(t("documents.proposalUpdatedToast"), "success");
      } else {
        const res = await api.createProposals({
          branchId,
          date,
          notes: t("documents.proposalAutoNote"),
          cases: cases.map((k) => ({ deskId: k.deskId, title: k.title, rows: payloadRows(k) })),
        });
        printParams = { groupId: res.groupId };
        toast(t("documents.proposalSavedToast"), "success");
      }
      closeSheet();
      backOut();
      await fillPrintTabMany(printTab, printParams);
    } catch (err) {
      printTab?.close();
      closeSheet();
      saving = false;
      if (err.code === "PROPOSAL_EXISTS" || err.code === "PROPOSAL_EMPTY_CASE") {
        const i = cases.findIndex((k) => k.deskId === err.data?.deskId);
        if (i >= 0) goToCase(i);
      }
      toast(err.message || t("documents.proposalLoadFailed"), "error");
    }
  }

  // ---- start ----
  if (editing) {
    // The whole group while it is still pending, else just this proposal.
    let docs = [edit];
    if (edit.group_id && edit.group_size > 1) {
      try {
        const { documents } = await api.documents({ groupId: edit.group_id, pageSize: 50 });
        const pending = documents.filter((d) => d.status === "pending" && d.kind === "proposal");
        if (pending.some((d) => d.id === edit.id)) docs = pending.sort((a, b) => a.doc_no.localeCompare(b.doc_no));
      } catch {}
    }
    cases = docs.map((d) => ({ deskId: d.desk_id, title: d.title, docId: d.id, loading: true, source: null, rows: [], saved: d.rows }));
    active = Math.max(0, cases.findIndex((k) => k.docId === edit.id));
    render();
    await Promise.all(cases.map((k) => loadCase(k, k.saved, true)));
    render();
  } else {
    render();
    // Straight into picking cases: that is the first thing a manager does here.
    openCasePicker(root.querySelector("#case-pick"));
  }
}
