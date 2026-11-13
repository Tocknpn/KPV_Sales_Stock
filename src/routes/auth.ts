// Login, session and the public data the login screen needs.
import { newRouter, readBody, HttpError, storeFor } from "../app";
import { getStore } from "../store";
import { verifyPassword, normalizeUsername, signToken, requireAuth, authSecret, MAX_FAILED_LOGINS, LOCK_MINUTES } from "../auth";
import { businessDate, isLive } from "../time";
import { seedBlocked } from "../dataMode";

const r = newRouter();

// A valid hash of a random value, checked when the username is unknown.
const DUMMY_HASH = "pbkdf2$100000$5a567e950cc5658058c5526ca2b2c529$fac4cf2f3f6f3b526ee8768176df34c642cd6994746bf8f8d8a9620126781dfe";

// Public — branch names only (the app shell still reads them before login).
r.get("/branches", async (c) => {
  return c.json({ branches: await getStore(c.env).branches() });
});

// Names (never password hashes) of a branch's accounts, for the case handover
// picker. Logged-in users only: the login screen no longer lists anyone.
r.get("/auth/accounts", requireAuth, async (c) => {
  const branchId = c.req.query("branchId");
  const accounts = await getStore(c.env).staffAccounts();
  const filtered = accounts.filter((a) => a.active && !seedBlocked(c.env, a) && (branchId ? a.branch_id === branchId : a.branch_id === null));
  return c.json({ accounts: filtered.map((a) => ({ id: a.id, branch_id: a.branch_id, display_name: a.display_name, role: a.role })) });
});

// Username + password. A wrong username, a wrong password and a closed
// account all get the same answer, so the form never reveals who exists.
r.post("/auth/login", async (c) => {
  // Nobody is logged in yet: the only writes here (lockouts) are the system's.
  const store = getStore(c.env, { system: "login" });
  const body = await readBody(c);
  const username = normalizeUsername(body.username);
  const password = typeof body.password === "string" ? body.password : "";
  const wrong = () => new HttpError(401, "Wrong username or password", "WRONG_LOGIN");
  if (!username || !password) throw wrong();

  const account = (await store.staffAccounts()).find((a) => a.username === username);
  if (!account || !account.active) {
    await verifyPassword(password, DUMMY_HASH); // same work either way: no timing hint
    throw wrong();
  }
  if (seedBlocked(c.env, account)) throw new HttpError(403, "This is a test account and is disabled in production", "SEED_ACCOUNT_DISABLED");

  const now = new Date();
  if (account.locked_until && account.locked_until > now.toISOString()) {
    const minutes = Math.max(1, Math.ceil((new Date(account.locked_until).getTime() - now.getTime()) / 60000));
    throw new HttpError(423, `Too many wrong passwords. Try again in ${minutes} min.`, "ACCOUNT_LOCKED", { minutes });
  }

  const ok = await verifyPassword(password, account.pin_hash);
  if (!ok) {
    const attempts = account.failed_attempts + 1;
    if (attempts >= MAX_FAILED_LOGINS) {
      await store.updateStaffAccount(account.id, {
        failed_attempts: 0,
        locked_until: new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString(),
      });
      throw new HttpError(423, `Too many wrong passwords. Try again in ${LOCK_MINUTES} min.`, "ACCOUNT_LOCKED", { minutes: LOCK_MINUTES });
    }
    await store.updateStaffAccount(account.id, { failed_attempts: attempts });
    throw new HttpError(401, "Wrong username or password", "WRONG_LOGIN", { attemptsLeft: MAX_FAILED_LOGINS - attempts });
  }

  if (account.failed_attempts > 0 || account.locked_until) {
    await store.updateStaffAccount(account.id, { failed_attempts: 0, locked_until: null });
  }
  const token = await signToken(account, authSecret(c.env));
  return c.json({
    token,
    user: { accountId: account.id, displayName: account.display_name, role: account.role, branchId: account.branch_id },
  });
});

r.get("/auth/me", requireAuth, async (c) => c.json({ user: c.get("user") }));

r.post("/auth/logout", requireAuth, async (c) => c.json({ ok: true }));

r.get("/app-meta", requireAuth, async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const [branches, desks, config] = await Promise.all([store.branches(), store.desks(), store.config()]);
  const mine = <T extends { branch_id: string }>(rows: T[]) => (user.role !== "admin" ? rows.filter((x) => x.branch_id === user.branchId) : rows);
  return c.json({ branches: mine(branches), desks: mine(desks), config, today: businessDate(c.env), live: isLive(c.env), user });
});

export default r;
