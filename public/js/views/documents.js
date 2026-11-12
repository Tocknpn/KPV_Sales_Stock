import { api } from "../api.js";
import { state, branchName, setStoredDocView } from "../state.js";
import { toast, openSheet, closeSheet, openActionSheet } from "../ui.js";
import { fmtDateTime, escapeHtml, icon } from "../util.js";
import { t, pickName } from "../i18n.js";

const PAGE_SIZE = 10;

export async function mountDocuments() {
  renderTopbar();
  await refreshDocuments();
}

function renderTopbar() {
  const el = document.getElementById("topbar-slot");
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
    <div class="mt-3 flex gap-2">
      <button id="branch-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
        <span id="branch-label" class="truncate">${state.documents.branch ? branchName(state.documents.branch) : t("documents.allBranches")}</span>
        <svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
      <button id="desk-select" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
        <span id="desk-label" class="truncate">${state.documents.desk ?? t("documents.allDesks")}</span>
        <svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>
    </div>
    <input id="date-filter" type="date" value="${state.documents.date ?? ""}" class="input-filled mt-2 w-full text-xs" />
  `;

  document.getElementById("branch-select").addEventListener("click", () => {
    const options = [{ label: t("documents.allBranches"), value: null }, ...state.meta.branches.map((b) => ({ label: branchName(b.branch_id), value: b.branch_id }))];
    openActionSheet(
      t("documents.filterByBranch"),
      options.map((o) => ({ ...o, selected: o.value === state.documents.branch })),
      (opt) => {
        state.documents.branch = opt.value;
        state.documents.desk = null;
        state.documents.page = 1;
        document.getElementById("branch-label").textContent = opt.label;
        document.getElementById("desk-label").textContent = t("documents.allDesks");
        refreshDocuments();
      }
    );
  });

  document.getElementById("desk-select").addEventListener("click", () => {
    const pool = state.documents.branch ? state.meta.desks.filter((d) => d.branch_id === state.documents.branch) : state.meta.desks;
    const options = [{ label: t("documents.allDesks"), value: null }, ...pool.map((d) => ({ label: `${d.desk_id} · ${d.display_name}`, value: d.desk_id }))];
    openActionSheet(
      t("documents.filterByDesk"),
      options.map((o) => ({ ...o, selected: o.value === state.documents.desk })),
      (opt) => {
        state.documents.desk = opt.value;
        state.documents.page = 1;
        document.getElementById("desk-label").textContent = opt.label ?? t("documents.allDesks");
        refreshDocuments();
      }
    );
  });

  document.getElementById("date-filter").addEventListener("change", (e) => {
    state.documents.date = e.target.value || null;
    state.documents.page = 1;
    refreshDocuments();
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

async function refreshDocuments() {
  const root = document.getElementById("view-root");
  root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">${t("documents.loading")}</div>`;
  const data = await api.documents({
    branchId: state.documents.branch,
    deskId: state.documents.desk,
    date: state.documents.date,
    page: state.documents.page,
    pageSize: PAGE_SIZE,
  });
  lastData = data;
  renderList(data);
}

function renderList(data) {
  const root = document.getElementById("view-root");
  root.innerHTML = `
    <button id="new-doc" class="btn-primary mb-2 w-full">
      <svg class="h-5 w-5 md:h-6 md:w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14"/></svg>
      ${t("documents.newDocument")}
    </button>
    <button id="new-proposal" class="btn-secondary mb-4 w-full border-danger/30 text-danger">
      <svg class="h-5 w-5 md:h-6 md:w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l9-4 9 4-9 4-9-4z"/><path stroke-linecap="round" stroke-linejoin="round" d="M3 8v9l9 4 9-4V8M12 12v9"/></svg>
      ${t("documents.newProposal")}
    </button>
    <div id="doc-list"></div>
    <div id="doc-pagination" class="mt-4 flex items-center justify-between"></div>
  `;
  document.getElementById("new-doc").addEventListener("click", openNewDocumentSheet);
  document.getElementById("new-proposal").addEventListener("click", openReorderProposalPage);

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

function renderCards(listEl, docs) {
  listEl.className = "flex flex-col gap-2.5";
  listEl.innerHTML = docs
    .map(
      (d) => `
    <div class="card p-2.5" data-doc="${d.id}">
      <div class="flex items-center justify-between">
        <div class="min-w-0">
          <div class="truncate text-xs font-extrabold text-gray-900">${escapeHtml(d.title)}</div>
          <div class="text-[10px] text-gray-500">${escapeHtml(d.doc_no)}</div>
        </div>
        <button data-delete="${d.id}" aria-label="${t("documents.delete")}" class="tap-target shrink-0 text-gray-400 hover:text-danger">
          <svg class="h-4 w-4 md:h-5 md:w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V4h6v3m-7 0 1 13h6l1-13"/></svg>
        </button>
      </div>
      <div class="mt-1.5 text-[11px] text-gray-600">${escapeHtml(branchName(d.branch_id))}${d.desk_id ? ` · ${d.desk_id}` : ""} · ${fmtDateTime(d.created_at)}</div>
      <div class="mt-2 flex items-center justify-between border-t border-hairline pt-2 text-[11px]">
        <span class="text-gray-500">${d.rowCount} ${t("documents.rows")}</span>
        <button data-print="${d.id}" class="font-bold text-brand-600">${t("documents.printPdf")} ↗</button>
      </div>
    </div>`
    )
    .join("");
  wireCardActions(listEl, docs);
}

function renderTable(listEl, docs) {
  listEl.className = "overflow-x-auto rounded-xl border border-hairline";
  listEl.innerHTML = `
    <table class="w-full text-left text-[11px] md:text-sm">
      <thead class="bg-gray-50 text-gray-600">
        <tr>
          <th class="px-3 py-2 font-semibold">${t("documents.docNo")}</th>
          <th class="px-3 py-2 font-semibold">${t("documents.titleField")}</th>
          <th class="px-3 py-2 font-semibold">${t("documents.branch")}</th>
          <th class="px-3 py-2 font-semibold">${t("documents.date")}</th>
          <th class="px-3 py-2 text-right font-semibold">${t("documents.rows")}</th>
          <th class="px-3 py-2"></th>
        </tr>
      </thead>
      <tbody class="divide-y divide-hairline">
        ${docs
          .map(
            (d) => `
          <tr data-doc="${d.id}">
            <td class="whitespace-nowrap px-3 py-2 font-semibold text-gray-800">${escapeHtml(d.doc_no)}</td>
            <td class="px-3 py-2 text-gray-700">${escapeHtml(d.title)}</td>
            <td class="px-3 py-2 text-gray-500">${escapeHtml(branchName(d.branch_id))}${d.desk_id ? ` · ${d.desk_id}` : ""}</td>
            <td class="whitespace-nowrap px-3 py-2 text-gray-500">${d.doc_date}</td>
            <td class="px-3 py-2 text-right text-gray-500">${d.rowCount}</td>
            <td class="whitespace-nowrap px-3 py-2 text-right">
              <button data-print="${d.id}" class="font-bold text-brand-600">${t("documents.printPdf")}</button>
              <button data-delete="${d.id}" class="ml-2 font-bold text-danger">${t("documents.delete")}</button>
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
      if (e.target.closest("[data-print],[data-delete]")) return;
      const doc = docs.find((d) => d.id === row.dataset.doc);
      openDocumentDetail(doc);
    })
  );
  listEl.querySelectorAll("[data-print]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.open(`/api/documents/${btn.dataset.print}/print`, "_blank");
    })
  );
  listEl.querySelectorAll("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDelete(btn.dataset.delete);
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
    t("documents.confirmAsAdmin"),
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
      } catch {
        toast(t("documents.deleteFailedToast"), "error");
      }
    }
  );
}

function openDocumentDetail(doc) {
  openSheet(
    `
    <div class="mb-3 text-[11px] text-gray-600">${escapeHtml(doc.doc_no)} · ${fmtDateTime(doc.created_at)}</div>
    <div class="mb-4 text-xs text-gray-500">${escapeHtml(branchName(doc.branch_id))}${doc.desk_id ? ` · ${doc.desk_id}` : ""} · ${t("documents.createdBy")} ${escapeHtml(doc.created_by)}</div>
    <div class="flex flex-col gap-2">
      ${doc.rows
        .map(
          (r) => `
        <div class="rounded-xl border border-hairline p-2.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-gray-900">${escapeHtml(r.item)}</span>
            <span class="text-xs font-extrabold text-gray-900">${r.qty ?? "—"}</span>
          </div>
          <div class="mt-0.5 flex items-center justify-between text-[11px] text-gray-500">
            <span>${r.note ? escapeHtml(r.note) : ""}</span>
            <span>${r.weight_g ?? "—"} g</span>
          </div>
        </div>`
        )
        .join("")}
    </div>
    ${doc.notes ? `<p class="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">${escapeHtml(doc.notes)}</p>` : ""}
    <div class="mt-5 flex gap-2.5 pb-2">
      <button id="print-btn" class="btn-secondary flex-1">${t("documents.printPdf")}</button>
      <button id="delete-btn" class="btn-secondary flex-1 text-danger">${t("documents.delete")}</button>
    </div>
  `,
    {
      title: doc.title,
      onMount: (body) => {
        body.querySelector("#print-btn").addEventListener("click", () => window.open(`/api/documents/${doc.id}/print`, "_blank"));
        body.querySelector("#delete-btn").addEventListener("click", () => {
          closeSheet();
          confirmDelete(doc.id);
        });
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Shared item-row component for both sheets below. A row can be either a
// freeform text item (legacy behaviour) or linked to a master SKU — once
// linked, it shows the SKU's live current balance for whichever Case is
// selected (from the same GET /api/stock/desk/:id payload the Daily Stock
// screen reads), so "how many do we have right now" and "how many do we
// want to order" sit side by side instead of staff having to remember or
// re-check the stock screen separately.
// ---------------------------------------------------------------------------
function blankRow() {
  return { sku_id: null, item: "", skuIcon: null, qty: "", weight_g: "", note: "", gramEach: 0, attention: false, reason: null };
}

function openSkuPicker(skuCatalog, selectedId, onPick) {
  const sorted = [...skuCatalog].sort((a, b) => pickName(a.name_en, a.name_lo).localeCompare(pickName(b.name_en, b.name_lo)));
  const options = [
    { label: t("documents.customItemOption"), value: null, selected: !selectedId },
    ...sorted.map((s) => ({ label: `${pickName(s.name_en, s.name_lo)} · ${s.sku_id}`, value: s.sku_id, selected: s.sku_id === selectedId })),
  ];
  openActionSheet(t("documents.pickSkuTitle"), options, (opt) => onPick(opt.value));
}

function buildRowCardHtml(r, i, balanceMap) {
  const itemCell = r.sku_id
    ? `<button type="button" data-link-item="${i}" class="flex w-full items-center justify-between gap-1.5 rounded-lg border border-brand-100 bg-brand-50 px-2.5 py-1.5 text-left">
         <span class="flex min-w-0 items-center gap-1.5">
           ${icon(r.skuIcon || "ring", "h-3.5 w-3.5 shrink-0 text-brand-600")}
           <span class="truncate text-xs font-bold text-gray-900">${escapeHtml(r.item)}</span>
         </span>
         <svg class="h-3 w-3 shrink-0 text-brand-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
       </button>`
    : `<div class="flex items-center gap-1">
         <input data-field="item" type="text" placeholder="${t("documents.item")}" value="${escapeHtml(r.item)}" class="input-filled min-w-0 flex-1 px-2 py-1.5 text-xs" />
         <button type="button" data-link-item="${i}" aria-label="${t("documents.pickSkuTitle")}" class="tap-target shrink-0 text-gray-500 hover:text-brand-600">${icon(
           "box",
           "h-4 w-4"
         )}</button>
       </div>`;
  const balance = r.sku_id ? balanceMap.get(r.sku_id) : null;
  const balanceLine = r.sku_id
    ? `<div class="mt-1 text-[10px] text-gray-500">${t("documents.currentBalance")}: <b class="text-gray-700">${
        balance ? `${balance.closing_qty} pcs` : t("documents.notOnCase")
      }</b></div>`
    : "";
  const reasonLine = r.reason ? `<div class="mt-1 text-[10px] font-semibold text-danger">${escapeHtml(r.reason)}</div>` : "";
  return `
    <div class="rounded-xl border ${r.attention ? "border-danger/30 bg-danger-bg" : "border-hairline"} p-2.5" data-row-index="${i}">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1">${itemCell}</div>
        <button type="button" data-remove-row="${i}" aria-label="${t("documents.delete")}" class="tap-target shrink-0 text-gray-400 hover:text-danger">×</button>
      </div>
      ${reasonLine}
      ${balanceLine}
      <div class="mt-2 grid grid-cols-3 gap-1.5">
        <input data-field="qty" type="number" min="0" placeholder="${t("documents.qty")}" value="${r.qty}" class="input-filled px-2 py-1.5 text-center text-xs" />
        <input data-field="weight_g" type="number" step="0.01" placeholder="${t("documents.weightG")}" value="${r.weight_g}" class="input-filled px-2 py-1.5 text-center text-xs" />
        <input data-field="note" type="text" placeholder="${t("documents.note")}" value="${escapeHtml(r.note)}" class="input-filled px-2 py-1.5 text-xs" />
      </div>
    </div>`;
}

function wireRowList(rowList, rows, render, body, balanceMap, skuCatalog) {
  rowList.querySelectorAll("[data-row-index]").forEach((rowEl) => {
    const idx = Number(rowEl.dataset.rowIndex);
    rowEl.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", (e) => {
        const field = e.target.dataset.field;
        rows[idx][field] = e.target.value;
        // Keep the order weight in sync with qty for a SKU-linked row (the
        // staff is ordering pieces, not weighing them on a scale here) — but
        // only while they haven't typed a weight of their own.
        if (rows[idx].sku_id && field === "qty" && rows[idx].gramEach) {
          const weightInput = rowEl.querySelector('[data-field="weight_g"]');
          if (weightInput && !weightInput.dataset.touched) {
            const computed = Math.round(Number(e.target.value || 0) * rows[idx].gramEach * 100) / 100;
            rows[idx].weight_g = computed;
            weightInput.value = computed;
          }
        }
        if (field === "weight_g") e.target.dataset.touched = "1";
      });
    });
    const linkBtn = rowEl.querySelector("[data-link-item]");
    if (linkBtn) {
      linkBtn.addEventListener("click", () => {
        openSkuPicker(skuCatalog, rows[idx].sku_id, (skuId) => {
          const sku = skuId ? skuCatalog.find((s) => s.sku_id === skuId) : null;
          if (sku) {
            rows[idx].sku_id = sku.sku_id;
            rows[idx].item = pickName(sku.name_en, sku.name_lo);
            rows[idx].skuIcon = sku.icon;
            rows[idx].gramEach = sku.std_gram_weight ?? 0;
          } else {
            rows[idx].sku_id = null;
            rows[idx].item = "";
            rows[idx].skuIcon = null;
            rows[idx].gramEach = 0;
          }
          render(body);
        });
      });
    }
    rowEl.querySelector("[data-remove-row]").addEventListener("click", () => {
      rows.splice(idx, 1);
      render(body);
    });
  });
}

// The reason a flagged row carries (set only on auto-added attention rows)
// is folded into the saved note so it survives onto the printed PDF, on top
// of whatever the staff types in manually.
function cleanRowsFor(rows) {
  return rows
    .filter((r) => r.item.trim() !== "")
    .map((r) => ({
      item: r.item.trim(),
      qty: r.qty === "" ? null : Number(r.qty),
      weight_g: r.weight_g === "" ? null : Number(r.weight_g),
      note: [r.reason, r.note.trim()].filter(Boolean).join(" — ") || null,
    }));
}

async function loadSkuCatalog() {
  try {
    const { skus } = await api.skus();
    return skus;
  } catch {
    return [];
  }
}

async function openNewDocumentSheet() {
  const desks = state.meta.desks;
  let selectedBranchId = state.documents.branch ?? state.meta.branches[0]?.branch_id;
  let selectedDeskId = desks.find((d) => d.branch_id === selectedBranchId)?.desk_id ?? desks[0]?.desk_id;
  let docDate = state.meta.today;
  let docTitle = "";
  let rows = [blankRow()];
  let skuCatalog = [];
  let balanceMap = new Map();

  const render = (body) => {
    const desk = desks.find((d) => d.desk_id === selectedDeskId);

    body.innerHTML = `
      <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("documents.titleField")}</label>
      <input id="doc-title" type="text" placeholder="${t("documents.titlePlaceholder")}" value="${escapeHtml(docTitle)}" class="input-filled" />

      <label class="mt-4 mb-1.5 block text-xs font-bold text-gray-600">${t("documents.branch")}</label>
      <button id="branch-pick" class="chip w-full justify-between border-hairline bg-white text-gray-700">
        <span>${branchName(selectedBranchId)}</span>
        <svg class="h-3.5 w-3.5 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>

      <label class="mt-4 mb-1.5 block text-xs font-bold text-gray-600">${t("documents.desk")}</label>
      <button id="desk-pick" class="chip w-full justify-between border-hairline bg-white text-gray-700">
        <span>${desk ? `${desk.desk_id} · ${desk.display_name}` : "—"}</span>
        <svg class="h-3.5 w-3.5 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
      </button>

      <label class="mt-4 mb-1.5 block text-xs font-bold text-gray-600">${t("documents.date")}</label>
      <input id="doc-date" type="date" value="${docDate}" class="input-filled" />

      <div class="mt-4 mb-1.5 flex items-center justify-between">
        <label class="text-xs font-bold text-gray-600">${t("documents.item")}</label>
      </div>
      <div id="row-list" class="flex flex-col gap-2"></div>
      <button id="add-row" class="btn-secondary mt-2.5 w-full py-2 text-xs">${t("documents.addRow")}</button>

      <button id="save-doc" class="btn-primary mt-5 mb-2 w-full">${t("documents.save")}</button>
    `;

    const rowList = body.querySelector("#row-list");
    rowList.innerHTML = rows.map((r, i) => buildRowCardHtml(r, i, balanceMap)).join("");
    wireRowList(rowList, rows, render, body, balanceMap, skuCatalog);

    body.querySelector("#doc-title").addEventListener("input", (e) => {
      docTitle = e.target.value;
    });

    body.querySelector("#branch-pick").addEventListener("click", () => {
      openActionSheet(
        t("documents.branch"),
        state.meta.branches.map((b) => ({ label: branchName(b.branch_id), value: b.branch_id, selected: b.branch_id === selectedBranchId })),
        (opt) => {
          selectedBranchId = opt.value;
          selectedDeskId = desks.find((d) => d.branch_id === selectedBranchId)?.desk_id;
          render(body);
          refreshBalance(body);
        }
      );
    });

    body.querySelector("#desk-pick").addEventListener("click", () => {
      const pool = desks.filter((d) => d.branch_id === selectedBranchId);
      openActionSheet(
        t("documents.desk"),
        pool.map((d) => ({ label: `${d.desk_id} · ${d.display_name}`, value: d.desk_id, selected: d.desk_id === selectedDeskId })),
        (opt) => {
          selectedDeskId = opt.value;
          render(body);
          refreshBalance(body);
        }
      );
    });

    body.querySelector("#doc-date").addEventListener("change", (e) => {
      docDate = e.target.value || state.meta.today;
      refreshBalance(body);
    });

    body.querySelector("#add-row").addEventListener("click", () => {
      rows.push(blankRow());
      render(body);
    });

    body.querySelector("#save-doc").addEventListener("click", async () => {
      const title = docTitle.trim();
      if (!title) return toast(t("documents.needTitle"), "error");
      const cleanRows = cleanRowsFor(rows);
      if (cleanRows.length === 0) return toast(t("documents.needOneRow"), "error");
      await api.createDocument({
        title,
        branchId: selectedBranchId,
        deskId: selectedDeskId,
        date: docDate,
        rows: cleanRows,
      });
      toast(t("documents.savedToast"), "success");
      closeSheet();
      refreshDocuments();
    });
  };

  async function refreshBalance(body) {
    if (!selectedDeskId) {
      balanceMap = new Map();
      render(body);
      return;
    }
    try {
      const detail = await api.deskDetail(selectedDeskId, docDate);
      balanceMap = new Map(detail.rows.map((r) => [r.sku_id, { closing_qty: r.closing_qty }]));
    } catch {
      balanceMap = new Map();
    }
    render(body);
  }

  openSheet(`<div id="doc-body"></div>`, {
    title: t("documents.newDocument"),
    onMount: async (body) => {
      const inner = body.querySelector("#doc-body");
      render(inner);
      skuCatalog = await loadSkuCatalog();
      await refreshBalance(inner);
    },
  });
}

// Reorder Proposal — a full page (not a sheet/modal), same pattern as
// stock.js's desk-detail page: its own back-arrow topbar, content rendered
// straight into #view-root instead of a bottom sheet, so there's room to
// show every SKU currently on the selected Case (not just the ones needing
// reorder) laid out as one dense spreadsheet-style row per SKU — the same
// "paper ledger" feel as the desk-detail stock grid — rather than a short
// list of cards. Picking a Case pulls that desk's current closing balance
// (GET /api/stock/desk/:id, the same source the Daily Stock screen uses for
// its low-stock chip / lifetime alert) and lists every SKU on it with its
// balance, highlighting the ones below their reorder level or projected to
// run out. Staff only fill in an order qty for whichever rows they actually
// want to order — saving goes through the same /api/documents create+print
// path as a normal document, so it lists and prints alongside everything
// else.
function setProposalTopbar(onBack) {
  document.getElementById("topbar-slot").innerHTML = `
    <div class="flex items-center gap-2.5">
      <button id="proposal-back" aria-label="${t("login.back")}" class="tap-target -ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-600 active:bg-gray-100">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
      </button>
      <h1 class="min-w-0 truncate text-lg font-extrabold text-gray-900">${t("documents.newProposal")}</h1>
    </div>`;
  document.getElementById("proposal-back").addEventListener("click", onBack);
}

const PROPOSAL_ROW_COLS = "grid-cols-[150px_56px_56px_64px_1fr_26px]";

function proposalHeaderHtml() {
  return `
  <div class="grid ${PROPOSAL_ROW_COLS} border-b border-hairline bg-gray-50 text-[8px] font-extrabold uppercase tracking-wide text-gray-500">
    <span class="sticky left-0 z-10 border-r border-hairline bg-gray-50 px-1.5 py-1.5">${t("settings.skuColumn")}</span>
    <span class="flex items-center justify-center border-r border-hairline px-0.5 py-1.5 text-center">${t("documents.colBalance")}</span>
    <span class="flex items-center justify-center border-r border-hairline px-0.5 py-1.5 text-center">${t("documents.qty")}</span>
    <span class="flex items-center justify-center border-r border-hairline px-0.5 py-1.5 text-center">${t("documents.weightG")}</span>
    <span class="flex items-center justify-center border-r border-hairline px-0.5 py-1.5 text-center">${t("documents.note")}</span>
    <span></span>
  </div>`;
}

function proposalRowHtml(r, i, balanceMap) {
  const balance = r.sku_id ? balanceMap.get(r.sku_id) : undefined;
  const balanceText = !r.sku_id ? "—" : balance !== undefined ? `${balance} pcs` : t("documents.notOnCase");
  const itemCell = r.sku_id
    ? `<div class="flex min-w-0 items-center gap-1.5">
         <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">${icon(r.skuIcon || "ring", "h-3.5 w-3.5")}</span>
         <div class="min-w-0 flex-1">
           <div class="truncate text-[11px] font-bold text-gray-900">${escapeHtml(r.item)}</div>
           <div class="truncate text-[9px] text-gray-500">${escapeHtml(r.sku_id)}</div>
           ${r.reason ? `<span class="status-pill mt-0.5 inline-flex px-1 py-0.5 text-[8px] leading-tight bg-danger-bg text-danger">${escapeHtml(r.reason)}</span>` : ""}
         </div>
       </div>`
    : `<button type="button" data-link-item="${i}" class="flex w-full items-center gap-1.5 text-left text-[11px] font-semibold text-brand-600">
         ${icon("box", "h-4 w-4 shrink-0")}<span>${t("documents.pickSkuTitle")}</span>
       </button>`;

  return `
  <div class="grid ${PROPOSAL_ROW_COLS} border-b border-hairline ${r.attention ? "bg-danger-bg" : ""}" data-row-index="${i}">
    <div class="sticky left-0 z-10 flex items-center border-r border-hairline ${r.attention ? "bg-danger-bg" : "bg-surface"} px-1.5 py-1.5">${itemCell}</div>
    <div class="flex items-center justify-center border-r border-hairline text-center text-[11px] font-bold text-gray-700">${balanceText}</div>
    <input data-field="qty" type="number" min="0" inputmode="numeric" placeholder="0" value="${r.qty}"
           class="h-full w-full border-r border-hairline bg-transparent text-center text-[11px] font-bold focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300" />
    <input data-field="weight_g" type="number" step="0.01" placeholder="0" value="${r.weight_g}"
           class="h-full w-full border-r border-hairline bg-transparent text-center text-[11px] font-semibold focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300" />
    <input data-field="note" type="text" placeholder="${t("documents.note")}" value="${escapeHtml(r.note)}"
           class="h-full w-full border-r border-hairline bg-transparent px-1.5 text-[10px] font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-300" />
    <button type="button" data-remove-row="${i}" aria-label="${t("documents.delete")}" class="flex items-center justify-center text-gray-400 hover:text-danger">×</button>
  </div>`;
}

function wireProposalRows(tableHost, rows, render, balanceMap, skuCatalog) {
  tableHost.querySelectorAll("[data-row-index]").forEach((rowEl) => {
    const idx = Number(rowEl.dataset.rowIndex);
    rowEl.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", (e) => {
        const field = e.target.dataset.field;
        rows[idx][field] = e.target.value;
        if (rows[idx].sku_id && field === "qty" && rows[idx].gramEach) {
          const weightInput = rowEl.querySelector('[data-field="weight_g"]');
          if (weightInput && !weightInput.dataset.touched) {
            const computed = Math.round(Number(e.target.value || 0) * rows[idx].gramEach * 100) / 100;
            rows[idx].weight_g = computed;
            weightInput.value = computed;
          }
        }
        if (field === "weight_g") e.target.dataset.touched = "1";
      });
    });
    const linkBtn = rowEl.querySelector("[data-link-item]");
    if (linkBtn) {
      linkBtn.addEventListener("click", () => {
        openSkuPicker(skuCatalog, rows[idx].sku_id, (skuId) => {
          const sku = skuId ? skuCatalog.find((s) => s.sku_id === skuId) : null;
          if (sku) {
            rows[idx].sku_id = sku.sku_id;
            rows[idx].item = pickName(sku.name_en, sku.name_lo);
            rows[idx].skuIcon = sku.icon;
            rows[idx].gramEach = sku.std_gram_weight ?? 0;
          }
          render();
        });
      });
    }
    rowEl.querySelector("[data-remove-row]").addEventListener("click", () => {
      rows.splice(idx, 1);
      render();
    });
  });
}

// Only rows the staff actually put an order qty on are saved — every SKU on
// the case is shown for reference, but listing them all isn't the same as
// ordering all of them.
function cleanProposalRows(rows) {
  return rows
    .filter((r) => r.item.trim() !== "" && r.qty !== "" && Number(r.qty) > 0)
    .map((r) => ({
      item: r.item.trim(),
      qty: Number(r.qty),
      weight_g: r.weight_g === "" ? null : Number(r.weight_g),
      note: [r.reason, r.note.trim()].filter(Boolean).join(" — ") || null,
    }));
}

async function openReorderProposalPage() {
  const desks = state.meta.desks;
  let selectedBranchId = state.documents.branch ?? state.meta.branches[0]?.branch_id;
  let selectedDeskId = desks.find((d) => d.branch_id === selectedBranchId)?.desk_id ?? desks[0]?.desk_id;
  let docDate = state.meta.today;
  let rows = [];
  let skuCatalog = [];
  let balanceMap = new Map();
  let loading = !!selectedDeskId;
  let docTitle = "";
  let titleAuto = true;

  const defaultTitle = () => {
    const desk = desks.find((d) => d.desk_id === selectedDeskId);
    return `${t("documents.proposalTitlePrefix")} — ${desk ? `${desk.desk_id} · ${desk.display_name}` : ""}`;
  };

  const reasonFor = (r) =>
    r.low_stock
      ? `${t("documents.proposalReasonLow")} (${r.closing_qty}/${r.threshold})`
      : r.lifetime_alert
      ? `${t("documents.proposalReasonLifetime")} (${r.est_lifetime_days}${t("stock.daysShort")})`
      : null;

  function backOut() {
    renderTopbar();
    refreshDocuments();
  }

  async function loadCaseRows() {
    if (!selectedDeskId) {
      rows = [];
      balanceMap = new Map();
      loading = false;
      render();
      return;
    }
    loading = true;
    render();
    let detail;
    try {
      detail = await api.deskDetail(selectedDeskId, docDate);
    } catch {
      loading = false;
      toast(t("documents.proposalLoadFailed"), "error");
      render();
      return;
    }
    balanceMap = new Map(detail.rows.map((r) => [r.sku_id, r.closing_qty]));
    const manualRows = rows.filter((r) => r.manual);
    rows = [
      ...detail.rows.map((r) => ({
        sku_id: r.sku_id,
        item: pickName(r.name_en, r.name_lo),
        skuIcon: r.icon,
        gramEach: r.gram_weight_each ?? 0,
        attention: r.low_stock || r.lifetime_alert,
        reason: reasonFor(r),
        qty: "",
        weight_g: "",
        note: "",
        manual: false,
      })),
      ...manualRows,
    ];
    if (titleAuto) docTitle = defaultTitle();
    loading = false;
    render();
  }

  function render() {
    const root = document.getElementById("view-root");
    const desk = desks.find((d) => d.desk_id === selectedDeskId);
    const attentionCount = rows.filter((r) => r.attention).length;

    root.innerHTML = `
      <p class="mb-3 text-[11px] text-gray-500">${t("documents.proposalIntro")}</p>

      <div class="mb-3 flex gap-2">
        <button id="branch-pick" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
          <span class="truncate">${branchName(selectedBranchId)}</span>
          <svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
        </button>
        <button id="desk-pick" class="chip flex-1 justify-between border-hairline bg-white text-gray-700">
          <span class="truncate">${desk ? `${desk.desk_id} · ${desk.display_name}` : "—"}</span>
          <svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      <input id="doc-date" type="date" value="${docDate}" class="input-filled mb-3 w-full text-xs" />
      <input id="doc-title" type="text" placeholder="${t("documents.titlePlaceholder")}" value="${escapeHtml(docTitle)}" class="input-filled mb-3 w-full" />

      <div class="mb-1.5 flex items-center justify-between">
        <label class="text-xs font-bold text-gray-600">${t("documents.item")}</label>
        ${
          !loading
            ? `<span class="status-pill px-1.5 py-0.5 text-[9px] ${attentionCount > 0 ? "bg-danger-bg text-danger" : "bg-gray-100 text-gray-500"}">${attentionCount} ${t(
                "documents.proposalNeedsReorder"
              )}</span>`
            : ""
        }
      </div>

      <div class="card overflow-x-auto p-1">
        <div class="min-w-[420px]" id="proposal-table"></div>
      </div>

      <button id="add-other" class="btn-secondary mt-3 w-full py-2.5 text-xs">${t("documents.addOtherItem")}</button>

      <div class="h-4"></div>
      <div class="sticky bottom-0 -mx-4 border-t border-hairline bg-white/95 px-4 pb-2 pt-3 backdrop-blur">
        <button id="save-doc" class="btn-primary w-full">${t("documents.proposalSave")}</button>
      </div>
    `;

    const tableHost = root.querySelector("#proposal-table");
    if (loading) {
      tableHost.innerHTML = `<div class="py-10 text-center text-xs text-gray-500">${t("documents.proposalLoading")}</div>`;
    } else if (rows.length === 0) {
      tableHost.innerHTML = `<div class="py-10 text-center text-xs text-gray-500">${t("documents.proposalEmptyCase")}</div>`;
    } else {
      tableHost.innerHTML = proposalHeaderHtml() + rows.map((r, i) => proposalRowHtml(r, i, balanceMap)).join("");
      wireProposalRows(tableHost, rows, render, balanceMap, skuCatalog);
    }

    root.querySelector("#branch-pick").addEventListener("click", () => {
      openActionSheet(
        t("documents.branch"),
        state.meta.branches.map((b) => ({ label: branchName(b.branch_id), value: b.branch_id, selected: b.branch_id === selectedBranchId })),
        (opt) => {
          selectedBranchId = opt.value;
          selectedDeskId = desks.find((d) => d.branch_id === selectedBranchId)?.desk_id;
          loadCaseRows();
        }
      );
    });

    root.querySelector("#desk-pick").addEventListener("click", () => {
      const pool = desks.filter((d) => d.branch_id === selectedBranchId);
      openActionSheet(
        t("documents.desk"),
        pool.map((d) => ({ label: `${d.desk_id} · ${d.display_name}`, value: d.desk_id, selected: d.desk_id === selectedDeskId })),
        (opt) => {
          selectedDeskId = opt.value;
          loadCaseRows();
        }
      );
    });

    root.querySelector("#doc-date").addEventListener("change", (e) => {
      docDate = e.target.value || state.meta.today;
      loadCaseRows();
    });

    root.querySelector("#doc-title").addEventListener("input", (e) => {
      docTitle = e.target.value;
      titleAuto = false;
    });

    root.querySelector("#add-other").addEventListener("click", () => {
      rows.push({ ...blankRow(), manual: true });
      render();
    });

    root.querySelector("#save-doc").addEventListener("click", async () => {
      const title = docTitle.trim();
      if (!title) return toast(t("documents.needTitle"), "error");
      if (!selectedDeskId) return toast(t("documents.proposalNeedCase"), "error");
      const cleanRows = cleanProposalRows(rows);
      if (cleanRows.length === 0) return toast(t("documents.proposalNeedAnyQty"), "error");
      const saved = await api.createDocument({
        title,
        branchId: selectedBranchId,
        deskId: selectedDeskId,
        date: docDate,
        notes: t("documents.proposalAutoNote"),
        rows: cleanRows,
      });
      toast(t("documents.savedToast"), "success");
      backOut();
      if (saved?.id) window.open(`/api/documents/${saved.id}/print`, "_blank");
    });
  }

  docTitle = defaultTitle();
  setProposalTopbar(backOut);
  document.getElementById("view-root").scrollTop = 0;
  render();
  skuCatalog = await loadSkuCatalog();
  await loadCaseRows();
}
