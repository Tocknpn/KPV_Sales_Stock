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

// Case-insensitive match on the Lao name, English name, SKU id or name + size.
export function filterSkus(skus, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return skus;
  return skus.filter((s) => [s.name_lo, s.name_en, s.sku_id, skuLabel(s)].some((v) => String(v ?? "").toLowerCase().includes(q)));
}

// A new Set with skuId added or removed.
export function toggleSelection(selected, skuId) {
  const next = new Set(selected);
  if (next.has(skuId)) next.delete(skuId);
  else next.add(skuId);
  return next;
}

// Sizes in the Lao units staff use (decided 2026-11-17, every label in Lao):
//   ບາດ = 15.244 g, ສະຫຼຶງ = 1/4 ບາດ, ຫຸນ = 1/40 ບາດ (as in the SKU data:
//   "1 ຫຸນ" = 0.025 baht), ກລາມ for gram sizes, ກິໂລ from 1000 g up.
export const GRAMS_PER_BAHT = 15.244;
const GRAMS_PER_HUN = GRAMS_PER_BAHT / 40;
const round2 = (n) => String(Math.round(n * 100) / 100);
const round3 = (n) => Math.round(n * 1000) / 1000;

// The units of the Weight form, biggest first.
export const WEIGHT_UNITS = [
  { unit: "ກິໂລ", grams: 1000 },
  { unit: "ບາດ", grams: GRAMS_PER_BAHT },
  { unit: "ສະຫຼຶງ", grams: GRAMS_PER_BAHT / 4 },
  { unit: "ຫຸນ", grams: GRAMS_PER_HUN },
  { unit: "ກລາມ", grams: 1 },
];

// Grams stored with 3 decimals: a whole number of hun within rounding.
function wholeHun(grams) {
  const hun = grams / GRAMS_PER_HUN;
  const h = Math.round(hun);
  return h > 0 && Math.abs(hun - h) < 0.005 ? h : null;
}

/** Lao label of a size in grams: "1 ບາດ 2 ສະຫຼຶງ", "1 ກິໂລ", "82.57 ກລາມ". */
export function weightLabel(grams) {
  const g = Number(grams);
  if (!(g > 0)) return "";
  const h = wholeHun(g);
  if (h !== null) {
    const parts = [
      [Math.floor(h / 40), "ບາດ"],
      [Math.floor((h % 40) / 10), "ສະຫຼຶງ"],
      [h % 10, "ຫຸນ"],
    ];
    return parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}`).join(" ");
  }
  if (g >= 1000) return `${round2(g / 1000)} ກິໂລ`;
  return `${round2(g)} ກລາມ`;
}

/** The Weight form's amount + unit for a size in grams (the reverse of gramsOf). */
export function splitWeight(grams) {
  const g = Number(grams);
  if (!(g > 0)) return { amount: "", unit: "ບາດ" };
  const h = wholeHun(g);
  if (h !== null) {
    if (h % 40 === 0) return { amount: String(h / 40), unit: "ບາດ" };
    if (h % 10 === 0) return { amount: String(h / 10), unit: "ສະຫຼຶງ" };
    return { amount: String(h), unit: "ຫຸນ" };
  }
  if (g >= 1000) return { amount: round2(g / 1000), unit: "ກິໂລ" };
  return { amount: round2(g), unit: "ກລາມ" };
}

/** Grams of an amount in a Lao unit; 0 when not a number above 0. */
export function gramsOf(amount, unit) {
  const n = Number(amount);
  const u = WEIGHT_UNITS.find((x) => x.unit === unit);
  return u && Number.isFinite(n) && n > 0 ? round3(n * u.grams) : 0;
}

// Grams of a SKU: its Baht weight when that is a whole number of hun (the shop
// sheet counts 15 g a baht, so "5 Baht" is stored as 75 g), else its size's
// grams, else a gram size name ("1g", "1kg"), else its Baht weight, else a Baht
// size name ("0.25 Baht").
function skuGrams(sku) {
  const bahtGrams = Number(sku.baht_weight) * GRAMS_PER_BAHT;
  if (bahtGrams > 0 && wholeHun(bahtGrams) !== null) return bahtGrams;
  if (sku.std_gram_weight > 0) return Number(sku.std_gram_weight);
  if (sku.gram_weight_each > 0) return Number(sku.gram_weight_each);
  const name = String(sku.weight_name ?? "").trim();
  const gram = /^([\d.]+)\s*(kg|g)$/i.exec(name);
  if (gram) return Number(gram[1]) * (gram[2].toLowerCase() === "kg" ? 1000 : 1);
  if (sku.baht_weight > 0) return Number(sku.baht_weight) * GRAMS_PER_BAHT;
  const baht = /^([\d.]+)\s*baht$/i.exec(name);
  return baht ? Number(baht[1]) * GRAMS_PER_BAHT : 0;
}

// Size labels as the admin named them ("8 ບາດ" = 120 g, migration 18), by
// size id and by grams. Filled from /app-meta and again whenever Settings
// reloads the sizes. A SKU whose size is unknown falls back to weightLabel.
const sizeById = new Map();
const sizeByGrams = new Map();
const gramKey = (g) => (Number(g) > 0 ? Math.round(Number(g) * 1000) : null);

export function setSizeLabels(weights) {
  sizeById.clear();
  sizeByGrams.clear();
  for (const w of weights ?? []) {
    if (!w?.name_en) continue;
    sizeById.set(w.weight_id, w.name_en);
    const k = gramKey(w.gram_value);
    if (k !== null && !sizeByGrams.has(k)) sizeByGrams.set(k, w.name_en);
  }
}

export function skuSizeLabel(sku) {
  if (sku?.weight_id && sizeById.has(sku.weight_id)) return sizeById.get(sku.weight_id);
  for (const g of [sku?.std_gram_weight, sku?.gram_weight_each]) {
    const k = gramKey(g);
    if (k !== null && sizeByGrams.has(k)) return sizeByGrams.get(k);
  }
  return weightLabel(skuGrams(sku));
}

/** A SKU on one line: the product name and its size, "ຄຳແທ່ງ 1 ສະຫຼຶງ". A
 *  name is the product only (2026-11-17); one that still ends in the size is
 *  not given it twice. */
export function skuLabel(sku) {
  const name = nameOf(sku);
  const size = skuSizeLabel(sku);
  return size && !name.endsWith(size) ? `${name} ${size}`.trim() : name;
}
