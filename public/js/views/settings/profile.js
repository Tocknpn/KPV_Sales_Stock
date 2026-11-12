import { api } from "../../api.js";
import { state } from "../../state.js";
import { t } from "../../i18n.js";
import { isAdmin, clearSession } from "../../session.js";

export async function renderProfile(root) {
  const user = state.user;
  const branch = user?.branchId ? state.meta?.branches.find((b) => b.branch_id === user.branchId) : null;
  const initials = (user?.displayName || "?").slice(0, 2).toUpperCase();

  root.innerHTML = `
    <div class="card p-5 text-center">
      <span class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-xl font-extrabold text-brand-700">${initials}</span>
      <div class="mt-3 text-base font-extrabold text-gray-900">${user?.displayName ?? ""}</div>
      <div class="mt-1 text-xs font-semibold text-gray-600">
        ${t("topbar.loggedInAs")} · ${branch ? branch.name_en : isAdmin(user) ? t("topbar.allBranches") : ""}
      </div>
      <span class="mt-2 inline-flex status-pill bg-gray-100 text-gray-600">${user?.role ?? ""}</span>
    </div>
    <button id="profile-logout" class="btn-secondary mt-4 w-full border-danger/30 text-danger">${t("topbar.logout")}</button>
  `;

  root.querySelector("#profile-logout").addEventListener("click", async () => {
    try {
      await api.logout();
    } catch {}
    clearSession();
    window.location.reload();
  });
}
