import { api } from "../../api.js";
import { toast, openSheet, closeSheet } from "../../ui.js";
import { icon, escapeHtml, fmtInt, ICONS, toggleSwitch, debounce } from "../../util.js";
import { t } from "../../i18n.js";
import { state } from "../../state.js";
import { isAdmin } from "../../session.js";
import { parseCsv, csvRowsToSkus, CSV_TEMPLATE } from "../../csv.js";

// Staff can look at the master data; only an admin can change it.
const canEdit = () => isAdmin(state.user);
const PURITY_OPTIONS = ["96.5%", "99.99%"];
const GRAMS_PER_BAHT = 15.244;

let activeTab = "sku";
let skuGroupFilter = "all"; // "all" | type_id
let skuSizeFilter = "all"; // "all" | weight_id
let skuSearchQuery = "";
let knownGroups = []; // existing product groups, suggested in the SKU form

export async function renderSku(root) {
  skuGroupFilter = "all";
  skuSizeFilter = "all";
  skuSearchQuery = "";
  root.innerHTML = `
    <div class="mb-3 flex rounded-lg bg-gray-200 p-0.5">
      <button data-tab="type" class="sku-tab flex-1 rounded-md px-3 py-1.5 text-xs font-bold">${t("settings.tabType")}</button>
      <button data-tab="weight" class="sku-tab flex-1 rounded-md px-3 py-1.5 text-xs font-bold">${t("settings.tabWeight")}</button>
      <button data-tab="sku" class="sku-tab flex-1 rounded-md px-3 py-1.5 text-xs font-bold">${t("settings.tabSku")}</button>
    </div>
    <div id="sku-tab-body"></div>
  `;
  root.querySelectorAll(".sku-tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      activeTab = btn.dataset.tab;
      paintTabs(root);
      await renderTab(root);
    });
  });
  paintTabs(root);
  await renderTab(root);
}

function paintTabs(root) {
  root.querySelectorAll(".sku-tab").forEach((btn) => {
    const active = btn.dataset.tab === activeTab;
    btn.classList.toggle("bg-white", active);
    btn.classList.toggle("shadow-card", active);
    btn.classList.toggle("text-brand-700", active);
    btn.classList.toggle("text-gray-600", !active);
  });
}

async function renderTab(root) {
  const body = root.querySelector("#sku-tab-body");
  body.innerHTML = `<div class="py-10 text-center text-sm text-gray-600">Loading…</div>`;
  if (activeTab === "type") return renderTypeTab(body);
  if (activeTab === "weight") return renderWeightTab(body);
  return renderSkuTab(body);
}

// --- Type tab ---

async function renderTypeTab(body) {
  const { types } = await api.skuTypes();
  body.innerHTML = `
    ${canEdit() ? `<button id="add-type" class="btn-primary mb-3 w-full py-2.5 text-xs">${t("settings.addType")}</button>` : ""}
    <div class="card divide-y divide-hairline p-0">
      ${types.map((ty) => typeRow(ty)).join("") || `<div class="py-6 text-center text-xs text-gray-500">—</div>`}
    </div>
  `;
  body.querySelector("#add-type")?.addEventListener("click", () => openTypeForm(null, body));
  body.querySelectorAll("[data-edit-type]").forEach((btn) =>
    btn.addEventListener("click", () => canEdit() && openTypeForm(types.find((ty) => ty.type_id === btn.dataset.editType), body))
  );
  body.querySelectorAll("[data-toggle-type]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const ty = types.find((x) => x.type_id === btn.dataset.toggleType);
      await api.updateSkuType(ty.type_id, { active: !ty.active });
      renderTypeTab(body);
    })
  );
}

function typeRow(ty) {
  return `
    <div class="flex items-center gap-2.5 px-4 py-3">
      <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">${icon(ty.icon, "h-4 w-4")}</span>
      <button data-edit-type="${ty.type_id}" class="min-w-0 flex-1 text-left">
        <span class="block truncate text-xs font-bold text-gray-900">${escapeHtml(ty.name_en)}</span>
        <span class="block text-[10px] text-gray-500">${ty.active ? t("settings.activeLabel") : t("settings.inactiveLabel")}</span>
      </button>
      ${canEdit() ? toggleSwitch(ty.active, `data-toggle-type="${ty.type_id}"`) : ""}
    </div>`;
}

function openTypeForm(existing, body) {
  const iconKeys = Object.keys(ICONS);
  let selectedIcon = existing?.icon ?? iconKeys[0];
  openSheet(
    `
    <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.typeNameLabel")}</label>
    <input id="type-name-en" type="text" value="${existing ? escapeHtml(existing.name_en) : ""}" class="input-filled" />
    <label class="mt-3 mb-1.5 block text-xs font-bold text-gray-600">${t("settings.typeNameLoLabel")}</label>
    <input id="type-name-lo" type="text" value="${existing?.name_lo ? escapeHtml(existing.name_lo) : ""}" class="input-filled" />
    <label class="mt-3 mb-1.5 block text-xs font-bold text-gray-600">${t("settings.typeIconLabel")}</label>
    <div class="grid grid-cols-4 gap-2">
      ${iconKeys
        .map(
          (key) =>
            `<button data-icon="${key}" class="type-icon-opt flex h-11 items-center justify-center rounded-xl border-2 ${key === selectedIcon ? "border-brand-600 bg-brand-50 text-brand-600" : "border-hairline text-gray-500"}">${icon(key, "h-5 w-5")}</button>`
        )
        .join("")}
    </div>
    <button id="save-type" class="btn-primary mt-4 w-full">${t("settings.save")}</button>
  `,
    {
      title: existing ? t("settings.editType") : t("settings.addType"),
      onMount: (sheetBody) => {
        sheetBody.querySelectorAll(".type-icon-opt").forEach((btn) => {
          btn.addEventListener("click", () => {
            selectedIcon = btn.dataset.icon;
            sheetBody.querySelectorAll(".type-icon-opt").forEach((b) => {
              const active = b.dataset.icon === selectedIcon;
              b.classList.toggle("border-brand-600", active);
              b.classList.toggle("bg-brand-50", active);
              b.classList.toggle("text-brand-600", active);
              b.classList.toggle("border-hairline", !active);
              b.classList.toggle("text-gray-500", !active);
            });
          });
        });
        sheetBody.querySelector("#save-type").addEventListener("click", async () => {
          const name_en = sheetBody.querySelector("#type-name-en").value.trim();
          if (!name_en) return toast(t("stock.needSkuName"), "error");
          const payload = { name_en, name_lo: sheetBody.querySelector("#type-name-lo").value.trim() || null, icon: selectedIcon };
          if (existing) await api.updateSkuType(existing.type_id, payload);
          else await api.createSkuType(payload);
          closeSheet();
          toast(t("settings.save"), "success");
          renderTypeTab(body);
        });
      },
    }
  );
}

// --- Weight tab ---

async function renderWeightTab(body) {
  const { weights } = await api.skuWeights();
  body.innerHTML = `
    ${canEdit() ? `<button id="add-weight" class="btn-primary mb-3 w-full py-2.5 text-xs">${t("settings.addWeight")}</button>` : ""}
    <div class="card divide-y divide-hairline p-0">
      ${weights.map((w) => weightRow(w)).join("") || `<div class="py-6 text-center text-xs text-gray-500">—</div>`}
    </div>
  `;
  body.querySelector("#add-weight")?.addEventListener("click", () => openWeightForm(null, body));
  body.querySelectorAll("[data-edit-weight]").forEach((btn) =>
    btn.addEventListener("click", () => canEdit() && openWeightForm(weights.find((w) => w.weight_id === btn.dataset.editWeight), body))
  );
  body.querySelectorAll("[data-toggle-weight]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const w = weights.find((x) => x.weight_id === btn.dataset.toggleWeight);
      await api.updateSkuWeight(w.weight_id, { active: !w.active });
      renderWeightTab(body);
    })
  );
}

function weightRow(w) {
  return `
    <div class="flex items-center gap-2.5 px-4 py-3">
      <button data-edit-weight="${w.weight_id}" class="min-w-0 flex-1 text-left">
        <span class="block truncate text-xs font-bold text-gray-900">${escapeHtml(w.name_en)}</span>
        <span class="block text-[10px] text-gray-500">${w.gram_value}g · ${w.active ? t("settings.activeLabel") : t("settings.inactiveLabel")}</span>
      </button>
      ${canEdit() ? toggleSwitch(w.active, `data-toggle-weight="${w.weight_id}"`) : ""}
    </div>`;
}

function openWeightForm(existing, body) {
  openSheet(
    `
    <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.weightNameLabel")}</label>
    <input id="weight-name" type="text" value="${existing ? escapeHtml(existing.name_en) : ""}" class="input-filled" />
    <label class="mt-3 mb-1.5 block text-xs font-bold text-gray-600">${t("settings.weightGramLabel")}</label>
    <input id="weight-gram" type="number" step="0.001" min="0" value="${existing ? existing.gram_value : ""}" class="input-filled" />
    <button id="save-weight" class="btn-primary mt-4 w-full">${t("settings.save")}</button>
  `,
    {
      title: existing ? t("settings.editWeight") : t("settings.addWeight"),
      onMount: (sheetBody) => {
        sheetBody.querySelector("#save-weight").addEventListener("click", async () => {
          const name_en = sheetBody.querySelector("#weight-name").value.trim();
          const gram_value = Number(sheetBody.querySelector("#weight-gram").value);
          if (!name_en || !gram_value) return toast(t("stock.needSkuName"), "error");
          const payload = { name_en, gram_value };
          if (existing) await api.updateSkuWeight(existing.weight_id, payload);
          else await api.createSkuWeight(payload);
          closeSheet();
          toast(t("settings.save"), "success");
          renderWeightTab(body);
        });
      },
    }
  );
}

// --- SKU tab ---

async function renderSkuTab(body) {
  const [{ skus }, { types }, { weights }] = await Promise.all([api.skus(true), api.skuTypes(), api.skuWeights()]);
  const activeTypes = types.filter((ty) => ty.active);
  const activeWeights = weights.filter((w) => w.active);
  knownGroups = [...new Set(skus.map((s) => s.group_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const searchOpen = skuSearchQuery.trim().length > 0;

  body.innerHTML = `
    <div class="mb-2 flex items-center gap-1.5">
      <div class="shrink-0 whitespace-nowrap text-[11px] font-semibold text-gray-600">${fmtInt(skus.filter((s) => s.active).length)} ${t("settings.activeSkus")}</div>
      <select id="sku-group-filter" class="chip min-h-0 min-w-0 flex-1 truncate border-hairline bg-white text-[11px] text-gray-600">
        <option value="all">${t("settings.filterGroupShort")}</option>
        ${types.map((ty) => `<option value="${ty.type_id}" ${skuGroupFilter === ty.type_id ? "selected" : ""}>${escapeHtml(ty.name_en)}</option>`).join("")}
      </select>
      <select id="sku-size-filter" class="chip min-h-0 min-w-0 flex-1 truncate border-hairline bg-white text-[11px] text-gray-600">
        <option value="all">${t("settings.filterSizeShort")}</option>
        ${weights.map((w) => `<option value="${w.weight_id}" ${skuSizeFilter === w.weight_id ? "selected" : ""}>${escapeHtml(w.name_en)}</option>`).join("")}
      </select>
      <button id="sku-search-toggle" aria-label="${t("settings.searchPlaceholder")}" class="tap-target flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-hairline text-gray-500 ${searchOpen ? "border-brand-600 bg-brand-50 text-brand-600" : "bg-white"}">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="11" cy="11" r="6.5"/><path stroke-linecap="round" d="M20 20l-4.3-4.3"/></svg>
      </button>
      ${
        canEdit()
          ? `<button id="import-csv" aria-label="${t("settings.importCsv")}" class="tap-target flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-hairline bg-white text-gray-500">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15V4M8 8l4-4 4 4"/><path stroke-linecap="round" d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
      </button>
      <button id="add-sku" aria-label="${t("settings.addSku")}" class="tap-target flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white shadow-pop active:scale-95">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>
      </button>`
          : ""
      }
    </div>
    <div id="sku-search-row" class="mb-3 ${searchOpen ? "" : "hidden"}">
      <input id="sku-search" type="search" placeholder="${t("settings.searchPlaceholder")}" value="${escapeHtml(skuSearchQuery)}"
        class="chip min-h-0 w-full border-hairline bg-white text-gray-600 placeholder:text-gray-400" />
    </div>
    <div id="sku-list-wrap"></div>
  `;

  body.querySelector("#import-csv")?.addEventListener("click", () => openImportSheet(body));
  body.querySelector("#add-sku")?.addEventListener("click", () => openSkuForm(null, activeTypes, activeWeights, types, weights, body));
  body.querySelector("#sku-group-filter").addEventListener("change", (e) => {
    skuGroupFilter = e.target.value;
    renderSkuList(body, skus, types, weights, activeTypes, activeWeights);
  });
  body.querySelector("#sku-size-filter").addEventListener("change", (e) => {
    skuSizeFilter = e.target.value;
    renderSkuList(body, skus, types, weights, activeTypes, activeWeights);
  });
  body.querySelector("#sku-search-toggle").addEventListener("click", () => {
    const row = body.querySelector("#sku-search-row");
    const nowHidden = !row.classList.contains("hidden");
    row.classList.toggle("hidden", nowHidden);
    if (nowHidden) {
      skuSearchQuery = "";
      body.querySelector("#sku-search").value = "";
      renderSkuList(body, skus, types, weights, activeTypes, activeWeights);
    } else {
      body.querySelector("#sku-search").focus();
    }
  });
  body.querySelector("#sku-search").addEventListener(
    "input",
    debounce((e) => {
      skuSearchQuery = e.target.value;
      renderSkuList(body, skus, types, weights, activeTypes, activeWeights);
    }, 300)
  );

  renderSkuList(body, skus, types, weights, activeTypes, activeWeights);
}

function visibleSkus(skus) {
  const q = skuSearchQuery.trim().toLowerCase();
  return skus.filter(
    (s) =>
      (skuGroupFilter === "all" || s.type_id === skuGroupFilter) &&
      (skuSizeFilter === "all" || s.weight_id === skuSizeFilter) &&
      (!q || s.name_en.toLowerCase().includes(q))
  );
}

function renderSkuList(body, skus, types, weights, activeTypes, activeWeights) {
  const visible = visibleSkus(skus);
  const typeOrder = new Map(types.map((ty, i) => [ty.type_id, ty.sort_order ?? i]));
  const weightOrder = new Map(weights.map((w, i) => [w.weight_id, w.sort_order ?? i]));

  const groups = new Map();
  for (const s of visible) {
    const key = s.type_id || "—";
    if (!groups.has(key)) groups.set(key, { name: s.type_name || "—", items: [] });
    groups.get(key).items.push(s);
  }
  const sortedGroups = [...groups.entries()].sort(
    (a, b) => (typeOrder.get(a[0]) ?? 999) - (typeOrder.get(b[0]) ?? 999)
  );
  for (const [, group] of sortedGroups) {
    group.items.sort((a, b) => (weightOrder.get(a.weight_id) ?? 999) - (weightOrder.get(b.weight_id) ?? 999));
  }

  const wrap = body.querySelector("#sku-list-wrap");
  wrap.innerHTML = sortedGroups.length
    ? sortedGroups
        .map(
          ([, group]) => `
      <div class="mb-3">
        <div class="mb-1.5 px-1 text-[10px] font-extrabold uppercase tracking-wide text-gray-500">${escapeHtml(group.name)} · ${group.items.length}</div>
        <div class="card divide-y divide-hairline p-0">
          ${group.items.map((s) => skuRow(s)).join("")}
        </div>
      </div>`
        )
        .join("")
    : `<div class="card p-0"><div class="py-6 text-center text-xs text-gray-500">—</div></div>`;

  wrap.querySelectorAll("[data-edit-sku]").forEach((btn) =>
    btn.addEventListener("click", () => canEdit() && openSkuForm(skus.find((s) => s.sku_id === btn.dataset.editSku), activeTypes, activeWeights, types, weights, body))
  );
  wrap.querySelectorAll("[data-toggle-sku]").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const s = skus.find((x) => x.sku_id === btn.dataset.toggleSku);
      await api.updateSku(s.sku_id, { active: !s.active });
      renderSkuTab(body);
    })
  );
}

function skuRow(s) {
  const subtitle = [s.group_name, s.weight_name, s.purity, s.baht_weight > 0 ? `${s.baht_weight} Baht` : null].filter(Boolean).join(" · ") || s.sku_id;
  return `
    <div class="flex items-center gap-2.5 px-4 py-3">
      <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">${icon(s.icon, "h-4 w-4")}</span>
      <button data-edit-sku="${s.sku_id}" class="min-w-0 flex-1 text-left">
        <span class="block truncate text-xs font-bold text-gray-900">${escapeHtml(s.name_en)}</span>
        <span class="block text-[10px] text-gray-500">${escapeHtml(subtitle)} · ${s.active ? t("settings.activeLabel") : t("settings.inactiveLabel")}</span>
      </button>
      ${canEdit() ? toggleSwitch(s.active, `data-toggle-sku="${s.sku_id}"`) : ""}
    </div>`;
}

function openSkuForm(existing, activeTypes, activeWeights, allTypes, allWeights, body) {
  if (!activeTypes.length || !activeWeights.length) return toast(t("settings.needTypeAndWeight"), "error");
  // Editing a SKU whose current Type/Weight was since deactivated: keep it
  // selectable so saving the name doesn't silently reassign it.
  const typeOptions = existing && existing.type_id && !activeTypes.some((ty) => ty.type_id === existing.type_id)
    ? [...activeTypes, allTypes.find((ty) => ty.type_id === existing.type_id)].filter(Boolean)
    : activeTypes;
  const weightOptions = existing && existing.weight_id && !activeWeights.some((w) => w.weight_id === existing.weight_id)
    ? [...activeWeights, allWeights.find((w) => w.weight_id === existing.weight_id)].filter(Boolean)
    : activeWeights;

  openSheet(
    `
    <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("stock.skuNameLabel")}</label>
    <input id="new-sku-name" type="text" maxlength="120" value="${existing ? escapeHtml(existing.name_en) : ""}" class="input-filled" />
    <label class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("settings.skuNameLoLabel")}</label>
    <input id="new-sku-name-lo" type="text" maxlength="120" lang="lo" value="${existing?.name_lo ? escapeHtml(existing.name_lo) : ""}" class="input-filled" />
    <div class="mt-3 grid grid-cols-2 gap-2">
      <div>
        <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.skuTypeLabel")}</label>
        <select id="new-sku-type" class="input-filled">
          ${typeOptions.map((ty) => `<option value="${ty.type_id}" ${existing?.type_id === ty.type_id ? "selected" : ""}>${escapeHtml(ty.name_en)}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.skuWeightLabel")}</label>
        <select id="new-sku-weight" class="input-filled">
          ${weightOptions.map((w) => `<option value="${w.weight_id}" ${existing?.weight_id === w.weight_id ? "selected" : ""}>${escapeHtml(w.name_en)}</option>`).join("")}
        </select>
      </div>
    </div>
    <label for="new-sku-group" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("settings.groupLabel")}</label>
    <input id="new-sku-group" type="text" maxlength="80" list="sku-group-list" autocomplete="off" value="${existing?.group_name ? escapeHtml(existing.group_name) : ""}" class="input-filled" />
    <datalist id="sku-group-list">${knownGroups.map((g) => `<option value="${escapeHtml(g)}"></option>`).join("")}</datalist>
    <p class="mt-1.5 text-[11px] text-gray-500">${t("settings.groupHint")}</p>
    <div class="mt-3 grid grid-cols-2 gap-2">
      <div>
        <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.purityLabel")}</label>
        <select id="new-sku-purity" class="input-filled">
          <option value="">${t("settings.notGold")}</option>
          ${PURITY_OPTIONS.map((p) => `<option value="${p}" ${existing?.purity === p ? "selected" : ""}>${p}</option>`).join("")}
        </select>
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.bahtWeightLabel")}</label>
        <input id="new-sku-baht" type="number" min="0" step="0.0001" inputmode="decimal" value="${existing ? existing.baht_weight ?? 0 : ""}" class="input-filled" />
      </div>
    </div>
    <p class="mt-1.5 text-[11px] text-gray-500">${t("settings.bahtWeightHint")}</p>
    <div class="mt-3 grid grid-cols-2 gap-2">
      <div>
        <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.priceLabel")}</label>
        <input id="new-sku-price" type="number" min="0" step="1000" inputmode="numeric" value="${existing ? existing.unit_price_lak ?? 0 : 0}" class="input-filled" />
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.reorderLevelLabel")}</label>
        <input id="new-sku-reorder" type="number" min="0" step="1" inputmode="numeric" value="${existing ? existing.reorder_level ?? 5 : 5}" class="input-filled" />
      </div>
    </div>
    <p class="mt-1.5 text-[11px] text-gray-500">${t("settings.reorderLevelHint")}</p>
    <button id="save-sku" class="btn-primary mt-4 w-full">${t("settings.saveSku")}</button>
  `,
    {
      title: existing ? existing.name_en : t("settings.addSku"),
      onMount: (sheetBody) => {
        // Gold items: suggest the Baht weight from the chosen size until the
        // admin types their own.
        const bahtInput = sheetBody.querySelector("#new-sku-baht");
        const suggestBaht = () => {
          if (bahtInput.dataset.touched || !sheetBody.querySelector("#new-sku-purity").value) return;
          const weight = allWeights.find((w) => w.weight_id === sheetBody.querySelector("#new-sku-weight").value);
          if (weight) bahtInput.value = String(Math.round((weight.gram_value / GRAMS_PER_BAHT) * 10000) / 10000);
        };
        bahtInput.addEventListener("input", () => (bahtInput.dataset.touched = "1"));
        if (existing) bahtInput.dataset.touched = "1";
        sheetBody.querySelector("#new-sku-weight").addEventListener("change", suggestBaht);
        sheetBody.querySelector("#new-sku-purity").addEventListener("change", suggestBaht);

        sheetBody.querySelector("#save-sku").addEventListener("click", async () => {
          const name_en = sheetBody.querySelector("#new-sku-name").value.trim();
          if (!name_en) return toast(t("stock.needSkuName"), "error");
          const payload = {
            name_en,
            name_lo: sheetBody.querySelector("#new-sku-name-lo").value.trim() || null,
            type_id: sheetBody.querySelector("#new-sku-type").value,
            weight_id: sheetBody.querySelector("#new-sku-weight").value,
            group_name: sheetBody.querySelector("#new-sku-group").value.trim() || null,
            purity: sheetBody.querySelector("#new-sku-purity").value || null,
            baht_weight: Math.max(0, Number(bahtInput.value) || 0),
            unit_price_lak: Math.max(0, Number(sheetBody.querySelector("#new-sku-price").value) || 0),
            reorder_level: Math.max(0, Math.round(Number(sheetBody.querySelector("#new-sku-reorder").value) || 0)),
          };
          if (existing) await api.updateSku(existing.sku_id, payload);
          else await api.createSku(payload);
          closeSheet();
          toast(t("settings.saveSku"), "success");
          renderSkuTab(body);
        });
      },
    }
  );
}

// --- CSV import: every row is checked first; one bad row imports nothing ---

function openImportSheet(body) {
  openSheet(
    `
    <p class="text-xs text-gray-600">${t("settings.importIntro")}</p>
    <button id="csv-template" class="mt-2 text-xs font-bold text-brand-600 underline">${t("settings.importTemplate")}</button>
    <label for="csv-file" class="mb-1.5 mt-4 block text-xs font-bold text-gray-600">${t("settings.importChoose")}</label>
    <input id="csv-file" type="file" accept=".csv,text/csv" class="input-filled text-xs" />
    <div id="csv-result" class="mt-3"></div>
    <button id="csv-submit" class="btn-primary mt-4 w-full" disabled>${t("settings.importCsv")}</button>
  `,
    {
      title: t("settings.importCsv"),
      onMount: (sheetBody) => {
        let rows = [];
        const result = sheetBody.querySelector("#csv-result");
        const submit = sheetBody.querySelector("#csv-submit");
        const showErrors = (errors) => {
          result.innerHTML = `
            <div class="rounded-xl bg-danger-bg px-3.5 py-3 text-xs font-semibold text-danger" role="alert">
              <div class="font-extrabold">${t("settings.importNothing")}</div>
              <ul class="mt-1 list-disc pl-4">${errors
                .slice(0, 30)
                .map((e) => `<li>${t("settings.importLine")} ${e.line}: ${escapeHtml(e.error)}</li>`)
                .join("")}</ul>
            </div>`;
        };

        sheetBody.querySelector("#csv-template").addEventListener("click", () => {
          const url = URL.createObjectURL(new Blob(["\ufeff" + CSV_TEMPLATE], { type: "text/csv;charset=utf-8" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = "kpv-sku-template.csv";
          a.click();
          URL.revokeObjectURL(url);
        });

        sheetBody.querySelector("#csv-file").addEventListener("change", async (e) => {
          rows = [];
          submit.disabled = true;
          const file = e.target.files[0];
          if (!file) return (result.innerHTML = "");
          const parsed = csvRowsToSkus(parseCsv(await file.text()));
          if (parsed.error) return showErrors([{ line: 1, error: parsed.error }]);
          rows = parsed.rows;
          result.innerHTML = `<p class="rounded-xl bg-gray-50 px-3.5 py-2.5 text-xs font-semibold text-gray-700">${rows.length} ${t("settings.importRowsFound")}</p>`;
          submit.disabled = rows.length === 0;
        });

        submit.addEventListener("click", async () => {
          submit.disabled = true;
          try {
            const { imported } = await api.importSkus(rows);
            closeSheet();
            toast(`${imported} ${t("settings.importDone")}`, "success");
            renderSkuTab(body);
          } catch (err) {
            if (err.code === "IMPORT_INVALID") return showErrors(err.data.errors);
            submit.disabled = false;
            throw err;
          }
        });
      },
    }
  );
}
