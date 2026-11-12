import { t, getLang, setLang } from "../../i18n.js";

export async function renderLanguage(root) {
  root.innerHTML = `
    <div class="card p-4">
      <div class="flex items-center justify-between rounded-xl bg-gray-50 px-3.5 py-3">
        <div class="text-[11px] text-gray-600">${t("settings.languageDesc")}</div>
        <div class="flex rounded-lg bg-gray-200 p-0.5">
          <button id="lang-lo" data-lang="lo" class="lang-toggle rounded-md px-3 py-1.5 text-xs font-bold">${t("settings.lao")}</button>
          <button id="lang-en" data-lang="en" class="lang-toggle rounded-md px-3 py-1.5 text-xs font-bold">${t("settings.english")}</button>
        </div>
      </div>
    </div>
  `;

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
