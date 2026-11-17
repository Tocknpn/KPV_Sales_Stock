// SKU import/export rows (decided 2026-11-17). The browser reads and writes the
// .xlsx and sends / receives these rows as JSON; this module checks a whole file
// and says what to write. Nothing here touches the Store.
//
// One row = one SKU in one branch. Blank sku_id = a new SKU; a known sku_id =
// an update; nothing is ever deleted. Name, type and size are the shared
// catalogue: a blank cell leaves them as they are, and for a staff / manager a
// change is ignored (and listed). Avg/day and lead time are the branch's own
// values: a blank cell means "none" (inherit), as in the export.
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
  errors: { line: number; error: string }[];
  // What to write when the plan has no errors.
  newSkus: { line: number; tempKey: string; name: string; type: SkuType; weight: SkuWeight; branch_id: string; avg: number | null; lead: number | null }[];
  skuPatches: Map<string, { name?: string; type?: SkuType; weight?: SkuWeight }>;
  rules: { sku_id: string; branch_id: string; avg: number | null; lead: number | null; before: { avg: number | null; lead: number | null } }[];
  carried: BranchSku[];
  // Existing (SKU, branch) pairs that change, for the audit.
  updatedRows: { sku_id: string; branch_id: string }[];
}

// A cell as text: trimmed, non-breaking spaces as spaces, inner runs of spaces as one.
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

// A number cell: "" = null; NaN when it is not a number.
function cellNumber(v: unknown): number | null {
  const t = cellText(v);
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
export const typeLabel = (t: SkuType) => t.name_lo || t.name_en;

export function findType(types: SkuType[], text: string): SkuType | undefined {
  const k = text.toLowerCase();
  return types.find((t) => t.type_id.toLowerCase() === k || t.name_en.toLowerCase() === k || (t.name_lo ?? "").toLowerCase() === k);
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
  const plan: ImportPlan = { created: 0, updated: 0, unchanged: 0, ignored: [], errors: [], newSkus: [], skuPatches: new Map(), rules: [], carried: [], updatedRows: [] };
  const skuById = new Map(input.skus.map((s) => [s.sku_id, s]));
  const skuByLower = new Map(input.skus.map((s) => [s.sku_id.toLowerCase(), s]));
  const knownBranches = new Set(input.branchIds);
  const carried = new Set(input.branchSkus.filter((b) => b.carried).map((b) => `${b.branch_id}|${b.sku_id}`));
  const ruleOf = new Map(input.rules.filter((r) => r.scope === "sku" && r.branch_id).map((r) => [`${r.branch_id}|${r.scope_key}`, r]));
  const seen = new Map<string, number>(); // branch|sku -> first line
  const patchLine = new Map<string, number>(); // sku -> line of its first catalogue change

  input.rows.forEach((raw, i) => {
    const line = i + 2; // line 1 is the header row
    const row = raw ?? {};
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
    const avg = cellNumber(row.avg_daily_sell);
    const lead = cellNumber(row.lead_time_days);
    if (Number.isNaN(avg) || (avg !== null && (avg < 0 || avg > MAX_AVG))) return fail(`avg_daily_sell must be a number from 0 to ${MAX_AVG}`);
    if (Number.isNaN(lead) || (lead !== null && (lead < 0 || lead > MAX_LEAD))) return fail(`lead_time_days must be a number from 0 to ${MAX_LEAD}`);
    const avgR = avg === null ? null : round(avg, 3);
    const leadR = lead === null ? null : round(lead, 1);

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
      plan.newSkus.push({ line, tempKey: `new-${line}`, name, type, weight, branch_id: branch, avg: avgR, lead: leadR });
      plan.created++;
      return;
    }

    const sku = skuById.get(code) ?? skuByLower.get(code.toLowerCase());
    if (!sku) return fail(`unknown sku_id ${code}`);
    const key = `${branch}|${sku.sku_id}`;
    const first = seen.get(key);
    if (first !== undefined) return fail(`sku_id ${sku.sku_id} is also on line ${first}`);
    seen.set(key, line);

    // Catalogue changes (blank = unchanged).
    const changes: { name?: string; type?: SkuType; weight?: SkuWeight } = {};
    if (name && name !== (sku.name_lo || sku.name_en)) changes.name = name;
    if (type && type.type_id !== sku.type_id) changes.type = type;
    if (weight && weight.weight_id !== sku.weight_id) changes.weight = weight;
    const changed = Object.keys(changes) as ("name" | "type" | "weight")[];
    if (changed.length > 0 && !input.isAdmin) {
      for (const f of changed) plan.ignored.push({ line, field: f === "weight" ? "grams" : f });
    } else if (changed.length > 0) {
      const prior = plan.skuPatches.get(sku.sku_id);
      if (prior) {
        const clash = (prior.name ?? null) !== (changes.name ?? null) || prior.type?.type_id !== changes.type?.type_id || prior.weight?.weight_id !== changes.weight?.weight_id;
        if (clash) return fail(`sku_id ${sku.sku_id} has a different name, type or size on line ${patchLine.get(sku.sku_id)}`);
      } else {
        plan.skuPatches.set(sku.sku_id, changes);
        patchLine.set(sku.sku_id, line);
      }
    }

    const rule = ruleOf.get(key);
    const before = { avg: rule?.avg_daily_sell ?? null, lead: rule?.lead_time_days ?? null };
    const ruleChanged = before.avg !== avgR || before.lead !== leadR;
    if (ruleChanged) plan.rules.push({ sku_id: sku.sku_id, branch_id: branch, avg: avgR, lead: leadR, before });
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
