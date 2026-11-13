// Drives the real Hono app against a fresh in-memory demo store.
import app from "../src/index";
import { resetDemoStore, getStore } from "../src/store";
import { DEMO_ADMIN_ID, DEMO_MANAGER, DEMO_STAFF, DEMO_USERNAMES } from "../src/demoData";

export const TODAY = "2026-11-12";
export const YESTERDAY = "2026-11-11";
export const TOMORROW = "2026-11-13";

export interface Session {
  token: string;
  // The business date this session's requests run on.
  date: string;
}

export function freshApp() {
  resetDemoStore();
}

export async function call(session: Session | null, method: string, path: string, body?: unknown, date = session?.date ?? TODAY, env: Record<string, string> = {}) {
  const res = await app.request(
    `/api${path}`,
    {
      method,
      headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { DEMO_DATE: date, ...env }
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// Login body for an account id. Demo accounts use their fixed username (no
// store access, so the demo store is never built off the pinned date); an
// account created in the test is looked up in the already-built store.
export function creds(accountId: string, password: string) {
  const username =
    DEMO_USERNAMES[accountId] ??
    (getStore({ DEMO_DATE: TODAY } as any) as any).db.staffAccounts.find((a: any) => a.id === accountId)?.username ??
    `no-such-${accountId}`;
  return { username, password };
}

export async function login(accountId: string, password: string, date = TODAY): Promise<Session> {
  const res = await call(null, "POST", "/auth/login", creds(accountId, password), date);
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  return { token: res.json.token, date };
}

export const asAdmin = (date = TODAY) => login(DEMO_ADMIN_ID, "9999", date);
export const asStaff = (branch: keyof typeof DEMO_STAFF, date = TODAY) => login(DEMO_STAFF[branch], "1234", date);
export const asManager = (branch: keyof typeof DEMO_MANAGER = "B-MM", date = TODAY) => login(DEMO_MANAGER[branch], "5678", date);
export const on = (session: Session, date: string): Session => ({ ...session, date });

// Fills in every count (= calculated closing) so a desk day can be closed.
export async function countEverything(session: Session, deskId: string, date: string) {
  const detail = (await call(session, "GET", `/stock/desk/${deskId}?date=${date}`)).json;
  return call(session, "POST", `/stock/desk/${deskId}/entries`, {
    date,
    changes: detail.rows.map((r: any) => ({ sku_id: r.sku_id, field: "counted_qty", to: r.closing_qty })),
  });
}

export async function closeDay(session: Session, deskId: string, date: string) {
  await countEverything(session, deskId, date);
  return call(session, "POST", `/stock/desk/${deskId}/close`, { date });
}
