// Executive dashboard: a briefing that answers management's questions in
// order (how much, how long, what needs a decision, what is stuck, what sells,
// which cases). Every figure comes from GET /api/executive, the same payload
// the report's tables read, so the two screens cannot disagree.
import { state, branchName } from "../state.js";
import { ribbonHtml, dailyColumnsHtml, barTrack, attachTips, bandFill, BAR_COLOR } from "../charts.js";
import { fmtBaht, fmtInt, fmtLak, escapeHtml, SHOW_VALUE, reorderChip } from "../util.js";
import { t, tf, productName } from "../i18n.js";
import { skuLabel } from "../sku-groups.js";
import { isManager } from "../session.js";
import { skeletonDashboard } from "../skeleton.js";
import { loadExecutive, execFiltersHtml, bindExecFilters } from "./exec-data.js";

const BANDS = ["order_now", "late", "ordered", "ok", "no_min"];
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
const bandLabel = (band) => t(`exec.band.${band}`);
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

// What a figure is weighed in: LAK while values are shown, else Baht (decided 2026-11-27).
const fmtBahtWord = (b) => `${fmtBaht(b, 2)} ${t("rep.col.baht")}`;
const money = (lak, baht) => (SHOW_VALUE ? fmtLak(lak) : fmtBahtWord(baht ?? 0));

function heroHtml(d) {
  const h = d.headline;
  const one = d.byBranch.length === 1;
  const value = n(esc(money(h.value_lak, h.baht)));
  const first = one ? tf("exec.heroValueOne", { value, branch: esc(branchName(d.byBranch[0].branch_id)) }) : tf("exec.heroValue", { value, n: n(h.branches) });
  const c = d.decisions.counts;
  const act = c.order_now + c.late;
  const second = act > 0 ? tf("exec.heroOrder", { n: `<span class="font-extrabold text-danger tnum">${act}</span>` }) : t("exec.heroOrderNone");
  const facts = [
    [fmtBaht(h.baht, 2), t("rep.col.baht")],
    [fmtInt(h.gram), "g"],
    [fmtInt(h.pcs), t("exec.pcsUnit")],
  ];
  const bands = d.ribbon.filter((b) => b.lines > 0);
  const totalLines = bands.reduce((s, b) => s + b.lines, 0) || 1;
  return `
  <section aria-labelledby="exec-hero">
    <p class="text-[11px] font-semibold text-gray-600">${esc(tf("exec.settled", { done: h.cases_done_today, n: h.cases }))}</p>
    <h2 id="exec-hero" class="mt-1.5 text-[25px] font-medium leading-[1.25] tracking-[-0.01em] text-gray-800 md:text-[28px]">${first} ${second}</h2>
    <dl class="mt-4 grid grid-cols-3 gap-2 border-y border-hairline py-3">
      ${facts
        .map(
          ([v, l]) => `<div class="min-w-0"><dt class="sr-only">${esc(l)}</dt><dd class="truncate text-sm font-extrabold text-gray-900 tnum">${esc(v)}</dd><div class="text-[10px] font-semibold text-gray-500">${esc(l)}</div></div>`
        )
        .join("")}
    </dl>
    ${SHOW_VALUE ? `<p class="mt-2 text-[11px] font-medium text-gray-500">${esc(tf("exec.priceLine", { price: fmtInt(d.price.lakPerBaht) }))}${d.priceStale ? ` <span class="font-bold text-warning">${t("exec.priceStale")}</span>` : ""}</p>` : ""}

    <div class="mt-5">
      <div class="mb-2 text-xs font-bold text-gray-700">${t("exec.ribbonTitle")}</div>
      <div data-chart>${ribbonHtml(
        bands.map((b) => {
          const pct = Math.round((b.lines / totalLines) * 1000) / 10;
          return { band: b.band, pct, tip: esc(`${bandLabel(b.band)}: ${lines(b.lines)} (${pct}%)`) };
        })
      )}</div>
      <ul class="mt-3 divide-y divide-hairline">
        ${bands
          .map(
            (b) => `<li><button type="button" data-band="${b.band}" class="focus-ring flex min-h-[44px] w-full items-center gap-2.5 py-2 text-left">
              <span class="h-3 w-3 shrink-0 rounded-sm" style="background:${bandFill(b.band)}" aria-hidden="true"></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-bold text-gray-900">${esc(bandLabel(b.band))}</span>
                <span class="block truncate text-[10px] text-gray-500">${esc(t(`exec.bandHint.${b.band}`))}</span>
              </span>
              <span class="shrink-0 text-right text-xs font-extrabold text-gray-900 tnum">${esc(lines(b.lines))}</span>
            </button></li>`
          )
          .join("")}
      </ul>
    </div>
  </section>`;
}

function decisionsHtml(d) {
  const c = d.decisions.counts;
  const act = c.order_now + c.late;
  const total = d.decisions.items.length;
  const lead =
    total === 0
      ? `<p class="text-sm font-medium text-gray-700">${t("exec.decideNone")}</p>`
      : act === 0
      ? `<p class="text-sm font-medium text-gray-700">${t("exec.decideAllCovered")}</p>`
      : `<p class="text-sm font-medium text-gray-700">${tf("exec.decideLead", { n: `<span class="text-lg font-extrabold text-danger tnum">${act}</span>` })}</p>`;
  const tally = [
    ["order_now", c.order_now, "text-danger"],
    ["late", c.late, "text-danger"],
    ["ordered", c.ordered, "text-warning"],
  ];
  const rows = d.decisions.items.slice(0, 8);
  return `
  <section>
    ${sectionHead(t("exec.q.decide"))}
    ${lead}
    ${
      total
        ? `<div class="card mt-3 p-0">
      <div class="grid grid-cols-3 divide-x divide-hairline border-b border-hairline">
        ${tally.map(([k, v, cls]) => `<div class="px-3 py-2.5"><div class="text-base font-extrabold tnum ${v ? cls : "text-gray-400"}">${v}</div><div class="text-[10px] font-semibold text-gray-600">${t(`exec.band.${k}`)}</div></div>`).join("")}
      </div>
      <ul class="divide-y divide-hairline">
        ${rows
          .map((it) => {
            const chip = reorderChip(it);
            const left = tf("exec.minLine", { has: fmtInt(it.position), min: it.min_qty ?? "–", lead: it.lead_days });
            return `<li class="flex items-center gap-3 px-4 py-2.5">
              <div class="min-w-0 flex-1">
                <div class="truncate text-xs font-bold text-gray-900">${esc(skuLabel(it))}</div>
                <div class="truncate text-[10px] text-gray-500">${esc(branchName(it.branch_id))} · ${esc(left)}</div>
              </div>
              <div class="flex shrink-0 flex-col items-end gap-0.5 text-right">
                ${chip ? `<span class="status-pill shrink-0 px-2 font-bold ${chip.cls}">${esc(chip.text)}</span>` : ""}
                ${it.action_doc ? `<span class="text-[10px] text-gray-500">${esc(it.action_doc)}</span>` : ""}
              </div>
            </li>`;
          })
          .join("")}
      </ul>
      <div class="flex flex-wrap gap-2 border-t border-hairline p-3">
        <button data-go="decide" class="btn-secondary flex-1 py-2 text-xs">${esc(tf("exec.seeAll", { n: total }))}</button>
        ${act > 0 && isManager(state.user) ? `<button data-go="documents" class="btn-primary flex-1 py-2 text-xs">${t("exec.makeProposal")}</button>` : ""}
      </div>
    </div>`
        : ""
    }
  </section>`;
}

function whereHtml(d) {
  const mode = state.exec.where;
  const weightOf = (x) => (SHOW_VALUE ? x.value_lak : x.baht);
  const list = (
    mode === "type"
      ? d.byType.filter((x) => weightOf(x) > 0).map((x) => ({ name: productName(x.name_en, x.name_lo), lo: true, ...x }))
      : d.byBranch.map((x) => ({ name: branchName(x.branch_id), lo: false, ...x }))
  ).sort((a, b) => weightOf(b) - weightOf(a));
  const sum = list.reduce((s, x) => s + weightOf(x), 0) || 1;
  const max = Math.max(1, ...list.map(weightOf));
  return `
  <section>
    ${sectionHead(t("exec.q.where"), segmented("where", [["branch", t("exec.byBranch")], ["type", t("exec.byType")]], mode))}
    <div class="card p-0" data-chart>
      <ul class="divide-y divide-hairline">
        ${list
          .map((x) => {
            const share = Math.round((weightOf(x) / sum) * 1000) / 10;
            return `<li class="px-4 py-3" tabindex="0" data-tip="${esc(`${x.name}: ${money(x.value_lak, x.baht)} (${share}%), ${fmtInt(x.pcs)} pcs`)}">
            <div class="flex items-baseline justify-between gap-2">
              <span ${x.lo ? 'lang="lo"' : ""} class="truncate text-xs font-bold text-gray-900">${esc(x.name)}</span>
              <span class="shrink-0 text-xs font-extrabold text-gray-900 tnum">${esc(money(x.value_lak, x.baht))} <span class="font-semibold text-gray-500">${share}%</span></span>
            </div>
            <div class="mt-1.5">${barTrack((weightOf(x) / max) * 100)}</div>
            <div class="mt-1.5 flex items-center gap-3 text-[10px] font-semibold text-gray-600">
              <span class="tnum">${esc(tf("exec.pcs", { n: fmtInt(x.pcs) }))}</span>
              ${x.critical ? `<span class="text-danger tnum">${esc(tf("exec.toOrder", { n: x.critical }))}</span>` : ""}
              ${x.warning ? `<span class="text-warning tnum">${x.warning} ${t("exec.band.ordered")}</span>` : ""}
            </div>
          </li>`;
          })
          .join("")}
      </ul>
    </div>
  </section>`;
}

// Held well over the minimum, in money: only while values are shown.
function slowHtml(d) {
  const s = d.slow;
  if (!SHOW_VALUE || s.count === 0) return "";
  return `
  <section>
    ${sectionHead(t("exec.q.slow"))}
    <p class="text-sm font-medium text-gray-700">${tf("exec.slowLead", { value: n(esc(fmtLak(s.value_lak))) })}</p>
    <div class="card mt-3 p-0">
      <ul class="divide-y divide-hairline">
        ${s.items
          .slice(0, 5)
          .map(
            (it) => `<li class="flex items-center gap-3 px-4 py-2.5">
          <div class="min-w-0 flex-1">
            <div class="truncate text-xs font-bold text-gray-900">${esc(skuLabel(it))}</div>
            <div class="truncate text-[10px] text-gray-500">${esc(branchName(it.branch_id))} · ${esc(tf("exec.minLine", { has: fmtInt(it.position), min: it.min_qty ?? "–", lead: it.lead_days }))}</div>
          </div>
          <div class="shrink-0 text-right">
            <div class="text-xs font-extrabold text-gray-900 tnum">${esc(fmtLak(it.value_lak))}</div>
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
        : `<p class="text-sm font-medium text-gray-700">${tf("exec.flowLead", { pcs: n(fmtInt(f.sold)), days, value: n(esc(money(f.sold_lak, f.sold_baht))) })}</p>
    <p class="mt-0.5 text-xs font-semibold ${f.change_pct == null ? "text-gray-500" : f.change_pct >= 0 ? "text-success" : "text-warning"}">${esc(change.replace("{days}", days))}</p>
    <div class="card mt-3 p-4">
      <div class="mb-2 text-xs font-bold text-gray-700">${t(SHOW_VALUE ? "exec.dailyTitle" : "exec.dailyTitlePcs")}</div>
      <div data-chart>${dailyColumnsHtml(
        d.daily.map((x) => ({ label: shortDate(x.date), value: SHOW_VALUE ? x.sold_lak : x.sold, tip: esc(`${shortDate(x.date)}: ${SHOW_VALUE ? `${fmtLak(x.sold_lak)}, ` : ""}${fmtInt(x.sold)} pcs`) })),
        { avgLabel: esc(tf("exec.avgPerDay", { value: SHOW_VALUE ? fmtLak(f.sold_lak / days) : `${fmtInt(f.sold / days)} pcs` })) }
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
            return `<li class="flex items-center gap-3 px-4 py-2.5" tabindex="0" data-tip="${esc(`${skuLabel(x)}: ${fmtInt(x.sold)} pcs, ${SHOW_VALUE ? `${fmtLak(x.sold_lak)}, ` : ""}${fmtBaht(x.sold_baht, 2)} ${t("rep.col.baht")}`)}">
            <span class="w-5 shrink-0 text-right text-xs font-extrabold text-gray-400 tnum">${i + 1}</span>
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-2">
                <span class="truncate text-xs font-bold text-gray-900">${esc(skuLabel(x))}</span>
                <span class="shrink-0 text-xs font-extrabold text-gray-900 tnum">${esc(tf("exec.pcs", { n: fmtInt(x.sold) }))}</span>
              </div>
              <div class="mt-1">${barTrack((x.sold / max) * 100, BAR_COLOR)}</div>
              <div class="mt-1 flex justify-between text-[10px] font-medium text-gray-500"><span class="tnum">${esc(money(x.sold_lak, x.sold_baht))}</span><span>${esc(move)}</span></div>
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
  const sold = (c) => (SHOW_VALUE ? c.sold_lak : c.sold);
  const top = d.cases.filter((c) => c.sold > 0).sort((a, b) => sold(b) - sold(a)).slice(0, 5);
  if (!top.length) return "";
  const max = Math.max(1, ...top.map(sold));
  return `
  <section>
    ${sectionHead(t("exec.q.cases"))}
    <div class="card p-0" data-chart>
      <ol class="divide-y divide-hairline">
        ${top
          .map(
            (c, i) => `<li class="flex items-center gap-3 px-4 py-2.5" tabindex="0" data-tip="${esc(`${c.display_name}: ${fmtInt(c.sold)} pcs${SHOW_VALUE ? `, ${fmtLak(c.sold_lak)}` : ""}`)}">
          <span class="w-5 shrink-0 text-right text-xs font-extrabold text-gray-400 tnum">${i + 1}</span>
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline justify-between gap-2">
              <span class="truncate text-xs font-bold text-gray-900">${esc(c.display_name)} <span class="font-semibold text-gray-500">${esc(c.desk_id)}</span></span>
              <span class="shrink-0 text-xs font-extrabold text-gray-900 tnum">${esc(SHOW_VALUE ? fmtLak(c.sold_lak) : tf("exec.pcs", { n: fmtInt(c.sold) }))}</span>
            </div>
            <div class="mt-1">${barTrack((sold(c) / max) * 100)}</div>
            <div class="mt-1 truncate text-[10px] font-medium text-gray-500">${esc(branchName(c.branch_id))}, ${esc(SHOW_VALUE ? tf("exec.caseLine", { held: fmtLak(c.held_lak), pct: Math.round(c.turn_pct) }) : tf("exec.caseLinePcs", { held: fmtInt(c.held_pcs) }))}</div>
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
