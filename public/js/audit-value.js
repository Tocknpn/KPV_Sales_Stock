// Audit values a person can read: day statuses in words, timestamps as Laos
// DD/MM HH:mm. No DOM or network here, so it is unit-tested directly.
import { t } from "./i18n.js";
import { fmtLaosStamp } from "./util.js";

const STATUS_KEY = {
  not_started: "stock.statusNotStarted",
  check_in: "stock.statusCheckIn",
  final_stock: "stock.statusFinalStock",
  done: "stock.statusDone",
};

const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// The readable form of one audit value, or null when the caller's generic
// formatting should be used.
export function auditValue(key, v) {
  if (key === "status" && typeof v === "string" && STATUS_KEY[v]) return t(STATUS_KEY[v]);
  if (/_at$/.test(key) && typeof v === "string" && ISO_STAMP.test(v)) return fmtLaosStamp(v);
  return null;
}

// Keys whose value differs between the old and new row, in the given order.
export function changedKeys(keys, ov, nv) {
  return keys.filter((k) => JSON.stringify(ov[k] ?? null) !== JSON.stringify(nv[k] ?? null));
}
