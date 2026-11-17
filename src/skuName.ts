// A SKU's name is the product only ("ຄຳແທ່ງ"); its size is the SKU's weight
// and the app shows it beside the name (decided 2026-11-17). A trailing size
// typed into a name is dropped: "ຄຳແທ່ງ 1 ສະຫຼຶງ" / "Gold Bar 5 g" -> the product.
// skuLabel mirrors public/js/sku-groups.js skuLabel (keep the two in step).
const TRAILING_SIZE = /\s+[\d.,]+\s*(ບາດ|ສະຫຼຶງ|ສະຫລຶງ|ຫຸນ|ກຣາມ|ກລາມ|ກິໂລ|baht|salueng|hun|kg|g)\s*$/i;

export function stripWeight(name: string): string {
  const trimmed = name.trim();
  const base = trimmed.replace(TRAILING_SIZE, "").trim();
  return base || trimmed;
}

const GRAMS_PER_BAHT = 15.244;
const GRAMS_PER_HUN = GRAMS_PER_BAHT / 40;
const round2 = (n: number) => String(Math.round(n * 100) / 100);

function wholeHun(grams: number): number | null {
  const hun = grams / GRAMS_PER_HUN;
  const h = Math.round(hun);
  return h > 0 && Math.abs(hun - h) < 0.005 ? h : null;
}

/** Lao label of a size in grams: "1 ບາດ 2 ສະຫຼຶງ", "1 ກິໂລ", "82.57 ກລາມ". */
export function weightLabel(grams: number): string {
  if (!(grams > 0)) return "";
  const h = wholeHun(grams);
  if (h !== null) {
    const parts: [number, string][] = [
      [Math.floor(h / 40), "ບາດ"],
      [Math.floor((h % 40) / 10), "ສະຫຼຶງ"],
      [h % 10, "ຫຸນ"],
    ];
    return parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}`).join(" ");
  }
  if (grams >= 1000) return `${round2(grams / 1000)} ກິໂລ`;
  return `${round2(grams)} ກລາມ`;
}

type Sized = { name_en?: string | null; name_lo?: string | null; baht_weight?: number | null; std_gram_weight?: number | null };

// Baht weight first when it is a whole number of hun (the shop sheet counts
// 15 g a baht, so "5 Baht" is stored as 75 g), else the grams.
function gramsOf(sku: Sized): number {
  const bahtGrams = Number(sku.baht_weight ?? 0) * GRAMS_PER_BAHT;
  if (bahtGrams > 0 && wholeHun(bahtGrams) !== null) return bahtGrams;
  return Number(sku.std_gram_weight ?? 0);
}

/** A SKU on one line: "ຄຳແທ່ງ 1 ສະຫຼຶງ". */
export function skuLabel(sku: Sized): string {
  const name = (sku.name_lo || sku.name_en || "").trim();
  const size = weightLabel(gramsOf(sku));
  return size && !name.endsWith(size) ? `${name} ${size}`.trim() : name;
}
