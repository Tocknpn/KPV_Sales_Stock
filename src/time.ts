// Business-date helpers. KPV operates in Laos (UTC+7, no daylight saving), so
// "today" is the Laos calendar date — never the Worker's UTC date.
import type { Env } from "./types";

const LAOS_OFFSET_MS = 7 * 60 * 60 * 1000;

export function isLive(env: Env): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export function laosDate(now: Date = new Date()): string {
  return new Date(now.getTime() + LAOS_OFFSET_MS).toISOString().slice(0, 10);
}

// DEMO_DATE only pins the date for the in-memory demo store and tests. A live
// (Supabase) deployment always uses the real Laos date.
export function businessDate(env: Env): string {
  if (!isLive(env) && env.DEMO_DATE) return env.DEMO_DATE;
  return laosDate();
}

export function isValidDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isValidMonth(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function datesInMonth(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

// Real first/last day of a "YYYY-MM" month (never "-31" for a 30-day month).
export function monthRange(month: string): { from: string; to: string } {
  const dates = datesInMonth(month);
  return { from: dates[0], to: dates[dates.length - 1] };
}
