// Documents and reorder proposals. A proposal carries an approval status
// (pending -> approved / rejected, decided by an admin). Only a branch manager
// (own branch) or an admin creates, edits or deletes proposals; staff view them.
// A manager may order several cases at once: one proposal per case, sharing a
// group id. One live (pending or approved) proposal per case per day.
// Mounted behind requireAuth in src/index.ts.
import { storeFor, newRouter, readBody, HttpError, scopeBranch, requireDate, audit, type Ctx } from "../app";
import { requireAdmin, requireManager, assertBranchAccess } from "../auth";
import { businessDate, isValidDate } from "../time";
import { enrichDocuments } from "../logic";
import { renderDocumentSheets } from "../print/documentSheet";
import { deskDetail } from "./stock";
import { resolveParams } from "../replenishment";
import type { Store, NewDocumentRow } from "../store";
import type { DocumentRecord, SessionUser } from "../types";

const r = newRouter();

const LIVE: ("pending" | "approved")[] = ["pending", "approved"];
const MAX_CASES = 30;

r.get("/documents", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const q = (k: string) => c.req.query(k) || undefined;
  const kind = q("kind");
  const status = q("status");
  const date = q("date");
  const dateFrom = q("dateFrom");
  const dateTo = q("dateTo");
  const page = Math.max(1, Math.floor(Number(q("page")) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(q("pageSize")) || 20)));
  const [{ rows, total }, branches, desks] = await Promise.all([
    store.documents({
      branchId: scopeBranch(user, q("branchId")),
      deskId: q("deskId"),
      date: isValidDate(date) ? date : undefined,
      dateFrom: isValidDate(dateFrom) ? dateFrom : undefined,
      dateTo: isValidDate(dateTo) ? dateTo : undefined,
      createdBy: q("createdBy"),
      groupId: q("groupId"),
      kind: kind === "proposal" || kind === "document" ? kind : undefined,
      status: status === "pending" || status === "approved" || status === "rejected" ? status : undefined,
      page,
      pageSize,
    }),
    store.branches(),
    store.desks(),
  ]);
  // How many cases each listed proposal's group holds ("Group of 3 · Print all").
  const groupIds = [...new Set(rows.map((d) => d.group_id).filter((g): g is string => Boolean(g)))];
  const groupSizes = new Map<string, number>();
  await Promise.all(
    groupIds.map(async (g) => {
      const res = await store.documents({ groupId: g, pageSize: MAX_CASES });
      groupSizes.set(g, res.total);
    })
  );
  const documents = enrichDocuments(rows, branches, desks).map((d) => ({ ...d, group_size: d.group_id ? groupSizes.get(d.group_id) ?? 1 : 1 }));
  return c.json({ documents, total, page, pageSize });
});

// The people who created documents in a branch (the "Created by" filter).
r.get("/documents/creators", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  return c.json({ creators: await store.documentCreators(scopeBranch(user, c.req.query("branchId") || undefined)) });
});

// The live proposal (if any) of each case of a branch on a date — the case
// picker greys these out and links to them.
r.get("/documents/proposal-taken", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const branchId = scopeBranch(user, c.req.query("branchId") || undefined);
  const date = requireDate(c.req.query("date"), businessDate(c.env));
  const { rows } = await store.documents({ branchId, date, kind: "proposal", statusIn: LIVE, pageSize: 100 });
  return c.json({
    taken: rows.filter((d) => d.desk_id).map((d) => ({ desk_id: d.desk_id, id: d.id, doc_no: d.doc_no, group_id: d.group_id ?? null, status: d.status })),
  });
});

// What a new proposal for one case lists: every SKU on the case's stock sheet
// that day, with the balance the manager orders against. Before the day's
// final count that is the opening; from final_stock on it is the closing. A
// day not opened yet uses the latest earlier day's closing.
r.get("/documents/proposal-source", async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const deskId = c.req.query("deskId") ?? "";
  const date = requireDate(c.req.query("date"), businessDate(c.env));
  let detail = await deskDetail(c, store, user, deskId, date);
  let source: "opening" | "closing" | "previous_closing" | "none";
  let sourceDate: string | null = date;
  if (detail.status !== "not_started") {
    source = detail.status === "opening" || detail.status === "check_in" ? "opening" : "closing";
  } else {
    const [previous] = await store.deskDays({ deskId, before: date, order: "desc", limit: 1 });
    if (previous) {
      detail = await deskDetail(c, store, user, deskId, previous.ledger_date);
      source = "previous_closing";
      sourceDate = previous.ledger_date;
    } else {
      source = "none";
      sourceDate = null;
    }
  }
  // Order lead time of every SKU at this branch (branch rule, else the default):
  // each ordered line arrives on proposal date + its lead time.
  const [existing, skus, rules, config, desks] = await Promise.all([liveProposal(store, deskId, date), store.skus(), store.rules(), store.config(), store.desks()]);
  const branchId = desks.find((d) => d.desk_id === deskId)?.branch_id ?? "";
  const leadDays: Record<string, number> = {};
  for (const sku of skus) leadDays[sku.sku_id] = resolveParams(sku, rules, config, branchId).lead.value;
  return c.json({
    desk_id: deskId,
    date,
    balance_source: source,
    balance_date: sourceDate,
    existing: existing ? { id: existing.id, doc_no: existing.doc_no, group_id: existing.group_id ?? null } : null,
    default_lead_days: config.default_lead_time_days,
    lead_days: leadDays,
    rows: detail.rows.map((row) => ({
      sku_id: row.sku_id,
      name_en: row.name_en,
      name_lo: row.name_lo,
      icon: row.icon,
      type_id: row.type_id,
      type_label: row.type_label,
      type_order: row.type_order,
      baht_weight: row.baht_weight,
      std_gram_weight: row.std_gram_weight,
      gram_each: row.gram_weight_each,
      balance: source === "opening" ? row.opening_qty : row.closing_qty,
      lead_days: leadDays[row.sku_id] ?? config.default_lead_time_days,
      branch_status: row.branch_status,
      min_qty: row.min_qty,
      short_by: row.short_by,
      order_eta: row.order_eta,
      detail: row.detail,
    })),
  });
});

function cleanNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cleanRows(raw: unknown, skuIds: Set<string>): NewDocumentRow[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 500).map((row: Record<string, unknown>, i: number) => ({
    sort_order: i,
    sku_id: typeof row?.sku_id === "string" && skuIds.has(row.sku_id) ? row.sku_id : null,
    item: String(row?.item ?? "").slice(0, 200),
    qty: cleanNumber(row?.qty),
    weight_g: cleanNumber(row?.weight_g),
    note: row?.note ? String(row.note).slice(0, 300) : null,
    balance: row?.balance === null || row?.balance === undefined || row?.balance === "" || !Number.isFinite(Number(row.balance)) ? null : Number(row.balance),
  }));
}

async function liveProposal(store: Store, deskId: string, date: string, exceptId?: string): Promise<DocumentRecord | null> {
  const { rows } = await store.documents({ deskId, date, kind: "proposal", statusIn: LIVE, pageSize: 10 });
  return rows.find((d) => d.id !== exceptId) ?? null;
}

function canManageBranch(user: SessionUser, branchId: string) {
  return (user.role === "admin" || user.role === "manager") && assertBranchAccess(user, branchId);
}

interface CaseInput {
  deskId: string;
  title: string;
  rows: NewDocumentRow[];
}

// Creates one proposal per case, all sharing a group id. Every check runs
// before anything is written; a failure part-way removes what was written.
async function createProposals(c: Ctx, body: Record<string, any>, cases: CaseInput[]) {
  const store = storeFor(c);
  const user = c.get("user");
  const branchId = String(body.branchId ?? "");
  const [branches, desks] = await Promise.all([store.branches(), store.desks()]);
  if (!branches.some((b) => b.branch_id === branchId)) throw new HttpError(400, "Unknown branch", "BAD_BRANCH");
  if (!canManageBranch(user, branchId)) throw new HttpError(403, "Only the branch manager or an admin creates proposals", "ROLE_DENIED");
  const today = businessDate(c.env);
  const date = requireDate(body.date, today);
  if (date > today) throw new HttpError(400, "A proposal cannot be dated in the future", "FUTURE_DATE");
  if (cases.length === 0) throw new HttpError(400, "Pick at least one case", "PROPOSAL_NEED_CASE");
  if (cases.length > MAX_CASES) throw new HttpError(400, `At most ${MAX_CASES} cases at once`, "TOO_MANY_CASES");
  const seen = new Set<string>();
  for (const k of cases) {
    if (!desks.some((d) => d.desk_id === k.deskId && d.branch_id === branchId)) {
      throw new HttpError(400, "That case does not belong to this branch", "DESK_NOT_IN_BRANCH", { deskId: k.deskId });
    }
    if (seen.has(k.deskId)) throw new HttpError(400, "A case is listed twice", "DUPLICATE_CASE", { deskId: k.deskId });
    seen.add(k.deskId);
    if (!k.rows.some((row) => (row.qty ?? 0) > 0)) {
      throw new HttpError(400, `Enter an order quantity for case ${k.deskId}`, "PROPOSAL_EMPTY_CASE", { deskId: k.deskId });
    }
  }
  for (const k of cases) {
    const existing = await liveProposal(store, k.deskId, date);
    if (existing) {
      throw new HttpError(409, `Case ${k.deskId} already has proposal ${existing.doc_no} for ${date}`, "PROPOSAL_EXISTS", {
        deskId: k.deskId,
        docId: existing.id,
        docNo: existing.doc_no,
      });
    }
  }

  const groupId = crypto.randomUUID();
  const created: DocumentRecord[] = [];
  try {
    for (const k of cases) {
      created.push(
        await store.createDocument(
          {
            title: k.title,
            branch_id: branchId,
            desk_id: k.deskId,
            created_by: user.displayName,
            doc_date: date,
            notes: body.notes ? String(body.notes).slice(0, 1000) : null,
            kind: "proposal",
            status: "pending",
            decided_by: null,
            decided_at: null,
            group_id: groupId,
          },
          k.rows
        )
      );
    }
  } catch (err) {
    await Promise.all(created.map((d) => store.deleteDocument(d.id).catch(() => false)));
    throw err;
  }
  for (const d of created) {
    await audit(store, user, "proposal.create", d.doc_no, { rows: d.rows?.length ?? 0, group: created.length > 1 ? groupId : null }, { branchId, deskId: d.desk_id });
  }
  return { groupId, documents: enrichDocuments(created, branches, desks) };
}

async function skuIdSet(store: Store) {
  return new Set((await store.skus()).map((s) => s.sku_id));
}

// One case (kept for older clients): same rules as the batch.
r.post("/documents", requireManager, async (c) => {
  const body = await readBody(c);
  const skuIds = await skuIdSet(storeFor(c));
  const title = String(body.title ?? "").trim();
  if (!title) throw new HttpError(400, "Title is required", "TITLE_REQUIRED");
  if (!body.deskId) throw new HttpError(400, "Pick a case", "PROPOSAL_NEED_CASE");
  const { documents } = await createProposals(c, body, [{ deskId: String(body.deskId), title: title.slice(0, 200), rows: cleanRows(body.rows, skuIds) }]);
  return c.json(documents[0]);
});

// Several cases at once: { branchId, date, notes?, cases: [{ deskId, title, rows }] }.
r.post("/documents/proposals", requireManager, async (c) => {
  const body = await readBody(c);
  const skuIds = await skuIdSet(storeFor(c));
  const cases: CaseInput[] = (Array.isArray(body.cases) ? body.cases : []).map((k: Record<string, unknown>) => ({
    deskId: String(k?.deskId ?? ""),
    title: String(k?.title ?? "").trim().slice(0, 200) || `Reorder ${String(k?.deskId ?? "")}`,
    rows: cleanRows(k?.rows, skuIds),
  }));
  return c.json(await createProposals(c, body, cases));
});

// Edit a pending proposal: its title and rows (case and date stay).
r.put("/documents/:id", requireManager, async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const doc = await store.getDocument(c.req.param("id") ?? "");
  if (!doc) throw new HttpError(404, "Document not found", "NOT_FOUND");
  if (!canManageBranch(user, doc.branch_id)) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
  if (doc.kind !== "proposal" || doc.status !== "pending") throw new HttpError(409, "Only a pending proposal can be edited", "NOT_EDITABLE");
  const rows = cleanRows(body.rows, await skuIdSet(store));
  if (!rows.some((row) => (row.qty ?? 0) > 0)) throw new HttpError(400, "Enter an order quantity", "PROPOSAL_EMPTY_CASE", { deskId: doc.desk_id });
  const title = String(body.title ?? "").trim().slice(0, 200);
  if (title && title !== doc.title) {
    const updated = await store.updateDocument(doc.id, { title }, "pending");
    if (!updated) throw new HttpError(409, "Only a pending proposal can be edited", "NOT_EDITABLE");
  }
  await store.replaceDocumentRows(doc.id, rows);
  await audit(store, user, "proposal.edit", doc.doc_no, { rows: rows.length }, { branchId: doc.branch_id, deskId: doc.desk_id });
  const [branches, desks, fresh] = await Promise.all([store.branches(), store.desks(), store.getDocument(doc.id)]);
  return c.json(enrichDocuments([fresh ?? doc], branches, desks)[0]);
});

// Admin approves or rejects a pending purchase proposal.
r.post("/documents/:id/decision", requireAdmin, async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const body = await readBody(c);
  const decision = body.decision;
  if (decision !== "approved" && decision !== "rejected") throw new HttpError(400, "Decision must be approved or rejected", "BAD_DECISION");
  const doc = await store.getDocument(c.req.param("id") ?? "");
  if (!doc) throw new HttpError(404, "Document not found", "NOT_FOUND");
  if (doc.kind !== "proposal") throw new HttpError(409, "Only purchase proposals are approved", "NOT_A_PROPOSAL");
  const updated = await store.updateDocument(doc.id, { status: decision, decided_by: user.displayName, decided_at: new Date().toISOString() }, "pending");
  if (!updated) throw new HttpError(409, `This proposal is already ${doc.status}`, "ALREADY_DECIDED");
  await audit(store, user, `proposal.${decision}`, doc.doc_no, null, { branchId: doc.branch_id, deskId: doc.desk_id });
  return c.json({ ok: true, status: decision });
});

// An admin deletes anything; a branch manager deletes a pending proposal of their branch.
r.delete("/documents/:id", requireManager, async (c) => {
  const store = storeFor(c);
  const user = c.get("user");
  const doc = await store.getDocument(c.req.param("id") ?? "");
  if (!doc) throw new HttpError(404, "Document not found", "NOT_FOUND");
  if (user.role !== "admin") {
    if (!canManageBranch(user, doc.branch_id)) throw new HttpError(403, "Branch access denied", "BRANCH_DENIED");
    if (doc.kind !== "proposal" || doc.status !== "pending") throw new HttpError(403, "Only an admin deletes a decided document", "ROLE_DENIED");
  }
  await store.deleteDocument(doc.id);
  await audit(store, user, "document.delete", doc.doc_no, { title: doc.title, kind: doc.kind, rows: doc.rows?.length ?? 0 }, { branchId: doc.branch_id, deskId: doc.desk_id });
  return c.json({ ok: true });
});

async function printDocs(c: Ctx, raws: (DocumentRecord | null)[]) {
  const store = storeFor(c);
  const user = c.get("user");
  const found = raws.filter((d): d is DocumentRecord => Boolean(d));
  if (found.length === 0) return c.text("Document not found", 404);
  if (found.some((d) => !assertBranchAccess(user, d.branch_id))) return c.text("Branch access denied", 403);
  const [branches, desks, skus, types] = await Promise.all([store.branches(), store.desks(), store.skus(), store.skuTypes()]);
  return c.html(renderDocumentSheets({ docs: enrichDocuments(found, branches, desks), skus, types }));
}

// Several documents in one printable page, each starting on a new sheet:
// ?ids=a,b,c or ?groupId=<group>.
r.get("/documents/print", async (c) => {
  const store = storeFor(c);
  const groupId = c.req.query("groupId");
  if (groupId) {
    const { rows } = await store.documents({ groupId, pageSize: MAX_CASES });
    const ordered = [...rows].sort((a, b) => a.doc_no.localeCompare(b.doc_no));
    return printDocs(c, ordered);
  }
  const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean).slice(0, MAX_CASES);
  return printDocs(c, await Promise.all(ids.map((id) => store.getDocument(id))));
});

// Printable sheet in the shop's case-sheet layout (see src/print/documentSheet.ts).
r.get("/documents/:id/print", async (c) => {
  const store = storeFor(c);
  return printDocs(c, [await store.getDocument(c.req.param("id") ?? "")]);
});

export default r;
