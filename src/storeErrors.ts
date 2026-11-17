// How a StoreError (a database refusal) is answered to the client.
import type { StoreError, StoreErrorCode } from "./store";

const STATUS: Record<StoreErrorCode, number> = {
  DAY_LOCKED: 423,
  CONFLICT: 409,
  INVALID: 400,
  UNAVAILABLE: 503,
  NEGATIVE: 409,
  AUDIT_ACTOR_MISSING: 500,
  DENIED: 403,
  IMMUTABLE: 409,
  SCHEMA: 503,
};

const MESSAGE: Partial<Record<StoreErrorCode, string>> = {
  DAY_LOCKED: "This day is Done and locked for this Desk",
  UNAVAILABLE: "The database cannot be reached. Try again.",
  NEGATIVE: "This would make the stock negative",
  DENIED: "You are not allowed to do that",
  IMMUTABLE: "An assignment can only be ended, never rewritten",
  CONFLICT: "That already exists or was changed on another device",
  SCHEMA: "The database needs an update. Ask the admin to run the latest migrations.",
};

const CODE: Partial<Record<StoreErrorCode, string>> = {
  NEGATIVE: "NEGATIVE_CLOSING",
  DENIED: "ROLE_DENIED",
  IMMUTABLE: "ASSIGNMENT_IMMUTABLE",
  SCHEMA: "SCHEMA_OUTDATED",
};

export function storeErrorResponse(err: StoreError): { status: number; body: Record<string, unknown> } {
  return {
    status: STATUS[err.code],
    body: {
      error: MESSAGE[err.code] ?? "The database rejected that value",
      code: CODE[err.code] ?? err.code,
      ...(err.code === "NEGATIVE" && err.available !== undefined ? { available: err.available } : {}),
    },
  };
}
