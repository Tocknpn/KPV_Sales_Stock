// Reusable month-grid calendar widget. Each day cell shows a small ring
// indicating what fraction of the branch's Desks have any record that day.
import { t } from "./i18n.js";

const WEEKDAY_KEYS = ["calendar.sun", "calendar.mon", "calendar.tue", "calendar.wed", "calendar.thu", "calendar.fri", "calendar.sat"];

function ringColor(pct) {
  if (pct >= 100) return "#10b981";
  if (pct > 0) return "#f59e0b";
  return "#d1d5db";
}

function dayRing(pct) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const filled = (Math.min(100, pct) / 100) * c;
  return `
    <svg class="absolute inset-0" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="2.5" />
      <circle cx="12" cy="12" r="${r}" fill="none" stroke="${ringColor(pct)}" stroke-width="2.5"
        stroke-dasharray="${filled} ${c}" stroke-linecap="round" transform="rotate(-90 12 12)" />
    </svg>`;
}

export function renderCalendar(container, { monthDate, selectedDate, completionByDate, onSelect, onMonthChange }) {
  const [y, m] = monthDate.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${monthDate}-${String(d).padStart(2, "0")}`);

  container.innerHTML = `
    <div class="flex items-center justify-between px-1">
      <button data-cal-prev class="tap-target flex h-8 w-8 items-center justify-center rounded-full text-gray-600 active:bg-gray-100">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 18l-6-6 6-6"/></svg>
      </button>
      <span class="text-sm font-extrabold text-gray-900">${monthLabel}</span>
      <button data-cal-next class="tap-target flex h-8 w-8 items-center justify-center rounded-full text-gray-600 active:bg-gray-100">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 18l6-6-6-6"/></svg>
      </button>
    </div>
    <div class="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase text-gray-500">
      ${WEEKDAY_KEYS.map((k) => `<span>${t(k)}</span>`).join("")}
    </div>
    <div class="mt-1 grid grid-cols-7 gap-1">
      ${cells
        .map((date) => {
          if (!date) return `<span></span>`;
          const day = Number(date.slice(-2));
          const pct = completionByDate?.[date]?.pct ?? 0;
          const isSelected = date === selectedDate;
          return `
          <button data-cal-day="${date}" class="relative flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold ${isSelected ? "bg-brand-600 text-white" : "text-gray-800"}">
            ${!isSelected ? dayRing(pct) : ""}
            <span class="relative">${day}</span>
          </button>`;
        })
        .join("")}
    </div>
    <div class="mt-3 flex items-center justify-center gap-4 text-[10px] font-semibold text-gray-500">
      <span class="flex items-center gap-1"><span class="h-2 w-2 rounded-full bg-gray-300"></span>${t("calendar.none")}</span>
      <span class="flex items-center gap-1"><span class="h-2 w-2 rounded-full" style="background:#f59e0b"></span>${t("calendar.partial")}</span>
      <span class="flex items-center gap-1"><span class="h-2 w-2 rounded-full" style="background:#10b981"></span>${t("calendar.full")}</span>
    </div>
  `;

  container.querySelector("[data-cal-prev]").addEventListener("click", () => {
    const d = new Date(Date.UTC(y, m - 2, 1));
    onMonthChange(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  });
  container.querySelector("[data-cal-next]").addEventListener("click", () => {
    const d = new Date(Date.UTC(y, m, 1));
    onMonthChange(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  });
  container.querySelectorAll("[data-cal-day]").forEach((btn) => btn.addEventListener("click", () => onSelect(btn.dataset.calDay)));
}
