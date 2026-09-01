# App Launcher Dashboard

A local web page with Start/Stop buttons for your dev servers (npm, Flask, Django, etc).
Runs entirely inside WSL — since WSL2 forwards localhost ports to Windows automatically,
you just open the dashboard in your normal Windows browser.

## Files

- `server.js` — the dashboard (Node.js, no npm install needed, uses only built-in modules)
- `apps.json` — your list of apps: id, name, folder path, start command, port
- `logs/` and `pids/` — created automatically, don't need to touch them

## Setup

1. Clone or copy this repo into WSL, e.g.:
   ```
   git clone https://github.com/kbaskar-hub/kbaskar-app-launcher.git ~/launcher
   ```
   (if you're copying from Windows instead, just `cp -r` the folder into WSL, e.g. under `~/launcher`)

2. Open **apps.json** and edit each entry to match your real projects:
   - `cwd`: full Linux path to the project folder (e.g. `/home/yourname/projects/frontend`)
   - `cmd`: the exact command that starts it (`npm run dev`, `flask run`, `python manage.py runserver`, `bash start.sh`, etc.)
   - `port`: the port it listens on. Used for the "Open" button, **and** — if set — for checking whether the app is running, by testing whether that port is open. Leave it out to fall back to tracking the process directly instead (only works for apps that stay in the foreground, like `npm run dev`).
   - `stopCmd` (optional): if your app has its own stop script (e.g. `stop.sh`), set this to the command that runs it, e.g. `"stopCmd": "bash stop.sh"`. Needed for any app whose start command forks to the background and exits on its own — for those, there's no single process left to kill directly, so Stop runs your script instead. Set `port` too in this case, so status reflects reality.
   - Add or remove entries freely; each just needs a unique `id`.

   Two patterns:
   - **Foreground app** (blocks until you Ctrl+C, e.g. `npm run dev`, `flask run`): just set `cmd`. No `stopCmd` needed — Stop kills the process directly.
   - **Start/stop script pair** (start script forks to background and exits): set both `cmd` and `stopCmd`, and set `port` so the dashboard can tell it's actually running.

3. From a **WSL terminal** (Ubuntu app, or `wsl` from Windows Terminal) — not PowerShell:
   ```
   cd ~/launcher
   node server.js
   ```
   You should see: `App Launcher Dashboard running at http://localhost:8787`

4. Open **http://localhost:8787** in your Windows browser.

Leave that terminal window open — the dashboard server needs to keep running. If you close it,
your started apps keep running (they're independent processes), but you won't be able to
start/stop/check them from the dashboard until you run `node server.js` again.

## Using it

- **Start** launches the app's command in its folder and shows it as running.
- **Stop** kills that process and everything it spawned (e.g. npm's child node process too).
- **Log** shows the last 200 lines of output from that app (handy for checking errors).
- **Open** (if a port is set) opens `http://localhost:<port>` in a new tab.
- Status auto-refreshes every 3 seconds, so it reflects reality even if you started/stopped something outside the dashboard.

## Optional: keep it running in the background

Instead of leaving a terminal window open, run it detached:
```
cd ~/launcher
nohup node server.js > dashboard.log 2>&1 & disown
```
It'll keep running until you reboot WSL or kill it manually (`pkill -f "node server.js"`).

## Notes

- This only manages processes inside WSL. It won't see or control anything run directly on Windows.
- If "Start" says the folder doesn't exist, double check the `cwd` path uses Linux-style paths (`/home/...`), not Windows paths.
- Port numbers are just for the "Open" button — the dashboard itself always runs on 8787. Change that with `DASHBOARD_PORT=9000 node server.js` if 8787 is taken.
