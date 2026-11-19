// Skeleton placeholders shown while a screen loads: grey shapes of the content
// that is coming, instead of a "Loading…" line. Each is one status region so a
// screen reader announces "Loading" once.
import { t } from "./i18n.js";

const bar = (cls) => `<div class="skeleton ${cls}"></div>`;
const times = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join("");
const region = (inner, cls = "") =>
  `<div role="status" aria-busy="true" class="${cls}"><span class="sr-only">${t("settings.loading")}</span>${inner}</div>`;

// Case cards (Daily Stock list, Documents list).
export function skeletonCards(n = 4) {
  return region(
    times(
      n,
      () => `<div data-skel-item class="card border-l-4 border-l-transparent px-2.5 py-2.5">
        <div class="flex items-center gap-1.5"><div class="min-w-0 flex-1">${bar("h-4 w-3/5")}</div>${bar("h-7 w-7 shrink-0")}</div>
        <div class="mt-1.5 space-y-1.5">${bar("h-4 w-1/2")}${bar("h-3 w-4/5")}${bar("h-3 w-2/3")}</div>
        <div class="mt-2.5 grid grid-cols-2 gap-1.5">${bar("h-11 rounded-xl")}${bar("h-11 rounded-xl")}</div>
      </div>`
    ),
    "grid grid-cols-2 gap-2 max-[359px]:grid-cols-1"
  );
}

// Rows of icon + two text lines (users, SKU rows, history, closed days, about).
export function skeletonList(n = 6) {
  return region(
    `<div class="card divide-y divide-hairline p-0">${times(
      n,
      () => `<div data-skel-item class="flex items-center gap-2.5 px-4 py-3">
        ${bar("h-8 w-8 shrink-0")}
        <div class="min-w-0 flex-1 space-y-1.5">${bar("h-3 w-1/2")}${bar("h-2.5 w-2/3")}</div>
      </div>`
    )}</div>`
  );
}

// SKU picker: one section header and a 3-column grid of cards.
export function skeletonGrid(n = 9) {
  return region(
    `${bar("mb-2 h-3 w-24")}<div class="grid grid-cols-3 gap-2">${times(
      n,
      () => `<div data-skel-item class="rounded-xl border border-hairline p-2" style="min-height:84px">
        ${bar("mb-2 h-5 w-5")}${bar("mb-1 h-3 w-full")}${bar("mb-2 h-3 w-2/3")}${bar("h-2.5 w-1/2")}
      </div>`
    )}</div>`
  );
}

// Dashboard: three stat tiles, a chart block, four list rows.
export function skeletonDashboard() {
  return region(
    `<div class="grid grid-cols-3 gap-2">${times(3, () => `<div class="card space-y-2 p-3">${bar("h-2.5 w-2/3")}${bar("h-5 w-1/2")}</div>`)}</div>
    <div class="card mt-3 p-4">${bar("mb-3 h-3 w-1/3")}${bar("h-40 w-full rounded-xl")}</div>
    <div class="card mt-3 divide-y divide-hairline p-0">${times(
      4,
      () => `<div class="flex items-center justify-between gap-3 px-4 py-3">${bar("h-3 w-2/5")}${bar("h-3 w-1/5")}</div>`
    )}</div>`
  );
}

// Tables (report, day grid, document proposal).
export function skeletonTable(rows = 6, cols = 4) {
  return region(
    `<div class="card space-y-2.5 p-3">${bar("h-3 w-1/3")}${times(
      rows,
      () => `<div class="grid gap-2" style="grid-template-columns:2fr repeat(${cols - 1}, 1fr)">${times(cols, () => `<div data-skel-item class="skeleton h-4"></div>`)}</div>`
    )}</div>`
  );
}

// Month calendar: 7 x 5 day cells.
export function skeletonCalendar() {
  return region(`<div class="grid grid-cols-7 gap-1.5 p-2">${times(35, () => `<div data-skel-item class="skeleton h-9"></div>`)}</div>`);
}
