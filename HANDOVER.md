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

- **1,087 automated tests pass.** Typecheck clean, build clean, `npm audit` clean. A full run
  simulates **800 audited scenarios** (200 ledger + 200 whole-application on full data + 400
  reporting), and the application now checks its own records at start-up as well.
- ⚠️ **There is a large body of uncommitted work — the only copy is on Ro's Mac.**
  **18 files modified (+1,843 lines) and 6 added (~2,390 lines)**, none of it committed. It includes
  the Annual Report, the property health grade, the integrity self-check, and a correction to the
  strata plan number that **also edited the live `db.json`** (backed up first to
  `db-backups/db.json.pre-2324-*`). Read *Sessions of 2026-08-16* below before touching anything.
- **`main` and `origin/main` are level** at `413de34` — verified against the remote with
  `git ls-remote`, not from a local ref. *Earlier versions of this file claimed `main` was one
  commit ahead and unpushed; that was stale and wrong.* Nothing is waiting to be pushed. The only
  thing not on the remote is the uncommitted work above.
- Latest release: **v1.8.1**. The pushed commit is unreleased and none of the uncommitted work is
  live — no tag, no build shipped to the HP.

**There is no known outstanding bug.** Everything found during 2026-08-16 was fixed in the same
session and carries a regression test. What is genuinely open is *untested surface* and the Excel
migration — both listed under *Where to pick up*. Do not go hunting for a bug list; there isn't one.

**The system is live.** The HP runs v1.8.1, Tailscale is installed and remote access from a phone
is confirmed.

### Migration from Excel — planned, partially enabled (2026-08-16)

Ro is migrating from Excel with a cutover of **1 September**. This is the next real piece of work
and the enabling parts are built:

- **Tenants owe nothing at cutover.** Nothing to carry across for them.
- **Owners DO owe maintenance.** Ro keys these in by hand.
- **Deposits are held for some tenants** and must be recorded on the tenancy so they are not lost.

Three things exist to make this safe:

1. **"The books begin on"** — System Settings → General. Set it to `2026-09-01`.
   Without it, entering a tenancy with its real start date (some tenants are years-standing) makes
   `unbilledOccupancy` report *every month back to that date* as unbilled — hundreds of false
   alerts that bury the real ones. It does **not** hide a month after the cutover that was
   genuinely missed; that is tested.
2. **`Opening balance`** one-off charge type — for keying each owner's carried-over arrears.
3. **`Insurance share`** one-off charge type — for the annual apportionment, adjustable per villa.

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

- `npm test` — build + full suite (1,087 checks). Each test file boots its own server on a **temp
  data dir**, so tests never touch the real `db.json`.
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
git tag -a v1.8.2 -m "…" && git push origin v1.8.2
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

## Built so far (all tested; the 2026-08-16 second session is **not yet committed** — see *State right now*)

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
- **The records check themselves** (2026-08-16, uncommitted) — `server/integrity.ts` walks the live
  database at start-up and on demand from **System Settings → Backup & recovery → Check now**, and
  reports anything that contradicts itself. It never repairs, never refuses to start, and is proved
  not to cry wolf against a 400-scenario database. See *Built-in safeguards* below.
- **A database from a newer build is refused** (2026-08-16, uncommitted) — restoring a
  post-upgrade backup onto an older `.exe` used to load it and stamp the old version on it. Older
  files still migrate forward; only newer is refused, with an instruction to install the current
  version.
- **Dependencies are gated in CI** (2026-08-16, uncommitted) — `npm audit --omit=dev
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

**What remains — the Annual Report export (next task):** build a CSV/Excel download that
assembles the full annual return for the Commission. It should have:

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

A long session. Everything below is **staged, not committed**.

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

## Sessions of 2026-08-16

Two sessions ran on this date and they are recorded separately.

**The first** is the commit *"Brand the app, add management reporting, and prepare the Excel
migration"* — pushed, and written up under *Session 2026-08-16* above.

**The second is everything below, and it is all uncommitted.** It ran in five passes, each of which
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
default for a fresh database and will not touch a live one.

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

**1. Commit the outstanding work, then push.** This is the first thing, and it is not optional
housekeeping: a session's worth of work exists only on Ro's Mac, and a disk failure loses it. Ro
reviewed it on 2026-08-16 and asked to commit in a following session — confirm that is still what
they want, then commit and push. `main` is already level with the remote, so this is one commit and
one push. Decide separately whether it is tagged and shipped to the HP, or held until after the
migration.

**`db.json` is gitignored and is never committed** — it holds the property's financial records. The
strata plan number correction edited it directly on this machine (backed up first to
`db-backups/db.json.pre-2324-*`), so that change is **local only**: any other machine picks up the
corrected number from the new default in `server/db.ts`, or by setting it in System Settings.

**2. Nothing is known to be broken.** Every defect found on 2026-08-16 was fixed with a regression
test — see the five session notes below for what they were and why they mattered. If the next
session opens expecting a bug list, there is none. The real work is 3 and 4.

**3. The untested surface is the honest risk, and no test here can close it.** Never exercised by
anyone: the Windows `.exe` outside CI, the PWA and service worker, the offline queue under real
network loss, a live Airbnb feed, the two-PC dry run, real print output on paper or in a PDF, and
the Excel export actually opened in Excel. **And the largest: none of this has met real data.**
Every figure demonstrated so far came from a seeded property. The Annual Report has never been run
against Villaggio Del Sol's actual expenditure.

**4. The Excel migration is the live piece of work.** Cutover 1 September. See *Migration from
Excel* under *State right now*. The enabling parts are built; the data entry and a dry run are not.
Suggested order:
   - Set **"The books begin on"** to `2026-09-01` in System Settings → General.
   - Enter tenancies with **real start dates** — that is now safe.
   - Record security deposits on the tenancies that have them.
   - Key each owner's carried-over maintenance as an **Opening balance** charge, **dated to when it
     actually fell due**.
   - Then verify: arrears match Excel, the ageing buckets look right on the Charts tab, and
     **System Settings → Backup & recovery → Check now** reports no contradictions.

**5. Offered and not taken up** — build only if asked:
   - Bulk insurance apportionment (enter the premium, split across villas, edit each line, post).
   - A PDF-diff harness. Real print output is the one thing no test here covers, and it is exactly
     where a regression already slipped through once (the letterhead mark rendered at ~1.5mm and
     passed every test).

Otherwise: **no backlog.** The audit is closed and no bug is outstanding. Resist finding work here —
ask what problem it solves at this property first.

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
