"""Build the Morning Market reset SQL from the case workbook (decided 2026-11-27).

    python -I scripts/build_mm_seed.py "ລາຍລະອຽດເຄື່ອງຕູ້_1-7 morning market actual.xlsx"

Writes supabase/reset/20261127_morning_market_reset.sql and prints the list of
spelling fixes applied. One sheet = one case (ຕູ້1..ຕູ້7 -> MM-D01..MM-D07).

Columns: A type, B grams per piece (merged down a group), C name, D detail,
E pieces (= opening balance on 2026-11-27). Subtotal rows (A = ລວມ…) and the
grand total are skipped. A SKU is type + weight + name; column D becomes the
SKU's detail line. Weights become a size in ບາດ (grams / 15); 1 g stays 1 ກລາມ.
"""
import json
import re
import sys
import unicodedata
from collections import OrderedDict
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "supabase" / "reset" / "20261127_morning_market_reset.sql"
BRANCH = "B-MM"
OPEN_DATE = "2026-11-27"

# Spelling fixes (whole-word replacements inside names / types), in order.
FIXES = [
    ("ປ້ອງອອ້ອຍ", "ປ້ອງອ້ອຍ"),
    ("ດູງງ", "ດູກງູ"),
    ("ຍ່ອຍ", "ຍ້ອຍ"),
    ("ໃຫ່ຍ", "ໃຫຍ່"),
    ("ໃຫ່ມ", "ໃໝ່"),
    ("ໝ້າໂຕະ", "ໜ້າໂຕະ"),
    ("ຍີງ", "ຍິງ"),
]
# Whole names that mean the same product.
SAME_NAME = {
    "ພະປະຈຳເກີດ": "ພະປະຈຳວັນເກີດ",
    "ພະຈຳວັນເກີດ": "ພະປະຈຳວັນເກີດ",
    "ພະລວມປະຈຳວັນ": "ພະປະຈຳວັນເກີດ",
}
# Type names: ຄໍແທ່ງ ("neck bar") is the gold bar ຄຳແທ່ງ.
TYPE_FIX = {"ຄໍແທ່ງ": "ຄຳແທ່ງ"}
# Rounded grams in the sheet -> the Baht they stand for.
BAHT_OF_GRAMS = {0.75: 0.05, 1.12: 0.075, 1.87: 0.125}
ICON = [("ສາຍຄໍ", "necklace"), ("ສາຍແຂນ", "bracelet"), ("ແຫວນ", "ring"), ("ຕຸ້ງຫູ", "ring"), ("ກີ້", "necklace"), ("ຄຳແທ່ງ", "bar"), ("ແຜ່ນຄຳ", "bar")]

changes = []


def norm(s):
    if s is None:
        return ""
    s = unicodedata.normalize("NFC", str(s))
    return re.sub(r"\s+", " ", s.replace(" ", " ")).strip()


def fix(text, where):
    out = text
    for a, b in FIXES:
        out = out.replace(a, b)
    out = SAME_NAME.get(out, out)
    if out != text:
        changes.append((where, text, out))
    return out


def sql(v):
    if v is None:
        return "null"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def size_of(grams, type_name):
    if type_name == "ຄຳແທ່ງ" and grams == 1:
        return ("ກລາມ", 1)
    baht = BAHT_OF_GRAMS.get(grams, round(grams / 15, 4))
    return ("ບາດ", baht)


def qty_label(q):
    return ("%.4f" % q).rstrip("0").rstrip(".")


def main(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    types = OrderedDict()  # name -> type_id
    sizes = OrderedDict()  # (unit, qty) -> weight_id
    skus = OrderedDict()  # (type, unit, qty, name) -> {sku_id, detail, ...}
    cases = []  # [(desk_id, name, {sku_id: qty})]
    for n, ws in enumerate(wb.worksheets, start=1):
        merged = {}
        for rng in ws.merged_cells.ranges:
            top = ws.cell(rng.min_row, rng.min_col).value
            for r in range(rng.min_row, rng.max_row + 1):
                for c in range(rng.min_col, rng.max_col + 1):
                    merged[(r, c)] = top
        val = lambda r, c: merged.get((r, c), ws.cell(r, c).value)
        holding = OrderedDict()
        last_type, last_grams = None, None
        for r in range(3, ws.max_row + 1):
            a, b, c, d, e = (val(r, i) for i in range(1, 6))
            a_txt = norm(a)
            if a_txt.startswith("ລວມ"):
                continue
            if not isinstance(e, (int, float)) or e <= 0:
                continue
            type_name = a_txt or last_type
            grams = float(b) if isinstance(b, (int, float)) else last_grams
            last_type, last_grams = type_name, grams
            type_name = TYPE_FIX.get(type_name, type_name)
            if type_name != a_txt and a_txt:
                changes.append((f"{ws.title} row {r} type", a_txt, type_name))
            type_name = fix(type_name, f"{ws.title} row {r} type")
            name = norm(c)
            detail = norm(d)
            # ຕູ້7 writes the ring size into the name too: column D wins.
            m = re.match(r"^(.*?)\s+(ເບີ\S+)$", name)
            if m:
                changes.append((f"{ws.title} row {r} name", name, m.group(1)))
                name = m.group(1)
                detail = detail or m.group(2)
            name = fix(name, f"{ws.title} row {r} name") if name else type_name
            detail = fix(detail, f"{ws.title} row {r} detail") if detail else ""
            unit, q = size_of(round(grams, 2), type_name)
            types.setdefault(type_name, f"T{len(types) + 1:02d}")
            sizes.setdefault((unit, q), None)
            key = (type_name, unit, q, name)
            if key not in skus:
                skus[key] = {"sku_id": f"MM{len(skus) + 1:04d}", "detail": detail}
            elif detail and skus[key]["detail"] and detail != skus[key]["detail"]:
                changes.append((f"{ws.title} row {r} merged into one SKU", f"{name} {detail}", f"{name} {skus[key]['detail']}"))
            sid = skus[key]["sku_id"]
            holding[sid] = holding.get(sid, 0) + int(e)
        cases.append((f"MM-D{n:02d}", norm(ws.title), holding))

    # Size ids, biggest unit first then by amount.
    ordered = sorted(sizes, key=lambda k: (0 if k[0] == "ບາດ" else 1, k[1]))
    for i, k in enumerate(ordered, start=1):
        sizes[k] = (f"WMM{i:02d}", i)

    L = []
    w = L.append
    w("-- ============================================================================")
    w("-- RESET to the Morning Market cases (decided 2026-11-27). Generated by")
    w("-- scripts/build_mm_seed.py from the case workbook; do not edit by hand.")
    w("--")
    w("-- Run AFTER migration 20261127_21_min_stock.sql, in the Supabase SQL editor.")
    w("-- One transaction: if anything fails, nothing changes.")
    w("--   1. Copies every table it empties into schema kpv_backup_20261127.")
    w("--   2. Empties, in EVERY branch: documents, transfers, stock days and")
    w("--      ledger, cases, case assignments, min/lead rules, SKUs, sizes, types.")
    w("--      Users, branches, units, closed days, settings, gold prices and the")
    w("--      audit log are kept.")
    w(f"--   3. Loads {len(types)} types, {len(sizes)} sizes, {len(skus)} SKUs and {len(cases)} cases")
    w(f"--      (ຕູ້1..ຕູ້7, {BRANCH}) opened and checked in on {OPEN_DATE}.")
    w("-- ============================================================================")
    w("begin;")
    w("")
    w("-- 1. Backup (a second run keeps the first backup).")
    w("create schema if not exists kpv_backup_20261127;")
    wipe = [
        "document_rows", "documents", "transfers", "daily_stock_ledger", "desk_days",
        "staff_main_case", "desk_assignment", "replenishment_rule", "branch_sku", "desks",
        "master_sku", "sku_weight", "sku_type",
    ]
    for t in wipe:
        w(f"do $$ begin if to_regclass('kpv_backup_20261127.{t}') is null then "
          f"execute 'create table kpv_backup_20261127.{t} as table public.{t}'; end if; end $$;")
    w("")
    w("-- 2. Empty. Guard triggers (Done-day lock, role checks, audit) are switched")
    w("--    off only for these deletes and back on before anything is loaded.")
    for t in wipe:
        w(f"alter table {t} disable trigger user;")
    for t in wipe:
        w(f"delete from {t};")
    for t in wipe:
        w(f"alter table {t} enable trigger user;")
    w("")
    w("-- 3. Load.")
    w("insert into sku_type (type_id, name_en, name_lo, icon, active, sort_order) values")
    rows = []
    for i, (name, tid) in enumerate(types.items(), start=1):
        icon = next((ic for prefix, ic in ICON if name.startswith(prefix)), "ring")
        rows.append(f"  ({sql(tid)}, {sql(name)}, {sql(name)}, {sql(icon)}, true, {i})")
    w(",\n".join(rows) + ";")
    w("")
    w("-- Sizes: grams from the unit list, so they follow Settings > Units.")
    w("insert into sku_weight (weight_id, name_en, qty, unit, parts, gram_value, active, sort_order)")
    w("select v.weight_id, v.qty_label || ' ' || v.unit, v.qty, v.unit,")
    w("       jsonb_build_array(jsonb_build_object('unit', v.unit, 'qty', v.qty)),")
    w("       round(v.qty * u.gram_value, 4), true, v.sort_order")
    w("  from (values")
    rows = []
    for (unit, q), (wid, order) in sizes.items():
        rows.append(f"    ({sql(wid)}, {sql(qty_label(q))}, {q}::numeric, {sql(unit)}, {order})")
    w(",\n".join(rows))
    w("  ) as v(weight_id, qty_label, qty, unit, sort_order)")
    w("  join sku_unit u on u.unit = v.unit;")
    w("")
    w("do $$ begin")
    w(f"  if (select count(*) from sku_weight) <> {len(sizes)} then")
    w("    raise exception 'UNIT_MISSING: add the units ບາດ and ກລາມ in Settings > Units first';")
    w("  end if;")
    w("end $$;")
    w("")
    w("insert into master_sku (sku_id, name_en, name_lo, detail, category, type_id, weight_id, std_gram_weight, baht_weight, reorder_level, active, icon)")
    w("select v.sku_id, v.name, v.name, nullif(v.detail, ''), t.name_en, t.type_id, s.weight_id, s.gram_value, round(s.gram_value / 15.244, 4), 0, true, t.icon")
    w("  from (values")
    rows = []
    for (tname, unit, q, name), info in skus.items():
        rows.append(f"    ({sql(info['sku_id'])}, {sql(name)}, {sql(info['detail'])}, {sql(types[tname])}, {sql(sizes[(unit, q)][0])})")
    w(",\n".join(rows))
    w("  ) as v(sku_id, name, detail, type_id, weight_id)")
    w("  join sku_type t on t.type_id = v.type_id")
    w("  join sku_weight s on s.weight_id = v.weight_id;")
    w("")
    w(f"insert into branch_sku (branch_id, sku_id, carried) select {sql(BRANCH)}, sku_id, true from master_sku;")
    w("")
    w("-- Cases, each with its frozen starting stock.")
    for i, (desk_id, title, holding) in enumerate(cases, start=1):
        skus_json = json.dumps(holding, ensure_ascii=False)
        w(f"insert into desks (desk_id, branch_id, display_name, active, sort_order, initial_stock)")
        w(f"select {sql(desk_id)}, {sql(BRANCH)}, {sql(title)}, true, {i},")
        w(f"       jsonb_build_object('skus', {sql(skus_json)}::jsonb, 'total_pcs', {sum(holding.values())},")
        w(f"         'total_baht', (select round(sum(m.baht_weight * (j.value)::int), 4) from jsonb_each_text({sql(skus_json)}::jsonb) j join master_sku m on m.sku_id = j.key));")
    w("")
    w(f"insert into desk_days (desk_id, ledger_date, branch_id, status)")
    w(f"select desk_id, date {sql(OPEN_DATE)}, branch_id, 'check_in' from desks;")
    w("")
    w("insert into daily_stock_ledger (ledger_date, desk_id, branch_id, sku_id, opening_qty) values")
    rows = []
    for desk_id, _title, holding in cases:
        for sid, qty in holding.items():
            rows.append(f"  (date {sql(OPEN_DATE)}, {sql(desk_id)}, {sql(BRANCH)}, {sql(sid)}, {qty})")
    w(",\n".join(rows) + ";")
    w("")
    total = sum(sum(h.values()) for _d, _t, h in cases)
    w("-- 4. Check, then one audit entry for the whole reset.")
    w("do $$ begin")
    w(f"  if (select count(*) from master_sku) <> {len(skus)} then raise exception 'RESET_CHECK: SKU count'; end if;")
    w(f"  if (select count(*) from desks) <> {len(cases)} then raise exception 'RESET_CHECK: case count'; end if;")
    w(f"  if (select sum(opening_qty) from daily_stock_ledger) <> {total} then raise exception 'RESET_CHECK: pieces'; end if;")
    w("end $$;")
    w("insert into audit_log (actor_name, action, target, detail)")
    w(f"values ('system', 'data.reset', {sql(BRANCH)}, jsonb_build_object('source', 'ລາຍລະອຽດເຄື່ອງຕູ້_1-7 morning market actual.xlsx', 'date', {sql(OPEN_DATE)},")
    w(f"        'types', {len(types)}, 'sizes', {len(sizes)}, 'skus', {len(skus)}, 'cases', {len(cases)}, 'pcs', {total}, 'backup_schema', 'kpv_backup_20261127'));")
    w("")
    w("commit;")
    w("")
    w("-- What was loaded, per case:")
    w("select d.display_name, count(*) as skus, sum(l.opening_qty) as pcs, round(sum(l.opening_qty * m.baht_weight), 2) as baht")
    w("  from daily_stock_ledger l join desks d using (desk_id) join master_sku m using (sku_id)")
    w(" group by d.display_name, d.sort_order order by d.sort_order;")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(types)} types, {len(sizes)} sizes, {len(skus)} SKUs, {len(cases)} cases, {total} pcs")
    for desk_id, title, holding in cases:
        print(f"  {desk_id} {title}: {len(holding)} SKUs, {sum(holding.values())} pcs")
    print("changes:")
    seen = set()
    for where, a, b in changes:
        if (a, b) in seen:
            continue
        seen.add((a, b))
        print(f"  {a} -> {b}   ({where})")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "ລາຍລະອຽດເຄື່ອງຕູ້_1-7 morning market actual.xlsx"))
