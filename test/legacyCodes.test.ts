import { describe, expect, it } from "vitest";
import { branchAliases, deskAliases, currentDeskId } from "../src/legacyCodes";
import { reopenedDatesFrom } from "../src/audit";

describe("renamed branch codes (B-TS -> B-VTC, 2026-11-17)", () => {
  it("a renamed branch / case also matches its old code", () => {
    expect(branchAliases("B-VTC")).toEqual(["B-VTC", "B-TS"]);
    expect(branchAliases("B-MM")).toEqual(["B-MM"]);
    expect(deskAliases("VTC-D03")).toEqual(["VTC-D03", "TS-D03"]);
    expect(deskAliases("MM-D01")).toEqual(["MM-D01"]);
    expect(currentDeskId("TS-D03")).toBe("VTC-D03");
    expect(currentDeskId("MM-D01")).toBe("MM-D01");
  });

  it("a reopen logged under the old case code still marks the renamed case", () => {
    const entry = {
      table_name: "desk_days",
      op: "UPDATE",
      desk_id: "TS-D01",
      row_key: { ledger_date: "2026-11-10" },
      old_values: { status: "done" },
      new_values: { status: "check_in" },
      created_at: "2026-11-11T03:00:00Z",
    } as any;
    const out = reopenedDatesFrom([entry], ["VTC-D01"], "2026-11-01", "2026-11-30");
    expect([...(out.get("VTC-D01") ?? [])]).toEqual(["2026-11-10"]);
  });
});
