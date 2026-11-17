import { describe, it, expect } from "vitest";
import { resolveGoldPrice, priceOn } from "../src/goldPrice";
import { valueLak } from "../src/logic";

const config = { spot_lak_per_baht: 32500000 };
const row = { price_baht_sell: 43230000, price_baht_buy: 42000000, updated_at: "2026-11-16T02:00:04Z", price_updated_at: null };

describe("resolveGoldPrice", () => {
  it("falls back to the manual config price when there is no row", () => {
    expect(resolveGoldPrice(null, config, "2026-11-16")).toEqual({ lakPerBaht: 32500000, source: "manual", asOf: null, stale: false });
  });
  it("uses the gold_prices sell price and is fresh on the same day", () => {
    const r = resolveGoldPrice(row, config, "2026-11-16");
    expect(r).toMatchObject({ lakPerBaht: 43230000, source: "gold_prices", stale: false, asOf: "2026-11-16T02:00:04Z" });
  });
  it("yesterday is not stale, two days old is", () => {
    expect(resolveGoldPrice(row, config, "2026-11-17").stale).toBe(false);
    expect(resolveGoldPrice(row, config, "2026-11-18").stale).toBe(true);
  });
  it("uses the Laos date of updated_at", () => {
    // 20:00Z on the 15th is already the 16th in Laos
    const late = { ...row, updated_at: "2026-11-15T20:00:00Z" };
    expect(resolveGoldPrice(late, config, "2026-11-17").stale).toBe(false);
    expect(resolveGoldPrice(late, config, "2026-11-18").stale).toBe(true);
  });
  it("falls back to manual when the sell price is not positive", () => {
    expect(resolveGoldPrice({ ...row, price_baht_sell: 0 }, config, "2026-11-16").source).toBe("manual");
  });
});

describe("priceOn", () => {
  const snaps = [
    { price_date: "2026-11-12", price_baht_sell: 1 },
    { price_date: "2026-11-15", price_baht_sell: 2 },
  ];
  it("picks the latest snapshot on or before the date, earliest before any", () => {
    expect(priceOn("2026-11-10", snaps, 9)).toBe(1);
    expect(priceOn("2026-11-14", snaps, 9)).toBe(1);
    expect(priceOn("2026-11-15", snaps, 9)).toBe(2);
    expect(priceOn("2026-11-20", snaps, 9)).toBe(2);
    expect(priceOn("2026-11-20", [], 9)).toBe(9);
  });
});

describe("valueLak with a resolved price", () => {
  it("values gold at baht weight x price", () => {
    expect(valueLak({ baht_weight: 0.5 }, 2, 43230000)).toBe(43230000);
  });
});
