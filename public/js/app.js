import { api } from "./api.js";
import { state } from "./state.js";
import { toast, isSheetOpen, closeSheet } from "./ui.js";
import { parseLocation, pathFor, go, listen } from "./router.js";
import { t, tf, getLang } from "./i18n.js";
import { getToken, getCachedUser, clearSession, isAdmin } from "./session.js";
import { mountLogin } from "./views/login.js";
import { mountStock, unmountStock } from "./views/stock.js";
import { mountDocuments, unmountDocuments } from "./views/documents.js";
import { mountDashboard } from "./views/dashboard.js";
import { mountReport } from "./views/report.js";
import { mountSettings } from "./views/settings/index.js";
import { setSizeLabels } from "./sku-groups.js";

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

// opts: { sub, params } from the URL (a case, a settings section). fromRoute:
// the URL already says this (boot, Back/Forward), so nothing is pushed.
async function switchView(view, opts = {}, { fromRoute = false } = {}) {
  if (!views[view]) view = "stock";
  if (!fromRoute) {
    const params = view === "stock" && opts.sub ? { date: opts.params?.date, tab: opts.params?.tab, step: opts.params?.step, view: opts.params?.view } : {};
    go(pathFor(view, opts.sub ?? null, params), { parent: opts.sub ? pathFor(view) : null });
  }
  if (isSheetOpen()) closeSheet({ fromHistory: true });
  if (state.view === "stock" && view !== "stock") unmountStock();
  if (state.view === "documents") unmountDocuments();
  state.view = view;
  setActiveNav(view);
  document.getElementById("view-root").scrollTop = 0;
  const mount = views[view];
  try {
    await mount({ sub: opts.sub ?? null, params: opts.params ?? {} });
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
    // Independent reads: the data-mode banner and the session meta load together.
    const [, meta] = await Promise.all([loadDataMeta(), api.meta()]);
    state.meta = meta;
    setSizeLabels(meta.weights);
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
  await routeFrom(parseLocation());
}

// Shows the screen the URL names. "/" and unknown paths become /daily_stock.
async function routeFrom(route) {
  if (!route.known) go(pathFor("stock"), { replace: true });
  const params = Object.fromEntries(route.params.entries());
  await switchView(route.view, { sub: route.known ? route.sub : null, params }, { fromRoute: true });
}

listen((route) => {
  if (!state.meta) return;
  routeFrom(route);
}, { isSheetOpen, closeSheet });

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
  // No valid session — show the username + password login gate.
  await mountLogin(async (user) => {
    state.user = user;
    await loadMetaAndEnter();
  });
}

boot();
