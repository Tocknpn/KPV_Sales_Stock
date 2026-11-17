import { t, tf, getLang, setLang } from "../../i18n.js";
import { api } from "../../api.js";
import { state } from "../../state.js";
import { fmtInt, fmtLaosStamp, escapeHtml } from "../../util.js";
import { isAdmin, isManager, clearSession } from "../../session.js";
import { renderSku } from "./sku.js";
import { renderExchangeRate } from "./exchange-rate.js";
import { go, pathFor, backTo } from "../../router.js";
import { renderUsers } from "./users.js";
import { renderAudit } from "./audit.js";

const MENU = [
  { id: "sku", labelKey: "settings.menuSku", render: renderSku, icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M3 8l9-4 9 4-9 4-9-4z"/><path stroke-linecap="round" stroke-linejoin="round" d="M3 8v9l9 4 9-4V8M12 12v9"/>` },
  { id: "exchange", labelKey: "settings.menuExchangeRate", render: renderExchangeRate, adminOnly: true, icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M7 8h12l-3-3M17 16H5l3 3"/>` },
  { id: "users", labelKey: "settings.menuUsers", render: renderUsers, icon: `<circle cx="9" cy="8" r="3"/><path stroke-linecap="round" d="M3 20c1-3.5 3.3-5.5 6-5.5s5 2 6 5.5"/><circle cx="17.5" cy="9" r="2.3"/><path stroke-linecap="round" d="M15.8 14.3c2 .2 3.6 2 4.2 4.2"/>` },
  { id: "audit", labelKey: "audit.menu", render: renderAudit, icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M8 4h8l3 3v13H5V4h3z"/><path stroke-linecap="round" d="M9 12h6M9 16h6M9 8h3"/>` },
];

// Hidden since 2026-11-17: Replenishment (now inside SKU setting), Stock-out
// mode (fixed to the full layout) and Closed days (views kept, not listed).
const visibleMenu = () => MENU.filter((m) => (!m.managerOnly || isManager(state.user)) && (!m.adminOnly || isAdmin(state.user)));

function setTopbar(title, subtitle, onBack) {
  document.getElementById("topbar-slot").innerHTML = onBack
    ? `<div class="flex items-center gap-2.5">
        <button id="settings-back" aria-label="${t("login.back")}" class="tap-target -ml-1.5 flex h-8 w-8 items-center justify-center rounded-full text-gray-600 active:bg-gray-100">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <h1 class="text-lg font-extrabold text-gray-900">${title}</h1>
      </div>`
    : `<div>
        <h1 class="text-lg font-extrabold text-gray-900">${title}</h1>
        <p class="text-[11px] font-medium text-gray-600">${subtitle}</p>
      </div>`;
  if (onBack) document.getElementById("settings-back").addEventListener("click", onBack);
}

function profileCard() {
  const user = state.user;
  const branch = user?.branchId ? state.meta?.branches.find((b) => b.branch_id === user.branchId) : null;
  const initials = (user?.displayName || "?").slice(0, 2).toUpperCase();
  return `
    <div class="card p-5 text-center">
      <span class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-xl font-extrabold text-brand-700">${initials}</span>
      <div class="mt-3 text-base font-extrabold text-gray-900">${user?.displayName ?? ""}</div>
      <div class="mt-1 text-xs font-semibold text-gray-600">
        ${t("topbar.loggedInAs")} · ${branch ? branch.name_en : isAdmin(user) ? t("topbar.allBranches") : ""}
      </div>
      <span class="mt-2 inline-flex status-pill bg-gray-100 text-gray-600">${user?.role ?? ""}</span>
    </div>`;
}

function goldStrip() {
  const g = state.meta?.gold;
  if (!g || !(g.lakPerBaht > 0)) return "";
  const price = fmtInt(g.lakPerBaht);
  const line = g.asOf ? tf("settings.goldStrip", { price, time: fmtLaosStamp(g.asOf) }) : tf("settings.goldStripNoTime", { price });
  const notes = [];
  if (g.source === "manual") notes.push(t("settings.goldManual"));
  if (g.stale) notes.push(t("settings.goldStale"));
  const tone = g.stale ? "border-warning/40 bg-warning-bg text-warning" : "border-hairline bg-white text-gray-700";
  return `
    <div id="gold-strip" class="mt-4 rounded-xl border px-4 py-2.5 text-xs font-semibold ${tone}">
      <div>${escapeHtml(line)}</div>
      ${notes.map((n) => `<div class="mt-0.5 text-[11px]">${escapeHtml(n)}</div>`).join("")}
    </div>`;
}

function menuRow(item) {
  return `
    <button data-menu="${item.id}" class="tap-target flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-gray-50">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        <svg class="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${item.icon}</svg>
      </span>
      <span class="flex-1 text-sm font-bold text-gray-900">${t(item.labelKey)}</span>
      <svg class="h-4 w-4 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
    </button>`;
}

function languageRow() {
  return `
    <div class="flex items-center gap-3 px-4 py-3.5">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        <svg class="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M3 12h18M12 3c2.5 2.5 3.8 6 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-6-3.8-9S9.5 5.5 12 3z"/></svg>
      </span>
      <span class="flex-1 text-sm font-bold text-gray-900">${t("settings.menuLanguage")}</span>
      <div class="flex rounded-lg bg-gray-200 p-0.5">
        <button id="lang-lo" data-lang="lo" class="lang-toggle rounded-md px-3 py-1.5 text-xs font-bold">${t("settings.lao")}</button>
        <button id="lang-en" data-lang="en" class="lang-toggle rounded-md px-3 py-1.5 text-xs font-bold">${t("settings.english")}</button>
      </div>
    </div>`;
}

function wireLanguageToggle(root) {
  root.querySelectorAll(".lang-toggle").forEach((btn) => {
    const active = btn.dataset.lang === getLang();
    btn.classList.toggle("bg-white", active);
    btn.classList.toggle("shadow-card", active);
    btn.classList.toggle("text-brand-700", active);
    btn.classList.toggle("text-gray-600", !active);
    btn.addEventListener("click", () => {
      if (btn.dataset.lang === getLang()) return;
      setLang(btn.dataset.lang);
      window.refreshNav?.();
      window.switchView("settings");
    });
  });
}

function renderMenu(root) {
  setTopbar(t("settings.title"), t("settings.subtitle"));
  root.innerHTML = `
    ${profileCard()}
    ${goldStrip()}
    <div class="card mt-4 divide-y divide-hairline p-0">
      ${visibleMenu().map((item) => menuRow(item)).join("")}
      ${languageRow()}
    </div>
    <button id="settings-logout" class="btn-secondary mt-4 w-full border-danger/30 text-danger">${t("topbar.logout")}</button>
    <div id="settings-version" class="mt-6 pb-2 pr-1 text-right text-[11px] font-semibold text-gray-400"></div>
  `;

  root.querySelectorAll("[data-menu]").forEach((btn) => {
    btn.addEventListener("click", () => openSub(btn.dataset.menu));
  });
  wireLanguageToggle(root);
  root.querySelector("#settings-logout").addEventListener("click", async () => {
    try {
      await api.logout();
    } catch {}
    clearSession();
    window.location.reload();
  });

  api
    .about()
    .then((about) => {
      const el = root.querySelector("#settings-version");
      if (el && about.version) el.textContent = `${t("settings.aboutVersion")} ${about.version}`;
    })
    .catch(() => {});
}

// fromRoute: the URL already names this section (refresh, Back/Forward).
async function openSub(id, { fromRoute = false } = {}) {
  const item = visibleMenu().find((m) => m.id === id);
  const root = document.getElementById("view-root");
  if (!item) {
    // Unknown, or not for this role: the menu instead.
    go(pathFor("settings"), { replace: true });
    return renderMenu(root);
  }
  if (!fromRoute) go(pathFor("settings", id), { parent: pathFor("settings") });
  setTopbar(t(item.labelKey), "", () => backTo(pathFor("settings"), () => renderMenu(root)));
  root.innerHTML = "";
  await item.render(root);
}

// route.sub is a section id when the URL names one: /settings/<id>
export async function mountSettings(route = {}) {
  const root = document.getElementById("view-root");
  if (route.sub) return openSub(route.sub, { fromRoute: true });
  renderMenu(root);
}
