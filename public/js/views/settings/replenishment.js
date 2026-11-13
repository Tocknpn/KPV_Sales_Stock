// Settings -> Replenishment: per SKU, the average daily sell and the lead time that
// drive the branch runway, grouped by product group (fallback: type).
// Everyone can read it; edits are admin (any rule) or a manager on their own branch.
import { api } from "../../api.js";
import { toast, openSheet, closeSheet } from "../../ui.js";
import { escapeHtml, fmtRunway, debounce } from "../../util.js";
import { t, tf, pickName } from "../../i18n.js";
import { state, branchName } from "../../state.js";
import { isAdmin } from "../../session.js";

const STATUS_CLS = {
  critical: "bg-danger-bg text-danger",
  warning: "bg-warning-bg text-warning",
  ok: "bg-success-bg text-success",
  no_data: "bg-gray-100 text-gray-600",
};

let branchId = null;
let filter = "all"; // all | critical | warning | review
let query = "";
let data = null; // { rows, config, skus: Map }
let priceConfig = {};

const num = (n) => String(Math.round(Number(n) * 1000) / 1000);

function mayEdit() {
  const u = state.user;
  return isAdmin(u) || (u?.role === "manager" && u.branchId === branchId);
}

export async function renderReplenishment(root) {
  const u = state.user;
  branchId = isAdmin(u) ? branchId || u.branchId || state.meta.branches[0]?.branch_id : u.branchId;
  filter = "all";
  query = "";
  data = null;
  if (isAdmin(u)) priceConfig = (await api.settingsSummary()).config;
  await load(root);
}

async function load(root) {
  if (!data) root.innerHTML = `<div class="py-16 text-center text-sm text-gray-600">…</div>`;
  const [rep, { skus }] = await Promise.all([api.replenishment(branchId), api.skus(true)]);
  data = { rows: rep.rows, config: rep.config, skus: new Map(skus.map((s) => [s.sku_id, s])) };
  paint(root);
}

// Groups keep the API order (worst status first). A row without a group falls under its type.
function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const sku = data.skus.get(row.sku_id);
    const scope = row.group ? "group" : "type";
    const key = row.group || sku?.type_id || "";
    const label = row.group || sku?.type_name || "—";
    const id = `${scope}:${key}`;
    if (!groups.has(id)) groups.set(id, { id, scope, key, label, rows: [] });
    groups.get(id).rows.push(row);
  }
  return [...groups.values()];
}

function visible(rows) {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === "review" ? !r.review : filter !== "all" && r.status !== filter) return false;
    return !q || r.name.toLowerCase().includes(q) || (data.skus.get(r.sku_id)?.name_lo ?? "").toLowerCase().includes(q);
  });
}

function paint(root) {
  const count = (pred) => data.rows.filter(pred).length;
  const chips = [
    ["all", t("replen.all"), data.rows.length],
    ["critical", t("replen.critical"), count((r) => r.status === "critical")],
    ["warning", t("replen.warning"), count((r) => r.status === "warning")],
    ["review", t("replen.review"), count((r) => r.review)],
  ];
  const chipCls = (on) => (on ? "border-brand-600 bg-brand-600 text-white" : "border-hairline bg-white text-gray-600");
  root.innerHTML = `
    <div class="card p-4">
      ${
        isAdmin(state.user)
          ? `<label for="rp-branch" class="mb-1.5 block text-xs font-bold text-gray-600">${t("replen.branch")}</label>
             <select id="rp-branch" class="input-filled mb-3">
               ${state.meta.branches.map((b) => `<option value="${escapeHtml(b.branch_id)}" ${b.branch_id === branchId ? "selected" : ""}>${escapeHtml(branchName(b.branch_id))}</option>`).join("")}
             </select>`
          : `<div class="mb-3 text-sm font-extrabold text-gray-900">${escapeHtml(branchName(branchId))}</div>`
      }
      <div class="flex flex-wrap gap-1.5">
        ${chips.map(([id, label, n]) => `<button data-filter="${id}" class="chip tap-target min-w-0 ${chipCls(filter === id)}">${escapeHtml(label)} · ${n}</button>`).join("")}
      </div>
      <input id="rp-search" type="search" value="${escapeHtml(query)}" placeholder="${t("settings.searchPlaceholder")}" aria-label="${t("settings.searchPlaceholder")}" class="input-filled mt-3" />
      <p class="mt-2 text-[11px] font-medium text-gray-600">${escapeHtml(tf("replen.defaults", { lead: num(data.config.defaultLeadTimeDays), margin: num(data.config.warningMarginDays) }))}</p>
      ${mayEdit() ? "" : `<p class="mt-1 text-[11px] font-bold text-gray-600">${t("replen.readOnly")}</p>`}
    </div>
    <div id="rp-list"></div>
    ${isAdmin(state.user) ? priceCard() : ""}
    <div class="h-4"></div>
  `;
  root.querySelector("#rp-branch")?.addEventListener("change", async (e) => {
    branchId = e.target.value;
    data = null;
    await load(root);
  });
  root.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.filter;
      paint(root);
    })
  );
  root.querySelector("#rp-search").addEventListener(
    "input",
    debounce((e) => {
      query = e.target.value;
      paintList(root);
    }, 250)
  );
  wirePriceCard(root);
  paintList(root);
}

function paintList(root) {
  const list = root.querySelector("#rp-list");
  const shown = visible(data.rows);
  const groups = groupRows(shown);
  const total = groupRows(data.rows);
  const editable = mayEdit();
  list.innerHTML = groups.length
    ? groups
        .map((g) => {
          const size = total.find((x) => x.id === g.id)?.rows.length ?? g.rows.length;
          return `
      <section class="mt-4">
        <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2 px-1">
          <h3 class="min-w-0 truncate text-xs font-extrabold uppercase tracking-wide text-gray-700">${escapeHtml(g.label)} · ${g.rows.length}</h3>
          ${editable ? `<button data-bulk="${escapeHtml(g.id)}" class="tap-target rounded-full border border-brand-600 px-3 text-[11px] font-bold text-brand-700 active:bg-brand-50">${escapeHtml(tf("replen.setAll", { n: size }))}</button>` : ""}
        </div>
        <div class="flex flex-col gap-2">${g.rows.map((r) => rowHtml(r, editable)).join("")}</div>
      </section>`;
        })
        .join("")
    : `<div class="card mt-4 p-6 text-center text-xs text-gray-500">${t("replen.empty")}</div>`;

  list.querySelectorAll("[data-sku]").forEach((el) =>
    el.addEventListener("click", () => openRuleSheet(root, data.rows.find((r) => r.sku_id === el.dataset.sku)))
  );
  list.querySelectorAll("[data-bulk]").forEach((el) =>
    el.addEventListener("click", () => openBulkSheet(root, groups.find((g) => g.id === el.dataset.bulk), total.find((g) => g.id === el.dataset.bulk)))
  );
}

const srcTag = (source) =>
  `<span class="rounded bg-gray-100 px-1 py-0.5 text-[10px] font-bold text-gray-600">${escapeHtml(t(`replen.src.${source}`))}</span>`;

function rowHtml(r, editable) {
  const sku = data.skus.get(r.sku_id);
  const name = pickName(r.name, sku?.name_lo);
  const sub = [sku?.weight_name, sku?.purity].filter(Boolean).join(" · ");
  const runway = fmtRunway(r.runwayDays);
  const auto = r.autoAvg?.value != null ? tf("replen.auto", { n: num(r.autoAvg.value), d: r.autoAvg.inStockDays }) : t("replen.autoNone");
  const attention = r.status === "critical" || r.status === "warning";
  const inner = `
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="truncate text-sm font-extrabold text-gray-900">${escapeHtml(name)}</div>
        ${sub ? `<div class="truncate text-[11px] text-gray-600">${escapeHtml(sub)}</div>` : ""}
      </div>
      <div class="flex shrink-0 flex-col items-end gap-1">
        <span class="status-pill ${STATUS_CLS[r.status] ?? STATUS_CLS.no_data}">${t(`replen.status.${r.status}`)}${runway && r.status !== "no_data" ? ` · ${escapeHtml(runway)}` : ""}</span>
        ${r.review ? `<span class="status-pill bg-warning-bg text-warning">${t("replen.review")}</span>` : ""}
      </div>
    </div>
    <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-800">
      <span class="inline-flex items-center gap-1"><span class="font-semibold text-gray-600">${t("replen.avg")}</span><b class="tabular-nums">${r.avg.value == null ? "—" : num(r.avg.value)}</b>${srcTag(r.avg.source)}</span>
      <span class="inline-flex items-center gap-1"><span class="font-semibold text-gray-600">${t("replen.lead")}</span><b class="tabular-nums">${num(r.lead.value)} ${t("replen.d")}</b>${srcTag(r.lead.source)}</span>
    </div>
    <div class="mt-1 text-[11px] text-gray-600">${escapeHtml(auto)}</div>
    <div class="mt-0.5 text-[11px] text-gray-600">${escapeHtml(tf("replen.position", { on: r.onHand, inb: r.inbound }))}${attention && r.suggestedQty > 0 ? ` · <b class="text-gray-800">${escapeHtml(tf("replen.suggest", { n: r.suggestedQty }))}</b>` : ""}</div>`;
  return editable
    ? `<button type="button" data-sku="${escapeHtml(r.sku_id)}" class="card focus-ring min-h-[44px] w-full min-w-0 p-3 text-left active:bg-gray-50">${inner}</button>`
    : `<div class="card min-w-0 p-3">${inner}</div>`;
}

// ---- helpers shared by both sheets ----

function scopeField(prefix) {
  if (isAdmin(state.user)) {
    return `<label for="${prefix}-scope" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("replen.scope")}</label>
      <select id="${prefix}-scope" class="input-filled">
        <option value="company">${t("replen.scopeCompany")}</option>
        <option value="branch">${t("replen.scopeBranch")} · ${escapeHtml(branchName(branchId))}</option>
      </select>`;
  }
  return `<input type="hidden" id="${prefix}-scope" value="branch" />
    <p class="mt-3 text-xs font-bold text-gray-600">${t("replen.scope")}: ${t("replen.scopeBranch")} · ${escapeHtml(branchName(branchId))}</p>`;
}

const scopeBranchId = (sheet, prefix) => (sheet.querySelector(`#${prefix}-scope`).value === "branch" ? branchId : null);

// Blank = null (inherit). Returns undefined when the text is not a number >= 0.
function readNumber(input) {
  const v = input.value.trim();
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const numberInput = (id, label, value, step) => `
  <div class="min-w-0">
    <label for="${id}" class="mb-1.5 block text-xs font-bold text-gray-600">${label}</label>
    <input id="${id}" type="number" min="0" step="${step}" inputmode="decimal" value="${value}" class="input-filled" />
  </div>`;

// ---- one SKU ----

function openRuleSheet(root, row) {
  if (!row) return;
  const sku = data.skus.get(row.sku_id);
  const ownValue = (field, branch) => {
    const src = row[field].source;
    return src === (branch ? "sku-branch" : "sku") ? num(row[field].value) : "";
  };
  openSheet(
    `
    <div class="grid grid-cols-2 gap-2">
      ${numberInput("rs-avg", t("replen.avg"), "", "any")}
      ${numberInput("rs-lead", `${t("replen.lead")} (${t("replen.d")})`, "", "any")}
    </div>
    <p class="mt-1.5 text-[11px] text-gray-500">${t("replen.inheritHint")}</p>
    ${scopeField("rs")}
    <button id="rs-save" class="btn-primary mt-4 w-full">${t("settings.save")}</button>`,
    {
      title: escapeHtml(pickName(row.name, sku?.name_lo)),
      onMount: (sheet) => {
        const avg = sheet.querySelector("#rs-avg");
        const lead = sheet.querySelector("#rs-lead");
        const fill = () => {
          const branch = sheet.querySelector("#rs-scope").value === "branch";
          avg.value = ownValue("avg", branch);
          lead.value = ownValue("lead", branch);
          avg.placeholder = row.avg.value == null ? "—" : num(row.avg.value);
          lead.placeholder = num(row.lead.value);
        };
        fill();
        sheet.querySelector("#rs-scope").addEventListener("change", fill);
        sheet.querySelector("#rs-save").addEventListener("click", async (e) => {
          const a = readNumber(avg);
          const l = readNumber(lead);
          if (a === undefined || l === undefined) return toast(t("err.BAD_RULE"), "error");
          e.target.disabled = true;
          try {
            await api.saveRule({ scope: "sku", key: row.sku_id, branchId: scopeBranchId(sheet, "rs"), avgDailySell: a, leadTimeDays: l });
          } catch (err) {
            e.target.disabled = false;
            throw err;
          }
          closeSheet();
          toast(t("replen.saved"), "success");
          await load(root);
        });
      },
    }
  );
}

// ---- a whole group / type ----

function openBulkSheet(root, group, full) {
  if (!group) return;
  const size = full?.rows.length ?? group.rows.length;
  openSheet(
    `
    <div class="grid grid-cols-2 gap-2">
      ${numberInput("rb-avg", t("replen.avg"), "", "any")}
      ${numberInput("rb-lead", `${t("replen.lead")} (${t("replen.d")})`, "", "any")}
    </div>
    <p class="mt-1.5 text-[11px] text-gray-500">${t("replen.inheritHint")}</p>
    ${scopeField("rb")}
    <p id="rb-preview" role="status" class="mt-3 rounded-xl bg-gray-50 px-3.5 py-2.5 text-xs font-semibold text-gray-700">${t("replen.previewLoading")}</p>
    <label class="mt-3 flex min-h-[44px] items-center gap-3 text-sm font-semibold text-gray-800">
      <input id="rb-clear" type="checkbox" class="h-5 w-5 shrink-0" disabled />
      <span id="rb-clear-label" class="min-w-0">${escapeHtml(tf("replen.clearOverrides", { k: 0 }))}</span>
    </label>
    <button id="rb-save" class="btn-primary mt-4 w-full" disabled>${t("settings.save")}</button>`,
    {
      title: escapeHtml(tf("replen.setAll", { n: size })) + " · " + escapeHtml(group.label),
      onMount: (sheet) => {
        const preview = sheet.querySelector("#rb-preview");
        const clear = sheet.querySelector("#rb-clear");
        const save = sheet.querySelector("#rb-save");
        const target = { scope: group.scope, key: group.key };
        let token = 0;
        const refresh = async () => {
          const mine = ++token;
          save.disabled = true;
          preview.textContent = t("replen.previewLoading");
          let res;
          try {
            res = await api.bulkRule({ ...target, branchId: scopeBranchId(sheet, "rb"), dryRun: true, clearOverrides: false });
          } catch (err) {
            if (mine === token) preview.textContent = err.message;
            return;
          }
          if (mine !== token) return;
          preview.textContent = tf("replen.preview", { n: res.affected, k: res.overrides });
          sheet.querySelector("#rb-clear-label").textContent = tf("replen.clearOverrides", { k: res.overrides });
          clear.disabled = res.overrides === 0;
          if (res.overrides === 0) clear.checked = false;
          save.disabled = false;
        };
        sheet.querySelector("#rb-scope").addEventListener("change", refresh);
        refresh();
        save.addEventListener("click", async () => {
          const a = readNumber(sheet.querySelector("#rb-avg"));
          const l = readNumber(sheet.querySelector("#rb-lead"));
          if (a === undefined || l === undefined) return toast(t("err.BAD_RULE"), "error");
          if (a === null && l === null) return toast(t("replen.needValue"), "error");
          save.disabled = true;
          try {
            await api.bulkRule({ ...target, branchId: scopeBranchId(sheet, "rb"), avgDailySell: a, leadTimeDays: l, clearOverrides: clear.checked, dryRun: false });
          } catch (err) {
            save.disabled = false;
            throw err;
          }
          closeSheet();
          toast(t("replen.saved"), "success");
          await load(root);
        });
      },
    }
  );
}

// ---- gold price (kept from the old Lead time screen; admin only) ----

function priceCard() {
  const c = priceConfig;
  return `
    <h2 class="mb-2.5 mt-6 text-[11px] font-extrabold uppercase tracking-wide text-gray-600">${t("settings.priceSection")}</h2>
    <div class="card p-4">
      <label for="spot-price" class="mb-1.5 block text-xs font-bold text-gray-600">${t("settings.spotPriceLabel")}</label>
      <input id="spot-price" type="number" min="0" step="1000" inputmode="numeric" value="${Number(c.spot_lak_per_baht) || ""}" class="input-filled text-center font-extrabold" />
      <label for="usd-rate" class="mb-1.5 mt-3 block text-xs font-bold text-gray-600">${t("settings.usdRateLabel")}</label>
      <input id="usd-rate" type="number" min="0" step="1" inputmode="numeric" value="${Number(c.usd_to_lak_rate) || ""}" class="input-filled text-center font-extrabold" />
      <p class="mt-2 text-[11px] text-gray-500">${t("settings.priceHint")}</p>
      <button id="save-config" class="btn-primary mt-4 w-full">${t("settings.save")}</button>
    </div>`;
}

function wirePriceCard(root) {
  root.querySelector("#save-config")?.addEventListener("click", async () => {
    const spot = Number(root.querySelector("#spot-price").value);
    const usd = Number(root.querySelector("#usd-rate").value);
    if (!(spot > 0)) return toast(t("settings.needSpotPrice"), "error");
    priceConfig = state.meta.config = await api.saveConfig({ spotLakPerBaht: spot, usdToLakRate: usd > 0 ? usd : 0 });
    toast(t("settings.savedToast"), "success");
  });
}
