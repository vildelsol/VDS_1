# Testing & pre-deployment checklist

## Automated tests

One command, works the same on macOS and Windows (needs Node 18+):

```
npm test
```

This builds the app and then runs the suite in `test/`. Each test file boots its
own server on a throwaway temporary folder, so **the tests never touch your real
`db.json`**. A non-zero exit code means something failed; the failing checks are
listed at the end.

To run the tests without rebuilding first (when you have already built):

```
npm run test:run
```

### What is covered (735 checks)

- **Authentication & sessions** — unauthenticated access is refused, passwords are
  checked, the session cookie is `HttpOnly; SameSite=Strict` (and not `Secure`
  over plain HTTP so LAN sign-in works), a forced password change is enforced by
  the server, the sign-in throttle cannot be bypassed with a spoofed
  `X-Forwarded-For`, deactivating a user kills their live session, and logout
  invalidates it. A wrong password takes the same time whether or not the account
  exists, so the clock cannot be used to map which usernames are real. A failed
  sign-in is recorded on the audit trail — never with
  the password that was tried — but recording it can never become a way to
  *erase* the trail: a run of guesses is one line rather than one line each, and
  a flood from many usernames is capped, says plainly that it stopped listing
  them, and leaves the genuine history underneath intact.
- **Ledger, receipts & void integrity** — negative / future / oversized /
  wrong-currency payments are refused, receipt numbers are unique, and the
  duplicate-ID bugs stay fixed (voiding then re-posting a charge, re-settling a
  utility, and restoring a booking deposit each produce a *new* record rather than
  a second row that can never be voided).
- **Role permissions** — `recordPayments` is granted by default, can be withdrawn
  in Settings, closes the utility-settle side door when withdrawn, and can be
  granted back; juniors stay blocked from senior actions; admins are never gated;
  every settings change is audited.
- **Data integrity & durability** — a rejected update leaves nothing behind (in
  memory or on disk), 20 concurrent writes all persist with unique receipts/ids,
  `db.json` is never observed half-written, impossible dates are refused, and
  basic input hardening holds.
- **Unreadable figures, replayed keys & impossible rates** — a figure is either
  understood or refused, never quietly reshaped: `50,000`, `$50,000`, `12 000`
  and `1,234.56` are read as written, while `1.500.000`, `1e999`, `50000abc` and
  `5-0-0` are refused with a message saying how to write it. The same grammar
  holds where a figure is optional, so an unreadable rent is refused rather than
  stored as `1.5`, and an omitted one still means "leave it as it was". An
  idempotency key is scoped to the account that sent it — the same key from
  someone else does its own work, while a genuine replay by the same account is
  still exactly one action. The exchange rate is held to a band a real rate could
  occupy.
- **Money arithmetic & currency separation** — the sums themselves, tested
  directly rather than through the API, because the figures the business acts on
  are computed in `src/lib/` and most of that runs in the browser where no test
  had reached it. Money does not drift: a hundred cents make exactly one dollar,
  and a total is the same whichever order the rows are added. USD and JMD never
  meet — a USD receipt does not pay down a JMD account (it is surfaced as a
  mismatch instead), and no total is ever the sum of both. A statement closes at
  opening + charged - paid, the next month opens where the last one closed, and a
  July receipt refunded in August moves August without restating July.
- **Calendar feed SSRF guard** — feed URLs pointing at loopback / private /
  link-local / CGNAT / IPv6-internal addresses are refused; public ones are
  accepted.
- **Received vs. expected money** — a recorded payment starts as pending, carries
  no receipt number and moves no balance; confirming it issues exactly one receipt
  number, records who received it, and only then reduces the balance. A payment
  entered as *received* (the "Receive payment" button on an arrears alert)
  completes in one step and clears the alert. Settling a utility leaves the bill
  unpaid until its receipt is confirmed.
- **Administrator password recovery** — a restart with no marker file changes
  nothing; a marker file resets the password, prints it once, forces a change,
  kills sessions from before the reset, and is recorded in the audit trail; an
  unmatched username is a safe no-op.
- **Off-machine backup target** — a folder chosen in the app receives a real,
  parseable copy with no half-written file left behind; an unplugged drive neither
  breaks a backup run nor loses the setting.
- **Finding and following the backup drive** — the drives attached to the server
  are listed with what each would be used for and whether it can be written to
  right now; the machine's own disk is identified by device rather than by name,
  so it is never offered as an "off-machine" copy, and hidden system volumes are
  not offered at all. Choosing a drive marks its folder with an id, so when the
  saved path stops answering — Windows hands a stick a different letter depending
  on what was plugged in first — the drive is found again wherever it turns up,
  the copy still lands on it, and the new location is written down and audited.
  Only settings-holders may enumerate the server's drives.
- **Restoring from a backup** — the whole disaster, end to end: `db.json` is
  deleted, the backup put in its place, and the server started on it. The villas,
  charges, payments, receipt numbers, audit trail, staff and settings all come
  back; everyone's password still works; the receipt counter carries on rather
  than reissuing a used number; and the already-billed month is not billed twice.
  A backup nobody has ever restored is not yet a backup.
- **First and last month's rent** — move-in bills two months; the tenant's final
  month is not charged again, so a tenancy of N months is charged exactly N months'
  rent. A backdated move-in is dated to the month they actually moved in, and the
  occupied months nobody billed are surfaced rather than left silent.
- **One-off charges** — late fees, recharged repairs and levies land on the right
  account, age into arrears, settle with an ordinary payment, and never make
  posting believe the month was already billed.
- **Lease terms** — only leases inside the warning window or already lapsed
  surface, most overdue first; renewing clears the warning without inventing a
  move-out date.
- **Maintenance work orders** — a request is assigned, progressed and closed with a
  cost; the cost reaches the expense register exactly once; other kinds of activity
  cannot be progressed as work.
- **Staff accounts** — creating an account, changing a role and resetting a
  password are Administrator-only: a Manager cannot promote themselves, cannot
  seize the administrator account by resetting its password, and cannot
  deactivate it. The last active Administrator can be neither demoted nor
  switched off. Weak passwords, duplicate usernames (in any case), illegal
  username characters and invented roles are refused, and fields a client is not
  entitled to set — its own id, its own forced password change, a password hash —
  are ignored rather than trusted.
- **Session integrity** — a made-up token neither reads nor writes, an expired
  session is refused after a restart, a password reset revokes the sessions
  already issued and forces a fresh choice before anything can be recorded, and no
  password hash or salt appears in `/api/db` or `/api/auth/me`.
- **The records export** — the snapshot that deliberately leaves the machine is
  gated to settings-holders, is audited, and carries no password hash, no salt and
  no session. Its staff list is limited to who people are, never how they sign in.
- **Receipt reprints** — a reprint is counted on the record, and copy #2 onwards is
  named on the audit trail, so the same money cannot quietly be receipted twice.
- **Two hundred scenarios on one database** — a property run for a simulated
  stretch of time on a database that is never reset: tenants moving in and out,
  months posted, rent part-paid, receipts voided and re-issued, guests booking and
  cancelling, deposits held and returned, meters read, costs paid, mistyped
  figures, wrong currencies, and two people at the desk at once. After *each* one,
  the whole database is audited: no two receipts share a number, nothing
  unreceived holds one, no figure is NaN or negative where it cannot be, nothing
  is refunded for more than it was worth, no month is billed twice, two confirmed
  stays never occupy one villa on the same night, and every balance still totals
  to whole cents. Scenarios come from a seeded generator, so a failure names a
  seed that reproduces it.
- **A hundred scenarios across the whole application** — the same idea run over
  the parts the ledger simulation never reaches, starting from a property that
  looks real on day one: sixteen villas as long lets, short lets, one
  owner-occupied and one out of service, rates in both currencies, staff in every
  role, and the standing monthly costs on file. It then drives monthly cost
  templates and posting them, maintenance work orders through to the expense they
  raise, resident activity records, damage deposits, security deposits held and
  settled, lease terms, bank reconciliation, receipt reprints, staff
  administration, permission changes mid-shift, calendar feeds, backups and the
  records export. The invariants are the cross-cutting ones: a work order raises
  its cost exactly once, a month's costs are never posted twice, no deposit is
  settled for more than was held, no meter runs backwards, and no villa is sold
  twice on one night.
- **Reading a platform calendar** — payloads shaped like real Airbnb, Booking.com
  and VRBO exports: folded description lines, escaped commas, `Reserved` with no
  guest name, `Airbnb (Not available)` blocks, `DURATION` in place of an end date,
  and `STATUS:CANCELLED`. A checkout date is exclusive, so five nights are five
  nights. A stay that has *gone* from the feed is cancelled — that is how Airbnb
  reports a cancellation — unless money is attached to it, in which case it is
  raised for a person rather than silently edited.
- **Calendar sync** — the internal-network guard runs against the address actually
  being dialled at *sync* time, not only when a feed is added: a feed written
  straight into `db.json` is still refused, is reported as an error rather than
  silently swallowed, and imports nothing. A deactivated feed is left alone. (The
  redirect hop is re-checked in `server/ical.ts` but is not integration-tested —
  proving it needs a public host that redirects inward, and the suite does not
  reach the internet.)

The one audit finding deliberately **not** enforced is read scope: every signed-in
user can read the whole database, including the audit log and staff list. This was
a conscious decision — only Administrators and Managers can *change* anything.

## What a backup file contains

A backup used to be a byte-for-byte copy of `db.json`, which meant it carried the
live `sessions` array. A session token is a working credential for twelve hours,
so anyone who could read a recent backup — off the USB stick, out of the synced
folder — could paste a token into a cookie and be signed in as its owner. Backups
are now written with sessions stripped, and the restore test fails if one ever
gets back in.

**Password hashes are still in the file, deliberately.** They have to be, or a
restore would lock every account out of the system. They are scrypt with a
per-user random salt, which is strong, but it does mean the backup folder holds
credential material: keep it somewhere you would be willing to keep the ledger
itself, not in a widely-shared drive.

The separate **records snapshot** (System Settings → download) is the one to hand
to an accountant or an owner: it carries no hashes, no salts and no sessions, and
cannot be used to sign in as anyone. It is not a restore file.

## Windows / two-PC dry run (do this before trusting it with real money)

The automated suite proves the logic. It does **not** prove the real deployment,
which has only ever been reasoned about, not run. Work through this on the actual
HP EliteDesk (server) and Kamrui (client) before going live.

1. **Back up first.** Copy the current `db.json` somewhere off the machine. The
   first launch of this build migrates the database one way (adds the
   `recordPayments` permission, grants it to every role). It has been verified on a
   copy of the live data, but keep the backup regardless.
2. **Build and self-test on the server PC:** `npm install`, then `npm test`. All
   735 checks should pass on Windows exactly as on macOS. If any fail, stop and note
   which — that is a real cross-platform difference worth looking at.

   Not needed if you are using the packaged `Villaggio-Del-Sol.exe` from Releases:
   the same suite, plus a start-and-serve smoke test of the executable itself and a
   check that it creates its Desktop shortcut, runs on a real Windows machine before
   any release is published.
3. **Start the server** on the HP by double-clicking `Villaggio-Del-Sol.bat`. The first
   run installs, builds, adds a desktop icon and starts; later runs start straight away.
   Confirm the console prints the URL and the one-time admin password.
4. **Sign in on the server PC itself** at `http://localhost:3000`. First run prints
   a one-time admin password to the console; you will be forced to change it.
5. **Sign in from the Kamrui client** over Tailscale, e.g.
   `http://<hp-tailscale-name>:3000`. Confirm sign-in works over plain HTTP (this
   is the LAN cookie case). If the cookie is rejected, the two PCs are not talking
   over the connection you think they are.
6. **Record a test payment on the client**, confirm the receipt prints, then check
   the same payment is visible on the server PC. This proves the shared `db.json`
   and the network path together.
7. **Pull the network for ~10 seconds** mid-entry (unplug Wi-Fi / pause Tailscale),
   then restore it. Confirm the reconnect banner shows and the entry completes
   without creating a duplicate receipt.
8. **Install the PWA** on both machines and confirm it launches and updates.
9. **Leave the server running overnight** and confirm a new dated file appears in
   `db-backups/` the next day. Point `VDS_BACKUP_DIR` at a synced folder or a USB
   drive so a copy leaves the machine.
10. **Run a week in parallel** with your existing process before relying on this
    alone.

## Environment variables

- `VDS_ADMIN_PASSWORD` — set the first admin password instead of having one
  generated and printed to the console.
- `VDS_DATA_DIR` — where `db.json` and `db-backups/` live (defaults to the working
  directory).
- `VDS_BACKUP_DIR` — a second, off-machine backup location (a synced folder or USB
  drive). Strongly recommended. Usually easier to set in the app instead:
  **System Settings → Backup & recovery**, which needs no restart and takes
  precedence over this variable.
- `VDS_DRIVE_ROOTS` — extra mount points to search for a backup drive, separated
  by the platform's path separator. Rarely needed: Windows drive letters, macOS
  `/Volumes` and the usual Linux mount points are searched already. Set it only if
  removable media mounts somewhere unusual on your machine.
- `VDS_TRUST_PROXY` — leave unset on the direct LAN. Only set it (`true`, a hop
  count, or a trusted address list) if the server genuinely sits behind a reverse
  proxy you control.
- `VDS_FORCE_SECURE_COOKIE=true` — force `Secure` session cookies. Only use this if
  every client reaches the server over HTTPS; it breaks sign-in over plain HTTP.
