import { t, getLang, setLang } from "../../i18n.js";
import { api } from "../../api.js";
import { state } from "../../state.js";
import { isAdmin, clearSession } from "../../session.js";
import { renderSku } from "./sku.js";
import { renderLeadtime } from "./leadtime.js";
import { renderUsers } from "./users.js";

const MENU = [
  { id: "sku", labelKey: "settings.menuSku", render: renderSku, icon: `<path stroke-linecap="round" stroke-linejoin="round" d="M3 8l9-4 9 4-9 4-9-4z"/><path stroke-linecap="round" stroke-linejoin="round" d="M3 8v9l9 4 9-4V8M12 12v9"/>` },
  { id: "leadtime", labelKey: "settings.menuLeadtime", render: renderLeadtime, icon: `<circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M12 7v5l3.5 2"/>` },
  { id: "users", labelKey: "settings.menuUsers", render: renderUsers, icon: `<circle cx="9" cy="8" r="3"/><path stroke-linecap="round" d="M3 20c1-3.5 3.3-5.5 6-5.5s5 2 6 5.5"/><circle cx="17.5" cy="9" r="2.3"/><path stroke-linecap="round" d="M15.8 14.3c2 .2 3.6 2 4.2 4.2"/>` },
];

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
    <div class="card mt-4 divide-y divide-hairline p-0">
      ${MENU.map((item) => menuRow(item)).join("")}
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

async function openSub(id) {
  const item = MENU.find((m) => m.id === id);
  const root = document.getElementById("view-root");
  setTopbar(t(item.labelKey), "", () => mountSettings());
  root.innerHTML = "";
  await item.render(root);
}

export async function mountSettings() {
  const root = document.getElementById("view-root");
  renderMenu(root);
}
