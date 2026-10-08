// Decides whether (and how) a repo can run entirely in the visitor's browser,
// with no backend: static sites and plain file listings in a WebContainer,
// Python scripts and notebooks in Pyodide, and Streamlit apps via stlite.
// Everything else needs the runner backend.

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'vendor', '__pycache__',
  '.venv', 'venv', 'target', 'bin', 'obj',
]);

/** Every file path in the tree ('dir/file.py'). */
export function listFiles(tree, prefix = '', out = []) {
  for (const [name, node] of Object.entries(tree)) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (node.directory) {
      if (!SKIP_DIRS.has(name)) listFiles(node.directory, path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}

/** The code cells of a notebook (JSON text) joined into one source string. */
function codeCells(json) {
  try {
    return (JSON.parse(json || '{}').cells || [])
      .filter((c) => c.cell_type === 'code')
      .map((c) => (Array.isArray(c.source) ? c.source.join('') : c.source || ''))
      .join('\n');
  } catch {
    return '';
  }
}

/** Text contents of a file in the tree, or null if missing/not downloaded. */
export function readText(tree, path) {
  let node = { directory: tree };
  for (const part of path.split('/')) {
    node = node?.directory?.[part];
    if (!node) return null;
  }
  const contents = node.file?.contents;
  if (contents == null) return null;
  return typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
}

// Python packages that serve HTTP.
const PY_WEB_SERVERS = /^(gradio|flask|django|fastapi|uvicorn|aiohttp|tornado|bottle|sanic|dash|panel|quart|starlette|litestar|falcon|cherrypy|pyramid|web\.py|nicegui|reflex|chainlit|shiny)\b/gim;
// WSGI/ASGI frameworks the browser can host: the app is called directly for
// each request (no socket), with a service worker routing the preview to it.
const PY_WEB_IN_BROWSER = { flask: 'Flask', django: 'Django', fastapi: 'FastAPI', starlette: 'Starlette', quart: 'Quart', bottle: 'Bottle', falcon: 'Falcon' };
// ASGI servers — not needed in the browser, they just come along with an app.
const PY_ASGI_SERVERS = new Set(['uvicorn']);

/**
 * Once every file is downloaded: where a Python web app lives.
 * Django → { django: '<settings module>', base }; others → { candidates, base }
 * with the files most likely to create the app first. null if none found.
 */
export function findPyWebApp(tree, framework) {
  const files = listFiles(tree);
  const byDepth = (a, b) => a.split('/').length - b.split('/').length;
  if (framework === 'django') {
    const manage = files.filter((f) => /(^|\/)manage\.py$/.test(f)).sort(byDepth)[0];
    const settings = manage && (readText(tree, manage) || '').match(/DJANGO_SETTINGS_MODULE['"]\s*,\s*['"]([\w.]+)['"]/)?.[1];
    if (!settings) return null;
    return { django: settings, base: manage.includes('/') ? manage.slice(0, manage.lastIndexOf('/')) : '.' };
  }
  const py = files.filter((f) => f.endsWith('.py')
    && !/(^|\/)(tests?|migrations|alembic|docs|examples?|benchmarks)\//.test(f)
    && !/(^|\/)(test_[^/]*|[^/]*_test|conftest|setup)\.py$/.test(f));
  const asFile = (mod) => {
    const p = mod.replace(/[:(].*$/, '').replace(/\.py$/, '').replace(/\./g, '/');
    return py.includes(`${p}.py`) ? `${p}.py` : py.includes(`${p}/__init__.py`) ? `${p}/__init__.py` : null;
  };
  const out = [];
  // Where the project says its app is: FLASK_APP, then the Procfile's web command.
  for (const f of ['.flaskenv', '.env', '.env.example']) {
    const m = (readText(tree, f) || '').match(/^\s*FLASK_APP\s*=\s*['"]?([\w./:()-]+)/m);
    if (m && asFile(m[1])) out.push(asFile(m[1]));
  }
  const web = (readText(tree, 'Procfile') || '').match(/^web:.*?\b(?:gunicorn|uvicorn|hypercorn|waitress-serve)\b.*?\s([\w.]+):\w+/m);
  if (web && asFile(web[1])) out.push(asFile(web[1]));
  // Then files that create one, entry-like names and shallow files first.
  const creates = /\b(Flask|FastAPI|Starlette|Quart|Bottle)\s*\(|falcon\.(asgi\.)?App\s*\(|def\s+create_app\s*\(/;
  const score = (f) => {
    const text = readText(tree, f) || '';
    return -f.split('/').length
      + (/^(main|app|server|api|wsgi|asgi|application|__init__)\.py$/.test(f.split('/').pop()) ? 2 : 0)
      + (/^\w+\s*=\s*(Flask|FastAPI|Starlette|Quart|Bottle)\s*\(|^\w+\s*=\s*create_app\s*\(/m.test(text) ? 2 : 0);
  };
  out.push(...py.filter((f) => creates.test(readText(tree, f) || '')).sort((a, b) => score(b) - score(a)));
  const candidates = [...new Set(out)].slice(0, 6);
  if (!candidates.length) return null;
  // The folder it's imported from (above its packages) — its requirements live there.
  const parts = candidates[0].split('/').slice(0, -1);
  while (parts.length && files.includes(`${parts.join('/')}/__init__.py`)) parts.pop();
  return { candidates, base: parts.join('/') || '.' };
}
// Deep-learning stacks have no WebAssembly builds for Pyodide.
const PY_HEAVY_ML = /^(torch|tensorflow|tensorflow-cpu|keras|jax|transformers|diffusers|sentence-transformers|ultralytics|accelerate|onnxruntime|llama-cpp-python|vllm|langchain|llama-index|openai-whisper|spacy)\b/im;
const PY_HEAVY_ML_IMPORT = /^\s*(?:import|from)\s+(torch|tensorflow|keras|jax|transformers|diffusers|sentence_transformers|ultralytics|whisper|langchain|llama_index|spacy)\b/m;
/**
 * Does this script use Transformers only through `pipeline(...)`, with no
 * direct PyTorch/TensorFlow/model-class code or UI server? Those calls can be
 * served by Transformers.js in the browser.
 */
/**
 * Once every file is downloaded: the planned notebook if it has code, else the
 * first notebook that does (chapter intros and tables of contents are prose only).
 */
export function notebookWithCode(tree, planned) {
  if (codeCells(readText(tree, planned)).trim()) return planned;
  const notebooks = listFiles(tree)
    .filter((f) => f.endsWith('.ipynb') && !f.includes('.ipynb_checkpoints'))
    // Plain character order: 'notebooks/' before 'notebooks_v1/' (an old copy).
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return notebooks.find((f) => codeCells(readText(tree, f)).trim()) || planned;
}

export function usesOnlyHfPipelines(code) {
  if (!/^\s*from\s+transformers\s+import\s+\(?\s*pipeline\s*\)?\s*$/m.test(code) && !/\btransformers\.pipeline\s*\(/.test(code)) return false;
  if (/^\s*from\s+transformers\s+import\s+(?!\(?\s*pipeline\s*\)?\s*$)/m.test(code)) return false; // AutoModel, Trainer, …
  if (/^\s*(?:import|from)\s+(torch|tensorflow|keras|jax|diffusers|sentence_transformers|gradio|streamlit|flask|fastapi)\b/m.test(code)) return false;
  return true;
}

// Desktop GUI toolkits have no window to draw into in a browser.
const PY_DESKTOP_GUI = /^\s*(?:import|from)\s+(tkinter|pygame|PyQt[56]|PySide[26]|wx|kivy|customtkinter|turtle|pyautogui)\b/m;

const PY_ENTRY_CANDIDATES = ['main.py', 'app.py', 'run.py', 'script.py', 'start.py', 'demo.py', 'index.py'];

function pickPythonEntry(tree, files, preferred) {
  for (const name of [...preferred, ...PY_ENTRY_CANDIDATES]) {
    if (files.includes(name)) return name;
  }
  const rootPy = files.filter((f) => !f.includes('/') && f.endsWith('.py') && !/^(setup|conftest|__init__)\.py$|^test_/.test(f));
  return rootPy.find((f) => /__name__\s*==\s*['"]__main__['"]/.test(readText(tree, f) || '')) || rootPy[0] || null;
}

const FRONTEND_DEPS = ['vite', 'next', 'react-scripts', '@sveltejs/kit', 'nuxt', 'vue', '@angular/core', 'react-dom'];
const FRONTEND_DEV_PORTS = new Set([3000, 3001, 4173, 4200, 5173, 5174]);

/**
 * A JavaScript site in a top-level folder (frontend/, client/, web/…) and the
 * port it expects its API on — from its config and code ("localhost:8000"),
 * else the framework's usual port. null if there's none.
 */
function findJsFrontend(tree, framework) {
  for (const [dir, node] of Object.entries(tree)) {
    if (!node.directory || dir.startsWith('.') || dir === 'node_modules') continue;
    let pkg;
    try {
      pkg = JSON.parse(readText(tree, `${dir}/package.json`) || 'null');
    } catch {
      continue;
    }
    const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
    const scripts = pkg?.scripts || {};
    if (!FRONTEND_DEPS.some((d) => deps[d]) || !(scripts.dev || scripts.start || scripts.serve)) continue;
    const ports = {};
    for (const f of listFiles(node.directory)) {
      if (!/(\.env[\w.]*|\.[cm]?[jt]sx?|\.vue|\.svelte)$/.test(f)) continue;
      for (const m of (readText(node.directory, f) || '').matchAll(/(?:localhost|127\.0\.0\.1):(\d{4,5})/g)) {
        const port = Number(m[1]);
        if (!FRONTEND_DEV_PORTS.has(port)) ports[port] = (ports[port] || 0) + 1;
      }
    }
    const seen = Object.entries(ports).sort((a, b) => b[1] - a[1])[0];
    return { dir, apiPort: seen ? Number(seen[0]) : framework === 'flask' ? 5000 : 8000 };
  }
  return null;
}

/**
 * Plan an in-browser run. Returns { kind, label, entry?, reason } where kind is
 * 'static' | 'python-script' | 'python-notebook' | 'stlite',
 * or { kind: null, reason } when the repo needs the backend.
 * `stack` is the coarse runtime from heuristics.detectStack().
 */
export function planBrowserRun(tree, stack) {
  const files = listFiles(tree);
  const has = (name) => files.includes(name);
  // Every Python manifest (backend/requirements.txt too), one dependency per
  // line with pyproject's indentation and quotes stripped.
  const manifests = files.filter((f) => /(^|\/)(requirements\.txt|pyproject\.toml|Pipfile|setup\.py)$/.test(f))
    .map((f) => (readText(tree, f) || '').toLowerCase().replace(/^[\s"']+/gm, ''))
    .join('\n');

  if (stack === 'python' || (stack === 'unknown' && files.some((f) => f.endsWith('.py') || f.endsWith('.ipynb')))) {
    const rootCode = files.filter((f) => !f.includes('/') && f.endsWith('.py')).map((f) => readText(tree, f) || '').join('\n');
    // Scripts that only use Hugging Face pipelines run on the visitor's GPU
    // through Transformers.js (ONNX + WebGPU) — even if requirements list torch.
    const scriptEntry = pickPythonEntry(tree, files, []);
    const entryCode = scriptEntry ? readText(tree, scriptEntry) || '' : '';
    if (usesOnlyHfPipelines(entryCode)) {
      return {
        kind: 'python-script',
        label: 'Python + Transformers.js',
        entry: scriptEntry,
        hfBridge: true,
        reason: 'Hugging Face pipelines run in your browser with Transformers.js (ONNX on your GPU via WebGPU, or the CPU).',
      };
    }
    const notebookCode = files.filter((f) => !f.includes('/') && f.endsWith('.ipynb')).map((f) => codeCells(readText(tree, f))).join('\n');
    const servers = [...manifests.matchAll(PY_WEB_SERVERS)].map((m) => m[1].toLowerCase());
    if (files.some((f) => /(^|\/)manage\.py$/.test(f))) servers.push('django');
    // Frameworks that run their own server (Gradio, Dash, aiohttp…) need the engine.
    const ownServer = servers.find((s) => !PY_WEB_IN_BROWSER[s] && !PY_ASGI_SERVERS.has(s));
    const framework = !ownServer && servers.find((s) => PY_WEB_IN_BROWSER[s]);
    // For a web app, what it needs is in its manifests; helper scripts beside
    // it (a dataset builder importing sentence_transformers) don't count.
    const heavy = (manifests.match(PY_HEAVY_ML)
      || (!framework && (rootCode.match(PY_HEAVY_ML_IMPORT) || notebookCode.match(PY_HEAVY_ML_IMPORT))))?.[1];
    if (heavy) {
      return { kind: null, reason: `This project uses ${heavy}, which can't run in a browser tab — it needs the runner engine (CPU builds are installed automatically).` };
    }
    if (/\bstreamlit\b/.test(manifests) || files.some((f) => /(^|\/)streamlit_app\.py$/.test(f))) {
      const entry = pickPythonEntry(tree, files, ['streamlit_app.py', 'Home.py', 'app.py', 'main.py']);
      return { kind: 'stlite', label: 'Streamlit (in-browser)', entry, reason: 'Streamlit runs in your browser via stlite (Pyodide).' };
    }
    if (servers.length) {
      if (framework) {
        const name = PY_WEB_IN_BROWSER[framework];
        // A JavaScript site beside the API (frontend/ + backend/): the site
        // runs in the Node sandbox and calls the API running in Pyodide.
        const frontend = findJsFrontend(tree, framework);
        return {
          kind: 'python-web',
          framework,
          frontend,
          label: frontend ? `${name} API + site (in-browser)` : `${name} (in-browser)`,
          reason: frontend
            ? `The ${name} API runs in your browser via Pyodide, and the site in ./${frontend.dir} in the in-browser Node sandbox.`
            : `${name} runs in your browser via Pyodide — this tab serves the app's pages itself.`,
        };
      }
      return { kind: null, reason: `This is a ${ownServer || servers[0]} web app — it runs its own web server, which needs the runner engine.` };
    }
    const entry = pickPythonEntry(tree, files, []);
    const gui = rootCode.match(PY_DESKTOP_GUI);
    if (gui) {
      return { kind: null, reason: `This program opens a desktop window (${gui[1]}), which can't be drawn inside a browser tab.` };
    }
    if (entry) {
      return { kind: 'python-script', label: 'Python (in-browser)', entry, reason: 'Python runs in your browser via Pyodide (WebAssembly).' };
    }
    // Skip table-of-contents / preface notebooks (Index.ipynb, 00.00-Preface)
    // when there are real ones.
    const notebooks = files.filter((f) => f.endsWith('.ipynb') && !f.includes('.ipynb_checkpoints'));
    const isFrontMatter = (f) => /(^|\/)(index|contents|toc|preface|readme|intro(duction)?|00[._-]00)[^/]*\.ipynb$|preface/i.test(f);
    const notebook = notebooks.find((f) => !isFrontMatter(f)) || notebooks[0];
    if (notebook) {
      return { kind: 'python-notebook', label: 'Jupyter notebook (in-browser)', entry: notebook, reason: 'The notebook runs top to bottom in your browser via Pyodide.' };
    }
  }

  if (stack === 'unknown') {
    const hasHtml = files.some((f) => f.endsWith('.html'));
    return hasHtml
      ? { kind: 'static', label: 'Static Site', reason: 'Static site served from an in-browser server.' }
      : { kind: 'static', label: 'Repository Files', browse: true, reason: 'No runnable app found — showing the repository files.' };
  }

  return { kind: null, reason: null };
}
