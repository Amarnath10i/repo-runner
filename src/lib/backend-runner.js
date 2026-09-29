// Client for the runner engine (the backend in /backend): REST + WebSocket for
// repos that can't run in the browser (Java, Go, Rust, PHP, Python web apps…).
//
// Where the engine lives:
//   1. VITE_BACKEND_URL at build time (a deployed engine, e.g. on Railway), else
//   2. the local dev engine when the UI itself is served from localhost, else
//   3. a local engine the visitor opted into ("Connect local engine") — we don't
//      probe their localhost unprompted, since browsers ask permission for that.

const ENGINE_KEY = 'repo-runner-engine-url';
const LOCAL_ENGINE = 'http://localhost:3001';
const PAGE_IS_LOCAL = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

function storedEngine() {
  try {
    return localStorage.getItem(ENGINE_KEY);
  } catch {
    return null;
  }
}

let BACKEND_URL = import.meta.env.VITE_BACKEND_URL || (PAGE_IS_LOCAL ? LOCAL_ENGINE : storedEngine());

/** True when the engine runs on this machine (not a deployed server). */
export const BACKEND_IS_LOCAL = !import.meta.env.VITE_BACKEND_URL;

export function getEngineUrl() {
  return BACKEND_URL;
}

/** Opt into (or out of, with null) a local engine; remembered in this browser. */
export function setEngineUrl(url) {
  BACKEND_URL = url;
  try {
    if (url) localStorage.setItem(ENGINE_KEY, url);
    else localStorage.removeItem(ENGINE_KEY);
  } catch {
    // storage unavailable — keep it for this page load only
  }
}

export const connectLocalEngine = () => setEngineUrl(LOCAL_ENGINE);

const wsUrl = () => `${BACKEND_URL.replace(/^http/, 'ws')}/ws`;

async function postJson(path, body) {
  if (!BACKEND_URL) throw new Error('No runner engine is connected.');
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Engine error: ${res.status}`);
  }
  return res.json();
}

/** Clone a repo on the engine and detect its runtime. */
export function analyzeRepoBackend({ repoUrl, token }) {
  return postJson('/api/analyze', { repoUrl, token });
}

/** Run a previously analyzed repo in a Docker sandbox. */
export function runRepoBackend({ sessionId, envVars }) {
  return postJson('/api/run', { sessionId, envVars });
}

/** Run a previously analyzed repo natively (without Docker). */
export function runRepoNative({ sessionId, envVars }) {
  return postJson('/api/run-native', { sessionId, envVars });
}

/** Stop a running session and delete its files. */
export async function stopRepoBackend(sessionId) {
  if (!BACKEND_URL) return;
  await fetch(`${BACKEND_URL}/api/stop/${sessionId}`, { method: 'POST' });
}

/**
 * Connect to WebSocket for real-time terminal output (and to send input).
 * Returns an object with { ws, close() } for cleanup.
 */
export function connectWebSocket({ sessionId, onOutput, onStage, onServerReady, onError }) {
  const ws = new WebSocket(`${wsUrl()}?session=${sessionId}`);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'output':
          onOutput?.(data.text);
          break;
        case 'stage':
          onStage?.(data);
          break;
        case 'server-ready':
          onServerReady?.(data.url, data.port);
          break;
        case 'error':
          onError?.(data.message);
          break;
        case 'connected':
          onOutput?.(`Connected to the runner engine (session ${data.sessionId.slice(0, 8)})\n`);
          break;
        default:
          break;
      }
    } catch {
      onOutput?.(event.data);
    }
  };

  ws.onerror = () => {
    onError?.('Lost the connection to the runner engine.');
  };

  return {
    ws,
    close: () => {
      if (ws.readyState <= 1) ws.close();
    },
  };
}

/** Preview URL for a Docker-sandboxed app (served through the engine). */
export function getPreviewUrl(sessionId) {
  return `${BACKEND_URL}/preview/${sessionId}/`;
}

/**
 * Is the engine reachable? Returns { serverOnline, dockerOnline, nativeRuntimes }.
 * Retries up to `maxRetries` times (the dev server starts the engine alongside
 * the UI, so it may not be listening yet on first load).
 */
export async function checkBackendStatus({ maxRetries = 1, retryDelayMs = 1500 } = {}) {
  const offline = { serverOnline: false, dockerOnline: false, nativeRuntimes: {} };
  if (!BACKEND_URL) return offline;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/status/health-check`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json();
        return {
          serverOnline: true,
          dockerOnline: data.docker === 'online',
          nativeRuntimes: data.nativeRuntimes || {},
        };
      }
      return { serverOnline: true, dockerOnline: false, nativeRuntimes: {} };
    } catch {
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return offline;
}
