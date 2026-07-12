// Express + WebSocket server for the Repo Runner backend.
// Handles cloning repos, detecting runtimes, spinning up Docker sandboxes,
// and streaming terminal output to the frontend via WebSocket.

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import httpProxy from 'http-proxy';
const { createProxyServer } = httpProxy;
import simpleGit from 'simple-git';
import { v4 as uuid } from 'uuid';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { detectRuntime, detectEnvVars } from './detector.js';
import { startSandbox, stopSandbox, getSession, cleanupAll } from './sandbox.js';
import {
  checkNativeRuntimes,
  canRunNatively,
  startNativeProcess,
  stopNativeProcess,
  getNativeSession,
  cleanupAllNative,
} from './native-runner.js';
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
const wss = new WebSocketServer({ server, path: '/ws' });
const proxy = createProxyServer();

const PORT = process.env.PORT || 3001;
const REPOS_DIR = join(process.cwd(), '.repos');

// Ensure repos directory exists
if (!existsSync(REPOS_DIR)) {
  mkdirSync(REPOS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

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

  ws.send(JSON.stringify({ type: 'connected', sessionId }));
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
  const { repoUrl, token } = req.body;
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });

  const sessionId = uuid();
  const repoDir = join(REPOS_DIR, sessionId);

  try {
    mkdirSync(repoDir, { recursive: true });

    // Clone the repo
    const git = simpleGit();
    const cloneUrl = token
      ? repoUrl.replace('https://', `https://x-access-token:${token}@`)
      : repoUrl;

    await git.clone(cloneUrl, repoDir, ['--depth', '1']);

    // Detect runtime
    const runtime = detectRuntime(repoDir);
    const envVars = detectEnvVars(repoDir);

    res.json({
      sessionId,
      runtime: {
        id: runtime.id,
        label: runtime.label,
        icon: runtime.icon,
        color: runtime.color,
      },
      envVars,
      commands: {
        install: runtime.install,
        start: runtime.start,
      },
      nativeAvailable: canRunNatively(runtime.id),
    });
  } catch (err) {
    // Clean up on failure
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch {}
    res.status(500).json({ error: err.message });
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

  const runtime = detectRuntime(repoDir);

  if (!canRunNatively(runtime.id)) {
    return res.status(400).json({
      error: `${runtime.label} is not installed on this machine. Install it or use Docker.`,
    });
  }

  broadcast(sessionId, {
    type: 'stage',
    stage: 'building',
    message: `Setting up ${runtime.label} natively...`,
  });

  try {
    const { hostPort } = await startNativeProcess({
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
 * Proxy preview requests to the running container.
 * GET /preview/:sessionId/*
 */
app.all('/preview/:sessionId/*', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    return res.status(404).send('Session not found or container not running.');
  }

  // Rewrite the URL to strip the /preview/:sessionId prefix
  req.url = req.url.replace(`/preview/${req.params.sessionId}`, '') || '/';

  proxy.web(req, res, {
    target: `http://localhost:${session.hostPort}`,
    changeOrigin: true,
  });
});

// Also handle the case without trailing path
app.all('/preview/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    return res.status(404).send('Session not found.');
  }
  proxy.web(req, res, {
    target: `http://localhost:${session.hostPort}`,
    changeOrigin: true,
  });
});

// Handle proxy errors gracefully
proxy.on('error', (err, req, res) => {
  if (res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('App is still starting up... Refresh in a moment.');
  }
});

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
  console.log(`\n🚀 Repo Runner backend running on http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`   Preview proxy: http://localhost:${PORT}/preview/:sessionId\n`);
});
