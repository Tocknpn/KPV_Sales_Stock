// Settings > Users. Everyone can see the accounts of their branch; an admin
// can add people, set their username, move them between branches, reset a
// password, unlock a locked
// account and deactivate someone who has left. An admin can also see each
// person's password (owner's decision, 2026-11-16; stored as plain text):
// masked, revealed on tap.
import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { escapeHtml } from "../../util.js";
import { state, branchName } from "../../state.js";
import { isAdmin, isBranchManager, roleLabelKey } from "../../session.js";
import { toast, openSheet, closeSheet } from "../../ui.js";
import { skeletonList } from "../../skeleton.js";

export async function renderUsers(root) {
  root.innerHTML = skeletonList();
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
        ${staff.accounts.map((a) => userRow(a, admin, manager && a.role !== "admin" && a.branch_id === state.user.branchId)).join("") || `<div class="py-6 text-center text-xs text-gray-500">—</div>`}
      </div>
    </div>
    ${admin ? `<p class="mt-3 text-center text-[11px] text-gray-500">${t("users.hint")}</p>` : manager ? `<p class="mt-3 text-center text-[11px] text-gray-500">${t("users.hintManager")}</p>` : ""}
  `;

  root.querySelector("#add-user")?.addEventListener("click", () => openUserForm(null, root));
  if (admin) wirePasswordRows(root);
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
      <span class="block truncate text-[10px] text-gray-500">${a.username ? `@${escapeHtml(a.username)} · ` : `<span class="text-danger">${t("users.noUsername")}</span> · `}${a.branch_id ? escapeHtml(branchName(a.branch_id)) : t("topbar.allBranches")}</span>
    </span>
    <span class="flex shrink-0 items-center gap-1">${chips}</span>`;
  if (admin) {
    return `<div class="py-2.5">
      <button data-user="${a.id}" class="tap-target flex w-full items-center gap-2.5 active:bg-gray-50">${inner}</button>
      ${passwordLine(a)}
    </div>`;
  }
  return canUnlock
    ? `<button data-user="${a.id}" class="tap-target flex w-full items-center gap-2.5 py-2.5 active:bg-gray-50">${inner}</button>`
    : `<div class="flex items-center gap-2.5 py-2.5">${inner}</div>`;
}

const EYE = `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a10.6 10.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>`;
const COPY = `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
const MASK = "••••••••";

// Admin only: the password line under a user. Not known yet = set before
// this feature and the person has not signed in since.
function passwordLine(a) {
  if (!a.has_password) {
    return `<p class="ml-[46px] mt-1 text-[11px] text-gray-500">${t("users.pwUnknown")}</p>`;
  }
  return `<div class="ml-[46px] mt-1 flex items-center gap-1 text-[11px]" data-pw-row="${a.id}">
    <span class="text-gray-500">${t("users.password")}:</span>
    <span data-pw-text class="select-all font-mono font-bold text-gray-800">${MASK}</span>
    <button type="button" data-pw-show class="tap-target flex h-8 w-8 items-center justify-center rounded-full text-gray-500 active:bg-gray-100" aria-label="${t("users.pwShow")}">${EYE}</button>
    <button type="button" data-pw-copy class="tap-target flex h-8 w-8 items-center justify-center rounded-full text-gray-500 active:bg-gray-100" aria-label="${t("users.pwCopy")}">${COPY}</button>
  </div>`;
}

// One fetch per user per visit; the list itself never carries passwords.
const pwCache = new Map();
async function fetchPassword(id) {
  if (!pwCache.has(id)) {
    const { password } = await api.userPassword(id);
    if (password === null) return null;
    pwCache.set(id, password);
  }
  return pwCache.get(id);
}

function wirePasswordRows(root) {
  pwCache.clear();
  root.querySelectorAll("[data-pw-row]").forEach((row) => {
    const id = row.dataset.pwRow;
    const text = row.querySelector("[data-pw-text]");
    const show = row.querySelector("[data-pw-show]");
    show.addEventListener("click", async () => {
      if (text.textContent !== MASK) {
        text.textContent = MASK;
        show.innerHTML = EYE;
        return;
      }
      const pw = await fetchPassword(id);
      if (pw === null) return toast(t("users.pwUnreadable"), "error");
      text.textContent = pw;
      show.innerHTML = EYE_OFF;
    });
    row.querySelector("[data-pw-copy]").addEventListener("click", async () => {
      const pw = await fetchPassword(id);
      if (pw === null) return toast(t("users.pwUnreadable"), "error");
      try {
        await navigator.clipboard.writeText(pw);
        toast(t("users.pwCopied"), "success");
      } catch {
        text.textContent = pw;
        show.innerHTML = EYE_OFF;
      }
    });
  });
}

const MIN_PASSWORD = 6;
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;

function passwordField(id, labelKey) {
  return `
    <label for="${id}" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t(labelKey)}</label>
    <input id="${id}" type="text" maxlength="72" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" class="input-filled" />`;
}

// Main cases (decided 2026-11-19): chips of the branch's cases; the chosen
// ones come first on that person's Daily stock list.
const branchDesks = (branchId) => (state.meta.desks ?? []).filter((d) => d.branch_id === branchId && d.active !== false);

function mainCasesField() {
  return `
    <div id="main-cases-wrap">
      <p class="mb-1.5 mt-3 block text-xs font-bold text-gray-600" id="main-cases-label">${t("users.mainCases")}</p>
      <div id="main-cases" role="group" aria-labelledby="main-cases-label" class="flex flex-wrap gap-1.5"></div>
      <p class="mt-1.5 text-[11px] text-gray-500">${t("users.mainCasesHint")}</p>
    </div>`;
}

// Renders the chips for one branch into the sheet; returns the live selection.
function bindMainCases(body, branchId, selected) {
  const host = body.querySelector("#main-cases");
  if (!host) return selected;
  const desks = branchDesks(branchId);
  for (const id of [...selected]) if (!desks.some((d) => d.desk_id === id)) selected.delete(id);
  host.innerHTML = desks.length
    ? desks
        .map((d) => {
          const on = selected.has(d.desk_id);
          return `<button type="button" data-case="${escapeHtml(d.desk_id)}" aria-pressed="${on}" class="chip ${on ? "border-brand-600 bg-brand-50 text-brand-700" : "border-hairline bg-white text-gray-600"}">${on ? "✓ " : ""}${escapeHtml(d.display_name)}</button>`;
        })
        .join("")
    : `<span class="text-[11px] text-gray-500">${t("users.mainCasesNone")}</span>`;
  host.querySelectorAll("[data-case]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = btn.dataset.case;
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      bindMainCases(body, branchId, selected);
    })
  );
  return selected;
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

function openUserForm(existing, root) {
  if (isBranchManager(state.user)) return openUnlockSheet(existing, root);
  const branches = state.meta.branches;
  const isSelf = existing?.id === state.user.accountId;
  openSheet(
    `
    <label for="user-name" class="mb-1.5 block text-xs font-bold text-gray-600">${t("users.name")}</label>
    <input id="user-name" type="text" maxlength="60" value="${existing ? escapeHtml(existing.display_name) : ""}" class="input-filled" />

    <label for="user-username" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("users.username")}</label>
    <input id="user-username" type="text" maxlength="30" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"
           value="${existing?.username ? escapeHtml(existing.username) : ""}" placeholder="somchai" class="input-filled" />
    <p class="mt-1.5 text-[11px] text-gray-500">${t("users.usernameHint")}</p>

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
             ${mainCasesField()}
           </div>`
        : ""
    }

    ${passwordField("user-password", existing && !existing.has_password ? "users.newPassword" : "users.password")}
    <p class="mt-1.5 text-[11px] text-gray-500">${existing ? t("users.newPasswordHint") : t("users.passwordHint")}</p>

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

        // Pre-fill the current password so the admin can read or change it.
        // Saving sends it only when it was changed.
        let current = null;
        if (existing?.has_password) {
          fetchPassword(existing.id)
            .then((pw) => {
              const input = body.querySelector("#user-password");
              if (pw !== null && input && !input.value) {
                current = pw;
                input.value = pw;
              }
            })
            .catch(() => {});
        }

        body.querySelector("#user-role")?.addEventListener("change", (e) => {
          body.querySelector("#user-branch-wrap").classList.toggle("hidden", e.target.value === "admin");
        });

        let casesBefore = new Set();
        const cases = new Set();
        const branchSelect = body.querySelector("#user-branch");
        if (branchSelect) {
          bindMainCases(body, branchSelect.value, cases);
          branchSelect.addEventListener("change", () => bindMainCases(body, branchSelect.value, cases));
          if (existing && existing.role !== "admin") {
            api
              .userCases(existing.id)
              .then(({ deskIds }) => {
                casesBefore = new Set(deskIds);
                deskIds.forEach((id) => cases.add(id));
                bindMainCases(body, branchSelect.value, cases);
              })
              .catch(() => {});
          }
        }

        body.querySelector("#user-save").addEventListener("click", async () => {
          const displayName = body.querySelector("#user-name").value.trim();
          const username = body.querySelector("#user-username").value.trim().toLowerCase();
          const typed = body.querySelector("#user-password").value;
          const password = existing && typed === current ? "" : typed;
          if (!displayName) return toast(t("users.needName"), "error");
          if (!USERNAME_RE.test(username)) return toast(t("err.BAD_USERNAME"), "error");
          if ((!existing || password) && password.length < MIN_PASSWORD) return toast(t("err.BAD_PASSWORD"), "error");
          const branchId = body.querySelector("#user-branch")?.value;
          if (existing) {
            const payload = {};
            if (displayName !== existing.display_name) payload.displayName = displayName;
            if (username !== existing.username) payload.username = username;
            if (existing.role !== "admin" && branchId !== existing.branch_id) payload.branchId = branchId;
            if (password) payload.password = password;
            if (Object.keys(payload).length) await api.updateUser(existing.id, payload);
            if (existing.role !== "admin" && !sameSet(cases, casesBefore)) await api.setUserCases(existing.id, [...cases]);
          } else {
            const role = body.querySelector("#user-role").value;
            const { id } = await api.createUser({ displayName, username, role, branchId: role === "admin" ? null : branchId, password });
            if (role !== "admin" && cases.size) await api.setUserCases(id, [...cases]);
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

// A branch manager sets the main cases of a person in their branch, and can
// unlock a locked staff account. Nothing else.
function openUnlockSheet(existing, root) {
  const canUnlock = existing.role === "staff" && existing.locked;
  openSheet(
    `
    ${mainCasesField()}
    <button id="cases-save" class="btn-primary mt-4 w-full">${t("settings.save")}</button>
    ${canUnlock ? `<button id="user-unlock" class="btn-secondary mt-2.5 w-full">${t("users.unlock")}</button>` : ""}
  `,
    {
      title: existing.display_name,
      onMount: (body) => {
        const cases = new Set();
        let before = new Set();
        bindMainCases(body, existing.branch_id, cases);
        api
          .userCases(existing.id)
          .then(({ deskIds }) => {
            before = new Set(deskIds);
            deskIds.forEach((id) => cases.add(id));
            bindMainCases(body, existing.branch_id, cases);
          })
          .catch(() => {});
        body.querySelector("#cases-save").addEventListener("click", async (e) => {
          e.currentTarget.disabled = true;
          try {
            if (!sameSet(cases, before)) await api.setUserCases(existing.id, [...cases]);
          } finally {
            e.currentTarget.disabled = false;
          }
          closeSheet();
          toast(t("users.mainCasesSaved"), "success");
          await renderUsers(root);
        });
        body.querySelector("#user-unlock")?.addEventListener("click", async () => {
          await api.updateUser(existing.id, { unlock: true });
          closeSheet();
          toast(t("users.unlocked"), "success");
          await renderUsers(root);
        });
      },
    }
  );
}
