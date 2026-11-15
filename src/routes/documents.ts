// Documents (free-form records) and purchase proposals (documents that carry
// an approval status: pending -> approved / rejected, decided by an admin).
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, readBody, HttpError, scopeBranch, requireDate, audit } from "../app";
import { requireAdmin, assertBranchAccess } from "../auth";
import { businessDate, isValidDate } from "../time";
import { enrichDocuments } from "../logic";
import { renderDocumentSheet } from "../print/documentSheet";

const r = newRouter();

r.get("/documents", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const kind = c.req.query("kind");
  const status = c.req.query("status");
  const date = c.req.query("date");
  const page = Math.max(1, Math.floor(Number(c.req.query("page")) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(c.req.query("pageSize")) || 10)));
  const [{ rows, total }, branches, desks] = await Promise.all([
    store.documents({
      branchId: scopeBranch(user, c.req.query("branchId") || undefined),
      deskId: c.req.query("deskId") || undefined,
      date: isValidDate(date) ? date : undefined,
      kind: kind === "proposal" || kind === "document" ? kind : undefined,
      status: status === "pending" || status === "approved" || status === "rejected" ? status : undefined,
      page,
      pageSize,
    }),
    store.branches(),
    store.desks(),
  ]);
  return c.json({ documents: enrichDocuments(rows, branches, desks), total, page, pageSize });
});

function cleanNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

r.post("/documents", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const branchId = String(body.branchId ?? "");
  const [branches, desks, skus] = await Promise.all([store.branches(), store.desks(), store.skus()]);
  const skuIds = new Set(skus.map((s) => s.sku_id));
  if (!branches.some((b) => b.branch_id === branchId)) throw new HttpError(400, "Unknown branch", "BAD_BRANCH");
  if (!assertBranchAccess(user, branchId)) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
  const deskId = body.deskId ? String(body.deskId) : null;
  if (deskId && !desks.some((d) => d.desk_id === deskId && d.branch_id === branchId)) {
    throw new HttpError(400, "That desk does not belong to this branch", "DESK_NOT_IN_BRANCH");
  }
  const title = String(body.title ?? "").trim();
  if (!title) throw new HttpError(400, "Title is required", "TITLE_REQUIRED");
  const kind = body.kind === "proposal" ? "proposal" : "document";

  const rows = (Array.isArray(body.rows) ? body.rows : []).map((row: Record<string, unknown>, i: number) => ({
    sort_order: i,
    sku_id: typeof row?.sku_id === "string" && skuIds.has(row.sku_id) ? row.sku_id : null,
    item: String(row?.item ?? "").slice(0, 200),
    qty: cleanNumber(row?.qty),
    weight_g: cleanNumber(row?.weight_g),
    note: row?.note ? String(row.note).slice(0, 300) : null,
  }));

  const doc = await store.createDocument(
    {
      title: title.slice(0, 200),
      branch_id: branchId,
      desk_id: deskId,
      created_by: user.displayName,
      doc_date: requireDate(body.date, businessDate(c.env)),
      notes: body.notes ? String(body.notes).slice(0, 1000) : null,
      kind,
      status: kind === "proposal" ? "pending" : null,
      decided_by: null,
      decided_at: null,
    },
    rows
  );
  return c.json(enrichDocuments([doc], branches, desks)[0]);
});

// Admin approves or rejects a pending purchase proposal.
r.post("/documents/:id/decision", requireAdmin, async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const decision = body.decision;
  if (decision !== "approved" && decision !== "rejected") throw new HttpError(400, "Decision must be approved or rejected", "BAD_DECISION");
  const doc = await store.getDocument((c.req.param("id") ?? ""));
  if (!doc) throw new HttpError(404, "Document not found", "NOT_FOUND");
  if (doc.kind !== "proposal") throw new HttpError(409, "Only purchase proposals are approved", "NOT_A_PROPOSAL");
  const updated = await store.updateDocument(doc.id, { status: decision, decided_by: user.displayName, decided_at: new Date().toISOString() }, "pending");
  if (!updated) throw new HttpError(409, `This proposal is already ${doc.status}`, "ALREADY_DECIDED");
  await audit(store, user, `proposal.${decision}`, doc.doc_no, null, { branchId: doc.branch_id, deskId: doc.desk_id });
  return c.json({ ok: true, status: decision });
});

r.delete("/documents/:id", requireAdmin, async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const doc = await store.getDocument((c.req.param("id") ?? ""));
  if (!doc) throw new HttpError(404, "Document not found", "NOT_FOUND");
  await store.deleteDocument(doc.id);
  await audit(store, user, "document.delete", doc.doc_no, { title: doc.title, kind: doc.kind, rows: doc.rows?.length ?? 0 }, { branchId: doc.branch_id, deskId: doc.desk_id });
  return c.json({ ok: true });
});

// Printable sheet in the shop's case-sheet layout (see src/print/documentSheet.ts).
r.get("/documents/:id/print", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const raw = await store.getDocument((c.req.param("id") ?? ""));
  if (!raw) return c.text("Document not found", 404);
  if (!assertBranchAccess(user, raw.branch_id)) return c.text("Branch access denied", 403);
  const [branches, desks, skus, types] = await Promise.all([store.branches(), store.desks(), store.skus(), store.skuTypes()]);
  const doc = enrichDocuments([raw], branches, desks)[0];
  return c.html(renderDocumentSheet({ doc, skus, types }));
});

export default r;
