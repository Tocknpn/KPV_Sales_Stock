// SKU import/export rows (decided 2026-11-17). The browser reads and writes the
// .xlsx and sends / receives these rows as JSON; this module checks a whole file
// and says what to write. Nothing here touches the Store.
//
// One row = one SKU in one branch. Blank sku_id = a new SKU; a known sku_id =
// an update; nothing is ever deleted. Name, type and size are the shared
// catalogue: a blank cell leaves them as they are, and for a staff / manager a
// change is ignored (and listed). Avg/day and lead time are the branch's own
// values: a blank cell leaves the value as it is, "-" clears it (decided
// 2026-11-17); on a new row both mean "none".
import type { BranchSku, MasterSku, ReplenishmentRule, SkuType, SkuWeight } from "./types";

export const MAX_IMPORT_ROWS = 500;
export const GRAMS_TOLERANCE = 0.001;
const MAX_AVG = 9_999_999;
const MAX_LEAD = 9999.9;

export interface ExportRow {
  sku_id: string;
  name: string;
  type: string;
  grams: number | null;
  avg_daily_sell: number | null;
  lead_time_days: number | null;
  branch_id: string | null;
}

export type CatalogueField = "name" | "type" | "grams";

export interface ImportPlan {
  created: number;
  updated: number;
  unchanged: number;
  ignored: { line: number; field: CatalogueField }[];
  // Branch values a "-" cell removes (listed apart from other changes).
  cleared: { line: number; field: "avg_daily_sell" | "lead_time_days" }[];
  errors: { line: number; error: string }[];
  // What to write when the plan has no errors.
  // One entry per new SKU (name + type + size); an all-branches file may list
  // it once per branch, and it is then carried in each.
  newSkus: { line: number; name: string; type: SkuType; weight: SkuWeight; branches: { branch_id: string; avg: number | null; lead: number | null }[] }[];
  skuPatches: Map<string, { name?: string; type?: SkuType; weight?: SkuWeight }>;
  rules: { sku_id: string; branch_id: string; avg: number | null; lead: number | null; before: { avg: number | null; lead: number | null } }[];
  carried: BranchSku[];
  // Existing (SKU, branch) pairs that change, for the audit.
  updatedRows: { sku_id: string; branch_id: string }[];
}

// Lao text in one form: NFC, and AM (U+0EB3) typed as NIGGAHITA + AA
// (U+0ECD U+0EB2) folded into AM, so the two spellings compare equal.
export const laoForm = (s: string) => s.normalize("NFC").replace(/\u0ECD\u0EB2/g, "\u0EB3");

// A cell as text: Lao form, trimmed, non-breaking spaces as spaces, inner runs of spaces as one.
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return laoForm(String(v)).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

// A number cell: "" = null; NaN when it is not a number.
function cellNumber(v: unknown): number | null {
  const t = cellText(v);
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

// A branch-value cell: blank = keep, a dash = clear, else a number in range.
const DASHES = new Set(["-", "\u2013", "\u2014"]);
type PlanCell = { kind: "keep" } | { kind: "clear" } | { kind: "set"; value: number };
function planCell(v: unknown, field: string, max: number, decimals: number): PlanCell | string {
  const t = cellText(v);
  if (t === "") return { kind: "keep" };
  if (DASHES.has(t)) return { kind: "clear" };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > max) return `${field} must be a number from 0 to ${max}, or - to clear`;
  return { kind: "set", value: round(n, decimals) };
}
const valueOf = (c: PlanCell, current: number | null) => (c.kind === "keep" ? current : c.kind === "clear" ? null : c.value);
export const typeLabel = (t: SkuType) => t.name_lo || t.name_en;

// Type and size lookups include inactive ones; planImport decides what an inactive one means.
export function findType(types: SkuType[], text: string): SkuType | undefined {
  const k = laoForm(text).toLowerCase();
  return types.find((t) => t.type_id.toLowerCase() === k || laoForm(t.name_en).toLowerCase() === k || laoForm(t.name_lo ?? "").toLowerCase() === k);
}

export function findWeight(weights: SkuWeight[], grams: number): SkuWeight | undefined {
  return weights.find((w) => Math.abs(w.gram_value - grams) <= GRAMS_TOLERANCE);
}

export function exportRows(input: {
  branchIds: string[];
  withBranch: boolean;
  skus: MasterSku[];
  types: SkuType[];
  rules: ReplenishmentRule[];
  branchSkus: BranchSku[];
}): ExportRow[] {
  const typeById = new Map(input.types.map((t) => [t.type_id, t]));
  const carried = new Set(input.branchSkus.filter((b) => b.carried).map((b) => `${b.branch_id}|${b.sku_id}`));
  const ruleOf = new Map(input.rules.filter((r) => r.scope === "sku" && r.branch_id).map((r) => [`${r.branch_id}|${r.scope_key}`, r]));
  const out: ExportRow[] = [];
  for (const branch of input.branchIds) {
    for (const s of input.skus) {
      if (!s.active || !carried.has(`${branch}|${s.sku_id}`)) continue;
      const type = s.type_id ? typeById.get(s.type_id) : undefined;
      const rule = ruleOf.get(`${branch}|${s.sku_id}`);
      out.push({
        sku_id: s.sku_id,
        name: s.name_lo || s.name_en,
        type: type ? typeLabel(type) : s.category,
        grams: s.std_gram_weight ?? null,
        avg_daily_sell: rule?.avg_daily_sell ?? null,
        lead_time_days: rule?.lead_time_days ?? null,
        branch_id: input.withBranch ? branch : null,
      });
    }
  }
  return out;
}

export function planImport(input: {
  rows: Record<string, unknown>[];
  // One branch, or null for an all-branches file (each row names its branch).
  branchId: string | null;
  isAdmin: boolean;
  branchIds: string[];
  skus: MasterSku[];
  types: SkuType[];
  weights: SkuWeight[];
  rules: ReplenishmentRule[];
  branchSkus: BranchSku[];
}): ImportPlan {
  const plan: ImportPlan = { created: 0, updated: 0, unchanged: 0, ignored: [], cleared: [], errors: [], newSkus: [], skuPatches: new Map(), rules: [], carried: [], updatedRows: [] };
  const skuById = new Map(input.skus.map((s) => [s.sku_id, s]));
  const skuByLower = new Map(input.skus.map((s) => [s.sku_id.toLowerCase(), s]));
  const knownBranches = new Set(input.branchIds);
  const carried = new Set(input.branchSkus.filter((b) => b.carried).map((b) => `${b.branch_id}|${b.sku_id}`));
  const ruleOf = new Map(input.rules.filter((r) => r.scope === "sku" && r.branch_id).map((r) => [`${r.branch_id}|${r.scope_key}`, r]));
  const seen = new Map<string, number>(); // branch|sku -> first line
  // Admin only: each existing SKU's name / type / size as its first line sets it.
  const firstLook = new Map<string, { line: number; look: string }>();
  const currentName = (s: MasterSku) => laoForm(s.name_lo || s.name_en);
  // A new SKU is name + type + size (name compared without case).
  const identity = (name: string, typeId: string | null, weightId: string | null) => `${laoForm(name).toLowerCase()}|${typeId ?? ""}|${weightId ?? ""}`;
  const existingByIdentity = new Map(input.skus.map((s) => [identity(s.name_lo || s.name_en, s.type_id, s.weight_id), s]));
  const newByIdentity = new Map<string, ImportPlan["newSkus"][number]>();

  input.rows.forEach((raw, i) => {
    const row = raw ?? {};
    // The sheet line the browser sends (blank rows are skipped there), else the
    // position in the list (line 1 is the header row).
    const line = Number.isInteger(row.line) && (row.line as number) > 0 ? (row.line as number) : i + 2;
    const fail = (error: string) => plan.errors.push({ line, error });

    // Branch
    const rowBranch = cellText(row.branch_id);
    let branch: string;
    if (input.branchId === null) {
      if (!rowBranch) return fail("branch_id is required");
      if (!knownBranches.has(rowBranch)) return fail(`unknown branch_id ${rowBranch}`);
      branch = rowBranch;
    } else {
      if (rowBranch && rowBranch !== input.branchId) return fail(`branch_id ${rowBranch} is not ${input.branchId}`);
      branch = input.branchId;
    }

    // Branch values
    const avgCell = planCell(row.avg_daily_sell, "avg_daily_sell", MAX_AVG, 3);
    if (typeof avgCell === "string") return fail(avgCell);
    const leadCell = planCell(row.lead_time_days, "lead_time_days", MAX_LEAD, 1);
    if (typeof leadCell === "string") return fail(leadCell);
    // A new SKU has nothing to keep: blank and "-" both mean none.
    const avgR = valueOf(avgCell, null);
    const leadR = valueOf(leadCell, null);

    // Catalogue cells
    const name = cellText(row.name).slice(0, 120);
    const typeText = cellText(row.type);
    const gramsCell = cellNumber(row.grams);
    if (Number.isNaN(gramsCell)) return fail(`grams must be a number`);
    const type = typeText ? findType(input.types, typeText) : undefined;
    if (typeText && !type) return fail(`unknown type ${typeText}`);
    const weight = gramsCell !== null ? findWeight(input.weights, gramsCell) : undefined;
    if (gramsCell !== null && !weight) return fail(`no size of ${gramsCell} g`);

    const code = cellText(row.sku_id);
    if (!code) {
      if (!name) return fail("name is required");
      if (!type) return fail("type is required");
      if (!weight) return fail("grams is required");
      if (!type.active) return fail(`type ${typeText} is not in use`);
      if (!weight.active) return fail(`size ${gramsCell} g is not in use`);
      const id = identity(name, type.type_id, weight.weight_id);
      const existing = existingByIdentity.get(id);
      if (existing) return fail(`this SKU already exists as ${existing.sku_id} — put ${existing.sku_id} in sku_id`);
      const prior = newByIdentity.get(id);
      if (prior) {
        if (prior.branches.some((b) => b.branch_id === branch)) return fail(`the same new SKU is also on line ${prior.line}`);
        prior.branches.push({ branch_id: branch, avg: avgR, lead: leadR });
        return;
      }
      const entry = { line, name, type, weight, branches: [{ branch_id: branch, avg: avgR, lead: leadR }] };
      newByIdentity.set(id, entry);
      plan.newSkus.push(entry);
      plan.created++;
      return;
    }

    const sku = skuById.get(code) ?? skuByLower.get(code.toLowerCase());
    if (!sku) return fail(`unknown sku_id ${code}`);
    if (!sku.active) return fail(`sku_id ${sku.sku_id} is not in use`);
    const key = `${branch}|${sku.sku_id}`;
    const first = seen.get(key);
    if (first !== undefined) return fail(`sku_id ${sku.sku_id} is also on line ${first}`);
    seen.set(key, line);

    // Catalogue changes (blank = unchanged).
    const changes: { name?: string; type?: SkuType; weight?: SkuWeight } = {};
    if (name && name !== currentName(sku)) changes.name = name;
    if (type && type.type_id !== sku.type_id) changes.type = type;
    if (weight && weight.weight_id !== sku.weight_id) changes.weight = weight;
    const changed = Object.keys(changes) as ("name" | "type" | "weight")[];
    if (changed.length > 0 && !input.isAdmin) {
      for (const f of changed) plan.ignored.push({ line, field: f === "weight" ? "grams" : f });
    } else if (input.isAdmin) {
      // Moving a SKU onto a type or size no longer in use is refused.
      if (changes.type && !changes.type.active) return fail(`type ${typeText} is not in use`);
      if (changes.weight && !changes.weight.active) return fail(`size ${gramsCell} g is not in use`);
      // Every line of a SKU must describe it the same way (blank = as it is now).
      const look = [changes.name ?? currentName(sku), changes.type?.type_id ?? sku.type_id, changes.weight?.weight_id ?? sku.weight_id].join("|");
      const first = firstLook.get(sku.sku_id);
      if (first && first.look !== look) return fail(`sku_id ${sku.sku_id} has a different name, type or size on line ${first.line}`);
      if (!first) firstLook.set(sku.sku_id, { line, look });
      if (changed.length > 0) plan.skuPatches.set(sku.sku_id, changes);
    }

    const rule = ruleOf.get(key);
    const before = { avg: rule?.avg_daily_sell ?? null, lead: rule?.lead_time_days ?? null };
    const nextAvg = valueOf(avgCell, before.avg);
    const nextLead = valueOf(leadCell, before.lead);
    if (avgCell.kind === "clear" && before.avg !== null) plan.cleared.push({ line, field: "avg_daily_sell" });
    if (leadCell.kind === "clear" && before.lead !== null) plan.cleared.push({ line, field: "lead_time_days" });
    const ruleChanged = before.avg !== nextAvg || before.lead !== nextLead;
    if (ruleChanged) plan.rules.push({ sku_id: sku.sku_id, branch_id: branch, avg: nextAvg, lead: nextLead, before });
    const carriedOff = !carried.has(key);
    if (carriedOff) plan.carried.push({ branch_id: branch, sku_id: sku.sku_id, carried: true });
    const catalogueChanged = changed.length > 0 && input.isAdmin;
    if (ruleChanged || carriedOff || catalogueChanged) {
      plan.updated++;
      plan.updatedRows.push({ sku_id: sku.sku_id, branch_id: branch });
    } else plan.unchanged++;
  });
  return plan;
}
