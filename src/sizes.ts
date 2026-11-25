// A size is up to 4 "qty unit" parts (decided 2026-11-25): "4 ບາດ 2 ສະຫຼຶງ".
// Each unit's grams come from the admin's unit list (sku_unit); the size's
// gram_value is the sum and is what every calculation uses. Pure helpers, no
// store access, so they are unit-tested in node.
import type { SizePart, SkuUnit, SkuWeight } from "./types";

export const MAX_SIZE_PARTS = 4;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** "4 ບາດ 2 ສະຫຼຶງ". */
export const partsLabel = (parts: SizePart[]) => parts.map((p) => `${Number(p.qty)} ${p.unit}`).join(" ");

/** Grams of the parts with the units' grams; null when a unit is unknown. */
export function partsGrams(parts: SizePart[], units: SkuUnit[]): number | null {
  let total = 0;
  for (const p of parts) {
    const u = units.find((x) => x.unit === p.unit);
    if (!u) return null;
    total += Number(p.qty) * Number(u.gram_value);
  }
  return round4(total);
}

/** The parts of a size: its own, else its one qty + unit (sizes before migration 20). */
export function partsOf(w: Pick<SkuWeight, "parts" | "qty" | "unit">): SizePart[] {
  if (Array.isArray(w.parts) && w.parts.length > 0) return w.parts;
  return w.unit && Number(w.qty) > 0 ? [{ unit: w.unit, qty: Number(w.qty) }] : [];
}

/** Parts typed in the SKU form, checked and put biggest unit first; or an error text. */
export function readParts(input: unknown, units: SkuUnit[]): SizePart[] | string {
  if (!Array.isArray(input) || input.length === 0) return "Add at least one unit to the size";
  if (input.length > MAX_SIZE_PARTS) return `A size has at most ${MAX_SIZE_PARTS} units`;
  const parts: SizePart[] = [];
  for (const raw of input) {
    const unit = String((raw as SizePart)?.unit ?? "").trim();
    const qty = Number((raw as SizePart)?.qty);
    if (!units.some((u) => u.unit === unit)) return `Unknown unit: ${unit || "—"}`;
    if (!(qty > 0) || qty > 1_000_000) return "Enter an amount above 0 for every unit";
    if (parts.some((p) => p.unit === unit)) return "Use each unit once";
    parts.push({ unit, qty: round4(qty) });
  }
  const gramsOf = (unit: string) => Number(units.find((u) => u.unit === unit)!.gram_value);
  return parts.sort((a, b) => gramsOf(b.unit) - gramsOf(a.unit));
}
