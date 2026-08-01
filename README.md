# Villaggio Del Sol — Property Operations

Internal property-management system for the 16-unit gated residence at Ocho Rios, St. Ann, Jamaica.

Handles long-term tenancies, owner HOA maintenance accounts, short-term guest reservations,
metered utilities, property expenses, receipts, and printable statements — in both JMD and USD.

---

## Two ways to run this

**On Windows, the simplest path is the single-file program.** Download `Villaggio-Del-Sol.exe`
from this repository's [Releases](../../releases) page and double-click it — nothing else to
install, not even Node.js. See `SETUP-WINDOWS.md` for the full non-technical walkthrough
(including what to do if the administrator password is ever lost). A new release is built —
tested end to end on a real Windows machine by GitHub Actions before it publishes — every time a
version tag is pushed; see `.github/workflows/build-exe.yml`.

Everything below this point describes running it **from source** with Node.js installed — the
path for development, for macOS/Linux, or if you'd rather not use the packaged `.exe`.

## Getting it onto a machine

You do **not** need GitHub. Pick whichever is easier:

- **Copy the folder** onto the machine (USB stick, network share, AirDrop). Simplest, works offline.
- **GitHub**, if you want version history and easy updates: push this folder to a private repo and
  `git clone` it on the target machine. The live records (`db.json`, `db-backups/`, `.env`) are
  git-ignored, so they are never uploaded.

Then, on that machine:

```bash
npm install
npm run setup
```

## Guided setup

`npm run setup` walks through the whole configuration — press Enter to accept each default:

- **Where to keep the records** (`db.json`). Defaults to the app folder; point it anywhere, e.g. a
  Documents subfolder. An existing database in that folder is kept and used, never overwritten.
- **An off-machine backup folder** — a synced folder (iCloud Drive, Dropbox, OneDrive) or an
  external drive. Strongly recommended; see *Data, backup and recovery* below.
- **The first administrator password** (or accept a generated strong one).
- **The port** to run on.

It writes a `.env` file that the app reads on every start. Re-run it any time to change settings.

## Running it

```bash
npm run dev
```

Then open <http://localhost:3000> (or the port you chose).

If you skipped `npm run setup`, the app still runs with sensible defaults — it stores records in the
current folder and prints a generated admin password to the console on first start.

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
| `VDS_BACKUP_DIR`     | **Second backup location** — point at a synced or external drive |

**Serve it over HTTPS.** Session cookies are marked `Secure` in production, so sign-in will not
work over plain HTTP once `NODE_ENV=production`. Put it behind a reverse proxy with TLS.

---

## How the money works

Understanding this one rule explains most of the application:

> **Balance = (charges billed) − (payments received)**, per unit, per account, per currency.

* **Charges** are raised by **HOA & Tenants Ledger → Post month**. Until a month is posted,
  nothing is owed for it. Posting is idempotent — posting the same month twice adds nothing.
* **Payments** reduce that unit's balance oldest-month-first — but only once they are
  *confirmed as received*. See *Received, or only expected?* below.
* Unpaid months therefore **accumulate**: this is what makes arrears and ageing work.
* A negative balance is a **credit** (the account paid more than it was billed).

### Received, or only expected?

Entering a payment does not, by itself, assert that money arrived. There are two entry points and
they mean different things:

| Button | Meaning | Effect |
| --- | --- | --- |
| **Receive payment** — on an arrears alert or a ledger row | The money is in hand now | Receipt issued immediately; the balance drops and the alert clears everywhere |
| **Record payment** — the button at the top of the ledger | Expected but not yet arrived (a cheque, a promised transfer) | Logged as *awaiting funds*; no receipt number, no effect on any balance or report |

An expected payment is confirmed later from **HOA & Tenants Ledger → Receipts ledger**, using
**Confirm received**. That is the moment a receipt number is issued and the money reaches the
balances and the reports. **Every figure in the application is derived from confirmed receipts
alone**, so an entry awaiting funds can never flatter a balance, a collection rate or a projection.

Settling a utility bill and a reservation deposit follow the same rule: the bill stays unpaid, and
the deposit stays expected, until the receipt is confirmed.

If the server is unreachable when something is entered, the entry is written to this computer
before it is sent and replayed in order when the server returns — surviving a reboot or a closed
tab. Until it lands it is described as held here, never as saved, because the HP has not seen it.

### Charges beyond the monthly bill

**Post month** raises the rent and the HOA fee. Anything else a property bills — a **late fee**, a
**repair recharged** to the tenant who caused it, a **fine**, an **amenity fee**, **legal costs**, a
**special assessment** — is raised with **Bill a one-off** on the ledger. A one-off is billed onto an
existing account (the tenant's rent, or the owner's maintenance), so it ages into arrears, shows on
the statement and is settled by an ordinary payment, exactly like rent.

### First and last month's rent

Recording a tenant's move-in date bills **two** months at once: their first month, and their last
month held in advance. The advance is not a deposit and is not refunded — it pays for their final
month, so when the tenancy is closed that month is **not charged again**. A tenant who stays N
months is charged exactly N months' rent.

### Currency

USD and JMD are **never** added together, anywhere. Each unit is billed in its own currency
(rent uses the unit's base currency; maintenance may use a different one). A receipt entered in
the wrong currency is refused with an explanation, and can only be forced through with an explicit
confirmation — in which case it is reported separately as a currency mismatch rather than being
silently netted off.

The exchange rate in System Settings is **indicative only**. It produces the small "≈" figures
next to amounts. It never converts a stored amount and never feeds a total.

---

## Tenancy records

The unit register holds the *current* occupant. The occupancy history is kept
separately and is **append-only**: a tenant is never edited away.

* Entering a tenant on a long-term lease opens a tenancy.
* Changing the tenant, or moving the villa off a long-term lease, **closes** that
  tenancy with a reason and keeps it — together with the rent they were paying and
  every receipt issued to them.
* Use **Edit tenancy dates** on the unit to set the dates the tenant actually
  moved in and left, rather than the day the paperwork was done. Closing the
  tenancy is an optional tick inside that same form.
* Rent is captured on the tenancy as agreed at the time, so raising the rent for a
  new tenant does not rewrite what the previous one was charged.
* A tenancy can carry a **lease end date** — the date the agreement runs to, which is
  not the same as the date the tenant left. Leases within 60 days of expiry, and any
  already lapsed, are flagged on the dashboard and in the Notifications Hub. An
  expired term does not end a tenancy; it continues month to month at the old rent
  until it is renewed or notice is served. Leave the date empty for a
  month-to-month tenancy.

Occupancy history appears in the unit detail view and as section I of the printed
unit ledger.

## Maintenance requests

A maintenance request logged against a villa is tracked as work rather than kept as a note. It opens
as **Reported** and can be assigned to a contractor, scheduled, progressed, and closed as
**Completed** or **Cancelled** with the date, the outcome and what it cost. The cost can be raised as
a property expense against that villa in the same step — once only, so it never reaches the accounts
twice. Other kinds of activity (a pool booking, a noise notice) are a record of something that
happened and are not tracked as work.

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

## Reporting screens

Three screens read the same figures in different shapes — all from `src/lib/finance.ts`, so they
cannot disagree with the ledger:

* **Operational Reports** — the reconcilable operating statement for any date range: opening and
  closing receivables, billed against received, expenses by category, and a printable statement
  plus a CSV export.
* **Charts & Snapshots** — the same money as pictures, for when the shape matters more than the
  exact figures: monthly cash movement, expenses by category, and category month-by-month, per
  currency, with its own date range and a printable chart pack.
* **Financial Projections** — a forward, straight-line view for the **strata corporation**: HOA
  maintenance contributions against operating expenditure. Rent and short-term booking income
  belong to individual proprietors, not the body corporate, so they are deliberately excluded.
  Exports to a spreadsheet for manual adjustment.

---

## Data, backup and recovery

Everything lives in a single `db.json`. That is appropriate at this scale, and it is handled
carefully:

* Writes are **atomic** (temp file, fsync, rename) so a crash or power loss can never leave a
  truncated, unreadable database.
* Every write runs inside a **serialized transaction**, so two staff members saving at the same
  moment cannot overwrite one another.
* A dated copy is placed in `db-backups/` once a day, keeping the last 30. This is driven by an
  hourly check, so a server left running for months still produces a copy each day.
* If `db.json` cannot be parsed on start, the server **refuses to start** rather than overwriting
  it with an empty database. Restore a backup and restart.

### Getting a copy off this machine

Backups written only to `db-backups/` sit on the same disk as the database they protect. That
survives a bad edit; it does not survive a failed disk, a stolen laptop, or the folder being
deleted. Two ways to fix that:

1. **Automatic, set in the app** — **System Settings → Backup & recovery → Back up to an external
   drive**. Plug in a USB or external drive, paste its folder (on Windows, e.g.
   `E:\Villaggio-Backups`), and press **Save and back up now**. The path is tested by actually
   writing to it, a copy is taken immediately, and one follows every day. No restart, no
   environment variable.

   An unplugged drive is handled: the path is remembered so it need not be re-typed, the copy on
   this machine still succeeds, and the screen says whether the folder could not be written to
   rather than silently showing no backup.

   The `VDS_BACKUP_DIR` environment variable still works and is honoured for a scripted or
   headless install; a folder saved in the app takes precedence over it.

2. **Manual** — **System Settings → Backup & recovery → Download a snapshot** produces a single
   JSON file of every record. Password hashes and sessions are stripped, so it is safe to email
   or store in cloud storage. Do this before anything risky.

### Restoring

1. Stop the application.
2. Copy the backup you want over `db.json`.
3. Start it again.

Backups are plain JSON — you can open one and read it before restoring.

### Schema migration

On start, an older database is migrated in place and every repair is written to the audit trail.
The notable one: records used to reference a unit by its *display number*, so renaming a unit
orphaned its financial history. Records are relinked to a stable unit id, and the unit label now
cascades on rename.

---

## Receipts, statements and guest documents

Every time money is received — rent, HOA maintenance, a utility bill, a booking deposit, or a
quick payment from the dashboard — a **receipt opens automatically** so it can be printed or
emailed on the spot. You can also reopen any receipt from **HOA & Tenants Ledger → Receipts
ledger**.

- **Print** uses the browser's print dialog; choose "Save as PDF" there to keep a digital copy.
- **Email** opens a pre-filled draft in your own mail app (Gmail, Outlook, Apple Mail), addressed
  to the tenant, owner or guest on file. You read it and press send. The app does **not** send mail
  itself — it never has your mail password, and nothing is sent behind your back. A mailto draft
  can't carry a PDF attachment, so the receipt details are in the body; attach a saved PDF yourself
  if a formal copy is needed.

Two more documents:

- **Account statement** — on the tenant and owner ledger tabs, each row has a **Statement** button
  that prints (or emails) a full itemised statement: every charge and payment in date order with a
  running balance and the closing position. The tabs also show a **Last payment** date column.
- **Guest stay receipt** — the Short-Term Bookings list has a **Guest receipt** button per
  reservation. This is the guest-facing document (villa, dates, nights, total, deposit, balance due
  on arrival), separate from the internal payment receipt kept in the finance ledger.

## When a tenant is evicted

If a tenant leaves owing rent, that debt should not keep showing on the dashboard and Notifications
hub as if it were still collectable. A **Manager or Administrator** (the same veto authority that
can void a payment) opens the tenant's villa in the Units register and uses **Evict tenant** on the
active tenancy:

- The tenancy is closed as an eviction, with the reason and effective date recorded.
- The tenant's **unpaid rent charges are written off** — voided as bad debt — so the balance leaves
  the dashboard and the hub immediately.
- The villa is freed (set to Vacant, tenant contact cleared).
- Nothing is deleted: the tenancy, the receipts, and the written-off amount stay in the record and
  the audit trail, and the eviction shows on the occupancy history with the sum written off.

A Junior or Finance Officer cannot do this; the button does not appear for them.

## The two-computer setup (HP + Kamrui)

The intended deployment: the **HP EliteDesk** runs the server and holds the database; the **Kamrui
mini PC** (and any other device) is just a client that opens the app in a browser. **No Docker is
needed** — it runs directly on Node.

### On the HP (the server)

1. Install [Node.js](https://nodejs.org) (LTS).
2. Put this folder on the HP (copy it, or `git clone`), then:
   ```bash
   npm install
   npm run setup      # choose data folder, backup folder, admin password, port
   npm run build
   npm start
   ```
3. Note the HP's address on your network. With Tailscale (below) it's a `100.x.y.z` address or a
   name like `hp-elitedesk`.

**Keep it running.** For a permanent install the server should start with the machine and restart
if it stops. On Windows the simplest route is [PM2](https://pm2.keymetrics.io):
```bash
npm install -g pm2
pm2 start dist/server.cjs --name villaggio --env production
pm2 save
pm2 startup     # follow the printed instruction so it launches on boot
```

### On the Kamrui (and any other device)

Nothing to install but a browser. Open `http://<hp-address>:3000` and sign in.

### Both PCs on Wi-Fi (no Ethernet)

This works fine — the HP just needs to stay reachable, and clients need a stable address.

**Use a name, not an IP.** A Wi-Fi router hands out addresses by DHCP, so the HP's `192.168.x.x`
can change after a reboot. Don't hard-code it. In order of preference:

1. **Tailscale name** — `http://hp-elitedesk:3000` always resolves to the HP regardless of its IP,
   on your Wi-Fi and off-site. Cleanest option (see *Running it remotely*).
2. **The HP's computer name** on the same Wi-Fi — `http://HP-ELITEDESK:3000`. Windows resolves this
   locally with no extra software. Find the name in *Settings → System → About*.
3. **A DHCP reservation** in your router so the HP always gets the same IP, then use that IP.

**Keep the HP serving** — the one thing to get right when the *server* is on Wi-Fi:

- **Firewall:** the first time you run it, Windows asks "Allow access?" — click **Allow**, and set the
  Wi-Fi network to **Private**. Without this the Kamrui can't reach port 3000.
- **Power saving:** stop the HP's Wi-Fi adapter powering down when idle (Device Manager → the Wi-Fi
  adapter → *Power Management* → untick "Allow the computer to turn off this device"), and set the HP
  not to sleep. Otherwise it silently drops off the network and clients see "Reconnecting…".

**Blips are handled.** Wi-Fi drops a few seconds more often than a cable would. A save caught in one
is retried automatically and can't double-record (see *If the connection drops for a few seconds*),
so Wi-Fi is a safe way to run this.

### Install it as an app (PWA)

The app is a **Progressive Web App**, so it installs from the browser and then behaves like a
desktop program — its own window, its own taskbar/Start-menu icon, no browser chrome.

- **Install:** open the app in Chrome or Edge, then use the install icon in the address bar (or
  menu → *Install Villaggio Del Sol / Apps → Install this site as an app*). Do this on both the HP
  and the Kamrui.
- **Updates are automatic:** when you `npm run build` a new version on the HP, each installed client
  picks it up on its next launch and reloads itself. **You never reinstall on each computer.**
- **Always live data:** only the app itself (screens, layout) is cached so it opens instantly and
  works through a blip. Every figure — balances, receipts, arrears — is always fetched fresh from
  the HP; nothing financial is ever served from a stale cache.

### If the connection drops for a few seconds

The link between the Kamrui and the HP can hiccup (a switch, Wi-Fi, or Tailscale re-handshake).
The app is built so a brief drop does not lose work:

- A save in progress is **not failed**; the app waits for the server to come back and **retries the
  same request automatically**. A "Reconnecting to the server…" banner shows while it waits.
- Retries are **idempotent**: every action carries a one-time key the server remembers, so if a
  request reached the HP but the reply was lost on the way back, the retry is recognised and does
  **not** record it twice. A retried payment can never become a duplicate receipt.
- Reconnection is automatic when the network returns; the banner clears itself.

This covers short interruptions — the realistic case on a small LAN. It is not full offline working:
if the outage runs long (over ~90 seconds) the save fails cleanly, the form keeps everything you
typed, and you retry once the banner clears. Nothing entered is lost.

## Running it remotely

The app is a normal web server, so staff can reach it from their own devices — but it ships
configured for a trusted local network, and how you expose it matters.

**Recommended — a private network (Tailscale).** Nothing is published to the open internet and the
records never leave the HP. Step by step:

1. **Make a Tailscale account** at <https://tailscale.com> (the free plan is plenty). Sign in with a
   Google/Microsoft/GitHub account you control.
2. **Install Tailscale on the HP** (the server): download it from the site, install, and sign in
   with that account. The HP now has a private address like `100.101.102.103` and a name like
   `hp-elitedesk` — you'll see it on the Tailscale admin page (*Machines*).
3. **Install Tailscale on the Kamrui** and on any phone/laptop staff will use, signing each into the
   **same** account. They all join the same private network.
4. **Connect:** on the Kamrui, open `http://hp-elitedesk:3000` (or `http://100.101.102.103:3000`).
   That's it — the traffic is encrypted end to end, no ports are opened on your router, and the app
   is unreachable to anyone outside your Tailscale account.
5. **Optional niceties:** in the Tailscale admin you can enable *MagicDNS* so the `hp-elitedesk`
   name always works, and *HTTPS certificates* if you later want the address to be `https://`.

Because staff reach it over Tailscale from anywhere with internet, this doubles as "remote access"
— someone at home sees the same live data as someone on-site, all talking to the one HP.

**Alternative — a hosted server** on a small VPS behind a reverse proxy that terminates TLS (Caddy
does this in two lines). Required if you host it, because session cookies are `Secure` in
production and sign-in fails over plain HTTP. Put `VDS_DATA_DIR` on persistent storage, set
`VDS_BACKUP_DIR` to somewhere off that server, and download snapshots regularly.

**Do not** port-forward this straight from a home router to the internet: there is no protection
beyond sign-in throttling, and the records hold tenants' names, contacts and payment history.

**Scale.** One `db.json` and one server process is the design, and it is genuinely fine for 16
villas with several staff working at once — writes are serialized and each save takes milliseconds.
Do not run two server processes against the same file; move to a real database first if you ever
outgrow this.

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

* **No document attachments.** Invoices and receipts are referenced by number; file the paper (or a
  saved PDF) against that reference. There is no in-app file upload.
* **Email is drafted, not auto-sent.** Receipts open a pre-filled draft in your own mail app; the
  app never sends mail itself. This is deliberate (see *Receipts*).
* **Brief-interruption resilience, not full offline.** Short network drops are handled
  transparently (see above). Working for minutes with no connection to the HP is not supported —
  editing financial records against stale data over a long outage needs conflict handling this app
  does not attempt.
* **Single property.** The data model assumes one property with one set of units.
* **No refund instrument.** A refund is recorded by voiding the receipt; there is no separate
  outbound-payment record for the cash returned.
* **Rent proration is not modelled.** A mid-month move-in bills the whole month; adjust with a
  charge void and a manual entry.
