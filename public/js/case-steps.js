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

// What tapping the card body does. It never starts a step: a done day opens in
// the day screen as usual (read-only, with Reopen for managers); every other
// case opens the same day screen in view mode, without the action footer. Only
// the card's Check in / Close day buttons open it with actions.
export function cardBodyAction(status) {
  return status === "done" ? "day" : "view";
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
