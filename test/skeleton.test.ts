import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser ES module without types
import { skeletonCards, skeletonList, skeletonGrid, skeletonDashboard, skeletonTable, skeletonCalendar } from "../public/js/skeleton.js";

const count = (html: string, marker: string) => html.split(marker).length - 1;

describe("skeletons", () => {
  it.each([
    ["cards", skeletonCards()],
    ["list", skeletonList()],
    ["grid", skeletonGrid()],
    ["dashboard", skeletonDashboard()],
    ["table", skeletonTable()],
    ["calendar", skeletonCalendar()],
  ])("%s is a busy status region with a hidden label and shimmer blocks", (_name, html) => {
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain("skeleton");
  });

  it("draws the number of items asked for", () => {
    expect(count(skeletonCards(3), "data-skel-item")).toBe(3);
    expect(count(skeletonList(5), "data-skel-item")).toBe(5);
    expect(count(skeletonGrid(9), "data-skel-item")).toBe(9);
    expect(count(skeletonTable(2, 3), "data-skel-item")).toBe(6);
    expect(count(skeletonCalendar(), "data-skel-item")).toBe(35);
  });

  it("the SKU grid has three columns", () => {
    expect(skeletonGrid()).toContain("grid-cols-3");
  });
});
