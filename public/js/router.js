// Path routing. Every screen has a URL, so a refresh stays where it was and
// the phone's Back gesture walks back through screens.
//
//   /daily_stock                              case cards
//   /daily_stock/<deskId>?date=…&tab=history  one case on one date
//   /documents  /dashboard  /report
//   /settings   /settings/<section>
//
// Back order: an open bottom sheet closes first (ui.js pushes an entry for
// it), then a case or settings section returns to its list, then the
// previous section.

const VIEW_PATH = { stock: "daily_stock", documents: "documents", dashboard: "dashboard", report: "report", settings: "settings" };
const PATH_VIEW = Object.fromEntries(Object.entries(VIEW_PATH).map(([view, path]) => [path, view]));

/** @returns {{view: string, sub: string|null, params: URLSearchParams, known: boolean}} */
export function parseLocation(loc = window.location) {
  const parts = loc.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  const view = PATH_VIEW[parts[0]];
  return { view: view ?? "stock", sub: parts[1] ?? null, params: new URLSearchParams(loc.search), known: Boolean(view) };
}

export function pathFor(view, sub = null, params = {}) {
  let path = `/${VIEW_PATH[view] ?? VIEW_PATH.stock}`;
  if (sub) path += `/${encodeURIComponent(sub)}`;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") q.set(k, v);
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

const here = () => window.location.pathname + window.location.search;

/**
 * Changes the URL without reloading. `parent` is the list this screen came
 * from, so the in-app back arrow can step back in history instead of piling
 * up entries.
 */
export function go(path, { replace = false, parent = null } = {}) {
  const st = { app: true, parent };
  if (replace || path === here()) history.replaceState(st, "", path);
  else history.pushState(st, "", path);
}

/** Updates query parameters in place (null removes one). */
export function replaceQuery(patch) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  history.replaceState(history.state, "", url.pathname + url.search);
}

/**
 * The in-app back arrow: when this screen was opened from `parentPath`, step
 * back in history (the popstate handler renders it); otherwise replace the URL
 * and render the parent directly.
 */
export function backTo(parentPath, render) {
  if (history.state?.parent === parentPath && !history.state?.sheet) {
    history.back();
    return;
  }
  go(parentPath, { replace: true });
  return render();
}

// --- bottom sheets -----------------------------------------------------------
// Opening a sheet pushes an entry (same URL) so Back closes it. Closing it from
// the page pops that entry again, deferred one tick so a sheet that opens right
// after (an action sheet's choice) reuses the entry instead of racing it.
let ignorePops = 0;

export function sheetOpened() {
  if (history.state?.sheet) return;
  history.pushState({ ...(history.state ?? {}), sheet: true }, "", here());
}

export function sheetClosed(isOpen) {
  setTimeout(() => {
    if (isOpen() || !history.state?.sheet) return;
    ignorePops++;
    history.back();
  }, 0);
}

/**
 * @param {(route: ReturnType<typeof parseLocation>) => void} onRoute
 * @param {{isSheetOpen: () => boolean, closeSheet: () => void}} sheets
 */
export function listen(onRoute, sheets) {
  window.addEventListener("popstate", () => {
    if (ignorePops > 0) {
      ignorePops--;
      return;
    }
    if (sheets.isSheetOpen()) {
      sheets.closeSheet({ fromHistory: true });
      return;
    }
    onRoute(parseLocation());
  });
}
