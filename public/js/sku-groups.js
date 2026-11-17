// Pure helpers for showing SKUs grouped by type (SKU picker, Settings > SKU).
// No DOM here, so they are unit-tested in node.
import { productName } from "./i18n.js";

const nameOf = (s) => productName(s.name_en, s.name_lo) ?? "";

// [{ typeId, type, items }], groups in type sort_order (SKUs without a known
// type last, typeId null); items by weight sort_order, baht weight, then name.
// An inactive type still groups its SKUs.
export function groupSkusByType(skus, types, weights) {
  const typeById = new Map(types.map((ty, i) => [ty.type_id, { ty, order: ty.sort_order ?? i }]));
  const weightOrder = new Map(weights.map((w, i) => [w.weight_id, w.sort_order ?? i]));
  const groups = new Map();
  for (const s of skus) {
    const known = s.type_id && typeById.has(s.type_id);
    const key = known ? s.type_id : null;
    if (!groups.has(key)) groups.set(key, { typeId: key, type: known ? typeById.get(key).ty : null, items: [] });
    groups.get(key).items.push(s);
  }
  const order = (g) => (g.typeId === null ? Infinity : typeById.get(g.typeId).order);
  const sorted = [...groups.values()].sort((a, b) => order(a) - order(b));
  for (const g of sorted) {
    g.items.sort(
      (a, b) =>
        (weightOrder.get(a.weight_id) ?? 999) - (weightOrder.get(b.weight_id) ?? 999) ||
        (a.baht_weight ?? 0) - (b.baht_weight ?? 0) ||
        nameOf(a).localeCompare(nameOf(b))
    );
  }
  return sorted;
}

// Case-insensitive match on the Lao name, English name or SKU id.
export function filterSkus(skus, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return skus;
  return skus.filter((s) => [s.name_lo, s.name_en, s.sku_id].some((v) => String(v ?? "").toLowerCase().includes(q)));
}

// A new Set with skuId added or removed.
export function toggleSelection(selected, skuId) {
  const next = new Set(selected);
  if (next.has(skuId)) next.delete(skuId);
  else next.add(skuId);
  return next;
}

export function skuSizeLabel(sku) {
  if (sku.weight_name) return sku.weight_name;
  if (sku.baht_weight > 0) return `${sku.baht_weight} Baht`;
  return "";
}
