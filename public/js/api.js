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
  // A 401 on an authenticated call means the session ended server-side
  // (password changed, account closed, 30 days passed) — drop it and return to
  // login. A 401 from the login call itself is just a wrong password.
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
  login: (username, password) => post(`/auth/login`, { username, password }),
  me: () => request("/auth/me"),
  logout: () => post(`/auth/logout`),

  createDesk: (payload) => post(`/desks`, payload),
  // skus(true) = with inactive ones; skus({ all, branchId }) adds carried + that branch's plan.
  skus: (opts = false) => {
    const o = typeof opts === "object" && opts ? opts : { all: !!opts };
    return request(`/skus?${query({ all: o.all ? 1 : undefined, branchId: o.branchId })}`);
  },
  setCarried: (skuId, branchId, carried) => request(`/skus/${encodeURIComponent(skuId)}/carried`, { method: "PUT", body: JSON.stringify({ branchId, carried }) }),
  exportSkus: (branchId) => request(`/skus/export?${query({ branchId })}`),
  createSku: (payload) => post(`/skus`, payload),
  updateSku: (skuId, payload) => patch(`/skus/${encodeURIComponent(skuId)}`, payload),
  // payload = { branchId, fileName, rows, dryRun }
  importSkus: (payload) => post(`/skus/import`, payload),

  skuTypes: () => request(`/sku-types`),
  createSkuType: (payload) => post(`/sku-types`, payload),
  updateSkuType: (typeId, payload) => patch(`/sku-types/${encodeURIComponent(typeId)}`, payload),
  skuWeights: () => request(`/sku-weights`),
  createSkuWeight: (payload) => post(`/sku-weights`, payload),
  updateSkuWeight: (weightId, payload) => patch(`/sku-weights/${encodeURIComponent(weightId)}`, payload),
  skuUnits: () => request(`/sku-units`),
  createSkuUnit: (payload) => post(`/sku-units`, payload),
  updateSkuUnit: (unit, payload) => patch(`/sku-units/${encodeURIComponent(unit)}`, payload),

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
  // payload = { date, items: [{ sku_id, opening_qty? }] }
  addDeskSkus: (deskId, payload) => post(`/stock/desk/${deskId}/sku`, payload),
  removeDeskSku: (deskId, skuId, date) => request(`/stock/desk/${deskId}/sku/${encodeURIComponent(skuId)}?${query({ date })}`, { method: "DELETE" }),

  undoMove: (ticketId, clientRef) => post(`/moves/${encodeURIComponent(ticketId)}/undo`, { clientRef }),
  transfers: (params) => request(`/transfers?${query(params ?? {})}`),

  documents: (params) => request(`/documents?${query(params)}`),
  createDocument: (payload) => post(`/documents`, payload),
  // payload = { branchId, date, cases: [{ deskId, title, rows }] }
  createProposals: (payload) => post(`/documents/proposals`, payload),
  updateDocument: (id, payload) => request(`/documents/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) }),
  documentCreators: (branchId) => request(`/documents/creators?${query({ branchId })}`),
  proposalTaken: (branchId, date) => request(`/documents/proposal-taken?${query({ branchId, date })}`),
  proposalSource: (deskId, date) => request(`/documents/proposal-source?${query({ deskId, date })}`),
  documentsPrintHtml: async (params) => (await send(`/documents/print?${query(params)}`)).text(),
  decideDocument: (id, decision) => post(`/documents/${id}/decision`, { decision }),
  deleteDocument: (id) => request(`/documents/${id}`, { method: "DELETE" }),
  documentPrintHtml: async (id) => (await send(`/documents/${id}/print`)).text(),

  dashboard: (params) => request(`/dashboard?${query(params)}`),
  executive: (params) => request(`/executive?${query(params)}`),
  report: (params) => request(`/report?${query(params)}`),
  reportGrid: (branch, month) => request(`/report/grid?${query({ branch, month })}`),

  settingsSummary: () => request("/settings/summary"),
  saveConfig: (payload) => post("/settings/config", payload),
  replenishment: (branchId) => request(`/replenishment?${query({ branchId })}`),
  replenishmentRules: (branchId) => request(`/replenishment/rules?${query({ branchId })}`),
  saveRule: (payload) => request("/replenishment/rules", { method: "PUT", body: JSON.stringify(payload) }),
  bulkRule: (payload) => post("/replenishment/rules/bulk", payload),
  about: () => request("/settings/about"),

  createUser: (payload) => post(`/users`, payload),
  updateUser: (id, payload) => patch(`/users/${id}`, payload),
  userPassword: (id) => request(`/users/${encodeURIComponent(id)}/password`),
  userCases: (id) => request(`/users/${encodeURIComponent(id)}/cases`),
  setUserCases: (id, deskIds) => request(`/users/${encodeURIComponent(id)}/cases`, { method: "PUT", body: JSON.stringify({ deskIds }) }),
  audit: (params) => request(`/audit?${query(params ?? {})}`),

  deskHistory: (deskId, to, days) => request(`/desks/${encodeURIComponent(deskId)}/history?${query({ to, days })}`),
  deskInfo: (deskId) => request(`/desks/${encodeURIComponent(deskId)}/info`),
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

// Several documents (one group, or a list of ids) in one printable tab.
export async function fillPrintTabMany(win, params) {
  try {
    const html = await api.documentsPrintHtml(params);
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err) {
    win?.close();
    throw err;
  }
}

export function openGroupPrint(groupId) {
  return fillPrintTabMany(openPrintTab(), { groupId });
}
