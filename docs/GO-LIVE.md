# Go-live checklist

One Supabase project (free plan) is used: test it with demo data, wipe it,
then load real data.

## 1. Create and test the database

1. Create a Supabase project. In **SQL Editor** run `supabase/schema.sql`, then
   `supabase/seed.sql` (demo data — regenerate it first with `npm run db:sql`
   so its dates are current).
2. Copy `.dev.vars.example` to `.dev.vars`; fill in `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API) and a long random
   `AUTH_SECRET`.
3. `npm run dev`, log in with the demo accounts and walk through:
   - check in a desk, record movements, try ✓ Done with a missing count → refused, the cells turn red;
   - count, add notes, Done; next day opens with the counted figure;
   - leave a day unfinished → next day's check-in points you back to it;
   - Out / Move to another desk → shows *in transit* on Dashboard; confirm on the receiving desk;
   - admin reopens the latest Done day; the next day's opening follows the fix;
   - staff cannot see another branch, delete documents or approve proposals;
   - 5 wrong PINs locks the account; admin unlocks / resets the PIN.
4. Compare one branch: Baht and pcs on the desk cards = Dashboard = Report closing.

## 2. Wipe and load real data

1. In **SQL Editor**, drop and recreate: run
   `drop schema public cascade; create schema public; grant usage on schema public to postgres, anon, authenticated, service_role; grant all on schema public to postgres, service_role;`
   then `supabase/schema.sql`, then `supabase/base.sql`.
2. `npm run db:admin -- "Owner name" <PIN>` and run the printed SQL — this is the only account created by hand.
3. Log in as that admin:
   - **Settings → Gold price**: gold price per Baht and the USD rate.
   - **Settings → SKU**: check types and sizes, then **Import CSV** (template
     button in the import sheet). One bad row imports nothing and lists the lines to fix.
   - **Settings → Lead time**: avg sold per day and order lead time per SKU (drives the reorder point).
   - **Settings → Users**: add every staff member with branch and PIN.
4. Day one at each desk: create the case (**+** on Daily Stock) with its starting stock, or, for existing desks,
   check in and add each SKU with its opening count (allowed only on a desk's first day).

## 3. Deploy

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put AUTH_SECRET
npm run deploy
```

The Worker refuses to sign sessions if `AUTH_SECRET` is missing while
Supabase is configured.

## 4. Lao manual — what has changed

The manual's screenshots show demo data from before this phase. The text
needs these updates:

| Section | Change |
|---|---|
| ສິດທີ່ມີໃນລະບົບ | Admin also: approve/reject purchase proposals, reopen a Done day, manage users (add, PIN, branch, lock). Staff can no longer create new SKUs in the master list — they pick existing ones. |
| ການເຂົ້າສູ່ລະບົບ | 5 wrong PINs = locked 15 minutes; admin can unlock. |
| ວົງຈອນປະຈຳວັນ | A day must be ✓ Done before the next check-in. Opening = the counted figure of the last Done day. Done is refused (cells turn red) until every row is counted, differences have notes and destock has reasons. |
| ຖັນ ອອກ / ຍ້າຍ | Tapping opens a sheet to choose the destination desk (ອອກ = other branch, ຍ້າຍ = same branch). The receiving desk taps **ຮັບແລ້ວ**; its ເຂົ້າ cell shows `+n⇄`. |
| ກົດ ✓ ແລ້ວ ແຕ່ບັນທຶກຜິດ | Tell the admin: they can reopen the **latest** Done day with a reason; after correcting, close it again. |
| ຂັ້ນຕອນການສັ່ງຊື້ເພີ່ມ | A saved proposal shows **ລໍຖ້າອະນຸມັດ**; admin approves/rejects in the app. Low stock = below the reorder point (avg/day × (lead time + buffer)). |
| ພາບລວມ | Value uses the gold price set in Settings; new "in transit" card; branch cards show desks done today. |
| ຕັ້ງຄ່າ | New: gold price & USD rate, CSV import, user management. |
