import { api } from "../../api.js";
import { toast } from "../../ui.js";
import { escapeHtml, clamp, toggleSwitch, fmtPct, debounce } from "../../util.js";
import { t } from "../../i18n.js";

const dirty = new Set();
let filter = "all"; // "all" | "incomplete"
let groupFilter = "all"; // "all" | type_name
let sizeFilter = "all"; // "all" | weight_name
let searchQuery = "";

export async function renderLeadtime(root) {
  root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">Loading…</div>`;
  const [{ items, summary }, { config }] = await Promise.all([api.runRate(), api.settingsSummary()]);
  dirty.clear();
  filter = "all";
  groupFilter = "all";
  sizeFilter = "all";
  searchQuery = "";
  renderChrome(root, items, summary, config);
}

function isComplete(item) {
  return item.avg_daily_sales != null && item.order_lead_time_days != null;
}

function visibleItems(items) {
  const q = searchQuery.trim().toLowerCase();
  return items.filter(
    (i) =>
      (filter !== "incomplete" || !isComplete(i)) &&
      (groupFilter === "all" || i.type_name === groupFilter) &&
      (sizeFilter === "all" || i.weight_name === sizeFilter) &&
      (!q || i.name_en.toLowerCase().includes(q))
  );
}

function renderChrome(root, items, summary, config) {
  const groupNames = [...new Set(items.map((i) => i.type_name).filter(Boolean))];
  const sizeNames = [...new Set(items.map((i) => i.weight_name).filter(Boolean))];

  root.innerHTML = `
    <div class="card p-4">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0 truncate text-sm font-bold text-gray-900">${t("settings.leadtimeTitle")}</div>
        <div class="flex shrink-0 gap-1.5">
          <span class="status-pill bg-brand-100 text-brand-700">${t("settings.avgSellingLabel")} ${fmtPct(summary.total ? (summary.filledSales / summary.total) * 100 : 0)}</span>
          <span class="status-pill bg-gray-100 text-gray-600">${t("settings.orderLeadTimeLabel")} ${fmtPct(summary.total ? (summary.filledLeadTime / summary.total) * 100 : 0)}</span>
        </div>
      </div>
      <div class="mt-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto no-scrollbar border-t border-hairline pt-3">
        <button data-filter="all" class="rr-filter chip min-h-0 min-w-0 shrink-0 ${filter === "all" ? "border-brand-600 bg-brand-600 text-white" : "border-hairline bg-white text-gray-600"}">${t("settings.filterAll")}</button>
        <button data-filter="incomplete" class="rr-filter chip min-h-0 min-w-0 shrink-0 ${filter === "incomplete" ? "border-brand-600 bg-brand-600 text-white" : "border-hairline bg-white text-gray-600"}">${t("settings.filterIncomplete")}</button>
        <select id="rr-group-filter" class="chip min-h-0 min-w-0 shrink-0 border-hairline bg-white text-gray-600">
          <option value="all">${t("settings.filterAllGroups")}</option>
          ${groupNames.map((g) => `<option value="${escapeHtml(g)}" ${groupFilter === g ? "selected" : ""}>${escapeHtml(g)}</option>`).join("")}
        </select>
        <select id="rr-size-filter" class="chip min-h-0 min-w-0 shrink-0 border-hairline bg-white text-gray-600">
          <option value="all">${t("settings.filterAllSizes")}</option>
          ${sizeNames.map((s) => `<option value="${escapeHtml(s)}" ${sizeFilter === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}
        </select>
        <input id="rr-search" type="search" placeholder="${t("settings.searchPlaceholder")}" value="${escapeHtml(searchQuery)}"
          class="chip min-h-0 min-w-0 shrink-0 w-24 border-hairline bg-white text-gray-600 placeholder:text-gray-400" />
      </div>
    </div>

    <div id="rr-unsaved" class="sticky top-0 z-10 mt-3 hidden rounded-xl bg-warning-bg px-3.5 py-2.5 text-xs font-bold text-warning">${t("settings.unsavedChanges")}</div>

    <div id="rr-table-wrap"></div>

    <button id="rr-save-all" class="btn-primary sticky bottom-3 mt-4 w-full" disabled>${t("settings.saveAll")}</button>

    ${sectionTitle(t("settings.bufferLabel"))}
    <div class="card p-4">
      ${stepperField("safety-buffer", t("settings.bufferLabel"), config.safety_buffer_days, "Days", 0.5)}
      <div class="mt-1 flex items-center justify-between rounded-xl bg-gray-50 px-3.5 py-3">
        <div>
          <div class="text-xs font-bold text-gray-800">${t("settings.autoDraftTitle")}</div>
          <div class="text-[11px] text-gray-600">${t("settings.autoDraftDesc")}</div>
        </div>
        ${toggleSwitch(config.auto_draft_po, 'id="auto-draft-toggle"')}
      </div>
      <button id="save-config" class="btn-primary mt-4 w-full">${t("settings.save")}</button>
    </div>
    <div class="h-4"></div>
  `;

  root.querySelectorAll(".rr-filter").forEach((btn) =>
    btn.addEventListener("click", () => {
      filter = btn.dataset.filter;
      dirty.clear();
      renderChrome(root, items, summary, config);
    })
  );
  root.querySelector("#rr-group-filter").addEventListener("change", (e) => {
    groupFilter = e.target.value;
    dirty.clear();
    renderChrome(root, items, summary, config);
  });
  root.querySelector("#rr-size-filter").addEventListener("change", (e) => {
    sizeFilter = e.target.value;
    dirty.clear();
    renderChrome(root, items, summary, config);
  });
  root.querySelector("#rr-search").addEventListener(
    "input",
    debounce((e) => {
      searchQuery = e.target.value;
      dirty.clear();
      renderTable(root, items);
    }, 300)
  );

  renderTable(root, items);
  root.querySelector("#rr-save-all").addEventListener("click", () => saveAll(root, items));
  wireConfigCard(root);
}

function renderTable(root, items) {
  const visible = visibleItems(items);
  const groups = new Map();
  for (const item of visible) {
    const key = item.type_name || "—";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const wrap = root.querySelector("#rr-table-wrap");
  wrap.innerHTML = `
    <div class="card mt-3 overflow-x-auto p-2">
      <div class="min-w-[320px]">
        <div class="grid grid-cols-[52px_1fr_54px_54px_26px] gap-1.5 px-1.5 pb-1.5 text-[9px] font-extrabold uppercase tracking-wide text-gray-500">
          <span>${t("settings.weightColumn")}</span>
          <span>${t("settings.skuColumn")}</span>
          <span class="text-center">${t("settings.avgSellingShort")}</span>
          <span class="text-center">${t("settings.leadTimeShort")}</span>
          <span></span>
        </div>
        <div class="flex flex-col divide-y divide-hairline">
          ${[...groups.entries()]
            .map(
              ([typeName, groupItems]) => `
            <div class="bg-gray-50 px-1.5 py-1 text-[9px] font-extrabold uppercase tracking-wide text-gray-500">${escapeHtml(typeName)} · ${groupItems.length}</div>
            ${groupItems.map((item) => tableRow(item)).join("")}
          `
            )
            .join("") || `<div class="py-6 text-center text-xs text-gray-500">—</div>`}
        </div>
      </div>
    </div>
  `;

  wrap.querySelectorAll("[data-rr-row]").forEach((rowEl) => wireRow(root, rowEl, items));
  syncFooter(root);
}

function statusBadge(complete) {
  return complete
    ? `<span data-rr-status aria-label="${t("settings.allSaved")}" class="flex h-5 w-5 items-center justify-center rounded-full bg-success-bg text-success">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
      </span>`
    : `<span data-rr-status aria-label="${t("settings.filterIncomplete")}" class="flex h-5 w-5 items-center justify-center rounded-full bg-gray-100 text-gray-400">
        <svg class="h-2 w-2" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>
      </span>`;
}

function tableRow(item) {
  const subtitle = escapeHtml(item.name_en);
  return `
  <div data-rr-row="${item.sku_id}" class="grid grid-cols-[52px_1fr_54px_54px_26px] items-center gap-1.5 px-1.5 py-1.5">
    <span class="truncate text-[10px] text-gray-500" title="${escapeHtml(item.weight_name || "")}">${escapeHtml(item.weight_name || "—")}</span>
    <span class="truncate text-xs font-bold text-gray-900" title="${subtitle}">${subtitle}</span>
    <input data-rr-input="sales" type="number" inputmode="decimal" step="0.1" value="${item.avg_daily_sales ?? ""}" placeholder="—"
      class="w-full rounded-lg border border-hairline bg-gray-50 py-1 text-center text-[11px] font-bold text-gray-900 focus:outline-none focus:ring-1 focus:ring-brand-300" />
    <input data-rr-input="lead" type="number" inputmode="decimal" step="0.5" value="${item.order_lead_time_days ?? ""}" placeholder="—"
      class="w-full rounded-lg border border-hairline bg-gray-50 py-1 text-center text-[11px] font-bold text-gray-900 focus:outline-none focus:ring-1 focus:ring-brand-300" />
    <div class="relative flex h-6 w-6 items-center justify-center">
      <span data-rr-status-slot>${statusBadge(isComplete(item))}</span>
      <button data-rr-save aria-label="${t("settings.saveRow")}" class="absolute inset-0 hidden h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-white">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
      </button>
    </div>
  </div>`;
}

function sectionTitle(text) {
  return `<h2 class="mb-2.5 mt-6 text-[11px] font-extrabold uppercase tracking-wide text-gray-600">${text}</h2>`;
}

function stepperField(id, label, value, unit, step) {
  return `
  <div class="mb-3" data-stepper data-step="${step}">
    <label class="mb-1.5 block text-xs font-bold text-gray-600">${label}</label>
    <div class="flex items-center gap-2">
      <button data-minus class="tap-target flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-hairline text-lg font-bold text-gray-500 active:bg-gray-50">−</button>
      <div class="input-filled flex flex-1 items-center justify-center gap-1.5">
        <input id="${id}" type="number" step="${step}" value="${Number(value).toFixed(1)}" class="w-16 bg-transparent text-center font-extrabold text-gray-900 focus:outline-none" />
        <span class="text-xs font-semibold text-gray-600">${unit}</span>
      </div>
      <button data-plus class="tap-target flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-hairline text-lg font-bold text-gray-500 active:bg-gray-50">+</button>
    </div>
  </div>`;
}

function wireRow(root, rowEl, items) {
  const skuId = rowEl.dataset.rrRow;
  const saveBtn = rowEl.querySelector("[data-rr-save]");
  const statusSlot = rowEl.querySelector("[data-rr-status-slot]");
  rowEl.querySelectorAll("[data-rr-input]").forEach((input) => {
    input.addEventListener("input", () => {
      dirty.add(skuId);
      statusSlot.classList.add("hidden");
      saveBtn.classList.remove("hidden");
      saveBtn.classList.add("flex");
      syncFooter(root);
    });
  });
  saveBtn.addEventListener("click", async () => {
    await saveRow(root, items, skuId);
    toast(t("settings.saveRow"), "success");
  });
}

async function saveRow(root, items, skuId) {
  const rowEl = root.querySelector(`[data-rr-row="${skuId}"]`);
  const salesInput = rowEl.querySelector('[data-rr-input="sales"]');
  const leadInput = rowEl.querySelector('[data-rr-input="lead"]');
  const avgDailySales = salesInput.value === "" ? null : Number(salesInput.value);
  const orderLeadTimeDays = leadInput.value === "" ? null : Number(leadInput.value);
  await api.saveRunRate(skuId, { avgDailySales, orderLeadTimeDays });
  const item = items.find((i) => i.sku_id === skuId);
  item.avg_daily_sales = avgDailySales;
  item.order_lead_time_days = orderLeadTimeDays;
  dirty.delete(skuId);
  const saveBtn = rowEl.querySelector("[data-rr-save]");
  saveBtn.classList.add("hidden");
  saveBtn.classList.remove("flex");
  const statusSlot = rowEl.querySelector("[data-rr-status-slot]");
  statusSlot.innerHTML = statusBadge(isComplete(item));
  statusSlot.classList.remove("hidden");
  syncFooter(root);
}

async function saveAll(root, items) {
  const btn = root.querySelector("#rr-save-all");
  btn.disabled = true;
  for (const skuId of [...dirty]) {
    await saveRow(root, items, skuId);
  }
  toast(t("settings.allSaved"), "success");
}

function syncFooter(root) {
  root.querySelector("#rr-unsaved").classList.toggle("hidden", dirty.size === 0);
  root.querySelector("#rr-save-all").disabled = dirty.size === 0;
}

function wireConfigCard(root) {
  root.querySelectorAll("[data-stepper]").forEach((group) => {
    const input = group.querySelector("input");
    const step = Number(group.dataset.step);
    group.querySelector("[data-minus]").addEventListener("click", () => {
      input.value = clamp(Number(input.value) - step, 0, 999).toFixed(1);
    });
    group.querySelector("[data-plus]").addEventListener("click", () => {
      input.value = clamp(Number(input.value) + step, 0, 999).toFixed(1);
    });
  });

  const toggleBtn = root.querySelector("#auto-draft-toggle");
  toggleBtn.addEventListener("click", () => {
    const on = toggleBtn.dataset.on === "true";
    toggleBtn.dataset.on = String(!on);
    toggleBtn.classList.toggle("bg-brand-600", !on);
    toggleBtn.classList.toggle("bg-gray-300", on);
    toggleBtn.querySelector("span").classList.toggle("translate-x-4", !on);
  });

  root.querySelector("#save-config").addEventListener("click", async () => {
    const safetyBufferDays = Number(root.querySelector("#safety-buffer").value);
    const autoDraftPo = toggleBtn.dataset.on === "true";
    await api.saveConfig({ safetyBufferDays, autoDraftPo });
    toast(t("settings.save"), "success");
  });
}
