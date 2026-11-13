export function toast(message, tone = "default", ms = 2200) {
  const host = document.getElementById("toast");
  const toneCls =
    tone === "success"
      ? "bg-success text-white"
      : tone === "error"
      ? "bg-danger text-white"
      : "bg-gray-900 text-white";
  const el = document.createElement("div");
  el.className = `pointer-events-auto rounded-full px-4 py-2.5 text-sm font-semibold shadow-pop ${toneCls} transition-opacity duration-300`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("opacity-100"));
  setTimeout(() => {
    el.classList.add("opacity-0");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

const sheetHost = () => document.getElementById("sheet-host");

// Remembers the element that had focus before a sheet opened, so closing it
// (Escape, backdrop tap, the X button, or a completed action) returns focus
// there instead of dropping it back to <body> — required for a screen-reader
// or keyboard-only user to keep their place in the page.
let lastFocusedBeforeSheet = null;

function trapFocus(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSheet();
    return;
  }
  if (e.key !== "Tab") return;
  const host = sheetHost();
  const focusable = host.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export function openSheet(innerHtml, { onMount, title, anchorEl } = {}) {
  const host = sheetHost();
  lastFocusedBeforeSheet = document.activeElement;
  // Anchored sheets (e.g. a dropdown-style trigger) open with their top edge
  // level with the trigger instead of sliding up from the bottom — keeps the
  // user's eye/focus point on screen instead of jumping it down to whatever
  // height the content happens to be.
  const anchorTop = anchorEl ? Math.max(12, anchorEl.getBoundingClientRect().top) : null;
  const panelClass =
    anchorTop != null
      ? "absolute inset-x-0 mx-auto flex max-h-[80vh] w-full max-w-[430px] flex-col rounded-3xl bg-white shadow-pop"
      : "absolute inset-x-0 bottom-0 mx-auto flex max-h-[92vh] w-full max-w-[430px] flex-col rounded-t-3xl bg-white shadow-pop";
  const panelStyle = anchorTop != null ? `style="top:${anchorTop}px"` : "";
  host.innerHTML = `
    <div class="absolute inset-0 bg-gray-900/40" data-close></div>
    <div class="${panelClass}" ${panelStyle}
         role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1">
      <div class="flex items-center justify-between border-b border-hairline px-5 py-4">
        <h2 id="sheet-title" class="text-base font-bold text-gray-900">${title ?? ""}</h2>
        <button data-close aria-label="Close" class="focus-ring tap-target -mr-2 flex items-center justify-center rounded-full text-gray-600">
          <svg class="h-5 w-5 md:h-6 md:w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="flex-1 overflow-y-auto px-5 py-4 no-scrollbar" id="sheet-body">${innerHtml}</div>
    </div>`;
  host.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  host.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSheet));
  host.addEventListener("keydown", trapFocus);
  if (onMount) onMount(host.querySelector("#sheet-body"));
  // Move focus into the dialog so a keyboard/screen-reader user lands inside
  // it rather than on whatever was behind it. The panel itself is the
  // fallback focus target (tabindex="-1" above) when the content has no
  // natively focusable element yet.
  const firstFocusable = host.querySelector(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  (firstFocusable || host.querySelector('[role="dialog"]'))?.focus();
}

export function closeSheet() {
  const host = sheetHost();
  host.removeEventListener("keydown", trapFocus);
  host.classList.add("hidden");
  host.innerHTML = "";
  document.body.style.overflow = "";
  lastFocusedBeforeSheet?.focus?.();
  lastFocusedBeforeSheet = null;
}

export function openActionSheet(title, options, onPick) {
  const rows = options
    .map(
      (opt, i) => `
      <button data-pick="${i}" class="focus-ring tap-target flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-sm font-semibold text-gray-800 active:bg-gray-50">
        <span>${opt.label}</span>
        ${opt.selected ? '<svg class="h-5 w-5 text-brand-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>' : ""}
      </button>`
    )
    .join("");
  openSheet(`<div class="flex flex-col gap-0.5 pb-2">${rows}</div>`, {
    title,
    onMount: (body) => {
      body.querySelectorAll("[data-pick]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.pick);
          closeSheet();
          onPick(options[idx], idx);
        });
      });
    },
  });
}

export function chip(label, active, extra = "") {
  return `<button class="chip ${extra} ${active ? "border-brand-600 bg-brand-600 text-white" : "border-hairline bg-white text-gray-600"}">${label}</button>`;
}

export function pillDot(color) {
  return `<span class="h-1.5 w-1.5 rounded-full" style="background:${color}"></span>`;
}

// Toast with one action button that disappears after `ms` (default 6 s).
export function toastAction(message, actionLabel, onAction, ms = 6000) {
  const host = document.getElementById("toast");
  const el = document.createElement("div");
  el.className = "pointer-events-auto flex max-w-full items-center gap-3 rounded-2xl bg-gray-900 py-1 pl-4 pr-1 text-sm font-semibold text-white shadow-pop";
  const msg = document.createElement("span");
  msg.className = "min-w-0 break-words py-2";
  msg.textContent = message;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tap-target shrink-0 rounded-full px-4 font-extrabold text-brand-100 underline";
  btn.textContent = actionLabel;
  el.append(msg, btn);
  host.appendChild(el);
  let timer = setTimeout(() => el.remove(), ms);
  btn.addEventListener("click", async () => {
    clearTimeout(timer);
    btn.disabled = true;
    try {
      await onAction();
    } finally {
      el.remove();
    }
  });
  return el;
}
