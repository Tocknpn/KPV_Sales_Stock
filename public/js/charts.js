import { fmtPct } from "./util.js";

// Categorical palette for the ornament-type donut — amber/teal/violet/rose,
// chosen and CVD-validated (dataviz skill: validate_palette.js, light mode,
// surface #faf8ff) so adjacent segments stay distinguishable to colorblind
// viewers: worst adjacent ΔE 13.6 (CVD) / 23.6 (normal vision). "Gold Bars"
// keeps literal amber on purpose post-rebrand (it's the material, not the
// brand chrome); the donut track/ring stays independent of canvas (#f1ede6
// below), so the maroon canvas swap doesn't revalidate this set.
export const CATEGORY_COLORS = {
  "Gold Bars": "#b45309",
  Necklaces: "#0d9488",
  Bracelets: "#7c3aed",
  "Rings & Accessories": "#e11d48",
};

const STATUS_COLORS = { success: "#10b981", warning: "#f59e0b", danger: "#ee552b" };

/**
 * Interactive SVG donut. `segments`: [{ label, value, pct, color }]
 */
export function renderDonut(container, segments, { centerLabel, centerValue } = {}) {
  const size = 180;
  const r = 70;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const gapDeg = 2.2; // visual gap between segments
  let cursor = -90; // start at 12 o'clock

  const arcs = segments
    .map((seg) => {
      const sweep = (seg.pct / 100) * 360 - gapDeg;
      const dash = (Math.max(sweep, 0) / 360) * circumference;
      const dashArray = `${dash} ${circumference - dash}`;
      const rotate = cursor + gapDeg / 2;
      cursor += (seg.pct / 100) * 360;
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="22"
        stroke-dasharray="${dashArray}" stroke-dashoffset="0" stroke-linecap="round"
        transform="rotate(${rotate} ${cx} ${cy})" data-seg="${seg.label}"
        class="donut-seg cursor-pointer transition-all" tabindex="0" role="button"
        aria-label="${seg.label}: ${fmtPct(seg.pct, 0)}"></circle>`;
    })
    .join("");

  container.innerHTML = `
    <div class="flex items-center gap-5">
      <div class="relative shrink-0" style="width:${size}px;height:${size}px">
        <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Category breakdown donut chart">
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f1ede6" stroke-width="22"/>
          ${arcs}
        </svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center" id="donut-center" aria-live="polite">
          <div class="text-lg font-extrabold leading-tight text-gray-900">${centerValue ?? ""}</div>
          <div class="text-[11px] font-medium text-gray-600">${centerLabel ?? ""}</div>
        </div>
      </div>
      <ul class="flex flex-1 flex-col gap-2.5" id="donut-legend">
        ${segments
          .map(
            (seg) => `
          <li data-seg="${seg.label}" class="donut-legend-item flex cursor-pointer items-center justify-between gap-2 rounded-lg px-1.5 py-1 transition">
            <span class="flex items-center gap-2 text-xs font-semibold text-gray-700">
              <span class="h-2.5 w-2.5 rounded-full" style="background:${seg.color}"></span>${seg.label}
            </span>
            <span class="text-xs font-bold text-gray-900">${fmtPct(seg.pct, 0)}</span>
          </li>`
          )
          .join("")}
      </ul>
    </div>`;

  const centerEl = container.querySelector("#donut-center");
  const highlight = (label) => {
    const seg = segments.find((s) => s.label === label);
    container.querySelectorAll(".donut-seg").forEach((el) => {
      el.style.opacity = !label || el.dataset.seg === label ? "1" : "0.25";
    });
    container.querySelectorAll(".donut-legend-item").forEach((el) => {
      el.classList.toggle("bg-gray-50", el.dataset.seg === label);
    });
    if (seg) {
      centerEl.innerHTML = `<div class="text-lg font-extrabold leading-tight text-gray-900">${fmtPct(seg.pct, 0)}</div><div class="text-[11px] font-medium text-gray-600">${seg.label}</div>`;
    } else {
      centerEl.innerHTML = `<div class="text-lg font-extrabold leading-tight text-gray-900">${centerValue ?? ""}</div><div class="text-[11px] font-medium text-gray-600">${centerLabel ?? ""}</div>`;
    }
  };
  container.querySelectorAll(".donut-seg, .donut-legend-item").forEach((el) => {
    el.addEventListener("mouseenter", () => highlight(el.dataset.seg));
    el.addEventListener("mouseleave", () => highlight(null));
    el.addEventListener("click", () => highlight(el.dataset.seg));
    el.addEventListener("focus", () => highlight(el.dataset.seg));
    el.addEventListener("blur", () => highlight(null));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        highlight(el.dataset.seg);
      }
    });
  });
}

/**
 * Horizontal cluster/comparison bars vs a 100% safety target reference line.
 * `rows`: [{ label, pct }]
 */
export function renderBranchClusterChart(container, rows) {
  const barsHtml = rows
    .map((row) => {
      const color = row.pct >= 90 ? STATUS_COLORS.success : row.pct >= 65 ? STATUS_COLORS.warning : STATUS_COLORS.danger;
      const widthPct = Math.min(100, row.pct);
      return `
      <div class="flex items-center gap-3" data-row>
        <div class="w-[92px] shrink-0 text-xs font-semibold leading-tight text-gray-600">${row.label}</div>
        <div class="relative flex-1 h-3 rounded-full bg-gray-100">
          <div class="absolute inset-y-0 left-0 rounded-full transition-all" style="width:${widthPct}%;background:${color}"></div>
          <div class="absolute inset-y-[-3px] border-l-2 border-dashed border-gray-300" style="left:100%"></div>
        </div>
        <div class="w-10 shrink-0 text-right text-xs font-extrabold" style="color:${color}">${fmtPct(row.pct, 0)}</div>
      </div>`;
    })
    .join("");
  container.innerHTML = `
    <div class="flex flex-col gap-3">${barsHtml}</div>
    <div class="mt-2 flex items-center justify-end gap-1.5 text-[11px] text-gray-600">
      <span class="inline-block h-0 w-3 border-t-2 border-dashed border-gray-300"></span> Safety target (100%)
    </div>`;
}

/**
 * Three-segment horizontal capacity/status bar.
 * `segments`: [{ label, pct, color }]  color is a hex.
 */
export function renderCapacityBar(container, segments) {
  const bar = segments
    .map(
      (seg, i) => `<div class="h-full transition-all" style="width:${seg.pct}%;background:${seg.color};${i > 0 ? "margin-left:2px" : ""}"></div>`
    )
    .join("");
  const legend = segments
    .map(
      (seg) => `
    <div class="flex items-center gap-1.5 text-xs text-gray-600">
      <span class="h-2 w-2 rounded-full" style="background:${seg.color}"></span>
      <span class="font-semibold">${seg.label}</span>
      <span class="text-gray-600">${fmtPct(seg.pct, 0)} · ${seg.count.toLocaleString()} SKUs</span>
    </div>`
    )
    .join("");
  container.innerHTML = `
    <div class="flex h-3.5 w-full overflow-hidden rounded-full bg-gray-100">${bar}</div>
    <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">${legend}</div>`;
}

export function renderFillBar(pct, color) {
  return `<div class="bottom-fill-bar"><div class="h-full rounded-full" style="width:${Math.max(2, pct)}%;background:${color}"></div></div>`;
}
