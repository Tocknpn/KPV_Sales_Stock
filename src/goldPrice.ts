// Gold price used to value stock. The owner's job keeps gold_prices fresh; when
// there is no usable row the admin's manual price in system_config is used.
import type { GoldPriceRow, GoldPriceSnapshot, SystemConfig } from "./types";
import { addDays, laosDate } from "./time";

export interface ResolvedPrice {
  lakPerBaht: number;
  source: "gold_prices" | "manual";
  asOf: string | null;
  stale: boolean;
}

export function resolveGoldPrice(row: GoldPriceRow | null, config: Pick<SystemConfig, "spot_lak_per_baht">, today: string): ResolvedPrice {
  const sell = Number(row?.price_baht_sell);
  if (!row || !Number.isFinite(sell) || sell <= 0) {
    return { lakPerBaht: config.spot_lak_per_baht ?? 0, source: "manual", asOf: null, stale: false };
  }
  const updated = row.updated_at ? new Date(row.updated_at) : null;
  const valid = updated !== null && !Number.isNaN(updated.getTime());
  const stale = valid ? laosDate(updated) < addDays(today, -1) : false;
  return { lakPerBaht: sell, source: "gold_prices", asOf: row.updated_at, stale };
}

// Sell price in force on `date`: the latest snapshot on or before it. A date
// before the first snapshot uses the earliest one; no snapshots uses `fallback`.
export function priceOn(date: string, snapshots: GoldPriceSnapshot[], fallback: number): number {
  if (snapshots.length === 0) return fallback;
  const sorted = [...snapshots].sort((a, b) => a.price_date.localeCompare(b.price_date));
  let pick = sorted[0];
  for (const s of sorted) {
    if (s.price_date <= date) pick = s;
    else break;
  }
  return Number(pick.price_baht_sell);
}
