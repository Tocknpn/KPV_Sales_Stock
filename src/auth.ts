// PIN hashing + stateless session tokens for staff login. Uses only Web
// Crypto (available natively in Workers) so no new dependency is needed
// beyond hono.
import type { Context, Next } from "hono";
import type { Env, SessionUser, StaffAccount, StaffRole } from "./types";
import { getStore } from "./store";
import { seedBlocked } from "./dataMode";
import { isLive } from "./time";

// The token-signing secret. A live deployment must set AUTH_SECRET; only the
// in-memory demo may fall back to a fixed development value.
export function authSecret(env: Env): string {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  if (isLive(env)) throw new Error("AUTH_SECRET is not set — refusing to sign or verify sessions");
  return "dev-insecure-secret";
}

export const MAX_FAILED_PINS = 5;
export const LOCK_MINUTES = 15;

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^[0-9]{4}$/.test(pin);
}

const PBKDF2_ITERATIONS = 100_000;

function toHex(buf: ArrayBuffer) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function pbkdf2(pin: string, salt: Uint8Array, iterations: number) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(bits);
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pin, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt.buffer as ArrayBuffer)}$${hash}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]);
  const expected = parts[3];
  const actual = await pbkdf2(pin, salt, iterations);
  if (actual.length !== expected.length) return false;
  // Constant-time-ish compare — short hex strings, not perf-sensitive here.
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function b64urlEncode(bytes: Uint8Array) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string) {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

interface TokenPayload {
  sub: string;
  role: StaffRole;
  branchId: string | null;
  displayName: string;
  tokenVersion: number;
  iat: number;
  exp: number;
}

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — shared branch tablet shouldn't force frequent re-login

async function hmac(data: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

export async function signToken(account: Pick<StaffAccount, "id" | "role" | "branch_id" | "display_name" | "token_version">, secret: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    sub: account.id,
    role: account.role,
    branchId: account.branch_id,
    displayName: account.display_name,
    tokenVersion: account.token_version,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export async function verifyToken(token: string, secret: string): Promise<TokenPayload | null> {
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expectedSig = await hmac(payloadB64, secret);
  if (expectedSig !== sig) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  } catch {
    return null;
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// Verifies the bearer token's signature/expiry, then checks the live account
// (active, token_version) so a PIN change or deactivation invalidates
// already-issued tokens without needing a session table.
export async function requireAuth(c: Context<{ Bindings: Env; Variables: { user: SessionUser } }>, next: Next) {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "Login required" }, 401);
  const payload = await verifyToken(token, authSecret(c.env));
  if (!payload) return c.json({ error: "Session expired, please log in again" }, 401);

  const store = getStore(c.env);
  const accounts = await store.staffAccounts();
  const account = accounts.find((a) => a.id === payload.sub);
  if (!account || !account.active || account.token_version !== payload.tokenVersion || seedBlocked(c.env, account)) {
    return c.json({ error: "Session expired, please log in again" }, 401);
  }

  c.set("user", {
    accountId: account.id,
    displayName: account.display_name,
    role: account.role,
    branchId: account.branch_id,
  });
  await next();
}

export async function requireAdmin(c: Context<{ Bindings: Env; Variables: { user: SessionUser } }>, next: Next) {
  const user = c.get("user");
  if (!user || user.role !== "admin") return c.json({ error: "Admin role required" }, 403);
  await next();
}

// Admin or branch manager. Managers are still limited to their own branch by
// assertBranchAccess / requireDesk in the route.
export async function requireManager(c: Context<{ Bindings: Env; Variables: { user: SessionUser } }>, next: Next) {
  const user = c.get("user");
  if (!user || (user.role !== "admin" && user.role !== "manager")) return c.json({ error: "Manager or admin role required", code: "ROLE_DENIED" }, 403);
  await next();
}

// True for a branch manager of exactly that branch.
export function isManagerOf(user: SessionUser, branchId: string): boolean {
  return user.role === "manager" && user.branchId !== null && user.branchId === branchId;
}

// Helper for routes that let staff act on their own branch (or any branch
// as admin): 403s on a branch mismatch rather than silently scoping.
export function assertBranchAccess(user: SessionUser, branchId: string) {
  if (user.role === "admin") return true;
  return user.branchId === branchId;
}
