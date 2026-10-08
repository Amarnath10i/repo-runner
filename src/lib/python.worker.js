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
  if (e.data?.type !== 'run' && e.data?.type !== 'serve') return;
  try {
    if (e.data.type === 'serve') {
      await serve(e.data); // keeps answering requests until the worker is stopped
      return;
    }
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

def rr_pkg_name(spec):
    import re
    return re.split(r'[<>=!~;\[\s]', spec)[0].lower().replace('_', '-')

async def rr_install_sdist(name):
    """Some pure-Python packages only publish source (no wheel), which micropip
    can't use. Copy their Python files into site-packages — unless the source
    has C code to compile."""
    import tarfile, zipfile, site
    from pyodide.http import pyfetch
    try:
        meta = await (await pyfetch(f'https://pypi.org/pypi/{name}/json')).json()
        sdist = next((u for u in meta['urls'] if u['packagetype'] == 'sdist'), None)
        if not sdist:
            return False
        data = await (await pyfetch(sdist['url'])).bytes()
        if sdist['filename'].endswith('.zip'):
            archive = zipfile.ZipFile(io.BytesIO(data))
            names = [n for n in archive.namelist() if not n.endswith('/')]
            read = archive.read
        else:
            archive = tarfile.open(fileobj=io.BytesIO(data))
            names = [m.name for m in archive.getmembers() if m.isfile()]
            read = lambda n: archive.extractfile(n).read()
        if any(n.endswith(('.c', '.cpp', '.pyx', '.rs', '.f90')) for n in names):
            return False
        root = names[0].split('/')[0] + '/'
        rels = {n[len(root):]: n for n in names if n.startswith(root)}
        src = 'src/' if any(r.startswith('src/') and r.count('/') == 2 and r.endswith('/__init__.py') for r in rels) else ''
        rels = {r[len(src):]: n for r, n in rels.items() if r.startswith(src)}
        packages = {r.split('/')[0] for r in rels if r.count('/') == 1 and r.endswith('/__init__.py')}
        modules = {r for r in rels if '/' not in r and r.endswith('.py') and r not in ('setup.py', 'conftest.py')}
        if not packages and not modules:
            return False
        target = site.getsitepackages()[0]
        for rel, full in rels.items():
            if rel.split('/')[0] in packages or rel in modules:
                path = os.path.join(target, rel)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, 'wb') as f:
                    f.write(read(full))
        print(f"\x1b[33m[install] {name}: installed from its source package (no wheel)\x1b[0m")
        return True
    except Exception:
        return False

def rr_mock_version(spec):
    import re
    m = re.search(r'(?:==|>=|~=)\s*([\w.]+)', spec)
    return m.group(1) if m else '1.0'

async def rr_install(pkgs):
    if not pkgs:
        return
    import micropip, re
    specs = list(dict.fromkeys(pkgs))
    dropped = []
    # Install together so pinned versions stay consistent. micropip names what
    # it can't get; each round fixes just that:
    #  - a pin with no browser build (markupsafe==2.1.5, compiled) → Pyodide's
    #    own build, and the same for packages tied to it (pydantic → pydantic-core);
    #  - something pulled in only as a dependency (uvloop for uvicorn[standard])
    #    → an empty placeholder package, it's only an accelerator;
    #  - anything still impossible → skipped.
    for _ in range(8):
        try:
            await micropip.install(specs, keep_going=True)
            specs = []
            break
        except Exception as e:
            # "Can't find a wheel for: 'a==1', 'b'" — drop the apostrophe first.
            msg = re.sub(r"(\w)'(\w)", r'\1\2', str(e))
            failing = re.findall(r"'([^']+)'", msg)
            names = {rr_pkg_name(f) for f in failing}
            if not names:
                break
            new, changed = [], False
            for s in specs:
                name = rr_pkg_name(s)
                tied = any(n.startswith(name + '-') for n in names)
                if name in names or tied:
                    changed = True
                    if re.search(r'[<>=!~]', s):
                        new.append(re.split(r'[<>=!~;\s]', s)[0])  # unpinned, extras kept
                    elif name in names:
                        dropped.append(s)
                    else:
                        new.append(s)
                else:
                    new.append(s)
            if not changed:
                ours = {rr_pkg_name(s) for s in specs}
                for f in failing:
                    if rr_pkg_name(f) not in ours:
                        micropip.add_mock_package(rr_pkg_name(f), rr_mock_version(f), modules={rr_pkg_name(f).replace('-', '_'): ''})
                        changed = True
            specs = new
            if not changed or not specs:
                break
    installed = {rr_pkg_name(n) for n in micropip.list()}
    for p in dropped:
        if rr_pkg_name(p) not in installed and not await rr_install_sdist(rr_pkg_name(p)):
            print(f"\x1b[33m[install] skipped {p} (not available for Pyodide)\x1b[0m")
    if specs:
        # Still failing as a group: one by one, so the rest still install.
        for p in pkgs:
            try:
                await micropip.install(p)
                continue
            except Exception:
                pass
            # A pinned version with no browser build: the latest one may have one.
            name = re.split(r'[<>=!~;\[\s]', p)[0]
            if name != p:
                try:
                    await micropip.install(name)
                    print(f"\x1b[33m[install] {p} isn't available in the browser — using the latest {name}\x1b[0m")
                    continue
                except Exception:
                    pass
            if not await rr_install_sdist(rr_pkg_name(p)):
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

/** Load Pyodide, route its output to the page and put the repo's files in place. */
async function boot(files, stdinBuffer) {
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
  return pyodide;
}

async function run({ files, entry, mode, requirements, stdinBuffer, hfBridge }) {
  const pyodide = await boot(files, stdinBuffer);

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

// ─── Web apps (Flask, Django, FastAPI, …) ───
// The app is imported (not started as a server) and called directly for each
// request the page's service worker (public/rr-pyapp-sw.js) passes along:
// WSGI apps (Flask, Django, Bottle) synchronously, ASGI apps (FastAPI,
// Starlette, Quart) on Pyodide's asyncio loop.

const WEB_DRIVER = String.raw`
import sys, os, io, asyncio, shutil, importlib, traceback
from urllib.parse import unquote

rr_web = {}

def rr_module_for(path):
    """'app/main.py' → ('.', 'app.main'); 'src/pkg/api.py' → ('src', 'pkg.api');
    a file outside any package is imported from its own folder."""
    parts = path[:-3].split('/')
    if parts[-1] == '__init__':
        parts = parts[:-1]
    i = len(parts) - 1
    while i > 0 and os.path.exists(os.path.join(*parts[:i], '__init__.py')):
        i -= 1
    return (os.path.join(*parts[:i]) if i else '.'), '.'.join(parts[i:])

APP_TYPES = {'flask.Flask', 'fastapi.FastAPI', 'starlette.Starlette', 'quart.Quart', 'bottle.Bottle', 'falcon.App'}
ASGI_TYPES = {'starlette.Starlette', 'quart.Quart', 'falcon.asgi.app.App'}

def rr_type_names(obj):
    names = set()
    for c in type(obj).__mro__:
        names.add(f"{c.__module__}.{c.__name__}")
        names.add(f"{c.__module__.split('.')[0]}.{c.__name__}")
    return names

def rr_is_app(obj):
    return bool(rr_type_names(obj) & APP_TYPES)

def rr_find_app(module):
    for name in ('app', 'application', 'api', 'server', 'main'):
        obj = getattr(module, name, None)
        if obj is not None and rr_is_app(obj):
            return obj
    for obj in list(vars(module).values()):
        if rr_is_app(obj):
            return obj
    for name in ('create_app', 'make_app', 'get_app', 'build_app', 'app_factory'):
        factory = getattr(module, name, None)
        if callable(factory):
            try:
                obj = factory()
            except TypeError:
                continue
            if rr_is_app(obj):
                return obj
    return None

def rr_env_file():
    if not os.path.exists('.env'):
        for example in ('.env.example', '.env.sample', '.env.template'):
            if os.path.exists(example):
                shutil.copy(example, '.env')
                print(f"[setup] Created .env from {example}")
                break

def rr_no_threads():
    """Pyodide has no threads: run 'thread pool' work (FastAPI's sync
    endpoints, file responses) inline instead."""
    try:
        import anyio.to_thread
        async def run_sync(func, *args, abandon_on_cancel=False, cancellable=None, limiter=None):
            return func(*args)
        anyio.to_thread.run_sync = run_sync
    except ImportError:
        pass
    async def run_in_threadpool(func, *args, **kwargs):
        return func(*args, **kwargs)
    for name, mod in list(sys.modules.items()):
        if name.split('.')[0] in ('starlette', 'fastapi') and getattr(mod, 'run_in_threadpool', None) is not None:
            mod.run_in_threadpool = run_in_threadpool

def rr_flask_db(app):
    """Create the app's database (SQLite in the browser): run its migrations,
    or create the tables from its models."""
    if os.path.isdir('migrations'):
        try:
            from flask_migrate import upgrade
            with app.app_context():
                upgrade()
            print('[setup] Ran the database migrations.')
            return
        except Exception as e:
            print(f"[setup] Migrations didn't run: {e}")
    for mod in list(sys.modules.values()):
        for value in list(getattr(mod, '__dict__', {}).values()):
            if type(value).__name__ == 'SQLAlchemy' and type(value).__module__.startswith('flask_sqlalchemy'):
                try:
                    with app.app_context():
                        value.create_all()
                    print('[setup] Created the database tables.')
                except Exception as e:
                    print(f"[setup] Couldn't create the database tables: {e}")
                return

def rr_django_static(app):
    """Serve STATIC_URL from the project's static folders (what runserver
    does), under the app's path prefix."""
    from django.conf import settings
    from django.contrib.staticfiles import finders
    import mimetypes, posixpath
    from urllib.parse import urlparse
    def static_base():
        base = urlparse(str(settings.STATIC_URL)).path
        if base.startswith(rr_web['prefix']):
            base = base[len(rr_web['prefix']):]
        return '/' + base.lstrip('/')
    def wrapped(environ, start_response):
        base, path = static_base(), environ.get('PATH_INFO', '')
        if base != '/' and path.startswith(base):
            rel = posixpath.normpath(path[len(base):]).lstrip('/')
            found = finders.find(rel)
            if not found and getattr(settings, 'STATIC_ROOT', None):
                found = os.path.join(str(settings.STATIC_ROOT), rel)
            if isinstance(found, (list, tuple)):
                found = found[0] if found else None
            if found and os.path.isfile(found):
                with open(found, 'rb') as f:
                    data = f.read()
                ctype = mimetypes.guess_type(found)[0] or 'application/octet-stream'
                start_response('200 OK', [('Content-Type', ctype), ('Content-Length', str(len(data)))])
                return [data]
        return app(environ, start_response)
    return wrapped

class _MissingMeta(type):
    def __getattr__(cls, name):
        return rr_missing_class(f"{cls.__name__}.{name}")
    def __bool__(cls):
        return False

class _Missing(metaclass=_MissingMeta):
    """Stands in for anything from a package the browser can't install."""
    def __init__(self, *args, **kwargs):
        pass
    def __getattr__(self, name):
        return rr_missing_class(name)()
    def __call__(self, *args, **kwargs):
        return self
    def __bool__(self):
        return False
    def __iter__(self):
        return iter(())
    def __repr__(self):
        return f"<{type(self).__name__}: not available in the browser>"

def rr_missing_class(name):
    return _MissingMeta(name, (_Missing,), {})

def rr_missing_attr(module, attr):
    # Python asks modules for __all__, __path__… — those must really be absent.
    if attr.startswith('__') and attr.endswith('__'):
        raise AttributeError(attr)
    return rr_missing_class(f"{module}.{attr}")

def rr_failed_import(exc):
    """The module the app's own code was importing when an installed package
    broke (e.g. the Gemini SDK raising 'gRPC is not installed')."""
    import traceback, re
    app_line = None
    for frame in traceback.extract_tb(exc.__traceback__):
        third_party = 'site-packages' in frame.filename or frame.filename.startswith('<frozen') or '/lib/python3' in frame.filename
        if not third_party and frame.filename.startswith('/home/pyodide'):
            app_line = frame.line
        elif 'site-packages' in frame.filename and app_line:
            m = re.match(r'\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))', app_line or '')
            return (m.group(1) or m.group(2)) if m else None
    return None

def rr_stub_module(name, replace=False):
    """Make 'import <name>' succeed with a placeholder, when <name> belongs to
    a package that has no browser build (an AI SDK with gRPC, a DB driver…)
    — so the app starts and only the features that use it fail."""
    import types
    top = name.split('.')[0]
    if os.path.exists(top) or os.path.exists(top + '.py'):
        return False
    if replace:
        # drop what the failed import left half-loaded
        for key in [k for k in sys.modules if k == name or k.startswith(name + '.')]:
            del sys.modules[key]
    elif name in sys.modules:
        return False
    parts = name.split('.')
    for i in range(1, len(parts) + 1):
        sub = '.'.join(parts[:i])
        if sub not in sys.modules:
            try:
                importlib.import_module(sub)
                continue
            except Exception:
                pass
            mod = types.ModuleType(sub)
            mod.__path__ = []
            mod.__getattr__ = lambda attr, _sub=sub: rr_missing_attr(_sub, attr)
            sys.modules[sub] = mod
            if i > 1:
                setattr(sys.modules['.'.join(parts[:i - 1])], parts[i - 1], mod)
    print(f"\x1b[33m[setup] {name} isn't available in the browser — using a placeholder; features that need it won't work here.\x1b[0m")
    return True

def rr_load_django(settings_module, origin, prefix):
    os.environ['DJANGO_SETTINGS_MODULE'] = settings_module
    # Pyodide always has an event loop running; Django's ORM refuses to run
    # then unless told it's safe (it is — there's only one thread).
    os.environ['DJANGO_ALLOW_ASYNC_UNSAFE'] = 'true'
    from django.conf import settings
    db = settings.DATABASES.get('default', {})
    if 'sqlite3' not in db.get('ENGINE', ''):
        settings.DATABASES['default'] = {'ENGINE': 'django.db.backends.sqlite3', 'NAME': os.path.join(os.getcwd(), 'rr-db.sqlite3')}
        print('[setup] No database server in the browser — using SQLite.')
    settings.ALLOWED_HOSTS = ['*']
    settings.CSRF_TRUSTED_ORIGINS = list(getattr(settings, 'CSRF_TRUSTED_ORIGINS', [])) + [origin]
    # Manifest storages (WhiteNoise's too) need collectstatic first; serve
    # the source files as they are instead.
    plain = 'django.contrib.staticfiles.storage.StaticFilesStorage'
    storages = getattr(settings, 'STORAGES', None)
    if isinstance(storages, dict) and 'Manifest' in storages.get('staticfiles', {}).get('BACKEND', ''):
        storages['staticfiles'] = {'BACKEND': plain}
    if 'Manifest' in str(getattr(settings, 'STATICFILES_STORAGE', '')):
        settings.STATICFILES_STORAGE = plain
    # Absolute static/media URLs ('/static/') must include the app's path.
    for key in ('STATIC_URL', 'MEDIA_URL'):
        value = getattr(settings, key, None)
        if isinstance(value, str) and value.startswith('/') and not value.startswith(prefix):
            setattr(settings, key, prefix + value)
    import django
    django.setup()
    from django.core.management import call_command
    try:
        call_command('migrate', interactive=False, verbosity=0)
        print('[setup] Ran the database migrations.')
    except Exception as e:
        print(f"[setup] Migrations didn't run: {e}")
    from django.core.wsgi import get_wsgi_application
    app = get_wsgi_application()
    if 'django.contrib.staticfiles' in settings.INSTALLED_APPS:
        app = rr_django_static(app)
    return app

async def rr_lifespan(app):
    """Run an ASGI app's startup (lifespan) handlers, if it has any."""
    queue = asyncio.Queue()
    started = asyncio.get_event_loop().create_future()
    async def receive():
        return await queue.get()
    async def send(message):
        if message['type'] == 'lifespan.startup.complete' and not started.done():
            started.set_result(None)
        elif message['type'] == 'lifespan.startup.failed' and not started.done():
            started.set_exception(RuntimeError(message.get('message') or 'startup failed'))
    await queue.put({'type': 'lifespan.startup'})
    scope = {'type': 'lifespan', 'asgi': {'version': '3.0', 'spec_version': '2.0'}, 'state': rr_web['state']}
    task = asyncio.ensure_future(app(scope, receive, send))
    await asyncio.wait([task, started], return_when=asyncio.FIRST_COMPLETED)
    if started.done():
        started.result()  # raise if startup failed
    elif task.exception():
        pass  # the app doesn't do lifespan — fine

async def rr_web_load(spec):
    spec = spec.to_py() if hasattr(spec, 'to_py') else spec
    rr_web.update(prefix=spec['prefix'], host=spec['host'], scheme=spec['scheme'], state={})
    root = os.getcwd()
    rr_env_file()
    if spec.get('django'):
        os.chdir(os.path.join(root, spec.get('base') or '.'))
        sys.path.insert(0, os.getcwd())
        rr_env_file()
        app, asgi = rr_load_django(spec['django'], spec['origin'], spec['prefix']), False
        rr_web['app'], rr_web['asgi'] = app, asgi
        return 'Django'
    else:
        app, first_error, stubbed = None, None, set()
        for path in spec['candidates']:
            base, module = rr_module_for(path)
            os.chdir(os.path.join(root, base))
            if os.getcwd() not in sys.path:
                sys.path.insert(0, os.getcwd())
            rr_env_file()
            print(f"[setup] Importing {module} ({path})")
            for _ in range(15):
                try:
                    app = rr_find_app(importlib.import_module(module))
                    break
                except Exception as e:
                    # A package with no browser build (missing, or broken by a
                    # missing native dependency, however it fails): retry with a
                    # placeholder for what the app's import line asked for.
                    if isinstance(e, ModuleNotFoundError) and e.name and rr_stub_module(e.name):
                        continue
                    target = rr_failed_import(e)
                    if target and target not in stubbed and rr_stub_module(target, replace=True):
                        stubbed.add(target)
                        continue
                    rr_print_exc()
                    first_error = first_error or e
                    break
                except BaseException as e:
                    rr_print_exc()
                    first_error = first_error or e
                    break
            if app is not None:
                break
            os.chdir(root)
        if app is None:
            if first_error:
                raise first_error
            raise RuntimeError("Couldn't find the web app (Flask(...), FastAPI(...)) in " + ', '.join(spec['candidates']))
        asgi = bool(rr_type_names(app) & ASGI_TYPES)
        if 'flask.Flask' in rr_type_names(app):
            rr_flask_db(app)
    rr_no_threads()
    rr_web['app'], rr_web['asgi'] = app, asgi
    if asgi:
        await rr_lifespan(app)
    return type(app).__name__

def rr_wsgi(method, path, query, headers, body):
    host = rr_web['host']
    environ = {
        'REQUEST_METHOD': method,
        'SCRIPT_NAME': rr_web['prefix'],
        'PATH_INFO': unquote(path).encode('utf-8').decode('latin-1'),
        'QUERY_STRING': query,
        'SERVER_NAME': host.split(':')[0],
        'SERVER_PORT': host.split(':')[1] if ':' in host else ('443' if rr_web['scheme'] == 'https' else '80'),
        'SERVER_PROTOCOL': 'HTTP/1.1',
        'REMOTE_ADDR': '127.0.0.1',
        'wsgi.version': (1, 0),
        'wsgi.url_scheme': rr_web['scheme'],
        'wsgi.input': io.BytesIO(body),
        'wsgi.errors': sys.stderr,
        'wsgi.multithread': False,
        'wsgi.multiprocess': False,
        'wsgi.run_once': False,
    }
    for name, value in headers:
        key = name.upper().replace('-', '_')
        if key in ('CONTENT_TYPE', 'CONTENT_LENGTH'):
            environ[key] = value
        else:
            key = 'HTTP_' + key
            environ[key] = f"{environ[key]},{value}" if key in environ else value
    environ['HTTP_HOST'] = host
    environ['CONTENT_LENGTH'] = str(len(body))
    out, chunks = {}, []
    def start_response(status, response_headers, exc_info=None):
        out['status'], out['headers'] = status, response_headers
        return chunks.append
    result = rr_web['app'](environ, start_response)
    try:
        for chunk in result:
            if chunk:
                chunks.append(chunk)
    finally:
        if hasattr(result, 'close'):
            result.close()
    return int(out['status'].split()[0]), [list(h) for h in out['headers']], b''.join(chunks)

def rr_full_asgi_path():
    """Starlette 0.33+ (like uvicorn today) expects scope['path'] to include
    root_path; older versions expect it without."""
    try:
        import starlette
        major, minor = (int(x) for x in starlette.__version__.split('.')[:2])
        return (major, minor) >= (0, 33)
    except Exception:
        return True

async def rr_asgi(method, path, query, headers, body):
    host = rr_web['host']
    if rr_web.get('full_path') is None:
        rr_web['full_path'] = rr_full_asgi_path()
    if rr_web['full_path']:
        path = rr_web['prefix'] + path
    scope = {
        'type': 'http',
        'asgi': {'version': '3.0', 'spec_version': '2.3'},
        'http_version': '1.1',
        'method': method,
        'scheme': rr_web['scheme'],
        'path': unquote(path),
        'raw_path': path.encode(),
        'root_path': rr_web['prefix'],
        'query_string': query.encode(),
        'headers': [(k.lower().encode('latin-1'), v.encode('latin-1')) for k, v in headers if k.lower() != 'host'] + [(b'host', host.encode())],
        'client': ('127.0.0.1', 0),
        'server': (host.split(':')[0], int(host.split(':')[1]) if ':' in host else (443 if rr_web['scheme'] == 'https' else 80)),
        'state': dict(rr_web['state']),
    }
    done = asyncio.Event()
    sent_body = False
    response = {'status': 500, 'headers': []}
    chunks = []
    async def receive():
        nonlocal sent_body
        if not sent_body:
            sent_body = True
            return {'type': 'http.request', 'body': body, 'more_body': False}
        await done.wait()
        return {'type': 'http.disconnect'}
    async def send(message):
        if message['type'] == 'http.response.start':
            response['status'] = message['status']
            response['headers'] = [[k.decode('latin-1'), v.decode('latin-1')] for k, v in message.get('headers', [])]
        elif message['type'] == 'http.response.body':
            chunks.append(message.get('body', b''))
            if not message.get('more_body'):
                done.set()
    await rr_web['app'](scope, receive, send)
    done.set()
    return response['status'], response['headers'], b''.join(chunks)

async def rr_web_handle(method, path, query, headers, body):
    headers, body = headers.to_py(), body.to_bytes()
    try:
        if rr_web['asgi']:
            return await rr_asgi(method, path, query, headers, body)
        return rr_wsgi(method, path, query, headers, body)
    except BaseException:
        rr_print_exc()
        return 500, [['content-type', 'text/plain; charset=utf-8']], traceback.format_exc().encode()
`;

/** Keep the cookies an app sets (a service worker's responses can't set real ones). */
function storeCookies(jar, headers) {
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'set-cookie') continue;
    const [pair, ...attrs] = value.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    const expired = attrs.some((a) => {
      const [k, v = ''] = a.split('=').map((s) => s.trim());
      if (/^max-age$/i.test(k)) return Number(v) <= 0;
      if (/^expires$/i.test(k)) return Date.parse(a.slice(a.indexOf('=') + 1)) < Date.now();
      return false;
    });
    if (expired || !val) jar.delete(key);
    else jar.set(key, val);
  }
}

async function serve({ files, app, requirements, appId, prefix }) {
  // Requests can arrive before Python is up; they wait for the app, one at a time.
  const channel = new BroadcastChannel('rr-pyapp');
  const jar = new Map();
  let handle = null;
  let markReady;
  const appReady = new Promise((resolve) => { markReady = resolve; });
  let queue = Promise.resolve();

  const respond = async ({ method, path, headers }, body, { log = true } = {}) => {
    if (!handle) throw new Error('The Python app failed to start — the terminal in GitLive shows why.');
    const [pathname, query = ''] = path.split(/\?(.*)/s);
    const sent = headers.filter(([k]) => k.toLowerCase() !== 'cookie');
    const cookie = [
      headers.find(([k]) => k.toLowerCase() === 'cookie')?.[1],
      ...[...jar].map(([k, v]) => `${k}=${v}`),
    ].filter(Boolean).join('; ');
    if (cookie) sent.push(['cookie', cookie]);
    const result = await handle(method, pathname, query, sent, body ? new Uint8Array(body) : new Uint8Array());
    const [status, outHeaders, data] = result.toJs();
    result.destroy();
    storeCookies(jar, outHeaders);
    if (log) post('stdout', { text: `\x1b[2m  ${method} ${path} → ${status}\x1b[0m\n` });
    return { status, headers: outHeaders, body: data };
  };

  channel.onmessage = ({ data }) => {
    if (data?.type !== 'request' || data.appId !== appId) return;
    channel.postMessage({ type: 'ack', reqId: data.reqId });
    queue = queue
      .then(() => appReady)
      .then(() => respond(data, data.body))
      .catch((err) => ({ status: 500, headers: [['content-type', 'text/plain; charset=utf-8']], body: new TextEncoder().encode(String(err?.message || err)) }))
      .then((res) => channel.postMessage({ type: 'response', reqId: data.reqId, ...res }));
  };

  const pyodide = await boot(files, null);
  post('status', { text: 'Installing packages…' });
  post('stdout', { text: '\x1b[36m▸ Installing packages…\x1b[0m\n' });
  await pyodide.loadPackage('micropip');
  // Older Pyodide releases ship sqlite3 as a separate package; newer ones build it in.
  await pyodide.loadPackage('sqlite3').catch(() => {});
  await pyodide.runPythonAsync(DRIVER);
  await pyodide.runPythonAsync(WEB_DRIVER);
  const g = pyodide.globals;
  // The project's pinned versions first: Pyodide bundles its own (newer)
  // FastAPI, Starlette, Pydantic… which would otherwise win.
  if (requirements.length) await g.get('rr_install')(pyodide.toPy(requirements));
  const chunks = files.filter((f) => f.path.endsWith('.py') && typeof f.data === 'string').map((f) => f.data);
  for (const chunk of chunks) {
    try {
      await pyodide.loadPackagesFromImports(chunk, { messageCallback: () => {}, errorCallback: () => {} });
    } catch {
      // unparsable file — its imports are retried by rr_missing_imports
    }
  }
  const missing = g.get('rr_missing_imports')(pyodide.toPy(chunks)).toJs();
  if (missing.length) {
    const pkgs = missing.map((m) => IMPORT_TO_PIP[m] || m);
    post('stdout', { text: `  Also installing imported packages: ${pkgs.join(', ')}\n` });
    await g.get('rr_install')(pyodide.toPy(pkgs));
  }

  post('status', { text: 'Starting the app…' });
  post('stdout', { text: '\x1b[36m▸ Starting the app…\x1b[0m\n' });
  const spec = {
    ...app,
    prefix,
    host: self.location.host,
    scheme: self.location.protocol.replace(':', ''),
    origin: self.location.origin,
  };
  let kind;
  try {
    kind = await g.get('rr_web_load')(pyodide.toPy(spec));
  } catch (err) {
    markReady(); // waiting requests get an error page instead of hanging
    throw err;
  }
  handle = g.get('rr_web_handle');
  post('stdout', { text: `\x1b[32m▸ ${kind} app loaded — serving it from this tab.\x1b[0m\n` });

  // API-only apps (FastAPI) have nothing at "/" — open their docs instead.
  let landing = '';
  const home = await respond({ method: 'GET', path: '/', headers: [['accept', 'text/html']] }, null, { log: false });
  if (home.status === 404) {
    const docs = await respond({ method: 'GET', path: '/docs', headers: [['accept', 'text/html']] }, null, { log: false });
    if (docs.status === 200) landing = 'docs';
  }
  markReady();
  post('web-ready', { landing });
}
