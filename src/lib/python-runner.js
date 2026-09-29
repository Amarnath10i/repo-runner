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
export function runPythonInBrowser({ tree, entry, mode, onOutput, onFigure, onStatus, onInputRequest, onDone }) {
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
  worker.postMessage({ type: 'run', files: repoFiles(tree), entry, mode, requirements, stdinBuffer });

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
