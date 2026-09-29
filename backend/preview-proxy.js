// Serves a running app's preview so it works inside the runner's iframe, both
// when the backend runs on the user's machine and when it's deployed.
//
// - Local backend: each session gets its own proxy port (http://localhost:<p>),
//   so apps see a normal root path and nothing needs rewriting.
// - Deployed backend: one public port, so previews live under
//   /preview/<sessionId>/. Apps that use absolute paths (/static/app.css,
//   fetch('/api')) are routed back to their session by the Referer header.
//
// Either way, headers that forbid framing (X-Frame-Options, CSP
// frame-ancestors — Django and Spring Security send these by default) are
// stripped, and WebSockets (HMR, Streamlit) are forwarded.

import { createServer, get as httpGet } from 'http';
import httpProxy from 'http-proxy';

const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true });

proxy.on('proxyRes', (proxyRes, req) => {
  delete proxyRes.headers['x-frame-options'];
  const csp = proxyRes.headers['content-security-policy'];
  if (csp) {
    proxyRes.headers['content-security-policy'] = csp
      .split(';')
      .filter((d) => !/^\s*frame-ancestors\b/i.test(d))
      .join(';');
  }
  // Path mode: keep the app's redirects inside its /preview/<id> prefix.
  const loc = proxyRes.headers.location;
  if (req.rrPrefix && loc) {
    let path = loc.replace(/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?/i, '');
    if (path.startsWith('/') && !path.startsWith(req.rrPrefix)) path = req.rrPrefix + path;
    proxyRes.headers.location = path;
  }
});

proxy.on('error', (err, req, res) => {
  if (res && typeof res.writeHead === 'function') {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<meta http-equiv="refresh" content="2"><p style="font:14px system-ui;padding:24px;color:#666">The app is still starting… this page retries automatically.</p>');
  } else {
    res?.destroy?.(); // a WebSocket socket
  }
});

// ─── Landing page ───

function statusOf(port, path, host) {
  return new Promise((resolve) => {
    const req = httpGet({ host, port, path, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

// Where API-only backends keep something worth looking at.
const LANDING_PATHS = ['/docs', '/swagger', '/swagger/index.html', '/api-docs', '/redoc', '/api', '/health'];

/**
 * The path to open in the preview: '' normally, but for an API whose root is
 * a 404 (FastAPI, ASP.NET minimal APIs, Express APIs) its docs page if any.
 */
export async function findLandingPath(port) {
  let root = await statusOf(port, '/', '127.0.0.1');
  const host = root ? '127.0.0.1' : '::1';
  if (!root) root = await statusOf(port, '/', host);
  if (root !== 404) return '';
  for (const path of LANDING_PATHS) {
    const status = await statusOf(port, path, host);
    if (status >= 200 && status < 400) return path;
  }
  return '';
}

// ─── Local mode: one proxy port per session ───

const PORT_START = 11000;
const PORT_END = 12000;
const portProxies = new Map(); // sessionId -> { server, port, target }

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Open (or retarget) a session's proxy port. Returns the port. */
export async function openPortProxy(sessionId, targetPort) {
  const target = `http://127.0.0.1:${targetPort}`;
  const existing = portProxies.get(sessionId);
  if (existing) {
    existing.target = target;
    return existing.port;
  }
  const entry = { target };
  const server = createServer((req, res) => proxy.web(req, res, { target: entry.target }));
  server.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head, { target: entry.target }));
  const taken = new Set([...portProxies.values()].map((p) => p.port));
  for (let port = PORT_START; port < PORT_END; port++) {
    if (taken.has(port)) continue;
    try {
      await listen(server, port);
      Object.assign(entry, { server, port });
      portProxies.set(sessionId, entry);
      return port;
    } catch {
      // port busy — try the next one
    }
  }
  throw new Error('No free port for the preview proxy.');
}

export function closePortProxy(sessionId) {
  const entry = portProxies.get(sessionId);
  if (!entry) return;
  entry.server.closeAllConnections?.();
  entry.server.close();
  portProxies.delete(sessionId);
}

/** Close proxies whose session is gone (e.g. stopped by its idle timeout). */
export function sweepPortProxies(isAlive) {
  for (const id of portProxies.keys()) if (!isAlive(id)) closePortProxy(id);
}

// ─── Deployed mode: /preview/<sessionId>/ on the backend's own port ───

const SESSION_IN_PATH = /^\/preview\/([0-9a-f-]{36})(\/.*)?$/i;

/** The session a request belongs to, from the Referer of a preview page. */
function sessionFromReferer(req) {
  const ref = req.headers.referer;
  if (!ref) return null;
  try {
    const url = new URL(ref);
    if (url.host !== req.headers.host) return null;
    return url.pathname.match(SESSION_IN_PATH)?.[1] || null;
  } catch {
    return null;
  }
}

/**
 * Express middleware + upgrade handler for path-based previews.
 * `targetFor(id)` returns the app's port (or null); `soleSession()` returns
 * the only running session's id, used when a request carries no hint.
 */
export function createPathProxy({ targetFor, soleSession }) {
  const forward = (req, res, id, prefix) => {
    const port = targetFor(id);
    if (!port) {
      res.status(404).send('This preview has stopped. Run the repo again to get a new one.');
      return;
    }
    req.rrPrefix = prefix;
    proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
  };

  // /preview/<id>/... → the app, with the prefix stripped.
  const prefixed = (req, res) => {
    const id = req.params.sessionId;
    const prefix = `/preview/${id}`;
    if (req.originalUrl === prefix || req.originalUrl.startsWith(`${prefix}?`)) {
      res.redirect(302, `${prefix}/${req.originalUrl.slice(prefix.length)}`);
      return;
    }
    req.url = req.originalUrl.slice(prefix.length) || '/';
    forward(req, res, id, prefix);
  };

  // Absolute-path requests made by a preview page (/static/x.css, /api/...).
  const fallback = (req, res, next) => {
    const fromReferer = sessionFromReferer(req);
    const id = fromReferer || soleSession();
    if (!id || !targetFor(id)) return next();
    const dest = req.headers['sec-fetch-dest'];
    if (fromReferer && (dest === 'document' || dest === 'iframe')) {
      // A link to /about from inside the preview: keep it under the prefix.
      res.redirect(302, `/preview/${id}${req.originalUrl}`);
      return;
    }
    forward(req, res, id, `/preview/${id}`);
  };

  // WebSocket upgrades for previews (HMR, Streamlit, Socket.IO).
  const upgrade = (req, socket, head) => {
    const m = req.url.match(SESSION_IN_PATH);
    const id = m?.[1] || sessionFromReferer(req) || soleSession();
    const port = id && targetFor(id);
    if (!port) {
      socket.destroy();
      return;
    }
    if (m) req.url = m[2] || '/';
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
  };

  return { prefixed, fallback, upgrade };
}
