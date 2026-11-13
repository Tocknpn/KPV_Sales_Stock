// Persisted login session — a shared branch tablet shouldn't force re-login
// on every reload, so the token lives in localStorage until logout or the
// server rejects it (expired, PIN changed, account deactivated).
const TOKEN_KEY = "kpv_session_token";
const USER_KEY = "kpv_session_user";

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getCachedUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSession(token, user) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {}
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {}
}

export function isAdmin(user) {
  return user?.role === "admin";
}

// Admin or branch manager.
export function isManager(user) {
  return user?.role === "admin" || user?.role === "manager";
}

// Only a branch manager (not an admin).
export function isBranchManager(user) {
  return user?.role === "manager";
}

export function roleLabelKey(role) {
  return role === "admin" ? "settings.admins" : role === "manager" ? "settings.managerRole" : "settings.staffRole";
}
