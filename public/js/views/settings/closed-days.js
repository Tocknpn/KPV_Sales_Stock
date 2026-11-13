// Settings > Closed days (manager / admin). Holidays and shop closures: a closed
// day is not a required check day and does not break a case streak. An admin can
// close every branch at once; a manager only their own.
import { api } from "../../api.js";
import { t, tf, getLang } from "../../i18n.js";
import { escapeHtml, fmtDate } from "../../util.js";
import { state, branchName } from "../../state.js";
import { isAdmin } from "../../session.js";
import { toast } from "../../ui.js";

function monthLabel(ym) {
  return new Date(`${ym}-01T00:00:00`).toLocaleDateString(getLang() === "lo" ? "lo-LA" : "en-US", { month: "long", year: "numeric" });
}

export async function renderClosedDays(root) {
  root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">${t("settings.loading")}</div>`;
  const admin = isAdmin(state.user);
  // Show this year and next; the list is short (a handful of holidays a year).
  const year = Number(state.meta.today.slice(0, 4));
  const { closedDays } = await api.closedDays({ from: `${year}-01-01`, to: `${year + 1}-12-31` });
  const rows = [...closedDays].sort((a, b) => a.closed_date.localeCompare(b.closed_date) || a.branch_id.localeCompare(b.branch_id));

  const byMonth = new Map();
  for (const r of rows) {
    const ym = r.closed_date.slice(0, 7);
    byMonth.set(ym, [...(byMonth.get(ym) ?? []), r]);
  }

  const branchOptions = admin
    ? `<option value="all">${t("closed.allBranches")}</option>` +
      state.meta.branches.map((b) => `<option value="${escapeHtml(b.branch_id)}">${escapeHtml(branchName(b.branch_id))}</option>`).join("")
    : `<option value="${escapeHtml(state.user.branchId)}">${escapeHtml(branchName(state.user.branchId))}</option>`;

  root.innerHTML = `
    <form id="closed-form" class="card p-4">
      <h2 class="text-sm font-extrabold text-gray-900">${t("closed.add")}</h2>
      <label for="closed-date" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("closed.date")}</label>
      <input id="closed-date" type="date" required class="input-filled" />
      <label for="closed-reason" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("closed.reason")}</label>
      <input id="closed-reason" type="text" required maxlength="200" class="input-filled" />
      <label for="closed-branch" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("closed.branch")}</label>
      <select id="closed-branch" class="input-filled" ${admin ? "" : "disabled"}>${branchOptions}</select>
      <button type="submit" class="btn-primary mt-4 w-full py-3">${t("closed.add")}</button>
    </form>
    <p class="mt-3 text-center text-[11px] text-gray-500">${t("closed.hint")}</p>
    <div class="mt-4 flex flex-col gap-4">
      ${
        byMonth.size
          ? [...byMonth.entries()]
              .map(
                ([ym, list]) => `
        <section>
          <h3 class="mb-1.5 text-xs font-extrabold uppercase tracking-wide text-gray-600">${escapeHtml(monthLabel(ym))}</h3>
          <div class="card divide-y divide-hairline p-0">
            ${list
              .map(
                (r) => `
              <div class="flex items-center gap-3 px-4 py-2.5">
                <div class="min-w-0 flex-1">
                  <div class="break-words text-sm font-bold text-gray-900">${escapeHtml(fmtDate(r.closed_date))} · ${escapeHtml(r.reason)}</div>
                  <div class="truncate text-[11px] text-gray-500">${escapeHtml(branchName(r.branch_id))}</div>
                </div>
                <button data-remove data-branch="${escapeHtml(r.branch_id)}" data-date="${escapeHtml(r.closed_date)}" class="tap-target shrink-0 rounded-full px-3 text-xs font-bold text-danger active:bg-danger-bg">${t("closed.remove")}</button>
              </div>`
              )
              .join("")}
          </div>
        </section>`
              )
              .join("")
          : `<div class="py-8 text-center text-sm text-gray-500">${t("closed.empty")}</div>`
      }
    </div>`;

  root.querySelector("#closed-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const res = await api.addClosedDays({
        branchId: root.querySelector("#closed-branch").value,
        date: root.querySelector("#closed-date").value,
        reason: root.querySelector("#closed-reason").value.trim(),
      });
      const added = Array.isArray(res.added) ? res.added.length : Number(res.added);
      toast(added ? tf("closed.added", { n: added }) : tf("closed.skipped", { n: res.skipped }), "success");
    } catch (err) {
      toast(err.message, "error");
    }
    await renderClosedDays(root);
  });

  root.querySelectorAll("[data-remove]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const { branch, date } = btn.dataset;
      if (!window.confirm(tf("closed.removeConfirm", { date: fmtDate(date), branch: branchName(branch) }))) return;
      btn.disabled = true;
      try {
        await api.removeClosedDay(branch, date);
        toast(t("closed.removed"), "success");
      } catch (err) {
        toast(err.message, "error");
      }
      await renderClosedDays(root);
    })
  );
}
