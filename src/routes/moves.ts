// Same-branch Move: gold goes from one case to another in a single atomic step.
// Both cases change at once (source `move`, destination `transfer_in`), nothing
// is ever "in transit", and a retry with the same clientRef changes nothing twice.
// Cross-branch transfers keep their send / receive flow in routes/transfers.ts.
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, readBody, HttpError, requireDesk, requireDate, requireOpenDay } from "../app";
import { assertBranchAccess } from "../auth";
import { businessDate } from "../time";
import { parseQty } from "../logic";
import { checkInDesk } from "./stock";
import type { MoveResult } from "../store";

const r = newRouter();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINES = 100;

const REFUSAL_STATUS: Record<string, number> = {
  NOT_ENOUGH_STOCK: 409,
  DEST_NOT_OPEN: 409,
  NOT_CHECKED_IN: 409,
  ALREADY_UNDONE: 409,
  DEST_DAY_LOCKED: 423,
  DAY_LOCKED: 423,
  OTHER_BRANCH: 400,
  SAME_DESK: 400,
  BAD_QTY: 400,
  NOT_A_MOVE: 400,
  DESK_NOT_FOUND: 404,
  NOT_FOUND: 404,
};
const REFUSAL_TEXT: Record<string, string> = {
  NOT_ENOUGH_STOCK: "Not enough stock in the source case",
  DEST_NOT_OPEN: "The destination case has not been checked in",
  NOT_CHECKED_IN: "This desk has not been checked in for that date",
  ALREADY_UNDONE: "This move was already undone",
  DEST_DAY_LOCKED: "The destination case's day is Done and locked",
  DAY_LOCKED: "This day is Done and locked for this Desk",
  OTHER_BRANCH: "A move stays inside one branch. Use a transfer for another branch",
  SAME_DESK: "Destination must be a different desk",
  BAD_QTY: "Quantity must be a whole number above 0",
  NOT_A_MOVE: "That is not a move",
  DESK_NOT_FOUND: "Desk not found",
  NOT_FOUND: "Move not found",
};

function respond(result: MoveResult) {
  if (result.ok) return result;
  throw new HttpError(REFUSAL_STATUS[result.code] ?? 409, REFUSAL_TEXT[result.code] ?? "The move was refused", result.code, {
    ...(result.skuId !== undefined ? { skuId: result.skuId } : {}),
    ...(result.available !== undefined ? { available: result.available } : {}),
  });
}

r.post("/moves", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);

  const clientRef = String(body.clientRef ?? "");
  if (!UUID.test(clientRef)) throw new HttpError(400, "clientRef must be a UUID", "BAD_CLIENT_REF");
  if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > MAX_LINES) {
    throw new HttpError(400, "A move needs between 1 and 100 lines", "BAD_QTY");
  }
  const lines = body.lines.map((l: Record<string, unknown>) => {
    const qty = parseQty(l?.qty);
    if (qty === null || qty === 0) throw new HttpError(400, "Quantity must be a whole number above 0", "BAD_QTY", { skuId: l?.skuId ?? null });
    return { skuId: String(l?.skuId ?? ""), qty };
  });

  const from = await requireDesk(store, user, String(body.fromDeskId ?? ""));
  // The destination only needs to be in the same branch, which the source
  // check already proved the user may act on.
  const to = (await store.desks()).find((d) => d.desk_id === body.toDeskId);
  if (!to || !to.active) throw new HttpError(400, "Unknown destination desk", "BAD_DESTINATION");
  if (to.desk_id === from.desk_id) throw new HttpError(400, REFUSAL_TEXT.SAME_DESK, "SAME_DESK");
  if (to.branch_id !== from.branch_id) throw new HttpError(400, REFUSAL_TEXT.OTHER_BRANCH, "OTHER_BRANCH");

  await requireOpenDay(store, user, from.desk_id, date, today);
  const note = body.note ? String(body.note).slice(0, 200) : undefined;

  // The destination case is checked in on demand, carrying its stock forward.
  try {
    await checkInDesk(store, user, to, date, today);
  } catch (err) {
    if (err instanceof HttpError && err.code === "EARLIER_DAY_OPEN") {
      throw new HttpError(409, `Finish ${err.extra?.openDate} on the destination case first`, "DEST_NOT_OPEN", err.extra);
    }
    throw err;
  }

  return c.json(respond(await store.moveStock({ date, fromDeskId: from.desk_id, toDeskId: to.desk_id, lines, clientRef, note })));
});

// Puts a whole move back, on the move's own date. Both days must still be open
// and the pieces must still be in the case they went to.
r.post("/moves/:ticketId/undo", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const ticketId = c.req.param("ticketId") ?? "";
  const clientRef = String(body.clientRef ?? "");
  if (!UUID.test(clientRef)) throw new HttpError(400, "clientRef must be a UUID", "BAD_CLIENT_REF");

  const original = UUID.test(ticketId) ? await store.transfers({ ticketId }) : [];
  const first = original[0];
  if (!first) throw new HttpError(404, REFUSAL_TEXT.NOT_FOUND, "NOT_FOUND");
  if (!assertBranchAccess(user, first.from_branch_id)) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
  await requireOpenDay(store, user, first.to_desk_id, first.sent_date, today);

  return c.json(respond(await store.undoMove(ticketId, clientRef)));
});

export default r;
