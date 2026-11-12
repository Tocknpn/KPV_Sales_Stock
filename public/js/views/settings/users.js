// Settings > Users. Everyone can see the accounts of their branch; an admin
// can add people, move them between branches, reset a PIN, unlock a locked
// account and deactivate someone who has left.
import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { escapeHtml } from "../../util.js";
import { state, branchName } from "../../state.js";
import { isAdmin, isBranchManager, roleLabelKey } from "../../session.js";
import { toast, openSheet, closeSheet } from "../../ui.js";

export async function renderUsers(root) {
  root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">${t("settings.loading")}</div>`;
  const { staff } = await api.settingsSummary();
  const admin = isAdmin(state.user);
  const manager = isBranchManager(state.user);

  root.innerHTML = `
    ${admin ? `<button id="add-user" class="btn-primary mb-3 w-full py-2.5 text-xs">${t("users.add")}</button>` : ""}
    <div class="card p-4">
      <div class="flex gap-2">
        <span class="status-pill bg-brand-100 text-brand-700">${t("settings.admins")} · ${staff.roleCounts.admin ?? 0}</span>
        <span class="status-pill bg-gray-100 text-gray-600">${t("settings.managerRole")} · ${staff.roleCounts.manager ?? 0}</span>
        <span class="status-pill bg-gray-100 text-gray-600">${t("settings.staffRole")} · ${staff.roleCounts.staff ?? 0}</span>
      </div>
      <div class="mt-3 flex flex-col divide-y divide-hairline">
        ${staff.accounts.map((a) => userRow(a, admin, manager && a.role === "staff" && a.locked)).join("") || `<div class="py-6 text-center text-xs text-gray-500">—</div>`}
      </div>
    </div>
    ${admin ? `<p class="mt-3 text-center text-[11px] text-gray-500">${t("users.hint")}</p>` : manager ? `<p class="mt-3 text-center text-[11px] text-gray-500">${t("users.hintManager")}</p>` : ""}
  `;

  root.querySelector("#add-user")?.addEventListener("click", () => openUserForm(null, root));
  root.querySelectorAll("[data-user]").forEach((btn) =>
    btn.addEventListener("click", () => openUserForm(staff.accounts.find((a) => a.id === btn.dataset.user), root))
  );
}

function userRow(a, admin, canUnlock) {
  const chips = [
    !a.active ? `<span class="status-pill bg-gray-100 text-gray-500">${t("settings.inactiveLabel")}</span>` : "",
    a.locked ? `<span class="status-pill bg-danger-bg text-danger">${t("users.locked")}</span>` : "",
    `<span class="status-pill ${a.role === "admin" ? "bg-brand-100 text-brand-700" : "bg-gray-100 text-gray-600"}">${t(roleLabelKey(a.role))}</span>`,
  ].join("");
  const inner = `
    <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-extrabold text-brand-700">${escapeHtml(a.display_name.slice(0, 2).toUpperCase())}</span>
    <span class="min-w-0 flex-1 text-left">
      <span class="block truncate text-xs font-bold ${a.active ? "text-gray-900" : "text-gray-400"}">${escapeHtml(a.display_name)}</span>
      <span class="block truncate text-[10px] text-gray-500">${a.branch_id ? escapeHtml(branchName(a.branch_id)) : t("topbar.allBranches")}</span>
    </span>
    <span class="flex shrink-0 items-center gap-1">${chips}</span>`;
  return admin || canUnlock
    ? `<button data-user="${a.id}" class="tap-target flex w-full items-center gap-2.5 py-2.5 active:bg-gray-50">${inner}</button>`
    : `<div class="flex items-center gap-2.5 py-2.5">${inner}</div>`;
}

function pinField(id, labelKey) {
  return `
    <label for="${id}" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t(labelKey)}</label>
    <input id="${id}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="new-password" placeholder="••••" class="input-filled text-center text-base font-extrabold tracking-[0.5em]" />`;
}

function openUserForm(existing, root) {
  if (isBranchManager(state.user)) return openUnlockSheet(existing, root);
  const branches = state.meta.branches;
  const isSelf = existing?.id === state.user.accountId;
  openSheet(
    `
    <label for="user-name" class="mb-1.5 block text-xs font-bold text-gray-600">${t("users.name")}</label>
    <input id="user-name" type="text" maxlength="60" value="${existing ? escapeHtml(existing.display_name) : ""}" class="input-filled" />

    ${
      existing
        ? ""
        : `<label for="user-role" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("users.role")}</label>
           <select id="user-role" class="input-filled">
             <option value="staff">${t("settings.staffRole")}</option>
             <option value="manager">${t("settings.managerRole")}</option>
             <option value="admin">${t("settings.admins")}</option>
           </select>`
    }

    ${
      !existing || existing.role !== "admin"
        ? `<div id="user-branch-wrap">
             <label for="user-branch" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("documents.branch")}</label>
             <select id="user-branch" class="input-filled">
               ${branches.map((b) => `<option value="${b.branch_id}" ${existing?.branch_id === b.branch_id ? "selected" : ""}>${escapeHtml(branchName(b.branch_id))}</option>`).join("")}
             </select>
           </div>`
        : ""
    }

    ${pinField("user-pin", existing ? "users.newPin" : "users.pin")}
    ${existing ? `<p class="mt-1.5 text-[11px] text-gray-500">${t("users.newPinHint")}</p>` : ""}

    <button id="user-save" class="btn-primary mt-4 w-full">${t("settings.save")}</button>

    ${
      existing
        ? `<div class="mt-3 flex gap-2.5 pb-2">
             ${existing.locked ? `<button id="user-unlock" class="btn-secondary flex-1">${t("users.unlock")}</button>` : ""}
             ${
               isSelf
                 ? ""
                 : `<button id="user-active" class="btn-secondary flex-1 ${existing.active ? "border-danger/30 text-danger" : ""}">${existing.active ? t("users.deactivate") : t("users.activate")}</button>`
             }
           </div>`
        : ""
    }
  `,
    {
      title: existing ? existing.display_name : t("users.add"),
      onMount: (body) => {
        const done = async (messageKey) => {
          closeSheet();
          toast(t(messageKey), "success");
          await renderUsers(root);
        };

        body.querySelector("#user-role")?.addEventListener("change", (e) => {
          body.querySelector("#user-branch-wrap").classList.toggle("hidden", e.target.value === "admin");
        });

        body.querySelector("#user-save").addEventListener("click", async () => {
          const displayName = body.querySelector("#user-name").value.trim();
          const pin = body.querySelector("#user-pin").value;
          if (!displayName) return toast(t("users.needName"), "error");
          if ((!existing || pin) && !/^[0-9]{4}$/.test(pin)) return toast(t("users.needPin"), "error");
          const branchId = body.querySelector("#user-branch")?.value;
          if (existing) {
            const payload = {};
            if (displayName !== existing.display_name) payload.displayName = displayName;
            if (existing.role !== "admin" && branchId !== existing.branch_id) payload.branchId = branchId;
            if (pin) payload.pin = pin;
            await api.updateUser(existing.id, payload);
          } else {
            const role = body.querySelector("#user-role").value;
            await api.createUser({ displayName, role, branchId: role === "admin" ? null : branchId, pin });
          }
          await done("settings.savedToast");
        });

        body.querySelector("#user-unlock")?.addEventListener("click", async () => {
          await api.updateUser(existing.id, { unlock: true });
          await done("users.unlocked");
        });

        body.querySelector("#user-active")?.addEventListener("click", async () => {
          await api.updateUser(existing.id, { active: !existing.active });
          await done("settings.savedToast");
        });
      },
    }
  );
}

// A branch manager can only unlock a locked staff account of their own branch.
function openUnlockSheet(existing, root) {
  openSheet(
    `<button id="user-unlock" class="btn-primary w-full">${t("users.unlock")}</button>`,
    {
      title: existing.display_name,
      onMount: (body) => {
        body.querySelector("#user-unlock").addEventListener("click", async () => {
          await api.updateUser(existing.id, { unlock: true });
          closeSheet();
          toast(t("users.unlocked"), "success");
          await renderUsers(root);
        });
      },
    }
  );
}
