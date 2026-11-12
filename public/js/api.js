import { getToken, clearSession } from "./session.js";

const BASE = "/api";

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    // Session expired or was invalidated server-side — drop it and force a
    // fresh login rather than letting every subsequent call fail silently.
    clearSession();
    window.location.reload();
    throw new Error("Session expired");
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  meta: () => request("/meta"),
  branches: () => request("/branches"),

  authAccounts: (branchId) => request(`/auth/accounts${branchId ? `?branchId=${branchId}` : ""}`),
  login: (accountId, pin) => request(`/auth/login`, { method: "POST", body: JSON.stringify({ accountId, pin }) }),
  me: () => request("/auth/me"),
  logout: () => request(`/auth/logout`, { method: "POST" }),

  createDesk: (payload) => request(`/desks`, { method: "POST", body: JSON.stringify(payload) }),
  skus: (all = false) => request(`/skus${all ? "?all=1" : ""}`),
  createSku: (payload) => request(`/skus`, { method: "POST", body: JSON.stringify(payload) }),
  updateSku: (skuId, payload) => request(`/skus/${skuId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  skuTypes: () => request(`/sku-types`),
  createSkuType: (payload) => request(`/sku-types`, { method: "POST", body: JSON.stringify(payload) }),
  updateSkuType: (typeId, payload) => request(`/sku-types/${typeId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  skuWeights: () => request(`/sku-weights`),
  createSkuWeight: (payload) => request(`/sku-weights`, { method: "POST", body: JSON.stringify(payload) }),
  updateSkuWeight: (weightId, payload) => request(`/sku-weights/${weightId}`, { method: "PATCH", body: JSON.stringify(payload) }),

  deskCards: (date, branchId) => request(`/stock/desks?date=${date}${branchId ? `&branchId=${branchId}` : ""}`),
  deskDetail: (deskId, date) => request(`/stock/desk/${deskId}?date=${date}`),
  calendar: (branchId, month) => request(`/stock/calendar?branchId=${branchId}&month=${month}`),
  checkIn: (deskId, date) => request(`/stock/desk/${deskId}/checkin`, { method: "POST", body: JSON.stringify({ date }) }),
  saveEntry: (deskId, payload) => request(`/stock/desk/${deskId}/entry`, { method: "POST", body: JSON.stringify(payload) }),
  transitionDesk: (deskId, payload) => request(`/stock/desk/${deskId}/transition`, { method: "POST", body: JSON.stringify(payload) }),
  addDeskSku: (deskId, payload) => request(`/stock/desk/${deskId}/sku`, { method: "POST", body: JSON.stringify(payload) }),
  removeDeskSku: (deskId, skuId, date) => request(`/stock/desk/${deskId}/sku/${skuId}?date=${date}`, { method: "DELETE" }),

  documents: (params) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ""));
    return request(`/documents?${qs.toString()}`);
  },
  createDocument: (payload) => request(`/documents`, { method: "POST", body: JSON.stringify(payload) }),
  deleteDocument: (id) => request(`/documents/${id}`, { method: "DELETE" }),

  dashboard: (params) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return request(`/dashboard?${qs.toString()}`);
  },

  report: (params) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return request(`/report?${qs.toString()}`);
  },

  settingsSummary: () => request("/settings/summary"),
  saveConfig: (payload) => request("/settings/config", { method: "POST", body: JSON.stringify(payload) }),
  runRate: () => request("/settings/run-rate"),
  saveRunRate: (skuId, payload) => request(`/settings/run-rate/${skuId}`, { method: "POST", body: JSON.stringify(payload) }),
  about: () => request("/settings/about"),
};
