// A live database that is missing a migration answers PostgREST "unknown
// column / function" errors. Those must reach the user as "the database needs
// an update", not as a generic server error.
import { afterEach, describe, expect, it } from "vitest";
import { getStore, StoreError } from "../src/store";
import { storeErrorResponse } from "../src/storeErrors";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

function stubSupabase(status: number, body: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as any;
  return getStore({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" } as any, { id: "u1" });
}

describe("missing-migration errors", () => {
  it.each([
    ["PGRST204", 400, "Could not find the 'initial_stock' column of 'desks' in the schema cache"],
    ["42703", 400, 'column "password_plain" does not exist'],
    ["PGRST202", 404, "Could not find the function public.ledger_apply"],
    ["42883", 404, "function ledger_apply(date, text) does not exist"],
  ])("Supabase %s becomes StoreError SCHEMA", async (code, status, message) => {
    const store = stubSupabase(status, { code, message });
    await expect(store.createStaffAccount({} as any)).rejects.toMatchObject({ code: "SCHEMA" });
  });

  it("an unmapped Supabase error is still a plain Error", async () => {
    const store = stubSupabase(500, { code: "XX000", message: "internal" });
    const err = await store.createStaffAccount({} as any).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StoreError);
  });

  it("SCHEMA answers 503 SCHEMA_OUTDATED", () => {
    expect(storeErrorResponse(new StoreError("SCHEMA" as any, "x"))).toEqual({
      status: 503,
      body: { code: "SCHEMA_OUTDATED", error: "The database needs an update. Ask the admin to run the latest migrations." },
    });
  });

  it("NEGATIVE still answers 409 NEGATIVE_CLOSING with available", () => {
    expect(storeErrorResponse(new StoreError("NEGATIVE", "x", 4))).toEqual({
      status: 409,
      body: { code: "NEGATIVE_CLOSING", available: 4, error: "This would make the stock negative" },
    });
  });
});
