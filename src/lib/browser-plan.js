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

// Python packages that serve HTTP themselves — a browser tab can't open a
// listening socket, so these need the backend.
const PY_WEB_SERVERS = /^(gradio|flask|django|fastapi|uvicorn|aiohttp|tornado|bottle|sanic|dash|panel|quart|starlette|litestar|falcon|cherrypy|pyramid|web\.py|nicegui|reflex|chainlit|shiny)\b/im;
// Deep-learning stacks have no WebAssembly builds for Pyodide.
const PY_HEAVY_ML = /^(torch|tensorflow|tensorflow-cpu|keras|jax|transformers|diffusers|sentence-transformers|ultralytics|accelerate|onnxruntime|llama-cpp-python|vllm|langchain|llama-index|openai-whisper|spacy)\b/im;
const PY_HEAVY_ML_IMPORT = /^\s*(?:import|from)\s+(torch|tensorflow|keras|jax|transformers|diffusers|sentence_transformers|ultralytics|whisper|langchain|llama_index|spacy)\b/m;
/**
 * Does this script use Transformers only through `pipeline(...)`, with no
 * direct PyTorch/TensorFlow/model-class code or UI server? Those calls can be
 * served by Transformers.js in the browser.
 */
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
    const heavy = (manifests.match(PY_HEAVY_ML) || rootCode.match(PY_HEAVY_ML_IMPORT) || notebookCode.match(PY_HEAVY_ML_IMPORT))?.[1];
    if (heavy) {
      return { kind: null, reason: `This project uses ${heavy}, which can't run in a browser tab — it needs the runner engine (CPU builds are installed automatically).` };
    }
    if (/\bstreamlit\b/.test(manifests) || files.some((f) => /(^|\/)streamlit_app\.py$/.test(f))) {
      const entry = pickPythonEntry(tree, files, ['streamlit_app.py', 'Home.py', 'app.py', 'main.py']);
      return { kind: 'stlite', label: 'Streamlit (in-browser)', entry, reason: 'Streamlit runs in your browser via stlite (Pyodide).' };
    }
    const server = manifests.match(PY_WEB_SERVERS) || (has('manage.py') ? ['django'] : null);
    if (server) {
      return { kind: null, reason: `This is a ${server[0].trim()} web app — it needs to open a network port, which a browser tab can't do.` };
    }
    const entry = pickPythonEntry(tree, files, []);
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
