import { api } from "./api.js";
import { state } from "./state.js";
import { toast } from "./ui.js";
import { t, tf, getLang } from "./i18n.js";
import { getToken, getCachedUser, clearSession, isAdmin } from "./session.js";
import { mountLogin } from "./views/login.js";
import { mountStock, unmountStock } from "./views/stock.js";
import { mountDocuments } from "./views/documents.js";
import { mountDashboard } from "./views/dashboard.js";
import { mountReport, unmountReport } from "./views/report.js";
import { mountSettings } from "./views/settings/index.js";

const views = {
  stock: mountStock,
  documents: mountDocuments,
  dashboard: mountDashboard,
  report: mountReport,
  settings: mountSettings,
};

const NAV_LABEL_KEYS = {
  stock: "nav.stock",
  documents: "nav.documents",
  dashboard: "nav.dashboard",
  report: "nav.report",
  settings: "nav.settings",
};

// Strip above the top bar: "test data" in test mode; for an admin in production, a
// reminder while mock rows are still loaded. Plain text, never colour alone.
// seedRows is null when unknown (anyone but a signed-in admin): never show a count then.
let dataMeta = { dataMode: "production", seedRows: null };

function paintBanner() {
  const el = document.getElementById("mode-banner");
  let text = "";
  if (dataMeta.dataMode === "test") text = t("mode.test");
  else if (dataMeta.dataMode === "production" && typeof dataMeta.seedRows === "number" && dataMeta.seedRows > 0) text = tf("mode.seedLeft", { n: dataMeta.seedRows });
  el.textContent = text;
  const tone = dataMeta.dataMode === "test" ? "bg-warning-bg text-warning" : "bg-danger-bg text-danger";
  el.className = text ? `${tone} border-b border-hairline px-4 py-2 text-center text-xs font-bold` : "hidden";
}

async function loadDataMeta() {
  try {
    dataMeta = await api.dataMeta();
  } catch {}
  paintBanner();
}

export function refreshNav() {
  document.documentElement.lang = getLang() === "lo" ? "lo" : "en";
  paintBanner();
  document.querySelectorAll("#bottom-nav [data-view]").forEach((btn) => {
    btn.querySelector("[data-nav-label]").textContent = t(NAV_LABEL_KEYS[btn.dataset.view]);
  });
}

function setActiveNav(view) {
  document.querySelectorAll("#bottom-nav [data-view]").forEach((btn) => {
    const isActive = btn.dataset.view === view;
    btn.classList.toggle("active", isActive);
    if (isActive) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.removeAttribute("aria-current");
    }
  });
}

async function switchView(view) {
  if (state.view === "report" && view !== "report") unmountReport();
  if (state.view === "stock" && view !== "stock") unmountStock();
  state.view = view;
  setActiveNav(view);
  document.getElementById("view-root").scrollTop = 0;
  const mount = views[view];
  try {
    await mount();
  } catch (err) {
    console.error(err);
    toast(err.message || "Something went wrong", "error");
  }
}
window.switchView = switchView;
window.refreshNav = refreshNav;

// Any action that fails (a rule the server refused, no connection) surfaces
// as a toast instead of failing silently.
window.addEventListener("unhandledrejection", (e) => {
  const message = e.reason?.message;
  if (!message) return;
  e.preventDefault();
  toast(message, "error");
});

document.getElementById("bottom-nav").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (btn) switchView(btn.dataset.view);
});

async function loadMetaAndEnter() {
  try {
    await loadDataMeta();
    state.meta = await api.meta();
    state.user = state.meta.user;
    state.stock.date = state.meta.today;
    state.stock.branch = state.meta.branches[0]?.branch_id ?? null;
    state.documents.branch = isAdmin(state.user) ? null : state.user.branchId;
    state.dashboard.branch = isAdmin(state.user) ? null : state.user.branchId;
    state.report.branch = isAdmin(state.user) ? null : state.user.branchId;
    state.report.period = state.meta.today.slice(0, 7);
    if (!state.meta.live) {
      toast(t("app.demoMode"));
    }
  } catch (err) {
    console.error(err);
    document.getElementById("view-root").innerHTML = `<div class="card p-6 text-center text-sm text-gray-500">${t("app.loadFailed")}</div>`;
    return;
  }
  refreshNav();
  await switchView("stock");
}

async function boot() {
  refreshNav();
  const token = getToken();
  if (token) {
    try {
      const { user } = await api.me();
      state.user = user;
      await loadMetaAndEnter();
      return;
    } catch {
      clearSession();
    }
  }
  await loadDataMeta();
  // No valid session — show the login gate. It needs the branch list, which
  // is public (no auth) since you haven't logged in yet.
  const { branches } = await api.branches();
  await mountLogin(branches, async (user) => {
    state.user = user;
    await loadMetaAndEnter();
  });
}

boot();
