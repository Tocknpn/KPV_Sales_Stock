// The two steps of a case's day as the home card shows them. Pure, so it is unit-tested.
// card: { status, openEarlierDate }
// Returns each step as "active" | "done" | "locked", the status icon, and the earlier
// day to jump to when that day is still open (null otherwise).
export function caseSteps(card) {
  const { status, openEarlierDate } = card;
  if (status === "done") return { checkIn: "done", close: "done", badge: "done", goToDate: null };
  if (openEarlierDate) return { checkIn: "active", close: "locked", badge: "alert", goToDate: openEarlierDate };
  if (status === "check_in" || status === "final_stock") return { checkIn: "done", close: "active", badge: "pending", goToDate: null };
  return { checkIn: "active", close: "locked", badge: "alert", goToDate: null };
}

// What tapping the card body does: a done day opens read-only in the day screen
// (sales, count, history, reopen); a not-started case checks in; otherwise the
// opening-balance snapshot sheet.
export function cardBodyAction(status) {
  if (status === "done") return "day";
  if (status === "not_started") return "checkIn";
  return "openingSheet";
}

// The status icon on the home card: which glyph and tint a badge shows.
// alert (not checked in) = red triangle, pending (checked in) = amber clock, done = green check.
const STATUS_ICONS = {
  alert: { icon: "triangle", tone: "red" },
  pending: { icon: "clock", tone: "amber" },
  done: { icon: "check", tone: "green" },
};
export function statusIcon(badge) {
  return STATUS_ICONS[badge] ?? STATUS_ICONS.alert;
}
