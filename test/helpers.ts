// Drives the real Hono app against a fresh in-memory demo store.
import app from "../src/index";
import { resetDemoStore } from "../src/store";
import { DEMO_ADMIN_ID, DEMO_STAFF } from "../src/demoData";

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

export async function call(session: Session | null, method: string, path: string, body?: unknown, date = session?.date ?? TODAY) {
  const res = await app.request(
    `/api${path}`,
    {
      method,
      headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { DEMO_DATE: date }
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

export async function login(accountId: string, pin: string, date = TODAY): Promise<Session> {
  const res = await call(null, "POST", "/auth/login", { accountId, pin }, date);
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
  return { token: res.json.token, date };
}

export const asAdmin = (date = TODAY) => login(DEMO_ADMIN_ID, "9999", date);
export const asStaff = (branch: keyof typeof DEMO_STAFF, date = TODAY) => login(DEMO_STAFF[branch], "1234", date);
export const on = (session: Session, date: string): Session => ({ ...session, date });

// Fills in every count (= calculated closing) so a desk day can be closed.
export async function countEverything(session: Session, deskId: string, date: string) {
  const detail = (await call(session, "GET", `/stock/desk/${deskId}?date=${date}`)).json;
  return call(session, "POST", `/stock/desk/${deskId}/entries`, {
    date,
    rows: detail.rows.map((r: any) => ({ sku_id: r.sku_id, counted_qty: r.closing_qty })),
  });
}

export async function closeDay(session: Session, deskId: string, date: string) {
  const detail = (await call(session, "GET", `/stock/desk/${deskId}?date=${date}`)).json;
  if (detail.status === "check_in") {
    const step = await call(session, "POST", `/stock/desk/${deskId}/transition`, { date, toStatus: "final_stock" });
    if (step.status !== 200) throw new Error(`final_stock failed: ${step.text}`);
  }
  await countEverything(session, deskId, date);
  return call(session, "POST", `/stock/desk/${deskId}/transition`, { date, toStatus: "done" });
}
