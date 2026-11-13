// Settings > Audit (manager / admin). Every change anyone made, newest first,
// one sentence each, with filters. A manager sees their own branch; the server
// enforces that, the screen only hides the branch choice. Read-only.
import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { escapeHtml, fmtDate, laosDateOf } from "../../util.js";
import { state, branchName } from "../../state.js";
import { isAdmin } from "../../session.js";
import { auditSentence } from "../day/history.js";

export async function renderAudit(root) {
  const admin = isAdmin(state.user);
  const branches = admin ? state.meta.branches : state.meta.branches.filter((b) => b.branch_id === state.user.branchId);
  const desks = state.meta.desks;
  let people = [];
  try {
    people = (await api.settingsSummary()).staff.accounts;
  } catch {}

  root.innerHTML = `
    <form id="audit-form" class="card p-4">
      ${
        admin
          ? `<label for="audit-branch" class="mb-1.5 block text-xs font-bold text-gray-600">${t("audit.branch")}</label>
             <select id="audit-branch" class="input-filled">
               <option value="">${t("closed.allBranches")}</option>
               ${branches.map((b) => `<option value="${escapeHtml(b.branch_id)}">${escapeHtml(branchName(b.branch_id))}</option>`).join("")}
             </select>`
          : ""
      }
      <label for="audit-desk" class="mb-1.5 ${admin ? "mt-3" : ""} block text-xs font-bold text-gray-600">${t("audit.case")}</label>
      <select id="audit-desk" class="input-filled"></select>
      <label for="audit-actor" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("audit.person")}</label>
      <select id="audit-actor" class="input-filled">
        <option value="">${t("audit.anyone")}</option>
        ${people.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.display_name)}</option>`).join("")}
      </select>
      <div class="mt-3 grid grid-cols-2 gap-2">
        <div class="min-w-0">
          <label for="audit-from" class="mb-1.5 block text-xs font-bold text-gray-600">${t("audit.from")}</label>
          <input id="audit-from" type="date" class="input-filled w-full min-w-0" />
        </div>
        <div class="min-w-0">
          <label for="audit-to" class="mb-1.5 block text-xs font-bold text-gray-600">${t("audit.to")}</label>
          <input id="audit-to" type="date" class="input-filled w-full min-w-0" />
        </div>
      </div>
      <button type="submit" class="btn-primary mt-4 w-full py-3">${t("audit.apply")}</button>
    </form>
    <div id="audit-days" class="mt-4 flex flex-col gap-3"></div>
    <p id="audit-status" class="py-4 text-center text-sm text-gray-600" role="status"></p>
    <button type="button" id="audit-more" class="btn-secondary mb-4 hidden w-full">${t("history.more")}</button>`;

  const $ = (id) => root.querySelector(id);
  const deskSelect = $("#audit-desk");
  const fillDesks = () => {
    const branch = admin ? $("#audit-branch").value : state.user.branchId;
    const list = desks.filter((d) => !branch || d.branch_id === branch);
    deskSelect.innerHTML = `<option value="">${t("audit.allCases")}</option>` + list.map((d) => `<option value="${escapeHtml(d.desk_id)}">${escapeHtml(d.display_name)}</option>`).join("");
  };
  fillDesks();
  $("#audit-branch")?.addEventListener("change", fillDesks);

  let next = null;
  let shown = 0;
  let lastDay = null;
  let block = null;

  function append(entries) {
    const host = $("#audit-days");
    for (const e of entries) {
      const day = laosDateOf(e.created_at);
      if (day !== lastDay) {
        lastDay = day;
        const section = document.createElement("section");
        section.innerHTML = `<h3 class="mb-1.5 text-xs font-extrabold uppercase tracking-wide text-gray-600">${escapeHtml(fmtDate(day))}</h3><ul class="card divide-y divide-hairline p-0"></ul>`;
        host.appendChild(section);
        block = section.querySelector("ul");
      }
      const li = document.createElement("li");
      li.className = "min-w-0 break-words px-3 py-2.5 text-sm text-gray-800";
      // textContent: audit values are arbitrary user text.
      li.textContent = auditSentence(e);
      block.appendChild(li);
      shown++;
    }
  }

  async function load(reset) {
    const status = $("#audit-status");
    const more = $("#audit-more");
    if (reset) {
      $("#audit-days").innerHTML = "";
      next = null;
      shown = 0;
      lastDay = null;
    }
    status.textContent = t("settings.loading");
    more.disabled = true;
    try {
      const res = await api.audit({
        branchId: admin ? $("#audit-branch").value : "",
        deskId: deskSelect.value,
        actorId: $("#audit-actor").value,
        from: $("#audit-from").value,
        to: $("#audit-to").value,
        before: next,
      });
      append(res.entries);
      next = res.next;
      status.textContent = shown ? "" : t("history.empty");
      more.classList.toggle("hidden", !next);
    } catch (err) {
      status.textContent = err.message || t("err.SERVER_ERROR");
    } finally {
      more.disabled = false;
    }
  }

  $("#audit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    load(true);
  });
  $("#audit-more").addEventListener("click", () => load(false));
  await load(true);
}
