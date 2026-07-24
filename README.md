# Villaggio Del Sol — Property Operations

Internal property-management system for the 16-unit gated residence at Ocho Rios, St. Ann, Jamaica.

Handles long-term tenancies, owner HOA maintenance accounts, short-term guest reservations,
metered utilities, property expenses, receipts, and printable statements — in both JMD and USD.

---

## Running it

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>.

**On the very first start**, an administrator account is created and its password is printed
once to the server console:

```
========================================================================
  FIRST RUN — an administrator account has been created.
    username: admin
    password: VdsAdmin-xxxxxxxx!
  You will be required to change this password at first sign-in.
========================================================================
```

Copy that password before the console scrolls. You will be forced to replace it at first sign-in.
To choose the initial password yourself, set `VDS_ADMIN_PASSWORD` before the first start.

Once signed in, create a real account per member of staff under
**System Settings → Staff accounts**, and stop using the shared `admin` login for daily work —
the audit trail is only meaningful when each action is attributable to a person.

### Production

```bash
npm run build
NODE_ENV=production npm start
```

| Variable             | Purpose                                                       |
| -------------------- | ------------------------------------------------------------- |
| `PORT`               | Listening port (default `3000`)                                |
| `NODE_ENV`           | Set to `production` to serve the built bundle instead of Vite  |
| `VDS_DATA_DIR`       | Where `db.json` and `db-backups/` live (default: process cwd)  |
| `VDS_ADMIN_PASSWORD` | Initial administrator password, first start only               |

**Serve it over HTTPS.** Session cookies are marked `Secure` in production, so sign-in will not
work over plain HTTP once `NODE_ENV=production`. Put it behind a reverse proxy with TLS.

---

## How the money works

Understanding this one rule explains most of the application:

> **Balance = (charges billed) − (payments received)**, per unit, per account, per currency.

* **Charges** are raised by **HOA & Tenants Ledger → Post month**. Until a month is posted,
  nothing is owed for it. Posting is idempotent — posting the same month twice adds nothing.
* **Payments** are receipted against a unit and reduce that unit's balance oldest-month-first.
* Unpaid months therefore **accumulate**: this is what makes arrears and ageing work.
* A negative balance is a **credit** (the account paid more than it was billed).

### Currency

USD and JMD are **never** added together, anywhere. Each unit is billed in its own currency
(rent uses the unit's base currency; maintenance may use a different one). A receipt entered in
the wrong currency is refused with an explanation, and can only be forced through with an explicit
confirmation — in which case it is reported separately as a currency mismatch rather than being
silently netted off.

The exchange rate in System Settings is **indicative only**. It produces the small "≈" figures
next to amounts. It never converts a stored amount and never feeds a total.

---

## Things that are deliberately one-way

These are financial controls, not limitations:

* **Voiding a receipt cannot be undone.** The receipt stays in the ledger marked VOID with the
  reason and the person recorded. To correct a payment, void it and enter a new one.
* **Charges are never deleted**, only voided with a reason.
* **A cancelled reservation cannot be reinstated.** Create a new one.
* **Receipt numbers are sequential and never reused**, including after a restore.
* **Reprints are marked as reprints** and counted.

## Roles

Permissions are set under **System Settings → Role permissions** and are enforced **on the server
for every request** — not merely hidden in the interface. Administrators always hold every
permission. Only Administrators can manage staff accounts.

---

## Booking-platform calendars

**System Settings → Calendar feeds** accepts the `.ics` export URL that Airbnb, Booking.com and
VRBO publish per listing. Syncing genuinely fetches and parses that feed.

What a platform feed contains: **booked dates only**. It does not carry guest contact details or
pricing. So imported stays arrive with a zero stay value that must be entered by hand, and any
event that clashes with an existing reservation is **skipped**, never silently overwritten.
Re-syncing updates dates but leaves what you typed alone.

### Occupancy convention

A stay occupies the nights from arrival up to — but not including — departure. A guest departing
on the 20th and another arriving on the 20th is a valid same-day changeover, not a clash. The
calendar and the availability checker both apply this rule.

---

## Data, backup and recovery

Everything lives in a single `db.json`. That is appropriate at this scale, and it is handled
carefully:

* Writes are **atomic** (temp file, fsync, rename) so a crash or power loss can never leave a
  truncated, unreadable database.
* Every write runs inside a **serialized transaction**, so two staff members saving at the same
  moment cannot overwrite one another.
* A dated copy is placed in `db-backups/` once per day, keeping the last 30.
* If `db.json` cannot be parsed on start, the server **refuses to start** rather than overwriting
  it with an empty database. Restore from `db-backups/` and restart.

**`db.json` contains live financial records. Back it up off this machine.**

### Schema migration

On start, an older database is migrated in place and every repair is written to the audit trail.
The notable one: records used to reference a unit by its *display number*, so renaming a unit
orphaned its financial history. Records are relinked to a stable unit id, and the unit label now
cascades on rename.

---

## Project layout

```
server.ts              API routes, validation, permission checks, audit writes
server/db.ts           persistence, atomic writes, transactions, migration
server/auth.ts         password hashing (scrypt), sessions, permission matrix
server/ical.ts         iCalendar fetch and parse
src/lib/money.ts       all monetary arithmetic and formatting
src/lib/dates.ts       calendar-day maths (timezone-safe)
src/lib/finance.ts     the single source of truth for every balance shown
src/lib/api.ts         one HTTP client, one place errors are parsed
src/components/        one file per screen, plus ui.tsx and PrintPortal.tsx
```

`src/lib/finance.ts` is the important one. Every screen computes balances through it, so the
dashboard, ledger, notifications and reports cannot drift apart.

---

## Known limitations

* **No attachments.** Invoices and receipts are referenced by number; file the paper against that
  reference. There is no document upload.
* **No email or SMS.** Notices are surfaced in the app; sending them is a manual step.
* **Single property.** The data model assumes one property with one set of units.
* **No refund instrument.** A refund is recorded by voiding the receipt; there is no separate
  outbound-payment record for the cash returned.
* **Rent proration is not modelled.** A mid-month move-in bills the whole month; adjust with a
  charge void and a manual entry.
