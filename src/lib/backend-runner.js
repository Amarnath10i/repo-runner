// Client-side module for the Docker backend execution path.
// Communicates with the backend server via REST + WebSocket for
// repos that can't run in WebContainers (Python, Go, Rust, etc.)

const BACKEND_URL = 'http://localhost:3001';
const WS_URL = 'ws://localhost:3001/ws';

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
 * Check if the backend server is reachable.
 */
export async function isBackendAvailable() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/status/health-check`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok || res.status === 404; // 404 means server is up but no session
  } catch {
    return false;
  }
}
