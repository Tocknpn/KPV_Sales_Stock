// The app shell is called "KPV Stock Tracking" (decided 2026-11-17).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FILES = ["public/index.html", "index.html", "public/manifest.webmanifest", "package.json", "public/js/i18n.js"];

describe("app name", () => {
  it("has no old name left in the app shell", () => {
    for (const f of FILES) {
      const text = read(f);
      expect(text, f).not.toContain("Goldsmith & Retail Inventory");
      expect(text, f).not.toContain("Goldsmith &amp; Retail Inventory");
      expect(text, f).not.toContain("KPV Inventory");
    }
  });

  it("uses KPV Stock Tracking for the title, manifest and login line", () => {
    expect(read("public/index.html")).toContain("<title>KPV Stock Tracking</title>");
    const manifest = JSON.parse(read("public/manifest.webmanifest"));
    expect(manifest.name).toBe("KPV Stock Tracking");
    expect(manifest.short_name).toBe("KPV Stock");
    const subtitles = [...read("public/js/i18n.js").matchAll(/"login\.subtitle": "([^"]*)"/g)].map((m) => m[1]);
    expect(subtitles).toHaveLength(2);
    for (const s of subtitles) expect(s.startsWith("KPV Stock Tracking — ")).toBe(true);
  });
});
