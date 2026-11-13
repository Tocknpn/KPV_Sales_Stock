// Which kind of data this deployment holds: "test" (Supabase with mock data),
// "production" (Supabase, real data) or "demo" (no Supabase, in-memory data).
import type { Env, StaffAccount } from "./types";
import { isLive } from "./time";

export type DataMode = "test" | "production" | "demo";

export function dataMode(env: Env): DataMode {
  if (env.KPV_DATA_MODE === "test" || env.KPV_DATA_MODE === "production") return env.KPV_DATA_MODE;
  return isLive(env) ? "production" : "demo";
}

// Production never lets a seed (mock-data) account sign in or keep a session.
export const seedBlocked = (env: Env, account: Pick<StaffAccount, "is_seed">): boolean => dataMode(env) === "production" && account.is_seed === true;
