// Branch codes that were renamed (decided 2026-11-17: Talat Sao B-TS became
// Vientiane Center B-VTC, its cases TS-Dxx became VTC-Dxx; migration 16).
// audit_log is append-only, so entries written before the rename still carry
// the old codes. History filters use these aliases so a branch's or case's
// history stays in one piece.
const RENAMED_BRANCHES: Record<string, string> = { "B-VTC": "B-TS" };
const RENAMED_DESK_PREFIXES: Record<string, string> = { "VTC-": "TS-" };

/** The branch code and any older code it replaced. */
export function branchAliases(branchId: string): string[] {
  const old = RENAMED_BRANCHES[branchId];
  return old ? [branchId, old] : [branchId];
}

/** The case code and any older code it replaced. */
export function deskAliases(deskId: string): string[] {
  for (const [now, old] of Object.entries(RENAMED_DESK_PREFIXES)) {
    if (deskId.startsWith(now)) return [deskId, old + deskId.slice(now.length)];
  }
  return [deskId];
}

/** The current code of a case code that may be an old one. */
export function currentDeskId(deskId: string): string {
  for (const [now, old] of Object.entries(RENAMED_DESK_PREFIXES)) {
    if (deskId.startsWith(old)) return now + deskId.slice(old.length);
  }
  return deskId;
}
