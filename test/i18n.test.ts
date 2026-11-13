import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser ES module without types
import { tf, t } from "../public/js/i18n.js";

describe("tf", () => {
  it("substitutes placeholders from the dictionary template", () => {
    expect(tf("stock.tierOnTrackOpen", { time: "08:10" })).toContain("08:10");
    expect(tf("stock.tierOnTrackOpen", { time: "08:10" })).not.toContain("{time}");
    expect(tf("cases.takeOverConfirm", { name: "Noy" })).toContain("Noy");
  });

  it("inserts $& and other replacement patterns literally", () => {
    expect(tf("cases.takeOverConfirm", { name: "A$&B$1" })).toContain("A$&B$1");
  });

  it("does not re-scan a substituted value", () => {
    const out = tf("stock.tierOverdue", { n: "{date}", date: "8 Nov" });
    expect(out).toContain("{date}");
    expect(out).toContain("8 Nov");
    expect(out.indexOf("{date}")).toBeLessThan(out.indexOf("8 Nov"));
  });

  it("leaves unknown placeholders untouched", () => {
    expect(tf("stock.tierOnTrackOpen", {})).toContain("{time}");
    expect(t("stock.tierOnTrackOpen")).toContain("{time}");
  });
});
