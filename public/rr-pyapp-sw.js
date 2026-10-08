// Serves Python web apps (Flask, Django, FastAPI…) that run in the page's
// Pyodide worker, so they work with no backend.
//
// The preview loads /__pyapp/<id>/…; every request under that path — and every
// root-relative request a page of the app makes ("/static/app.css", "/login")
// — is handed to the worker over a BroadcastChannel and answered with what
// the app returned. All other requests pass through untouched.

const PREFIX = '/__pyapp/';
const ACK_TIMEOUT_MS = 5000; // no worker answering → the app isn't running
const RESPONSE_TIMEOUT_MS = 180000; // the first request may wait for Python to start

const channel = new BroadcastChannel('rr-pyapp');
const pending = new Map(); // reqId → { ack, resolve }

channel.onmessage = ({ data }) => {
  const entry = pending.get(data?.reqId);
  if (!entry) return;
  if (data.type === 'ack') entry.ack();
  if (data.type === 'response') {
    pending.delete(data.reqId);
    entry.resolve(data);
  }
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** '/__pyapp/<id>/rest' → { id, rest } (or null). */
function parseAppPath(pathname) {
  if (!pathname.startsWith(PREFIX)) return null;
  const [id, ...rest] = pathname.slice(PREFIX.length).split('/');
  return id ? { id, rest: `/${rest.join('/')}` } : null;
}

/** The app a URL belongs to, if it's one of the app's pages or files. */
function appOf(urlString) {
  try {
    const url = new URL(urlString);
    return url.origin === self.location.origin ? parseAppPath(url.pathname)?.id || null : null;
  } catch {
    return null;
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const target = parseAppPath(url.pathname);
  if (target) {
    event.respondWith(forward(event.request, target.id, target.rest + url.search));
    return;
  }
  // A root-relative URL used by a page of an app: it means the app's own root.
  const id = appOf(event.request.referrer);
  if (!id) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(Response.redirect(`${PREFIX}${id}${url.pathname}${url.search}`, 302));
  } else {
    event.respondWith(forward(event.request, id, url.pathname + url.search));
  }
});

function page(status, title, text) {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px system-ui;padding:32px;color:#444"><h3>${title}</h3><p>${text}</p></body>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...ISOLATION } });
}

// The preview page is embedded in GitLive's cross-origin-isolated page, so
// its documents must declare an embedder policy too.
const ISOLATION = {
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

async function forward(request, appId, path) {
  const reqId = crypto.randomUUID();
  const headers = [...request.headers.entries()];
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();

  const reply = new Promise((resolve) => {
    let acked = false;
    pending.set(reqId, { ack: () => { acked = true; }, resolve });
    setTimeout(() => {
      if (!acked && pending.has(reqId)) {
        pending.delete(reqId);
        resolve(null);
      }
    }, ACK_TIMEOUT_MS);
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        resolve({ timedOut: true });
      }
    }, RESPONSE_TIMEOUT_MS);
  });
  channel.postMessage({ type: 'request', reqId, appId, method: request.method, path, headers, body });
  const res = await reply;

  if (!res) {
    return page(503, 'This app has stopped', 'The Python app that served this page is no longer running. Run the repo again from GitLive.');
  }
  if (res.timedOut) {
    return page(504, 'The app took too long', 'The Python app didn\'t answer this request in time — the terminal in GitLive may show why.');
  }

  const out = new Headers(ISOLATION);
  for (const [name, value] of res.headers) {
    const key = name.toLowerCase();
    // Framing is how the preview shows the app (Django denies it by default).
    if (['set-cookie', 'content-length', 'transfer-encoding', 'connection', 'content-encoding', 'x-frame-options'].includes(key)) continue;
    if (key === 'content-security-policy') {
      const csp = value.split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';');
      if (csp.trim()) out.append(name, csp);
      continue;
    }
    if (key === 'location') {
      out.set('Location', keepInApp(value, appId));
      continue;
    }
    out.append(name, value);
  }
  const status = res.status || 500;
  const noBody = request.method === 'HEAD' || [101, 204, 205, 304].includes(status);
  return new Response(noBody ? null : res.body, { status, headers: out });
}

/** Keep redirects inside the app: '/login' → '/__pyapp/<id>/login'. */
function keepInApp(location, appId) {
  const base = `${PREFIX}${appId}`;
  try {
    const url = new URL(location, self.location.origin);
    const local = url.origin === self.location.origin || /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(url.hostname);
    if (!local) return location;
    const path = url.pathname.startsWith(`${base}/`) || url.pathname === base ? url.pathname : base + url.pathname;
    return `${self.location.origin}${path}${url.search}${url.hash}`;
  } catch {
    return location;
  }
}
