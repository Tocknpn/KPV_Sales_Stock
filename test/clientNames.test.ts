// The browser files have no build step, so a name used out of its scope only
// fails when someone clicks. TypeScript's checker (on the plain JS) finds those:
// this test fails on any "Cannot find name" (TS2304) in the SKU screens.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const FILES = ["public/js/views/sku-picker.js", "public/js/views/settings/sku.js", "public/js/sku-xlsx.js"];

describe("client files", () => {
  it("use no undefined names", () => {
    let out = "";
    try {
      execFileSync(
        process.execPath,
        [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "--allowJs", "--checkJs", "--noEmit", "--target", "es2022", "--module", "es2022", "--moduleResolution", "bundler", "--lib", "es2022,dom", ...FILES],
        { encoding: "utf8", stdio: "pipe" }
      );
    } catch (e: any) {
      out = String(e.stdout ?? "");
    }
    expect(out.split("\n").filter((l) => l.includes("TS2304"))).toEqual([]);
  }, 60000);
});
