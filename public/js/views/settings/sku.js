import { api } from "../../api.js";
import { toast, openSheet, closeSheet } from "../../ui.js";
import { icon, escapeHtml, fmtInt, ICONS, toggleSwitch, debounce } from "../../util.js";
import { t, tf, productName } from "../../i18n.js";
import { state } from "../../state.js";
import { isAdmin } from "../../session.js";
import { exportRowsToSheet, sheetRowsToImport, loadXlsx } from "../../sku-xlsx.js";
import { groupSkusByType, skuSizeLabel, skuLabel, weightLabel, splitWeight, WEIGHT_UNITS, setSizeLabels } from "../../sku-groups.js";
import { skeletonList } from "../../skeleton.js";

// The catalogue (name, type, size, active; Types and Sizes) is admin only.
// Every logged-in user runs their own branch: which SKUs it carries, its
// avg/day and lead time, and adding a SKU (decided 2026-11-17).
const canEditCatalogue = () => isAdmin(state.user);
const canEditBranch = () => !!state.user;
const canEdit = canEditCatalogue;
const typeLabel = (ty) => productName(ty.name_en, ty.name_lo);
const num = (n) => String(Math.round(Number(n) * 1000) / 1000);

let activeTab = "sku";
let skuGroupFilter = "all"; // "all" | type_id
let skuSizeFilter = "all"; // "all" | weight_id
let skuSearchQuery = "";
// The branch shown: an admin picks one (remembered while the app is open);
// a staff / manager always sees their own.
let adminBranch = null;
const branchList = () => state.meta?.branches ?? [];
function skuBranch() {
  if (!isAdmin(state.user)) return state.user?.branchId ?? null;
  if (!adminBranch || !branchList().some((b) => b.branch_id === adminBranch)) adminBranch = branchList()[0]?.branch_id ?? null;
  return adminBranch;
}
// SKUs the branch does not carry are hidden until asked for.
let showNotCarried = false;
// The branch's avg/day + lead time rules and the defaults (Settings > SKU is
// where they are set; per branch since 2026-11-17, migration 15).
let plan = { rules: [], config: { defaultLeadTimeDays: 7, warningMarginDays: 3 } };
// Runway status of each SKU in the branch shown (sku_id -> row).
let statusBySku = new Map();
// Type groups the user opened in the SKU list (key = type_id, "none" = no type).
// Starts empty: every group collapsed. Kept while the app is open.
const openTypes = new Set();

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
  body.innerHTML = skeletonList(8);
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
        <span class="block truncate text-xs font-bold text-gray-900">${escapeHtml(productName(ty.name_en, ty.name_lo))}</span>
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
    <label for="type-name" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.typeNameOneLabel")}</label>
    <input id="type-name" type="text" lang="lo" maxlength="60" value="${existing ? escapeHtml(typeLabel(existing)) : ""}" class="input-filled" />
    ${existing ? `<p class="mt-1.5 text-[11px] text-gray-500">${t("settings.typeRenameHint")}</p>` : ""}
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
          const name = sheetBody.querySelector("#type-name").value.trim();
          if (!name) return toast(t("settings.needTypeName"), "error");
          const payload = { name, icon: selectedIcon };
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
  setSizeLabels(weights);
  body.innerHTML = `
    ${canEdit() ? `<button id="add-weight" class="btn-primary mb-3 w-full py-2.5 text-xs">${t("settings.addWeight")}</button>` : ""}
    <div class="card divide-y divide-hairline p-0">
      ${weights.map((w) => weightRow(w)).join("") || `<div class="py-6 text-center text-xs text-gray-500">—</div>`}
    </div>
  `;
  body.querySelector("#add-weight")?.addEventListener("click", () => openWeightForm(null, body, weights));
  body.querySelectorAll("[data-edit-weight]").forEach((btn) =>
    btn.addEventListener("click", () => canEdit() && openWeightForm(weights.find((w) => w.weight_id === btn.dataset.editWeight), body, weights))
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
        <span lang="lo" class="lao block truncate text-xs font-bold text-gray-900">${escapeHtml(w.name_en || weightLabel(w.gram_value))}</span>
        <span class="block text-[10px] text-gray-500">${num(w.gram_value)} ກລາມ · ${w.active ? t("settings.activeLabel") : t("settings.inactiveLabel")}</span>
      </button>
      ${canEdit() ? toggleSwitch(w.active, `data-toggle-weight="${w.weight_id}"`) : ""}
    </div>`;
}

// A size is qty + unit + its weight in grams, all typed by the user (decided
// 2026-11-19): "8 ບາດ" = 120 g. The unit list is every unit already in use
// plus the usual Lao ones; "+ add unit" types a new one. Only the grams are
// used in calculations; the label "qty unit" is what the app shows.
const NEW_UNIT = "__new__";

function unitChoices(weights) {
  const units = WEIGHT_UNITS.map((u) => u.unit);
  for (const w of weights) if (w.unit && !units.includes(w.unit)) units.push(w.unit);
  return units;
}

function openWeightForm(existing, body, weights) {
  const split = existing && !(existing.qty > 0 && existing.unit) ? splitWeight(existing.gram_value) : null;
  const start = {
    qty: existing ? String(split ? split.amount : Number(existing.qty)) : "",
    unit: existing ? (split ? split.unit : existing.unit) : "ບາດ",
    grams: existing ? num(existing.gram_value) : "",
  };
  const units = unitChoices(weights);
  if (!units.includes(start.unit)) units.push(start.unit);
  openSheet(
    `
    <div class="grid grid-cols-[1fr_1.4fr_1fr] gap-2">
      <div class="min-w-0">
        <label for="weight-amount" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.weightAmountLabel")}</label>
        <input id="weight-amount" type="number" step="any" min="0" inputmode="decimal" value="${escapeHtml(start.qty)}" class="input-filled px-2.5" />
      </div>
      <div class="min-w-0">
        <label for="weight-unit" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.weightUnitLabel")}</label>
        <select id="weight-unit" lang="lo" class="input-filled px-2">
          ${units.map((u) => `<option value="${escapeHtml(u)}" ${u === start.unit ? "selected" : ""}>${escapeHtml(u)}</option>`).join("")}
          <option value="${NEW_UNIT}">${t("settings.addUnit")}</option>
        </select>
      </div>
      <div class="min-w-0">
        <label for="weight-grams" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.weightGramsLabel")}</label>
        <input id="weight-grams" type="number" step="any" min="0" inputmode="decimal" value="${escapeHtml(start.grams)}" class="input-filled px-2.5" />
      </div>
    </div>
    <div id="new-unit-row" class="mt-2 hidden">
      <label for="weight-new-unit" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.newUnitLabel")}</label>
      <input id="weight-new-unit" type="text" lang="lo" maxlength="30" class="input-filled" />
    </div>
    <p id="weight-preview" role="status" class="mt-2 text-[11px] font-semibold text-gray-600"></p>
    <p id="weight-error" role="alert" class="mt-1 hidden text-xs font-semibold text-danger"></p>
    <button id="save-weight" class="btn-primary mt-4 w-full">${t("settings.save")}</button>
  `,
    {
      title: existing ? t("settings.editWeight") : t("settings.addWeight"),
      onMount: (sheetBody) => {
        const $ = (sel) => sheetBody.querySelector(sel);
        const amount = $("#weight-amount");
        const unit = $("#weight-unit");
        const grams = $("#weight-grams");
        const newUnit = $("#weight-new-unit");
        const unitName = () => (unit.value === NEW_UNIT ? newUnit.value.trim() : unit.value);
        const show = () => {
          $("#new-unit-row").classList.toggle("hidden", unit.value !== NEW_UNIT);
          const q = Number(amount.value);
          const g = Number(grams.value);
          const u = unitName();
          $("#weight-preview").textContent = q > 0 && u ? `${num(q)} ${u}${g > 0 ? ` = ${num(g)} ກລາມ` : ""}` : "";
        };
        amount.addEventListener("input", show);
        grams.addEventListener("input", show);
        newUnit.addEventListener("input", show);
        unit.addEventListener("change", () => {
          show();
          if (unit.value === NEW_UNIT) newUnit.focus();
        });
        show();
        const fail = (msg) => {
          const el = $("#weight-error");
          el.textContent = msg;
          el.classList.remove("hidden");
        };
        $("#save-weight").addEventListener("click", async (e) => {
          const qty = Number(amount.value);
          const gram_value = Number(grams.value);
          const u = unitName();
          if (!(qty > 0)) return fail(t("settings.needWeightQty"));
          if (!u) return fail(t("settings.needWeightUnit"));
          if (!(gram_value > 0)) return fail(t("settings.needWeightGrams"));
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const payload = { qty, unit: u, gram_value };
            if (existing) await api.updateSkuWeight(existing.weight_id, payload);
            else await api.createSkuWeight(payload);
          } catch (err) {
            btn.disabled = false;
            return fail(err.message || t("err.SERVER_ERROR"));
          }
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
  const branchId = skuBranch();
  const [{ skus: allSkus }, { types }, { weights }, rules] = await Promise.all([
    api.skus({ all: canEditCatalogue(), branchId }),
    api.skuTypes(),
    api.skuWeights(),
    api.replenishmentRules(branchId),
  ]);
  setSizeLabels(weights);
  const activeTypes = types.filter((ty) => ty.active);
  const activeWeights = weights.filter((w) => w.active);
  plan = rules;
  const notCarried = allSkus.filter((s) => s.carried === false).length;
  const skus = showNotCarried ? allSkus : allSkus.filter((s) => s.carried !== false);

  const searchOpen = skuSearchQuery.trim().length > 0;

  body.innerHTML = `
    <div class="mb-1.5 flex items-center gap-1.5">
      ${
        isAdmin(state.user)
          ? `<select id="sku-branch" lang="lo" aria-label="${t("settings.branchPick")}" class="chip min-h-0 w-auto max-w-[40%] shrink-0 truncate border-hairline bg-white text-[11px] font-bold text-gray-900">
        ${branchList().map((b) => `<option value="${escapeHtml(b.branch_id)}" ${b.branch_id === branchId ? "selected" : ""}>${escapeHtml(productName(b.name_en, b.name_lo))}</option>`).join("")}
      </select>`
          : ""
      }
      <select id="sku-group-filter" class="chip min-h-0 min-w-0 flex-1 truncate border-hairline bg-white text-[11px] text-gray-600">
        <option value="all">${t("settings.filterGroupShort")}</option>
        ${types.map((ty) => `<option value="${ty.type_id}" ${skuGroupFilter === ty.type_id ? "selected" : ""}>${escapeHtml(typeLabel(ty))}</option>`).join("")}
      </select>
      <select id="sku-size-filter" class="chip min-h-0 min-w-0 flex-1 truncate border-hairline bg-white text-[11px] text-gray-600">
        <option value="all">${t("settings.filterSizeShort")}</option>
        ${weights.map((w) => `<option value="${w.weight_id}" ${skuSizeFilter === w.weight_id ? "selected" : ""}>${escapeHtml(w.name_en || weightLabel(w.gram_value))}</option>`).join("")}
      </select>
      <button id="sku-search-toggle" aria-label="${t("settings.searchPlaceholder")}" class="tap-target flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-hairline text-gray-500 ${searchOpen ? "border-brand-600 bg-brand-50 text-brand-600" : "bg-white"}">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="11" cy="11" r="6.5"/><path stroke-linecap="round" d="M20 20l-4.3-4.3"/></svg>
      </button>
      ${
        canEditBranch()
          ? `<button id="import-xlsx" aria-label="${t("settings.importExport")}" class="tap-target flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-hairline bg-white text-gray-500">
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
    <p class="mb-2 flex flex-wrap gap-x-3 px-1 text-[11px] font-medium text-gray-600">
      <span class="font-semibold">${fmtInt(skus.filter((s) => s.active).length)} ${t("settings.activeSkus")}</span>
      <span>${escapeHtml(tf("replen.defaults", { lead: num(plan.config.defaultLeadTimeDays), margin: num(plan.config.warningMarginDays) }))}</span>
    </p>
    <div id="sku-list-wrap"></div>
    ${
      notCarried > 0
        ? `<button id="sku-not-carried" class="tap-target mt-1 w-full text-center text-[11px] font-bold text-brand-700">${escapeHtml(tf(showNotCarried ? "settings.hideNotCarried" : "settings.showNotCarried", { n: fmtInt(notCarried) }))}</button>`
        : ""
    }
  `;

  body.querySelector("#sku-branch")?.addEventListener("change", (e) => {
    adminBranch = e.target.value;
    body.innerHTML = skeletonList(8);
    renderSkuTab(body);
  });
  body.querySelector("#sku-not-carried")?.addEventListener("click", () => {
    showNotCarried = !showNotCarried;
    renderSkuTab(body);
  });

  body.querySelector("#import-xlsx")?.addEventListener("click", () => openImportSheet(body));
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
  // Status badges arrive after the list (one request per branch).
  loadStatuses().then(() => body.isConnected && renderSkuList(body, skus, types, weights, activeTypes, activeWeights));
}

const STATUS_RANK = { critical: 0, warning: 1, ok: 2, no_data: 3 };

async function loadStatuses() {
  const branchId = skuBranch();
  const branchIds = branchId ? [branchId] : [];
  const results = await Promise.all(branchIds.map((b) => api.replenishment(b).catch(() => null)));
  const next = new Map();
  for (const res of results) {
    for (const row of res?.rows ?? []) {
      const cur = next.get(row.sku_id);
      if (!cur || STATUS_RANK[row.status] < STATUS_RANK[cur.status]) next.set(row.sku_id, row);
    }
  }
  statusBySku = next;
}

// The branch's rule of a SKU or a Type, if any (the API sends only that branch's).
const ruleOf = (scope, key) => plan.rules.find((r) => r.scope === scope && r.scope_key === key) ?? null;

// What applies to a SKU: its own value, else its Type's, else auto / the default.
function planOf(s) {
  const own = ruleOf("sku", s.sku_id);
  const type = s.type_id ? ruleOf("type", s.type_id) : null;
  const avg = own?.avg_daily_sell ?? type?.avg_daily_sell ?? null;
  const lead = own?.lead_time_days ?? type?.lead_time_days ?? null;
  return { own, type, avg, lead: lead ?? plan.config.defaultLeadTimeDays, leadSet: lead != null };
}

function visibleSkus(skus) {
  const q = skuSearchQuery.trim().toLowerCase();
  return skus.filter(
    (s) =>
      (skuGroupFilter === "all" || s.type_id === skuGroupFilter) &&
      (skuSizeFilter === "all" || s.weight_id === skuSizeFilter) &&
      (!q || s.name_en.toLowerCase().includes(q) || (s.name_lo ?? "").toLowerCase().includes(q) || skuLabel(s).toLowerCase().includes(q))
  );
}

const CHEVRON = `<svg class="h-4 w-4 shrink-0 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>`;

function renderSkuList(body, skus, types, weights, activeTypes, activeWeights) {
  const groups = groupSkusByType(visibleSkus(skus), types, weights);
  // While searching or filtering, every matching group is shown open.
  const filtering = skuSearchQuery.trim() !== "" || skuGroupFilter !== "all" || skuSizeFilter !== "all";
  const keyOf = (g) => g.typeId ?? "none";
  const isOpen = (g) => filtering || openTypes.has(keyOf(g));
  const allOpen = groups.length > 0 && groups.every(isOpen);

  const wrap = body.querySelector("#sku-list-wrap");
  wrap.innerHTML = groups.length
    ? `
    ${
      filtering
        ? ""
        : `<div class="mb-1.5 flex justify-end"><button id="sku-toggle-all" class="tap-target px-1 text-[11px] font-bold text-brand-700">${allOpen ? t("settings.collapseAll") : t("settings.expandAll")}</button></div>`
    }
    ${groups
      .map((g) => {
        const open = isOpen(g);
        const name = g.type ? productName(g.type.name_en, g.type.name_lo) : "—";
        return `
      <div class="mb-2">
        <div class="flex items-center gap-1.5 pr-2">
          <button data-type-toggle="${escapeHtml(keyOf(g))}" aria-expanded="${open}" aria-controls="sku-grp-${escapeHtml(keyOf(g))}" ${filtering ? "disabled" : ""}
            class="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left text-gray-600 ${filtering ? "" : "active:bg-gray-100"}">
            <span class="${open ? "rotate-90" : ""} inline-flex">${CHEVRON}</span>
            <span lang="lo" class="lao min-w-0 flex-1 truncate text-xs font-extrabold uppercase tracking-wide">${escapeHtml(name)}</span>
          </button>
          ${
            canEditBranch() && g.typeId
              ? `<button data-type-plan="${escapeHtml(g.typeId)}" class="flex h-6 shrink-0 items-center rounded-full border border-brand-600 px-2 text-[10px] font-bold text-brand-700 active:bg-brand-50">${t("settings.typeSetAll")}</button>`
              : ""
          }
          <span class="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-bold text-gray-600">${g.items.length}</span>
        </div>
        ${
          canEditBranch() && g.typeId && typePlanText(g.typeId)
            ? `<div class="-mt-1 mb-1.5 truncate px-8 text-[11px] text-gray-500">${escapeHtml(typePlanText(g.typeId))}</div>`
            : ""
        }
        <div id="sku-grp-${escapeHtml(keyOf(g))}" class="card divide-y divide-hairline p-0 ${open ? "" : "hidden"}">
          ${open ? g.items.map((s) => skuRow(s)).join("") : ""}
        </div>
      </div>`;
      })
      .join("")}`
    : `<div class="card p-0"><div class="py-6 text-center text-xs text-gray-500">—</div></div>`;

  const rerender = () => renderSkuList(body, skus, types, weights, activeTypes, activeWeights);
  wrap.querySelector("#sku-toggle-all")?.addEventListener("click", () => {
    if (allOpen) openTypes.clear();
    else groups.forEach((g) => openTypes.add(keyOf(g)));
    rerender();
  });
  wrap.querySelectorAll("[data-type-toggle]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.typeToggle;
      if (openTypes.has(key)) openTypes.delete(key);
      else openTypes.add(key);
      rerender();
    })
  );
  wrap.querySelectorAll("[data-type-plan]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const g = groups.find((x) => x.typeId === btn.dataset.typePlan);
      if (g) openTypePlanSheet(g, skus, body);
    })
  );
  wrap.querySelectorAll("[data-edit-sku]").forEach((btn) =>
    btn.addEventListener("click", () => canEditBranch() && openSkuForm(skus.find((s) => s.sku_id === btn.dataset.editSku), activeTypes, activeWeights, types, weights, body))
  );
  // The switch on a row = "this branch carries it". Off is refused while the
  // branch still holds the SKU (err.STOCK_HELD).
  wrap.querySelectorAll("[data-carried-sku]").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const s = skus.find((x) => x.sku_id === btn.dataset.carriedSku);
      btn.disabled = true;
      try {
        await api.setCarried(s.sku_id, skuBranch(), s.carried === false);
      } finally {
        btn.disabled = false;
      }
      renderSkuTab(body);
    })
  );
}

// "ຂາຍ/ມື້ 2 · ໄລຍະສັ່ງ 7 ມື້" for a Type header (blank parts = not set).
function typePlanText(typeId) {
  const r = ruleOf("type", typeId);
  const parts = [];
  if (r?.avg_daily_sell != null) parts.push(`${t("replen.avg")} ${num(r.avg_daily_sell)}`);
  if (r?.lead_time_days != null) parts.push(`${t("replen.lead")} ${num(r.lead_time_days)} ${t("replen.d")}`);
  return parts.join(" · ");
}

const STATUS_CLS = { critical: "bg-danger-bg text-danger", warning: "bg-warning-bg text-warning" };

function skuRow(s) {
  const p = planOf(s);
  const avgText = p.avg != null ? num(p.avg) : t("replen.src.auto");
  const planText = `${t("replen.avg")} ${avgText} · ${t("replen.lead")} ${num(p.lead)} ${t("replen.d")}`;
  const subtitle = [skuSizeLabel(s), planText].filter(Boolean).join(" · ");
  const st = statusBySku.get(s.sku_id);
  const badge = st && STATUS_CLS[st.status] ? `<span class="status-pill mt-0.5 inline-flex px-1.5 py-0 text-[10px] ${STATUS_CLS[st.status]}">${t(`replen.status.${st.status}`)}</span>` : "";
  return `
    <div class="flex items-center gap-2.5 px-4 py-3">
      <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">${icon(s.icon, "h-4 w-4")}</span>
      <button data-edit-sku="${s.sku_id}" class="min-w-0 flex-1 text-left">
        <span lang="lo" class="lao block truncate text-xs font-bold text-gray-900">${escapeHtml(productName(s.name_en, s.name_lo))}</span>
        <span class="block text-[10px] text-gray-500">${escapeHtml(subtitle)}${s.active ? "" : ` · ${t("settings.inactiveLabel")}`}${s.carried === false ? ` · ${t("settings.notCarried")}` : ""}</span>
        ${badge}
      </button>
      ${canEditBranch() && s.carried !== null && s.carried !== undefined ? toggleSwitch(s.carried, `data-carried-sku="${s.sku_id}" aria-label="${escapeHtml(t("settings.carried"))}"`) : ""}
    </div>`;
}

// A SKU's own numbers in the branch: from GET /skus (plan) or a rule row.
const ownAvg = (o) => (o ? o.avg ?? o.avg_daily_sell ?? null : null);
const ownLead = (o) => (o ? o.lead ?? o.lead_time_days ?? null : null);

// Blank = null (inherit). undefined when the text is not a number >= 0.
function readNumber(input) {
  const v = input.value.trim();
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const planInputs = (prefix, avg, lead, placeholders) => `
    <div class="mt-3 grid grid-cols-2 gap-2">
      <div class="min-w-0">
        <label for="${prefix}-avg" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.avgSellLabel")}</label>
        <input id="${prefix}-avg" type="number" min="0" step="any" inputmode="decimal" value="${avg ?? ""}" placeholder="${escapeHtml(placeholders.avg)}" class="input-filled" />
      </div>
      <div class="min-w-0">
        <label for="${prefix}-lead" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.leadTimeLabel")}</label>
        <input id="${prefix}-lead" type="number" min="0" step="any" inputmode="decimal" value="${lead ?? ""}" placeholder="${escapeHtml(placeholders.lead)}" class="input-filled" />
      </div>
    </div>
    <p class="mt-1 text-[11px] leading-snug text-gray-500">${t("settings.avgAutoHint")}</p>`;

// One Type: the values typed apply to every SKU in it (each SKU's own value of
// that field is replaced). A field left blank is not changed.
function openTypePlanSheet(group, skus, body) {
  const r = ruleOf("type", group.typeId);
  const count = skus.filter((s) => s.active && s.type_id === group.typeId).length;
  openSheet(
    `
    <p class="text-xs text-gray-600">${escapeHtml(tf("settings.typeSetAllHint", { n: count }))}</p>
    ${planInputs("tp", r?.avg_daily_sell != null ? num(r.avg_daily_sell) : "", r?.lead_time_days != null ? num(r.lead_time_days) : "", { avg: t("replen.src.auto"), lead: num(plan.config.defaultLeadTimeDays) })}
    ${allBranchesBox("tp")}
    <button id="tp-save" class="btn-primary mt-4 w-full">${escapeHtml(tf("settings.typeApply", { n: count }))}</button>`,
    {
      title: `${t("settings.typeSetAll")} · ${escapeHtml(typeLabel(group.type))}`,
      onMount: (sheet) => {
        sheet.querySelector("#tp-save").addEventListener("click", async (e) => {
          const avg = readNumber(sheet.querySelector("#tp-avg"));
          const lead = readNumber(sheet.querySelector("#tp-lead"));
          if (avg === undefined || lead === undefined) return toast(t("err.BAD_RULE"), "error");
          if (avg === null && lead === null) return toast(t("replen.needValue"), "error");
          e.target.disabled = true;
          try {
            await api.bulkRule({ scope: "type", key: group.typeId, avgDailySell: avg, leadTimeDays: lead, ...branchTarget(sheet, "tp") });
          } catch (err) {
            e.target.disabled = false;
            throw err;
          }
          closeSheet();
          toast(t("replen.saved"), "success");
          renderSkuTab(body);
        });
      },
    }
  );
}

// Admin only: "apply to every branch" under the avg/day + lead time fields.
const allBranchesBox = (prefix) =>
  isAdmin(state.user)
    ? `<label class="mt-2 flex items-center gap-2 text-xs font-semibold text-gray-700"><input id="${prefix}-all-branches" type="checkbox" class="h-4 w-4" /> ${t("settings.applyAllBranches")}</label>`
    : "";
// Where a planning write goes: the branch shown, or every branch (admin box ticked).
const branchTarget = (sheet, prefix) => (sheet.querySelector(`#${prefix}-all-branches`)?.checked ? { allBranches: true } : { branchId: skuBranch() });

function openSkuForm(existing, activeTypes, activeWeights, allTypes, allWeights, body) {
  if (!activeTypes.length || !activeWeights.length) return toast(t("settings.needTypeAndWeight"), "error");
  // A staff / manager editing an existing SKU changes only their branch's numbers.
  const catalogueLocked = !!existing && !canEditCatalogue();
  const lock = catalogueLocked ? "disabled" : "";
  // Editing a SKU whose current Type/Weight was since deactivated: keep it
  // selectable so saving the name doesn't silently reassign it.
  const typeOptions = existing && existing.type_id && !activeTypes.some((ty) => ty.type_id === existing.type_id)
    ? [...activeTypes, allTypes.find((ty) => ty.type_id === existing.type_id)].filter(Boolean)
    : activeTypes;
  const weightOptions = existing && existing.weight_id && !activeWeights.some((w) => w.weight_id === existing.weight_id)
    ? [...activeWeights, allWeights.find((w) => w.weight_id === existing.weight_id)].filter(Boolean)
    : activeWeights;
  const own = existing ? existing.plan ?? ruleOf("sku", existing.sku_id) : null;
  // What a blank field falls back to, for the chosen Type.
  const placeholdersFor = (typeId) => {
    const tr = typeId ? ruleOf("type", typeId) : null;
    return {
      avg: tr?.avg_daily_sell != null ? num(tr.avg_daily_sell) : t("replen.src.auto"),
      lead: num(tr?.lead_time_days ?? plan.config.defaultLeadTimeDays),
    };
  };

  openSheet(
    `
    <label for="new-sku-name" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.skuNameLabel")}</label>
    <input id="new-sku-name" type="text" maxlength="120" lang="lo" ${lock} value="${existing ? escapeHtml(productName(existing.name_en, existing.name_lo)) : ""}" class="input-filled lao" />
    <p class="mt-1 text-[11px] text-gray-500">${t("settings.skuNameHint")}</p>
    <div class="mt-3 grid grid-cols-2 gap-2">
      <div class="min-w-0">
        <label for="new-sku-type" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.skuTypeLabel")}</label>
        <select id="new-sku-type" lang="lo" ${lock} class="input-filled">
          ${typeOptions.map((ty) => `<option value="${ty.type_id}" ${existing?.type_id === ty.type_id ? "selected" : ""}>${escapeHtml(typeLabel(ty))}</option>`).join("")}
        </select>
      </div>
      <div class="min-w-0">
        <label for="new-sku-weight" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.skuWeightLabel")}</label>
        <select id="new-sku-weight" lang="lo" ${lock} class="input-filled">
          ${weightOptions.map((w) => `<option value="${w.weight_id}" ${existing?.weight_id === w.weight_id ? "selected" : ""}>${escapeHtml(w.name_en || weightLabel(w.gram_value))}</option>`).join("")}
        </select>
      </div>
    </div>
    ${planInputs("new-sku", ownAvg(own) != null ? num(ownAvg(own)) : "", ownLead(own) != null ? num(ownLead(own)) : "", placeholdersFor(existing?.type_id ?? typeOptions[0]?.type_id))}
    <p class="mt-1.5 text-[11px] text-gray-500">${t("settings.planHint")}</p>
    ${allBranchesBox("new-sku")}
    ${
      existing && canEditCatalogue()
        ? `<label class="mt-3 flex items-center gap-2 text-xs font-semibold text-gray-700"><input id="new-sku-active" type="checkbox" class="h-4 w-4" ${existing.active ? "checked" : ""} /> ${t("settings.activeLabel")}</label>`
        : ""
    }
    <button id="save-sku" class="btn-primary mt-4 w-full">${t("settings.saveSku")}</button>
  `,
    {
      title: existing ? escapeHtml(skuLabel(existing)) : t("settings.addSku"),
      onMount: (sheetBody) => {
        const typeSel = sheetBody.querySelector("#new-sku-type");
        typeSel.addEventListener("change", () => {
          const ph = placeholdersFor(typeSel.value);
          sheetBody.querySelector("#new-sku-avg").placeholder = ph.avg;
          sheetBody.querySelector("#new-sku-lead").placeholder = ph.lead;
        });
        sheetBody.querySelector("#save-sku").addEventListener("click", async (e) => {
          const name = sheetBody.querySelector("#new-sku-name").value.trim();
          if (!name) return toast(t("stock.needSkuName"), "error");
          const avg = readNumber(sheetBody.querySelector("#new-sku-avg"));
          const lead = readNumber(sheetBody.querySelector("#new-sku-lead"));
          if (avg === undefined || lead === undefined) return toast(t("err.BAD_RULE"), "error");
          const planPart = { avg_daily_sell: avg, lead_time_days: lead, ...branchTarget(sheetBody, "new-sku") };
          const payload = catalogueLocked
            ? planPart
            : {
                name,
                type_id: typeSel.value,
                weight_id: sheetBody.querySelector("#new-sku-weight").value,
                ...planPart,
                ...(existing && sheetBody.querySelector("#new-sku-active") ? { active: sheetBody.querySelector("#new-sku-active").checked } : {}),
              };
          e.target.disabled = true;
          try {
            if (existing) await api.updateSku(existing.sku_id, payload);
            else await api.createSku(payload);
          } catch (err) {
            e.target.disabled = false;
            throw err;
          }
          closeSheet();
          toast(t("settings.saveSku"), "success");
          renderSkuTab(body);
        });
      },
    }
  );
}

// --- Excel import / export: every row is checked first (a preview), one bad
// row imports nothing; nothing is ever deleted. ---

function openImportSheet(body) {
  const admin = isAdmin(state.user);
  const startBranch = skuBranch();
  openSheet(
    `
    <p class="text-xs text-gray-600">${t("settings.importIntro")}</p>
    ${
      admin
        ? `<label for="xl-branch" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("settings.branchPick")}</label>
      <select id="xl-branch" lang="lo" class="input-filled text-xs">
        ${branchList().map((b) => `<option value="${escapeHtml(b.branch_id)}" ${b.branch_id === startBranch ? "selected" : ""}>${escapeHtml(productName(b.name_en, b.name_lo))}</option>`).join("")}
        <option value="all">${t("settings.importBranchAll")}</option>
      </select>`
        : ""
    }
    <div class="mt-3 grid grid-cols-2 gap-2">
      <button id="xl-export" class="btn-secondary py-2 text-xs">${t("settings.exportXlsx")}</button>
      <button id="xl-template" class="btn-secondary py-2 text-xs">${t("settings.importTemplate")}</button>
    </div>
    <label for="xl-file" class="mb-1.5 mt-4 block text-xs font-bold text-gray-600">${t("settings.importChoose")}</label>
    <input id="xl-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="input-filled text-xs" />
    <div id="xl-result" class="mt-3" role="status"></div>
    <button id="xl-submit" class="btn-primary mt-4 w-full" disabled>${t("settings.importConfirm")}</button>
  `,
    {
      title: t("settings.importExport"),
      onMount: (sheetBody) => {
        let rows = [];
        let fileName = "";
        const result = sheetBody.querySelector("#xl-result");
        const submit = sheetBody.querySelector("#xl-submit");
        const branchOf = () => (admin ? sheetBody.querySelector("#xl-branch").value : skuBranch());
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
        const showPreview = (p) => {
          const lines = [...new Set(p.ignored.map((x) => x.line))];
          const clearedLines = [...new Set((p.cleared ?? []).map((x) => x.line))];
          result.innerHTML = `
            <div class="rounded-xl bg-gray-50 px-3.5 py-2.5 text-xs font-semibold text-gray-700">
              ${escapeHtml(tf("settings.importPreview", { created: fmtInt(p.created), updated: fmtInt(p.updated), unchanged: fmtInt(p.unchanged) }))}
              ${lines.length ? `<div class="mt-1 text-warning">${escapeHtml(tf("settings.importIgnored", { lines: lines.slice(0, 30).join(", ") }))}</div>` : ""}
              ${clearedLines.length ? `<div class="mt-1 text-danger">${escapeHtml(tf("settings.importCleared", { n: fmtInt(p.cleared.length), lines: clearedLines.slice(0, 30).join(", ") }))}</div>` : ""}
            </div>`;
        };
        const reset = () => {
          rows = [];
          submit.disabled = true;
          result.innerHTML = "";
        };
        sheetBody.querySelector("#xl-branch")?.addEventListener("change", () => {
          reset();
          sheetBody.querySelector("#xl-file").value = "";
        });

        // Export = the branch's SKUs as they are now; template = the header row only.
        const download = async (withData, btn) => {
          btn.disabled = true;
          try {
            const branch = branchOf();
            const [XLSX, data] = await Promise.all([loadXlsx(), withData ? api.exportSkus(branch) : Promise.resolve({ rows: [] })]);
            const ws = XLSX.utils.aoa_to_sheet(exportRowsToSheet(data.rows, weightLabel));
            ws["!cols"] = [12, 30, 16, 14, 14, 14, 10, 14].map((wch) => ({ wch }));
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "SKU");
            const stamp = state.meta?.today ?? new Date().toISOString().slice(0, 10);
            XLSX.writeFile(wb, withData ? `kpv-sku-${branch}-${stamp}.xlsx` : "kpv-sku-template.xlsx");
          } finally {
            btn.disabled = false;
          }
        };
        sheetBody.querySelector("#xl-export").addEventListener("click", (e) => download(true, e.currentTarget));
        sheetBody.querySelector("#xl-template").addEventListener("click", (e) => download(false, e.currentTarget));

        // Reading a file previews it at once (dryRun); Confirm writes it.
        sheetBody.querySelector("#xl-file").addEventListener("change", async (e) => {
          reset();
          const file = e.target.files[0];
          if (!file) return;
          fileName = file.name;
          const XLSX = await loadXlsx();
          let aoa;
          let firstRow = 1;
          try {
            const wb = XLSX.read(await file.arrayBuffer());
            const ws = wb.Sheets[wb.SheetNames[0]];
            // Keep blank rows and note where the used range starts, so error lines match Excel's row numbers.
            firstRow = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]).s.r + 1 : 1;
            aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
          } catch {
            return showErrors([{ line: 1, error: t("settings.importUnreadable") }]);
          }
          const parsed = sheetRowsToImport(aoa, firstRow);
          if (parsed.error) return showErrors([{ line: 1, error: parsed.error }]);
          if (parsed.rows.length === 0) return showErrors([{ line: 1, error: t("err.EMPTY_IMPORT") }]);
          try {
            const preview = await api.importSkus({ branchId: branchOf(), fileName, rows: parsed.rows, dryRun: true });
            rows = parsed.rows;
            showPreview(preview);
            submit.disabled = false;
          } catch (err) {
            if (err.code === "IMPORT_INVALID") return showErrors(err.data.errors);
            throw err;
          }
        });

        submit.addEventListener("click", async () => {
          submit.disabled = true;
          try {
            const done = await api.importSkus({ branchId: branchOf(), fileName, rows, dryRun: false });
            closeSheet();
            toast(`${fmtInt(done.created + done.updated)} ${t("settings.importDone")}`, "success");
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
