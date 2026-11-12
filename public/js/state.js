// Tiny shared app state — plain object + pub/sub, no framework needed for a
// 5-screen mobile SPA this size.
import { pickName } from "./i18n.js";

function getStoredDocView() {
  try {
    return localStorage.getItem("kpv_doc_view") || "cards";
  } catch {
    return "cards";
  }
}
export function setStoredDocView(view) {
  try {
    localStorage.setItem("kpv_doc_view", view);
  } catch {}
}

export const state = {
  meta: null, // { branches, desks, config, today, live }
  user: null, // { accountId, displayName, role, branchId }
  view: "stock",
  stock: { date: null, branch: null, filter: "all" },
  documents: { branch: null, desk: null, date: null, page: 1, filter: "all", view: getStoredDocView() },
  report: { period: null, branch: null, desk: null, q: "", view: "cards" },
  dashboard: { period: "today", branch: null, desk: null, category: null, stockFlag: null },
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notify() {
  for (const fn of listeners) fn();
}

export function branchName(branchId) {
  const b = state.meta?.branches.find((b) => b.branch_id === branchId);
  return b ? pickName(b.name_en, b.name_lo) : branchId;
}
export function deskById(deskId) {
  return state.meta?.desks.find((d) => d.desk_id === deskId);
}
