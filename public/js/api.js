import { getToken, clearSession } from "./session.js";
import { t } from "./i18n.js";

const BASE = "/api";

// Server errors carry a stable `code`; when a translation exists for it the
// user sees that instead of the server's English text.
function errorMessage(body, status) {
  const key = body?.code ? `err.${body.code}` : null;
  const translated = key ? t(key) : null;
  if (translated && translated !== key) return translated;
  return body?.error || `Request failed (${status})`;
}

async function send(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  // A 401 on an authenticated call means the session ended server-side (PIN
  // changed, account closed, 30 days passed) — drop it and return to login.
  // A 401 from the login call itself is just a wrong PIN.
  if (res.status === 401 && token && !path.startsWith("/auth/login")) {
    clearSession();
    window.location.reload();
    throw new Error(t("err.SESSION_EXPIRED"));
  }
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {}
    const err = new Error(errorMessage(body, res.status));
    err.status = res.status;
    err.code = body?.code ?? null;
    err.data = body ?? {};
    throw err;
  }
  return res;
}

async function request(path, options) {
  const res = await send(path, options);
  if (res.status === 204) return null;
  return res.json();
}

const post = (path, payload) => request(path, { method: "POST", body: JSON.stringify(payload ?? {}) });
const patch = (path, payload) => request(path, { method: "PATCH", body: JSON.stringify(payload ?? {}) });
const query = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== "")).toString();

export const api = {
  meta: () => request("/app-meta"),
  dataMeta: () => request("/meta"),
  branches: () => request("/branches"),

  authAccounts: (branchId) => request(`/auth/accounts${branchId ? `?branchId=${branchId}` : ""}`),
  login: (accountId, pin) => post(`/auth/login`, { accountId, pin }),
  me: () => request("/auth/me"),
  logout: () => post(`/auth/logout`),

  createDesk: (payload) => post(`/desks`, payload),
  skus: (all = false) => request(`/skus${all ? "?all=1" : ""}`),
  createSku: (payload) => post(`/skus`, payload),
  updateSku: (skuId, payload) => patch(`/skus/${encodeURIComponent(skuId)}`, payload),
  importSkus: (rows) => post(`/skus/import`, { rows }),

  skuTypes: () => request(`/sku-types`),
  createSkuType: (payload) => post(`/sku-types`, payload),
  updateSkuType: (typeId, payload) => patch(`/sku-types/${encodeURIComponent(typeId)}`, payload),
  skuWeights: () => request(`/sku-weights`),
  createSkuWeight: (payload) => post(`/sku-weights`, payload),
  updateSkuWeight: (weightId, payload) => patch(`/sku-weights/${encodeURIComponent(weightId)}`, payload),

  deskCards: (date, branchId) => request(`/stock/desks?${query({ date, branchId })}`),
  // date may be "latest" = the desk's most recent recorded day.
  deskDetail: (deskId, date) => request(`/stock/desk/${deskId}?${query({ date })}`),
  calendar: (branchId, month) => request(`/stock/calendar?${query({ branchId, month })}`),
  checkIn: (deskId, date) => post(`/stock/desk/${deskId}/checkin`, { date }),
  // Compare-and-set save: changes = [{sku_id, field, from?, to}].
  saveChanges: (deskId, payload) => post(`/stock/desk/${deskId}/entries`, payload),
  closeDay: (deskId, payload) => post(`/stock/desk/${deskId}/close`, payload),
  transitionDesk: (deskId, payload) => post(`/stock/desk/${deskId}/transition`, payload),
  reopenDesk: (deskId, payload) => post(`/stock/desk/${deskId}/reopen`, payload),
  addDeskSku: (deskId, payload) => post(`/stock/desk/${deskId}/sku`, payload),
  removeDeskSku: (deskId, skuId, date) => request(`/stock/desk/${deskId}/sku/${encodeURIComponent(skuId)}?${query({ date })}`, { method: "DELETE" }),

  transferDestinations: () => request(`/transfers/destinations`),
  move: (payload) => post(`/moves`, payload),
  undoMove: (ticketId, clientRef) => post(`/moves/${encodeURIComponent(ticketId)}/undo`, { clientRef }),
  transfers: (params) => request(`/transfers?${query(params ?? {})}`),
  createTransfer: (payload) => post(`/transfers`, payload),
  cancelTransfer: (id) => post(`/transfers/${id}/cancel`),
  receiveTransfer: (id, date) => post(`/transfers/${id}/receive`, { date }),

  documents: (params) => request(`/documents?${query(params)}`),
  createDocument: (payload) => post(`/documents`, payload),
  decideDocument: (id, decision) => post(`/documents/${id}/decision`, { decision }),
  deleteDocument: (id) => request(`/documents/${id}`, { method: "DELETE" }),
  documentPrintHtml: async (id) => (await send(`/documents/${id}/print`)).text(),

  dashboard: (params) => request(`/dashboard?${query(params)}`),
  report: (params) => request(`/report?${query(params)}`),

  settingsSummary: () => request("/settings/summary"),
  saveConfig: (payload) => post("/settings/config", payload),
  replenishment: (branchId) => request(`/replenishment?${query({ branchId })}`),
  saveRule: (payload) => request("/replenishment/rules", { method: "PUT", body: JSON.stringify(payload) }),
  bulkRule: (payload) => post("/replenishment/rules/bulk", payload),
  about: () => request("/settings/about"),

  createUser: (payload) => post(`/users`, payload),
  updateUser: (id, payload) => patch(`/users/${id}`, payload),
  audit: (params) => request(`/audit?${query(params ?? {})}`),

  myCases: (branchId) => request(`/my-cases?${query({ branchId })}`),
  assignDesk: (deskId, staffId, note) => post(`/desks/${encodeURIComponent(deskId)}/assign`, { staffId, note }),
  releaseDesk: (deskId) => post(`/desks/${encodeURIComponent(deskId)}/release`),
  closedDays: (params) => request(`/closed-days?${query(params ?? {})}`),
  addClosedDays: (payload) => post(`/closed-days`, payload),
  removeClosedDay: (branchId, date) => request(`/closed-days?${query({ branchId, date })}`, { method: "DELETE" }),
};

// Printing needs the login token, which a plain new-tab link cannot send. The
// tab is opened immediately (so the browser does not block it as a popup) and
// filled once the document has been fetched.
export function openPrintTab() {
  return window.open("", "_blank");
}

export async function fillPrintTab(win, id) {
  try {
    const html = await api.documentPrintHtml(id);
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err) {
    win?.close();
    throw err;
  }
}

export function openDocumentPrint(id) {
  return fillPrintTab(openPrintTab(), id);
}
