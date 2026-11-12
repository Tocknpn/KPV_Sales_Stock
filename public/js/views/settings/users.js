import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { escapeHtml } from "../../util.js";

export async function renderUsers(root) {
  root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">Loading…</div>`;
  const { staff } = await api.settingsSummary();

  root.innerHTML = `
    <div class="card p-4">
      <div class="flex gap-2">
        <span class="status-pill bg-brand-100 text-brand-700">${t("settings.admins")} · ${staff.roleCounts.admin ?? 0}</span>
        <span class="status-pill bg-gray-100 text-gray-600">${t("settings.staffRole")} · ${staff.roleCounts.staff ?? 0}</span>
      </div>
      <div class="mt-3 flex -space-x-2">
        ${staff.accounts
          .slice(0, 8)
          .map((a) => `<span title="${escapeHtml(a.display_name)}" class="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-brand-50 text-[10px] font-extrabold text-brand-700">${a.display_name.slice(0, 2).toUpperCase()}</span>`)
          .join("")}
        ${staff.accounts.length > 8 ? `<span class="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-gray-100 text-[10px] font-extrabold text-gray-500">+${staff.accounts.length - 8}</span>` : ""}
      </div>
      <div class="mt-3 flex flex-col divide-y divide-hairline">
        ${staff.accounts
          .map(
            (a) => `
          <div class="flex items-center justify-between py-2 text-xs">
            <span class="font-bold text-gray-800">${escapeHtml(a.display_name)}</span>
            <span class="text-gray-500">${escapeHtml(a.branch_name)}</span>
            <span class="status-pill bg-gray-100 text-gray-500">${a.role}</span>
          </div>`
          )
          .join("")}
      </div>
    </div>
  `;
}
