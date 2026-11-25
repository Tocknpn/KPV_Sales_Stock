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

// SKU types are editable, so a type outside the original four takes the next
// colour from this ordered fallback set.
const EXTRA_CATEGORY_COLORS = ["#2563eb", "#65a30d", "#c026d3", "#0891b2", "#ea580c", "#475569"];

export function categoryColor(category, index) {
  return CATEGORY_COLORS[category] ?? EXTRA_CATEGORY_COLORS[index % EXTRA_CATEGORY_COLORS.length];
}

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
export function renderCapacityBar(container, segments, unitLabel = "") {
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
      <span class="text-gray-600">${fmtPct(seg.pct, 0)} · ${seg.count.toLocaleString()} ${unitLabel}</span>
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

// ---------------------------------------------------------------------------
// Executive dashboard charts
// ---------------------------------------------------------------------------
// Runway bands, validated with the dataviz validate_palette.js script (light
// mode, white surface): all PASS, worst adjacent CVD ΔE 13.2, normal 17.3.
// "No sales data" is not a state but missing information: neutral grey plus a
// hatch, so it never reads as a status colour. Every band also carries a text
// label in the legend; colour is never the only cue.
export const BAND_COLORS = {
  critical: "#c8301e",
  warning: "#e0a100",
  ok: "#17915f",
  long: "#5a93dc",
  no_sales: "#3a5aa8",
  unknown: "#d1d5db",
};
// The single-series bar colour (brand maroon).
export const BAR_COLOR = "#990000";

const HATCH = "repeating-linear-gradient(135deg, #d1d5db 0 4px, #eceef1 4px 7px)";
export function bandFill(band) {
  return band === "unknown" ? HATCH : BAND_COLORS[band];
}

// One tooltip per chart container: any element with data-tip shows it on
// hover or keyboard focus, positioned above the mark.
export function attachTips(container) {
  if (!container) return;
  container.style.position = container.style.position || "relative";
  let tip = container.querySelector(":scope > .chart-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.setAttribute("role", "tooltip");
    container.appendChild(tip);
  }
  const show = (el) => {
    tip.innerHTML = el.dataset.tip;
    tip.style.display = "block";
    const box = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.min(Math.max(r.left - box.left + r.width / 2 - w / 2, 0), box.width - w);
    tip.style.left = `${left}px`;
    tip.style.top = `${r.top - box.top - tip.offsetHeight - 6}px`;
  };
  const hide = () => (tip.style.display = "none");
  container.querySelectorAll("[data-tip]").forEach((el) => {
    el.addEventListener("mouseenter", () => show(el));
    el.addEventListener("mouseleave", hide);
    el.addEventListener("focus", () => show(el));
    el.addEventListener("blur", hide);
  });
}

/**
 * Runway ribbon: stock value split by days-of-cover band. A band with value
 * keeps at least 1.5% width so a small one can still be seen and hovered.
 * `segments`: [{ band, pct, tip }]
 */
export function ribbonHtml(segments) {
  const shown = segments.filter((s) => s.pct > 0);
  const floor = 1.5;
  const raw = shown.map((s) => Math.max(s.pct, floor));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return `<div class="flex h-7 w-full gap-[2px] overflow-hidden rounded-md" role="img">
    ${shown
      .map(
        (s, i) => `<span tabindex="0" data-tip="${s.tip}" class="focus-ring block h-full first:rounded-l-md last:rounded-r-md" style="width:${(raw[i] / sum) * 100}%;background:${bandFill(s.band)}"></span>`
      )
      .join("")}
  </div>`;
}

/**
 * Daily columns (one series, brand colour) with an average reference line.
 * `days`: [{ label, value, tip }]
 */
export function dailyColumnsHtml(days, { avgLabel = "" } = {}) {
  const max = Math.max(1, ...days.map((d) => d.value));
  const avg = days.reduce((s, d) => s + d.value, 0) / (days.length || 1);
  const gap = days.length > 40 ? 1 : 2;
  return `<div>
    <div class="relative flex h-24 items-end" style="gap:${gap}px">
      ${days
        .map(
          (d) => `<span tabindex="0" data-tip="${d.tip}" class="focus-ring relative flex h-full flex-1 items-end">
            <span class="block w-full rounded-t-[3px] ${d.value > 0 ? "" : "bg-gray-200"}" style="height:${d.value > 0 ? Math.max(3, (d.value / max) * 100) : 2}%;${d.value > 0 ? `background:${BAR_COLOR}` : ""}"></span>
          </span>`
        )
        .join("")}
      ${avg > 0 ? `<div class="pointer-events-none absolute inset-x-0 border-t border-dashed border-gray-500" style="bottom:${(avg / max) * 100}%"><span class="absolute bottom-0.5 left-0 rounded bg-white/90 px-1 text-[10px] font-semibold text-gray-600">${avgLabel}</span></div>` : ""}
    </div>
    <div class="mt-1 flex justify-between text-[10px] font-medium tabular-nums text-gray-500"><span>${days[0]?.label ?? ""}</span><span>${days[days.length - 1]?.label ?? ""}</span></div>
  </div>`;
}

// A horizontal bar track, filled to pct (0..100). Single series.
export function barTrack(pct, color = BAR_COLOR) {
  return `<div class="h-2 w-full rounded-full bg-gray-100"><div class="h-full rounded-full" style="width:${Math.max(pct > 0 ? 1.5 : 0, Math.min(100, pct))}%;background:${color}"></div></div>`;
}
