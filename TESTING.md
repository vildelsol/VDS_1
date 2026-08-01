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

### What is covered (233 checks)

- **Authentication & sessions** — unauthenticated access is refused, passwords are
  checked, the session cookie is `HttpOnly; SameSite=Strict` (and not `Secure`
  over plain HTTP so LAN sign-in works), a forced password change is enforced by
  the server, the sign-in throttle cannot be bypassed with a spoofed
  `X-Forwarded-For`, deactivating a user kills their live session, and logout
  invalidates it.
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

The one audit finding deliberately **not** enforced is read scope: every signed-in
user can read the whole database, including the audit log and staff list. This was
a conscious decision — only Administrators and Managers can *change* anything.

## Windows / two-PC dry run (do this before trusting it with real money)

The automated suite proves the logic. It does **not** prove the real deployment,
which has only ever been reasoned about, not run. Work through this on the actual
HP EliteDesk (server) and Kamrui (client) before going live.

1. **Back up first.** Copy the current `db.json` somewhere off the machine. The
   first launch of this build migrates the database one way (adds the
   `recordPayments` permission, grants it to every role). It has been verified on a
   copy of the live data, but keep the backup regardless.
2. **Build and self-test on the server PC:** `npm install`, then `npm test`. All
   233 checks should pass on Windows exactly as on macOS. If any fail, stop and note
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
- `VDS_TRUST_PROXY` — leave unset on the direct LAN. Only set it (`true`, a hop
  count, or a trusted address list) if the server genuinely sits behind a reverse
  proxy you control.
- `VDS_FORCE_SECURE_COOKIE=true` — force `Secure` session cookies. Only use this if
  every client reaches the server over HTTPS; it breaks sign-in over plain HTTP.
