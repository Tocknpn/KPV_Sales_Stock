import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { fmtDateTime } from "../../util.js";

export async function renderAbout(root) {
  root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">Loading…</div>`;
  const [{ sync }, about] = await Promise.all([api.settingsSummary(), api.about()]);

  root.innerHTML = `
    <div class="card p-4">
      <div class="flex items-center gap-2.5">
        <span class="flex h-9 w-9 items-center justify-center rounded-full ${sync.connected ? "bg-success-bg text-success" : "bg-warning-bg text-warning"}">
          <svg class="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v6h6M20 20v-6h-6"/><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 15a8 8 0 0014.3 3.4M19.5 9A8 8 0 005.2 5.6"/></svg>
        </span>
        <div class="flex-1 text-xs font-bold text-gray-900">${sync.connected ? t("settings.connected") : t("settings.demoDataset")}</div>
      </div>
    </div>
    <div class="card mt-4 divide-y divide-hairline p-0">
      <div class="flex items-center justify-between px-4 py-3 text-xs">
        <span class="font-semibold text-gray-600">${t("settings.aboutVersion")}</span>
        <span class="font-bold text-gray-900">${about.version}</span>
      </div>
      <div class="flex items-center justify-between px-4 py-3 text-xs">
        <span class="font-semibold text-gray-600">${t("settings.aboutBuildDate")}</span>
        <span class="font-bold text-gray-900">${about.buildDate ? fmtDateTime(`${about.buildDate}T00:00:00`) : "—"}</span>
      </div>
    </div>
  `;
}
