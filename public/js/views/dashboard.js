// Executive dashboard: a briefing that answers management's questions in
// order (how much, how long, what needs a decision, what is stuck, what sells,
// which cases). Every figure comes from GET /api/executive, the same payload
// the report's tables read, so the two screens cannot disagree.
import { state, branchName } from "../state.js";
import { ribbonHtml, dailyColumnsHtml, barTrack, attachTips, bandFill, BAR_COLOR } from "../charts.js";
import { fmtBaht, fmtInt, fmtLak, fmtUsd, escapeHtml } from "../util.js";
import { t, tf, productName } from "../i18n.js";
import { skuLabel } from "../sku-groups.js";
import { isManager } from "../session.js";
import { skeletonDashboard } from "../skeleton.js";
import { loadExecutive, execFiltersHtml, bindExecFilters, fmtDays } from "./exec-data.js";

const BANDS = ["critical", "warning", "ok", "long", "no_sales", "unknown"];
const esc = escapeHtml;

export async function mountDashboard() {
  renderTopbar();
  await refreshDashboard();
}

function renderTopbar() {
  const el = document.getElementById("topbar-slot");
  el.innerHTML = `
    <div>
      <h1 class="text-lg font-extrabold text-gray-900">${t("dashboard.title")}</h1>
      <p class="text-[11px] font-medium text-gray-600">${t("exec.subtitle")}</p>
    </div>
    ${execFiltersHtml()}`;
  bindExecFilters(() => refreshDashboard());
}

async function refreshDashboard() {
  const root = document.getElementById("view-root");
  root.innerHTML = skeletonDashboard();
  let data;
  try {
    data = await loadExecutive();
  } catch (err) {
    root.innerHTML = `<div class="card px-4 py-8 text-center">
      <p class="text-sm font-semibold text-gray-700">${t("exec.loadError")}</p>
      <p class="mt-1 text-xs text-gray-500">${esc(err?.message ?? "")}</p>
      <button id="exec-retry" class="btn-secondary mt-4">${t("exec.retry")}</button></div>`;
    document.getElementById("exec-retry").addEventListener("click", refreshDashboard);
    return;
  }
  if (!root.isConnected) return;
  render(root, data);
}

// Report deep links: the dashboard's "see all" goes to the matching table.
function openReport(tab, posFilter = "all") {
  state.report.tab = tab;
  state.report.posFilter = posFilter;
  window.switchView("report");
}

const lines = (k) => (k === 1 ? t("exec.line1") : tf("exec.lines", { n: k }));
const bandLabel = (band, slowDays) => tf(`exec.band.${band}`, { d: slowDays });
const n = (v) => `<span class="font-extrabold text-gray-900 tnum">${v}</span>`;
const shortDate = (iso) => `${Number(iso.slice(8))}/${Number(iso.slice(5, 7))}`;

function sectionHead(question, aside = "") {
  return `<div class="mb-2.5 mt-8 flex items-end justify-between gap-3">
    <h2 class="text-[17px] font-extrabold leading-snug text-gray-900">${question}</h2>${aside}</div>`;
}

function segmented(name, options, current) {
  return `<div class="flex shrink-0 rounded-lg bg-gray-100 p-0.5" role="group">
    ${options
      .map(
        ([value, label]) =>
          `<button type="button" data-seg-${name}="${value}" aria-pressed="${value === current}" class="focus-ring rounded-md px-2.5 py-1 text-[11px] font-bold ${
            value === current ? "bg-white text-brand-700 shadow-card" : "text-gray-600"
          }">${label}</button>`
      )
      .join("")}
  </div>`;
}

function statusPill(band) {
  const cls = band === "critical" ? "bg-danger-bg text-danger" : "bg-warning-bg text-warning";
  return `<span class="status-pill shrink-0 ${cls}">${band === "critical" ? "!" : "•"} ${t(`exec.band.${band}`)}</span>`;
}

// ---------------------------------------------------------------------------
function render(root, d) {
  const h = d.headline;
  if (h.lines === 0) {
    root.innerHTML = `<div class="card mt-2 px-5 py-10 text-center text-sm font-medium text-gray-600">${t("exec.noData")}</div>`;
    return;
  }
  root.innerHTML = `
    ${heroHtml(d)}
    ${decisionsHtml(d)}
    ${whereHtml(d)}
    ${slowHtml(d)}
    ${fastHtml(d)}
    ${casesHtml(d)}
    <button id="exec-open-report" class="btn-secondary mt-8 w-full">${t("exec.openReport")}</button>
  `;
  root.querySelectorAll("[data-chart]").forEach(attachTips);
  bind(root, d);
}

function heroHtml(d) {
  const h = d.headline;
  const one = d.byBranch.length === 1;
  const value = n(esc(fmtLak(h.value_lak)));
  const first = one ? tf("exec.heroValueOne", { value, branch: esc(branchName(d.byBranch[0].branch_id)) }) : tf("exec.heroValue", { value, n: n(h.branches) });
  const second = h.cover_days != null ? tf("exec.heroCover", { days: n(fmtDays(h.cover_days)) }) : t("exec.heroCoverNone");
  const facts = [
    [fmtBaht(h.baht, 2), t("rep.col.baht")],
    [fmtInt(h.gram), "g"],
    [fmtInt(h.pcs), t("exec.pcsUnit")],
    ...(d.price.usdToLak > 0 ? [[fmtUsd(h.value_usd), "USD"]] : []),
  ];
  const bands = d.ribbon.filter((b) => b.lines > 0);
  return `
  <section aria-labelledby="exec-hero">
    <p class="text-[11px] font-semibold text-gray-600">${esc(tf("exec.settled", { done: h.cases_done_today, n: h.cases }))}</p>
    <h2 id="exec-hero" class="mt-1.5 text-[25px] font-medium leading-[1.25] tracking-[-0.01em] text-gray-800 md:text-[28px]">${first} ${second}</h2>
    <dl class="mt-4 grid grid-cols-4 gap-2 border-y border-hairline py-3">
      ${facts
        .map(
          ([v, l]) => `<div class="min-w-0"><dt class="sr-only">${esc(l)}</dt><dd class="truncate text-sm font-extrabold text-gray-900 tnum">${esc(v)}</dd><div class="text-[10px] font-semibold text-gray-500">${esc(l)}</div></div>`
        )
        .join("")}
    </dl>
    <p class="mt-2 text-[11px] font-medium text-gray-500">${esc(tf("exec.priceLine", { price: fmtInt(d.price.lakPerBaht) }))}${d.priceStale ? ` <span class="font-bold text-warning">${t("exec.priceStale")}</span>` : ""}</p>

    <div class="mt-5">
      <div class="mb-2 text-xs font-bold text-gray-700">${t("exec.ribbonTitle")}</div>
      <div data-chart>${ribbonHtml(
        bands.map((b) => ({ band: b.band, pct: b.pct, tip: esc(`${bandLabel(b.band, d.slowDays)}: ${fmtLak(b.value_lak)} (${b.pct}%), ${lines(b.lines)}`) }))
      )}</div>
      <ul class="mt-3 divide-y divide-hairline">
        ${bands
          .map(
            (b) => `<li><button type="button" data-band="${b.band}" class="focus-ring flex w-full items-center gap-2.5 py-2 text-left">
              <span class="h-3 w-3 shrink-0 rounded-sm" style="background:${bandFill(b.band)}" aria-hidden="true"></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-bold text-gray-900">${esc(bandLabel(b.band, d.slowDays))}</span>
                <span class="block truncate text-[10px] text-gray-500">${esc(tf(`exec.bandHint.${b.band}`, { d: d.slowDays }))}</span>
              </span>
              <span class="shrink-0 text-right">
                <span class="block text-xs font-extrabold text-gray-900 tnum">${esc(fmtLak(b.value_lak))}</span>
                <span class="block text-[10px] text-gray-500 tnum">${esc(lines(b.lines))}</span>
              </span>
            </button></li>`
          )
          .join("")}
      </ul>
      ${h.cover_days != null && h.cover_basis_pct < 100 ? `<p class="mt-1 text-[10px] text-gray-500">${esc(tf("exec.coverBasis", { pct: Math.round(h.cover_basis_pct) }))}</p>` : ""}
    </div>
  </section>`;
}

function decisionsHtml(d) {
  const c = d.decisions.counts;
  const noAction = c.critical.none + c.warning.none;
  const total = d.decisions.items.length;
  const lead =
    total === 0
      ? `<p class="text-sm font-medium text-gray-700">${t("exec.decideNone")}</p>`
      : noAction === 0
      ? `<p class="text-sm font-medium text-gray-700">${t("exec.decideAllCovered")}</p>`
      : `<p class="text-sm font-medium text-gray-700">${tf("exec.decideLead", { n: `<span class="text-lg font-extrabold text-danger tnum">${noAction}</span>` })}</p>`;
  const tally = [
    ["none", c.critical.none + c.warning.none, "text-danger"],
    ["pending", c.critical.pending + c.warning.pending, "text-warning"],
    ["approved", c.critical.approved + c.warning.approved, "text-success"],
  ];
  const rows = d.decisions.items.slice(0, 6);
  return `
  <section>
    ${sectionHead(t("exec.q.decide"))}
    ${lead}
    ${
      total
        ? `<div class="card mt-3 p-0">
      <div class="grid grid-cols-3 divide-x divide-hairline border-b border-hairline">
        ${tally.map(([k, v, cls]) => `<div class="px-3 py-2.5"><div class="text-base font-extrabold tnum ${v ? cls : "text-gray-400"}">${v}</div><div class="text-[10px] font-semibold text-gray-600">${t(`exec.action.${k}`)}</div></div>`).join("")}
      </div>
      <ul class="divide-y divide-hairline">
        ${rows
          .map((it) => {
            const left = it.position <= 0 ? tf("exec.outNow", { lead: it.lead_days }) : tf("exec.daysLeft", { d: fmtDays(it.runway_days), lead: it.lead_days });
            const right =
              it.action === "none"
                ? it.suggested_qty > 0
                  ? `<span class="text-[11px] font-bold text-gray-900">${esc(tf("exec.suggest", { n: it.suggested_qty }))}</span>`
                  : ""
                : `<span class="text-[11px] font-bold ${it.action === "approved" ? "text-success" : "text-warning"}">${t(`exec.action.${it.action}`)}</span>${it.action_doc ? `<span class="block text-[10px] text-gray-500">${esc(it.action_doc)}</span>` : ""}`;
            return `<li class="flex items-center gap-3 px-4 py-2.5">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2"><span class="truncate text-xs font-bold text-gray-900">${esc(skuLabel(it))}</span></div>
                <div class="truncate text-[10px] text-gray-500">${esc(branchName(it.branch_id))}, ${esc(left)}</div>
              </div>
              <div class="flex shrink-0 flex-col items-end gap-1 text-right">${statusPill(it.band)}${right}</div>
            </li>`;
          })
          .join("")}
      </ul>
      <div class="flex flex-wrap gap-2 border-t border-hairline p-3">
        ${total > rows.length || total > 0 ? `<button data-go="decide" class="btn-secondary flex-1 py-2 text-xs">${esc(tf("exec.seeAll", { n: total }))}</button>` : ""}
        ${noAction > 0 && isManager(state.user) ? `<button data-go="documents" class="btn-primary flex-1 py-2 text-xs">${t("exec.makeProposal")}</button>` : ""}
      </div>
    </div>`
        : ""
    }
  </section>`;
}

function whereHtml(d) {
  const mode = state.exec.where;
  const list =
    mode === "type"
      ? d.byType.filter((x) => x.value_lak > 0).map((x) => ({ name: productName(x.name_en, x.name_lo), lo: true, ...x }))
      : d.byBranch.map((x) => ({ name: branchName(x.branch_id), lo: false, ...x }));
  const max = Math.max(1, ...list.map((x) => x.value_lak));
  return `
  <section>
    ${sectionHead(t("exec.q.where"), segmented("where", [["branch", t("exec.byBranch")], ["type", t("exec.byType")]], mode))}
    <p class="mb-2 text-[10px] text-gray-500">${t("exec.coverHint")}</p>
    <div class="card p-0" data-chart>
      <ul class="divide-y divide-hairline">
        ${list
          .map(
            (x) => `<li class="px-4 py-3" tabindex="0" data-tip="${esc(`${x.name}: ${fmtLak(x.value_lak)} (${x.share_pct}%), ${fmtBaht(x.baht, 2)} ${t("rep.col.baht")}, ${fmtInt(x.pcs)} pcs`)}">
            <div class="flex items-baseline justify-between gap-2">
              <span ${x.lo ? 'lang="lo"' : ""} class="truncate text-xs font-bold text-gray-900">${esc(x.name)}</span>
              <span class="shrink-0 text-xs font-extrabold text-gray-900 tnum">${esc(fmtLak(x.value_lak))} <span class="font-semibold text-gray-500">${x.share_pct}%</span></span>
            </div>
            <div class="mt-1.5">${barTrack((x.value_lak / max) * 100)}</div>
            <div class="mt-1.5 flex items-center gap-3 text-[10px] font-semibold text-gray-600">
              <span class="tnum">${x.cover_days != null ? esc(tf("exec.coverDays", { d: fmtDays(x.cover_days) })) : "–"}</span>
              ${x.critical ? `<span class="text-danger tnum">${x.critical} ${t("exec.band.critical")}</span>` : ""}
              ${x.warning ? `<span class="text-warning tnum">${x.warning} ${t("exec.band.warning")}</span>` : ""}
            </div>
          </li>`
          )
          .join("")}
      </ul>
    </div>
  </section>`;
}

function slowHtml(d) {
  const s = d.slow;
  if (s.count === 0) {
    return `<section>${sectionHead(t("exec.q.slow"))}<p class="text-sm font-medium text-gray-700">${esc(tf("exec.slowNone", { d: d.slowDays }))}</p></section>`;
  }
  return `
  <section>
    ${sectionHead(t("exec.q.slow"))}
    <p class="text-sm font-medium text-gray-700">${tf("exec.slowLead", { value: n(esc(fmtLak(s.value_lak))), d: d.slowDays })}</p>
    ${s.excess_lak > 0 ? `<p class="mt-0.5 text-xs text-gray-600">${esc(tf("exec.slowExcess", { value: fmtLak(s.excess_lak), d: d.slowDays }))}</p>` : ""}
    <div class="card mt-3 p-0">
      <ul class="divide-y divide-hairline">
        ${s.items
          .slice(0, 5)
          .map(
            (it) => `<li class="flex items-center gap-3 px-4 py-2.5">
          <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style="background:${bandFill(it.band)}" aria-hidden="true"></span>
          <div class="min-w-0 flex-1">
            <div class="truncate text-xs font-bold text-gray-900">${esc(skuLabel(it))}</div>
            <div class="truncate text-[10px] text-gray-500">${esc(branchName(it.branch_id))}, ${esc(it.band === "no_sales" ? t("exec.band.no_sales") : tf("exec.lasts", { d: fmtDays(it.runway_days) }))}</div>
          </div>
          <div class="shrink-0 text-right">
            <div class="text-xs font-extrabold text-gray-900 tnum">${esc(fmtLak(it.value_lak))}</div>
            ${it.excess_lak > 0 ? `<div class="text-[10px] font-semibold text-gray-500 tnum">${esc(tf("exec.excess", { value: fmtLak(it.excess_lak) }))}</div>` : ""}
          </div>
        </li>`
          )
          .join("")}
      </ul>
      ${s.count > 5 ? `<div class="border-t border-hairline p-3"><button data-go="slow" class="btn-secondary w-full py-2 text-xs">${esc(tf("exec.seeAll", { n: s.count }))}</button></div>` : ""}
    </div>
  </section>`;
}

function fastHtml(d) {
  const f = d.flow;
  const days = d.period.days;
  const change =
    f.change_pct == null
      ? t("exec.flowNoPrev")
      : f.change_pct >= 0
      ? tf("exec.flowUp", { pct: Math.abs(f.change_pct), days })
      : tf("exec.flowDown", { pct: Math.abs(f.change_pct), days });
  const top = d.stockOut.slice(0, state.exec.top);
  const max = Math.max(1, ...top.map((x) => x.sold));
  const split = [
    ["grid.retail", f.retail],
    ["grid.wholesale", f.wholesale],
    ["grid.withdraw", f.withdraw],
    ["grid.destock", f.returned],
  ];
  return `
  <section>
    ${sectionHead(t("exec.q.fast"), segmented("top", [["5", t("exec.top5")], ["10", t("exec.top10")]], String(state.exec.top)))}
    ${
      f.sold === 0 && f.returned === 0
        ? `<p class="text-sm font-medium text-gray-700">${t("exec.noOut")}</p>`
        : `<p class="text-sm font-medium text-gray-700">${tf("exec.flowLead", { pcs: n(fmtInt(f.sold)), days, value: n(esc(fmtLak(f.sold_lak))) })}</p>
    <p class="mt-0.5 text-xs font-semibold ${f.change_pct == null ? "text-gray-500" : f.change_pct >= 0 ? "text-success" : "text-warning"}">${esc(change.replace("{days}", days))}</p>
    <div class="card mt-3 p-4">
      <div class="mb-2 text-xs font-bold text-gray-700">${t("exec.dailyTitle")}</div>
      <div data-chart>${dailyColumnsHtml(
        d.daily.map((x) => ({ label: shortDate(x.date), value: x.sold_lak, tip: esc(`${shortDate(x.date)}: ${fmtLak(x.sold_lak)}, ${fmtInt(x.sold)} pcs`) })),
        { avgLabel: esc(tf("exec.avgPerDay", { value: fmtLak(f.sold_lak / days) })) }
      )}</div>
      <div class="mt-3 grid grid-cols-4 gap-2 border-t border-hairline pt-3">
        ${split.map(([k, v]) => `<div><div class="text-sm font-extrabold text-gray-900 tnum">${fmtInt(v)}</div><div class="truncate text-[10px] font-semibold text-gray-500">${t(k)}</div></div>`).join("")}
      </div>
    </div>
    <div class="card mt-3 p-0" data-chart>
      <ol class="divide-y divide-hairline">
        ${top
          .map((x, i) => {
            const move = f.prev_sold === 0 ? "" : x.prev_rank == null ? t("exec.rankNew") : x.prev_rank === i + 1 ? "" : tf("exec.rankWas", { n: x.prev_rank });
            return `<li class="flex items-center gap-3 px-4 py-2.5" tabindex="0" data-tip="${esc(`${skuLabel(x)}: ${fmtInt(x.sold)} pcs, ${fmtLak(x.sold_lak)}, ${fmtBaht(x.sold_baht, 2)} ${t("rep.col.baht")}`)}">
            <span class="w-5 shrink-0 text-right text-xs font-extrabold text-gray-400 tnum">${i + 1}</span>
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-2">
                <span class="truncate text-xs font-bold text-gray-900">${esc(skuLabel(x))}</span>
                <span class="shrink-0 text-xs font-extrabold text-gray-900 tnum">${esc(tf("exec.pcs", { n: fmtInt(x.sold) }))}</span>
              </div>
              <div class="mt-1">${barTrack((x.sold / max) * 100, BAR_COLOR)}</div>
              <div class="mt-1 flex justify-between text-[10px] font-medium text-gray-500"><span class="tnum">${esc(fmtLak(x.sold_lak))}</span><span>${esc(move)}</span></div>
            </div>
          </li>`;
          })
          .join("")}
      </ol>
      ${d.stockOut.length > top.length ? `<div class="border-t border-hairline p-3"><button data-go="out" class="btn-secondary w-full py-2 text-xs">${esc(tf("exec.seeAll", { n: d.stockOut.length }))}</button></div>` : ""}
    </div>`
    }
  </section>`;
}

function casesHtml(d) {
  const top = d.cases.filter((c) => c.sold > 0).slice(0, 5);
  if (!top.length) return "";
  const max = Math.max(1, ...top.map((c) => c.sold_lak));
  return `
  <section>
    ${sectionHead(t("exec.q.cases"))}
    <div class="card p-0" data-chart>
      <ol class="divide-y divide-hairline">
        ${top
          .map(
            (c, i) => `<li class="flex items-center gap-3 px-4 py-2.5" tabindex="0" data-tip="${esc(`${c.display_name}: ${fmtInt(c.sold)} pcs, ${fmtLak(c.sold_lak)}`)}">
          <span class="w-5 shrink-0 text-right text-xs font-extrabold text-gray-400 tnum">${i + 1}</span>
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline justify-between gap-2">
              <span class="truncate text-xs font-bold text-gray-900">${esc(c.display_name)} <span class="font-semibold text-gray-500">${esc(c.desk_id)}</span></span>
              <span class="shrink-0 text-xs font-extrabold text-gray-900 tnum">${esc(fmtLak(c.sold_lak))}</span>
            </div>
            <div class="mt-1">${barTrack((c.sold_lak / max) * 100)}</div>
            <div class="mt-1 truncate text-[10px] font-medium text-gray-500">${esc(branchName(c.branch_id))}, ${esc(tf("exec.caseLine", { held: fmtLak(c.held_lak), pct: Math.round(c.turn_pct) }))}</div>
          </div>
        </li>`
          )
          .join("")}
      </ol>
      ${d.cases.length > top.length ? `<div class="border-t border-hairline p-3"><button data-go="cases" class="btn-secondary w-full py-2 text-xs">${esc(tf("exec.seeAll", { n: d.cases.length }))}</button></div>` : ""}
    </div>
  </section>`;
}

function bind(root, d) {
  root.querySelector("#exec-open-report")?.addEventListener("click", () => openReport("position"));
  root.querySelectorAll("[data-band]").forEach((b) => b.addEventListener("click", () => openReport("position", b.dataset.band)));
  root.querySelectorAll("[data-go]").forEach((b) =>
    b.addEventListener("click", () => {
      const go = b.dataset.go;
      if (go === "documents") window.switchView("documents");
      else if (go === "decide") openReport("position", "decide");
      else if (go === "slow") openReport("position", "slow");
      else openReport(go);
    })
  );
  root.querySelectorAll("[data-seg-where]").forEach((b) =>
    b.addEventListener("click", () => {
      state.exec.where = b.dataset.segWhere;
      render(root, d);
    })
  );
  root.querySelectorAll("[data-seg-top]").forEach((b) =>
    b.addEventListener("click", () => {
      state.exec.top = Number(b.dataset.segTop);
      render(root, d);
    })
  );
}

export { BANDS };
