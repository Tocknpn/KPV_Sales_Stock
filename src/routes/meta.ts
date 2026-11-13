// Public: which data mode this deployment runs in, so the app can show a banner.
// seedRows (how many mock rows are still loaded) is only revealed to an admin.
import { newRouter } from "../app";
import { getStore } from "../store";
import { authSecret, verifyToken } from "../auth";
import { dataMode } from "../dataMode";

const r = newRouter();

r.get("/meta", async (c) => {
  const body = { dataMode: dataMode(c.env), seedRows: 0 };
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token ? await verifyToken(token, authSecret(c.env)) : null;
  if (!payload) return c.json(body);
  const store = getStore(c.env);
  const account = (await store.staffAccounts()).find((a) => a.id === payload.sub);
  if (account && account.active && account.token_version === payload.tokenVersion && account.role === "admin") {
    body.seedRows = (await store.seedCounts()).reduce((sum, row) => sum + Number(row.seed_rows), 0);
  }
  return c.json(body);
});

export default r;
