import type { Env } from "./types";

/**
 * Keeps the Supabase project awake. Supabase pauses a free project after 7
 * days with no activity; the cron in wrangler.jsonc calls this every 3 days
 * and it writes one row (table `heartbeat`, migration 22).
 */
export async function beat(env: Env, source = "cron"): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("[heartbeat] no Supabase configured; skipped");
    return;
  }
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/heartbeat_beat`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_source: source }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`[heartbeat] ${res.status} ${text}`);
  console.log(`[heartbeat] ok ${text}`);
}
