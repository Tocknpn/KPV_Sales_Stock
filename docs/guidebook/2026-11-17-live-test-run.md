# Guidebook test run — 2026-11-17

## Pre-flight

- Planned for the live site; on the owner's instruction (2026-11-17) the run moved to the **local demo**
  (`npx wrangler dev scripts/guidebook/devclock.ts --port 8790`, in-memory demo data, no database).
  `devclock.ts` moves the business date forward without a restart (`/api/__clock?days=1`) and
  refuses to run if Supabase credentials are set. Production was not touched.
- Branch: ວັງທອງ (B-VT). Scenario driver: `KPV_URL=http://localhost:8790 node scripts/guidebook/run.mjs <step>`,
  steps in order: `users`, `sku`, `cases`, `close1`, `clock 1`, `day2`, `reopen`, `reports`.
- Day 1 = 2026-11-17, Day 2 = 2026-11-18 (simulated).

## Scenario results

| # | Scenario | Who | Expected | Observed | Result | Shots |
|---|---|---|---|---|---|---|
| 1 | User set-up | admin | New staff `TEST ພະນັກງານຄູ່ມື` (@test.guide, ວັງທອງ) appears in the list; staff count 5 → 6 | As expected; password shown only to admin | PASS | 04–06 |
| 2 | SKU set-up | admin | New SKU `TEST ສິນຄ້າຄູ່ມື`, ທອງຄຳແທ່ງ, 1 ສະຫຼຶງ, avg/day 1, lead 3, ວັງທອງ only | Saved; branch SKU count 12 → 13; import/export sheet opens | PASS | 07–10 |
| 3 | Case creating | staff | `TEST ຕູ້ A` (TEST SKU 10, ຄຳແທ່ງ 1 ບາດ 5, ຄຳແທ່ງ 2 ບາດ 5) and `TEST ຕູ້ B` (TEST SKU 4); both open today | Both created as VT-D05/VT-D06, status ເຂົ້າວຽກ (already checked in on the day they are made) | PASS | 11–12 |
| 4 | Day 1 close | staff | Count = closing on every row, ✓ ປິດມື້ → done | Both done | PASS | 13 |
| 5 | Login | staff | Username + password form, lands on ສະຕັອກ | As expected | PASS | 01–03 |
| 6 | Check-in (Day 2) | staff | Cards ຍັງບໍ່ເລີ່ມ with ເຂົ້າວຽກ; after check-in opening = Day 1 closing (TEST SKU 10) | Opening 10 | PASS | 14–15 |
| 7 | Stock tracking | staff | A: in 3, retail 2, wholesale 1 | Saved (ບັນທຶກແລ້ວ) | PASS | 16 |
| 8 | Stock move | staff | A −2 (ອອກ, red), B +2 (ເຂົ້າ, green) | A move −2, B move +2; B closing 6 | PASS | 17–18 |
| 9 | Stock adjust — destock | staff | Destock 1 needs a reason | Reason sheet "(ບັງຄັບ)"; reason saved | PASS | 19 |
| 10 | Stock adjust — count variance | staff | Expected 7, counted 6 → ຕ່າງ −1 needs a note | ຕ່າງ −1 with note; A closing 7, counted 6 | PASS | 20 |
| 11 | Day 2 close | staff | Both done and read-only | Both done; "ປິດແລ້ວ … ໂດຍ …" banner | PASS | 21 |
| 12 | Reopen | admin | Reopen needs a reason; day back to open; close again | status done → check_in → done; closing still 7 | PASS | 22 |
| 13 | Dashboard | staff | Branch totals, movement today, attention list, stock age, status bar | Shown for ວັງທອງ | PASS | 23–24 |
| 14 | Movement report | staff | Case A, Nov: opening 20 pcs, in +3, out −6 (retail 2 + wholesale 1 + destock 1 + move 2), count adjustment −1, closing 16 | Exactly these; day grid: A 17 ✓, 18 −0.25 (baht short); B ✓ ✓ | PASS | 25–26 |
| 15 | Case history | staff | One line per day, flags for count mismatch and reopen | 18 Nov flagged ນັບບໍ່ກົງ and ເປີດແກ້ໄຂຄືນ | PASS | 27 |
| 16 | Audit history | staff | Branch entries incl. reopen with reason | Present | PASS | 28 |
| 17 | Purchase proposal | staff | Low rows highlighted | ຄຳແທ່ງ 1 ບາດ highlighted (ສະຕັອກຕ່ຳກວ່າຈຸດສັ່ງຊື້ 4 ມື້) | PASS | 29 |

Final numbers (API): A TEST SKU opening 10, in 3, retail 2, wholesale 1, destock 1 ("TEST ເສຍຫາຍ"),
move −2, closing 7, counted 6 ("TEST ນັບຂາດ 1"), done. B opening 4, move +2, closing 6, counted 6, done.

## Bugs and surprises

1. **Reopen sheet wording is out of date.** It says to press "ຢືນຢັນວ່າແລ້ວ" again; the button is now "✓ ປິດມື້" (shot 22). Copy fix in `public/js/i18n.js`.
2. **Audit list shows raw values.** Entries read "ສະຖານະ check_in → done; … 2026-11-17T09:27:35.432Z" — status names and timestamps are not translated/formatted (shot 28).
3. **A case not yet checked in shows 0.0 Baht · 0 pcs** on its card, although it closed yesterday with 20 pcs (shot 14). Possibly by design (the card shows today's rows); confusing for staff.
4. Simulation only: audit entries are grouped under the real date (17 Nov) because the audit uses the real clock.
5. The movement report counts a move out as **ສິນຄ້າອອກ** (−6 pcs includes the 2 moved to case B). Worth knowing when reading a single case; branch totals net out.
6. **Profile card is half English** on the Lao screen: branch "Vangthong" and role "staff" (shot 30).

## Cleanup

Nothing to clean: the run used the in-memory demo, which resets when the dev server stops.
