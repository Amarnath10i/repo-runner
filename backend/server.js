// Express + WebSocket server for the GitLive backend.
// Handles cloning repos, detecting runtimes, spinning up Docker sandboxes,
// and streaming terminal output to the frontend via WebSocket.

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import simpleGit from 'simple-git';
import { v4 as uuid } from 'uuid';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'fs';
import { detectRuntime, detectEnvVars, detectEnvVarsFromCode, detectServices, isPromptableSecret, envKeysWithDefaults, detectOrchestratedScript } from './detector.js';
import { startSandbox, stopSandbox, getSession, cleanupAll } from './sandbox.js';
import {
  checkNativeRuntimes,
  canRunNatively,
  startNativeProcess,
  startCompoundNative,
  stopNativeProcess,
  getNativeSession,
  cleanupAllNative,
  writeToSession,
  listPreviewSessions,
} from './native-runner.js';
import { openPortProxy, closePortProxy, sweepPortProxies, createPathProxy, findLandingPath } from './preview-proxy.js';
// Docker is optional — the server starts even if Docker Desktop isn't running.
// We create the instance lazily and never let it crash the startup.
let dockerCheck = null;
try {
  const Docker = (await import('dockerode')).default;
  dockerCheck = new Docker();
} catch {
  console.log('⚠ Docker module unavailable — Docker features will be disabled.');
}

const app = express();
const server = createServer(app);
// noServer: upgrades are routed below, since previews need WebSockets too.
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 3001;
const REPOS_DIR = join(process.cwd(), '.repos');

// Ensure repos directory exists
if (!existsSync(REPOS_DIR)) {
  mkdirSync(REPOS_DIR, { recursive: true });
}

// Clones left behind by runs that were never stopped (closed tabs, restarts).
function sweepOldRepos(maxAgeMs = 6 * 60 * 60 * 1000) {
  for (const name of readdirSync(REPOS_DIR)) {
    const dir = join(REPOS_DIR, name);
    try {
      if (!getNativeSession(name) && Date.now() - statSync(dir).mtimeMs > maxAgeMs) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // in use or already gone
    }
  }
}
sweepOldRepos(0);
setInterval(() => sweepOldRepos(), 60 * 60 * 1000).unref();

// One misbehaving request or child process must not take the engine down.
process.on('uncaughtException', (err) => console.error('[engine] uncaught:', err));
process.on('unhandledRejection', (err) => console.error('[engine] unhandled rejection:', err));

// Chrome's Private Network Access: lets a page on the public web (e.g. the
// Vercel-hosted UI) talk to a backend running on the visitor's own machine.
app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});
app.use(cors());
// Only the API takes JSON; preview requests must reach the app with their body intact.
app.use('/api', express.json());

// Track WebSocket clients per session
const wsClients = new Map(); // sessionId -> Set<ws>

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const sessionId = url.searchParams.get('session');

  if (!sessionId) {
    ws.close(4000, 'Missing session parameter');
    return;
  }

  if (!wsClients.has(sessionId)) {
    wsClients.set(sessionId, new Set());
  }
  wsClients.get(sessionId).add(ws);

  ws.on('close', () => {
    const clients = wsClients.get(sessionId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) wsClients.delete(sessionId);
    }
  });

  // Terminal input typed in the UI → the running program's stdin.
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input' && typeof msg.data === 'string') writeToSession(sessionId, msg.data);
    } catch {
      // ignore malformed messages
    }
  });

  ws.send(JSON.stringify({ type: 'connected', sessionId }));
});

// ─── Previews ───

const previewTarget = (id) => getNativeSession(id)?.hostPort || getSession(id)?.hostPort || null;
const soleSession = () => {
  const ids = listPreviewSessions();
  return ids.length === 1 ? ids[0] : null;
};
const pathProxy = createPathProxy({ targetFor: previewTarget, soleSession });

setInterval(() => sweepPortProxies((id) => !!previewTarget(id)), 60_000).unref();

function isLocalRequest(req) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').replace(/:\d+$/, '');
  return ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

/**
 * Where the browser should load a session's preview. A local backend gives
 * each session its own proxy port; a deployed one serves it under
 * /preview/<id>/ on its public URL.
 */
async function previewUrlFor(req, sessionId, port) {
  // An API with nothing at "/" opens on its docs page instead of a 404.
  const landing = await findLandingPath(port);
  if (isLocalRequest(req)) {
    return `http://localhost:${await openPortProxy(sessionId, port)}${landing}`;
  }
  const proto = (req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/preview/${sessionId}${landing || '/'}`;
}

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ws?') || req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    pathProxy.upgrade(req, socket, head);
  }
});

function broadcast(sessionId, data) {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

// ─── API Routes ───

/**
 * POST /api/analyze
 * Clone a repo, detect its runtime, and return analysis without running it.
 */
app.post('/api/analyze', async (req, res) => {
  const { repoUrl: rawUrl, branch, token } = req.body;
  if (!rawUrl) return res.status(400).json({ error: 'repoUrl is required' });

  // Accept browser-copied URLs: .../tree/<branch>, ?tab=readme, trailing .git or /.
  const m = rawUrl.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '')
    .match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)(?:\/tree\/([^/\s]+))?/i);
  if (!m) return res.status(400).json({ error: 'That is not a GitHub repository URL.' });
  const repoUrl = `https://github.com/${m[1]}/${m[2]}`;
  const cloneBranch = branch || (m[3] && decodeURIComponent(m[3])) || null;

  const sessionId = uuid();
  const repoDir = join(REPOS_DIR, sessionId);

  try {
    mkdirSync(repoDir, { recursive: true });

    // Clone the repo
    const git = simpleGit();
    const cloneUrl = token
      ? repoUrl.replace('https://', `https://x-access-token:${token}@`)
      : repoUrl;

    await git.clone(cloneUrl, repoDir, ['--depth', '1', ...(cloneBranch ? ['--branch', cloneBranch] : [])]);

    // Detect runtime
    const runtime = detectRuntime(repoDir);
    // Env vars from .env.example files AND from what the code actually reads,
    // so required config (DB URIs, API keys) is surfaced for the user to fill.
    // Only prompt for secrets/DB URIs the user must supply; base URLs and other
    // config are auto-wired by the runner or left to the app's own defaults.
    const withDefaults = envKeysWithDefaults(repoDir);
    // Laravel: the runner generates APP_KEY and falls back to SQLite.
    const isLaravel = runtime.artisan || runtime.nativeFallback?.artisan;
    const runnerProvided = (k) => isLaravel && (k === 'APP_KEY' || k.startsWith('DB_'));
    const envVars = [...new Set([...detectEnvVars(repoDir), ...detectEnvVarsFromCode(repoDir)])]
      .filter((k) => isPromptableSecret(k) && !withDefaults.has(k) && !runnerProvided(k));

    // When the primary runtime needs Docker but a natively-runnable app exists
    // (often in a subfolder), report that as what will actually run.
    const fallbackNative =
      runtime.nativeFallback && canRunNatively(runtime.nativeFallback.id)
        ? runtime.nativeFallback
        : null;
    const effective = canRunNatively(runtime.id) ? runtime : fallbackNative || runtime;

    res.json({
      sessionId,
      runtime: {
        id: effective.id,
        label: effective.label,
        icon: effective.icon,
        color: effective.color,
      },
      envVars,
      commands: {
        install: effective.install,
        start: effective.start,
      },
      nativeAvailable: canRunNatively(runtime.id) || !!fallbackNative,
    });
  } catch (err) {
    // Clean up on failure
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {}
    // git's message includes the clone URL — never echo a token back.
    let message = token ? err.message.split(token).join('***') : err.message;
    if (/not found|could not read Username|Authentication failed/i.test(message)) {
      message = `Couldn't clone ${repoUrl} — it doesn't exist, or it's private (add a GitHub token).`;
    } else if (/Remote branch .* not found/i.test(message)) {
      message = `Branch "${cloneBranch}" doesn't exist in ${repoUrl}.`;
    }
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/run
 * Start running a previously analyzed repo in a Docker sandbox.
 */
app.post('/api/run', async (req, res) => {
  const { sessionId, envVars } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const repoDir = join(REPOS_DIR, sessionId);
  if (!existsSync(repoDir)) {
    return res.status(404).json({ error: 'Session not found. Analyze the repo first.' });
  }

  const runtime = detectRuntime(repoDir);

  broadcast(sessionId, {
    type: 'stage',
    stage: 'building',
    message: `Building ${runtime.label} sandbox...`,
  });

  try {
    const { hostPort } = await startSandbox({
      sessionId,
      repoDir,
      runtime,
      envVars: envVars || {},
      onOutput: (text) => {
        broadcast(sessionId, { type: 'output', text });
      },
    });

    const previewUrl = `http://localhost:${hostPort}`;

    broadcast(sessionId, {
      type: 'stage',
      stage: 'ready',
      message: 'App is running!',
      previewUrl,
    });

    // Wait a moment for the server to be ready, then signal
    setTimeout(() => {
      broadcast(sessionId, {
        type: 'server-ready',
        url: previewUrl,
        port: hostPort,
      });
    }, 3000);

    res.json({ ok: true, previewUrl, port: hostPort, mode: 'docker' });
  } catch (err) {
    broadcast(sessionId, {
      type: 'error',
      message: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/run-native
 * Run a previously analyzed repo natively (without Docker).
 */
app.post('/api/run-native', async (req, res) => {
  const { sessionId, envVars } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  const repoDir = join(REPOS_DIR, sessionId);
  if (!existsSync(repoDir)) {
    return res.status(404).json({ error: 'Session not found. Analyze the repo first.' });
  }

  let runtime = detectRuntime(repoDir);

  // A root script that already starts every service (concurrently "vite"
  // "uvicorn …") is run as-is — the frontend expects the backend exactly where
  // that script puts it. Otherwise, with both a frontend and a backend, run
  // both and wire them together.
  const orchestrated = runtime.id === 'node' && !runtime.workdir ? detectOrchestratedScript(repoDir) : null;
  if (orchestrated) runtime = { ...runtime, start: `${runtime.manager || 'npm'} run ${orchestrated.script}`, orchestrated };
  const services = orchestrated ? [] : detectServices(repoDir).filter((s) => canRunNatively(s.runtime.id));
  const hasFrontend = services.some((s) => s.role === 'frontend');
  const hasBackend = services.some((s) => s.role === 'backend');
  const isCompound = services.length >= 2 && hasFrontend && hasBackend;

  // If the repo's primary runtime needs Docker (or is unknown) but we detected
  // a natively-runnable app (possibly in a subfolder), run that instead.
  if (!isCompound && !canRunNatively(runtime.id) && runtime.nativeFallback && canRunNatively(runtime.nativeFallback.id)) {
    runtime = runtime.nativeFallback;
  }

  if (!isCompound && !canRunNatively(runtime.id)) {
    return res.status(400).json({
      error: `${runtime.label} is not installed on this machine. Install it or use Docker.`,
    });
  }

  broadcast(sessionId, {
    type: 'stage',
    stage: 'building',
    message: isCompound
      ? `Setting up ${services.length} services (frontend + backend)...`
      : orchestrated
        ? `Running the repo's own "${orchestrated.script}" script (it starts every service)...`
        : `Setting up ${runtime.label} natively...`,
  });

  try {
    const onOutput = (text) => broadcast(sessionId, { type: 'output', text });
    // A slow app (e.g. Spring Boot) may open its port after we've responded.
    const onReady = async (port) => {
      const url = await previewUrlFor(req, sessionId, port);
      broadcast(sessionId, { type: 'stage', stage: 'ready', message: 'App is running!', previewUrl: url });
      broadcast(sessionId, { type: 'server-ready', url, port });
    };
    const { hostPort, failed, finished, blocked } = isCompound
      ? await startCompoundNative({ sessionId, repoDir, services, envVars: envVars || {}, onOutput })
      : await startNativeProcess({
          sessionId,
          repoDir,
          runtime,
          envVars: envVars || {},
          onOutput,
          onReady,
        });

    // No port: either a console program (C/C++, expected) or the app failed to
    // open a web server. Don't show a broken "refused to connect" preview.
    if (!hostPort) {
      if (failed) {
        broadcast(sessionId, {
          type: 'error',
          message: blocked
            ? "Windows blocked a program this repo needs (Smart App Control). This PC's security setting stops unsigned programs, including some compiled Python packages, from running."
            : 'The app exited before opening a web server — check the terminal output for the error.',
        });
        res.status(200).json({ ok: false, previewUrl: null, port: null, mode: 'native-failed', blocked: !!blocked });
        return;
      }
      broadcast(sessionId, {
        type: 'stage',
        stage: 'ready',
        message: finished
          ? 'Program finished — its output is in the terminal.'
          : 'Program is running (console output in the terminal).',
      });
      res.json({ ok: true, previewUrl: null, port: null, mode: 'native-console' });
      return;
    }

    const previewUrl = await previewUrlFor(req, sessionId, hostPort);

    broadcast(sessionId, {
      type: 'stage',
      stage: 'ready',
      message: 'App is running!',
      previewUrl,
    });

    broadcast(sessionId, {
      type: 'server-ready',
      url: previewUrl,
      port: hostPort,
    });

    res.json({ ok: true, previewUrl, port: hostPort, mode: 'native' });
  } catch (err) {
    broadcast(sessionId, {
      type: 'error',
      message: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/stop/:sessionId
 * Stop a running sandbox.
 */
app.post('/api/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  closePortProxy(sessionId);

  // Check if it's a native session first
  const nativeSession = getNativeSession(sessionId);
  if (nativeSession) {
    await stopNativeProcess(sessionId, (msg) => {
      broadcast(sessionId, { type: 'output', text: msg });
    });
  } else {
    await stopSandbox(sessionId, (msg) => {
      broadcast(sessionId, { type: 'output', text: msg });
    });
  }

  // Clean up repo files
  const repoDir = join(REPOS_DIR, sessionId);
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {}

  res.json({ ok: true });
});

/**
 * GET /api/status/health-check
 * Check if the backend server AND Docker are running.
 */
app.get('/api/status/health-check', async (req, res) => {
  const nativeRuntimes = checkNativeRuntimes();
  let dockerStatus = 'unavailable';

  if (dockerCheck) {
    try {
      await dockerCheck.ping();
      dockerStatus = 'online';
    } catch {
      dockerStatus = 'offline';
    }
  }

  res.json({
    status: 'ok',
    server: 'online',
    docker: dockerStatus,
    nativeRuntimes,
  });
});

/**
 * GET /api/status/:sessionId
 * Check if a session is running.
 */
app.get('/api/status/:sessionId', (req, res) => {
  // Check both native and Docker sessions
  const nativeSession = getNativeSession(req.params.sessionId);
  const dockerSession = getSession(req.params.sessionId);
  const session = nativeSession || dockerSession;

  if (!session) {
    return res.json({ running: false });
  }
  res.json({
    running: true,
    port: session.hostPort,
    runtime: session.runtime.label,
    mode: nativeSession ? 'native' : 'docker',
    previewUrl: `http://localhost:${session.hostPort}`,
  });
});

/**
 * Previews on a deployed backend: /preview/<sessionId>/... proxies to the
 * app (native or Docker). Must come after the API routes; the fallback catches
 * absolute-path requests (/static/app.css) made from inside a preview.
 */
app.all('/preview/:sessionId', pathProxy.prefixed);
app.all('/preview/:sessionId/*', pathProxy.prefixed);
app.use(pathProxy.fallback);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down — cleaning up...');
  await cleanupAll();
  await cleanupAllNative();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await cleanupAll();
  await cleanupAllNative();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`\n🚀 GitLive backend running on http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   Preview proxy: http://localhost:${PORT}/preview/:sessionId\n`);
});
