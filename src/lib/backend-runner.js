// Client-side module for the Docker backend execution path.
// Communicates with the backend server via REST + WebSocket for
// repos that can't run in WebContainers (Python, Go, Rust, etc.)

// Configurable for deployment: set VITE_BACKEND_URL to your deployed backend
// (e.g. a Railway URL). Defaults to the local dev backend.
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
const WS_URL = `${BACKEND_URL.replace(/^http/, 'ws')}/ws`;

/**
 * Analyze a repo — clone it on the backend and detect its runtime.
 */
export async function analyzeRepoBackend({ repoUrl, token }) {
  const res = await fetch(`${BACKEND_URL}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoUrl, token }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Backend error: ${res.status}`);
  }

  return res.json();
}

/**
 * Run a previously analyzed repo in a Docker sandbox.
 */
export async function runRepoBackend({ sessionId, envVars }) {
  const res = await fetch(`${BACKEND_URL}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, envVars }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Backend error: ${res.status}`);
  }

  return res.json();
}

/**
 * Run a previously analyzed repo natively (without Docker).
 */
export async function runRepoNative({ sessionId, envVars }) {
  const res = await fetch(`${BACKEND_URL}/api/run-native`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, envVars }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Backend error: ${res.status}`);
  }

  return res.json();
}

/**
 * Stop a running sandbox.
 */
export async function stopRepoBackend(sessionId) {
  await fetch(`${BACKEND_URL}/api/stop/${sessionId}`, { method: 'POST' });
}

/**
 * Connect to WebSocket for real-time terminal output.
 * Returns an object with { ws, close() } for cleanup.
 */
export function connectWebSocket({ sessionId, onOutput, onStage, onServerReady, onError }) {
  const ws = new WebSocket(`${WS_URL}?session=${sessionId}`);

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
          onOutput?.(`Connected to backend (session: ${data.sessionId.slice(0, 8)}...)\n`);
          break;
        default:
          break;
      }
    } catch {
      // Non-JSON message, treat as raw output
      onOutput?.(event.data);
    }
  };

  ws.onerror = () => {
    onError?.('WebSocket connection error — is the backend server running?');
  };

  ws.onclose = () => {
    onOutput?.('\n[Connection closed]\n');
  };

  return {
    ws,
    close: () => {
      if (ws.readyState <= 1) ws.close();
    },
  };
}

/**
 * Get the preview URL for a Docker-sandboxed app.
 */
export function getPreviewUrl(sessionId) {
  return `${BACKEND_URL}/preview/${sessionId}`;
}

/**
 * Check if the backend server is reachable and Docker is available.
 * Returns { serverOnline, dockerOnline } status object.
 * Retries up to `maxRetries` times if the server is unreachable (handles
 * the race condition where Vite auto-starts the backend but it's not ready yet).
 */
export async function checkBackendStatus({ maxRetries = 1, retryDelayMs = 1500 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/status/health-check`, {
        signal: AbortSignal.timeout(2000),
      });

      if (res.ok) {
        const data = await res.json();
        return {
          serverOnline: true,
          dockerOnline: data.docker === 'online',
          nativeRuntimes: data.nativeRuntimes || {},
        };
      }

      // Server responded but not OK — it's still online
      return { serverOnline: true, dockerOnline: false, nativeRuntimes: {} };
    } catch {
      // Server unreachable — retry if we have attempts left
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  return { serverOnline: false, dockerOnline: false, nativeRuntimes: {} };
}

/**
 * Legacy compatibility wrapper.
 * Returns true only if BOTH the backend server AND Docker are online.
 */
export async function isBackendAvailable() {
  const { serverOnline, dockerOnline } = await checkBackendStatus();
  return serverOnline && dockerOnline;
}

