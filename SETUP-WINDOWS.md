# Villaggio Del Sol — Simple Setup Guide (Windows)

This guide is for non-technical staff. Follow it once on the **HP EliteDesk** (the
computer that will hold the records). Then any other computer — like the **Kamrui**
— just opens it in a web browser.

You do **not** need to understand any of the technical parts. Just follow the steps.

---

## Part 1 — Start it on the HP

### Step 1: Get the program folder onto the HP
Copy the `pm-app` folder onto the HP — for example onto the Desktop. (You can copy it
from a USB stick, or download it; see *"Where do I get it?"* at the bottom.)

### Step 2: Double-click **`Villaggio-Del-Sol.bat`**
That is the whole thing. There is no separate installer and nothing to activate.

- **The first time**, it sets itself up: it installs what it needs, prepares the
  application, and adds a **"Villaggio Del Sol"** icon to the Desktop. This takes a few
  minutes — leave the window open.
- **Every time after that**, it starts straight away.
- Once the icon is on the Desktop, use that from then on. It does exactly the same
  thing.

If it says **Node.js is needed**, it opens the download page for you. Download the big
green **LTS** button, install it (click Next → Next → Finish), then double-click
**`Villaggio-Del-Sol.bat`** again. That is a one-time thing for the computer.

### Step 3: Sign in
1. A green window stays open — that is the "engine". **Leave it open** while anyone is
   using the program. Closing it shuts the program down.
2. Your browser opens the app automatically.
3. The very first time, the green window prints a **one-time admin password**.
   **Write it down.** Sign in with username **admin** and that password; you will be
   asked to choose your own password straight away.
4. Go to **System Settings → Staff accounts** and make an account for each person, so
   everyone signs in as themselves.

That's it — the HP is now running the program.

> **If the window flashes and disappears:** a file called `last-run-log.txt` is written
> next to `Villaggio-Del-Sol.bat` every time it runs. Send that file — it says what went
> wrong.

---

## Part 2 — Use it from the Kamrui (or any other computer)

Nothing to install. On the Kamrui, open a browser (Chrome or Edge) and go to the
HP's address. The easiest way to always find the HP is **Tailscale** (see the main
`README.md`), which gives it a name like `http://hp-elitedesk:3000`.

Both PCs are on **Wi-Fi**, so a couple of one-time settings on the HP keep it reachable:
see *"Both PCs on Wi-Fi"* in the main `README.md` (allow it through the firewall, and
stop the Wi-Fi from sleeping).

### Make it feel like an installed app
In the browser, look for a small **install icon** in the address bar (or open the
browser menu and choose **Install Villaggio Del Sol**). Do this on both the HP and the
Kamrui. Now it has its own desktop icon and window, just like a normal program — and it
**updates itself** whenever a new version is built on the HP.

---

## Common questions

**Do I have to leave the HP on all the time?**
Only when people are using the program (including using it remotely). You can shut the
HP down overnight if nobody works then, and start it again in the morning. Your records
are saved safely and are all still there.

**Can I use it from home / from Canada?**
Yes. Install Tailscale on your laptop, sign into the same Tailscale account, and open
`http://hp-elitedesk:3000`. The HP must be turned **on and awake** at that moment,
because your laptop is really just viewing what's on the HP.

**Where are my records kept? Are they safe?**
Everything is in a single file called `db.json`, kept next to the program on the HP. The
program keeps a fresh backup every day. From inside the app, **System Settings → Backup
& recovery** has a "Download a snapshot" button — use it before anything risky.

To keep a copy **off** the computer as well (strongly recommended), see
`VDS_BACKUP_DIR` in `TESTING.md` — point it at a OneDrive folder or a USB drive.

**Can I get a `.exe` instead?**
`Villaggio-Del-Sol.bat` already behaves like one: double-click, it does everything. A
true single `.exe` — where the computer needs nothing installed at all, not even
Node.js — is planned as a later step, built and tested on a real Windows machine.

**Where do I get the program folder? Can I use GitHub?**
Two options:
- **Copy the folder** onto the HP (USB stick, network share). Simplest.
- **GitHub:** if you create a free account at github.com and make a repository, you can
  store the program there and download it with `git clone`. The web address would be
  `https://github.com/YOUR-USERNAME/villaggio-del-sol` — but that link only exists after
  *you* create the repository; it can't be made for you in advance. Your live records
  are never uploaded (they're excluded automatically).

---

If a step doesn't work, take a photo of the window and ask for help — you can't break
anything by trying.
