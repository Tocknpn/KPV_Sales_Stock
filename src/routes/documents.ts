// Documents (free-form records) and purchase proposals (documents that carry
// an approval status: pending -> approved / rejected, decided by an admin).
// Mounted behind requireAuth in src/index.ts.
import { newRouter, readBody, HttpError, scopeBranch, requireDate, audit } from "../app";
import { getStore } from "../store";
import { requireAdmin, assertBranchAccess } from "../auth";
import { businessDate, isValidDate } from "../time";
import { enrichDocuments } from "../logic";

const r = newRouter();

r.get("/documents", async (c) => {
  const store = getStore(c.env);
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
  const store = getStore(c.env);
  const user = c.get("user");
  const body = await readBody(c);
  const branchId = String(body.branchId ?? "");
  const [branches, desks] = await Promise.all([store.branches(), store.desks()]);
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
  const store = getStore(c.env);
  const user = c.get("user");
  const body = await readBody(c);
  const decision = body.decision;
  if (decision !== "approved" && decision !== "rejected") throw new HttpError(400, "Decision must be approved or rejected", "BAD_DECISION");
  const doc = await store.getDocument((c.req.param("id") ?? ""));
  if (!doc) throw new HttpError(404, "Document not found", "NOT_FOUND");
  if (doc.kind !== "proposal") throw new HttpError(409, "Only purchase proposals are approved", "NOT_A_PROPOSAL");
  const updated = await store.updateDocument(doc.id, { status: decision, decided_by: user.displayName, decided_at: new Date().toISOString() }, "pending");
  if (!updated) throw new HttpError(409, `This proposal is already ${doc.status}`, "ALREADY_DECIDED");
  await audit(store, user, `proposal.${decision}`, doc.doc_no, null);
  return c.json({ ok: true, status: decision });
});

r.delete("/documents/:id", requireAdmin, async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const doc = await store.getDocument((c.req.param("id") ?? ""));
  if (!doc) throw new HttpError(404, "Document not found", "NOT_FOUND");
  await store.deleteDocument(doc.id);
  await audit(store, user, "document.delete", doc.doc_no, { title: doc.title, kind: doc.kind, rows: doc.rows?.length ?? 0 });
  return c.json({ ok: true });
});

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
}

const STATUS_LABEL: Record<string, string> = {
  pending: "ລໍຖ້າອະນຸມັດ · Pending approval",
  approved: "ອະນຸມັດແລ້ວ · Approved",
  rejected: "ບໍ່ອະນຸມັດ · Rejected",
};

r.get("/documents/:id/print", async (c) => {
  const store = getStore(c.env);
  const user = c.get("user");
  const raw = await store.getDocument((c.req.param("id") ?? ""));
  if (!raw) return c.text("Document not found", 404);
  if (!assertBranchAccess(user, raw.branch_id)) return c.text("Branch access denied", 403);
  const [branches, desks] = await Promise.all([store.branches(), store.desks()]);
  const doc = enrichDocuments([raw], branches, desks)[0];
  const rowsHtml = doc.rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.item)}</td>
        <td style="text-align:right">${row.qty ?? ""}</td>
        <td style="text-align:right">${row.weight_g ?? ""}</td>
        <td>${row.note ? escapeHtml(row.note) : ""}</td>
      </tr>`
    )
    .join("");
  const statusHtml = doc.status
    ? `<p><span class="pill">${STATUS_LABEL[doc.status]}</span>${
        doc.decided_by ? ` &nbsp;·&nbsp; ${escapeHtml(doc.decided_by)} &nbsp;·&nbsp; ${new Date(doc.decided_at ?? "").toLocaleString("en-GB", { timeZone: "Asia/Vientiane" })}` : ""
      }</p>`
    : "";
  const html = `<!doctype html>
<html lang="lo"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Noto+Sans+Lao:wght@400;500;600;700&display=swap" rel="stylesheet" />
<title>${escapeHtml(doc.doc_no)} — ${escapeHtml(doc.title)}</title>
<style>
  body{font-family:'Plus Jakarta Sans','Noto Sans Lao',Arial,sans-serif;color:#111;padding:32px;max-width:720px;margin:auto}
  h1{color:#990000;font-size:20px;margin-bottom:4px}
  .meta{color:#555;font-size:13px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border-bottom:1px solid #e5e7eb;padding:8px 6px;text-align:left}
  th{color:#888;text-transform:uppercase;font-size:11px}
  .totals{margin-top:16px;text-align:right;font-weight:700}
  .pill{display:inline-block;padding:4px 10px;border-radius:999px;background:#ffebeb;color:#990000;font-size:12px;font-weight:700}
  @media print{ .no-print{display:none} }
</style></head>
<body>
  <h1>${escapeHtml(doc.title)}</h1>
  <div class="meta">
    <strong>${escapeHtml(doc.doc_no)}</strong> &nbsp;·&nbsp; ${doc.doc_date} &nbsp;·&nbsp; ${escapeHtml(doc.branch_name)}
    ${doc.desk_id ? ` (${escapeHtml(doc.desk_id)})` : ""} &nbsp;·&nbsp; By ${escapeHtml(doc.created_by)}
    &nbsp;·&nbsp; ${new Date(doc.created_at).toLocaleString("en-GB", { timeZone: "Asia/Vientiane" })}
  </div>
  ${statusHtml}
  <table>
    <thead><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Weight (g)</th><th>Note</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="totals">${doc.rowCount} rows · ${doc.totalWeightG.toFixed(2)} g total</div>
  ${doc.notes ? `<p style="margin-top:20px;color:#555;font-size:13px">Notes: ${escapeHtml(doc.notes)}</p>` : ""}
  <p class="no-print" style="margin-top:32px"><button onclick="window.print()">Print / Save as PDF</button></p>
</body></html>`;
  return c.html(html);
});

export default r;
