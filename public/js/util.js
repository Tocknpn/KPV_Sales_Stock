export function fmtInt(n) {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtBaht(n, digits = 1) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtLak(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `₭${(n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 1 })}B`;
  if (abs >= 1e6) return `₭${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  if (abs >= 1e3) return `₭${(n / 1e3).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
  return `₭${fmtInt(n)}`;
}

export function fmtLakSigned(n) {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${fmtLak(Math.abs(n))}`;
}

export function fmtUsd(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
  return `$${fmtInt(n)}`;
}

export function fmtPct(n, digits = 0) {
  return `${Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export function fmtDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const day = d.getDate();
  const suffix = day >= 11 && day <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";
  const month = d.toLocaleDateString("en-US", { month: "short" });
  return `${day}${suffix} ${month}`;
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export const ICONS = {
  bar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="9" rx="1.5"/><path stroke-linecap="round" d="M7 8l1.5-3h7L17 8"/></svg>`,
  necklace: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M5 4c0 6 3 10 7 10s7-4 7-10"/><circle cx="12" cy="16" r="2.3"/></svg>`,
  bracelet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.2"/></svg>`,
  ring: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="14" r="6"/><path stroke-linecap="round" stroke-linejoin="round" d="M9.5 8l1-4h3l1 4"/></svg>`,
  box: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l9-4 9 4-9 4-9-4z"/><path stroke-linecap="round" stroke-linejoin="round" d="M3 8v9l9 4 9-4V8M12 12v9"/></svg>`,
  bag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 8h12l1 12H5L6 8z"/><path stroke-linecap="round" d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>`,
  pen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 20l1-4L16 5l3 3-11 11-4 1z"/><path stroke-linecap="round" d="M14 7l3 3"/></svg>`,
  mug: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h11v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7z"/><path stroke-linecap="round" d="M15 9h2a2.5 2.5 0 0 1 0 5h-2"/></svg>`,
};

// Standard iOS-style switch. Deliberately has no `tap-target` class: that
// class sets `min-height/min-width: 44px`, which silently overrides the
// small h-*/w-* track size with a near-square box and breaks the pill shape
// (the knob then overlaps the track's rounded corner, rendering as a
// crescent instead of a dot-on-a-pill). The clickable row around it already
// gives this a large enough tap target.
export function toggleSwitch(on, extraAttrs = "") {
  return `
    <button ${extraAttrs} data-on="${on}" class="toggle-switch relative h-6 w-10 shrink-0 rounded-full transition-colors ${on ? "bg-brand-600" : "bg-gray-300"}">
      <span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}"></span>
    </button>`;
}

export function icon(name, cls = "h-5 w-5") {
  return `<span class="${cls} inline-flex">${ICONS[name] || ICONS.ring}</span>`;
}

export function statusPillClasses(status) {
  switch (status) {
    case "done":
      return "bg-success-bg text-success";
    case "final_stock":
      return "bg-warning-bg text-warning";
    case "check_in":
      return "bg-brand-100 text-brand-700";
    case "not_started":
    default:
      return "bg-gray-100 text-gray-500";
  }
}

export function varianceClasses(variance) {
  if (!variance) return "bg-gray-100 text-gray-500";
  return variance > 0 ? "bg-success-bg text-success" : "bg-danger-bg text-danger";
}

export function healthClasses(health) {
  switch (health) {
    case "Optimal":
      return { chip: "bg-success-bg text-success", bar: "#10b981" };
    case "Restock Needed":
      return { chip: "bg-warning-bg text-warning", bar: "#f59e0b" };
    case "Alert":
    default:
      return { chip: "bg-danger-bg text-danger", bar: "#ee552b" };
  }
}

// Laos wall-clock time (HH:MM) and calendar date of an ISO timestamp. This
// only formats a server-supplied instant; the client never decides "today".
export function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Vientiane" });
}

export function laosDateOf(iso) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Vientiane" });
}

export function flameIcon(cls = "h-3.5 w-3.5") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c.5 3-1 4.5-2.5 6.2C8 10 7 11.6 7 14a5 5 0 0 0 10 0c0-1.7-.7-3-1.6-4.2-.3 1-.9 1.7-1.7 2C14 9.5 13.4 5.2 12 2z"/></svg>`;
}
