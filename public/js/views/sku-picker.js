// SKU picker: SKUs grouped by type in a 3-column grid, several picked at once.
// Used by "Create case" and a case's "Add SKU". Only SKUs the case's branch
// carries are offered; anyone may create a brand-new SKU from here (it is then
// carried by that branch).
import { api } from "../api.js";
import { state } from "../state.js";
import { toast } from "../ui.js";
import { icon, escapeHtml, fmtInt } from "../util.js";
import { t, tf, productName } from "../i18n.js";
import { groupSkusByType, filterSkus, toggleSelection, skuSizeLabel, skuLabel, weightLabel } from "../sku-groups.js";
import { skeletonGrid } from "../skeleton.js";

const typeLabel = (type) => (type ? productName(type.name_en, type.name_lo) : "—");
const CHECK = `<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`;

// onAdd(skus, { types, weights }) gets the picked SKUs (full objects, grid
// order) and the type/weight lists it loaded; onCancel() is "Back".
// SKUs already on the case (excludeSkuIds) show greyed out as "In case".
// allowCreate: false hides "New SKU" (reorder proposals only pick existing ones).
export async function renderSkuPickerInto(container, { excludeSkuIds = [], onAdd, onCancel, branchId, allowCreate = true }) {
  container.innerHTML = skeletonGrid();
  const branch = branchId || state.user?.branchId || state.stock.branch || undefined;
  const [{ skus }, { types }, { weights }] = await Promise.all([api.skus({ branchId: branch }), api.skuTypes(), api.skuWeights()]);
  const inCase = new Set(excludeSkuIds);
  const canCreate = allowCreate && !!state.user;
  let all = skus.filter((s) => s.carried !== false);
  let selected = new Set();
  let query = "";
  let observer = null;
  let chipLockUntil = 0; // after a chip tap, scrolling does not move the highlight
  let head, body, chips;

  const card = (s) => {
    const taken = inCase.has(s.sku_id);
    const on = selected.has(s.sku_id);
    const size = skuSizeLabel(s);
    const look = taken ? "border-hairline bg-gray-50 opacity-60" : on ? "border-brand-600 bg-brand-50" : "border-hairline bg-white active:bg-gray-50";
    return `
      <button type="button" data-pick-sku="${escapeHtml(s.sku_id)}" aria-pressed="${on}" ${taken ? "disabled" : ""}
        class="focus-ring relative flex flex-col items-start rounded-xl border-2 p-2 text-left ${look}" style="min-height:84px">
        <span class="mb-1 flex h-6 w-6 items-center justify-center rounded-md bg-brand-50 text-brand-600">${icon(s.icon, "h-3.5 w-3.5")}</span>
        <span lang="lo" class="lao line-clamp-3 break-words pr-3 text-xs font-bold leading-snug text-gray-900">${escapeHtml(productName(s.name_en, s.name_lo))}</span>
        ${size ? `<span class="mt-0.5 text-[10px] text-gray-500">${escapeHtml(size)}</span>` : ""}
        ${taken ? `<span class="mt-1 rounded-full bg-gray-200 px-1.5 py-0.5 text-[9px] font-bold text-gray-600">${t("picker.inCase")}</span>` : ""}
        ${on ? `<span class="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white">${CHECK}</span>` : ""}
      </button>`;
  };

  const paintFooter = () => {
    const n = selected.size;
    const add = container.querySelector("#pick-add");
    add.disabled = n === 0;
    add.textContent = n ? tf("picker.addN", { n: fmtInt(n) }) : t("picker.selectSome");
    container.querySelector("#pick-clear").classList.toggle("hidden", n === 0);
  };

  const setActiveChip = (key) => {
    chips.querySelectorAll("[data-chip]").forEach((c) => {
      const on = c.dataset.chip === key;
      c.setAttribute("aria-current", on ? "true" : "false");
      c.classList.toggle("bg-brand-600", on);
      c.classList.toggle("border-brand-600", on);
      c.classList.toggle("text-white", on);
      c.classList.toggle("bg-white", !on);
      c.classList.toggle("text-gray-700", !on);
      if (on) chips.scrollTo({ left: c.offsetLeft - chips.clientWidth / 2 + c.clientWidth / 2, behavior: "smooth" });
    });
  };

  const renderGroups = () => {
    const groups = groupSkusByType(filterSkus(all, query), types, weights);
    observer?.disconnect();
    chips.innerHTML = groups
      .map(
        (g) =>
          `<button type="button" data-chip="${g.typeId ?? "none"}" class="shrink-0 whitespace-nowrap rounded-full border border-hairline bg-white px-3 py-1.5 text-[11px] font-bold text-gray-700"><span lang="lo" class="lao">${escapeHtml(
            typeLabel(g.type)
          )}</span> · ${g.items.length}</button>`
      )
      .join("");
    body.innerHTML = groups.length
      ? groups
          .map(
            (g) => `
        <section data-section="${g.typeId ?? "none"}" class="mb-4" style="scroll-margin-top:${head.offsetHeight}px">
          <h3 class="mb-1.5 px-0.5 text-[11px] font-extrabold uppercase tracking-wide text-gray-500"><span lang="lo" class="lao">${escapeHtml(typeLabel(g.type))}</span> · ${g.items.length}</h3>
          <div class="grid grid-cols-3 gap-2">${g.items.map(card).join("")}</div>
        </section>`
          )
          .join("")
      : `<div class="py-8 text-center text-xs text-gray-500">${all.length || canCreate ? "—" : t("stock.askAdminForSku")}</div>`;

    // The section nearest the top of the sheet marks its chip.
    if (groups.length && "IntersectionObserver" in window) {
      observer = new IntersectionObserver(
        (entries) => {
          const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
          if (top && Date.now() > chipLockUntil) setActiveChip(top.target.dataset.section);
        },
        { root: container.closest("#sheet-body"), rootMargin: `-${head.offsetHeight}px 0px -60% 0px` }
      );
      body.querySelectorAll("[data-section]").forEach((sec) => observer.observe(sec));
    }
    if (groups.length) setActiveChip(groups[0].typeId ?? "none");
    paintFooter();
  };

  const mount = () => {
    container.innerHTML = `
      <div id="pick-head" class="sticky -top-4 z-10 -mx-5 -mt-4 bg-white px-5 pt-4 pb-2">
        <div class="mb-2 flex items-center justify-between">
          <button id="sku-back" class="tap-target -ml-2 px-2 text-left text-xs font-bold text-gray-500">&larr; ${t("login.back")}</button>
          ${canCreate ? `<button id="create-new-sku" class="tap-target px-2 text-xs font-bold text-brand-700">${t("picker.newSku")}</button>` : ""}
        </div>
        <input id="pick-search" type="search" value="${escapeHtml(query)}" placeholder="${t("picker.searchPlaceholder")}" class="input-filled py-2 text-sm" />
        <div id="pick-chips" class="no-scrollbar -mx-5 mt-2 flex gap-1.5 overflow-x-auto px-5"></div>
      </div>
      <div id="pick-body" class="pt-1"></div>
      <div class="sticky -bottom-4 z-10 -mx-5 -mb-4 flex items-center gap-2 border-t border-hairline bg-white px-5 py-3">
        <button id="pick-clear" class="tap-target hidden px-2 text-xs font-bold text-gray-500">${t("picker.clear")}</button>
        <button id="pick-add" class="btn-primary flex-1" disabled></button>
      </div>`;
    head = container.querySelector("#pick-head");
    body = container.querySelector("#pick-body");
    chips = container.querySelector("#pick-chips");

    container.querySelector("#sku-back").addEventListener("click", () => {
      observer?.disconnect();
      onCancel();
    });
    container.querySelector("#pick-search").addEventListener("input", (e) => {
      query = e.target.value;
      renderGroups();
    });
    container.querySelector("#pick-clear").addEventListener("click", () => {
      selected = new Set();
      renderGroups();
    });
    container.querySelector("#pick-add").addEventListener("click", () => {
      if (!selected.size) return;
      observer?.disconnect();
      const ordered = groupSkusByType(all, types, weights).flatMap((g) => g.items);
      onAdd(ordered.filter((s) => selected.has(s.sku_id)), { types, weights });
    });
    chips.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-chip]");
      if (!chip) return;
      chipLockUntil = Date.now() + 1000;
      body.querySelector(`[data-section="${chip.dataset.chip}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      setActiveChip(chip.dataset.chip);
    });
    body.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pick-sku]");
      if (!btn || btn.disabled) return;
      const id = btn.dataset.pickSku;
      selected = toggleSelection(selected, id);
      btn.outerHTML = card(all.find((s) => s.sku_id === id));
      body.querySelector(`[data-pick-sku="${CSS.escape(id)}"]`)?.focus();
      paintFooter();
    });
    container.querySelector("#create-new-sku")?.addEventListener("click", () => {
      observer?.disconnect();
      renderCreateSkuFormInto(
        container,
        (sku) => {
          all = [...all, sku];
          selected = toggleSelection(selected, sku.sku_id);
          query = "";
          mount();
        },
        mount,
        branch
      );
    });
    renderGroups();
  };

  mount();
}

// Opening-balance rows grouped by type: [{ sku, qty }] -> HTML. Each row has
// data-opening-row="<sku_id>" and an input data-opening-input; with
// removable, a data-remove-row button.
export function openingRowsHtml(entries, types, weights, { removable = false, qtyLabel = t("stock.openingQtyLabel") } = {}) {
  const qtyOf = new Map(entries.map((e) => [e.sku.sku_id, e.qty]));
  return groupSkusByType(
    entries.map((e) => e.sku),
    types,
    weights
  )
    .map(
      (g) => `
      <div class="mb-2">
        <div class="mb-1 px-0.5 text-[10px] font-extrabold uppercase tracking-wide text-gray-500"><span lang="lo" class="lao">${escapeHtml(typeLabel(g.type))}</span> · ${g.items.length}</div>
        <div class="card divide-y divide-hairline p-0">
          ${g.items
            .map((s) => {
              const size = skuSizeLabel(s);
              return `
            <div class="flex items-center gap-2 px-2.5 py-2" data-opening-row="${escapeHtml(s.sku_id)}">
              <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">${icon(s.icon, "h-3.5 w-3.5")}</span>
              <span class="min-w-0 flex-1">
                <span lang="lo" class="lao block break-words text-xs font-bold leading-snug text-gray-900">${escapeHtml(productName(s.name_en, s.name_lo))}</span>
                ${size ? `<span class="block text-[10px] text-gray-500">${escapeHtml(size)}</span>` : ""}
              </span>
              <input data-opening-input type="number" min="0" step="1" inputmode="numeric" enterkeyhint="next" value="${qtyOf.get(s.sku_id) ?? 0}"
                aria-label="${escapeHtml(skuLabel(s))} — ${escapeHtml(qtyLabel)}" class="w-16 shrink-0 rounded-lg border border-hairline py-1.5 text-center text-sm font-bold" />
              ${removable ? `<button data-remove-row aria-label="${t("documents.delete")}" class="tap-target shrink-0 text-gray-400 hover:text-danger">×</button>` : ""}
            </div>`;
            })
            .join("")}
        </div>
      </div>`
    )
    .join("");
}

// Wires opening inputs: whole numbers 0+, Enter moves to the next one.
// onChange(skuId, qty) on every edit.
export function bindOpeningInputs(root, onChange) {
  const inputs = [...root.querySelectorAll("[data-opening-input]")];
  inputs.forEach((input, i) => {
    input.addEventListener("focus", () => setTimeout(() => input.select?.(), 0));
    input.addEventListener("input", () => {
      onChange(input.closest("[data-opening-row]").dataset.openingRow, Math.max(0, Math.floor(Number(input.value) || 0)));
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (inputs[i + 1]) inputs[i + 1].focus();
      else input.blur();
    });
  });
}

// branch: the case's branch; the new SKU is carried there.
async function renderCreateSkuFormInto(container, onCreated, onCancel, branch) {
  container.innerHTML = skeletonGrid(3);
  const [{ types }, { weights }] = await Promise.all([api.skuTypes(), api.skuWeights()]);
  const activeTypes = types.filter((ty) => ty.active);
  const activeWeights = weights.filter((w) => w.active);
  container.innerHTML = `
    <button id="sku-back" class="mb-2 text-xs font-bold text-gray-500">&larr; ${t("login.back")}</button>
    <label for="sku-name" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.skuNameLabel")}</label>
    <input id="sku-name" type="text" maxlength="120" lang="lo" class="input-filled lao" />
    <p class="mt-1 text-[11px] text-gray-500">${t("settings.skuNameHint")}</p>
    <div class="mt-3 grid grid-cols-2 gap-2">
      <div class="min-w-0">
        <label for="sku-type" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.skuTypeLabel")}</label>
        <select id="sku-type" lang="lo" class="input-filled">
          ${activeTypes.map((ty) => `<option value="${ty.type_id}">${escapeHtml(productName(ty.name_en, ty.name_lo))}</option>`).join("")}
        </select>
      </div>
      <div class="min-w-0">
        <label for="sku-weight" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.skuWeightLabel")}</label>
        <select id="sku-weight" lang="lo" class="input-filled">
          ${activeWeights.map((w) => `<option value="${w.weight_id}">${escapeHtml(w.name_en || weightLabel(w.gram_value))}</option>`).join("")}
        </select>
      </div>
    </div>
    <button id="create-sku-submit" class="btn-primary mt-4 w-full">${t("stock.createNewSku")}</button>
  `;
  container.querySelector("#sku-back").addEventListener("click", onCancel);
  container.querySelector("#create-sku-submit").addEventListener("click", async () => {
    const name = container.querySelector("#sku-name").value.trim();
    if (!name) return toast(t("stock.needSkuName"), "error");
    if (!activeTypes.length || !activeWeights.length) return toast(t("settings.needTypeAndWeight"), "error");
    const sku = await api.createSku({
      name,
      type_id: container.querySelector("#sku-type").value,
      weight_id: container.querySelector("#sku-weight").value,
      branchId: branch,
    });
    onCreated(sku);
  });
}
