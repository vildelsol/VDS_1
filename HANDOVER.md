# Villaggio Del Sol — Handover

The running note between sessions. Read this before touching anything, and update it before you
stop — the state section and the audit list are the parts that go stale first.

---

## What this is

Property-management system for a 16-unit gated residence in Ocho Rios, Jamaica.
Vite + React 19 + TypeScript front end, Express server, a single `db.json` file store.
Runs on the **HP EliteDesk** (the server, holds the records); the **Kamrui** and phones are
browser clients reaching it over Tailscale on plain-HTTP LAN.

**Project path (Mac):**
`/Users/rogeanedwards/Desktop/River Oaks/Villaggio Del Sol/Website/New_vildelsol/pm-app`

⚠️ Sessions have been launched from the *EGES-Platform* folder, so Claude's memory/sidebar shows
EGES context — **a different, unrelated project**. All work is in `pm-app` above. Ideally open the
next session from inside `pm-app`.

**Repo:** `https://github.com/vildelsol/VDS_1.git` (private) · branch `main`
`gh` CLI is installed and authenticated as `vildelsol` with `repo` + `workflow` scope.

---

## State right now

- **338 automated tests pass.** Typecheck clean, build clean.
- Working tree is clean.
- Latest release: **v1.6.0** (security deposits and owner statements). The double-record guard and
  recurring expenses both landed *after* it and are not in a tagged release yet.

### Owner statements — finished

The dangling `src/lib/finance.ts` this file used to warn about is committed and in use. Owner
statements (Tier 2 of the audit) are complete: helpers, screen, printable per-owner document,
Excel export, 26 tests, verified in the browser against seeded data.

**The design decision, unchanged:** the corporation's income is HOA maintenance; **rent and
short-let booking income belong to the individual proprietor** — the agent only collects it for
them — and their villa's costs are theirs. A statement puts those three on one page:
collected on your behalf − maintenance billed − expenses on your villa = net. Computed **per
currency, never across**. That matches how the Projections tab frames the strata corporation, so
the two cannot contradict each other.

Two things worth knowing about the implementation:

- Maintenance is deducted **as billed**, not as paid. So an owner who settles their own
  maintenance by bank transfer *and* has it withheld from their rent has been charged twice. The
  statement therefore also carries `maintenancePaid` and says out loud, on screen and on the
  printed page, how much was received in the period. Nothing else would have shown it.
- Statements are per villa per currency, but they are grouped by **owner** for issuing —
  `groupStatementsByOwner()` — because an owner of two villas is owed one document, not two
  envelopes that each tell half the story.

---

## How to run and test

```bash
cd "/Users/rogeanedwards/Desktop/River Oaks/Villaggio Del Sol/Website/New_vildelsol/pm-app"
```

- `npm test` — build + full suite (338 checks). Each test file boots its own server on a **temp
  data dir**, so tests never touch the real `db.json`.
- `npm run test:run` — tests only, skip the build.
- `npm run build` — client + `dist/server.cjs`.
- `npm run build:exe-prep` — everything needed for the single-file `.exe` (the `.exe` itself can
  only be assembled on Windows; CI does it).

**To preview with realistic data**, there is a seed script in the session scratchpad that boots the
production server on an isolated temp dir and populates units, charges, payments, bookings,
utilities and expenses. It's disposable — rewrite it if it's gone. Never point a preview at the
real `db.json`.

**Verifying in the browser:** the app is a PWA with a service worker. After a rebuild the browser
will serve the **stale cached bundle** — unregister the service worker and clear caches, or you
will spend twenty minutes debugging a fix that already works.

---

## Releasing

Push a tag; GitHub Actions builds the `.exe` on a real Windows runner and publishes it.

```bash
git tag -a v1.6.0 -m "…" && git push origin v1.6.0
```

The workflow (`.github/workflows/build-exe.yml`) gates the release on: full test suite → assemble
`.exe` → **start it and serve a real request** → **verify it created its Desktop shortcut**. Nothing
publishes unless all of that passes on Windows. It has caught two genuine bugs already; if it fails,
believe it.

Watch it with `gh run watch <id> --exit-status`.

---

## Things learned the hard way

- **The single source of truth is `src/lib/finance.ts`.** Every screen derives balances through it.
  Never compute a balance in a component — that is what made screens disagree before.
- **Every figure comes from `status === 'completed'` payments only.** That is what lets pending
  payments exist without corrupting anything.
- **USD and JMD are never combined**, anywhere. Per currency, always.
- **Charges carry a `kind`.** `undefined` = ordinary monthly; `'advance-final-month'` = the
  first-and-last advance; `'one-off'` = late fee / recharge / levy. **Post-month's "is this month
  already billed?" check must only count `kind === undefined`** — otherwise a one-off silently
  suppresses that month's rent. This was a real, near-invisible bug.
- **Editing `server.ts` via python heredocs**: quoting bites. Write the block to a file in the
  scratchpad and insert it, rather than embedding triple-quoted TS inside triple-quoted Python.
- **`bad()` is not typed `never`**, so it does not narrow types. Throw `new ApiError(...)` directly
  when you need narrowing afterwards.
- **Verify by driving the real UI**, not by calling `fetch` in the console — raw `fetch` bypasses
  `src/lib/api.ts` entirely and therefore bypasses the offline queue. I made that mistake once.

---

## Built so far (all on `main`, all tested)

**Money handling**
- **Proprietor statements** — per villa, per currency, grouped by owner; itemised printable
  document, Excel export. See *Owner statements* above for the rules it applies.
- Two-step payments: **"Receive payment"** (money in hand → receipt issued, alert clears) vs
  **"Record payment"** (expected → *awaiting funds*, counts for nothing until confirmed).
- **First and last month's rent** on move-in; the final month is not charged again, so a tenancy of
  N months is charged exactly N months.
- **One-off charges** — late fee, repair recharge, fine, amenity fee, legal costs, special
  assessment — billed onto the tenant's rent or the owner's maintenance account.
- **Security deposits** — held on the tenancy, refundable, reconciled at move-out. Raises no
  charge, records no payment, moves no balance. Withholding requires a reason and is veto-gated.
- Utility settling and booking deposits are *expected* until confirmed.

**Operations**
- **Lease end dates** + renewal warnings (60 days, and already-lapsed) on dashboard and hub.
- **Maintenance work orders** — assign, progress, close with cost and outcome; the cost can be
  raised as a property expense **once**.
- **Unbilled-occupancy alerts** — months a tenant has occupied that nobody billed.
- **Charts & Snapshots** tab; **Financial Projections** with custom range + Excel export.

**Resilience / deployment**
- **Offline action queue** — work entered while the HP is down is written to `localStorage` before
  being attempted, survives a reboot or closed tab, and replays in order with the original
  idempotency keys. Never described as "saved" until the server has it.
- **External-drive backup**, settable in the app (no environment variable, no restart).
- **Admin password recovery** — drop `RESET-ADMIN-PASSWORD.txt` next to `db.json`, restart.
  File-based only; nothing over the network can trigger it.
- **Single-file `.exe`** via Node SEA, built and smoke-tested on Windows by CI.

### Recurring expenses — finished

Payroll, electricity, water and the security contract were re-typed by hand every month — about
twenty entries, slow and quietly lossy, because a bill nobody remembered was simply never recorded.
Under **Utilities & Expenses → Monthly costs** there is now a list of templates and a run that posts
a month from them.

**The design decision, and why it is not one click:** the run does *not* post templates blindly. It
lays them out as a table with the usual figure filled in, and the person posting corrects each line
before anything is written. Electricity is never the same twice; a blind "post the month" would
either be wrong or would need correcting afterwards on twenty records. Lines can be unticked for a
month (a skip is "not this month", not "already done" — the line stays available), and anything that
only came up this month is added at the bottom of the same table and posted with the rest **without
becoming a template**.

**The invariant that matters:** everything posts as `pending`, never `paid`. A posted line is a bill
raised, not money gone. `finance.ts` counts only `status === 'paid'` expenses — see
`expensesInPeriod` and `ownerStatement` — so marking a run's lines paid would assert payments nobody
made and would flow straight into a proprietor's statement as a deduction from their rent. A line
becomes `paid` through the ordinary expense form, when it is actually settled. Do not change this.

Re-posting a month tops up only what is missing, exactly like posting charges: templates dedupe on
`recurringId + periodMonth`, and an added one-off dedupes on what it actually is (month, vendor,
category, allocation, currency, amount), so a double-submitted run cannot double the property's
costs. Each posted line is dated to the month it belongs to rather than the day it was typed, so a
run posted late still falls in the right period on every report.

**Deliberately monthly-only.** The annual insurance premium is split across the villas — different
arithmetic, different operation — and stays a hand-entered expense. Template due days are capped at
1–28 so every month has the day.

28 tests in `test/recurring-expenses.test.mjs`; verified in the browser against seeded data.

---

## The audit — what's left

I audited the app as a property manager. Remaining gaps, in the order I'd do them:

**Tier 2 — done**
1. ~~**Owner statements**~~ — done, see above.
2. ~~**Recurring expenses**~~ — done, see below.

**Tier 3 — risk and defensibility**
3. **Document storage** — leases, IDs, insurance certificates, inspection photos, contractor
   invoices. Everything is referenced by number only.
4. **Communication log** — "called re arrears on the 3rd", "notice served on the 10th". In a
   dispute that log *is* the case.
5. **Formal notices** — eviction is modelled as a financial write-off; there is no demand letter or
   notice-to-quit document. Jamaica's process expects served, dated notices.
6. **Inspection records** — move-in/move-out condition, which is what a deposit deduction is
   defended with.

**Tier 4 — short lets are financially overstated**
7. Bookings have **no cleaning fee, no channel commission, no guest damage deposit**. Airbnb and
   Booking.com take ~3–15%, so short-let villas look more profitable than they are — and the
   Projections tab inherits that optimism.

**Tier 5 — finance hygiene**
8. **Bank reconciliation** — nothing ties receipts to a bank statement.
9. **No refund instrument** — refunds are done by voiding, which is not the same as recording money
   going out.
10. **No rent proration** — a mid-month move-in bills a whole month, and now also a whole advance.

**Also open, flagged but not built:** two people (or two tabs) actioning the same arrears
simultaneously can still double-record — both work from data fetched before either saved. Closing
that needs a server-side check that the charge is still outstanding at the moment of payment.

---

## The user

Non-technical on git and deployment. Wants dead-simple, one-double-click outcomes. Dislikes long
answers and repeated friction. **Prefers being shown proof — screenshots, reconciled numbers —
over assurances.** Gets reasonably frustrated when steps multiply; keep it concrete.

Decisions already made — **do not re-litigate**:

- `recordPayments` is a permission, **ON by default for all roles** (juniors cover the desk alone).
- **No Docker, no PostgreSQL, no Windows Service.** The user's own conclusion: "For River Oaks
  today, what you built is fine" — revisit only if this becomes multi-property or SaaS.
- `/api/db` returns everything to every signed-in user; only **writes** are gated. Deliberate.
- Charges are posted **manually** ("Post month") — they are dated, audited records.
- Move-in/eviction dates are **never invented**; unknown stays blank.
- Eviction is veto-gated and writes off rent as bad debt.
- **First-and-last is not a deposit.** It pays the final month. A damage deposit is separate and
  refundable.
