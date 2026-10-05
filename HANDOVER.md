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

- ✅ **v1.13.1 is the current release** (published 2026-09-28 20:54 UTC, tag `v1.13.1` on `0fb6007`,
  `Villaggio-Del-Sol.exe` **96,248,320 bytes**, run `36479349955` green in 27m05s — every gate
  including the advisory check, the 1,982-test suite, the smoke test that starts the .exe and serves a
  real request, and the Desktop shortcut check). **v1.12.0 was 95,472,128 bytes**, so unlike the
  v1.11.1/v1.12.0 pair these two *can* be told apart by size — but still confirm the version from the
  console line or `/api/health`, never the sidebar. It carries the Strata / ISPO / Everything
  book filter across Operational Reports, reservation deposits reaching the receipts ledger as
  received, the duplicate-deposit reconcile panel, real arrivals and departures on the dashboard, the
  currency pill on a one-off charge, one disclaimer on the printed statement instead of three, and no
  em dashes in any user-facing text. It also carries four pieces that had sat uncommitted since
  September: printed signature spacing, the Airbnb calendar fixes, staying signed in while the
  program is open, and the screens remembering where you left them. **The HP is still on v1.9.0 and
  needs it.**
- ⚠️ **v1.13.0 built green and published nothing.** Every real gate passed — advisory check,
  typecheck, all 1,982 tests, assembly, the executable starting and serving a request, the shortcut —
  and the job then died on **"Artifact storage quota has been hit"**, which was the step *before*
  "Publish to the GitHub Release". So the release was skipped and no `.exe` exists for v1.13.0. The
  workflow now publishes the release **first** and marks the artifact upload `continue-on-error`, so a
  billing condition can never again throw away a build that passed everything. **Use v1.13.1.** No
  application code differs between the two tags. The `v1.13.0` **tag still exists with no release
  behind it** — harmless, but if it is ever confusing, delete it on the remote rather than re-pointing
  it. The account's Actions storage quota is still full; this repo holds only one 34MB artifact and the
  same binary is attached permanently to the v1.12.0 release, so something in another repo is holding
  it.
- **2,019 automated tests pass** (1,982 at v1.13.1, plus `supplier-credits` and the credits now running inside `reports-2000`). Earlier: 1,982 (1,871 before that session, plus `report-books`,
  `short-stay-deposits` and a new **2,000-operation `reports-2000`** run over the book filters, the
  deposits and the charges). Six mutations run against the new guards, six killed. Typecheck and
  build clean, and the screens were driven signed in.
- **Earlier: 1,806 automated tests passed at v1.12.0** (1,655 before this session, plus `taking-a-cost-back`, `two-books` and a new **5,000-operation `books-5000`** run over the two books, the voids and the recalls). Typecheck and build clean. A full run now simulates **6,800 audited
  scenarios**: 200 ledger, 200 whole-application on full data, 400 reporting, a **3,000-scenario
  adversarial red team**, a **5,000-operation run that then reads the paperwork it produced**, and
  three **1,000-simulation expert suites** (property manager, architect, security). The application
  also checks its own records at start-up. A full `npm test` takes about **six and a half minutes** —
  the 3,000 red team is about 2m30s and the 5,000 run about 3m. That is the price of the coverage; do not trim
  it to make the suite faster.
- **Nothing is uncommitted.** Everything through the 2026-09-28 session is committed and pushed:
  `990d087` (the work), `25235f3` (the v1.13.0 bump) and `0fb6007` (the workflow fix and the v1.13.1
  bump). Released as **v1.13.1**. v1.12.0 carried the cost recall, the two books, the ISPO
  Operations statement and the tidy; v1.11.1 the five faults real data found and the occupancy split;
  v1.11.0 the shortfall report.
- ⚠️ **Open with Ro, and it is data rather than code:** the `ISPO BNS-Transfer from Ispo to Villaggio`
  rows on the HP (J$122,000 on 24 Sep, J$100,000 on 17 Sep) are recorded as ISPO **costs**. Ro says
  they are transfer notes saying where the money came from, which would mean J$222,000 of costs
  nobody incurred. **No release changes them.** They have to be taken back on the HP, with the
  funding note moved into the reference of the cost each one paid for.
- **`main` and `origin/main` are level.** Check that with `git ls-remote origin main` against your
  own `git rev-parse main` — not against a hash copied into this file, and not against a local
  `origin/main` ref, which only says what the last fetch saw. **`main` may sit a documentation commit
  or two ahead of the tag `v1.11.1`, and that is expected**: the released binary is built from the
  tag, so docs written after a release do not move it. Nothing is unpushed. A hash was written here
  by hand and was wrong three times running: once claiming `main` was a commit ahead when it was not, once claiming
  work was uncommitted after it had been pushed, and once naming a commit two sessions old.
- One untracked file sits in the tree: **`docs/USER-GUIDE.html`** ("Villaggio Del Sol Handbook"),
  dated 25 August and not written by any session recorded here. It has deliberately **not** been
  committed — ask Ro whether it should be, rather than assuming either way.
- **The version number is on screen** (sidebar footer and sign-in, beside "Powered by ISPO"),
  injected from `package.json` at build time — **and from v1.10.1 the server's own version is shown
  beside it whenever the two differ.** Read the next bullet before trusting either number.
- ⚠️ **The plan number fix does NOT travel in a release, and this is the trap.** The 2026-08-16
  session changed `defaultSettings()` in `server/db.ts`, and `db.json` is **gitignored** — it has
  never been tracked and cannot be. The Mac's own `db.json` was edited by hand (backed up to
  `db-backups/db.json.pre-2324-*`); that edit exists on this machine only. On load, `loadDb()` merges
  as `{ ...defaultSettings(), ...parsed.settings }` (`server/db.ts:726`), so **a stored value always
  beats the new default** — an existing `db.json` holding `2724` keeps `2724` through any upgrade.
  The default only applies to a database that has never had the field. **Installing a new `.exe` on
  the HP will not correct its plan number.**
- ⚠️ **And there is no field to correct it with. `strataPlanNumber` has never had a UI** — checked in
  the code on 2026-09-01 after Ro went looking for it and could not find it. The setting is real
  everywhere else: it is in `AppSettings` (`src/types.ts:174`), it defaults to `2324`
  (`server/db.ts:424`), `POST /api/settings` accepts it (`server.ts:1044`), and it prints on the
  letterhead of every statement, the operating statement, the annual report and the projections.
  Only the input box is missing — `GeneralPanel` (`src/components/SystemSettings.tsx:1209`) has the
  exchange rate, the books-begin date, the health grade and the vendor list, and nothing else. `trn`
  has no field either. **Three earlier versions of this file said "set it in System Settings →
  General". That was never possible.** Do not repeat it.
- **What saves this in practice: a brand-new database takes the default, which is already `2324`** —
  confirmed by creating one and reading `db.json` back on 2026-09-01. So the rebuilt books come up
  correct with nobody touching anything. **Changing it still needs a release.** Ro was offered the
  field on 2026-09-01 and declined it — *"if its already built in, let it be"* — having been told
  plainly that the value is built in and the field is not. Build it if the number ever turns out to
  be wrong, or if the TRN is needed on a statutory return; do not build it unasked.
- **Nobody has ever checked the plan number on a printed letterhead.** That is still the only
  confirmation that exists, and it is still outstanding.
- ⚠️ **The version in the sidebar is the version of the *page*, not of the program — and until
  v1.10.1 nothing on the machine could tell you the difference.** The number is compiled into the
  browser bundle, and the bundle is delivered by a service worker that may serve a cached copy for as
  long as it likes. On the v1.10.0 upgrade this produced the worst possible outcome: the release was
  built from the right commit, the HP had it, and every visible check still read v1.9.0. **The
  previous version of this file told you to "confirm the sidebar reads v1.10.0" — that instruction
  could lie, and did.** From v1.10.1 the server states its own version in two places a cache cannot
  reach: `GET /api/health` returns it, and the console window prints it (with the records folder)
  on start-up. The screen shows both numbers and raises a banner when they disagree.
- Latest release: **v1.11.1**, tagged 2026-09-03, built and published — the Windows workflow passed
  every gate (**1,655 tests, 0 failed** → assemble the `.exe` → start it and serve a real request →
  verify the Desktop shortcut) and `Villaggio-Del-Sol.exe` (**95,428,608 bytes**) is on the release.
  **Superseded by v1.12.0.** It was the release immediately before it, carrying the five faults real
  data found on 2026-09-02, the split occupancy figures and the proprietors' monthly report, on top
  of v1.11.0's shortfall report.
- Superseded: **v1.10.4**, tagged 2026-09-02 (`Villaggio-Del-Sol.exe` **95,379,968 bytes**).
  ⚠️ It carries **no behaviour change** over v1.10.3, and is byte-identical in size — the difference
  is that this is the first binary built *after* the 5,000-operation paperwork suite existed, so the
  published `.exe` is gated by it. **Tell them apart by the version on the console line and in the
  sidebar, never by the file size.** Install this one; v1.10.3 is superseded.
- Previous release: **v1.10.3**, tagged 2026-09-02 — the printed records carry every record (below).
- Previous release: **v1.10.2**, tagged 2026-09-01 — posted is no longer the same as due (below).
- Previous release: **v1.10.1**, tagged 2026-09-01 — the version-visibility fix above. Supersedes
  v1.10.0 in every respect.
- Previous release: **v1.10.0**, tagged 2026-09-01 on `7b2d21f` — the owner-statement and currency
  fixes, the adversarial and expert simulation suites, Excel workbooks in place of every CSV, and the
  two new statements (owners' monthly operations, and the strata corporation's operating statement).
  The Windows workflow passed every gate (full suite → assemble the `.exe` → **start it and serve a
  real request** → verify the Desktop shortcut) and `Villaggio-Del-Sol.exe` (91MB) is published on the
  release.
- Older release: **v1.9.0**, shipped 2026-08-21, tag on `b29b55d`. Four releases went out that day
  — v1.8.3 (version number on screen, docs), v1.8.4 (the migration billing bug), v1.8.5 (tenant name
  intent), v1.9.0 (ownership history + tenant-removal intent). **The HP was running v1.9.0 as of
  2026-09-01 and needs v1.12.0.** Every earlier release is superseded; install the latest only.

## Session of 2026-10-05 — supplier credits, itemised costs, and where the money came from

🟡 **Uncommitted on `main`.** Tests → **2,019, 0 failed.** Typecheck and build clean. Driven on a real
signed-in screen, including inflating the exported workbook to read the sheet rather than trusting it.

Four things Ro asked for, and the bug hunt that followed.

### A supplier credit is a cost of less than nothing

Ro: *"negative amounts cannot be inserted into the expenses. One of our utility providers gave us a
credit... specifically when it comes to posting, so for the monthly costs section under utilities and
expenses, allow a negative number to be posted and reflected on all applicable reports."*

The refusal was `requirePositiveAmount`, in three places: the expense register, the monthly-cost
template, and **the month-posting run**, which is the one Ro actually met. New `requireSignedAmount`
on those three and nowhere else. Rent, charges, receipts, deposits and refunds stay strictly positive:
those are amounts moving in a stated direction, and a negative one is a slip, not a credit. Zero is
still refused on both, because a cost of nothing reconciles to nothing.

**The dangerous half was never the server.** Allowing the figure took three lines; the faults were in
every screen that read `> 0` and so treated a credit as nothing having happened:

- the expense register's own totals strip vanished entirely when the filtered rows netted negative,
  so the rows were on screen and the figures summarising them were not;
- the management charts and the **board pack** dropped a credited category from the picture while
  every total beside it still counted it;
- the month-by-month category chart did the same through `present`;
- an outstanding credit printed as `-`, meaning nothing, on three tables;
- a run's added line read "Needs a payee and an amount" with both filled in;
- the notifications hub showed no figure against a credit awaiting settlement.

The chart rule was pulled out into `categoriesWithSpend` in `finance.ts`, because it had to be wrong
in two components at once before anybody would have noticed, and a rule inside a `useMemo` is a rule
no test can reach.

### Itemised costs in the workbook

Ro: *"the expenses on the excel sheet needs to itemize all the expenses, line by line as opposed to
grouping them by Payroll, Utilities etc."* The sheet was one row per category, which is a figure
nobody can check: "Payroll 82,000" cannot be questioned, approved or reconciled against a bank
statement. It is now a row per cost with the date, currency, payee, what it was for, category,
allocation, which book pays, the reference and the amount, with taken-back costs left off and the
category totals kept at the foot **after** the detail rather than instead of it.

### Why Received can exceed Billed

Ro: *"the USD billed was 1700, however the amount received is 5400. The received amount is correct as
the system counted short term rentals as well, however, there is no mention that this was from short
term rental."* Billed counts rent and maintenance charges; Received counts every receipt, and a guest
pays against no charge at all. The printed monthly movement gained an **of which short-stay** column
and a line saying what the two columns mean, the Excel sheet gained the same column, and the
observations name the figure and what it is made of.

### What the suite could not have told us

**Every one of the 1,982 tests passed before any of the credit work was written, and would have passed
if all of it were wrong**, because nothing had ever posted a negative cost. New
`test/supplier-credits.test.mjs` (31) posts one through the register, the template and the run, and
follows it into the monthly report, the annual report, the operating statement on all three books, the
breakdown and the recall. `reports-2000` now posts credits too: 97 of them inside 2,000 operations,
through every invariant.

**Four mutations run, four killed:** the posting path back to positive-only (4 deaths), zero allowed
(2), the sign flipped (13), credits hidden from the charts again (2).

The last of those mattered: the first version of that test **passed while the mutation killed
nothing**, because it fed data straight to a component that never did the filtering, and because its
fixture had the category positive in one month. Both were fixed rather than left green.

### Also

Every em dash the previous session's sweep had flattened into a comma inside a *title* was restored to
a proper separator (`Expenses, line by line, Everything (both books)` read as a list). Em dashes
outside comments: still zero.

---

## Released as v1.13.1 — 2026-09-28

`Villaggio-Del-Sol.exe`, **96,248,320 bytes**, tag `v1.13.1` on `0fb6007`, run `36479349955` green in
27m05s. Every gate passed on the Windows runner: the dependency advisory check, the typecheck, the
full 1,982-test suite, the assembly, the smoke test that starts the executable and serves a real
request from it with no `dist/` beside it, and the Desktop shortcut check.

**v1.12.0 was 95,472,128 bytes**, so these two can be told apart by size, which the v1.11.1/v1.12.0
pair could not. Confirm the version from the console line or `/api/health` anyway; the sidebar reads
a cached bundle and lied on the v1.10.0 upgrade.

### v1.13.0 is a tag with nothing behind it

The first attempt built green and published nothing. Everything that means anything passed, and the
job then failed uploading the 30-day convenience artifact:

    Failed to CreateArtifact: Artifact storage quota has been hit.

That step sat **before** "Publish to the GitHub Release", so the publish never ran and a complete,
verified build was thrown away by a housekeeping step nobody installs from.

Fixed in `0fb6007` by swapping the order and marking the artifact upload `continue-on-error`. The
release asset is what people download and what lasts; the artifact is a convenience for handing
someone a build without cutting a release. A full storage quota is a billing condition, not a fault
in the build, and it must not fail a release that has already passed every real gate. The step still
runs and still reports, so the quota stays visible rather than being silently ignored.

**No application code differs between `v1.13.0` and `v1.13.1`.** The dangling tag is harmless; if it
ever confuses anyone, delete it on the remote rather than re-pointing it, because re-pointing a
published tag is the kind of thing that is invisible until it matters.

The account's Actions storage quota is still full. This repo holds one 34MB artifact and the same
binary is attached permanently to the v1.12.0 release, so the quota is being held by something in
another repo. The workflow no longer cares, but a release will keep logging the failure until it is
cleared.

### What is in it

The Strata / ISPO / Everything book filter across Operational Reports, reservation deposits reaching
the receipts ledger as received, the duplicate-deposit reconcile panel, real arrivals and departures
on the dashboard, the currency pill on a one-off charge, the refunded-deposit guard that
`reports-2000` found, one disclaimer on the printed statement instead of three, and no em dashes in
any user-facing text. It also carries four pieces that had sat uncommitted since September: printed
signature spacing, the Airbnb calendar fixes, staying signed in while the program is open, and the
screens remembering where you left them.

**Tests 1,982.** Commits: `990d087`, `25235f3`, `0fb6007`.

---

## Session of 2026-09-28 — reading the reports on one set of books

🟡 **Uncommitted on `main`, on top of the work already sitting there.** Tests → **1,982, 0 failed.**
Typecheck and build clean. Driven on a real signed-in screen against a seeded database, and every
new guard mutation-tested.

Ro, working on the live system: *"The operational reports tab is showing payments for both ISPO and
the BNS Strata. Both are not supposed to be mixed... The operating statement section shows all
figures calculated in both with no separation or option to be separated. The 'Internal-Everything'
tab does not separate the calculations, neither does the 'For the Strata corporation' which is
precisely what it was built in for... The filters and metrics need to actually work. Strata, ISPO and
Everything. There must be options to separate, especially for when the accountant comes."*

### What was actually wrong

Four separate faults, all of them real:

1. **`operatingStatement` had no book filter at all.** It computed `strataExpenditure` and
   `ispoExpenditure` and printed them as a *label* under a combined total. A label is not a filter:
   the figure a council was being asked to approve still had both books inside it. "For the strata
   corporation" only hid short-stay booking income and lumped maintenance into one line — ISPO's
   phone and company vehicle were on it, and so was rent.
2. **The management summary at the top of the tab was entirely book-blind.** Receivables, billed,
   received, expenses, the observations, the monthly chart and the account balances were one
   combined number each, with no way to take them apart.
3. **The dashboard's departures list could never contain anything.** It filtered on
   `status === 'checked-in'`, and nobody checks a guest in or out of an imported stay in this
   program. Arrivals had the mirror of the same fault: a stay stayed `confirmed` for ever, so it went
   on reading as a coming arrival after the guest had been and gone.
4. **Every reservation deposit reached the ledger as "Awaiting funds."** Raised `pending` on purpose,
   which asked the person who took the money the same question a second time on a second screen — so
   every deposit on the property read as unreceived until somebody answered it.

### The book, and where the filter lives

`ReportBook = 'strata' | 'ispo' | 'everything'`, in `finance.ts` beside the existing `ExpenseFund`.
`everything` is the default everywhere, so nothing changed until it is asked to — Ro keeps the
combined statement as *"my all in view for the entire business"*.

Income needed a book and did not have one. The mapping is **not a new decision**: it is the one
already built into `ispoOperations`, stated once as `bookOfPaymentCategory` —

- **ISPO's:** rent, short-stay bookings.
- **The corporation's:** maintenance contributions, utilities recovered, other income.

and `bookOfChargeCategory` for receivables: rent arrears are ISPO's, maintenance arrears the fund's.

**The filter is applied inside `operatingStatement`**, at the top, on both sides at once — the
standing rule for this codebase. A screen written next year that passes the raw arrays gets
`everything`, never a half-filtered page. It could not have been a `LineVisibility`: hiding a class
of income leaves the money in the other side's totals, while reading one book changes which money is
on the page at all, and the two must move together or the surplus means nothing.

**One selector governs the whole tab** (Ro's choice when asked), so a pack printed for the accountant
cannot have its management figures on one book and its statement on another. `OperatingStatement`
takes the book as a **prop**, not its own control.

### The two things that only showed up on a real screen

- **The ISPO book's own summary disagreed with its own statement**, J$39,000 against J$61,000 for the
  same period. The maintenance ISPO pays the corporation on the villas it lets is real money leaving
  ISPO and **has no row in the cost register** — it exists only as a contribution receipt. It is now
  an expenditure line on the ISPO book, taken from `operatingStatement` so the two cannot drift, and
  named on the card rather than appearing as an unexplained J$22,000.
- **A contribution typed into the cost register as well as receipted** was excluded by the statement
  and counted by the summary. One definition now — `isContributionCountedFromReceipts` and
  `expensesForBook` — used by `ispoOperations`, `operatingStatement` and the summary alike.

Every printed page and every Excel sheet names the book on its face, and the book is in the export
filename. A page whose scope is not on it is the page that gets photocopied and misread.

### Short-stay deposits

A deposit entered on a reservation is money in hand: `syncBookingDepositReceipt` now issues a
**completed** receipt with a receipt number on the spot. A deposit left `pending` by an older version
is completed **in place** on the next touch of that reservation — the same receipt, matched on
`bookingId`, never a second one beside it. Covered by restarting the server on a hand-written
`db.json` in the older shape, which is the path the HP actually takes.

The real double-count risk is the one the sync cannot see, and Ro named it: *"i do not want there to
be a double count of payments after i have manually confirmed before i apply the fix."* A deposit
typed into **Record a payment** carries no `bookingId`, so it sits beside the reservation's own
receipt. `bookingDepositFindings` finds those — same villa, same currency, same amount, inside a
bounded window — and **`BookingDeposits.tsx`** puts them at the head of the receipts ledger with the
money named and both actions offered. **Nothing is changed automatically**, which is asserted rather
than promised.

### The currency pill on "Bill a one-off charge"

Asked for by Ro. It re-opens the villa C11 fault — a charge in the currency an account is not billed
in is counted by neither side of that balance — so the server refuses it once with
`charge-currency-not-confirmed` and accepts it with `confirmCurrencyMismatch: true`. The house
pattern: one right answer, so the screen confirms rather than offering a choice, and the audit line
says the charge stands outside that account's balance.

### Tests

New `test/report-books.test.mjs` (30) and `test/short-stay-deposits.test.mjs` (34), both written as
the property's rules rather than the code's. The load-bearing ones:

- the two books add up to everything on both sides, once the one genuine transfer between them is
  taken out — the arithmetic guarantee against anything being lost *or* doubled;
- the ISPO book's surplus equals `ispoOperations.net` for the same period — two screens, one answer;
- the tab summary's "paid out" equals the statement's expenditure total on all three books, with a
  third assertion that the comparison was made against real money and not three zeros agreeing.

**Five mutations run, five killed:** deposits back to `pending` (1 death), the book filter removed
(16), the currency guard bypassed (6), departures back to `status === 'checked-in'` (4), the ISPO
transfer line removed (7).

### Second pass — 2,000 operations, one disclaimer, and a real fault they found

Ro, the same day: *"run 2k tests and scenario combinations of use to test accuracy, robustness,
integrity, find gaps in the code etc... also for the different filters that are under the operational
reports, ensure they work as intended... as for the statement, there are 3 different areas of
disclaimers, thats unnecessary."*

**The disclaimers.** Three blocks on the printed statement — an opening paragraph, the scope box added
with the books, and a footer — between them saying the currency rule three times and the cash basis
twice. Now **one** block above the figures, carrying whose money it is, the scope of the book, the
cash basis, "not a tax document", the currency rule and the indicative rate. The management report
beside it had the same shape and got the same treatment.

**`test/reports-2000.test.mjs`** — 2,000 seeded operations, audited every 125 against the whole
accumulated database, 24 checks. `books-5000` audits the books as they are *recorded* and predates the
filters entirely; this one audits them as they are *read*. Eleven invariants, including: the books add
up on both sides once the internal transfer is removed **and the exclusion the ISPO statement names is
added back**; nothing appears on the wrong book; nothing voided appears on any book; the ISPO book and
the ISPO Operations statement agree; the tab summary agrees with the statement beneath it on all three
books; receivables split by account; a deposit is on the ledger exactly once, net of refunds; a charge
in the wrong currency is named and never counted; arrivals and departures are derived and disjoint.
Coverage is asserted on **what it did**, not only on what stayed true — 342 strata costs, 213 ISPO
costs, 127 taken back, 361 receipts, 50 voided, 44 refunded, 139 reservations, 148 edits, 47
cancellations, 157 one-off charges, 52 in the wrong currency, 35 refused for it, 114 own-account
toggles.

**It found a real fault on its first run, and it is money.** Refunding a reservation deposit reduces
`booking.depositPaid` and leaves the receipt's `amount` alone — correct, a receipt is what the guest
was handed. But editing the deposit afterwards then overwrote `amount` while `refundedAmount` stayed,
so the receipt netted to `newAmount − refund`: not what the property holds, and **negative** when the
new deposit was smaller — a receipt claiming more money went back than ever came in. Everything built
on `amount − refundedAmount` carried it: booking income on ISPO's book, the operating statement, and
"deposits held" on the dashboard. It predates this session but only bit once deposits started reaching
the ledger as received.

Refused now, with `deposit-receipt-already-refunded`, naming what to record instead — a further
payment, or a refund. The whole change rolls back; an edit that leaves the deposit alone is untouched.
Regression test in `short-stay-deposits`, and the guard mutation-tested: removing it kills 5 checks
there and 1 in the 2,000 run.

Two invariants in the new suite were wrong on their first run and were corrected rather than loosened:
the receipt/deposit comparison had to be **net of refunds**, and the books' sum had to add back what
the ISPO book **names** as already counted from its receipts — the strong form, which fails if money
vanishes *or* vanishes quietly.

**Tests → 1,982, 0 failed.** Typecheck and build clean. Print preview driven on a real screen for both
the strata and the ISPO book.

### Still to do / open with Ro

- **The ISPO→Villaggio bank transfers in the live register.** Ro: *"those are just transfer notes
  from one bank account to the next to inform the reader where the money came from to pay the
  expense."* They are recorded as **ISPO expenses** (J$122,000 + J$100,000 on 17 and 24 Sep). If they
  are annotations, that is J$222,000 of costs ISPO did not incur. If they are genuine funding
  movements, they are correct per book and are the same money twice in the combined `everything`
  total — the shape the maintenance contribution already has, and which the app names as an internal
  transfer. **Not changed. Ro's call.**

---

## Session of 2026-09-16 (third) — signatures on a second sheet, and what happens after a stay

**Unreleased. Uncommitted on `main`, with everything below it.**

**The `×3`, `×8` beside receipt numbers** are the print count (`payment.printCount`): how many times
that receipt has been printed. Every copy after the first prints marked REPRINT and is on the audit
trail. Nothing said so on screen; the badge now has a tooltip that does.

**Signatures printing alone on a second sheet** (Ro: *"a waste of paper for just a signature
section"*). `PrintSignatures` sits under `mt-12 pt-10` — 88px, about 23mm on paper — before a single
signing line. On paper only (`@media print`, class `vds-print-signatures`) that is now 6mm, and the
block is `break-inside: avoid` so it can never be split across two pages. The signing line itself is
unchanged.

**Measured, not assumed.** The real `PrintPortal` + `PrintLetterhead` + `PrintSignatures` were
rendered with the built stylesheet and printed to PDF by headless Chrome (Letter), with a table of
N rows, against the same stylesheet with only the new rules removed. That turned up a **second
cause**: in the "before" PDF at 15 rows, page 2 held **only the "Powered by ISPO" credit** — the
signatures had fitted and the one-line footer took a sheet of its own. The credit is now tightened on
paper too (`vds-print-credit`). Result:

| Rows | Before | After |
|---|---|---|
| 8–14 | 1 page | 1 page |
| **15** | **2 pages** (credit alone on page 2) | **1 page** |
| **16** | **2 pages** | **1 page** |
| 17 | 2 pages | 2 pages — genuinely full, ~2cm short; the whole block moves over together, not split |

So on this document roughly **two rows' worth** of page is recovered. A page full to the last line
still has to go over; no print setting makes room that is not there. The PDFs were looked at, not just
counted. Not in the suite — it runs where there is no Chrome — so `components.test.mjs` +3 holds the
pieces the measurement depended on (the class, the 6mm/no-split rule, the credit rule).

**"Once the date has passed, the system will do what?"** Answering it found a fault.
- On screen: from the **departure day** the stay reads **Completed**, the row is shaded, and the
  "Completed" filter finds it. Nothing else happens: the recorded status is not changed, nobody is
  checked out, money is not touched (a completed stay still owing still shows its balance), and
  nothing is hidden, deleted or sent.
- **The fault:** `planWithdrawals` treated any imported stay that stopped appearing in the feed as
  cancelled, **with no look at the date**. A platform export has no reason to keep listing old stays,
  so a finished stay dropping out of it would have been marked *cancelled* on the next sync — or, if it
  carried money, raised as a "cancel it by hand and settle the deposit" conflict on **every** sync
  afterwards. Now: a stay that has **ended is left exactly as it is**; a stay **under way** is never
  cancelled silently, money or not — it is raised as a conflict to check on the platform; only a stay
  **still to come** is withdrawn as before. `today` is a required parameter so no caller can forget it.
  How long Airbnb goes on listing past stays was not verified; the guard does not depend on it.

**Tests — 1,861 → 1,871, 0 failed. `ical-parsing.test.mjs` +7, `components.test.mjs` +3.** Mutations: removing the
ended-stay exemption fails 3; removing the under-way branch fails 2.

## Session of 2026-09-16 (second) — the Airbnb calendar on real bookings

**Unreleased. Uncommitted on `main`, with the two pieces of work below it.**

Ro connected villa B6's Airbnb calendar for the first time and reported five things. What each one
turned out to be:

**1. "It doesn't show client information."** Not something any program can get from this feed.
Airbnb's iCal export carries **no guest name, email or price** — every reservation is `SUMMARY:
Reserved` — and only an Airbnb-approved software partner can reach guest details through their API.
What the feed *does* carry, in each reservation's description, is a link to the reservation and the
**last four digits of the guest's phone**. The sync already copied that into the notes, where nobody
would look. The list now shows the confirmation code as a link that opens the reservation in Airbnb,
plus "phone ends 1234", so the guest can be copied across in one step.

**And a real fault behind it, contradicting a promise on screen.** The booking form says *"Re-syncing
will update the dates but will not overwrite what you enter."* The sync compared `guestName` and
wrote it back, so **every name typed onto an imported stay reverted to "External guest" on the next
Sync** — the only way to get a guest onto an imported stay undid itself. New `feedDateChange()` in
`server/ical.ts` (pure, beside `planWithdrawals`, for the same reason): a re-sync changes dates and
nothing else.

**2. "Paid in full" over USD $0.00 on a stay not yet taken.** The receipt read `balanceDue <= 0` as
settled, and an imported stay has no value, so no balance. New `receiptStanding()`:
`no-value | balance-due | paid`, paid only when there was a value and nothing is left of it. A
no-value stay prints as a **confirmation** with "Stay total: Not yet confirmed", no money box, no
"Paid in full"; the emailed version says the same. The list shows "Stay value not entered" instead
of three $0.00 columns. Greeting reads "Dear Guest" rather than "Dear External guest" or
"Dear Airbnb (Not available)".

**3. "Only one says Airbnb, the other two say Blocked."** The import is reading Airbnb correctly.
Airbnb's export has exactly two kinds of entry: `Reserved` (a guest) and `Airbnb (Not available)` —
**everything else closed on the listing**, identically: nights blocked by hand, preparation gaps, the
booking window, dates synced in from another calendar. The two long B6 entries (10–26 Dec,
28 Dec–19 Jan) are the second kind. **Ro should check B6's Airbnb calendar for those dates**: if real
guests are in them, they came from somewhere Airbnb does not name to the feed. What changed here is
only how they read: "Dates closed — no guest" with the feed's text beneath, "No stay to charge", and
**no Guest receipt or Hold-deposit button** beside them.

**4. "When a stay has been completed there's no way to tell."** The recorded `status` only changes
when somebody changes it, and nobody checks a guest out of an Airbnb stay here, so last month's stays
read "confirmed". New `stayPhase()` derives **Upcoming / In stay / Completed / Cancelled** from the
dates — the departure day counts as completed, since the villa is free on it — and the Status column
and the list filter now use it. Completed rows are shaded. The recorded status is untouched.
The filter is remembered per session (`bookings.listFilter`).

**5. "The app's calendar isn't fed back to Airbnb." — not built; a decision for Ro.** Technically an
export feed is small: a secret per-villa `.ics` URL of direct bookings, pasted into Airbnb's
"Import calendar". What stands in the way is not the code:
- **Airbnb has to fetch it from the internet, and the HP is not on the internet** — it is reached
  over Tailscale on a plain-HTTP LAN, by design. Exporting means exposing the HP publicly (e.g.
  Tailscale Funnel), which is an infrastructure and security decision, not a feature.
- **Airbnb refreshes imported calendars on its own schedule, every few hours**, so a direct booking
  taken at 10am could still be sold on Airbnb before it lands. It narrows double-booking, it does
  not close it.
- It must never echo Airbnb's own imported stays back to Airbnb.
**Recommended: stay manual** — when a direct booking is taken, close those dates on Airbnb at the
same moment — and revisit if direct bookings become frequent.

**New `src/lib/stays.ts`** holds the rules (`isClosedDates`, `stayPhase`, `receiptStanding`,
`platformReservation`, `guestGreetingName`). The reservation link is **rebuilt from the code on
Airbnb's own address**, never lifted from the notes: notes are free text anyone with edit rights can
type, and a lifted link would let a note point that button anywhere.

**Tests — 1,831 → 1,861, 0 failed.** `components.test.mjs` +25, rendering the real `GuestStayReceipt` (now exported) on the
rows from Ro's screenshot; `ical-parsing.test.mjs` +5 for the re-sync rule. Two of those five are
**source checks and say so**: the sync cannot be driven from a test because the SSRF guard refuses a
local feed, rightly, so they read `syncFeed` for the call to `feedDateChange` and the absence of a
`existing.guestName =` assignment.

**Mutations — all 8 killed:** receipt back to `balanceDue <= 0` (2 fail); standing ignoring the value
(5); departure day counted as in stay (1); link lifted from notes (2); greeting using the feed's name
(2); email back to $0.00 (1); sync overwriting the name again (1); date rule letting a name through (1).

**Not covered by any test:** the list rows themselves (hidden buttons, "Dates closed", the link) —
`Bookings` needs a full set of props to render and was checked by reading, not asserted. And none of
it was driven in a signed-in browser.

## Session of 2026-09-16 — staying signed in while the program is open

**Unreleased. Uncommitted on `main`, alongside the 2026-09-04 screen-memory work below.**

Ro, 2026-09-16: *"if i leave the program open, say overnight, eventually it times out, and closes."*

**The cause was a fixed shelf life, not a timeout.** `SESSION_TTL_MS` was twelve hours **from
sign-in**, however much the session was used: sign in at 8am, signed out at 8pm mid-click. Two
details made it certain overnight: the open screen's connection watcher only polls `/api/health`,
which needs no session, so nothing an untouched screen did counted as use; and `lastSeenAt` was
recorded on every request and read by nothing.

**Ro chose "stay signed in while it's open"** over "24 hours unused" and "7 days from sign-in",
with the trade-off stated: a screen left open at an empty desk stays signed in until closed or
signed out.

**What changed.**
- `server/auth.ts` — `renewSession()`: every signed-in request (`requireAuth`) and
  `/api/auth/me` push the expiry to twelve hours from *now*. Twelve hours is now how long a
  session survives with **nothing holding it open**. Three copies of the expiry move together, and
  each one on its own was a way to be signed out anyway: the live database; **db.json**, or an HP
  restarting overnight brings back the old expiry; and **the browser's cookie**, whose `Max-Age`
  was set at sign-in and would be deleted at the original time whatever the server believed.
  Throttled by `SESSION_RENEW_EVERY_MS` (1 hour), so a check-in is a disk write at most hourly per
  open screen, not every five minutes.
- `src/App.tsx` — `SESSION_HEARTBEAT_MS` (5 minutes): while signed in, the application checks in on
  `/api/auth/me` by itself, and again on `visibilitychange` and `online`, so a machine waking from
  sleep renews before anyone clicks. A genuine 401 goes through the ordinary unauthenticated
  handler; network errors are ignored here and never sign anybody out.

**⚠️ The one case this does not cover — tell Ro if it bites.** A computer that **sleeps** runs no
timers, so a screen on a machine asleep for more than twelve hours is still signed out on waking
(the `visibilitychange` check-in then gets a 401). An office machine asleep 6pm to 8am is fourteen
hours. If the Kamrui or the desk PC sleeps overnight, either set its power plan to not sleep, or
raise `SESSION_TTL_MS` — it is one number, and the tests read the lifetime from the cookie, so
`TTL_SECONDS` in the test moves with it.

**Tests — 1,813 → 1,831, 0 failed. New `test/staying-signed-in.test.mjs`, 18 checks**, named after the rules in the order a
morning meets them: the open screen checking in stays signed in; the browser is handed a fresh
twelve hours; the renewal reaches db.json; **so the screen is still signed in after the server
restarts overnight**; ordinary work renews too; a session renewed minutes ago is not renewed again
and nothing is rewritten; a session nothing held open is refused, gets no new cookie and cannot be
brought back; signing out still signs out. Time is moved the way `staff-accounts` already moves it:
stop the server, age the session on disk, start again. The heartbeat is a React effect the server
renderer does not run, so its three checks read the source — they guard the *relationship* (the
interval stays well inside the lifetime), not the behaviour, and say so.

**Mutations run** (server rebuilt for each):
| Mutation | Result |
|---|---|
| No renewal anywhere | 5 fail |
| Cookie not re-issued | 2 fail |
| Nothing saved to disk | 3 fail |
| Renew on every request | 2 fail |
| Check-in route does not renew | 3 fail |
| Only the `stored.expiresAt =` line inside the save removed | **0 fail** |

The last one survived, and why is written on the line: in the ordinary case the live session was
already moved and the transaction writes a copy of it, so the line changes nothing. It exists for a
narrow race — a transaction mid-flight that took its copy before the renewal and replaces the live
database when it finishes. The suite does not produce that race. It is documented as uncovered
rather than counted as coverage.

**Not verified on a signed-in browser.** Signing in is not something this seat does.

## Session of 2026-09-04 — the screens now remember where you left them

**Unreleased. On `main`, not yet in a tagged build.**

Ro, 2026-09-04: *"i was in operational reports, went to the general dashboards to look at the
numbers went back to operational reports and what i was looking at was already off screen because
the tabs default to August 2026 instead of the current month. it makes for an annoying workflow,
and its the same thing in the other applicable tabs."*

`App.tsx` renders exactly one tab, so leaving a screen unmounts it and every choice on it — the
month, the period, which sub-view — was thrown away. Coming back re-ran the default.

**The defaults were not changed, and should not be.** `MonthlyOwnersReport`,
`OperationsStatement` and `IspoOperations` open on *last* month on purpose, and the reason is
written above each one: a report about a finished month opened on a month still running invites a
part-month figure being circulated as if it were final. August was the right first answer on
4 September. What was wrong was that the screen kept giving it after Ro had said otherwise.

**New `src/lib/screenState.ts`** — `useRemembered(key, initial)`, a drop-in for `useState` that
consults the documented default only the first time a key is used in the session. Same shape and
same reasoning as `reportRange.ts`: a module, session-scoped, not persisted, because this is a
working choice and not a setting. Cleared by `forgetScreenState()` on sign-out, alongside the
records snapshot — the desk machine is shared and the next person to sign in is not owed the last
one's view. `resetReportRange()` was added and wired in at the same time; `reportRange.ts` had a
`/** Testing seam: forget the shared range. */` comment with **no function under it** (lost in the
dead-code tidy), and nothing had been clearing the shared period on logout at all.

**28 controls across 14 screens** now remember: the month on the dashboard, bookings, monthly
expenses, reconciliation, the operations statement, ISPO operations and the proprietors' monthly;
the period on the operating statement, the shortfall report, owner statements and projections (with its
lookback and horizon); and
the sub-view on bookings, the ledger, utilities, the shortfall report and the annual report.
Keys are namespaced by screen (`'reports.ispo.month'`).

**Deliberately left alone:**
- **The shortfall report's `open` toggle.** Ro, 2026-09-02: *"make it a toggle switch as it is not
  something we need to have open permanently."* It stays shut on every mount. VDS's trading
  position does not belong on a screen left in front of whoever is at the desk, and "I opened it
  ten minutes ago" is not a reason to put it back up.
- **`postMonth` on the ledger.** That is the target of an action, not a viewing lens, and posting
  the current month is what it should offer.
- **Charts and Operational Reports' own range**, which already survived via `reportRange.ts`.

**Tests — 1,806 → 1,813**, seven new checks in `test/components.test.mjs` (screen behaviour, which
is what that file is for). They are named after Ro's rules rather than the functions:
*"a report about a finished month still opens on last month the first time you see it"*, *"and
comes back to the month you left it on, not to the default again"*, *"signing out forgets it"*.
`renderToStaticMarkup` mounts fresh on every call, which is exactly what leaving a tab and coming
back does, so a second render **is** the return trip — the screen under test is the real
`IspoOperations`, not a probe.

Two mutations were run and both killed a test:
- `IspoOperations` reverted to plain `useState` → *"and comes back to the month you left it on"*
  fails with `showed 2026-08` — the exact thing Ro reported.
- `Dashboard`'s key changed to `IspoOperations`' → *"every remembered key is used by exactly one
  screen"* fails and names both. Two screens sharing a key would silently share a control and
  nothing in TypeScript prevents it, so the check greps the real source.

**Not yet verified on a real signed-in screen.** The automated proof is a genuine remount of a real
component, but no browser session was driven — signing in is not something this seat does. Worth
one pass through the tabs on the HP before it is tagged.

## Released as v1.12.0 — 2026-09-03

Tag `v1.12.0` on `3bff141`, `Villaggio-Del-Sol.exe` **95,472,128 bytes**, published 2026-09-04.
Every gate passed on the Windows runner: `npm ci`, `npm audit --omit=dev --audit-level=high`,
`npm run lint`, the **1,806-test suite (0 failed)**, the client and SEA bundle, assembling the
executable, **starting it and serving a real request**, and verifying the Desktop shortcut.

⚠️ **v1.11.1 was 95,428,608 bytes and this is 95,472,128 — close enough to misread at a glance.**
Tell them apart by the version on the console line, never by the file size.

**What it carries** — the four sessions below, in order:

1. **Taking a cost back.** A posted expense can be recalled and a mistaken monthly cost removed
   outright. Before this, a month posted in error stayed in the operating statement, the proprietors'
   reports and the annual accounts permanently.
2. **The two books.** The corporation's money and ISPO's are separated. This is the one with a
   consequence you can measure: ISPO's phone and vehicle costs were counted as the corporation's and
   ran into `feeToCoverBudget`, **the maintenance contribution the annual report puts to the AGM**.
3. **5,000 operations** over both books, the voids and the recalls, plus the `viewIspoOperations`
   permission on "every role unless withdrawn", and the ISPO statement made assertably printable.
4. **The dead-code tidy**, with `noUnusedLocals`/`noUnusedParameters` now gating the build.

**Also fixed:** the stray full-width rule above the signature block on **every** printed document.

⚠️ **Two setup steps are Ro's, and two screens look wrong until he does them** — see "Where to pick
up". Nothing guesses either of them.

**Verified before cutting**, on a clean database with one dataset (contributions J$120,000, rent
J$240,000, strata costs J$185,000, ISPO costs J$74,000):

| Document | Expenditure | ISPO's vendors on it? |
| --- | --- | --- |
| Proprietors' monthly | J$185,000 | no |
| Annual report (drives the AGM contribution) | J$185,000 | no |
| ISPO Operations | J$74,000 own + J$60,000 contributions = J$134,000 | only ISPO's |
| Operating statement (Ro's all-in view) | J$259,000, named as J$185,000 + J$74,000 | both, labelled |

The books reconcile and the J$60,000 transfer is named on the combined page rather than counted
twice.

⚠️ **Still not proven, and it has not changed:** nothing has been printed **on paper**; the `.exe`
outside CI, the PWA/service worker after an upgrade, the offline queue under real network loss, an
Excel export opened in **actual Excel**, and the two-PC dry run are all untested. And nobody has yet
used the two books on the real records — every fault in this project's history was found there, not
by the suite.

**Known and accepted:** `npm audit` reports three **moderate** advisories in `qs` → `body-parser` →
`express`. The release gate is `--audit-level=high`, so they do not block it, and changing the
dependency tree while cutting a release is the wrong moment. Worth clearing deliberately in a quiet
commit: `npm audit fix`, then the full suite.

## Released as v1.11.1 — 2026-09-03

Tag `v1.11.1` on `342a850`, `Villaggio-Del-Sol.exe` **95,428,608 bytes**, published by the workflow
after the full suite passed on the Windows runner. It carries everything in the three sessions below:
the shortfall report from v1.11.0, the five faults real data found, the split occupancy figures and
the proprietors' monthly report.

v1.11.1 is superseded by v1.12.0 above. Install the latest only.

---

## Session of 2026-09-03 (fourth pass) — the tidy

Ro: *"tidy everything that needs tidying including what you found in your own work"*, then *"remove all
dead code"*.

### What was found, and how

Four sweeps, each mechanical rather than by eye, because "looks unused" is not evidence:

1. **`tsc --noUnusedLocals --noUnusedParameters`** — 34 unused declarations. To separate mine from
   inherited, the same check was run in a git worktree at `906c4b4` (the commit before this session):
   **33 there, 34 now**, so exactly **one was mine** — an `ExpenseFund` import in `finance.ts` I added
   and never used. The other 33 were pre-existing.
2. **A dead-export scan** across `src/`, `server/`, `server.ts` **and `test/`** — because a helper
   pulled out purely so a test can reach it is not dead, which is a deliberate pattern here.
   **12 exports referenced nowhere at all**, each verified by a whole-repo grep returning exactly one
   hit: its own declaration.
3. **A prop scan** for interface members no component reads — tsc cannot see these, an unread member
   is legal. Found two.
4. **A route scan** and an **orphan-module scan** — all 54 routes are reached by the client or the
   tests, and every module is imported by something. No commented-out code anywhere.

### What was removed

- **My own**: the unused `ExpenseFund` import.
- **The dead guard I flagged last pass, and its twin.** `if (base.viewShortfall === undefined) …` in
  `server/db.ts` was unreachable for the same reason the ISPO one was: `merged` spreads
  `noPermissions()` first and that set already carries `true`. **Both gone.** `recordPayments` and
  `postCharges` keep theirs and now say why — `noPermissions()` carries those as `false`, so without
  their lines an upgrade really would withdraw them. Mutating the surviving mechanism now fails five
  checks including the upgrade path, so it is provably load-bearing.
- **12 dead exports**: `resetCacheForTests`, `getConnection`, `getPendingCount`, `creditAccounts`,
  `groupByMonth`, `formatMoneyPlain`, `toMoney`, `clearQueue`, `subscribePending`, `clearReportRange`,
  `OPEN_WORK_STATUSES`, `PROPERTY_LOCATION_LABELS`.
  - `subscribePending` cascaded: it was the only thing that could populate `listeners`, so the whole
    pub/sub in `queue.ts` — the `Listener` type, the set, and the notify loop — was unreachable and
    went with it.
  - `formatMoneyPlain` was "for CSV exports"; nothing has produced a CSV since v1.10.0 replaced them
    with Excel workbooks.
  - `toMoney` defaulted an unparseable figure to zero. **Its warning was worth keeping even though the
    function was not**, so the note about never booking a silent zero moved onto `parseMoneyInput`,
    which is the one actually used.
  - `PROPERTY_LOCATION_LABELS` was superseded by `getAllocationLabel()`.
- **33 unused imports** across 18 files, and one unused parameter: `syncOwnership` took the unit's
  previous state and never read it. That is **not** a latent bug — `syncTenancy` needs its `original`
  to report a status change, while ownership changes are detected from the open `Ownership` period,
  which is the correct source. The parameter was symmetry for its own sake; removed, and the reason
  written down so nobody adds it back.
- **Two dead props**: `RecurringForm`'s `vendors` (the suggestions come from the parent's datalist) and
  `Dashboard`'s `onRefresh`, both including the pass-down in the caller. The first sweep left `vendors`
  half-alive — the destructure gone, the type and the pass-down still there — which is worth
  remembering: removing a destructured prop is three edits, not one.

### What was deliberately kept

**Four engines are reachable only from the test suite and are staying**, now documented in a block at
the head of `finance.ts` so the next sweep does not raise them again: `form13BContributions` and
`form13CDebts` (Ro, 2026-08-21: the statutory return stays manual — *"Forms 13B/13C export stays
manual"* — so the engines wait for a screen that has not been asked for), plus `periodStatement` and
`disproportionateLevies`. All four are tested, so none can rot silently. **Deleting them is Ro's call,
not a tidy-up.**

### And the check is now permanent

`noUnusedLocals` and `noUnusedParameters` are on in `tsconfig.json`. CI already gates on
`npm run lint` (`tsc --noEmit`), so unused code now fails the build rather than accumulating again —
which is how 33 of them got there. An intentionally unused parameter can still be named with a
leading underscore.

**1,806 tests pass.** Typecheck and build clean. Net **123 deletions against 83 insertions** across 26
files, most of the insertions being the explanations above.

---

## Session of 2026-09-03 (third pass) — 5,000 operations, and what they found

Ro: *"Ispo read only. also ensure it is printable. Short Term Bookings are also Ispo income. Every role
unless withdrawn is the best option. You keep finding little bugs and things to fix. Run 5000 tests /
simulations for robustness, mapping, bugs, accuracy, arithmetic, etc. now that changes have been
made."*

### The four instructions

- **Read only** — it always was; nothing is typed into ISPO Operations, every figure is generated.
- **Printable** — it was, and now it is *asserted*: `printed-records.test.mjs` renders the document and
  checks it carries the rent, the short-stay income, each cost named, the contribution line, the unpaid
  memo, the internal-document notice and the preparer — and that **no strata cost is on it**. The
  printed page also gained the signature block every other document here carries.
- **Short-term bookings are ISPO income** — already counted (`bookingReceived`), now asserted on both
  the screen and the printed page.
- **Every role unless withdrawn** — new `viewIspoOperations` permission, granted to every role by
  default, withdrawable in System Settings (the matrix is data-driven, so the switch appeared for free).
  **And the guard that could not fire is gone**: `Reports.tsx` no longer wraps the shortfall report in
  `session.role === 'ADMINISTRATOR'`, so its "every role unless withdrawn" rule finally reaches
  somebody. The ISPO statement follows the same rule, decided inside the component, once.

### The new suite: `test/books-5000.test.mjs`

Five thousand operations through the real HTTP API — costs in both books, receipts, month runs, voids,
month recalls, template removals, edits that move a cost between the books, and new templates. The
whole database is audited every 250 operations against seven invariants, the first being
**strata + ISPO = the whole**, per currency, over three periods: the direct answer to *"ensure there's
no double counting anywhere"*, since it fails if a cost is counted twice **or** if one falls between
the two books.

**It found three things on its first two runs**, which is the entire point of having built it:

1. **The rent scopes genuinely differ, and nothing said so.** `ispoOperations` counts *every* rent and
   booking receipt — the corporation never collects a proprietor's rent, so any rent is ISPO's — while
   the shortfall report counts only villas ticked `letOnOwnAccount`. On Ro's live data those coincide;
   the moment they do not, the two documents quote different rent for the same month with no
   explanation. **Fixed by stating it**: `incomeFromUnflaggedVillas` is now on the statement, naming
   the villas, because it means either a villa VDS lets that nobody has ticked or rent recorded against
   a proprietor's villa. The invariant is now containment plus a declared gap, not equality.
2. **The simulation degenerated and the coverage assertions caught it.** Templates were being removed
   faster than anything created them, so within a few hundred operations there was nothing left to
   post or recall — "0 recalled" out of five thousand — while every invariant still passed happily. A
   replenishing branch was added, and skipped operations are now counted so the totals reconcile to
   5,000.
3. **The delete path was never reached at all** on the first run, because templates almost always
   carry live postings. The simulation now walks the remedy the refusal names — recall the months,
   then remove — which is the workflow Ro will actually use.

### And a dead guard, found by mutation-testing my own fix

The `if (base.viewIspoOperations === undefined) merged.viewIspoOperations = true;` line I first added to
`server/db.ts` was **unreachable**: `merged` spreads `noPermissions()` first and that set already
carries `true`. Deleting the line broke nothing. Per this codebase's own rule — *a guard that cannot
fire is worse than no guard, because it is counted as coverage* — it was removed, and the behaviour is
proved instead by a **real upgrade test**: a `db.json` is written in the shape an older version left
it, the server is restarted on it, and the permissions are read back. That is the HP's actual upgrade
path and nothing had ever covered it. ⚠️ The equivalent `viewShortfall` line above it is redundant
today for the same reason; left alone rather than churned, but worth tidying.

### Mutations run against the new work

| Mutation | Result |
| --- | --- |
| voided costs count again | `books-5000` fails, 126 problems |
| the ISPO statement stops filtering to its own book | `books-5000` fails, 14,082 problems |
| `noPermissions()` default flipped to false | `two-books` fails 2, including the upgrade path |
| ISPO statement gated on ADMINISTRATOR (the old mistake) | `components` fails 3 |
| absent permission read as a denial | `components` fails 1 |

**1,806 tests pass.** Typecheck and build clean.

---

## Session of 2026-09-03 (second half) — the two books (shipped in v1.12.0)

Ro, still on the live system: *"Ispo, the company that owns VDS is the company who collects the Rent
payments, there are certain expenses, such as Cell phone bills, company vehicle expenses and insurance
and other expenses that are paid from the rental income. This has not yet been accounted for … how can
i separate the two?"* And, while it was being built: *"ensure there's no double counting anywhere."*

### The fault this was hiding

Every cost was the corporation's. `isCommonCost` accepted **General and Office alike**, so a cell phone
bill or a vehicle invoice was a common cost of the property — and from there it ran into
`budgetExpenditure` and then into `feeToCoverBudget`, **which is the maintenance contribution the annual
report puts to the AGM.** ISPO's vehicle insurance was being charged to sixteen proprietors through the
one number they vote on. Mutation-tested, so the size is known rather than asserted: on the test's own
figures the contribution goes from **J$7,333.34 to J$10,000 per villa per month** when the filter is
removed. It also reached the proprietors' monthly report and would have reached Form 13C.

### The design

**`ExpenseFund = 'strata' | 'ispo'` on `Expense` and `RecurringExpense`. Absent means `strata`** — which
is what every existing record is, what the reports already say, and what the great majority of costs
genuinely are. Nothing moved on the upgrade; only the exceptions get marked. Ro confirmed the scope
himself: *"office costs, property electricty grounds staff, pool mainentance, painting, etc are covered
by Maintenance payments are all strata."* All of those still count exactly as before.

**Where the filter lives is the load-bearing decision.** A document that is a strata document *by
identity* filters **inside the function**, the same way it already decides for itself that only
`status === 'paid'` counts: `operationsStatement`, `annualOwnersReport`, `form13CDebts`, `ownerStatement`.
Left to the caller, a screen written next year forgets and puts the vehicle insurance back into the AGM
figure, silently and self-consistently. `Projections` and `BoardPack` filter at their own boundary
(they call the general helpers) and are asserted in the suite for that reason.

**The combined views keep both books**, because Ro asked for that explicitly. The Operating Statement
stays his *"all in view for the entire business"* — but it now **names the split on its face and on the
printed page**, since it carries the corporation's letterhead and a reader otherwise cannot tell whose
costs are whose.

**`ispoOperations`** is the mirror of the owners' statement: rent and short-stay receipts against ISPO's
own costs, plus the contribution ISPO pays on the villas it lets. Under Operational Reports, badged
internal, gated exactly as the shortfall report is gated there.

### No double counting — the four rules, and the one that was only a claim

1. **Every cost is in exactly one book.** `strata + ISPO = the whole`, asserted directly over three
   periods and both currencies. It fails if anything is counted twice *or* lost.
2. **The contribution ISPO pays is an internal transfer** — the corporation's income and ISPO's cost,
   genuinely both. Named on the combined statement as such, so nobody reads the gross totals as money
   that entered or left the group.
3. **That figure is read from the receipts, never from an expense row**, and both it and the shortfall
   report go through the new `netReceivedInPeriod`, so they cannot drift apart on refund timing.
4. **ISPO Operations and the shortfall report are made to agree**, and the suite compares them.

⚠️ **Rule 3 was a claim, not a test, and mutation testing caught it.** Making the ISPO statement also
count a Maintenance-category cost row on an own-account villa produced **no failure at all**. The design
only *detected* that shape (via a new `contribution-entered-as-a-cost` self-check); it was not immune to
it. Fixed: such a row is now excluded from ISPO's own costs — and **named on the page**, never silently
dropped — so the double count is arithmetically impossible rather than merely reported. Re-run, the same
mutation fails two checks.

### Also fixed, reported by Ro while this was being built

**The stray rule above the signature block.** *"on statements to be printed, there is a random line
above the signature lines … it runs almost edge to edge. it should be removed."* `PrintSignatures`
carried `border-t` across the full width of the page, immediately above the two short lines a person
actually signs on. Removed; the spacing is kept. It is one shared component, so the fix reaches **every**
printed document at once — verified on the printed expense register (`border-top: 0px`, and by eye).

### The test

`test/two-books.test.mjs`, **50 checks**, phrased as the property's rules. Seven mutations were run and
every one now fails the suite: the annual report unfiltered (4 fail, and it names the AGM figure moving),
the monthly report unfiltered (4), owner statements unfiltered (1), Form 13C unfiltered (2), the transfer
counting every proprietor's contribution (2), the contribution counted twice on the ISPO statement (2 —
zero before the fix above), and the self-check silenced (1).

**Driven through the real UI** on a scratch database as well: the "Paid from" cards on the expense form
with strata preselected, the ISPO badge and split totals in the register, ISPO Operations rendering with
its own figures, and the owners' statement correctly refusing to print a month whose only cost was
ISPO's.

**1,761 tests pass.** Typecheck and build clean.

### Still to do

- **Not released.** This and the cost-recall work above both need a version bump, tag and Windows build.
- **Mark the ISPO costs once**, in the expense register or on their monthly cost — the phone, the
  vehicle, the vehicle insurance. Nothing guesses them.
- **Tick "let on the corporation's own account"** on the villas VDS lets, or the ISPO statement's
  maintenance line reads nil. The screen says so rather than showing a silent zero.
- ✅ **Closed in the third pass below:** the unreachable `ADMINISTRATOR` gate on the shortfall report
  is gone — Ro chose *"Every role unless withdrawn"* — and the ISPO statement follows the same rule
  through a new `viewIspoOperations` permission.
- ✅ **Closed in the fourth pass:** every dead export, unused import, unread prop and unfirable guard
  in the tree is gone, and `noUnusedLocals`/`noUnusedParameters` now gate the build so they cannot
  come back.

---

## Session of 2026-09-03 — taking a cost back (shipped in v1.12.0)

Ro, working on the live system: *"when the line items are posted under monthly costs, there is no
option to completely remove that item from the system. When the expenses are posted, there is no
option to recall the posting in the event an error was made. Those are real operational gaps as
errors do happen. all the arithemetic and affected areas will also neeed to be adjusted
accordingly."*

Both were real, and the second was the worse of the two. **Posting a month raised up to twenty costs
in one action and nothing on the machine could take them back.** A run posted for the wrong month,
or twice, or off the wrong invoice, stayed in the operating statement, the proprietors' reports and
the annual accounts permanently — the only "remedy" was to edit the mistaken cost into some other
cost, which destroys the record of what actually happened. An expense had no void of any kind: the
charge ledger had one since the beginning, the expense register never did.

### What was built

**1. `Expense.status` gained a third state, `void`.** Deliberately a status and not a flag: every sum
in `finance.ts` already keys on `status === 'paid'` or `status === 'pending'`, so a cost taken back
leaves the arithmetic everywhere **by construction** rather than by twenty call sites each
remembering to exclude it. The row carries `voidedBy`, `voidedAt`, `voidReason` and `voidedFromPaid`.
Nothing is deleted, for the same reason a charge is voided rather than removed.

**2. `POST /api/expenses/:id/void`** — take one cost back. **3. `POST /api/expenses/recall-month`** —
take a whole posted run back in one action, matching the way it went in. Only rows the run raised are
touched (`periodMonth` is set on those and nothing else), so **a cost logged by hand in the same month
is left alone** — there is a test for exactly that, because a recall that swept it up would cause the
kind of loss it exists to fix.

**4. `DELETE /api/recurring-expenses/:id`** — remove a monthly cost outright. The rule is about
*history*, not about the template: nothing live raised from it → it never happened, it goes; anything
still on the books → refused with `monthly-cost-has-postings`, **naming the months**, so the person is
told to recall those first or to use Stop. Postings that have all been taken back count as no history.
"Stopped" stays, and is still the right answer for a cost the property genuinely used to have.

**5. Both recalls follow the house pattern for a paid cost.** Recalling a `pending` bill is a
correction. Recalling one the books record as **paid** asserts the money never left the account, so it
is refused once with `expense-already-settled` and the screen turns it into a deliberate act — the
server's own sentence, an unticked box, nothing preselected. Gated on `modify_settled` throughout:
**the person who takes the money does not erase the record of it**, the same rule juniors already have
for receipts.

### The affected areas, which was the harder half

- **Re-posting.** `post-month`'s "already posted?" check now ignores voided rows, or a recalled month
  could never be posted again — which would have made the whole feature useless.
- **The self-check.** `monthly-cost-posted-twice` skips voided rows, or recall-then-repost reports the
  *remedy* as a serious fault. A new check, `void-cost-without-a-reason`, catches a void that lost its
  author or reason — the only thing standing between a taken-back cost and an unexplained hole.
- **The one place a void could still have been counted:** `ExpensesPanel`'s totals were
  `if (paid) … else pending`, which would have counted a void as pending. Now three buckets, and the
  recalled figure is stated separately as *"in no total"*.
- **The printed operating statement's expense detail** had no status filter at all — it is the list an
  accountant checks the totals against, so a line not in the total is a line that will not reconcile.
  Now `liveExpenses()`.
- **A voided expense cannot be edited** back into a live one; the PUT refuses it and says to log a new
  one instead.
- **The villa's own record keeps voided costs, marked**, exactly as it already keeps voided charges.

### The test, and why it is written the way it is

`test/taking-a-cost-back.test.mjs`, **56 checks**, phrased as Ro's rules rather than the code's
function names — the lesson of 2026-09-02, where five faults survived 1,575 tests because every test
asserted the code's own definition.

The central assertion is a **comparison of the reports to themselves**: every figure the property
looks at — operating statement, operations statement, monthly owners report, annual report, owner
statements, expense breakdown, Form 13C ageing, both currencies — captured before a run is posted and
again after it is recalled, and required to be **identical**. A figure that quietly kept a recalled
cost shows up as a difference, wherever it lives, including in a report nobody thought to check. It is
built on a baseline that is asserted to be non-empty, and on a posting that is asserted to have
actually moved the figures — otherwise the comparison would be two nothings agreeing.

**Every guard was mutation-tested** (remove the guard, confirm the suite fails):

| Mutation | Result |
| --- | --- |
| post-month no longer ignores voided rows | 4 checks fail |
| self-check no longer skips voided rows | 1 fails, naming the false "posted twice" |
| the settled confirmation gate removed | 5 fail |
| a void that leaves the row `pending` | 11 fail, led by the whole-report comparison |
| recall matches on date instead of `periodMonth` | 6 fail, including the hand-entered cost |

**And it was driven through the real UI on a scratch database**, not just the API: add a monthly cost →
post September → Remove refused, naming the month → take the month back with a reason → the row reads
"Taken back" and the tick box returns → register shows it struck through with who/when/why and
*"taken back J$42,000.00 (in no total)"* → log a paid cost → take it back → refused once, confirmed,
gone from every total.

### Still to do

- **Not released.** Needs a version bump, tag and Windows build; the HP is still on v1.9.0 and needs
  whatever ships next.
- The **service worker** will serve the old bundle after the upgrade — Ctrl+Shift+R on the Kamrui and
  phones, and confirm the version **from the console window**, never the sidebar.
- Nobody has yet put a **printed** expense register with a taken-back line on paper. Printed output on
  actual paper remains the standing untested surface.

---

## Session of 2026-09-02 — the owners' monthly report

Ro: *"Include a section for monthly report that we may be able to give our owners should they ask …
we can include a tab section within that area that gives the option for a monthly report."*

**Annual Report now has two tabs: Annual report | Monthly report.** They belong on one screen because
they obey the same rule, and that rule is the design: **identical for every owner, carrying nothing
personal.** Ro, 2026-08-16, on the annual report: *"it has to do with how the property is run, not
their unit nor their finances."* A shorter period does not relax it.

**Everything on it is generated; nothing is typed.** The annual report carries eight narrative boxes
because it argues a case to a meeting. This reports a month, so there is no wording to drift out of
step with a figure, **nothing to save, and no new collection** — which also means the `/api/db`
projection trap does not apply. A corrected receipt reaches it without anyone reopening anything.

**What is on it:** contributions received, common costs paid, the surplus a proprietor can check by
subtraction, and where the money went **by category**. Then the three facts that stop the month
reading better than it was — bills that fell due and were not settled, work on individual villas
recharged to those owners, and the arrears position.

**The arrears line is the boundary, and it is deliberately narrow: a count and a total, never a
list.** *"1 of 16 lots had contributions outstanding at the end of the month, totalling J$20,000.00.
No lot is named on this report."* The fund's health is every proprietor's business; who owes it is
not, on a document that goes to all of them.

**No payee is named either.** The itemised statement naming every contractor is the operating
statement, and that is the council's document. A circular to sixteen households is not the place.

⚠️ **Rent is not on it, in any form, and this is now asserted rather than assumed.** Ro, 2026-09-02:
*"rent should not be included as it is not apart of the report, only maintenance contributions and
the expenses, including payroll vendors utilities and all other expenses."* Rent is a landlord's
business between an owner and their tenant; the corporation's fund is owed contributions and nothing
else. The income side reads `collectedInPeriod(...).maintenance` alone — **never `.total`**, which
would sweep in rent, short-stay receipts and utility recoveries — and the arrears count is over the
Maintenance account only, so a tenant who has not paid rent can never put a lot on this document.
**A test banks rent, a booking and a utility recovery into the month and asserts that not one figure
moves**, and another leaves a month's rent unpaid and asserts no lot appears in arrears because of
it. The page and the printed document both say so in words, because a proprietor reading a report of
a property they know is let will otherwise wonder where the rent went.

Built on `operationsStatement()` rather than a new engine — it already computes contributions
received, common costs by category, the surplus, and the unpaid and recharged memos. `monthlyOwnersReport()`
composes that with the arrears count, which is **contributions only**: rent arrears are a landlord's
business between an owner and their tenant, and putting rent on a proprietors' circular would misstate
whose money the document is about.

**Defaults to last month**, because a month still running is a partial figure and a partial figure
handed to an owner is one they will be held to. Choosing the current month is allowed and says so on
the page rather than being refused.

⚠️ **The test that matters most here is the one that reads the finished page.** 31 checks in
`test/monthly-owners-report.test.mjs`, and the last five render the printed document and fail if a
proprietor's name, a villa, a payee or a personal balance has found its way onto it. This is the one
document in the application that goes to sixteen households, and a balance leaking onto it cannot be
recalled once it is in the post.

**Still to decide, and it was built without it:** no narrative. If Ro wants a covering paragraph, it
needs a stored record per month and the same discipline the annual report has — generated figures in
fixed slots, wording in named boxes, nobody typing over a number.

---

## Session of 2026-09-02 (last) — five faults real data found in an hour

All of them came from Ro opening v1.11.0 on real data. **None was found by 1,575 tests**, and the
reason is the same in every case, so it is written down at the end of this section rather than
five times over.

### 1. A nightly rate that did not reach the total

Ro: *"when i input the nightly rate, the total is not automatically calculated in the total stay
value field … if the nightly rate is populated, it should automatically reflect in the total stay
value."*

The total is derived from rate × nights, and typing a total by hand overrode it — but **the override
latched for the life of the form**. Once that field had been touched, the nightly rate never drove it
again. The silent shape, reproduced in the browser: **type a figure into the total and delete it, and
the field looks untouched but is latched** — enter a rate afterwards and nothing happens at all, with
no way out but closing the reservation and starting again.

Now: **changing the rate always recomputes the total** and releases the latch, because that is an
explicit act on the field the total is derived from. Changing the *dates* still respects a hand-typed
total — a stay agreed at a flat price keeps it when a date moves. Clearing the rate leaves the total
alone; an empty rate says "not pricing it that way", not "worth nothing".

The rule is `stayValueForRate()`, exported from `Bookings.tsx` **so a test can reach it** —
`renderToStaticMarkup` cannot type into a field or run an effect, which is exactly why the fault was
invisible. Seven checks in `components.test.mjs`.

### 2. Occupancy 100% on a property that was almost entirely empty

Ro: *"Occupancy cannot be 100% because the villas that are not on long term lease are for short term
vacation rentals. Currently, they are available not occupied."*

The dashboard counted **`unit.status`**, which is how a villa is *let*, not whether anybody is in it.
A villa offered on Airbnb counted as occupied whether or not a guest was in residence, and "Vacant
villas" counted only the ones explicitly marked vacant — so the card read **Occupancy 100%, Vacant
villas 0** while the property stood empty and available.

⚠️ **The application already disagreed with itself about this on one screenful.** `Charts` and
`BoardPack` had always used `occupiedUnitIdsOn()`, the dated version. Only the dashboard and the
management report read the status flag. No test compared the two.

Now `occupancyOn()` in `finance.ts` is the one answer: a villa is occupied when **a tenancy covers
the day, a guest is in residence that night, or the owner lives there** — the last because an
owner-occupied villa files neither a tenancy nor a booking and would otherwise read as empty.
Everything else is **available**. Villas marked `unavailable` are counted separately and **left out
of the rate's denominator**, since a villa that cannot be let is not a letting being missed. The card
now reads "N of M lettable villas occupied today" and the second card is **Available villas**, not
Vacant.

`isOccupied()` survives with a warning on it, for the question it does answer — how is this villa
let — which is what billing keys off. **Do not use it to count occupancy.**

### 3. "+11 vs August 2026" on books that begin on 1 September

A month that falls entirely before `booksBeginOn` is not a quiet month, it is a month this system has
no standing to describe — and comparing against it reports **every opening balance as growth**. The
dashboard now suppresses the comparison and says *"no comparison — the books begin 1 Sep 2026"* on
the arrears card and on the money tiles. Same class as calling rent arrears before its due date: a
figure stated about a period the records do not cover.

### 4. Any villa could take a guest reservation

Ro: *"if a villa isnt listed in its status as short term rental it should not be listed under short
term bookings. Long Term leases and owner occupied should not be listed under short term rental, this
is a huge gap."*

`assertBookableUnit` refused `unavailable` and `long-term` **and allowed everything else** — so a
guest could be booked into the villa the **proprietor lives in**, or one simply standing vacant, and
nothing objected. The villa dropdown, the availability search and the scheduler grid listed every
villa on the property.

Now **only `short-term` villas can be booked**, enforced on the server (the refusal names the status
the villa is actually in and points at the Units Register) and reflected in every list on the screen.

⚠️ **A villa that carries a reservation stays on the screen whatever its status is now.** A villa
moved to a long-term lease still has last winter's stays against it, and a record that disappears is
worse than one out of place. Editing an existing booking keeps its own villa in the dropdown, so
changing a guest's phone number cannot silently move their stay. Asserted.

⚠️ **If no villa is set to Short-term / Airbnb, there is nothing to book** — the form says so and
names the register, rather than showing an empty dropdown.

**Two simulations had to be corrected, and they were wrong, not the rule.** Two scenarios in
`scenarios.test.mjs` booked whatever villa they were handed without ever listing it for short stays.
They now set the status first, as the third booking scenario always did.

### 5. One occupancy figure became two, because they are different measures

Ro, reading the fix: *"the dashboard occupancy chart will now only use long term lease, vacancy and
unavailable status. Short term rental should have its own chart."* Agreed and built, and the reason
is worth keeping: **a long-term lease is a state and a short let is a rate.** One percentage over
both blends the two and answers neither.

**Long-term occupancy** — `residentialOccupancy()`. Leased ÷ the long-term pool, where the pool is
the villas that could be leased long-term: **short-lets, the proprietor's own home and anything off
the market are excluded from the denominator and named beside it instead.** A short-let villa is not
vacant, it is committed to the other business. Leased is counted from **tenancies covering the day**,
never from the status flag.

⚠️ **A villa marked long-term with no tenancy on file is named, not guessed at** — it counts as
waiting for a tenant, and the card says how many are in that state. The register and the dated
records disagreeing is exactly how a villa gets occupied for a month nobody ever bills.

**Short-let occupancy** — `shortLetOccupancy()`. **Ro's own rule, in his words:** *"If 4 units are
short term, and 1 is occupied from short term rental, only 25% occupied for short term rental."*
Villas taken tonight ÷ villas listed. A villa is occupied or it is not — no part-month fractions —
because the question is what can be sold tonight. **Nights sold across the current month is carried
beside it, labelled, and never folded in**: 1 of 4 villas taken is 25% while 5 of 120 nights sold is
4%, and both are true of the same property. The month travels with the night figures so they cannot
be read against the wrong one.

Half that engine existed already, written inline in `Reports.tsx` where nothing else could use it and
no test could reach it. It lives in `finance.ts` now.

### Why 1,575 tests missed all of this

**Every one of them asserted the code's own definition.** The dashboard counted `unit.status`; the
simulations counted `unit.status` through the same helper; the two agreed perfectly. **A wrong
definition is entirely self-consistent**, and internal consistency is the only thing a suite can
check unless somebody writes the meaning down. Nothing in 6,800 audited scenarios ever asked *should
a villa nobody is staying in be counted as occupied?* — because that rule lived in Ro's head, not in
a file.

The same for the rest. No suite set `booksBeginOn` near its data, so no comparison ever reached
before the books. The booking rule was asserted as "refuses long-term and unavailable" — which is
what the code did, faithfully. And the nightly-rate fault lived in a React state handler that
`react-dom/server` cannot reach at all: **the suite can render a component but cannot type into one.**

**What to do about it, and it is not "write more tests":**

1. **Write the property's rules down as sentences before asserting them.** `occupancy-truth.test.mjs`
   is phrased the way Ro phrases them — *"a villa offered on Airbnb with nobody in it is not
   occupied"* — and each check fails on the old behaviour. A test named after a function tests the
   function; a test named after the rule tests the rule.
2. **When two parts of the application answer the same question, make a test compare them.** Charts
   and the dashboard disagreed for weeks and nothing noticed.
3. **Pull rules out of handlers so they can be reached.** `stayValueForRate` exists for that reason.
4. **Real data on a real screen is still finding what 6,800 scenarios cannot.** That is not a failure
   of the suite; it is the limit of what any suite proves. Keep opening the application.

---

## Session of 2026-09-02 (latest) — the out-of-pocket shortfall report

Ro: *"Build the shortfall report since it is ready to be built. The system is up and running so
these will be updates as I am not reinputting information from scratch once more."*

Built to the design recorded in this file on 2026-09-02 and **not redesigned**. Nothing about it
requires re-entering data: the one new field is optional and absent on every existing record.

### What it is

**Operational Reports → Out-of-pocket shortfall**, the last thing on the screen, under the operating
statement, badged **INTERNAL**. It answers a question the books have never been able to: on the
villas VDS lets on its own account the maintenance contribution is funded out of the rent that villa
collects, so **a month with no tenant is a month VDS paid the contribution out of its own pocket**.
The system bills a vacant villa perfectly correctly and has never modelled any link between the two.

**It is not a strata document, and the placement is load-bearing.** The operating statement above it
is the corporation's income and expenditure; this is VDS's own trading position as a landlord. On
one page they would be read as one set of books, which is why the report carries the internal badge
on screen, on the printed page and on the Excel sheet.

**Two views off one engine**, because there are two questions: **by villa** (is this villa worth
letting?) and **by month** (how much cash did we need to find?). Both fold from the same villa-month
grain and a test asserts they agree.

**The headline is a sentence, not a column total:** *"VDS funded J$80,000.00 from its own account
across 4 vacant villa-months"* — with those months **named** underneath it, villa by villa, with
what each one cost. A figure with no list behind it is not something anybody can act on.

### The one decision that could not be guessed, and how it was answered

**How does the system know which villas are VDS's own?** There was no such field, and `unit.ownerName`
is free text — matching on a name breaks silently the day somebody types "Villaggio Del Sol Ltd."
instead of "VDS", and a dropped villa *understates* the only figure the report exists to state.

The answer put to Ro on 2026-09-02 and built: **a tick box on the villa register** — *"Let on the
corporation's own account"*, in the edit dialog under the entitlement and strata lot fields.
Explicit, survives a rename, one field.

⚠️ **Nothing is ticked on the live database, and nothing guesses.** `letOnOwnAccount` is optional and
**absent means no**, deliberately — a register written before the field existed cannot be assumed to
hold VDS's own villas, and claiming villas that are not ours would overstate the shortfall. So on
first run the report says *"No villa is marked as let on the corporation's own account"* and tells
the reader where to tick. **That is a one-off setup step Ro does by hand, and until it is done the
report is correctly empty.** It is deliberately a different message from "nothing to report".

The flag follows the `hidePropertyHealth` rule on the server: **only a genuine boolean moves it, and
an absent field leaves it alone**, so a client that does not know about it cannot clear it by
omission. Both directions are written to the audit trail.

### What the figures mean

- **Cash basis**, matching the operating statement: earnings counted when **received**, the
  contribution when **paid**, refunds subtracted on the day the money went **back out**.
- **Shortfall = maintenance paid − what the villa earned, floored at zero, per villa per month.** Never
  netted: a villa that earned more than its contribution does not subsidise one that earned
  nothing, and the total is summed from the villa-months rather than taken as the difference
  of two totals. A test asserts those two are different numbers on the seeded data, so the cheaper
  arithmetic cannot creep back in.
- **Occupied days come from tenancies and bookings, never from `unit.status`** — a status flag has no
  history and would answer every past month with today's answer.
- **The vacant-month count is over months that actually cost something**, not over every empty month.
  Found in the browser before release: the headline read "J$80,000 across 13 vacant villa-months"
  above a list of four, because eight of those months predated any payment and cost nothing. The
  sentence and the list have to describe the same months.
- **Currencies never meet.** One report per currency, and a villa taking rent in one currency while
  billed its contribution in another is **given no shortfall at all** — it is kept off the rows
  entirely and **named** in a "no shortfall computed" note, because a subtraction across two moneys
  invents a figure and half a row puts a meaningless number into a total.
- ⚠️ **Short-stay income counts towards the contribution, and this was corrected after the first
  cut.** The engine originally offset the contribution with long-term rent alone and carried booking
  receipts as a declared memo, which is how the design was written. Ro, reading it: *"when a unit is
  vacant or under short term/airbnb Villaggio still has to cover that cost"*. A villa that earned
  US$900 on Airbnb in a month its contribution was US$200 cost VDS nothing, and the first engine said
  it cost US$200 — **overstating the shortfall on exactly the villas the report exists to judge.**
  **Earnings are now rent plus short-stay receipts**, each in its own column with an `Earned` column
  between them and the contribution, because *how* a villa was let is a separate question from
  whether it paid for itself.
- **The headline counts every villa-month that cost money, not only the empty ones.** That follows
  from the above: a villa let cheaply on short stay that did not cover its contribution cost VDS
  money too, and a headline counting only wholly-empty months would leave it out of the figure it
  belongs in. It reads *"VDS funded $950.00 from its own account across 5 villa-months. 4 of them
  stood empty for the whole month, accounting for $800.00."* Each month in the list underneath is
  named as either **"empty all month"** or **"let, earned less than the contribution"**.

### Where it lives

`outOfPocketShortfall()` in `src/lib/finance.ts`; `letOnOwnAccount` on `Unit` in `src/types.ts`;
the tick box in `src/components/Units.tsx`; the screen, the Excel export and the printed document in
`src/components/ShortfallReport.tsx` (`ShortfallDocument` is exported so the printed page can be
rendered and asserted); mounted in `src/components/Reports.tsx`, which now also takes `tenancies`.
The server accepts the flag on `PUT /api/units/:id`. **No new top-level collection**, so the `/api/db`
projection trap does not apply — the flag rides on the unit record that is already returned.

### Tests — 1,503 → 1,575

**`test/shortfall-report.test.mjs`**, 72 checks: the tick box round trip (including that an unrelated
edit which omits the field does not clear it, that a string is not a tick, and that both directions
are audited), the arithmetic, occupancy from dated records, refunds landing in the month the money
left, unconfirmed money counting for nothing, the two views reconciling, the currencies staying
apart, the villa with two currencies being named rather than computed, and **the printed document
rendered and asked what it shows** — the headline, both views, the named vacant months, the internal
banner, the declared short-stay receipts and the named uncomputed villa.

**The 400-scenario reporting audit now audits this engine after every scenario**, the way
`annualOwnersReport` and `operationalHealth` are. Nothing in the simulation ticks the flag, so the
audit flags **every third villa on a copy of the register** and asserts against real tenancies,
bookings and receipts — with a guard that fails if it ever runs against an empty report. That guard
is the annual-report lesson, restated: *a green assertion that ran against nothing is not coverage.*

### Internal only — every member of staff, and nothing an owner sees

Ro, 2026-09-02: *"The shortfall is for internal uses only, it should not be reflected in any public
facing reports whatsoever, that includes owners. this is just for us as admin."* Then, when it was
first built for administrators alone: *"just for us as admin means every staff member who has an
account so ensure every role can see it, not just adminstrators. Or make it an access checkbox in
the settings."*

**So internal means internal to the office, not to one login**, and it is both: every role sees it,
and the choice lives in System Settings.

- **`viewShortfall` is a role permission, granted to every role by default** and editable in the
  System Settings permission grid like every other one. Administrators are never gated, as
  everywhere else. **Absent means granted** — a database written before the field must not read the
  missing value as a denial and take the report off the team on the next restart, which is the rule
  `recordPayments` already follows for the same reason.
- **The section is a switch, and it is closed by default.** Ro: *"make it a toggle switch as it is
  not something we need to have open permanently."* Operational Reports is a screen people leave
  open in front of whoever is at the desk. Nothing is computed while it is shut — which is also the
  cheapest state, since the engine walks every day in the period across every villa.

- **`outOfPocketShortfall` has exactly one caller in the whole application**, and it is this screen.
  No owner statement, board pack, annual report, operating statement or operations statement touches
  it, and none ever should. **A test walks every component file and fails if a second caller
  appears** — the wiring is asserted, not trusted.
- **The screen renders for every role that holds `viewShortfall`** (`maySeeShortfall()` in
  `ShortfallReport.tsx`). A role it has been withdrawn from gets nothing at all — not a stub, not an
  empty card. Asserted for all four roles, for a withdrawn permission, for an administrator (never
  gated), and for a session that predates the field.
- **The owner-statement screen is rendered from live data and searched** for this report's language.
  It says nothing about it.
- ⚠️ **This is a visibility rule, not a security boundary, and it must not be described to Ro as
  one.** It is said on the settings row itself, too, so nobody withdraws it expecting a lock. Every screen computes from `/api/db`, which any signed-in session can fetch, and the
  receipts underneath are already on the ledger. Hiding the screen keeps VDS's trading position off a
  colleague's page; it does not put it behind a lock. A real boundary needs the figures computed on
  the server behind a permission — a different piece of work, not yet asked for.
- **`letOnOwnAccount` does travel inside the `OwnerStatement` object**, because that object embeds
  the whole unit record — exactly as the owner's email, the meter number and the internal notes
  always have. **Nothing renders it.** The test asserts on what is rendered rather than on the JSON,
  because a failing assertion about a field nobody can see would say nothing about what an owner
  reads.
- **Unrelated older uses of the word "shortfall" exist and are not this.** The annual report's
  shortfall is the corporation's contributions-versus-expenditure gap; the operations statement's is
  the fund's monthly deficit. Both predate this work, both are the corporation's own figures, and
  neither has anything to do with VDS's trading position.

### A finding on the way past, not fixed

**There is no `GET` or `PUT /api/settings`.** Settings are read from `/api/db` and written with
`POST /api/settings`. Several suites carry a copied pair of lines —
`const s = (await c.get('/api/settings')).body; await c.put('/api/settings', { ...s, booksBeginOn: … })`
— which **404s in silence and configures nothing**; `operating-statement.test.mjs` is one of them, and
it is where the idiom was copied from. Those suites still pass, so nothing depended on the setting,
but a test that quietly does nothing is a test that will mislead somebody later. The shortfall suite
now uses the real endpoints. **The others were left alone deliberately** — changing a books-begin
date from "never set" to "set" could move results in suites this session did not otherwise touch, and
that is a change to make on purpose rather than in passing.

### Still to do

**Released in v1.11.0 on 2026-09-02, superseded by v1.11.1 the same day.** Drop that `.exe` in the same folder as the old one and confirm
the version from the console window, not the sidebar. **No data is re-entered** — the existing
`db.json` is untouched and simply gains a field that is absent until somebody ticks it.

**Then the one manual step, and the report is empty until it is done:** open each villa VDS lets in
the Units Register and tick **"Let on the corporation's own account"**. Nothing is ticked by default
and nothing is guessed from the owner name, so before this the report correctly says *"No villa is
marked as let on the corporation's own account"* rather than reporting zero. It is a different
message from "nothing to report", deliberately.

## Session of 2026-09-02 (later) — five thousand operations, then read the paperwork

Ro, straight after the printed-record fault: *"Test 5000 simulations of different types of payments,
modifications, possible human actions to see if they all pass, include prints, included and omitted
records that are not to be ommitted, connected and disconnected functions."*

**`test/redteam-5000.test.mjs`** — 5,000 operations through the real HTTP API, with the printed
documents rendered from live data every 250 operations and read back. Same founding rule as the
3,000-scenario red team: nothing touches the database behind the application's back, so a failure is
never "the test broke it".

What makes it different from every suite before it: **the others prove the books survive; this one
asks whether the document you hand somebody contains what the books hold.** That question could not
be asked at all until `PrintPortal` was made to render without a DOM earlier the same day.

It covers, per the brief: payments full, part, over, early, in the wrong currency, duplicated under
one idempotency key, confirmed, reversed, refunded in part, over-refunded, refunded after reversal;
modifications to rent, due days, currency (with and without acknowledgement), owner and tenant names
as corrections and as changes, move-in dates moved backwards to 2009, deposits taken, over-returned
and returned twice, charges voided and voided again, one-off charges, the books-begin date moved
underneath live data; and human actions - the same request twice, an action abandoned unconfirmed, a
month posted three times and once for 2099.

Then, on the documents: **every completed receipt and every charge the books hold must appear on the
villa's own ledger**; a villa with charges must never print "no charges have been raised";
**maintenance receipts must never appear on a tenant's record**, and where maintenance falls inside
the occupancy the record must *declare* it rather than drop it. Plus the connected/disconnected
question: no receipt, charge or tenancy may belong to a villa that does not exist, and money stranded
in another currency must be reported by `currencyMismatchWarnings` rather than sitting silent.

**223 documents rendered, no server error in 5,000 operations, no serious integrity finding, every
balance finite and to the cent, no duplicate receipt numbers.** 1,503 tests now pass.

WARNING: **It failed on its first run, and the fault was the test's.** It reported a tenant record
omitting maintenance without declaring it. The document was right: for a tenancy still running, the
record covers move-in **to today**, the same window it uses for the rent lines, and the check had run
its window out to the end of 2027 - so it counted a charge dated next month, which is not yet part of
that tenant's account and, since v1.10.2, not even owed. **Which side was wrong was established before
either was changed**, because a test bent to agree with the code is exactly how the owner-statement
fault survived 1,245 checks.

### Two test files were binary as far as git was concerned - FIXED

`test/redteam-3000.test.mjs` and `test/expert-security.test.mjs` each contained a **raw NUL byte**,
written directly into a hostile-input payload. The payloads are deliberate and worth keeping - but a
NUL makes git treat the whole file as binary, so `git show`/`git diff`/`git blame` produce
**`Bin 0 -> 18633 bytes`** and nothing else. Two of the largest test files in the project had
unreviewable history, and `grep` skipped them silently, which is how it was noticed. Both now use a
unicode escape: byte-for-byte the same string at run time, and the files are text again.

**No application code changed in this entry.** v1.10.4 was nevertheless cut at Ro's instruction, and
the reason is a good one: the release workflow runs the whole suite as a gate, so a binary published
before this suite existed had never been tested against it. v1.10.4 is the same application as
v1.10.3, proven against 1,503 checks instead of 1,489.

## Session of 2026-09-02 — a printed record that left half the money off

Ro recorded a rent payment and a maintenance payment against C11, opened the villa in the register,
pressed **Print record**, and found only the rent. *"this is a major gap that needs to be fixed."*

**Reproduced before anything was changed**, by rendering the two documents and asking what each
contained. The result:

| | rent receipt | maintenance receipt |
|---|---|---|
| **Print unit ledger** (unit detail, bottom) | shown | shown |
| **Print record** (beside a tenancy) | shown | **absent, and unmentioned** |

The button opens `TenancyRecordDocument`, which filters both charges and payments to
`category === 'Rent'`. That is **correct by design** — a tenant is not handed the proprietor's
maintenance account, and maintenance is the owner's liability, never the tenant's. The document is
even titled "Tenant Record" with a table headed "Rent account for this occupancy".

⚠️ **The fault was not the omission. It was that nothing declared it.** A document that looks like the
villa's complete record and silently drops a class of money is indistinguishable, to whoever is
reading it, from data that was never saved — and that is exactly the conclusion Ro drew. This
property's own rule was already written down for the operating statement and simply had not been
applied here: *a statement that quietly omits a class of money is not a narrower document, it is a
misleading one.*

### What changed

1. **The tenant record declares what it leaves out**, in the same shape the operating statement uses:
   *"Not included on this record: maintenance contributions for this villa — J$20,000.00 billed and
   J$20,000.00 received across 1 receipt. That is the proprietor's account, not the tenant's. It is
   recorded, and it appears on the villa's unit ledger and on the owner's statement."* It appears only
   when there is something to declare, so it never becomes noise on a document with no maintenance on
   it. A standing line under the heading also states that the record covers rent only, and why.
2. **The button is now "Print tenant record"**, not "Print record". It was one word away from being
   read correctly.
3. ⚠️ **A second, larger gap the audit found: the unit ledger listed every receipt and not one
   charge.** The villa's own record showed money coming in with nothing to reconcile it against — a
   proprietor querying a balance could be handed it and still not see what they had been billed. A
   new **"II. Charges raised"** section itemises every charge with its due date, period, category,
   who it was billed to, description and status. **Voided charges are kept and struck through with
   the reason**: they are in no balance by design, but a record that quietly drops a cancelled charge
   invites the question of what else it dropped.

### Printed documents could not be tested at all until now — that was the real hole

Every printed document in this application lives inside `PrintPortal`, which called
`document.createElement` and returned a `createPortal`. Neither works under `react-dom/server`, so
**not one printed document could be rendered by a test.** The figures feeding them were covered by
hundreds of checks; the documents themselves by none. That is why a whole class of record could go
missing from one and nothing noticed.

`PrintPortal` now holds a null host when there is no DOM and returns the same tree inline. In a
browser nothing changes — the portal is still used, still attached to `<body>`, still paginating the
same way.

**`test/printed-records.test.mjs` — 28 checks.** Every class of record the application can hold
against a villa is seeded with a unique marker, both documents are rendered, and each is asked what it
shows: rent and maintenance charges, a voided charge and its reason, rent and maintenance receipts,
utility readings, reservations, expenses and the vendor paid, logged activity and its note, occupancy
history, the owner. Plus the empty case — a villa with nothing on it must *say* nothing was recorded
rather than dropping the section — and the negative case, that the exclusion notice does not appear
when there is no maintenance to exclude.

⚠️ **A trap in the test files themselves, worth knowing.** The first version of the activity fixture
invented field names (`summary`, `occurredOn`) and the suite duly reported that the unit ledger was
dropping recorded activity. It was not — the fixture was wrong. **These files are plain `.mjs` and
nothing typechecks them**, so a fixture that does not match the interface produces a confident, wrong
answer in either direction. When a check here fails, read the type in `src/types.ts` before believing
it.

**1,489 tests pass.**

## Session of 2026-09-01 (later still) — posted is not due, and a test reading a UTC clock

### Rent was called arrears from the moment the month was posted — FIXED in v1.10.2

Ro, having set a rent due day of the 7th: *"if rent is due on the 7th, and when i click post month on
the 1st of every month it generates an alert in the notifications hub for rent due on the 7th, it
defeats the purpose and unneccessarily posts a rent thats not yet due."* He was right, and the
objection is the sharp one: **if a charge is treated as late from the day it is posted, recording a
due date at all is pointless.**

`accountBalance()` has always taken an optional as-of date and correctly ignores charges not yet due
(`.filter(c => !asOf || c.dueDate <= asOf)`). **Three screens called `delinquentAccounts()` without
it** — the notifications hub, the dashboard arrears card, and the outstanding count on the sidebar —
so every open charge counted regardless of when it fell due. The hub read *"Rent outstanding — 1
unpaid month"* about money nobody owed for another six days.

⚠️ **The reports were never wrong.** Reports, the board pack and the finance hub all pass a date, so
the arrears schedule, the ageing buckets and Form 13B were correct throughout. Nothing that left the
property misstated anything. This was a screen fault, and it is worth knowing the boundary.

**`scheduledCharges()` in `src/lib/finance.ts`** is the new engine call: open charges whose due date
has not arrived, with the amount still to find after any credit already held, the earliest due date
and the days until it. The hub shows them **grey, headed "Rent due 7 September", badged "Not yet
due"**, kept out of the open-items count and out of every money total, and sorted below everything
real. On the due day the charge becomes arrears with nothing to re-post and nothing for anyone to do.

Two judgements worth keeping:

- **The due date comes from the charge, not from the register.** A charge stores the due date it was
  raised with, so changing a villa's rent day in April does not retroactively make March early or
  late.
- **Paying early still works, and had to.** The payment screen deliberately asks for the *unrestricted*
  balance — a tenant who pays on the 1st for the 7th must have somewhere to put the money — and the
  scheduled row offers "Receive early payment" for exactly that. **"What is owed today" and "what is
  open on this account" are two different questions, and only the first drives an alert.** Do not
  "tidy" this by making them one.

The villa profile and the printed unit ledger were deliberately left showing the full open balance:
they answer the second question.

### Two refinements that came with it

- **A month can be posted from the notifications hub.** The "not yet billed" alert used to send you
  to the ledger to do the thing it was asking for; it now posts the months itself, oldest first. Safe
  to press twice — the endpoint skips a villa already billed for that month.
- **`oldestUnpaidDays` aged against the wall clock, not against the date being asked about.** It
  called `daysSince()`, so an arrears schedule run *as of* a past quarter printed a days-overdue
  column measured from this morning, **beside ageing buckets on the same page measured correctly from
  the quarter end** (`ageAccountArrears` has always used `daysSinceOn`). Two numbers on one document
  describing the same debt and disagreeing. Now `daysSinceOn(dueDate, asOf || today())`; ordinary
  screens are unchanged.

**28 checks in `test/due-dates.test.mjs`**, including the boundary in both directions (the day before,
the day itself), a charge due on the day it is posted staying due immediately, an August arrear and a
September scheduled charge not cancelling out, and the hub rendered through `react-dom/server` to
assert the row is genuinely grey and the due one genuinely amber.

### ⚠️ A test was reading a UTC clock — FIXED, and this is the second one

`test/expert-property-manager.test.mjs` failed on `main` **before any change this session**, exactly
as `corrections.test.mjs` had a few hours earlier. It dated a receipt with
`new Date().toISOString().slice(0, 10)` — the **UTC** day — while the application works in **local**
time (`toDayString`). For the last four or five hours of every Jamaican day those are different, so
the receipt was dated *tomorrow* and the server refused it: *"a payment cannot be dated in the
future."* The guard was working. The test was wrong.

It passed on the CI runner an hour before, because **CI runs in UTC, where the two never differ** —
so this class of failure cannot be caught by the release workflow. Found at 21:33 EDT; it would have
passed again after midnight.

`localToday()` now lives in `test/harness.mjs` with the explanation. **Never build a "now" date in a
test from `toISOString()`.** `test/first-and-last-rent.test.mjs` had the same call and was corrected
with it; the two remaining uses build a fixed UTC date and read it back as UTC, which is
self-consistent and was left alone.

## Session of 2026-09-01 (later) — the upgrade that worked and looked like it had not

Ro installed v1.10.0 on the HP and the screen still said v1.9.0, missing the new strata Operating
Statement. He asked for the cut and the release to be checked. **They were correct**, and that is the
whole point of this entry: the release was fine, and every way of checking it was broken.

Verified against the remote, not from memory: tag `v1.10.0` points at `7b2d21f`, `package.json` **at
that commit** reads `1.10.0`, and the build log shows `checkout refs/tags/v1.10.0` followed by
`react-example@1.10.0 lint/test/build`. The full suite passed, the `.exe` was assembled, smoke-tested
and uploaded — 95,368,704 bytes against v1.9.0's 95,311,360. Different binaries. Nothing was
mis-tagged and nothing stale was published.

### The real fault: nothing on the machine could state its own version — FIXED in v1.10.1

`__APP_VERSION__` is compiled into the **browser bundle**, and the bundle is delivered by a service
worker. So the number in the sidebar is the version of the *page*, which after an upgrade can be a
release behind the program that served it. Meanwhile `/api/health` returned `{ok, time}` and the
console window printed only "running at http://localhost:…" — **neither said what was running.**

That made two completely different situations identical on screen: the upgrade did not happen, and
the upgrade happened and this browser has not noticed. There was no third source of truth short of
comparing the byte size of the `.exe` in Explorer.

Four things now answer it:

1. **`GET /api/health` reports the version** (`server.ts`, `APP_VERSION` from `package.json`).
   Unauthenticated on purpose — the moment it is most needed is a half-finished upgrade, when nobody
   may be able to sign in to ask.
2. **The console window prints the version on start-up, and the records folder with it.** The second
   line matters as much as the first: `DATA_DIR` is the **working directory** (`server/db.ts:75`), not
   the folder the executable sits in, so a copy started from the wrong place opens a different — or
   empty — set of books, and nothing used to say which set was open.
3. **The screen shows both numbers** when they differ (`src/components/VersionCheck.tsx`), so the
   footer reads `v1.9.0 · server v1.10.1` rather than quietly reporting the cached one.
4. **A banner appears on a genuine mismatch**, on the sign-in screen and inside the app, saying which
   version the program is and telling the reader to press Ctrl+Shift+R. Worded as an instruction, not
   a diagnosis.

⚠️ **Not knowing is deliberately not a mismatch.** `versionMismatch()` in `src/lib/version.ts` returns
false when the server is unreachable or too old to report a version. A warning that fires on "no
answer" is one people learn to dismiss, and it would then be dismissed on the day it was right.

The health request is made **once per page load** and shared. Both the footer and the banner use the
same hook and both are rendered twice per screen, which fired four identical requests before anybody
had typed a password; a running program's version cannot change underneath it, so the one answer is
kept for the life of the page.

**15 checks in `test/version.test.mjs`** — the endpoint's value against `package.json`, the liveness
contract the reconnect logic depends on left intact, the mismatch rule in all four states, and the
banner rendered through `react-dom/server` asserting it names both versions and says what to do.
1,433 tests now pass. Verified in a real browser as well: the sign-in screen reads v1.10.1 and exactly
one `/api/health` request is made per load. **The banner itself has been asserted through server-side
rendering but has not yet been seen in a live browser** — there is no way to produce a genuine
mismatch against a dev server that serves both halves.

⚠️ **This is why the handover's own upgrade instruction has changed.** "Confirm the sidebar reads
v1.10.0" was advice that could lie. The check is now: **open the black console window and read the
version line**, or visit `/api/health`. The sidebar is a second opinion, not the answer.

## Session of 2026-09-01 — cutover day, and what real money broke

The HP was confirmed on v1.9.0 with plan number **2324** and books-begin **2026-09-01** already set, so
the whole upgrade path from the last session is closed. Tenancy entry with real start dates is in and
behaving; billing correctly raises only the tenancies whose rent day has come and holds the rest at
"Not yet billed". **Then the first real maintenance receipt went in and found a fault that 1,245 tests
had not.** That is now three times running that real data has found what the suite could not.

### The owner statement never subtracted maintenance the owner had paid — FIXED

A proprietor who had paid his J$20,000 contribution in full was shown, **on screen and on the printed
statement**, "Due from Fr. Howard James — J$20,000.00", directly beside a line confirming the money had
been received. The statement contradicted itself on the one figure an owner acts on, and the failure
mode is an owner paying twice.

`ownerStatement()` computed `net = collected − maintenanceBilled − utilityBilled − expenses`, and
`maintenancePaid` was **deliberately** excluded — there was a comment arguing the owner is liable for
what was *billed* whether or not they have paid. That reasoning is a leftover from the **old, wrong
business model** where the agent collected the rent and withheld maintenance out of it. Under the real
arrangement the corporation collects nothing for a proprietor, so `collected` is always nil and the net
sat at minus the entire contribution however much the owner paid.

**The deduction is now the contribution still outstanding, `maintenanceBilled − maintenancePaid`.**
Nothing is netted across currencies — both terms are already scoped to the statement's currency.

⚠️ **The old suite asserted the bug.** `test/owner-statements.test.mjs` expected `net === -12000` for a
villa whose owner had paid the whole 12,000, and the 400-scenario reporting-integrity check re-derived
the same wrong identity. Both were written to match the code rather than the business, which is exactly
how this survived 1,245 tests. Both now assert the corrected arithmetic and there is an explicit test
that a contribution billed and paid in the same period nets to nothing owed.

Wording followed the arithmetic: a nil position reads **"Settled in full"** rather than "Due to <name>
J$0.00", the printed tile reads "Settled in full" instead of "Balance owing J$0.00", and the screen and
print explanations no longer say contributions are deducted "as billed, whether or not they have been
paid" — they say what the page now actually does.

**One modelling assumption is written down here deliberately:** recording a Maintenance receipt is taken
to mean the owner paid it. There is no "withheld from rent" mechanism anywhere in the software — no
field, no path — so on a villa the corporation lets on its own account, a maintenance receipt funded out
of rent it already holds would be counted twice. That cannot happen with the data entry that exists
today. **If a withholding mechanism is ever built, this arithmetic must be revisited first.**

### The Collected column is gone entirely — DONE

It began as "take Bookings and the currency off that cell", and ended with the column removed, because
the column itself was the error. **"Collected" meant rent or guest income taken in on the owner's
behalf, and the corporation does not do that for any proprietor** — Ro confirmed it flatly on
2026-09-01: *"we do not collect rent on any owner's behalf."* Every owner lets their own villa. So the
column was permanently J$0.00, and sitting next to a contribution the owner *had* just paid it read as
though the payment had been missed. That is precisely the question it was asked.

Removed from the summary table, the printed statement (the whole "Collected on your behalf" section),
the emailed draft and the CSV export. The "Less:" headings went with it — nothing is being deducted
from a remittance, so the printed sections are now plainly "Maintenance contribution billed",
"Utilities billed to your villa" and "Charged to your villa". The header tile no longer speaks of a
"net position" at all: it is a balance, and a settled owner reads **"Settled in full"** rather than
"Balance owing J$0.00". The screen's own blurb no longer claims rent is "collected on their behalf".

⚠️ **The underlying fields — `collected`, `rentCollected`, `bookingCollected`, `refunded` — are still
computed in `ownerStatement()` and are still correct.** Only the proprietor-facing presentation drops
them. If a villa the corporation genuinely lets on its own account ever needs a remittance document,
the arithmetic is there; do not rebuild it, and do not put it back on a proprietor's statement.

### A test was reading a stopped clock — FIXED

`corrections.test.mjs` failed on `main` **before any change this session**, so the previous entry's
"1,245 tests pass, no outstanding bug" was already untrue by the time it was read. The application was
right and the test was wrong: a move-out spends the advance on `monthOf(endedOn)`, and `endedOn` is
today, but the test hardcoded `'2026-08'` as "the following month". It passed every day of August 2026
and failed on 1 September. It now computes the month it is actually running in. **Look for this shape
whenever a suite starts failing on the first of a month.**

**1,247 tests now pass, typecheck and build clean.**

### Still open from this session — NOT diagnosed, do not guess

~~**A US$800 cash payment reads as a credit, and "Billed to date" reads 0.**~~ **DIAGNOSED AND FIXED
the same day** — Ro confirmed he had moved villa C11's maintenance to USD after the JMD charges were
already raised, because the owner asked for it. See *The currency trap* above. The original two
candidate causes are kept below because the reasoning is worth having:

1. **A currency split.** `accountBalance()` scopes both sides to `chargeCurrency(unit, category)` —
   charges in any other currency are not counted, so `charged` reads 0 while a matching-currency
   payment reads as a credit. `mismatchedCurrencyPayments` surfaces a payment in the wrong currency but
   **there is no equivalent for a charge in the wrong currency**, so this state is silent. That gap is
   real regardless of what caused this particular case.
2. **Nothing has been billed yet.** If that tenancy's rent day has not come round, no charge exists, so
   an advance payment genuinely is a credit and "Billed to date 0" is arithmetically right — just badly
   worded for someone who knows the money was owed.

**Which one it is has not been established, and the Mac's `db.json` holds no live records — the data is
on the HP.** Ask which villa it was and whether a charge appears on that tenant's ledger before writing
any fix.

### The currency trap: money stranded where no balance counts it — FIXED, and guarded

**This is the fault behind the US$800 that read as a credit, and it was the most dangerous thing
found this session**, because it understates what a villa owes rather than mislaying a receipt.

Ro moved villa C11's maintenance to USD **after** JMD contributions had already been raised against
it, because the owner asked for it. Entirely legitimate, one dropdown on the register. But a balance
is computed per unit, per category, **per currency**, and the two are never combined — so every
charge already open in JMD stopped counting the moment the villa became a USD account. "Billed to
date" read nil, and the US$800 that *did* match then showed as a **credit** on a villa that actually
owed money. Nothing warned anybody: `accountBalance` surfaced a *payment* in the wrong currency and
had no equivalent for a *charge* in the wrong currency.

Four things now close it, at four different depths:

1. **`accountBalance` reports it.** New `mismatchedCurrencyCharges`, the mirror of the payments
   field, and `currencyMismatchWarnings` reports both directions. Surfaced on the ledger screen with
   the amounts named and what to do about it.
2. **The self-check catches it on the live machine.** New `charge-in-unbilled-currency` (**serious** —
   money is misstated) and `payment-in-unbilled-currency` (warning). The integrity checker had no
   currency checks at all before this. Voided charges are deliberately not reported: they are in no
   balance by design, and noise trains people to ignore the check.
3. **The server refuses the edit.** Re-denominating a villa with charges open in the old currency is
   refused with `unit-currency-change-not-confirmed`, naming the count and the consequence. On
   confirmation the stranded charges are **voided, never converted** — J$20,000 is not US$20,000 and
   no rate this application holds is good enough to restate somebody's debt — with the reason stored
   and the audit trail keeping them.
4. **The register asks before it happens.** The edit screen lists the affected charges with their
   amounts and due dates, and will not save until the consequence is ticked. ⚠️ It previously carried
   a note saying charges already posted "keep the currency they were raised in" — true, and exactly
   the problem, stated as though it were fine. That note is gone.

**Afterwards: re-post the month, or raise the balance again in the new currency.** Nothing restates
it for you, by design.

### The 3000-scenario red team — `test/redteam-3000.test.mjs`

Commissioned by Ro on 2026-09-01 before rebuilding the database. **Its rule is what makes it worth
having: nothing in it touches the database behind the application's back.** Every action goes through
the same HTTP API the screens use. So when the books end up contradicting themselves it is never "the
test broke it" — it means a sequence of legitimate operations was allowed to leave the records in a
state the application itself calls serious, and **the fix belongs at the point of entry as a guard.**

It found the currency trap on scenario 25 of 3000, from ordinary API calls alone, before Ro's own
account of what he had done to C11 arrived. Attack classes it carries that the older suites do not:
re-denomination mid-life, the books-begin date moved after entry, rent due days of 29/30/31 across
February in an ordinary and a leap year, months posted twice and out of order and from three machines
at once, refunds larger than the receipt, refunds of voided receipts, charges voided after payment,
deposits returned twice or over-returned, one-off charges dated outside the books, tenant churn
inside one month, sub-cent and 1e999 amounts, and a year boundary so the receipt counter rolls.

The whole run takes about 2m30s and it is wired into `npm test`. **If it ever fails, read the seed it
names and reproduce it before changing anything.**

⚠️ **One hypothesis it could not have caught was checked by hand and disproved:** `tenancy.currency`
is a snapshot taken at move-in and eviction write-off filters open charges by it, which looked like a
stranding waiting to happen. It is not — the tenancy currency is updated when the villa is
re-denominated (`current.currency = unit.currency`), and a probe confirmed eviction wrote off the new
USD charge correctly. Recorded here so nobody re-opens it.

### Three thousand more, from three expert seats (2026-09-01)

Ro asked whether the software is high performing, judged as a property manager, a software architect
and a security reviewer would judge it, with a thousand simulations each. Three suites now do that,
all wired into `npm test`.

**`test/expert-property-manager.test.mjs` — 1000 operating events across a full year, 21 checks.**
Judges what a manager is answerable for rather than whether the arithmetic closes: nobody billed
twice, nothing billed before the books open, the arrears schedule matching the ledger to the cent in
*both* directions, Form 13B agreeing with the ledger villa by villa, deposits never lost, every
receipt attributable, occupancy inside the register, evictions recording what was written off.

⚠️ **Two of its own assertions were caught passing vacuously and were rewritten** — worth knowing,
because the same trap is easy to fall into again. "No settled account is reported as in arrears"
passed over an *empty set*: after a year of billing every month, no account happens to sit at exactly
zero. It now pays one off deliberately and reads the answer back. And the first attempt to do that
dated the receipt 31 December, which the application refused — *"a payment cannot be dated in the
future"*, the guard working correctly. That refusal is now its own assertion.

**`test/expert-architect.test.mjs` — 1000 requests, 17 checks, with measured numbers.** No request may
return 5xx (a 4xx is design, a 5xx is a defect); concurrent writes serialise with no lost updates;
idempotency holds under six retries; the server is killed and restarted mid-life and everything
acknowledged survives; a backup carries the whole ledger. **Measured on this hardware: full database
read p95 6ms, writes p95 16ms, integrity check p95 2ms, store 728KB for 328 ledger rows.** Also
confirms a `__proto__` payload does not pollute the prototype.

**`test/expert-security.test.mjs` — 1000 hostile requests, 22 checks.** The threat model is the real
one: an insider, or a laptop left signed in. Every route cold (all 401), forged and tampered cookies,
each staff role attempting escalation, sign-out and password-reset session revocation, brute-force
throttling and its audit entry, hostile text stored as text, and a scan of every response for password
hashes, salts, session tokens, stack traces and internal paths.

⚠️ **One security assertion was passing for the wrong reason and is now correct.** The escalation probe
posted an empty body to the password-reset endpoint, which is refused on *validation* before the
permission check ever runs — so it proved nothing about authorisation while being counted as coverage.
It now sends a well-formed request, so only the permission gate can refuse it. A second one measured
the suite's own interference: the cookie-flag check ran after the brute-force section had locked the
sign-in throttle, so there was no cookie to inspect and it reported the header as missing.

### Every export is now a real Excel workbook, not a CSV (2026-09-01)

Ro: *"The excel csv printouts tended to be unformatted and unprofessional, they need to be polished and
professional so we are able to print and give to accountants and owners."* He was right, and no amount
of care with the CSV would have fixed it — **CSV carries no column widths, no bold, no number formats,
no page setup.** An accountant opened one to `20000` in a narrow column beside a raw `2026-08-01`, and
printing it produced pages with no headings on them.

**`src/lib/xlsx.ts` writes genuine `.xlsx` files with no dependency added.** An xlsx is a ZIP of XML
parts, and the entries are written **stored (uncompressed)** on purpose — that removes any need for a
deflate implementation in the browser, and Excel reads stored entries happily. This matters because the
application ships as a single Windows executable and every dependency is another thing that has to
survive that.

What the documents now carry:

- **money as real numbers with a currency format** (`"J$"#,##0.00`, negatives red and parenthesised),
  so a column can be selected and re-totalled by whoever receives it. **JMD and USD use different
  formats**, so no column ever implies the two can be added;
- **dates as real dates**, so they sort and filter;
- bold white-on-slate headers, **frozen on screen and repeated at the top of every printed page**;
- column widths, so nothing arrives as `####`;
- page setup — landscape where it is needed, fit to one page wide, "Page 1 of 3" in the footer;
- and a masthead on every sheet naming the property, the strata plan, the document and the period,
  because these get printed and separated from each other.

**All five exports were converted** and no CSV remains: the operating statement (Reports, now five
sheets), proprietor statements, the monthly operations statement, the annual report (four sheets,
carrying the written sections so a committee never retypes them) and the financial projection.

Verified three ways: 33 checks in `test/xlsx-export.test.mjs` that open the archive and read the XML
the way Excel does; opened with `openpyxl` outside the suite; and **driven end to end in a real
browser** — the workbook the application actually produced was captured from the download, decoded and
inspected.

⚠️ **Two things to know before editing it.** Worksheet child elements must appear in schema order
(`sheetPr, dimension, sheetViews, sheetFormatPr, cols, sheetData, mergeCells, pageMargins, pageSetup,
headerFooter`) — get it wrong and **Excel simply refuses to open the file with no explanation of why**;
there is a test asserting the order. And the header row is *found* rather than assumed when freezing
and repeating it, because sheets with a section band above their headers sit a row lower than those
without — a fixed constant froze a data row on three of the annual report's four sheets.

### The Operating Statement for the strata corporation (2026-09-01)

Ro asked for the document that gets carried into a council meeting: **income and expenditure, and
nothing else.** The management report above it answers different questions — receivables ageing,
collection rates, occupancy — and all of that is in the way when a council is being asked to approve
a set of figures. `operatingStatement()` in `src/lib/finance.ts`, screen and printable document in
`src/components/OperatingStatement.tsx`, at the foot of **Operational Reports**.

Three requirements, all stated by Ro and all load-bearing:

1. **Every expense is itemised with the payee named under its category.** His example, quoted because
   it is the clearest statement of the rule: *"If Darryl Whyte is 20000, he should not be grouped with
   Payroll, it should be classed at Payroll but the person's name should be there."* So the statement
   reads `Payroll — J$54,500` as a heading, and under it `Darryl Whyte  Grounds — July  J$20,000`,
   `Darryl Whyte  Grounds — August  J$20,000`, `Marcia Simpson  Housekeeping  J$14,500`. **A category
   never appears as a bare lump**; there is a test asserting every line carries a payee and that each
   category total is the sum of its own named lines.
2. **The currencies are separated.** One statement per currency, computed independently, no combined
   total anywhere on the page or in the workbook.
3. **The period is chosen**: this month, last month, last 3, 6 or 12 months, year to date, or
   "Choose months" — two month pickers, inclusive. Set both to the same month for a single month.
   **Whole months only, deliberately**: a statement running from the 14th to the 13th is not something
   anybody presents to a council. It holds its own period rather than inheriting the management
   report's, because the two documents have different audiences.

Expenditure includes work recharged to a villa — it is money that left the corporation's account —
with the allocation named on the line (`General`, `Office`, or the villa), so the recovery on the
income side can be matched against it. Cash basis both sides, so the surplus reconciles to the bank.
A refund appears as **its own negative line** saying who it went back to and why, rather than quietly
shrinking the receipt it came from.

27 checks in `test/operating-statement.test.mjs`, including Ro's Darryl Whyte case by name, and the
whole thing driven end to end in a browser against seeded data.

⚠️ **A bug worth remembering, because it was mine and it was invisible.** The table originally chose
its fourth column with `reference ?? allocation`, duck-typing the two sides of the ledger. An expense's
reference is usually the *empty string*, and `??` only falls through on null — so every common cost
displayed its allocation as "—" instead of "General". The components now take explicit `who` / `what`
/ `extra` fields from the caller instead of guessing which shape they were handed.

### Choosing what goes on the Operating Statement (2026-09-01)

The same period is two legitimately different documents, and Ro said so plainly: *"typically the
maintenance should not be itemized to send to strata corporation but internally we would like to see
it. Short term rental is not supposed to be included but internally yes."*

Each class of income and expenditure can now be **Itemised**, shown as a **Total only**, or **Left
out**, with two presets:

- **For the strata corporation** (the default) — maintenance contributions as one figure rather than
  naming every proprietor on a document that circulates to the council, and short-stay rental left off.
- **Internal — everything** — every class itemised.

"Choose line by line" opens a three-way control per class. The expenditure classes are read from the
data, so a category that did not exist when this was written still appears.

**The selection lives in the engine, not the view.** `operatingStatement()` takes an
`OperatingStatementOptions` and returns each group with an `itemised` flag — so a class shown as a
total keeps its exact figure and the statement total never changes, and an excluded class genuinely
leaves the totals rather than being hidden while still counted. Anything not named falls back to
`itemised`, so a caller passing nothing gets the whole statement and a new class never vanishes
silently.

⚠️ **Exclusions are declared on the page, and this is not decoration.** A statement that quietly omits
a class of income is not a narrower document, it is a misleading one — anybody reconciling it against
the bank would find money they could not place. Every excluded class is named with its amount on
screen, in print and in the workbook: *"Not included in this statement: Short-stay bookings $950.00."*
For the same reason, an empty side no longer says "Nothing recorded in this period" when money *was*
received and merely left off — it says so.

### Known limits, none of them defects (2026-09-01)

Stated so nobody has to rediscover them, and so "everything passes" is not mistaken for "there is
nothing to know":

- **The audit trail is trimmed oldest-first at 20,000 entries with no archive** (`server/db.ts:820`;
  `addAudit` unshifts, so the trim drops the *beginning* of the record). At a few thousand entries a
  year that ceiling is several years out, but the loss would be silent. The self-check now raises
  **`audit-trail-near-capacity`** at 90% so it cannot be. **Archiving is still a decision nobody has
  made** — nothing rotates the trail anywhere.
- **The LAN is plain HTTP.** Kamrui → HP is unencrypted by design (the cookie is `Secure` only over
  real TLS, or with `VDS_FORCE_SECURE_COOKIE`), so anyone on the property network could read a
  session. Remote access over Tailscale is encrypted. Acceptable for a private LAN; worth knowing.
- **The whole database is sent to the browser on every load.** Correct and fast at sixteen villas —
  6ms — and the wrong shape at several hundred.
- **One machine, one JSON file, no redundancy.** Backup and restore is the entire recovery story.
- **No two-factor authentication**, and no rate limiting on endpoints other than sign-in.
- The untested surface listed above (the `.exe` outside CI, PWA and service worker, offline queue
  under real network loss, live Airbnb feed, two-PC dry run, real print output) is unchanged — **no
  simulation can close any of it.**

### The owners' monthly operations report — BUILT AND TESTED

Ro asked for a monthly report to owners setting operating costs against maintenance collected, itemised
line by line. Decisions taken with Ro on 2026-09-01: **common costs only** (fuel, grounds staff, pool
chemicals — not personal villa work, which is recharged to that owner); **one identical communal
statement** for all sixteen, not sixteen personalised ones; and costs on a **cash basis — paid in the
month, with bills raised but unsettled shown as a memo below**, so the surplus reconciles to the bank
while a large unpaid bill cannot hide.

`operationsStatement()` in `src/lib/finance.ts` is the engine; `src/components/OperationsStatement.tsx`
is the screen and the printable document, at the foot of **Operational Reports**. 19 checks in
`test/operations-statement.test.mjs`, and it has been driven end to end in a browser against seeded
data: contributions received, costs itemised by category with supplier and description, surplus,
unpaid memo and excluded total all correct on screen and in print.

A common cost is defined strictly: **no `unitId`, and an allocation that is blank or a
`PROPERTY_LOCATION`.** Anything else falls to a `villaRecharged` memo that is counted and shown, so
the statement always reconciles to the expense register — a cost miscategorised against a villa
appears as a visible exclusion instead of vanishing from both sides. There is a test asserting exactly
that: every paid cost in the period is either on the statement or declared as excluded.

⚠️ **Two things to tell whoever keys the costs.** Fuel, grounds staff and pool chemicals must be
recorded against **General** (or Office) rather than a villa, or the statement will not see them —
they will land in the excluded total instead, which is at least visible. And **there is no `Fuel`
category**: it goes in `Supplies` or `Other`.

---

**There is no known outstanding bug.** Everything found on 2026-08-21 and 2026-09-01 — including the
US$800 that read as a credit — was fixed the same day and carries a regression test. What is genuinely open is *untested surface*, the Excel migration, and
two questions sitting with management — all under *Where to pick up*. Do not go hunting for a bug
list; there isn't one.

**The system is live.** The HP was last confirmed on **v1.9.0** (Ro, 2026-09-01) and **has not been
confirmed on any later build** — five releases went out on 1–2 September and the upgrade has not been
reported back. Do not assume it is current: read the version off the console window, or
`/api/health`. Tailscale is installed and remote access from a phone is confirmed.

### Migration from Excel — planned, partially enabled (2026-08-16)

Ro is migrating from Excel with a cutover of **1 September**. This is the next real piece of work
and the enabling parts are built:

- **Tenants owe nothing at cutover.** Nothing to carry across for them.
- **Owners DO owe maintenance.** Ro keys these in by hand.
- **Deposits are held for some tenants** and must be recorded on the tenancy so they are not lost.

Three things exist to make this safe:

1. **"The books begin on"** — System Settings → General. Set it to `2026-09-01`.
   It does two separate jobs, and the second one was added on 2026-08-21 after the first real data
   went in:
   - `unbilledOccupancy` stops reporting *every month back to a years-old start date* as unbilled —
     hundreds of false alerts that would bury the real ones. It does **not** hide a month after the
     cutover that was genuinely missed; that is tested.
   - **`raiseFirstAndLastRent` refuses to bill a move-in month that falls before it.** A tenant of
     several years settled their first and last month with whatever kept the records before this
     system did.
2. **`Opening balance`** one-off charge type — for keying each owner's carried-over arrears.
3. **`Insurance share`** one-off charge type — for the annual apportionment, adjustable per villa.

⚠️ **A previous version of this file said "enter tenancies with real start dates — that is now
safe." That sentence was written as an assumption, was never tested, and was false.** It considered
only the unbilled-occupancy alerts and not `raiseFirstAndLastRent`, which billed a long-standing
tenant two months of rent dated years before the books open. Found on Ro's real migration data on
2026-08-21, not by any of the 1,087 tests then passing — each feature was doing exactly what it had
been built to do and nothing had ever asked what happens when they meet. **Fixed in v1.8.4. Do not
write a claim like that into this file again without a test behind it.**

**Tell whoever does the data entry:** date an opening balance to **when the debt actually fell
due**, not to 1 September. The balance is the same either way; the *ageing* is only right if the
date is, and the Form 13B return depends on that ageing.

No bulk-entry screen was built. "Bill a one-off" in the HOA & Tenants Ledger already takes villa,
account, type, amount, currency, **editable due date** and description — which is the manual
feature Ro asked for. A bulk apportionment tool was offered and not taken up.

### Owner statements — rebuilt on the correct business model (2026-08-16)

**This section previously described the wrong business model. It has been corrected — read this
before touching anything on this screen.**

The old note said rent and booking income "belong to the individual proprietor — the agent only
collects it for them". **That is not the arrangement.** Ro confirmed on 2026-08-16:

- **Proprietors let their own villas entirely on their own account.** The corporation never
  collects their rent, never sees it, and it does not pass through this system.
- **The corporation collects exactly two things from a proprietor:** the maintenance contribution,
  and their share of the annual insurance premium.
- **Utilities are the owner's own.** Each villa's supply is metered in the owner's own name and
  settled directly with the utility. Utilities never appear on a proprietor's statement.
- **Work done for an owner is recharged**, so the "Charged to your villa" section stays.
- The rent / tenancy / short-term booking machinery exists for the villas **VDS lets on its own
  account**. It is real and stays.

So for an ordinary proprietor the statement is an **account of what they owe**, not a remittance of
what was gathered for them:

    contributions billed − payments received = balance owing

The remittance columns ("Collected on your behalf") still exist and are still correct, but they
**render only when money was actually held** — so a proprietor's statement is never opened by a
line reading "nothing collected in the period" about rent nobody was collecting. Same conditional
governs the utilities section.

Still true from the original design, and still load-bearing:

- Maintenance is deducted **as billed**, not as paid, so `maintenancePaid` is stated out loud
  underneath. An owner who paid directly *and* had it withheld would otherwise be charged twice.
- Per villa **per currency, never across**.
- Grouped by **owner** for issuing (`groupStatementsByOwner()`) — an owner of two villas gets one
  document.

**One supply is billed once.** A metered villa produces two records for the same electricity: the
supplier invoice the corporation pays, and the reading it bills the occupant from. Utility-category
expenses are therefore **excluded** from what is recharged to an owner (`ownerStatement` filters
`e.category !== 'Utilities'`). Removing that filter double-bills, and three tests plus a
400-scenario invariant will catch you.

## How to run and test

```bash
cd "/Users/rogeanedwards/Desktop/River Oaks/Villaggio Del Sol/Website/New_vildelsol/pm-app"
```

- `npm test` — build + full suite (**1,655 checks, 6m25s measured on 2026-09-03**). Each test file boots its
  own server on a **temp data dir**, so tests never touch the real `db.json`. The runtime is mostly
  `redteam-3000` (~2m30s) and the three expert suites; that is the cost of the coverage and it is
  worth paying.
- **`test/redteam-3000.test.mjs` is the one to read first if you are changing anything that writes.**
  3,000 scenarios, and its rule is what makes it useful: **it never touches the database behind the
  application's back**, so a failure means legitimate operations were allowed to break the books and
  the fix belongs at the point of entry. It names a seed that reproduces the failure exactly.
- **`test/corrections.test.mjs` is the one to read first if you are touching tenancies, ownership or
  charge creation.** 158 checks on mistakes and their correction, and its header explains the real
  failure it was written after. Run it alone with:
  `node -e "import('./test/corrections.test.mjs').then(async m => { const r = await m.default({ port: 3941, projectRoot: process.cwd() }); console.log(r.pass + ' passed, ' + r.fail + ' failed'); r.failures.forEach(f => console.log('  - ' + f)); })"`
  (swap the filename to run any other suite alone — do this rather than waiting six minutes for the
  whole thing while iterating.)
- `npm run test:run` — tests only, skip the build.
- `npm run build` — client + `dist/server.cjs`.
- `npm run build:exe-prep` — everything needed for the single-file `.exe` (the `.exe` itself can
  only be assembled on Windows; CI does it).

**To preview with realistic data**, there is a seed script in the session scratchpad that boots the
production server on an isolated temp dir and populates units, charges, payments, bookings,
utilities and expenses. It's disposable — rewrite it if it's gone. Never point a preview at the
real `db.json`.

**Checking the live records:** `npm test` proves the code; it says nothing about the file on the HP.
For that, start the server and read the line it prints at start-up, or open **System Settings →
Backup & recovery → Check now**. `GET /api/integrity` returns the same report to any signed-in user.

**Verifying in the browser:** the app is a PWA with a service worker. After a rebuild the browser
will serve the **stale cached bundle** — unregister the service worker and clear caches, or you
will spend twenty minutes debugging a fix that already works.

---

## Releasing

Push a tag; GitHub Actions builds the `.exe` on a real Windows runner and publishes it.

```bash
git tag -a v1.9.1 -m "…" && git push origin v1.9.1
```

The workflow (`.github/workflows/build-exe.yml`) gates the release on: full test suite → assemble
`.exe` → **start it and serve a real request** → **verify it created its Desktop shortcut**. Nothing
publishes unless all of that passes on Windows. It has caught two genuine bugs already; if it fails,
believe it.

Watch it with `gh run watch <id> --exit-status`.

---

## Things learned the hard way

- **Two features can each be correct and still be wrong together.** The 2026-08-21 migration bug was
  exactly this: `raiseFirstAndLastRent` correctly billed a new tenant, `booksBeginOn` correctly
  silenced unbilled-month alerts, and 1,087 tests passed while the application invented two months
  of debt. **When a setting is added for a specific situation, enumerate every code path that
  situation touches** — do not assume the setting's own tests cover it. And never write "this is now
  safe" into this file without a test behind it; that sentence was here, and it was false.
- **Where the machine cannot infer intent, ask — do not guess.** Three edits look identical over the
  wire and mean opposite things: a tenant name replaced (correction vs. changeover), an owner name
  replaced (correction vs. sale), a tenant taken off a villa (mistake vs. moved out). All three now
  refuse once with a `code` and let the screen offer a choice, the same shape as
  `account-already-settled` and `currency-change-not-confirmed`. **Never preselect a default where
  the two answers do different things to money.** Deriving the answer from the data was tried for
  the tenant case and broke genuine changeovers across 400 scenarios.
- **If a fix breaks existing tests, the tests are the more likely authority.** Investigate before
  updating them. Two suites caught a reverted-fix regression that reading the code had not.
- **Watch for tests that start passing for the wrong reason.** Adding a refusal upstream of an
  existing assertion can satisfy it without exercising what it was written for — one in
  `input-hardening` did exactly that on 2026-08-21.
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
- **`bad()` now returns `never`** and is a function declaration, so it *does* narrow types — code
  after a `bad()` call is understood to be unreachable. It was an arrow function returning `void`,
  which meant a value it had just rejected still looked possibly-null to everything downstream. If
  you add another refusal helper, declare it the same way or you lose the narrowing.
- **Verify by driving the real UI**, not by calling `fetch` in the console — raw `fetch` bypasses
  `src/lib/api.ts` entirely and therefore bypasses the offline queue. I made that mistake once.
- **Voiding and refunding are opposites, and the codebase now says so.** Void = it never happened.
  Refund = it happened and the money went back. A receipt can be one or the other, never both.
- **Editing a settled receipt rebuilds it with `{...original}`.** That spread carries
  `refundedAmount` and the bank-match fields forward silently, so any new field on `Payment` has to
  be considered there or it will survive an edit that invalidates it. Two live bugs came from
  exactly this — see *Robustness audit* below.
- **A refund nets off by `refundedOn`, not by the payment date.** `netPaidAsOf`/`refundedAsOf` in
  `finance.ts` are the only place that arithmetic lives — never read `refundedAmount` directly, or a
  month that has already been reported on will quietly restate itself.
- **The settled-account guard bites in tests too.** A second payment against an account that already
  owes nothing is refused (correctly). When a test needs another receipt, bill something first or
  use an account that is genuinely in arrears — do not reach for the override.
- **Nothing binary goes in `db.json`** if a feature ever needs files again. It is parsed whole into
  memory, `structuredClone`d on every write and copied on every backup.

---

## Built so far (all tested; everything here is committed and on the remote, released as v1.10.4)

**Money handling**
- **Proprietor statements** — per villa, per currency, grouped by owner; itemised printable
  document, Excel export. See *Owner statements* above for the rules it applies.
- Two-step payments: **"Receive payment"** (money in hand → receipt issued, alert clears) vs
  **"Record payment"** (expected → *awaiting funds*, counts for nothing until confirmed).
- **First and last month's rent** on move-in; the final month is not charged again, so a tenancy of
  N months is charged exactly N months.
- **One-off charges** — late fee, repair recharge, fine, amenity fee, legal costs, special
  assessment, **insurance share**, **opening balance** — billed onto the tenant's rent or the
  owner's maintenance account, with an **editable due date**. The last two were added for the
  2026-09 migration: date an opening balance to when the debt fell due, not to the cutover, or the
  ageing on the Form 13B return will be wrong.
- **Security deposits** — held on the tenancy, refundable, reconciled at move-out. Raises no
  charge, records no payment, moves no balance. Withholding requires a reason and is veto-gated.
- **Guest damage deposits** — the same instrument on a short stay, and **entirely optional**. See
  *Guest damage deposits* above; do not let it become required.
- **Monthly costs** — templates for what recurs (payroll, electricity, water, security), posted a
  month at a time through a review table. Everything posts *pending*, never paid. See *Recurring
  expenses* above.
- **Double-recorded payments are refused** at the moment of the write, with a deliberate override.
  See *Double-recorded payments* above, including the trap that hid the override in the UI.
- **Refunds** — money genuinely handed back, recorded on the receipt it came out of and netted off
  from the day it left. Not a void, and not an expense. See *Refunds* above.
- **Bank reconciliation** — tick each receipt against the statement; what stays unticked is what the
  ledger claims and the bank does not show. A tick, never an import. See above.
- Utility settling and booking deposits are *expected* until confirmed.

**Operations**
- **Ownership history** (`Ownership`, 2026-08-21) — append-only periods per villa, mirroring
  `Tenancy`, with a reconciling migration that opens one for every villa already on the register. A
  sale closes the seller's period and opens the buyer's; **the seller keeps their arrears**. In the
  `/api/db` projection — check there first if it ever comes back empty.
- **Correction vs. real change is asked, never guessed** (2026-08-21) — for a tenant name, an owner
  name, and taking a tenant off a villa. Refusal codes `tenant-change-intent-required` and
  `owner-change-intent-required`, kept in step between `server.ts` and `src/lib/api.ts`.
- **Voiding a charge is reachable** — a labelled **Charges** button on every ledger row. It used to
  live behind the "Billed" figure being silently clickable, and was reported as not existing.
- **Lease end dates** + renewal warnings (60 days, and already-lapsed) on dashboard and hub.
- **Maintenance work orders** — assign, progress, close with cost and outcome; the cost can be
  raised as a property expense **once**.
- **Unbilled-occupancy alerts** — months a tenant has occupied that nobody billed.
- **Charts & Snapshots** tab; **Financial Projections** with custom range + Excel export.

**Resilience / deployment**
- **Offline action queue** — work entered while the HP is down is written to `localStorage` before
  being attempted, survives a reboot or closed tab, and replays in order with the original
  idempotency keys. Never described as "saved" until the server has it.
- **External-drive backup**, settable in the app (no environment variable, no restart). Backups are
  written with live sessions stripped — a byte-for-byte copy of `db.json` carried working session
  tokens off the machine, and a token is a valid login for twelve hours. Password hashes stay in the
  file (a restore needs them), so the backup folder is still credential-bearing. Restoring one is
  tested end to end: delete `db.json`, drop the backup in its place, start the server.
- **The backup drive is detected, and followed when it moves.** System Settings lists the drives
  attached *to the server* with the folder each would use and whether it is writable now, so the
  drive is picked rather than typed. The machine's own disk is identified by device id, not by name —
  on macOS the boot volume sits in `/Volumes` looking exactly like a USB stick, and a copy on the
  same disk is not an off-machine copy at all. Choosing a folder marks it with an id; when the saved
  path stops answering (Windows hands a stick whatever letter is free), the marker is searched for
  across the attached drives, the copy still lands, and the new path is saved and audited. Without
  that, a moved drive letter meant the off-machine copy silently stopped happening.
- **The records check themselves** (2026-08-16) — `server/integrity.ts` walks the live
  database at start-up and on demand from **System Settings → Backup & recovery → Check now**, and
  reports anything that contradicts itself. It never repairs, never refuses to start, and is proved
  not to cry wolf against a 400-scenario database. See *Built-in safeguards* below.
- **A database from a newer build is refused** (2026-08-16) — restoring a
  post-upgrade backup onto an older `.exe` used to load it and stamp the old version on it. Older
  files still migrate forward; only newer is refused, with an instruction to install the current
  version.
- **Dependencies are gated in CI** (2026-08-16) — `npm audit --omit=dev
  --audit-level=high` and a typecheck run before the suite in `build-exe.yml`, so a release cannot
  be built carrying a known high or critical advisory.
- **Admin password recovery** — drop `RESET-ADMIN-PASSWORD.txt` next to `db.json`, restart.
  File-based only; nothing over the network can trigger it.
- **Adversarial pass** — a running server was attacked rather than read. What held: 20-way races on
  the same record (confirm, refund, void, post-month) settle to exactly one action; refunds cannot
  exceed, repeat, or apply to a voided or unconfirmed receipt; receipt numbers, ids and `receivedBy`
  cannot be set by a client; no prototype pollution, path traversal, session fixation, or escalation
  through the settings matrix. What did not, and is now fixed: sign-in timing revealed which
  usernames existed (a missing account answered 6x faster); figures like `1.500.000` were silently
  read as `1.5`; the exchange rate accepted `0.0001`; an idempotency key was answered from whoever
  used it first, regardless of account. Each has a regression test.
- **The sums are tested directly.** The server was well covered; the arithmetic behind the owner
  statements and reports runs in the browser and had never been reached. It is now: money does not
  drift through cents, USD and JMD never combine, and a statement closes where the next one opens.
  Dates are built from local calendar parts, so a payment taken at 8pm in Jamaica lands on the day
  it was taken rather than being pushed into the next month by UTC.
- **Dependencies carry no known advisories** (`npm audit` clean). `vite` was declared as both a
  runtime and a build dependency; it is build-only, imported dynamically in the dev branch alone.

**Booking platforms — what is and is not possible**

Airbnb has no open API for individual hosts; API access is granted to approved software partners
under a formal application, and is not something this property can simply switch on. The supported
route is the **iCal export link** each listing provides, which is what this app consumes. Booking.com
and VRBO are the same.

That sets a hard boundary worth knowing before anyone asks for more: an iCal feed carries *dates and
availability only*. It does not carry the guest's name (Airbnb sends `Reserved`), the nightly rate,
the payout, or the fees. So stays import with their dates and must have their value entered by hand,
and platform payouts can never be reconciled automatically from the feed. Nothing in the code can
change that; it is what the feed contains.

What the reader now handles: exclusive checkout dates, folded lines, escaped text, `DURATION` instead
of an end date, `STATUS:CANCELLED`, owner blocks (`Airbnb (Not available)`, `CLOSED - Not available`),
and UTC times converted to the property's own day. **A stay that disappears from the feed is
cancelled** — Airbnb signals a cancellation by dropping the entry rather than marking it, so without
this a cancelled guest went on blocking a villa for ever. Stays with money against them are raised as
conflicts instead of being cancelled silently.
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

### Robustness audit — 2026-08-09

Ran an adversarial probe over the whole app (~90 assertions: money invariants, lifecycle cycles,
unit-id mapping, concurrency, input hardening, sessions, precision, backups, and whether the finance
helpers agree with each other). **Three live bugs found, all in the Tier 5 code, all fixed with
regression tests.** Everything older held.

1. **A refunded receipt could be corrected below what had already been handed back.** The settled-
   receipt edit route rebuilds the payment with `{...original}`, carrying `refundedAmount` forward
   while letting the amount be rewritten freely. J$50,000 taken, J$40,000 refunded, receipt corrected
   to J$1,000 left the receipt worth **minus J$39,000** and the account grew a debt out of nothing.
   Now the amount cannot go below the refund, the currency is frozen, and it cannot be re-dated past
   its own refund.
2. **A bank match outlived the receipt it checked.** Correcting a ticked receipt's amount, date,
   currency or method left the tick standing, so the month still read as reconciled against a figure
   nobody had matched. The tick is now dropped on those edits (and only those — a note or a payer
   spelling keeps it) and the audit says so.
3. **A voided receipt kept its bank tick** — one record claiming both that the money never arrived
   and that the bank had shown it arriving. Voiding now clears it.

Also fixed: `periodStatement` in `finance.ts` took its opening balance from `accountBalance` (which
nets refunds) but summed `paid` gross, so its closing balance contradicted the ledger. It is **dead
code** — exported and never called — which is why nothing surfaced it. Worth deleting if it stays
unused; it is a trap sitting in the source-of-truth module.

**Currency changes on a settled receipt — now a deliberate act.** Editing a receipt's currency was
raised in the audit and then locked down on Ro's instruction. It could not simply be blocked: it is
the intended correction path for money recorded in the wrong currency, which is why `accountBalance`
surfaces `mismatchedCurrencyPayments` rather than hiding them. So it follows the house pattern
instead — refused once with the machine-readable code `currency-change-not-confirmed`, and allowed
on a second, explicit ask.

The refusal states the actual consequence in figures ("recorded as JMD 95,000 … becomes USD 95,000,
and the receipt moves off the JMD account"), because nothing converts the amount — a JMD receipt
flipped to USD is roughly a hundred and fifty times the money. The field itself also turns red the
moment the dropdown changes, so an accidental change is caught before submit rather than after.

Note the layering: even a *wrongly confirmed* change is still caught by the mismatched-currency
banner on the ledger. Verified end to end in the browser.

### Hardening — 2026-08-10

Not a feature tier. A pass over the parts nobody had attacked, plus the sums nobody had tested.

**Found by attacking a running server** (three rounds, all fixed, each with a regression test):

- **Backups carried working logins.** A backup was a byte-for-byte copy of `db.json`, so every copy
  on a USB stick or in a synced folder contained the live `sessions` array. A token is valid for
  twelve hours: read a recent backup, paste a token into a cookie, and you are signed in as whoever
  it belonged to. Sessions are now stripped as the backup is written.
- **Sign-in timing leaked which usernames exist.** A wrong password against a real account took
  ~33ms of scrypt; against an account that did not exist, under 6ms. A decoy check now burns the same
  work, and the two are indistinguishable.
- **Figures were silently reshaped rather than refused.** The parser stripped everything but digits,
  dots and minus signs, so `1.500.000` became `1.5` and `50000abc` became `50000`. A wrong figure
  that looks deliberate is worse than a refused one — it is receipted and reconciled before anyone
  notices. The grammar is explicit now, and the same rule holds where a figure is optional.
- **Idempotency keys were global.** A key was answered from whoever used it first, so the same key
  from another member of staff returned *their* receipt with your payment never recorded. Keys are
  scoped to the account now.
- **The exchange rate accepted 0.0001.** Bounded to 50–1000, on the input as well as the server.

**Held up under attack, and worth not re-litigating:** 20-way races on the same record (confirm,
refund, void, post-month) settle to exactly one action; refunds cannot exceed, repeat, or apply to a
voided or unconfirmed receipt; receipt numbers, ids and `receivedBy` cannot be set by a client; no
prototype pollution, path traversal, session fixation, or escalation through the settings matrix;
session tokens are 256-bit.

**The sums are now tested directly.** The figures the business acts on are computed in `src/lib/`
and most of that runs in the browser, where no test had reached it — `money.ts` had none at all.
Money does not drift through cents, USD and JMD never combine, and a statement closes where the next
one opens. All 52 checks passed first time: the arithmetic was right, it just had nothing holding it
there. Dates were checked too and needed no change — they are built from local calendar parts, so a
payment taken at 8pm in Jamaica is dated that day rather than pushed into the next month by UTC.

**300 simulated scenarios, no integrity violation.** Two suites, both on databases that are never
reset. `scenarios` runs 200 through the ledger; `scenarios-full` runs 100 across the whole
application from a fully populated property. After *each* scenario the entire database is audited: no
shared receipt numbers, nothing unreceived holding one, no NaN or impossible negative, nothing
refunded beyond its worth, no month billed twice, no villa sold twice on one night, a work order's
cost raised exactly once. Seeded, so a failure names a seed that reproduces it.

**Airbnb.** There is no open Airbnb API for individual hosts — access is for approved software
partners under a formal application. iCal is the supported route and is what this uses. The feed
carries dates and availability only: no guest name (Airbnb sends `Reserved`), no rate, no payout, so
stay values are entered by hand and platform payouts can never be reconciled from the feed. The
reader now handles `DURATION` in place of an end date, `STATUS:CANCELLED`, owner blocks, and folded
or escaped text. **A stay that disappears from the feed is cancelled** — that is how Airbnb signals a
cancellation, and without it a cancelled guest blocked a villa for ever. Stays with money against
them are raised as conflicts instead of being cancelled silently.

**Still not run by anyone:** the Windows `.exe` path beyond CI, the PWA, the offline queue under real
network loss, a live Airbnb feed against a real listing, and the two-PC dry run.

---

## Reaching the app from outside the property

**Tailscale is installed and confirmed working as of 2026-08-10.** Remote access from a phone to
the HP was tested and succeeded on first attempt. This section describes the setup for reference and
for any new device that needs to be added.

The HP stays on and serves; everything else connects to it. The server binds `0.0.0.0:3000`, so it
answers on every interface including a VPN one — no code change is needed for remote access.

**Tailscale** builds a private encrypted network between your own devices; the HP is reachable at a
fixed `100.x` address that only your devices can see. No port forwarding, nothing published. Do
**not** forward port 3000 on the router, and do **not** use Tailscale *Funnel* — both put a system
holding tenants' financial records on the public internet in plain HTTP.

On the HP: Tailscale is installed. Confirm **tray icon → Preferences → Run unattended** is on —
without it, Tailscale disconnects at logout and remote access dies at the first reboot. Sleep is set
to **Never** (a sleeping HP is an unreachable one).

To add a new device: install Tailscale, sign in with the same account, then `http://<HP-machine-name>:3000`.

Worth knowing: Tailscale encrypts the traffic even though the app speaks plain HTTP, so the browser's
"Not secure" warning is about the missing certificate rather than an exposed connection. Leave
`VDS_FORCE_SECURE_COOKIE` unset — forcing `Secure` cookies breaks sign-in over plain HTTP, which is
how the LAN clients connect. Anyone signed into that Tailscale account can reach the app, so keep it
to staff devices only and use strong passwords.

---

### Bank reconciliation — finished, and it is a tick

Everything in this application derived from the property's own records, which made every figure
consistent with every other figure and proved nothing. A transfer that was promised and never sent
looked exactly like one that arrived. **Bank Reconciliation** is the only screen that checks the
ledger against something outside it.

**A tick, not an import.** Ro, asked directly how the statement reaches the office (2026-08-09):
manual tick-off. A CSV importer would have to be written against an NCB/Scotiabank export nobody has
a sample of, and would fail quietly the first time a column moved. Do not build one because it
sounds better — it is worse until someone produces a real statement file to test against.

One month, one currency, three figures: what the ledger says was received, what has been found on a
statement, and **what has not** — the number the exercise exists to drive to zero. A "statement date"
is set once and then every tick uses it, because the posture is statement-open-beside-you, working
down. Printable and signable for filing.

`reconciledOn` is the *bank's* date, not today's, because that is the date being matched. Only
`completed` receipts can be matched: an expected cheque has not been banked and a voided receipt
records something that did not happen. **Matching moves no balance** — it records only whether the
money was found, and a reconciliation that shifted figures would be a second, rival source of truth.
Un-matching is allowed and audited, because "it reconciled last week and now it doesn't" is a shape
worth seeing.

Cash is deliberately included rather than filtered as "never going to appear on a statement": cash
received and never banked is precisely the thing worth being able to see.

Gated on `recordPayments`, not something heavier — the person who banks the money has the statement,
and putting it behind a manager would mean it never got done. 24 tests in
`test/reconciliation.test.mjs`.

### Refunds — finished, and they are not voids

The instrument that was missing. Money going back out could only be recorded by **voiding** the
receipt — which asserts the money never arrived, destroys the evidence that the property ever held
it, and leaves no record of the payment out at all.

**Void and refund say opposite things and both are needed.** Void: this should never have been
recorded — an entry error, a bounced cheque. Refund: it *was* received, the receipt is valid and
stays printable, and afterwards some or all went back. Recording a refund as an expense is no better
than voiding it: a refund is not a cost of running the property, it is income handed back.

So it lives on the receipt (`refundedAmount`, `refundedOn`, `refundMethod`, `refundReason`,
`refundedBy`) — the same shape as a deposit living on its tenancy. The receipt keeps its status and
its number.

**The date is the whole trick.** A refund is netted off from the day the money *left*, not the day
the receipt was taken. `netPaidAsOf` and `refundedAsOf` in `finance.ts` are the only place that
arithmetic is written — nothing should read `refundedAmount` directly. A July receipt refunded in
August reduces *August*; netting it into July would silently restate a month already reported on.

Partial refunds are the normal case, so it is an amount, not a flag. A receipt cannot be both
refunded and voided in either order — the pair would take the money off the ledger twice. Booking
deposits reduce `depositPaid` and put `balanceDue` back; a fully refunded utility settlement reopens
the bill. Gated on `reversePayments`. 27 tests in `test/refunds.test.mjs`.

Verified in the browser: a refunded maintenance payment correctly returns the owner to arrears, and
the refund appears on the proprietor statement as its own dated negative line so the column still
adds up.

### Rent proration — closed as policy, not built

**A mid-month move-in is billed the whole month.** Ro's decision, asked directly, 2026-08-09. Rent is
not prorated.

Do not "fix" this with day-count arithmetic. Proration would have to reach the advance final month
and the move-out month as well to stay coherent, and none of that is wanted. It is a lease term, not
an oversight.

What changed is that it is no longer *invisible*. The move-in charge now says so on its own face when
the date is not the first — "full month; moved in 20 Aug, not prorated" — so the ledger, the statement
and the tenant's copy all show a full month against a mid-month date instead of looking like a
billing error to whoever reads it next. The tenancy screen says the same thing under the move-in
date field.

### Guest damage deposits — finished, and optional

Short-Term Bookings gains a **Damage held** column. Blank for a stay with no deposit, which is most
of them; "Hold one" where it makes sense; the amount held once one is taken; and what went back once
it is reconciled.

**Optional is the requirement, not a nicety** (Ro, 2026-08-09: "do not make it mandatory, make it
optional for us"). A booking, a check-out and a guest receipt all behave exactly as they did when no
deposit is held. Nothing prompts for one and nothing blocks on its absence — there is a test for
each of those, because this is the kind of thing that quietly becomes mandatory later.

**It is not `depositPaid`.** That field beside it is a part-payment toward the stay: the guest's
money becoming the property's, and it raises a receipt. This is the opposite — the guest's money
staying the guest's, held against damage and owed back. So `damageDeposit*` raises **no payment
row**, appears in no collection figure, and cannot reach an owner statement or a projection. It
lives on the booking exactly as a tenant's deposit lives on the tenancy, and for the same reason.
Do not "fix" this by booking it as income.

Reconciling insists returned + withheld equals what was held, and anything withheld carries a reason
kept permanently — a deposit that half disappears is what a guest disputes, and a chargeback follows
the guest, not the paperwork. Withholding is still not income: a real cost recovered that way is
recorded as an expense against the villa. Holding needs `recordPayments`; reconciling needs
`reversePayments`, the same veto level as a tenancy deposit.

26 tests in `test/damage-deposit.test.mjs`; verified in the browser.

### Reading the records when the server is down — finished

The offline queue was making a half-promise. Work *entered* while the HP is down is kept and
replayed, so nothing typed is lost — but nothing could be *read*. The moment the server went away
the application had no records at all, so nobody could answer "what does Villa 7 owe?" at the gate,
look up a tenant, or check whether a bill was already settled. Losing writes for ten minutes is an
inconvenience; losing lookups is the office stopping.

Every successful load is now kept in IndexedDB (`src/lib/snapshot.ts`) and shown when the server
cannot be reached, under a **red banner naming the time the records were taken** that does not go
away. That wording is the safety mechanism: a balance an hour old presented as current is how
somebody takes a payment that was already taken.

Three decisions worth keeping:

- **IndexedDB here, localStorage for the queue** — deliberately opposite, for opposite reasons. The
  queue holds work that exists nowhere else, so it needs a synchronous write that is on disk before
  the call returns. This holds a copy of records the server already has: losing it costs nothing but
  a blank screen, and a synchronous `JSON.stringify` of the whole database on every refresh would
  stall the interface.
- **`refresh()` uses `failFast`.** The reconnect loop exists to protect *writes*. A read has nothing
  to lose, and the first cut inherited the 90-second retry window — ninety seconds of spinner before
  showing the stored copy, with someone standing at the gate. It now falls back in about 0.2s.
- **The copy is keyed to the user and cleared on sign-out and on any 401.** The desk machine is
  shared; records must not outlive the session that loaded them.

**Not covered by the test suite.** Every test boots a real server and talks HTTP; IndexedDB is
browser-only, so there is no `.mjs` test for this. It was verified by hand — load, `kill -9` the
server, confirm the ledger still reads with the banner up, restart, confirm it goes live and stores
a fresh copy. Re-verify that way if you touch it.

**Still open, and it is Ro's call:** this only helps a tab that was *already signed in*. On a cold
page load with the server down, the session probe gets nothing, so it shows the sign-in screen and
the stored copy is unreachable — you cannot sign in with no server. Fixing that means letting the
last user's records be read without signing in, which on a shared desk machine is a real exposure.
Worth asking before building.

### Strata compliance and unit entitlement — engines built, export next

**Read `STRATA_COMPLIANCE.md` before touching reporting.** It records what the Commission of Strata
Corporations actually requires, researched from the regulator's own pages on 2026-08-15: Forms 8,
13A (income and expenditure), 13B (outstanding contributions), 13C (outstanding payables), filed
within **120 days of the financial year end**, with AGM minutes, a list of proprietor balances
**against strata lot numbers**, and accounts signed by the Chairman plus one other executive member.

**Critical filing note (Ro, 2026-08-15):** the Commission accepts an Excel breakdown in place of 13A's
fixed printed lines, because those lines cannot describe what a real property actually spends. Do NOT
realign app expense categories to match the form's fixed lines. The export should carry the full
breakdown. This is recorded in `STRATA_COMPLIANCE.md` under "How the return is actually filed".

**Unit entitlement is in the model.** `Unit.entitlement` and `Unit.strataLotNumber`, both optional,
both audited when changed. The strata plan number is Villaggio Del Sol **2324** (in settings as
`strataPlanNumber`; `trn` also held in settings but not yet filled). `levyProportionality()` and
`disproportionateLevies()` compare levied amounts against what entitlement implies; villa detail
shows the entitlement share and whether the levy is proportionate. 27 tests in `entitlement.test.mjs`.

Two rules that are deliberate and must not be "simplified":

- **A lot with no entitlement is excluded, never treated as zero.** Treating it as zero would
  redistribute its share and manufacture a finding.
- **Currencies are pooled separately.** A villa billed in USD is not in the same pool as one in JMD.

**Forms 13B and 13C are built as compute engines in `finance.ts`.** `form13BContributions()` produces
the outstanding contributions ageing schedule keyed by strata lot number; `form13CDebts()` produces
the outstanding debts ageing schedule keyed by vendor/category description. Both use 30/60/90/over-90
day buckets. The invariant that matters most: **13B bucket totals must equal the account balance** — a
part-paid charge is aged only for what is still owed (payments are re-applied oldest-first inside the
function). The `accountBalance.unpaidCharges` list shows a partly-paid charge in full — correct for
display, wrong for the return. 26 tests in `annual-return.test.mjs`, covering boundary days, part-pay
invariant, strata lot fallback, currency separation, 13C pending-only rule, and future-due exclusion.

**Naming and wording fixed throughout.** In the Act, "strata corporation" means the body corporate
(the proprietors of Villaggio Del Sol themselves), not the Commission of Strata Corporations (the
regulator). This confusion was in several screens. Fixed by:

- `bodyCorporateName(settings?)` helper in `types.ts` returns "Villaggio Del Sol (Strata Plan No. 2324)"
- "Proprietor Statements" renamed to **"Owners Statements"** throughout App.tsx and OwnerStatements.tsx
- `netLabel()` now says "Due to Alba Reid — Villa Unit 1" — owner name and villa number, not the
  generic "due from proprietor"
- Projections printout now says explicitly: "This is NOT the annual return filed with the Commission
  of Strata Corporations"
- OwnerStatements basis note: "income of the body corporate, Villaggio Del Sol (Strata Plan No. 2324)"

**What remains — the statutory return export. DEFERRED by Ro on 2026-08-21: "we'll do that
manually for now."** The compute engines exist and are tested (`form13BContributions`,
`form13CDebts`); nothing in the UI calls them, so the app cannot put Forms 13B/13C on paper and
the return is worked out by hand. **Do not build this unless asked** — the deployment and the
Excel migration come first. When it is asked for, the shape below is what was designed:

- Header: Strata Plan No. 2324, TRN (from settings), Name & Address
- Financial year end date selector
- 13A-style income and expenditure: contributions raised, outstanding, expenses by category with
  current-year total and outstanding amount per line
- 13B table: strata lot rows × 30/60/90/over-90 columns + totals row
- 13C table: description rows × same columns + totals row
- BOM CSV (same pattern as Projections.tsx / OwnerStatements.tsx Excel exports)
- Accessible from the Reports tab or a dedicated Annual Return section

The compute engines exist. What needs building is the UI section and the CSV assembly.

### Double-recorded payments — fixed

Two officers working the same arrears list, or one person with the hub open in two tabs, both saw
"Villa 1 owes J$50,000", both pressed Receive payment, and the money was only ever handed over once.
Each request was validated against a world in which the other had not happened, so both were
accepted and the villa showed a credit for money nobody received. The idempotency key does not help
— two people acting independently generate two different keys, so there is nothing to deduplicate.

`assertAccountStillOwes` in `server.ts` checks the balance **inside the transaction**, against the
committed ledger at the moment of the write, using the same `accountBalance()` the screens use. The
refusal names who banked it and which receipt, carries the code `account-already-settled`, and the
screen offers a checkbox to record it deliberately as a credit if it really is separate money. The
same guard covers confirming an expected cheque and settling a utility bill twice.

**If you touch the payment forms:** do not wrap `onSubmit` in a `try/catch` that rethrows as a plain
`Error`. That strips `ApiError.code`, the refusal message still shows but the override checkbox
never appears, and the officer is walled out with no way through. That exact bug was in
`Dashboard.tsx` and was only caught in the browser — the tests all passed.

---

### Session 2026-08-16 — branding, management reporting, migration groundwork

A long session. Everything below is committed and pushed (`413de34`).

**Branding.** Logo (`public/vds-logo.png`, transparent) on the login screen, sidebar, mobile header
and every printed letterhead. **"Powered by ISPO"** on the sign-in screen, the sidebar footer, and
printed-document footers — Villaggio Del Sol is owned by Ispo Construction Ltd.

⚠️ **ISPO is deliberately NOT in the letterhead.** The letterhead answers *who issued this
document*, and on an owner statement that must be the body corporate alone — a second company's
name there invites a proprietor to ask who is actually billing them. Keep it a footer credit. If
Forms 13A/13B/13C are ever generated as documents, keep ISPO off them entirely.

**Management reporting — new.**
- `BoardPack.tsx` — one document (covering figures + charts) replacing the print-three-documents
  ritual. Button on the Charts tab.
- Three charts: **rented villas by month**, **collection rate by month**, **arrears ageing**.
- `arrearsAgeing` / `ageAccountArrears` in `finance.ts`. **Form 13B now buckets debt through the
  same function**, so the statutory return and the management chart cannot diverge.
- `occupancySeries` / `occupiedUnitIdsOn` — occupancy read from tenancy and booking *dates*, because
  `unit.status` has no history. **Consequence, stated on the chart and pinned by a test:** an
  owner-occupied villa files neither, so it is not counted. This measures villas *rented out*.
- Every SVG chart now also emits a data table. **This is an invariant, not a nicety** — chart values
  live in `<title>` tooltips, which are unreachable on paper, by keyboard, or to a screen reader.
  `components.test.mjs` asserts it per chart *and* as a blanket rule.

**Dashboard / Reports / navigation.**
- Removed the full-width banner that spent the best space on one button.
- Unbilled accounts got their own warning — they previously shared a line with the arrears figure
  and vanished the moment anything was in arrears.
- Prior-month comparisons on arrears, collection rate and net cash.
- Report observations ranked (urgent / notable / context) instead of emitted in computation order.
- Sidebar grouped Daily / Financial / Records.
- Reporting date range shared between Charts and Reports (`src/lib/reportRange.ts`). **Deliberately
  not shared with Projections** — that window is a run-rate averaging basis that ends at last month
  on purpose.

**Terminology.** "Let occupancy" → **"Rented"**. "Occupied" was rejected because the app already
uses "Owner Occupied" as a unit status.

**Testing — 788 → 913.**
- `scenarios-400.test.mjs` (was 300). Audits the books **and** the reporting layer after every
  scenario, exhaustively rather than sampled (16s for 400).
- `components.test.mjs` — first frontend tests. esbuild + `react-dom/server`, no new dependencies.
- `management-charts.test.mjs`, `time-assumptions.test.mjs`.
- **A 404 tripwire now lives in `makeClient`.** Three of my scenarios were posting to routes that
  do not exist, passing silently, and proving nothing — two assertions above them passed for
  unrelated reasons. All three scenario suites now assert zero 404s during their loops. The other
  two suites were clean.

**Read this before trusting a green run:** several fixes in this session were mutation-tested —
the guard was removed and the suite confirmed to fail. Do the same for anything load-bearing you
add. A green test that would not catch its own bug is worse than no test.

**Known limitation.** The letterhead pill's right edge was flush with its container (measured gap
of zero) and lost its outer half to rasteriser clipping; it now has a 1px inset and the rule is
defined once for all media rather than print-only. **This could not be verified in an actual PDF
export** — no tool here rasterises one. If it still reads thin on paper, the next step is dropping
the corner radius for print.

---

## The audit — closed

I audited the app as a property manager and worked the list down. **Everything on it is now done or
deliberately closed.** Kept here so nobody re-derives it or rebuilds something that was ruled out.

**Tier 2 — done**
1. ~~**Owner statements**~~ · 2. ~~**Recurring expenses**~~ — see above.

**Tier 3 — closed by decision, NOT built**
3–6. Document storage, communication log, formal notices, inspection records.

   These were built as one *Records & Documents* timeline — entries dated by when they happened,
   attached to a villa or a person, with real files stored beside `db.json` — and then **removed at
   Ro's instruction, 2026-08-09**: *"we'll leave it manual for now as all leases are signed
   physically anyway."*

   The removal was complete and clean: no types, routes, storage, screen or tests remain, and
   nothing else ever depended on it (verified on a running server before removing it — the feature
   was fully additive). Recovering it means rebuilding, not un-hiding.

   **Do not rebuild it speculatively.** Ro was asked what a real dispute had looked like and the
   answer was that there have been none: *"usually we pull up an owner or tenants records as proof
   and move accordingly."* If that changes, the shape that was right is one screen, not four — the
   need is *evidence, dated, attached to a villa or a person, in the order it happened* — and files
   must go in a folder beside `db.json`, never inside it, with the off-machine backup extended to
   carry them.

**Tier 4 — short lets: nothing left**
7. ~~**Guest damage deposit**~~ — done, see above. Channel commission and cleaning fees were
   examined and ruled out as non-issues — see the closed note below before reopening either.

**Tier 5 — done**
8. ~~**Bank reconciliation**~~ — a tick, not an import. See above.
9. ~~**Refund instrument**~~ — refunds are no longer voids. See above.
10. ~~**Rent proration**~~ — closed as policy: a mid-month move-in is billed whole. See above.

**Closed, and do not reopen it:** short lets are *not* financially overstated, whatever an earlier
reading of this file said. Confirmed with Ro, 2026-08-09:

- **Direct bookings are priced all-inclusive** — the quoted figure already accounts for the costs of
  the stay, so the recorded amount is what the property keeps.
- **Airbnb and Booking.com remit net** — their commission is taken before the money arrives, so the
  receipt is the real deposit. There is no gross figure to deduct anything from.
- **No management commission exists.** The corporation provides no management service to an owner
  who rents their own villa, so booking income passes to the proprietor in full — exactly as owner
  statements already treat it.
- **There is no separate cleaning fee.** Cleaning is covered by the nightly rate and by the monthly
  grounds/housekeeping payroll.

So there is no commission model to build and nothing to net off. Do not add one: recording a
commission that is not charged, or a gross figure that is never received, would make the ledger
*less* true than it is now.

## Session of 2026-08-21 — the first real data, and what it broke

**The most important session in this file, because it is the only one where the application met
Villaggio Del Sol's actual records rather than a seeded property.** Four releases went out:
**v1.8.3, v1.8.4, v1.8.5, v1.9.0**. All committed and pushed; `main` is `b29b55d`.

### How it started

Ro set "The books begin on" to 1 September, entered a long-standing tenant on villa C13 with their
real move-in date, mistyped the name, corrected it — and the villa showed outstanding rent that
nobody owed. Reported as *"this should not have happened."*

It was reproduced on a throwaway database rather than reasoned about, and there were **two** faults,
not one:

1. **`raiseFirstAndLastRent` billed first and last month's rent dated to a move-in month years
   before the books open.** Correct for a new tenant; nonsense for a tenant migrating out of Excel
   who settled that money in 2024. `booksBeginOn` had never been wired into charge creation — it
   only silenced unbilled-occupancy alerts.
2. **Correcting the mistyped name raised a *second* advance beside the first.** A name change closes
   one tenancy and opens another; the new one carried no `advanceRentChargeId`, so the guard against
   double-billing could not see the charge already standing. The villa ended up holding two
   advances for one month, one of them in the name of a tenant who never existed. Outstanding went
   2 → 3.

**All 1,087 tests passed throughout both.** Each feature was doing exactly what it had been built to
do. Nothing had ever asked what happens when they meet. See *Things learned the hard way*.

Ro also reported *"there is no void option on the UI"* — and was right. Voiding a charge lived behind
the **"Billed" money figure being secretly clickable**: a plain number, no underline, tooltip only.
The correction path existed and could not be found.

### What shipped

**v1.8.3** — the version number now renders in the sidebar footer and on the sign-in screen, from
`package.json` via a Vite `define`. Asked for by Ro so it is possible to tell what a machine is
running. `README.md` and `SETUP-WINDOWS.md` were rewritten around the single-file `.exe` (they still
described the old `.bat`) and gained an explicit "updating without losing your records" section.

**v1.8.4** — the two migration faults:
- `raiseFirstAndLastRent` returns early when the move-in month falls before `booksBeginOn`. Compared
  **by month**, so a mid-month move-in inside the opening month still bills normally.
- An advance already standing for that villa and month is **adopted** — payer renamed, tenancy bound
  to it — rather than reissued. Same for the first month's charge.
- A labelled **Charges** button on every ledger row, beside Statement. The modal also explains who to
  ask when the viewer lacks `modify_settled`, rather than silently hiding the column.

**v1.8.5** — a changed tenant name now asks whether it is a **correction** or a **new tenant**.

**v1.9.0** — the same question in the two other places it was being guessed:
- **Owner name**: correction, or has the villa been **sold**? New append-only `Ownership` record with
  a reconciling migration. A sale closes the seller's period and opens the buyer's, **and what the
  seller already owes stays with the seller** — which is what Form 13B requires. A correction edits
  the open period and re-payers only the *open* maintenance charges, never a settled one whose
  receipt has already gone out.
- **Taking a tenant off a villa**: moved out, or entered by mistake? A move-out spends the advance
  and writes off the final month. A correction takes the entry back — unpaid rent voided with the
  reason recorded, advance left unspent, no departure recorded — and deliberately does **not** touch
  a receipt already issued.

### The pattern, and why it was not invented

All three follow the house pattern that `account-already-settled` and `currency-change-not-confirmed`
already used: **refuse once with a machine-readable `code`, let the screen turn it into a deliberate
act.** The difference is that those have one right answer so the screen confirms, and these have two
so the screen offers a choice with the consequence written on each. **Nothing is preselected** — a
default would be the machine guessing again, which is the fault being removed.

Codes: `tenant-change-intent-required`, `owner-change-intent-required`. Kept in step between
`server.ts` and `src/lib/api.ts`, as the existing two are.

### One fix was tried and reverted — do not re-attempt it

Deriving the tenant answer from the outgoing tenancy's move-in date (blank date ⇒ correction) looked
right and was wrong: **a genuine changeover very often follows a tenant who had no move-in date
recorded either.** It suppressed the advance on real handovers throughout the scenario suite —
`scenarios-400` never supplies a move-in date and relies entirely on the changeover stamp, so the
advance path vanished from all 400 scenarios. Reverted, and the reasoning is written into
`syncTenancy` so it is not tried a third time. The signal has to come from the person entering it.

### Testing

**1,245 pass, up from 1,087.** New suite `test/corrections.test.mjs` — **158 checks** covering
mistakes and their correction: mistyped names, wrong rent figures, tenant against the wrong villa,
charges voided, the books-begin date itself corrected, sales, take-backs, and the invariants that
must survive all of it (no villa holding two open advances for one month, no two open ownership
periods, every closed period saying why).

**Every guard added was mutation-tested** — removed, and the suite confirmed to fail. Counts: 8, 11
and 3 for the v1.8.4 fixes; 6 and 8 for v1.8.5; 5, 7 and 13 for v1.9.0.

Updating the other suites turned up a test in `input-hardening` that had **started passing for the
wrong reason**: the new owner refusal was firing before the number-grammar guard it was written to
exercise. Fixed so it tests what it claims. Worth watching for whenever a new refusal is added
upstream of existing assertions.

### A constraint worth knowing before the cutover

**A move-in date cannot be in the future.** With the books opening on 1 September and today in
August, *every* enterable move-in date falls before the books — so nothing bills at all. That makes
entering the register now safe, and it also means the billing path cannot be exercised until
September actually arrives.

## Session of 2026-08-18

Handover-only session. No code was changed.

Confirmed that v1.8.2 was already released on 2026-08-17 containing the full 2026-08-16 body of
work. The previous handover stated `main` was at `9b75b61` (unreleased); the remote had moved two
commits further to `70af15d` through commits `83b41a6` ("Say plainly that a release does not carry
the plan number") and `70af15d` ("Move the release workflow off the deprecated Node 20 runtime"),
both by `vildelsol`, neither carrying app changes.

No outstanding bugs. No uncommitted work. The action is to install v1.8.2 on the HP and set the
plan number in System Settings.

---

## Sessions of 2026-08-16

Two sessions ran on this date and they are recorded separately.

**The first** is the commit *"Brand the app, add management reporting, and prepare the Excel
migration"* — pushed, and written up under *Session 2026-08-16* above.

**The second is everything below, and it is all committed and pushed (`9b75b61`) and released as v1.8.2.** It ran in five passes, each of which
found something the one before it had missed. Read them in order; the lesson at the end of each is
the part worth keeping:

1. *Stress run* — a dead route hiding behind a probabilistic branch.
2. *Plan number*, *Projections and USD* — a wrong statutory number, and a non-bug.
3. *Property health grade*, *The annual report* — the two features built.
4. *Full-data simulation pass* — the headline figure did not reconcile; scenario coverage had
   silently collapsed.
5. *Closing the untested gaps*, *Built-in safeguards* — permissions, restore, concurrency, mobile;
   then the self-check, the schema guard and the dependency gate.

**The thread running through all five:** a green suite proves the assertions ran, not that they
still mean anything. Three separate times a guard existed, passed, and could not possibly have
fired — a dead route, a frozen scenario month, a receipt pattern that matched nothing. **A guard
that cannot fire is worse than no guard, because it is counted as coverage.**

### Stress run — 2026-08-16 (second session)

The 2026-08-16 changes were re-attacked by simulation rather than re-read. **800 audited scenarios
per suite run**: 200 through the ledger, **200 across the whole application from a fully populated
property** (raised from 100), and 400 against the reporting layer. The whole database is audited
after *every single scenario*. **913 tests pass, typecheck clean, build clean. No integrity
violation in any of them** — no shared receipt numbers, no NaN, nothing refunded beyond its worth,
no month billed twice, no villa sold twice on a night, and every ageing column still totals the
balance behind it.

**One real defect found, and it was in the tests, not the books.** `scenarios-full` was calling
`DELETE /api/expenses/:id` — **a route that has never existed**, server-side or in the client. An
expense is an audited record and the correction path is an edit; there is no delete and there should
not be one. The call sat behind a `rand() > 0.7` arm that a hundred iterations never reached, so it
had never fired and had never been caught. At two hundred it fired, the 404 tripwire caught it
exactly as designed, and the scenario now re-dates and re-categorises the cost instead — which is
what the office actually does to a cost entered wrongly.

**`SCENARIO_COUNT` in `scenarios-full.test.mjs` is now 200, and the reason is written above it:
raise it, never lower it.** At a hundred, the scenario list does not come round often enough for its
probabilistic branches to all fire, and a dead route can hide in one indefinitely. It is
env-overridable for a deeper pass — `VDS_SCENARIOS_FULL=500 node test/run.mjs`. Seeds are still
fixed, so a failure names a seed that reproduces it.

**The lesson, and it generalises:** the 404 tripwire added in the previous session works, but a
tripwire only fires on code that runs. A probabilistic branch in a seeded, fixed-count loop is not
covered just because the file it lives in is. If you add a scenario arm behind a `rand()` gate,
check the count is high enough to reach it.

### The strata plan number was wrong — corrected to 2324 (2026-08-16)

It read **2724** in `server/db.ts`, in the live `db.json`, in `STRATA_COMPLIANCE.md` and throughout
this file. It is **2324**, confirmed by Ro against the owners' AGM report
(`docs/Villaggio_Del_Sol_Owners_Financial_Report_2027.pdf`), which carries it on all eleven pages.

This was on the letterhead of every printed document and in the header of every statutory return.
Corrected in all four places; `db.json` was backed up to `db-backups/db.json.pre-2324-*` first.
`bodyCorporateName()` reads it from settings, so every screen picked the change up at once.

**If it ever moves again, change it in System Settings** — the value in `server/db.ts` is only the
default for a fresh database and will not touch a live one. `loadDb()` merges stored settings *over*
the defaults, so a live `db.json` keeps whatever it already holds. **This cuts both ways: the HP's
own `db.json` is not corrected by installing a new build.** It must be changed in System Settings on
the HP, or it will go on heading statutory returns with the wrong plan number no matter what the
source says.

### Financial Projections and USD — not a bug (2026-08-16)

Ro asked why Projections only shows Jamaican Dollars when rent, maintenance and short lets are
sometimes taken in USD. **The screen already builds both currencies and always has**, then drops
either one that has no activity (`active` in `Projections.tsx`). USD is empty because:

- **Every villa is assessed maintenance in JMD** (`maintCurrency: 'JMD'` on all sixteen). Villa A1
  is USD 1,000 rent but JMD 25,000 maintenance.
- **Projections is maintenance-only by design.** Rent and short-term income are excluded, so A1's
  USD rent never reaches it.

A USD card will appear on its own the moment a villa is assessed maintenance in USD. **Ro decided
2026-08-16 to leave the scope as it is** — maintenance contributions versus common-property
expenditure, which is what the corporation actually forecasts, and what the AGM report is stated in.
Offered and declined: projecting rent and booking income for the villas VDS lets on its own account.
Do not widen this without being asked.

### Property health grade — dashboard, built 2026-08-16

One letter on the dashboard for "is the property being run well", from four things the ledger
already knows: **collection** (35), **cost coverage** (30), **debt ageing** (20), **cash position**
(15). `operationalHealth()` in `finance.ts`, `HealthCard` in `Dashboard.tsx`, 27 tests in
`health.test.mjs` plus 8 render checks in `components.test.mjs`.

**A single letter is the most dangerous figure on a dashboard** — it is the one nobody checks,
because checking it means reconstructing it. So three rules are load-bearing and all three were
mutation-tested:

1. **It shows its working.** Every component prints its own score, its weight and the figures behind
   it, and the grade is exactly their weighted mean. Reproducible by hand. The bar is a *second*
   reading of the table, never the only one — same invariant as every chart here.
2. **A component that cannot be measured is excluded and the weights renormalised — never scored
   zero.** A property that has billed nothing has not failed at collection, and grading it E would
   have somebody acting on an empty month. Same principle as `entitledUnits`.
3. **Nothing measurable at all returns `null`**, and the card says so, rather than printing an E.

Collection is capped at 100 (a rate above it is arrears catch-up, not performance, and letting it
run over would mask a weak component elsewhere). Graded per currency like everything else.

The grade boundaries live in `gradeFor()` and are printed on the card, so the UI cannot disagree
with the engine.

**It can be switched off** — System Settings → General, "Show the property health grade". Stored as
`hidePropertyHealth` on `AppSettings`: **the negative, deliberately.** Live databases exist that
were written before this field, and `undefined` has to mean *shown*, or upgrading would silently
strip the card from every installation. Anything reading it must treat absent as on. Six tests cover
the round trip, including that saving an unrelated General setting does not disturb the choice and
that only a genuine boolean turns it off.

### The annual report — built 2026-08-16

**There are two annual reports and they are different documents.** Ro made this explicit on
2026-08-16 and the distinction is now in the code:

- **Forms 13A/13B/13C** — the statutory filing to the Commission, keyed by strata lot: what each
  proprietor owes, aged. Compute engines exist in `finance.ts`; the export UI is still unbuilt.
- **The annual report** (sidebar: *Annual Report*) — circulated to proprietors before the AGM. **Identical for every
  owner, carrying nothing personal.** Ro: *"it has to do with how the property is run, not their
  unit nor their finances."* No balances, no arrears by name. **Do not merge owner data into it.**
  The same figures are the basis of what goes to the Commission.

Reference document: `docs/Villaggio_Del_Sol_Owners_Financial_Report_2027.pdf` — the 2026 report,
the model this was built from. Read it before changing the shape of the document.

**The vocabulary is the property's, not an accountant's. Read this before touching the engine.**

- **"Maintenance collected"** = the contribution × villas. $20,000 × 16. It is **assessed** income
  taken at full value — a proprietor is obliged by law to pay, so the document does not discount it
  for arrears. (Ro, asked directly: *"the proposed fee assumes every owner pays, because by law they
  MUST pay."*) Arrears are chased through Form 13B, not by shrinking this line.
- **"Billed"** = what the *property* was invoiced. Its expenditure.
- **The gap** between them is the shortfall, and sizing it is the whole purpose of the document.

**There are two levers and the report shows both**, because the second is what the meeting turns to
when it refuses the first (Ro: *"if the owners do not agree, then something like security can be
removed as an expense to fall within what the total maintenance can cover"*):

1. **Raise the contribution** — `feeToCoverBudget`.
2. **Cut the expenditure** — `expenditureCeiling`, `reductionRequired`, and `cutsThatWouldClose`,
   which names the categories large enough to close the gap on their own.

A report that only argued for an increase would have no answer at the meeting. Do not remove lever 2.

**It is a form, not a document editor, and that is the safety property.** The figures, tables and
month-by-month are generated from the ledger into fixed slots; eight named narrative boxes
(`ANNUAL_REPORT_SECTIONS` in `types.ts`) are the only things typed. Nobody can type over a number,
so the arithmetic in the printed document is always the arithmetic in the books. **The 2026 report
needed a whole corrections log (Appendix A) because percentages were typed beside figures that did
not produce them** — a free canvas reintroduces exactly that. If asked for rich text, say no and
explain why.

Narrative and budget persist **per year**, so opening 2028 starts from 2027's wording with every
figure recomputed. Figures are never stored — a corrected receipt reaches the report without anyone
reopening it.

**The budget.** `budgetByCategory` holds next year per expenditure category; **a category left out
falls back to this year's actual**, so an untouched budget is a flat run-rate, never zero. `0` is a
meaningful value — it is how a service is cut — so the route uses `optionalAmount`, not
`requirePositiveAmount`. Clearing a line (`null`) removes the override.

**The contribution comes from the Units Register and nowhere else.** `feeBilled` reads
`monthlyMaintenance` off each unit via `chargeAmount()`. Ro, 2026-08-16: after the meeting votes,
the fees are changed by hand in the Units Register and the report follows. There is deliberately no
separate "fee" setting to drift out of step with the units.

**Excel export** (`Export figures`) carries the **narrative as well as the figures**, so a document
can be finished or adjusted outside the application without retyping the wording. Amounts are
exported unformatted (`1976334`, not `J$1,976,334.00`) so Excel reads them as numbers; currency is
stated in the header instead. BOM CSV, same pattern as Projections and Owner Statements.

Where things live: `annualOwnersReport()` in `finance.ts`; `AnnualReport` type and
`ANNUAL_REPORT_SECTIONS` in `types.ts`; `db.annualReports` (migrated in, added to `/api/db`);
`PUT /api/annual-reports/:year` gated on `post_charges`; `src/components/AnnualReport.tsx`;
73 tests in `test/owners-annual-report.test.mjs`.

**Two bugs found by verifying in the browser, both invisible to the tests that existed:**

1. **`/api/db` never returned `annualReports`.** The report saved to disk and audited correctly, but
   came back blank on the next load, so the printed document had no narrative in it. Every unit test
   passed throughout — the arithmetic was never the problem. There is now a **round-trip test**, and
   it was mutation-tested: removing the field again fails 11 checks. **Any new top-level collection
   needs the same treatment — `/api/db` is a hand-written projection, not a dump.**
2. **The allocation table did not add up.** It printed `4,843,030.00 + 916,968.96` against a stated
   total of `5,760,000.00` — short by 1.04, because the reserve was the *rounded* per-villa figure
   multiplied back across sixteen villas and twelve months. `reserveAnnual` is now the residual
   (`proposedAnnualCommunity - budgetExpenditure`), and a test asserts the column sums **exactly**,
   not nearly. This is the table an owner adds up with a pen.

3. **The recommended contribution could round *down*.** `feeToCoverBudget` used a plain round-to-
   cent, so half the time it raised slightly less than the budget and the report stated a shortfall
   against the very fee it had just recommended. It now rounds **up** to the cent, computed in one
   step rather than from an already-rounded annual figure. A property-based test runs 400 different
   budgets and asserts the fee never under-covers and the allocation column always balances.

**Still open, and worth asking Ro:** the app has no *budget* concept beyond this screen — next
year's figures are keyed in per category here and live only on the report record. If budgeting ever
needs to drive anything else (Projections, a variance report), it should move into its own model
rather than being read out of the AGM document.

### Full-data simulation pass — 2026-08-16 (third)

Ran the whole suite plus a deep pass at `VDS_SCENARIOS_FULL=500`. **1,030 tests pass at the committed
defaults and at 500. No integrity violation in any scenario.**

**First, a gap that was closed:** the 400-scenario reporting audit did not touch either engine built
this session. `annualOwnersReport()` and `operationalHealth()` are now audited after **every one of
the 400 scenarios**, and two new scenarios drive `PUT /api/annual-reports/:year` (including a
year that cannot exist, an unknown narrative section, a cleared budget line and a line budgeted at
zero) and toggle the health setting mid-flight.

**Three defects found, all by the simulation, none by a unit test.**

1. **The headline shortfall did not reconcile.** `annualCommunityPosition` was the *rounded*
   per-villa position scaled across sixteen villas and twelve months, so it did not exactly equal
   `contributions − expenditure` — the subtraction a proprietor does to check the figure. Now the
   residual, pinned by an exact-equality test and a 400-budget property test. Same class as the
   `reserveAnnual` bug; if you add another per-villa figure that is also stated annually, **derive
   the annual one by subtraction, not by multiplication.**

2. **A scenario branch stopped firing when the scenario count changed.** One utility scenario left
   readings unpaid on `i % 3 === 0`. A scenario only runs when `i % scenarios.length` selects it, so
   `i % n` is **constant** for that scenario whenever `n` divides the scenario count. Adding two
   scenarios took the count to 24, and the branch went from firing sometimes to never. **Never gate
   a scenario's internal branch on `i` — use the seeded `rand()`.**

3. **The same arithmetic froze the month for every scenario.** `monthOf(i)` cycles every twelve, so
   at a scenario count that is a multiple of twelve *every run of a given scenario lands in the same
   month*. Records that dedupe per period collapsed: meter readings fell from dozens to **ten, all
   settled**, and the suite went on asserting coverage it no longer had. The month is now taken from
   the repetition number (`Math.floor(i / scenarios.length)`), which varies whatever the count is.
   Fixed in all three scenario suites.

**Two guards were added so this cannot regress silently**: the simulation must reach at least six
distinct billing months and four distinct meter periods. Both would have failed on the broken build.

**The lesson, and it is the third time this session:** a green suite proves the assertions ran, not
that they still mean anything. Coverage assertions need their own guards. Anything derived from the
loop index is coupled to the scenario count, and adding a scenario silently re-rolls that coupling.

### Closing the untested gaps — 2026-08-16 (fourth)

Asked directly what had *not* been tested, and the answer was checked against the suite rather than
recalled. Four gaps were real and are now closed:

- **Permissions on the annual report.** `PUT /api/annual-reports/:year` is gated on `post_charges`,
  but nothing proved a junior was refused — every other write route had that test. Four checks in
  `permissions.test.mjs`: a junior cannot write it, cannot set the contribution it proposes, leaves
  nothing behind when refused, and somebody who posts the charges can.
- **The annual report through a backup and a restore.** The narrative is the only thing in this
  application that exists nowhere else — every figure recomputes, the wording does not — so losing
  it in a restore would be silent and permanent. `restore.test.mjs` now writes a report before the
  backup and proves the wording, the budget (including a line deliberately at zero), the proposed
  contribution and the meeting date all come back.
- **Concurrency.** A 20-way race on the same year settles to exactly one record, and the winner is
  one officer's document rather than two stitched together — the summary and the fee must come from
  the same write.
- **Mobile.** Both new screens verified at 375px. The page never scrolls sideways; the budget table
  is wider than the screen and scrolls **inside its own container**, which is the house pattern.

**Cosmetic, known, and left alone:** with the proposed contribution left blank the report defaults it
to the requirement, and because that figure is rounded *up* to the cent the year raises about a
pound more than the budget — so the reserve reads `J$0.00` per villa monthly and `J$1.00` annually.
Both columns still add up exactly, which is the invariant that matters. Do not "fix" it by
multiplying the per-villa figure back up: that is the bug that was removed twice already.

**Still never exercised by anyone** — unchanged, and no test here can close them: the Windows `.exe`
outside CI, the PWA and service worker, the offline queue under real network loss, a live Airbnb
feed, the two-PC dry run, real print output on paper or in a PDF, and the Excel export actually
opened in Excel. **And the largest one: none of this has met real data.** Every figure demonstrated
so far came from a seeded property. The annual report has never been run against Villaggio Del Sol's
actual expenditure, and the Excel migration has not been dry-run.

### Built-in safeguards — 2026-08-16 (fifth)

Asked to make sure the safeguards are **built in**, not merely tested. That is a real distinction:
the suite proves the code was right when it ran on a developer's laptop; it says nothing about the
file on the HP after a year of use, a restore from a USB stick, or a disk returning bad sectors.
Three gaps were found and closed.

**1. The records now check themselves, on the machine that holds them.**
`server/integrity.ts` walks the live database and reports every contradiction: a receipt number
issued twice, money received with no receipt, a receipt both voided *and* refunded, a month billed
twice, a villa sold to two guests on one night, a deposit settled beyond what was held, one job's
cost reaching the register twice, a monthly cost posted twice, a meter running backwards, a record
pointing at a villa that is no longer on the register, and a receipt counter that has fallen behind
what has already been issued. Runs **at startup** and on demand from **System Settings → Backup &
recovery**.

Four rules it lives by, and they are not negotiable:
- **It never repairs.** An automatic fix to a ledger is a second, unaudited author of the accounts.
  It names the records and lets a person decide.
- **It never throws and never refuses to start.** A property that cannot take a payment this morning
  is worse than one running on records with a stated fault.
- **It never cries wolf.** Verified clean against the database 400 scenarios of refunds, voids,
  part-payments and cancelled stays build — a check that fires on a healthy property is ignored
  within a week, and the real finding is ignored with it.
- **Serious and warning are separated.** Serious means money is misstated.

41 tests in `self-check.test.mjs`, each invariant proved against a database broken in exactly that
way, plus malformed input, plus a live server. Verified by hand too: a copy of a real database was
deliberately corrupted four ways and all four were caught and displayed.

**2. A database from a newer build is now refused.** `readFromDisk` used to load *any* schema version
and stamp its own on it. Restoring a post-upgrade backup onto an older `.exe` — exactly what somebody
does in a hurry the morning the disk dies — would have read the file with the wrong assumptions and
written it back silently damaged. It now refuses with an instruction to install the current version.
Older files still migrate forward as before; only *newer* is refused.

**3. Dependencies are gated in CI.** `npm audit --omit=dev --audit-level=high` now runs before the
suite in `build-exe.yml`, so a release cannot be built carrying a known high or critical advisory.
Dev-only advisories deliberately do not fail the build — they are not shipped inside the `.exe`, and
failing releases over them trains people to ignore the step. `npm run lint` (typecheck) was added
ahead of the suite for a faster, clearer failure. `npm ci` was already installing from the lockfile.

**Two bugs in the safeguard itself, both worth remembering:**
- The typechecker caught that a voided payment carries `status: 'reversed'`, not `'void'`. Had it
  compiled, that check would have passed on every database forever.
- The receipt-counter check read `R-2026-0001`; the real format is `REC-2026-0001`. It matched
  nothing, so it silently passed on every property that had ever issued a receipt. Found only by
  running it against a real database. **A guard that cannot fire is worse than no guard, because it
  is counted as coverage.** The test now pins the real format.

### Where to pick up

⚠️ **Install v1.13.1.** It is the current release and contains everything before it: the
Strata / ISPO / Everything book filter on Operational Reports, reservation deposits reaching the
receipts ledger as received, the duplicate-deposit check, real arrivals and departures on the
dashboard, the currency pill on a one-off charge, taking a cost back, the two books (the
corporation's money separated from ISPO's), the ISPO Operations statement, the printed-signature fix,
the shortfall report, the five faults found on real data, the split occupancy figures and the
proprietors' monthly report.

⚠️ **Not v1.13.0.** That tag exists and has no `.exe` behind it — see *State right now*.

⚠️ **Two of the steps below are new and nothing guesses them.** Until they are done, two screens read
as though they are broken when they are simply waiting: costs still count as the corporation's until
they are marked as ISPO's, and the ISPO statement's maintenance line reads nil until the own-account
villas are ticked. The screen says so rather than showing a silent zero.

**A. Mark the ISPO costs — once.** The cell phone, the company vehicle and its insurance. Either edit
each in Utilities & Expenses → Expense register (the **Paid from** cards, "Rental income (ISPO)"), or
set it on the monthly cost so every future run posts it to the right book on its own. Everything else
— office, property electricity, grounds staff, pool, painting — is already the corporation's and
needs nothing.

**B. Tick "Let on the corporation's own account"** in the Units Register on the villas VDS lets. The
shortfall report and the ISPO statement's contribution line both depend on it, and nothing infers it
from an owner's name.

**1. Install v1.13.1 on the HP. It was last confirmed on v1.9.0.** Download `Villaggio-Del-Sol.exe` from
`https://github.com/vildelsol/VDS_1/releases/latest`, close the running program, drop the new file
**in the same folder**, replacing the old one, and double-click it.

**Then confirm it took — and confirm it the right way.** The v1.10.0 upgrade was correct and looked
like a failure because the only check available read from a browser cache. In order of trust:

   - **The black console window** now prints `Villaggio Del Sol operations server v1.13.1 running
     at …` and, underneath, `Records folder: …`. This is the program speaking; nothing caches it.
     **Read the folder line too** — if it is not the folder the records have always been in, the
     program is looking at a different (probably empty) set of books, because the data folder is the
     working directory and not the executable's folder. Close it and start it from the right place.
   - **`http://localhost:PORT/api/health`** in a browser returns the version as well.
   - **The sidebar and sign-in screen** show the page's own version, and from v1.10.1 onwards the server's
     beside it when they differ, plus a banner saying so. Trust this *last*: it is the thing that was
     lying.

Then on the Kamrui and any phones: **Ctrl+Shift+R**; if the old version persists, F12 → Application →
Service Workers → Unregister, then reload. The banner will tell you when this is needed.

**2. Two setup steps only Ro can do, and two screens are wrong-looking until he does.** Neither is a
defect and both are deliberate — nothing is guessed from a name or a status — but both are invisible
unless somebody says so.

   - ⚠️ **Tick the villas VDS lets on its own account.** Units Register → open the villa → **"Let on
     the corporation's own account"**. Nothing is ticked by default, and until at least one is, the
     out-of-pocket shortfall report correctly says *"No villa is marked as let on the corporation's
     own account"* rather than reporting zero. That is a different message from "nothing to report",
     deliberately. `letOnOwnAccount` is absent on every record written before v1.11.0, and **absent
     means no** — claiming villas that are not VDS's would overstate the one figure the report exists
     to state.
   - ⚠️ **Set every villa VDS rents out short-term to "Short-term / Airbnb".** From v1.11.1 that
     status decides **three** things at once: whether the villa can take a guest reservation (the
     server refuses anything else, naming the status it is actually in), whether it appears anywhere
     under Short-Term Bookings, and whether it counts in the short-let occupancy figure. **A villa
     left as `vacant` will refuse reservations** — which is correct, and will look like a bug to
     anybody who has not been told.

**3. Ro is rebuilding the database from scratch, with a start date of 1 September 2026.** Decided on
2026-09-01, after the currency and owner-statement faults were found in the first real data. This
changes what has to be done and in what order.

**On the fresh database, before anything else:**

   - **"The books begin on" `2026-09-01`**, in System Settings → General. **Enter this before
     creating a single villa.** A brand-new database has it **empty** — it is not defaulted, and
     nothing prompts for it. ⚠️ **This cost Ro an evening on 2026-09-01.** He rebuilt the database,
     entered a villa at J$80,000 and a tenancy with its real move-in date of 7 February 2009, and the
     ledger read **J$160,000 outstanding**. Nothing was wrong: `raiseFirstAndLastRent` bills the first
     month and the last month held in advance, and its only guard is
     `if (booksBegin && month < monthOf(booksBegin)) return false` (`server.ts:1157`) — with the field
     empty, the guard never fires and a 2009 tenant is billed two months dated 2009-02. Reproduced
     both ways through the real API: empty gives 160,000, set to `2026-09-01` gives nothing.
     **The remedy, if it happens again**, verified end to end: set the date, then void both charges
     from the **Charges** button on the villa's ledger row. The tenancy keeps its real start date, the
     self-check stays clean, and a later move-out copes with the voided advance — checked, because the
     tenancy still references it. Voided charges cannot be un-raised any other way; setting the date
     afterwards does not remove them.
   - **The strata plan number needs nothing done to it, and cannot have anything done to it.** A
     brand-new database takes the default `2324` on its own, and there is no field for it in the
     settings screen — see the state section above. **Print a letterhead and read the plan number
     off the paper**; that is the only check available, and nobody has ever done it.
   - **Set each villa's currency correctly before posting the first month.** This is the fault that
     bit C11: re-denominating a villa after charges exist strands every one of them. v1.10.0 refuses
     that edit unless the consequence is acknowledged, so it can no longer happen silently — but
     getting it right up front avoids the whole conversation.
   - The books-begin date is load-bearing, not cosmetic: it governs billing as well as alerts, and it
     is what stops `raiseFirstAndLastRent` billing a long-standing tenant for months dated before the
     books open.

**Then the migration itself**, in this order:

   - Enter tenancies with **real start dates**. Safe, with 158 checks behind that claim.
   - Record security deposits on the tenancies that have them.
   - Key each owner's carried-over maintenance as an **Opening balance** charge, **dated to when it
     actually fell due**, not to 1 September. The balance is the same either way; the ageing is only
     right if the date is, and Form 13B depends on that ageing.
   - Then verify: arrears match Excel, the ageing buckets look right on the Charts tab, and
     **System Settings → Backup & recovery → Check now** reports no contradictions.
   - **Correcting a mistake is a supported path, not a hazard.** A mistyped tenant or owner name asks
     whether it is a correction or a real change; a charge raised in error is voided from the
     **Charges** button on its ledger row.

**4. Tell whoever keys the costs two things**, or the operations statement will not see them:

   - **Fuel, grounds staff and pool chemicals must be allocated to `General`** (or `Office`), not to a
     villa. Anything tied to a villa is treated as recharged to that proprietor — it is still counted
     and declared as an exclusion, so it is visible rather than lost, but it will not be in the
     common-costs total.
   - **There is no `Fuel` category, and no `Telephone` one.** Fuel goes under `Supplies` or `Other`;
     electricity, water and phone/internet all go under `Utilities`, which is itemised by supplier on
     the operating statement. If the corporation wants those split out, that is a category addition.

**5. Both questions that were with management are now answered** (raised 2026-08-21, answered
2026-09-02). Nothing is outstanding with anybody outside the office:
   - ~~**Do VDS-owned villas record a payment against their own maintenance charge?**~~ **ANSWERED
     2026-09-02 — yes, and the system already works that way.** Ro: *"we do record a payment against
     our own maintenance charge. the system as is is already setup that way."* So a villa VDS owns is
     billed like any other lot and settles like any other lot; the books stay clean and Form 13B shows
     no permanent arrears against those lots. **Nothing to build, and nothing to change** — this is
     recorded so the question is not asked a fourth time. It also means a VDS-owned villa sitting in
     arrears on the ledger is a real unpaid contribution, not an artefact of the model.
   - ~~**Does Ro want an out-of-pocket shortfall report?**~~ **ANSWERED 2026-09-02 — yes, and it is
     built.** Ro: *"Build the shortfall report since it is ready to be built."* Built to the design
     recorded here, unchanged. See **"The out-of-pocket shortfall report — built 2026-09-02"** below
     for what shipped. The design is left in place because it is the specification the code was
     written against. The funding model: on villas VDS lets long-term the maintenance is funded from the rent
     collected, so a vacant villa means VDS pays it out of pocket. The system bills maintenance on
     vacant villas correctly but models **no link** between rent received and maintenance owed.

     **Where it goes:** Operational Reports, below the operating statement, badged **internal**. It is
     *not* a strata document — the operating statement is the corporation's income and expenditure,
     this is VDS's own trading position as a landlord, and putting them on one page confuses two
     entities that must stay apart.

     **What it shows:** one row per villa VDS lets on its own account, per month, **cash basis** —
     occupied days, rent received, maintenance paid, and the shortfall where maintenance paid exceeds
     rent received. Under it, per currency and never combined: *"VDS funded J$X from its own account
     across N vacant villa-months"*, with the vacant months **named**, because the figure is only
     actionable if you can see which villas produced it. Two views off one engine: **by villa** (is
     this villa worth letting?) and **by month** (how much cash did we need to find?).

     ⚠️ **One decision has to come first and cannot be guessed: how does the system know which villas
     are VDS's own?** There is no such field — `unit.ownerName` is free text, and matching on a name
     breaks silently the day somebody types "Villaggio Del Sol Ltd." instead of "VDS". The answer put
     to Ro was **a tick box on the villa register** ("Let on the corporation's own account"): explicit,
     survives a rename, one field. About a day's work all in — the flag, an engine function, a screen,
     an Excel export and tests.

**6. The untested surface is the honest risk, and no simulation closes any of it.** Narrowed again on
2026-09-02 — printed documents can now be rendered and asserted, and 223 of them are, under the
5,000-operation suite — but **no test has ever put ink on paper**, and that is where a regression
slipped through once before:
   - **The `.exe` on the HP itself.** The release workflow now assembles it, **starts it, serves a
     real request and verifies the Desktop shortcut** on a Windows runner — which is much closer than
     before, but a GitHub runner is not a desktop in Ocho Rios.
   - **Real print output on paper or in a PDF.** Every statement has been read as text and as a
     screenshot; none has come out of a printer. This is exactly where a regression slipped through
     once before (the letterhead mark rendered at ~1.5mm and passed every test).
   - **An Excel workbook opened in actual Excel.** The exports are verified by reading the archive
     and the XML the way Excel does, and independently with `openpyxl` — but nobody has double-clicked
     one on Windows.
   - The PWA and service worker, the offline queue under real network loss, a live Airbnb feed, and
     the two-PC dry run.
   - The Annual Report has still never been run against Villaggio Del Sol's actual expenditure.

**7. Offered and not taken up** — build only if asked:
   - **The Forms 13B/13C export.** Deferred by Ro on 2026-08-21 — the statutory return is done by
     hand for now. Engines are built and tested; only the UI and assembly are missing, and it would
     now produce an Excel workbook rather than a CSV.
   - Bulk insurance apportionment (enter the premium, split across villas, edit each line, post).
   - A PDF-diff harness, for the print output nothing else covers.
   - **Somewhere to archive the audit trail.** It is trimmed oldest-first at 20,000 entries and the
     self-check now warns at 90%, but nothing rotates it anywhere. Several years out; still nobody's
     decision yet.
   - **A settings field for the strata plan number and the TRN.** Neither has ever had one. Offered
     on 2026-09-01 and declined — the value defaults correctly on a fresh database, so nothing is
     blocked. Needed the moment the number has to change, or a statutory return needs the TRN.
   - **A grey "not yet due" line on the Dashboard.** Offered 2026-09-02. The dashboard already keeps
     not-yet-due charges out of the arrears card (it passes `today()` to `delinquentAccounts`), so
     nothing reads red that should not — but unlike the Notifications Hub it does not show the
     figure at all. Nothing is wrong; the dashboard is simply silent about what is coming.
   - **A narrative box on the proprietors' monthly report.** It is generated-only today. Adding one
     means a stored record per month and the annual report's discipline: figures in fixed slots,
     wording in named boxes, nobody typing over a number.
   - **Fixing the dead `c.put('/api/settings', …)` idiom** in `operating-statement.test.mjs` and its
     siblings. **There is no GET or PUT on that path** — settings are read from `/api/db` and written
     with `POST /api/settings` — so those lines 404 in silence and configure nothing. The suites still
     pass, because nothing depended on the setting; the shortfall and occupancy suites use the real
     endpoints. Left alone deliberately on 2026-09-02: making a books-begin date actually apply could
     move results in suites that session did not otherwise touch, and that is a change to make on
     purpose.

Otherwise: **no backlog.** No bug is outstanding. Resist finding work here — ask what problem it
solves at this property first.

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
- **Rent is never prorated.** A mid-month move-in is billed the whole month, by policy (2026-08-09).
- **Records and documents stay manual.** The Records & Documents feature was built and then removed
  at Ro's instruction (2026-08-09) — leases are signed physically and the office keeps the paper. Do
  not rebuild it without being asked.
- **Bank reconciliation is a tick, not a CSV import** (2026-08-09). Revisit only with a real
  statement file in hand to test against.
- **Where intent cannot be inferred, the application asks** (2026-08-21). Tenant name, owner name,
  and taking a tenant off a villa all refuse once with a `code` and offer a choice with the
  consequence written on each. **Nothing is preselected.** Do not "simplify" any of these into a
  default or a checkbox — the two answers do different things to money, and guessing is the fault
  they were built to remove.
- **On a sale, the seller keeps their arrears** (2026-08-21). Charges raised while the seller held
  the lot keep their name and go on ageing under it. Form 13B reports what each proprietor owes
  against their strata lot, and moving that debt to the buyer would misstate the return.
- **The Forms 13B/13C export stays manual for now** (2026-08-21). The compute engines exist and are
  tested; the UI and CSV assembly are not built. Ro's decision — do not build it unasked.
- **The corporation does not collect rent for proprietors** (2026-08-16). They let their own villas
  entirely on their own account. The corporation collects maintenance and the insurance share, and
  recharges work it performs. The rent/booking machinery is for **VDS's own villas**.
- **Owners' utilities are their own** (2026-08-16) — metered in their own name, settled directly
  with the utility, never on an owner statement.
- **Insurance is apportioned equally per villa and adjusted by hand** (2026-08-16). Not a formula.
- **Juniors cannot reverse** (2026-08-16, reaffirmed). Void, refund and void-charge all exist and
  are audited; juniors hold only `recordPayments` and `addBookings`. The person taking money does
  not erase the record of it. Toggleable in System Settings if that ever changes.
- **"Rented", not "let" or "occupied"** (2026-08-16), because "Owner Occupied" is already a status.
- **"Powered by ISPO" is a footer credit, never a letterhead** (2026-08-16).
