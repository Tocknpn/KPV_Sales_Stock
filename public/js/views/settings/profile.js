// The signed-in person's card at the top of Settings: name, branch and role,
// in the screen's language.
import { state, branchName } from "../../state.js";
import { t } from "../../i18n.js";
import { escapeHtml } from "../../util.js";
import { isAdmin, roleLabelKey } from "../../session.js";

export function profileCardHtml(user = state.user) {
  const initials = (user?.displayName || "?").slice(0, 2).toUpperCase();
  const where = user?.branchId ? branchName(user.branchId) : isAdmin(user) ? t("topbar.allBranches") : "";
  return `
    <div class="card p-5 text-center">
      <span class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-xl font-extrabold text-brand-700">${escapeHtml(initials)}</span>
      <div class="mt-3 text-base font-extrabold text-gray-900">${escapeHtml(user?.displayName ?? "")}</div>
      <div class="mt-1 text-xs font-semibold text-gray-600">${t("topbar.loggedInAs")} · ${escapeHtml(where)}</div>
      <span class="mt-2 inline-flex status-pill bg-gray-100 text-gray-600">${user?.role ? t(roleLabelKey(user.role)) : ""}</span>
    </div>`;
}
