// App Launcher Dashboard
// Run this with Node.js INSIDE WSL (open your Ubuntu/WSL terminal, not PowerShell):
//   node server.js
// Then open http://localhost:8787 in your Windows browser.
//
// Edit apps.json to list your own projects (path + start command + port).

const http = require('http');
const net = require('net');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.DASHBOARD_PORT || 8787;
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'apps.json');
const LOG_DIR = path.join(ROOT, 'logs');
const PID_DIR = path.join(ROOT, 'pids');

for (const dir of [LOG_DIR, PID_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadApps() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function findApp(id) {
  const apps = loadApps();
  return apps.find(a => a.id === id);
}

function pidFilePath(id) {
  return path.join(PID_DIR, id + '.pid');
}

function logFilePath(id) {
  return path.join(LOG_DIR, id + '.log');
}

function getPid(id) {
  try {
    const raw = fs.readFileSync(pidFilePath(id), 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = just checks existence/permission
    return true;
  } catch {
    return false;
  }
}

// Checks whether something is actually listening on a TCP port. Used for apps
// that daemonize (fork to background and exit) since tracking the pid of the
// launcher process alone would show them as "stopped" the instant they fork.
function checkPort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(600);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

// If a port is configured, that's the source of truth for "is it running"
// (works for daemonizing start/stop scripts). Otherwise fall back to
// tracking the pid of the process we spawned (works for foreground dev
// servers like `npm run dev` / `flask run` that block until stopped).
async function isAppRunning(app) {
  if (app.port) return checkPort(app.port);
  return isRunning(getPid(app.id));
}

async function startApp(app) {
  const already = await isAppRunning(app);
  if (already) {
    return { ok: false, message: 'Already running' };
  }

  if (!fs.existsSync(app.cwd)) {
    return { ok: false, message: 'Folder does not exist: ' + app.cwd };
  }

  const logFd = fs.openSync(logFilePath(app.id), 'a');
  fs.writeSync(logFd, '\n----- started ' + new Date().toISOString() + ' -----\n');

  let child;
  try {
    child = spawn('bash', ['-lc', app.cmd], {
      cwd: app.cwd,
      detached: true, // creates a new session, so child.pid is also the process group id
      stdio: ['ignore', logFd, logFd]
    });
  } finally {
    fs.closeSync(logFd);
  }

  child.on('error', (err) => {
    fs.appendFileSync(logFilePath(app.id), '\n[launcher error] ' + err.message + '\n');
  });

  fs.writeFileSync(pidFilePath(app.id), String(child.pid));
  child.unref();

  return { ok: true, pid: child.pid };
}

async function stopApp(app) {
  // Apps with their own stop script (e.g. stop.sh) get that run instead of
  // being killed directly — needed since a daemonizing start script's own
  // process already exited, so there's nothing useful to kill by pid.
  if (app.stopCmd) {
    try {
      execSync('bash -lc ' + JSON.stringify(app.stopCmd), { cwd: app.cwd, stdio: 'ignore', timeout: 10000 });
    } catch (err) {
      fs.appendFileSync(logFilePath(app.id), '\n[stop error] ' + err.message + '\n');
    }
    try { fs.unlinkSync(pidFilePath(app.id)); } catch {}
    return { ok: true };
  }

  const pid = getPid(app.id);
  if (!isRunning(pid)) {
    try { fs.unlinkSync(pidFilePath(app.id)); } catch {}
    return { ok: false, message: 'Not running' };
  }

  try {
    process.kill(-pid, 'SIGTERM'); // negative pid => whole process group
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  setTimeout(() => {
    if (isRunning(pid)) {
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  }, 3000);

  try { fs.unlinkSync(pidFilePath(app.id)); } catch {}
  return { ok: true };
}

async function statusOf(app) {
  const running = await isAppRunning(app);
  const pid = (running && !app.port) ? getPid(app.id) : null;
  if (!running) {
    try { fs.unlinkSync(pidFilePath(app.id)); } catch {}
  }
  return { id: app.id, name: app.name, cwd: app.cwd, cmd: app.cmd, port: app.port || null, running, pid };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const DASHBOARD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>App Launcher</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; background: #16181d; color: #e6e6e6; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 20px; }
  .card { background: #202329; border: 1px solid #2c2f36; border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .info { flex: 1; }
  .name { font-size: 16px; font-weight: 600; }
  .meta { font-size: 12px; color: #9aa0aa; margin-top: 4px; }
  .status { display: flex; align-items: center; gap: 6px; font-size: 13px; margin-top: 6px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #666; display: inline-block; }
  .dot.on { background: #3fb950; }
  .dot.off { background: #6e7681; }
  .actions { display: flex; gap: 8px; }
  button { border: none; border-radius: 6px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
  .start { background: #238636; color: white; }
  .stop { background: #a12c2c; color: white; }
  .open { background: #30363d; color: #e6e6e6; }
  .log { background: #30363d; color: #e6e6e6; }
  button:disabled { opacity: 0.4; cursor: default; }
  pre#logbox { display:none; background:#0d1117; border:1px solid #2c2f36; border-radius:8px; padding:12px; max-height:300px; overflow:auto; font-size:12px; white-space:pre-wrap; }
</style>
</head>
<body>
  <h1>App Launcher</h1>
  <div id="apps"></div>
  <pre id="logbox"></pre>

<script>
async function fetchApps() {
  const res = await fetch('/api/apps');
  return res.json();
}

function render(apps) {
  const container = document.getElementById('apps');
  container.innerHTML = '';
  for (const app of apps) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = \`
      <div class="info">
        <div class="name">\${app.name}</div>
        <div class="meta">\${app.cwd}  &middot;  \${app.cmd}</div>
        <div class="status"><span class="dot \${app.running ? 'on' : 'off'}"></span>\${app.running ? 'Running (pid ' + app.pid + ')' : 'Stopped'}</div>
      </div>
      <div class="actions">
        \${app.port ? '<button class="open" onclick="window.open(\\'http://localhost:' + app.port + '\\')">Open</button>' : ''}
        <button class="log" onclick="viewLog('\${app.id}')">Log</button>
        <button class="start" \${app.running ? 'disabled' : ''} onclick="doAction('\${app.id}','start')">Start</button>
        <button class="stop" \${app.running ? '' : 'disabled'} onclick="doAction('\${app.id}','stop')">Stop</button>
      </div>
    \`;
    container.appendChild(card);
  }
}

async function doAction(id, action) {
  await fetch('/api/' + action + '/' + id, { method: 'POST' });
  refresh();
}

async function viewLog(id) {
  const box = document.getElementById('logbox');
  const res = await fetch('/api/logs/' + id);
  const text = await res.text();
  box.style.display = 'block';
  box.textContent = text || '(empty log)';
  box.scrollTop = box.scrollHeight;
}

async function refresh() {
  const apps = await fetchApps();
  render(apps);
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','start','frontend']

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return sendHtml(res, DASHBOARD_HTML);
    }

    if (req.method === 'GET' && url.pathname === '/api/apps') {
      const apps = await Promise.all(loadApps().map(statusOf));
      return sendJson(res, 200, apps);
    }

    if (req.method === 'POST' && parts[0] === 'api' && (parts[1] === 'start' || parts[1] === 'stop') && parts[2]) {
      const app = findApp(parts[2]);
      if (!app) return sendJson(res, 404, { ok: false, message: 'Unknown app id' });
      const result = parts[1] === 'start' ? await startApp(app) : await stopApp(app);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'logs' && parts[2]) {
      const app = findApp(parts[2]);
      if (!app) return sendJson(res, 404, { ok: false, message: 'Unknown app id' });
      let text = '';
      try {
        text = fs.readFileSync(logFilePath(app.id), 'utf8');
        const lines = text.split('\n');
        text = lines.slice(-200).join('\n'); // last 200 lines
      } catch {}
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }

    sendJson(res, 404, { ok: false, message: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { ok: false, message: err.message });
  }
});

server.listen(PORT, () => {
  console.log('App Launcher Dashboard running at http://localhost:' + PORT);
  console.log('Edit apps.json to add/change your projects.');
});
