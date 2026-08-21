# Villaggio Del Sol — Simple Setup Guide (Windows)

This guide is for non-technical staff. Follow it once on the **HP EliteDesk** (the
computer that will hold the records). Then any other computer — like the **Kamrui**
— just opens it in a web browser.

You do **not** need to understand any of the technical parts. Just follow the steps.

---

## Part 1 — Start it on the HP

### Step 1: Download the program

Go to: **https://github.com/vildelsol/VDS_1/releases/latest**

Download the file called **`Villaggio-Del-Sol.exe`**. That is the only file you need —
there is no zip, no installer, nothing else.

Create a folder on the Desktop called **`Villaggio Del Sol`** and put the `.exe` inside it.
The program saves your records next to itself, so pick a permanent spot and don't move the
folder after you've started using it.

### Step 2: Double-click **`Villaggio-Del-Sol.exe`**

That is the whole thing. Nothing else to install.

A black console window opens and stays open — that is the "engine". **Leave it open** while
anyone is using the program. Closing it shuts the program down.

Your browser should open the app automatically. If it does not, open Chrome or Edge and go to:
`http://localhost:3000`

### Step 3: Sign in

The very first time you run it, the console window prints a **one-time admin password**.
**Write it down before the window scrolls.** Sign in with username **admin** and that
password — you will be asked to set your own password straight away.

Go to **System Settings → Staff accounts** and make an account for each person, so
everyone signs in as themselves rather than sharing the admin login.

That's it — the HP is now running the program.

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

**Nobody can sign in — the administrator password is lost. What now?**
The screen inside the app that resets a password only works if you can already sign in as
an administrator, which is no help if that account itself is the one locked out. Recovery
instead works directly on the HP, using its files:

1. Make sure the program (the green console window) is **closed**.
2. Go to the folder next to `Villaggio-Del-Sol.exe` — the same one that holds `db.json`.
3. Create a new, empty text file there named exactly **`RESET-ADMIN-PASSWORD.txt`**
   (right-click → New → Text Document, then rename it — if you can't see the `.txt` part
   to remove it, turn on "File name extensions" in Explorer's View menu first).
4. Double-click `Villaggio-Del-Sol.exe` to start the program again.
5. The green console window prints a **new one-time password** for `admin`, exactly like
   the very first time you ever ran it. Sign in with it and set your own password
   immediately, as before.

The file is deleted automatically the moment it's used, and every device that was still
signed in is signed out. This only ever works by being at the HP itself with its files —
nobody on the Kamrui, or anywhere else, can trigger it.

**Where are my records kept? Are they safe?**
Everything is in a single file called `db.json`, kept next to `Villaggio-Del-Sol.exe` on
the HP. The program keeps a fresh daily backup automatically. From inside the app,
**System Settings → Backup & recovery** has a "Download a snapshot" button — use it
before anything risky, and to keep a copy off the machine.

To back up automatically to a USB drive or a cloud-synced folder (OneDrive, Dropbox),
open **System Settings → Backup & recovery → Back up to an external drive**, choose the
folder, and press **Save and back up now**. The app writes a copy there every day from
then on without you having to remember.

**How do I update to a new version without losing my records?**
Your records (`db.json`) are completely separate from the program file. Updating is safe.

1. Close the program (close the black console window).
2. Go to **https://github.com/vildelsol/VDS_1/releases/latest** and download the new
   `Villaggio-Del-Sol.exe`.
3. Put the new file in the same folder as the old one, replacing it.
4. Double-click `Villaggio-Del-Sol.exe` to start it.

That's it. Your `db.json` stays exactly where it is — nothing touches it. On first start
the program checks its own records and prints a line to the console; on a healthy
database it reads **"no contradictions found"**.

After the HP is running the new version, do this on the **Kamrui and any phones**:
open the app, press **Ctrl+Shift+R** (hard reload) to clear the cached screens. If the
old version keeps showing, press **F12 → Application → Service Workers → Unregister**,
then reload.

---

If a step doesn't work, take a photo of the window and ask for help — you can't break
anything by trying.
