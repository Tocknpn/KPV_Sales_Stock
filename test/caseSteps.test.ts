import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser ES module without types
import { caseSteps, cardBodyAction, statusIcon } from "../public/js/case-steps.js";

describe("caseSteps", () => {
  it("not_started with no earlier open day: check in is the step", () => {
    expect(caseSteps({ status: "not_started", openEarlierDate: null })).toEqual({ checkIn: "active", close: "locked", badge: "alert", goToDate: null });
  });
  it("opening with no earlier open day: check in is the step", () => {
    expect(caseSteps({ status: "opening", openEarlierDate: null })).toEqual({ checkIn: "active", close: "locked", badge: "alert", goToDate: null });
  });
  it("any non-done card with an earlier open day points at that day", () => {
    for (const status of ["not_started", "opening", "check_in", "final_stock"]) {
      expect(caseSteps({ status, openEarlierDate: "2026-11-10" })).toEqual({ checkIn: "active", close: "locked", badge: "alert", goToDate: "2026-11-10" });
    }
  });
  it("check_in: check in done, close is the step", () => {
    expect(caseSteps({ status: "check_in", openEarlierDate: null })).toEqual({ checkIn: "done", close: "active", badge: "pending", goToDate: null });
  });
  it("final_stock: check in done, close is the step", () => {
    expect(caseSteps({ status: "final_stock", openEarlierDate: null })).toEqual({ checkIn: "done", close: "active", badge: "pending", goToDate: null });
  });
  it("done: everything done", () => {
    expect(caseSteps({ status: "done", openEarlierDate: null })).toEqual({ checkIn: "done", close: "done", badge: "done", goToDate: null });
  });
});

describe("cardBodyAction", () => {
  it("a done card body opens the read-only day", () => expect(cardBodyAction("done")).toBe("day"));
  it("every other status opens the day in view mode, never a step", () => {
    for (const s of ["not_started", "opening", "check_in", "final_stock"]) expect(cardBodyAction(s)).toBe("view");
  });
});

describe("statusIcon", () => {
  it("maps each badge to its glyph and tint", () => {
    expect(statusIcon("alert")).toEqual({ icon: "triangle", tone: "red" });
    expect(statusIcon("pending")).toEqual({ icon: "clock", tone: "amber" });
    expect(statusIcon("done")).toEqual({ icon: "check", tone: "green" });
  });
  it("follows caseSteps for every status", () => {
    expect(statusIcon(caseSteps({ status: "not_started", openEarlierDate: null }).badge).icon).toBe("triangle");
    expect(statusIcon(caseSteps({ status: "check_in", openEarlierDate: null }).badge).icon).toBe("clock");
    expect(statusIcon(caseSteps({ status: "done", openEarlierDate: null }).badge).icon).toBe("check");
  });
});
