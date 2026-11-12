import { api } from "./api.js";
import { state } from "./state.js";
import { toast } from "./ui.js";
import { t, getLang } from "./i18n.js";
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

export function refreshNav() {
  document.documentElement.lang = getLang() === "lo" ? "lo" : "en";
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

document.getElementById("bottom-nav").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (btn) switchView(btn.dataset.view);
});

async function loadMetaAndEnter() {
  try {
    state.meta = await api.meta();
    state.user = state.meta.user;
    state.stock.date = state.meta.today;
    state.stock.branch = state.meta.branches[0]?.branch_id ?? null;
    state.documents.branch = isAdmin(state.user) ? null : state.user.branchId;
    state.dashboard.branch = isAdmin(state.user) ? null : state.user.branchId;
    state.report.branch = isAdmin(state.user) ? null : state.user.branchId;
    state.report.period = state.meta.today.slice(0, 7);
    if (!state.meta.live) {
      toast("Demo mode — connect Supabase to go live (see Settings)");
    }
  } catch (err) {
    console.error(err);
    document.getElementById("view-root").innerHTML = `<div class="card p-6 text-center text-sm text-gray-500">Failed to load app data. Pull to refresh.</div>`;
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
  // No valid session — show the login gate. It needs the branch list, which
  // is public (no auth) since you haven't logged in yet.
  const { branches } = await api.branches();
  await mountLogin(branches, async (user) => {
    state.user = user;
    await loadMetaAndEnter();
  });
}

boot();
