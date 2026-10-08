// Main-thread side of in-browser Python: runs scripts/notebooks in a Pyodide
// worker, and builds a self-contained page for Streamlit apps (stlite).
// Nothing here needs a backend.

import { listFiles, readText } from './browser-plan.js';

const STLITE_VERSION = '1.9.2';

/** Package names from requirements.txt, without pins (Pyodide ships its own builds). */
export function parseRequirements(text, exclude = []) {
  return (text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l && !l.startsWith('-') && !/^(git\+|https?:)/.test(l))
    .map((l) => l.split(/[<>=!~;\[\s]/)[0])
    .filter((name) => name && !exclude.includes(name.toLowerCase()));
}

/**
 * Requirement specs that keep the project on its major versions: an exact pin
 * 'Django==4.2.1' becomes 'Django>=4.2.1,<5'. Frameworks break APIs between
 * majors (Starlette 1.0, Django 6), but the exact old release often predates
 * the browser's Python (3.14) — the newest compatible release is the best bet.
 * The worker unpins whatever has no browser build at all.
 */
export function parseRequirementSpecs(text) {
  return (text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').replace(/;.*/, '').trim())
    .filter((l) => l && !l.startsWith('-') && !/^(git\+|https?:)/.test(l))
    .map((l) => l.replace(/\s+/g, ''))
    .map((l) => {
      const m = l.match(/^([\w.\-[\],]+)===?(\d+)((?:\.\w+)*)$/);
      return m ? `${m[1]}>=${m[2]}${m[3]},<${Number(m[2]) + 1}` : l;
    });
}

function repoFiles(tree) {
  return listFiles(tree).map((path) => {
    let node = { directory: tree };
    for (const part of path.split('/')) node = node.directory[part];
    return { path, data: node.file.contents ?? '' };
  });
}

/**
 * Run a Python script or notebook in a Pyodide worker. Returns controls:
 * { sendInput(line), stop() }. Output arrives through the callbacks.
 */
export function runPythonInBrowser({ tree, entry, mode, hfBridge = false, onOutput, onFigure, onStatus, onInputRequest, onDone }) {
  const worker = new Worker(new URL('./python.worker.js', import.meta.url), { type: 'module' });

  // input() support: the worker blocks on this buffer until a line arrives.
  const stdinBuffer = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated
    ? new SharedArrayBuffer(8 + 64 * 1024)
    : null;
  const queued = [];
  let waiting = false;
  const deliver = (line) => {
    const ctrl = new Int32Array(stdinBuffer, 0, 2);
    const bytes = new TextEncoder().encode(line).slice(0, 64 * 1024);
    new Uint8Array(stdinBuffer, 8).set(bytes);
    ctrl[1] = bytes.length;
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
    waiting = false;
  };

  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'stdout':
        onOutput(data.text);
        break;
      case 'stderr':
        onOutput(`\x1b[31m${data.text}\x1b[0m`);
        break;
      case 'status':
        onStatus?.(data.text);
        break;
      case 'figure':
        onFigure?.(`data:image/png;base64,${data.png}`);
        break;
      case 'input-request':
        if (queued.length) deliver(queued.shift());
        else {
          waiting = true;
          onInputRequest?.();
        }
        break;
      case 'done':
        onDone?.(data.code);
        break;
      default:
    }
  };
  worker.onerror = (e) => {
    onOutput(`\x1b[31m${e.message || 'Python worker failed to start'}\x1b[0m\n`);
    onDone?.(1);
  };

  const requirements = parseRequirements(readText(tree, 'requirements.txt'));
  worker.postMessage({ type: 'run', files: repoFiles(tree), entry, mode, requirements, stdinBuffer, hfBridge });

  return {
    sendInput(line) {
      if (!stdinBuffer) return;
      if (waiting) deliver(`${line}\n`);
      else queued.push(`${line}\n`);
    },
    stop() {
      worker.terminate();
    },
  };
}

/**
 * Serve a Python web app (Flask, Django, FastAPI…) from a Pyodide worker. A
 * service worker routes the preview's requests (/__pyapp/<id>/…) to it.
 * `app` comes from findPyWebApp(). Resolves to { stop() }; the preview URL
 * arrives through onReady once the app has loaded.
 */
export async function servePythonWebApp({ tree, app, env = {}, onOutput, onStatus, onReady, onDone }) {
  if (!('serviceWorker' in navigator)) {
    throw new Error("This browser can't serve web pages from Python (service workers are off, e.g. in a private window).");
  }
  await navigator.serviceWorker.register('/rr-pyapp-sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;

  const appId = Math.random().toString(36).slice(2, 10);
  const prefix = `/__pyapp/${appId}`;
  const worker = new Worker(new URL('./python.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'stdout':
        onOutput(data.text);
        break;
      case 'stderr':
        onOutput(`\x1b[31m${data.text}\x1b[0m`);
        break;
      case 'status':
        onStatus?.(data.text);
        break;
      case 'web-ready':
        onReady(`${location.origin}${prefix}/${data.landing || ''}`, appId);
        break;
      case 'done':
        onDone?.(data.code);
        break;
      default:
    }
  };
  worker.onerror = (e) => {
    onOutput(`\x1b[31m${e.message || 'Python worker failed to start'}\x1b[0m\n`);
    onDone?.(1);
  };

  const reqFiles = ['requirements.txt', app.base && app.base !== '.' ? `${app.base}/requirements.txt` : null].filter(Boolean);
  const requirements = [...new Set(reqFiles.flatMap((f) => parseRequirementSpecs(readText(tree, f))))];
  worker.postMessage({ type: 'serve', files: repoFiles(tree), app: { ...app, env }, requirements, appId, prefix });

  return {
    appId,
    stop() {
      worker.terminate();
    },
  };
}

/**
 * Send one HTTP request to an in-browser Python app (the same channel its
 * service worker uses). Resolves { status, headers, body: Uint8Array }.
 */
export function pyAppRequest(appId, { method, path, headers = [], body = null }) {
  const channel = new BroadcastChannel('rr-pyapp');
  const reqId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ status: 504, headers: [], body: new TextEncoder().encode('The Python app took too long to answer.') }), 180000);
    function finish(res) {
      clearTimeout(timer);
      channel.close();
      resolve(res);
    }
    channel.onmessage = ({ data }) => {
      if (data?.type === 'response' && data.reqId === reqId) finish(data);
    };
    channel.postMessage({ type: 'request', reqId, appId, method, path, headers, body });
  });
}

function toBase64(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function pageUrl(html) {
  return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
}

const PAGE_STYLE = 'html,body{margin:0;height:100%;background:#fff}';

/** A page that runs a Streamlit app with stlite. Returns a blob: URL. */
export function buildStlitePage({ tree, entry }) {
  // Files go in base64 so binary assets (images, models, CSVs) survive intact.
  const files = Object.fromEntries(repoFiles(tree).map((f) => [f.path, toBase64(f.data)]));
  const config = {
    entrypoint: entry,
    requirements: parseRequirements(readText(tree, 'requirements.txt'), ['streamlit']),
  };
  return pageUrl(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Streamlit app</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@stlite/browser@${STLITE_VERSION}/build/stlite.css">
<style>${PAGE_STYLE}</style></head><body><div id="root"></div>
<script type="module">
import { mount } from "https://cdn.jsdelivr.net/npm/@stlite/browser@${STLITE_VERSION}/build/stlite.js";
const config = ${JSON.stringify(config)};
const b64 = ${JSON.stringify(files)};
const files = {};
for (const [path, data] of Object.entries(b64)) {
  files[path] = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}
mount({ ...config, files }, document.getElementById("root"));
</script></body></html>`);
}
