// Linked Transfer-out (to a desk in another branch) and Move (to another desk
// in the same branch). The sender's row carries the quantity in transfer_out /
// move immediately; the gold is "in transit" until the receiving desk confirms,
// which credits that desk's transfer_in on its open day. Neither side's
// closing is ever blocked by the other.
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, readBody, HttpError, scopeBranch, requireDesk, requireDate, requireOpenDay } from "../app";
import { assertBranchAccess } from "../auth";
import { businessDate } from "../time";
import { computeClosing, parseQty } from "../logic";

const r = newRouter();

// Every active desk in the company — the destination picker. Desk names are
// not sensitive, and staff must be able to send to another branch.
r.get("/transfers/destinations", async (c) => {
  const store = storeFor(c);
  const [desks, branches] = await Promise.all([store.desks(), store.branches()]);
  const branchName = new Map(branches.map((b) => [b.branch_id, b]));
  return c.json({
    desks: desks
      .filter((d) => d.active)
      .map((d) => ({
        desk_id: d.desk_id,
        display_name: d.display_name,
        branch_id: d.branch_id,
        branch_name: branchName.get(d.branch_id)?.name_en ?? d.branch_id,
        branch_name_lo: branchName.get(d.branch_id)?.name_lo ?? null,
      })),
  });
});

r.get("/transfers", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const status = c.req.query("status");
  const [transfers, skus] = await Promise.all([
    store.transfers({ branchId, status: status === "in_transit" || status === "received" || status === "cancelled" ? status : undefined }),
    store.skus(),
  ]);
  const skuName = new Map(skus.map((s) => [s.sku_id, s.name_en]));
  return c.json({ transfers: transfers.slice(0, 200).map((t) => ({ ...t, name_en: skuName.get(t.sku_id) ?? t.sku_id })) });
});

r.post("/transfers", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  const from = await requireDesk(store, user, String(body.fromDeskId ?? ""));
  await requireOpenDay(store, user, from.desk_id, date, today);

  const to = (await store.desks()).find((d) => d.desk_id === body.toDeskId);
  if (!to || !to.active) throw new HttpError(400, "Unknown destination desk", "BAD_DESTINATION");
  if (to.desk_id === from.desk_id) throw new HttpError(400, "Destination must be a different desk", "SAME_DESK");

  const qty = parseQty(body.qty);
  if (qty === null || qty === 0) throw new HttpError(400, "Quantity must be a whole number above 0", "BAD_QTY");
  const skuId = String(body.skuId ?? "");
  const row = (await store.ledger({ date, deskId: from.desk_id })).find((x) => x.sku_id === skuId && !x.excluded);
  if (!row) throw new HttpError(400, "That item is not on this desk today", "ROW_NOT_FOUND");
  const available = computeClosing(row);
  if (qty > available) throw new HttpError(409, `Only ${available} pcs available to send`, "NOT_ENOUGH_STOCK", { available });

  // Same branch = Move, another branch = Transfer-out.
  const kind = to.branch_id === from.branch_id ? "move" : "transfer";
  const transfer = await store.createTransfer({
    kind,
    from_desk_id: from.desk_id,
    from_branch_id: from.branch_id,
    to_desk_id: to.desk_id,
    to_branch_id: to.branch_id,
    sku_id: skuId,
    qty,
    sent_date: date,
    sent_by: user.accountId,
  });
  try {
    const key = { ledger_date: date, desk_id: from.desk_id, sku_id: skuId };
    const applied = await store.ledgerAdd(key, kind === "move" ? "move" : "transfer_out", qty, user.accountId);
    if (applied === null) throw new HttpError(409, "That item is no longer on this desk today", "ROW_NOT_FOUND");
  } catch (err) {
    // The sender's stock was not reduced, so the transfer must not exist.
    await store.updateTransfer(transfer.id, { status: "cancelled" }, "in_transit");
    throw err;
  }
  return c.json(transfer);
});

// Sender takes back a transfer that has not been received yet.
r.post("/transfers/:id/cancel", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const today = businessDate(c.env);
  const transfer = await store.getTransfer((c.req.param("id") ?? ""));
  if (!transfer) throw new HttpError(404, "Transfer not found", "NOT_FOUND");
  if (!assertBranchAccess(user, transfer.from_branch_id)) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
  if (transfer.status !== "in_transit") throw new HttpError(409, `This transfer is already ${transfer.status}`, "NOT_IN_TRANSIT");
  // The quantity sits in the sender's row for sent_date, so that day must still be open.
  await requireOpenDay(store, user, transfer.from_desk_id, transfer.sent_date, today);

  const cancelled = await store.updateTransfer(transfer.id, { status: "cancelled" }, "in_transit");
  if (!cancelled) throw new HttpError(409, "This transfer was just received or cancelled on another device", "STALE");
  try {
    const key = { ledger_date: transfer.sent_date, desk_id: transfer.from_desk_id, sku_id: transfer.sku_id };
    await store.ledgerAdd(key, transfer.kind === "move" ? "move" : "transfer_out", -transfer.qty, user.accountId);
  } catch (err) {
    await store.updateTransfer(transfer.id, { status: "in_transit" }, "cancelled");
    throw err;
  }
  return c.json({ ok: true });
});

// Receiving desk confirms the gold arrived. It lands on the desk's open day.
r.post("/transfers/:id/receive", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  const transfer = await store.getTransfer((c.req.param("id") ?? ""));
  if (!transfer) throw new HttpError(404, "Transfer not found", "NOT_FOUND");
  if (!assertBranchAccess(user, transfer.to_branch_id)) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
  if (transfer.status !== "in_transit") throw new HttpError(409, `This transfer is already ${transfer.status}`, "NOT_IN_TRANSIT");
  if (date < transfer.sent_date) throw new HttpError(409, "A transfer cannot be received before it was sent", "BEFORE_SENT");
  const to = await requireDesk(store, user, transfer.to_desk_id);
  await requireOpenDay(store, user, to.desk_id, date, today);

  const received = await store.updateTransfer(transfer.id, { status: "received", received_date: date, received_by: user.accountId }, "in_transit");
  if (!received) throw new HttpError(409, "This transfer was just received or cancelled on another device", "STALE");
  try {
    const key = { ledger_date: date, desk_id: to.desk_id, sku_id: transfer.sku_id };
    await store.insertLedgerRows([{ ...key, branch_id: to.branch_id, opening_qty: 0, performed_by: user.accountId }]);
    const applied = await store.ledgerAdd(key, "transfer_in", transfer.qty, user.accountId);
    if (applied === null) throw new Error("Receiving row could not be created");
  } catch (err) {
    await store.updateTransfer(transfer.id, { status: "in_transit", received_date: null, received_by: null }, "received");
    throw err;
  }
  return c.json({ ok: true });
});

export default r;
