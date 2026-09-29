// Runs a Python repo in the browser with Pyodide (CPython compiled to
// WebAssembly). Lives in a worker so a busy or looping script can't freeze the
// page, and so input() can block (on a SharedArrayBuffer) until the user types.
//
// Messages in:  { type: 'run', files, entry, mode: 'script'|'notebook', requirements, stdinBuffer }
// Messages out: stdout / stderr {text}, status {text}, figure {png}, input-request, done {code}

export const PYODIDE_VERSION = '314.0.7';
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const ROOT = '/home/pyodide/repo';

const post = (type, data = {}) => self.postMessage({ type, ...data });

self.onmessage = async (e) => {
  if (e.data?.type !== 'run') return;
  try {
    const code = await run(e.data);
    post('done', { code });
  } catch (err) {
    post('stderr', { text: `\n${err?.message || err}\n` });
    post('done', { code: 1 });
  }
};

function writeFiles(pyodide, files) {
  for (const { path, data } of files) {
    const full = `${ROOT}/${path}`;
    pyodide.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    pyodide.FS.writeFile(full, data);
  }
}

/** Blocking stdin backed by a SharedArrayBuffer the page writes lines into. */
function makeStdin(stdinBuffer) {
  if (!stdinBuffer) return () => null; // not cross-origin isolated: behave like EOF
  const ctrl = new Int32Array(stdinBuffer, 0, 2);
  const data = new Uint8Array(stdinBuffer, 8);
  const dec = new TextDecoder();
  return () => {
    Atomics.store(ctrl, 0, 0);
    post('input-request');
    Atomics.wait(ctrl, 0, 0);
    const len = ctrl[1];
    Atomics.store(ctrl, 0, 0);
    return len < 0 ? null : dec.decode(data.slice(0, len));
  };
}

// Python-side driver: package installs, matplotlib capture, and running the
// script (runpy) or the notebook (cell by cell, Jupyter-style).
const DRIVER = String.raw`
import sys, os, io, json, base64, traceback, runpy
import js
from pyodide.code import eval_code_async

os.environ.setdefault('MPLBACKEND', 'agg')

async def rr_install(pkgs):
    if not pkgs:
        return
    import micropip
    try:
        await micropip.install(pkgs, keep_going=True)
    except Exception as e:
        # keep_going reports every package it couldn't get in one error;
        # retry one by one so the rest still install.
        print(f"\x1b[33m[install] some packages aren't available in the browser:\x1b[0m {str(e).splitlines()[0]}")
        for p in pkgs:
            try:
                await micropip.install(p)
            except Exception:
                print(f"\x1b[33m[install] skipped {p} (not available for Pyodide)\x1b[0m")

rr_shown = set()  # ids of figures already sent (per cell / per show)

def rr_emit_figure(fig):
    if id(fig) in rr_shown:
        return
    rr_shown.add(id(fig))
    buf = io.BytesIO()
    fig.savefig(buf, format='png', bbox_inches='tight', dpi=110)
    js.rrFigure(base64.b64encode(buf.getvalue()).decode())

def rr_flush_figures():
    if 'matplotlib.pyplot' in sys.modules:
        import matplotlib.pyplot as plt
        for num in plt.get_fignums():
            rr_emit_figure(plt.figure(num))
        plt.close('all')
    rr_shown.clear()

def rr_display(*objs):
    """Jupyter-style display: figures become images, anything else its repr."""
    for obj in objs:
        if 'matplotlib' in sys.modules:
            from matplotlib.figure import Figure
            if isinstance(obj, Figure):
                rr_emit_figure(obj)
                continue
        print(obj if isinstance(obj, str) else repr(obj))

def rr_patch_matplotlib():
    try:
        import matplotlib
        matplotlib.use('agg')
        import matplotlib.pyplot as plt
        plt.show = lambda *a, **k: rr_flush_figures()
    except ImportError:
        pass

def rr_missing_imports(chunks):
    """Top-level modules the code imports that aren't importable yet.
    Each chunk (file or notebook cell) is parsed on its own, so one bit of
    unparsable code doesn't hide the imports in the rest."""
    import ast, importlib.util
    names = set()
    for code in chunks:
        try:
            tree = ast.parse(code)
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(a.name.split('.')[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                names.add(node.module.split('.')[0])
    local = {os.path.splitext(f)[0] for f in os.listdir('.')}
    return sorted(n for n in names if n not in local and n not in sys.builtin_module_names
                  and importlib.util.find_spec(n) is None)

def rr_print_exc():
    """Print the current exception like Python would, minus the runner's own
    frames (Pyodide internals, runpy, this driver)."""
    etype, value, tb = sys.exc_info()
    frames = [f for f in traceback.extract_tb(tb)
              if '/_pyodide/' not in f.filename and 'runpy' not in f.filename
              and not f.name.startswith('rr_')]
    if frames:
        print('Traceback (most recent call last):', file=sys.stderr)
        print(''.join(traceback.format_list(frames)), end='', file=sys.stderr)
    print(''.join(traceback.format_exception_only(etype, value)), end='', file=sys.stderr)

def rr_run_script(entry):
    folder = os.path.dirname(entry) or '.'
    os.chdir(folder)
    sys.path.insert(0, os.getcwd())
    sys.argv = [os.path.basename(entry)]
    code = 0
    try:
        runpy.run_path(os.path.basename(entry), run_name='__main__')
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException:
        rr_print_exc()
        code = 1
    rr_flush_figures()
    return code

async def rr_run_notebook(cells):
    ns = {'__name__': '__main__', 'display': rr_display}
    sys.path.insert(0, os.getcwd())
    for i, src in enumerate(cells, 1):
        print(f"\x1b[2m── In [{i}] ─────────────────────────\x1b[0m")
        try:
            result = await eval_code_async(src, ns)
            if result is not None:
                rr_display(result)
        except BaseException:
            rr_print_exc()
            print("\x1b[31mStopped at this cell (like Jupyter's Run All).\x1b[0m")
            rr_flush_figures()
            return 1
        rr_flush_figures()
    return 0
`;

// ─── Hugging Face bridge ───
// Scripts that only use `transformers.pipeline(...)` get a stand-in
// `transformers` module backed by Transformers.js: the same task runs on an
// ONNX version of the model, on the visitor's GPU (WebGPU) or CPU (WASM).

// jsDelivr's +esm build resolves the package's bare imports (onnxruntime-web) to CDN URLs.
const TRANSFORMERS_JS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm';
let transformersJs = null;

async function hfDevice() {
  try {
    if (self.navigator?.gpu && (await self.navigator.gpu.requestAdapter())) return 'webgpu';
  } catch {
    // no usable GPU
  }
  return 'wasm';
}

/** Hub ids to try: the name as given, then the common ONNX conversions of it. */
function onnxCandidates(model) {
  if (!model) return [undefined];
  const base = model.split('/').pop();
  return [...new Set([model, `Xenova/${base}`, `onnx-community/${base}`])];
}

self.rrHfPipeline = async (task, model) => {
  transformersJs ||= await import(/* @vite-ignore */ TRANSFORMERS_JS);
  const preferred = await hfDevice();
  let lastProgress = 0;
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.progress - lastProgress >= 20) {
      lastProgress = p.progress;
      post('stdout', { text: `  Downloading ${p.file}… ${Math.round(p.progress)}%\n` });
    }
  };
  let lastError;
  for (const device of preferred === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm']) {
    for (const id of onnxCandidates(model)) {
      try {
        const where = device === 'webgpu' ? 'your GPU (WebGPU)' : 'the CPU (WebAssembly)';
        post('stdout', { text: `\x1b[36m▸ ${task}${id ? ` · ${id}` : ''} — Transformers.js on ${where}\x1b[0m\n` });
        return await transformersJs.pipeline(task, id, { device, progress_callback });
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw new Error(`No ONNX version of ${model || `the default ${task} model`} could be loaded (${lastError?.message || lastError}).`);
};

self.rrHfCall = async (pipe, inputs, options) => {
  const out = await pipe(inputs, options);
  return typeof out?.tolist === 'function' ? out.tolist() : out; // Tensors → nested lists
};

const HF_SHIM = String.raw`
import sys, types, importlib.machinery, js
from pyodide.ffi import run_sync, to_js

def _to_js(value):
    return to_js(value, dict_converter=js.Object.fromEntries)

class Pipeline:
    def __init__(self, task, model=None):
        self.task, self.model = task, model
        self._pipe = run_sync(js.rrHfPipeline(task, model))

    def __call__(self, inputs, *args, **kwargs):
        kwargs.pop("device", None)
        result = run_sync(js.rrHfCall(self._pipe, _to_js(inputs), _to_js(kwargs)))
        return result.to_py() if hasattr(result, "to_py") else result

    def __repr__(self):
        return f"<Transformers.js pipeline task={self.task!r} model={self.model!r}>"

def pipeline(task=None, model=None, *args, **kwargs):
    if task is None:
        raise ValueError("pipeline() needs a task name when running in the browser")
    return Pipeline(task, model)

_mod = types.ModuleType("transformers")
_mod.__spec__ = importlib.machinery.ModuleSpec("transformers", None)
_mod.__version__ = "transformers.js"
_mod.pipeline, _mod.Pipeline = pipeline, Pipeline
sys.modules["transformers"] = _mod
`;

// Packages the bridge replaces — installing them in Pyodide would fail or be pointless.
const HF_BRIDGED = /^(torch|torchvision|torchaudio|transformers|tensorflow|tensorflow-cpu|accelerate|sentencepiece|tokenizers|safetensors|huggingface[-_]hub|optimum|onnxruntime)$/i;

// Import names whose pip package is named differently.
const IMPORT_TO_PIP = {
  cv2: 'opencv-python', PIL: 'pillow', sklearn: 'scikit-learn', skimage: 'scikit-image',
  bs4: 'beautifulsoup4', yaml: 'pyyaml', dotenv: 'python-dotenv', dateutil: 'python-dateutil',
  Crypto: 'pycryptodome', attr: 'attrs', docx: 'python-docx',
};

/** Notebook → list of code-cell sources with shell/magic lines handled. */
function notebookCells(json, pipInstalls) {
  const nb = JSON.parse(json);
  return (nb.cells || [])
    .filter((c) => c.cell_type === 'code')
    .map((c) => (Array.isArray(c.source) ? c.source.join('') : c.source || ''))
    .map((src) => src.split('\n').map((line) => {
      const pip = line.match(/^\s*[!%]\s*pip3?\s+install\s+(.+)$/);
      if (pip) {
        pipInstalls.push(...pip[1].split(/\s+/).filter((a) => a && !a.startsWith('-')));
        return '';
      }
      return /^\s*[!%]/.test(line) ? '' : line; // other shell commands / magics
    }).join('\n'))
    .filter((src) => src.trim());
}

async function run({ files, entry, mode, requirements, stdinBuffer, hfBridge }) {
  post('status', { text: 'Loading Python (Pyodide)…' });
  post('stdout', { text: `\x1b[36m▸ Starting Python in your browser (Pyodide ${PYODIDE_VERSION})…\x1b[0m\n` });
  const { loadPyodide } = await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`);
  const pyodide = await loadPyodide({ indexURL: INDEX_URL });

  const outDec = new TextDecoder();
  const errDec = new TextDecoder();
  pyodide.setStdout({ write: (buf) => { post('stdout', { text: outDec.decode(buf, { stream: true }) }); return buf.length; } });
  pyodide.setStderr({ write: (buf) => { post('stderr', { text: errDec.decode(buf, { stream: true }) }); return buf.length; } });
  pyodide.setStdin({ stdin: makeStdin(stdinBuffer) });
  self.rrFigure = (png) => post('figure', { png });

  writeFiles(pyodide, files);
  pyodide.FS.chdir(ROOT);

  const pipInstalls = [];
  const cells = mode === 'notebook'
    ? notebookCells(new TextDecoder().decode(pyodide.FS.readFile(entry)), pipInstalls)
    : null;
  // Scan each file / cell separately: one unparsable chunk mustn't hide the rest.
  const chunks = cells || files.filter((f) => f.path.endsWith('.py') && typeof f.data === 'string').map((f) => f.data);
  const allCode = chunks.join('\n');

  post('status', { text: 'Installing packages…' });
  post('stdout', { text: '\x1b[36m▸ Installing packages…\x1b[0m\n' });
  await pyodide.loadPackage('micropip');
  for (const chunk of chunks) {
    try {
      await pyodide.loadPackagesFromImports(chunk, {
        messageCallback: (m) => post('stdout', { text: `  ${m}\n` }),
        errorCallback: (m) => post('stderr', { text: `  ${m}\n` }),
      });
    } catch {
      // unparsable chunk — its imports are retried by rr_missing_imports
    }
  }
  await pyodide.runPythonAsync(DRIVER);
  const g = pyodide.globals;
  const toPy = (v) => pyodide.toPy(v);
  if (hfBridge) {
    await pyodide.runPythonAsync(HF_SHIM);
    post('stdout', { text: '  transformers → Transformers.js (ONNX models, WebGPU when available)\n' });
  }

  const wanted = [...new Set([...requirements, ...pipInstalls])].filter((p) => !(hfBridge && HF_BRIDGED.test(p)));
  if (wanted.length) await g.get('rr_install')(toPy(wanted));
  const missing = g.get('rr_missing_imports')(toPy(chunks)).toJs().filter((m) => !(hfBridge && HF_BRIDGED.test(m)));
  if (missing.length) {
    const pkgs = missing.map((m) => IMPORT_TO_PIP[m] || m);
    post('stdout', { text: `  Also installing imported packages: ${pkgs.join(', ')}\n` });
    await g.get('rr_install')(toPy(pkgs));
  }
  if (/matplotlib|seaborn|plt\.|\.plot\(/.test(allCode)) g.get('rr_patch_matplotlib')();

  post('status', { text: 'Running…' });
  if (mode === 'notebook') {
    // Like Jupyter, run the notebook from its own folder so relative paths work.
    if (entry.includes('/')) pyodide.FS.chdir(`${ROOT}/${entry.slice(0, entry.lastIndexOf('/'))}`);
    post('stdout', { text: `\x1b[32m▸ Running ${entry} (${cells.length} code cells)\x1b[0m\n\n` });
    return await g.get('rr_run_notebook')(toPy(cells));
  }
  post('stdout', { text: `\x1b[32m▸ Running ${entry}\x1b[0m\n\n` });
  const runScript = g.get('rr_run_script');
  if (hfBridge) {
    // pipeline() waits on Transformers.js with run_sync, which needs the
    // Python call to run with stack switching (JSPI).
    if (typeof runScript.callPromising !== 'function' || !('Suspending' in WebAssembly)) {
      throw new Error("This browser can't run Hugging Face models from Python yet — use a current Chrome or Edge.");
    }
    return await runScript.callPromising(entry);
  }
  return runScript(entry);
}
