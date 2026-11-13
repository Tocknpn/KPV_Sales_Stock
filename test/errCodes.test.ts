// Every error code the API can answer with must have a Lao and an English
// `err.<CODE>` message, or Lao users read the English fallback (or a bare code).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Codes the UI never shows as a message: internal, or handled before display.
const SKIP = new Set<string>([
  // none at the moment; add a code here only with a reason
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

// new HttpError(status, message, "CODE", ...): the message is a "string", a `template` or an expression.
const HTTP_ERROR = /new HttpError\(\s*[^,]+,\s*(?:`[^`]*`|"(?:[^"\\]|\\.)*"|[^,]+),\s*"([A-Z][A-Z0-9_]+)"/g;

function codesInSource(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(join(process.cwd(), "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(HTTP_ERROR)) if (!found.has(m[1])) found.set(m[1], file);
  }
  return found;
}

// The two language blocks of the dictionary: `lo: {` ... `en: {` ... end.
const i18n = readFileSync(join(process.cwd(), "public", "js", "i18n.js"), "utf8");
const enAt = i18n.indexOf("\n  en: {");
const sections = { lo: i18n.slice(0, enAt), en: i18n.slice(enAt) };
const has = (lang: "lo" | "en", code: string) => sections[lang].includes(`"err.${code}":`);

describe("err.* translations", () => {
  const codes = codesInSource();

  it("finds the codes it should (sanity check of the scan)", () => {
    expect(enAt).toBeGreaterThan(0);
    for (const known of ["BAD_QTY", "ROW_CHANGED", "NEXT_DAY_NEGATIVE", "USE_CHANGES"]) expect(codes.has(known), known).toBe(true);
    expect(codes.size).toBeGreaterThan(40);
  });

  it("every HttpError code has an err.<CODE> key in Lao and in English", () => {
    const missing: string[] = [];
    for (const [code, file] of codes) {
      if (SKIP.has(code)) continue;
      for (const lang of ["lo", "en"] as const) if (!has(lang, code)) missing.push(`${code} (${lang}) used in ${file}`);
    }
    expect(missing).toEqual([]);
  });

  it("the codes the store layer maps in src/index.ts are translated too", () => {
    for (const code of ["NEGATIVE_CLOSING", "ROLE_DENIED", "ASSIGNMENT_IMMUTABLE", "AUDIT_ACTOR_MISSING", "SERVER_ERROR"]) {
      expect(has("lo", code), `${code} lo`).toBe(true);
      expect(has("en", code), `${code} en`).toBe(true);
    }
  });
});
