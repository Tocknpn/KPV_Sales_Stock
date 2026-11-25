// The executive overview, shared by the dashboard and the report's position /
// stock-out / case tabs. A short cache keeps switching between them instant.
import { api } from "../api.js";
import { state, branchName } from "../state.js";
import { openActionSheet } from "../ui.js";
import { t } from "../i18n.js";
import { isAdmin } from "../session.js";

const TTL_MS = 60_000;
let cache = { key: null, at: 0, data: null };

export async function loadExecutive({ fresh = false } = {}) {
  const key = `${state.exec.days}|${state.exec.branch ?? ""}`;
  if (!fresh && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.data;
  const data = await api.executive({ days: state.exec.days, branchId: state.exec.branch ?? undefined });
  cache = { key, at: Date.now(), data };
  return data;
}

export const periodLabel = (days) => t(`exec.days${days}`);

// Days of cover: one decimal under 10, whole days above.
export function fmtDays(d) {
  if (d == null) return "–";
  return d < 10 ? String(Math.round(d * 10) / 10) : String(Math.round(d));
}

const chevron = `<svg class="h-3.5 w-3.5 shrink-0 text-gray-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>`;

// Period + branch pickers (branch only for admin; others see their own branch).
export function execFiltersHtml() {
  return `<div class="mt-3 flex gap-2">
    <button id="exec-period" class="chip flex-1 justify-between border-hairline bg-white text-gray-700"><span id="exec-period-label">${periodLabel(state.exec.days)}</span>${chevron}</button>
    ${
      isAdmin(state.user)
        ? `<button id="exec-branch" class="chip flex-1 justify-between border-hairline bg-white text-gray-700"><span id="exec-branch-label" class="truncate">${state.exec.branch ? branchName(state.exec.branch) : t("documents.allBranches")}</span>${chevron}</button>`
        : ""
    }
  </div>`;
}

export function bindExecFilters(onChange) {
  document.getElementById("exec-period")?.addEventListener("click", (e) => {
    const options = [7, 30, 90].map((d) => ({ label: periodLabel(d), value: d, selected: d === state.exec.days }));
    openActionSheet(t("exec.period"), options, (opt) => {
      state.exec.days = opt.value;
      document.getElementById("exec-period-label").textContent = opt.label;
      onChange();
    }, { anchorEl: e.currentTarget });
  });
  document.getElementById("exec-branch")?.addEventListener("click", (e) => {
    const options = [{ label: t("documents.allBranches"), value: null }, ...state.meta.branches.map((b) => ({ label: branchName(b.branch_id), value: b.branch_id }))];
    openActionSheet(
      t("documents.filterByBranch"),
      options.map((o) => ({ ...o, selected: o.value === state.exec.branch })),
      (opt) => {
        state.exec.branch = opt.value;
        document.getElementById("exec-branch-label").textContent = opt.label;
        onChange();
      },
      { anchorEl: e.currentTarget }
    );
  });
}
