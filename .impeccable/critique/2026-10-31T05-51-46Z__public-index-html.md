---
target: public/index.html (full app)
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
target_identity: "file:C:\\Users\\advice\\KPV Sale Stock Management\\public\\index.html"
target_fingerprint: "sha256:5d20c1cf382eaffe64e16e916cbafa62fcc1bce2e3e207a1a455b3398f76ad3d"
target_path: "C:\\Users\\advice\\KPV Sale Stock Management\\public\\index.html"
timestamp: 2026-10-31T05-51-46Z
slug: public-index-html
closed: true
---
Method: dual-agent (A: design-review sub-agent · B: detector/evidence sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Toasts have no `aria-live`; otherwise good branded loading copy throughout |
| 2 | Match System / Real World | 3 | Strong domain terminology overall; "Whsl/Xfer" is unexplained jargon |
| 3 | User Control and Freedom | 2 | No calm review step before irreversible "Submit Final Closing" |
| 4 | Consistency and Standards | 3 | Native `confirm()` breaks the custom sheet language at the highest-stakes moment |
| 5 | Error Prevention | 2 | Finalize only gates on low-stock; no general totals-review step |
| 6 | Recognition Rather Than Recall | 3 | Branch/date persist across views via shared state |
| 7 | Flexibility and Efficiency | 3 | Good desk shortcut; Report's "Adjust" button is a dead end |
| 8 | Aesthetic and Minimalist Design | 3 | Clean cards/hairlines, consistent iconography |
| 9 | Error Recovery | 2 | Boot failure shows raw `err.message` to non-technical users, no retry |
| 10 | Help and Documentation | 2 | Only help is the inline formula strip; no help affordance anywhere |
| **Total** | | **26/40** | **Acceptable** (65%) |

## Design Specificity Verdict

**LLM assessment**: Real domain grounding exists — Baht-gold units, bilingual Lao subtitles per screen, a CVD-validated category palette (documented inline in `charts.js`), a desk-specific "Quick Check-In My Desk" shortcut, and an inline closing-formula reminder. But the chrome around that domain layer — chip filters, card grids, bottom sheets, stat tiles — is templated enough that a generic retail-inventory app could reuse it unchanged. The gold-specific layer is additive, not structural.

**Deterministic scan**: `impeccable detect --json public/index.html public/js` (exit code 2, 2 findings; all `public/js/**` files scanned individually came back clean — the detector reads static markup/CSS, not the JS-templated DOM):
- `low-contrast` (warning/quality): `#9ca3af` on `#ffffff` measured at 2.5:1, against a 4.5:1 requirement.
- `overused-font` (warning/slop): Plus Jakarta Sans is flagged by the detector's blocklist of common AI-generated-UI faces. This is **expected and non-actionable** here — `app.md`, the project's governing brief, explicitly pins Plus Jakarta Sans as the required typeface, and a pinned brief overrides a generic saturated-pattern warning.

The detector's contrast finding independently corroborates Assessment A's P0 below (see next section) — two isolated methods converged on the same defect without seeing each other's output. I additionally re-derived the WCAG relative-luminance math myself from the literal hex values for all four flagged colors against `#ffffff`, and it matches both assessments closely: `#9ca3af` ≈2.54:1, `#10b981` (success) ≈2.54:1, `#ef4444` (danger) ≈3.76:1, `#f59e0b` (warning) ≈2.15:1 — all below the confirmed 4.5:1 AA floor for normal text.

**Visual overlays**: Not available. Neither sub-agent had a browser-automation tool in this session (confirmed independently by both), so no `[Human]` tab overlay exists — do not expect one. Assessment A grounded its review in full source reading instead; Assessment B's CLI scan stands on its own as deterministic evidence.

## Overall Impression

The information architecture, bilingual intent, and domain-specific shortcuts are genuinely well-considered — this doesn't read as a template someone forgot to customize. But the craft breaks down exactly where the brief said it couldn't: the confirmed WCAG 2.1 AA requirement is violated systemically (not in one corner, but on the majority of secondary/status text across all 5 screens), and the confirmed 44px tap-target floor is explicitly overridden for the filter controls the primary persona — a rushed desk cashier — touches most. The single biggest opportunity is a targeted color/sizing pass: the structure doesn't need to change, the tokens do.

## What's Working

- **"Check-In My Desk (Desk 01)" quick action** (`stock.js`) surfaces the single highest-frequency action for the confirmed primary persona (desk cashier) with zero navigation — direct, deliberate frequency-of-use design.
- **Bilingual Lao subtitles under every screen header**, plus a CVD-validated, source-commented category palette in `charts.js` (amber/teal/violet/rose, chosen and validated for colorblind-safe adjacent contrast) — real evidence of craft intent, even though contrast execution undermines the Lao text specifically (see P0 below).
- **Live-recomputed totals and the inline closing-formula strip** (`Closing = Opening + Stock In − Retail Sale − Wholesale − Transfer/Out`) give the user a constant real-time anchor while entering numbers that represent real gold value.

## Priority Issues

**[P0] Systemic WCAG AA contrast failure on load-bearing text**
- **Why it matters**: WCAG 2.1 AA is a confirmed, non-negotiable requirement for this project, and the confirmed primary persona is senior/non-technical desk staff under time pressure. `text-gray-400` (`#9ca3af`, 2.54:1) is used 65 times across the codebase — including **every single Lao subtitle on all 5 screens**, which the project's own bilingual-by-default principle treats as load-bearing content, not decoration. `text-success` (`#10b981`, 2.54:1, 13 uses), `text-danger` (`#ef4444`, 3.76:1, 7 uses), and `text-warning` (`#f59e0b`, 2.15:1, 8 uses) color the Stock In / Sale / Stock Out figures and low-stock alert chips — the exact numbers representing real physical gold value.
- **Fix**: Darken all four tokens to AA-safe steps and re-run the detector to confirm: gray-400 labels → gray-600 or darker; success → `#047857`; danger → `#dc2626`/`#b91c1c`; warning → `#92400e`. Re-check the brand amber `#b45309` too while in there (it reads close to this list's territory on white).
- **Suggested command**: `$impeccable audit` (to get full WCAG-scoped findings beyond this sample) then `$impeccable polish`.

**[P0] `.chip` cancels the confirmed 44px tap-target floor**
- **Why it matters**: `src/styles/input.css` defines `.tap-target { min-height: 44px; min-width: 44px; }`, then both `.chip` and `.status-pill` immediately override it with `min-height: auto`. `.chip` is not decorative — it's the Branch/Date selectors on Daily Stock, the status filters on Orders, and the Period/Branch/Desk filters on Report: exactly the controls the confirmed primary persona (a cashier moving fast at a counter) taps repeatedly every shift. `.status-pill` is lower-risk since most pills are non-interactive status labels, but confirm none of them double as tap targets before leaving that override in place.
- **Fix**: Remove `min-height: auto` from `.chip` (and verify `.status-pill` has no interactive instances before deciding whether to touch it too).
- **Suggested command**: `$impeccable polish`.

**[P1] Bottom sheet lacks accessible modal semantics**
- **Why it matters**: `ui.js`'s `openSheet` has zero `role=`/`aria-` attributes anywhere in the file — confirmed by direct source read. No `role="dialog"`, no `aria-modal`, no focus trap, no focus return on close. The `#toast` host has no `aria-live` either. A screen-reader user (the confirmed Sam persona, directly implied by the confirmed WCAG AA requirement) can tab behind an open desk-audit sheet and will never hear "Final closing submitted" — the confirmation for an action that locks in real gold-value numbers.
- **Fix**: Add `role="dialog"` + `aria-modal="true"` + a focus trap + focus-return-on-close to `openSheet`; add `aria-live="polite"` to the toast host.
- **Suggested command**: `$impeccable audit`, `$impeccable harden`.

**[P1] No review step before the irreversible "Submit Final Closing"**
- **Why it matters**: `stock.js` only intercepts with a native browser `confirm()` dialog, and only for the low-stock edge case — there's no general "review your totals before this locks in" moment for an action that commits a desk's real gold-value closing. The native `confirm()` also breaks the app's own custom-sheet visual language at its single highest-stakes moment, which both assessments independently flagged as the weakest point in the emotional journey.
- **Fix**: Replace the native `confirm()` with a branded review screen (or an inline summary step within the sheet) for every finalize, not just the low-stock case.
- **Suggested command**: `$impeccable harden`, `$impeccable onboard` (for the confirmation/success moment specifically).

**[P2] Bottom nav labels are English-only**
- **Why it matters**: `#bottom-nav` in `index.html` has zero Lao text on any of its 5 buttons (confirmed by direct source read — only an icon + English `<span>` per item). This directly contradicts the confirmed "every staff-facing screen carries both Lao and English labels" principle, on the one navigation element visible on literally every screen. The original `app.md` brief itself names each nav item bilingually (e.g. "Daily Stock (ການກວດນັບປະຈຳວັນ)").
- **Fix**: Add a small Lao sub-label under each English nav label (matching the pattern already used in each screen's own header).
- **Suggested command**: `$impeccable clarify`.

## Persona Red Flags

**Sam (Accessibility-Dependent)**: Number inputs in the desk-entry rows (`rowTemplate` in `stock.js`) have no `<label for>` association — a screen reader announces only "number input, 0," never which field it is. The donut chart segments (`charts.js`) are `tabindex="0"` but have no `keydown` handler and no per-segment `aria-label`, so Tab reaches them but Enter/Space does nothing and nothing is announced. Combined with the missing sheet/toast semantics above, Sam cannot reliably complete or confirm a desk closing.

**Casey (Distracted Mobile User)**: "Save Progress" / "Submit Final Closing" sit at the bottom of a potentially long, non-sticky SKU list inside the desk sheet — a one-handed thumb must scroll past every row to reach them. There's no autosave or draft indicator, so an interruption mid-count (a phone call, a customer) before tapping "Save Progress" silently loses whatever was entered.

**Jordan (Confused First-Timer)**: The Morning/Evening mode toggle grays out the Sale/Wholesale fields (opacity 0.45) with zero explanatory microcopy — a first-time user has no way to know those fields are intentionally disabled rather than broken. "Whsl/Xfer" is an unexplained abbreviation for a non-technical senior user.

## Minor Observations

- Orders' status-chip row has 5 options (All/Pending/Approved/Draft/Dispatched) — one over the ≤4 cognitive-load guideline.
- Report's "Adjust" button is a functional dead end: it only toasts "Adjustments are made from the Daily Stock desk detail screen" rather than navigating there.
- The "Demo mode" toast auto-dismisses in ~2.2s — likely too fast to read the full sentence, and it never resurfaces elsewhere (e.g. Settings' sync indicator is the only other place this is discoverable).
- Cognitive load: 2-3 checklist failures = moderate. Specifically: the 5-option Orders chip row, the Report "Adjust" cross-screen memory demand, and the irony that Lao text — meant to be load-bearing, confirmed bilingual-by-default — is styled in the single lowest-contrast gray used anywhere in the app.
- Emotional journey: good micro-reassurance via live running totals and the "✓ Finalized & audit verified" chip, but the actual submit moment for real gold value relies on a jarring native `confirm()` rather than a calm, branded review screen — the moment needing the most reassurance gets the least design care.

## Questions to Consider

- If `.chip` was deliberately shrunk below 44px for visual density, was that a conscious trade-off against the confirmed 44px requirement, or did the override simply go unnoticed?
- Should "Submit Final Closing" ever be a single tap, given it locks in a number representing real physical gold value?
- Is the Lao text truly first-class bilingual content, or is it being treated as decorative subtext — given it's rendered in the app's lowest-contrast color almost everywhere it appears?
