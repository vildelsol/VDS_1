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

- **735 automated tests pass.** Typecheck clean, build clean, `npm audit` clean.
- Working tree is clean, everything pushed.
- Latest release: **v1.8.1**.
  - `v1.8.1` — USB backup drive detection is now fully automatic. When the Backup & recovery tab
    opens the server enumerates attached drives. If exactly one removable writable drive is found
    and no backup folder is configured, it is selected and saved without any user input. When
    multiple drives are present each shows a single-tap "Use this drive" button that selects, saves,
    and writes the first copy immediately. Previously the user had to type the path by hand.
  - `v1.8.0` — a hardening and confidence release. Backups no longer carry working logins; the
    restore path is tested end to end; a figure is read or refused rather than silently reshaped;
    sign-in no longer leaks which usernames exist; a stay cancelled on Airbnb is now cancelled here;
    and a USB backup drive is detected and followed when Windows moves its letter. 300 simulated
    scenarios across the whole application found no integrity violation. Details in *Hardening —
    2026-08-10* below.
  - `v1.7.0` — double-record guard, recurring expenses, damage deposits, and Tier 5 (bank
    reconciliation, refunds, the proration decision).
  - `v1.7.1` — three bugs the robustness audit found in that Tier 5 code. **Do not deploy v1.7.0**;
    it can leave a receipt worth a negative amount. See *Robustness audit* below.
  - `v1.7.2` — changing a settled receipt's currency now takes an explicit confirmation.

**The audit is finished.** Every tier is closed. There is no backlog: the next thing to build is
whatever Ro asks for, not something on a list in this file.

**The system is live.** As of 2026-08-10 the HP is running v1.8.1, Tailscale is installed and
confirmed working, and remote access from a phone over Tailscale has been tested successfully.

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

- `npm test` — build + full suite (735 checks). Each test file boots its own server on a **temp
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

### Where to pick up

**Nowhere — there is no backlog.** The audit is finished. The next thing to build is whatever Ro
asks for.

Resist the urge to find work here. Two things this file would previously have pointed at are now
settled decisions rather than gaps: **records/documents stay manual**, and **rent is never
prorated**. Both were Ro's calls, made explicitly. Treat a new idea the same way the closed items
above were treated — ask what problem it actually solves at this property before building it.

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
