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

// Size in the Lao units staff use: ບາດ, ສະລຶງ (1/4 baht), ຫຸນ (1/40 baht, as in
// the SKU data: "1 ຫຸນ" = 0.025 baht), or ກລາມ for gram sizes and for weights
// that are not a whole number of hun.
const GRAMS_PER_BAHT = 15.244;
const round2 = (n) => String(Math.round(n * 100) / 100);

export function skuSizeLabel(sku) {
  const name = String(sku.weight_name ?? "").trim();
  const gram = /^([\d.]+)\s*(kg|g)$/i.exec(name);
  if (gram) return `${round2(Number(gram[1]) * (gram[2].toLowerCase() === "kg" ? 1000 : 1))} ກລາມ`;

  const fromName = /^([\d.]+)\s*baht$/i.exec(name);
  const baht = sku.baht_weight > 0 ? Number(sku.baht_weight) : fromName ? Number(fromName[1]) : 0;
  if (!(baht > 0)) return "";

  const hunTotal = baht / 0.025;
  if (Math.abs(hunTotal - Math.round(hunTotal)) < 1e-6) {
    const h = Math.round(hunTotal);
    const parts = [
      [Math.floor(h / 40), "ບາດ"],
      [Math.floor((h % 40) / 10), "ສະລຶງ"],
      [h % 10, "ຫຸນ"],
    ];
    return parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}`).join(" ");
  }
  const grams = sku.std_gram_weight > 0 ? Number(sku.std_gram_weight) : baht * GRAMS_PER_BAHT;
  return `${round2(grams)} ກລາມ`;
}
