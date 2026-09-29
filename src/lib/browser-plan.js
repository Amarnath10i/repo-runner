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

// Python packages that serve HTTP themselves — a browser tab can't open a
// listening socket, so these need the backend.
const PY_WEB_SERVERS = /^(gradio|flask|django|fastapi|uvicorn|aiohttp|tornado|bottle|sanic|dash|panel|quart|starlette|litestar|falcon|cherrypy|pyramid|web\.py|nicegui|reflex|chainlit|shiny)\b/im;
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

/**
 * Plan an in-browser run. Returns { kind, label, entry?, reason } where kind is
 * 'static' | 'python-script' | 'python-notebook' | 'stlite',
 * or { kind: null, reason } when the repo needs the backend.
 * `stack` is the coarse runtime from heuristics.detectStack().
 */
export function planBrowserRun(tree, stack) {
  const files = listFiles(tree);
  const has = (name) => files.includes(name);
  const manifests = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']
    .map((f) => (readText(tree, f) || '').toLowerCase())
    .join('\n');

  if (stack === 'python' || (stack === 'unknown' && files.some((f) => f.endsWith('.py') || f.endsWith('.ipynb')))) {
    if (/\bstreamlit\b/.test(manifests) || files.some((f) => /(^|\/)streamlit_app\.py$/.test(f))) {
      const entry = pickPythonEntry(tree, files, ['streamlit_app.py', 'Home.py', 'app.py', 'main.py']);
      return { kind: 'stlite', label: 'Streamlit (in-browser)', entry, reason: 'Streamlit runs in your browser via stlite (Pyodide).' };
    }
    const server = manifests.match(PY_WEB_SERVERS) || (has('manage.py') ? ['django'] : null);
    if (server) {
      return { kind: null, reason: `This is a ${server[0].trim()} web app — it needs to open a network port, which a browser tab can't do.` };
    }
    const entry = pickPythonEntry(tree, files, []);
    const rootCode = files.filter((f) => !f.includes('/') && f.endsWith('.py')).map((f) => readText(tree, f) || '').join('\n');
    const gui = rootCode.match(PY_DESKTOP_GUI);
    if (gui) {
      return { kind: null, reason: `This program opens a desktop window (${gui[1]}), which can't be drawn inside a browser tab.` };
    }
    if (entry) {
      return { kind: 'python-script', label: 'Python (in-browser)', entry, reason: 'Python runs in your browser via Pyodide (WebAssembly).' };
    }
    const notebook = files.find((f) => f.endsWith('.ipynb') && !f.includes('.ipynb_checkpoints'));
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
