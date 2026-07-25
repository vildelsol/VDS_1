# Villaggio Del Sol — Simple Setup Guide (Windows)

This guide is for non-technical staff. Follow it once on the **HP EliteDesk** (the
computer that will hold the records). Then any other computer — like the **Kamrui**
— just opens it in a web browser.

You do **not** need to understand any of the technical parts. Just follow the steps.

---

## Part 1 — Install it on the HP (once)

### Step 1: Get the program folder onto the HP
Copy the `pm-app` folder onto the HP — for example onto the Desktop. (You can copy it
from a USB stick, or download it; see *"Where do I get it?"* at the bottom.)

### Step 2: Run the installer
1. Open the `pm-app` folder.
2. Double-click **`install-windows.bat`**.
3. A blue window opens and does everything for you.

- If it says **Node.js is not installed**, it will open a website. Download the big
  green **LTS** button, install it (just click Next → Next → Finish), then double-click
  **`install-windows.bat`** again.
- When it asks questions (folders, password), you can just press **Enter** to accept
  each suggestion. Where it asks for a **backup folder**, choose a OneDrive or an
  external USB drive folder if you have one — that keeps a safe copy off the computer.
- **Write down the password it shows you.** You'll need it the first time you sign in.

When it finishes, you'll have a **"Villaggio Del Sol"** icon on the desktop.

### Step 3: Start the program
1. Double-click the **Villaggio Del Sol** icon on the desktop.
2. A green window opens (leave it open — that's the "engine") and your browser opens
   the app.
3. Sign in with username **admin** and the password from Step 2. You'll be asked to
   choose your own password straight away.
4. Go to **System Settings → Staff accounts** and make an account for each person, so
   everyone signs in as themselves.

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

**Where are my records kept? Are they safe?**
Everything is a single file on the HP (chosen during setup). The program keeps a fresh
backup every day, and a second copy on the backup folder you picked. From inside the
app, **System Settings → Backup & recovery** has a "Download a snapshot" button — use
it before anything risky.

**Can I get a `.exe` installer instead?**
The `install-windows.bat` file *is* the installer — double-clicking it is the same idea
as running a `.exe`. A traditional signed `.exe` would show Windows security warnings
unless it's professionally code-signed, so the batch installer is the safer route.

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
