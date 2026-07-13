// Native process runner — runs projects directly on the host machine
// without Docker. Supports Python, Go, Rust, Ruby, PHP, Java, .NET.
// Falls back to Docker sandbox if the runtime isn't installed locally.

import { spawn, execSync } from 'child_process';
import { join, relative, dirname, delimiter } from 'path';
import { writeFileSync, existsSync, copyFileSync, readdirSync, readFileSync } from 'fs';
import { createConnection } from 'net';
import {
  isPythonProvisioned,
  getProvisionedPythonPath,
  getProvisionedPipPath,
  provisionPython,
  isGoProvisioned,
  getProvisionedGoPath,
  provisionGo,
} from './auto-provision.js';

// Track active native sessions
const nativeSessions = new Map();

const PORT_RANGE_START = 10000;
const PORT_RANGE_END = 11000;
const usedPorts = new Set();
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

function getAvailablePort() {
  for (let p = PORT_RANGE_START; p < PORT_RANGE_END; p++) {
    if (!usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  throw new Error('No available ports for native process.');
}

function releasePort(port) {
  usedPorts.delete(port);
}

/**
 * Check if a command is available on the host system.
 * On Windows, `where` can return paths to Windows Store stub executables
 * that aren't real installations, so we try running the command with --version.
 */
function isCommandAvailable(command) {
  try {
    const check = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
    execSync(check, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a Python command actually works (not a Windows Store stub).
 * Windows Store stubs for python.exe exist in PATH but just open the Store.
 */
function isPythonReal(command) {
  try {
    const result = execSync(`${command} --version`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    const output = result.toString().trim();
    return output.toLowerCase().startsWith('python');
  } catch {
    return false;
  }
}

/**
 * Get the Python executable name.
 * Checks: py (Windows launcher) > python3 > python
 * Validates each by running --version to skip Windows Store stubs.
 */
function getPythonCmd() {
  // On Windows, the `py` launcher is the most reliable way
  if (process.platform === 'win32') {
    if (isPythonReal('py')) return 'py';
  }
  if (isPythonReal('python3')) return 'python3';
  if (isPythonReal('python')) return 'python';
  return null;
}

/**
 * Get the pip executable name.
 * If using `py`, pip is invoked as `py -m pip`.
 */
function getPipCmd(pythonCmd) {
  if (pythonCmd === 'py') return 'py -m pip';
  if (isCommandAvailable('pip3')) return 'pip3';
  if (isCommandAvailable('pip')) return 'pip';
  // Fallback: use python -m pip
  if (pythonCmd) return `${pythonCmd} -m pip`;
  return null;
}

/**
 * Check which runtimes are available natively on this host.
 */
let _cachedRuntimes = null;
export function clearRuntimeCache() {
  _cachedRuntimes = null;
}

export function checkNativeRuntimes() {
  if (_cachedRuntimes) return _cachedRuntimes;

  let python = getPythonCmd();
  let pip = getPipCmd(python);

  // Fallback to provisioned Python if system Python is not found
  if (!python && isPythonProvisioned()) {
    python = getProvisionedPythonPath();
    pip = getProvisionedPipPath();
  }

  _cachedRuntimes = {
    python: !!python,
    pythonCmd: python,
    pipCmd: pip,
    go: isCommandAvailable('go') || isGoProvisioned(),
    rust: isCommandAvailable('cargo'),
    ruby: isCommandAvailable('ruby'),
    php: isCommandAvailable('php'),
    java: isCommandAvailable('java'),
    dotnet: isCommandAvailable('dotnet'),
    node: isCommandAvailable('node'),
    cppCompiler: isCommandAvailable('g++') ? 'g++' : isCommandAvailable('clang++') ? 'clang++' : null,
  };
  _cachedRuntimes.cpp = !!_cachedRuntimes.cppCompiler;

  // Log detected runtimes on first check
  const found = Object.entries(_cachedRuntimes)
    .filter(([k, v]) => v === true && !k.endsWith('Cmd'))
    .map(([k]) => k);
  console.log(`  Native runtimes detected: ${found.length > 0 ? found.join(', ') : 'none'}`);
  if (python) console.log(`  Python: ${python} (pip: ${pip})`);

  return _cachedRuntimes;
}

/**
 * Check if a runtime can be run natively (without Docker).
 */
export function canRunNatively(runtimeId) {
  const runtimes = checkNativeRuntimes();
  const isWin = process.platform === 'win32';
  
  // Python and Go can be auto-provisioned on Windows, so they can run natively.
  const canRunPython = runtimes.python || isWin;
  const canRunGo = runtimes.go || isWin;

  const runtimeMap = {
    'python': canRunPython,
    'python-flask': canRunPython,
    'python-fastapi': canRunPython,
    'python-django': canRunPython,
    'python-streamlit': canRunPython,
    'python-gradio': canRunPython,
    'go': canRunGo,
    'rust': runtimes.rust,
    'ruby': runtimes.ruby,
    'php': runtimes.php,
    'java-maven': runtimes.java,
    'java-gradle': runtimes.java,
    'dotnet': runtimes.dotnet,
    'node': runtimes.node,
    'cpp': runtimes.cpp,
    'static': canRunPython, // served via Python's http.server
  };
  return runtimeMap[runtimeId] ?? false;
}

/**
 * Wait for a port to become reachable (server startup detection).
 * Checks both IPv4 and IPv6 via isPortOpen.
 */
function waitForPort(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      if (await isPortOpen(port)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for port ${port}`));
      setTimeout(check, 500);
    };
    check();
  });
}

function tryConnect(port, host) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(600, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Is a TCP port accepting connections? Checks both IPv4 (127.0.0.1) and IPv6
 * (::1) — many dev servers (Vite, etc.) bind only one family, so checking a
 * single one wrongly reports a running app as crashed.
 */
async function isPortOpen(port) {
  if (await tryConnect(port, '127.0.0.1')) return true;
  return tryConnect(port, '::1');
}

// Ports commonly hardcoded by dev servers, tried as a last resort. Excludes the
// runner's own ports (3001 backend, 5173 Vite) to avoid false positives.
const COMMON_APP_PORTS = [4000, 3000, 5000, 8000, 8080, 8501, 9000, 5000, 3333];

/**
 * Watch app output for a port it announces (e.g. "http://localhost:4000",
 * "listening on port 4000"). Returns a live Set that fills as output streams,
 * plus a scanner to feed each chunk through. Only local URLs count, so a
 * printed DB/API URL the app *connects to* isn't mistaken for its own port.
 */
function createPortObserver() {
  const ports = new Set();
  const patterns = [
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/gi,
    /listening on\s+(?:port\s*)?:?\s*(\d{2,5})/gi,
    /(?:server|app|running).{0,20}?\bport\s*[:=]?\s*(\d{2,5})/gi,
  ];
  const scan = (text) => {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const p = Number(m[1]);
        if (p > 0 && p < 65536) ports.add(p);
      }
    }
  };
  return { ports, scan };
}

/**
 * Wait for the app's server to come up. Prefers the port we allocated (apps
 * that respect $PORT), then any port announced in the app's output, then a
 * short list of common hardcoded ports. Returns the port that opened.
 */
async function waitForServer({ hostPort, observedPorts, timeoutMs = 60000, onOutput }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const p of [hostPort, ...observedPorts]) {
      if (await isPortOpen(p)) {
        if (p !== hostPort) {
          onOutput?.(`\n[info] App bound port ${p} (it ignores $PORT=${hostPort}) — using that for the preview.\n`);
        }
        return p;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Last resort: scan common ports the app may have hardcoded.
  for (const p of COMMON_APP_PORTS) {
    if (p === hostPort) continue;
    if (await isPortOpen(p)) {
      onOutput?.(`\n[info] Detected app on port ${p} — using that for the preview.\n`);
      return p;
    }
  }
  return null;
}

/**
 * Spawn a command and stream output.
 * Returns a promise that resolves when the process exits.
 */
function spawnWithOutput(cmd, args, opts, onOutput) {
  return new Promise((resolve, reject) => {
    onOutput(`$ ${cmd} ${args.join(' ')}\n`);

    const proc = spawn(cmd, args, {
      ...opts,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    proc.stdout.on('data', (data) => onOutput(data.toString()));
    proc.stderr.on('data', (data) => onOutput(data.toString()));
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => resolve({ code, process: proc }));
  });
}

/**
 * Install a single service's dependencies in `cwd`.
 * Shared by the single-app and compound (multi-service) run paths.
 */
async function installDeps({ runtime, cwd, processEnv, runtimes, onOutput }) {
  const isWin = process.platform === 'win32';
  switch (runtime.id) {
    case 'python':
    case 'python-flask':
    case 'python-fastapi':
    case 'python-django':
    case 'python-streamlit':
    case 'python-gradio': {
      if (!runtimes.python) {
        await provisionPython(onOutput);
        clearRuntimeCache();
        Object.assign(runtimes, checkNativeRuntimes());
      }
      const python = runtimes.pythonCmd || 'python';
      onOutput(`\n[setup] Setting up Python virtual environment (using: ${python})...\n`);
      if (!existsSync(join(cwd, '.venv'))) {
        await spawnWithOutput(python, ['-m', 'venv', '.venv'], { cwd, env: processEnv }, onOutput);
      }
      const venvPip = isWin ? join('.venv', 'Scripts', 'pip.exe') : join('.venv', 'bin', 'pip');
      // Match requirements.txt and common variants/typos (requirments.txt,
      // requirement.txt, requirements-dev.txt, ...) so deps still install.
      const reqFile = findRequirementsFile(cwd);
      if (reqFile) {
        await spawnWithOutput(venvPip, ['install', '-r', reqFile], { cwd, env: processEnv }, onOutput);
      } else if (existsSync(join(cwd, 'pyproject.toml'))) {
        await spawnWithOutput(venvPip, ['install', '.'], { cwd, env: processEnv }, onOutput);
      } else {
        // No manifest — install the third-party packages the code imports so
        // scripts (e.g. ML pipelines) don't die on ModuleNotFoundError.
        const pkgs = inferPipPackages(cwd);
        if (pkgs.length) {
          onOutput(`\n[install] No requirements file — installing inferred packages: ${pkgs.join(', ')}\n`);
          await spawnWithOutput(venvPip, ['install', ...pkgs], { cwd, env: processEnv }, onOutput);
        }
      }
      if (runtime.id === 'python-fastapi') {
        await spawnWithOutput(venvPip, ['install', 'uvicorn'], { cwd, env: processEnv }, onOutput);
      }
      if (runtime.id === 'python-streamlit') {
        await spawnWithOutput(venvPip, ['install', 'streamlit'], { cwd, env: processEnv }, onOutput);
      }
      if (runtime.id === 'python-gradio') {
        await spawnWithOutput(venvPip, ['install', 'gradio'], { cwd, env: processEnv }, onOutput);
      }
      break;
    }
    case 'go':
      // Auto-provision Go if it isn't installed, then put it on PATH.
      if (!isCommandAvailable('go')) {
        const goPath = isGoProvisioned() ? getProvisionedGoPath() : await provisionGo(onOutput);
        processEnv.PATH = `${dirname(goPath)}${delimiter}${processEnv.PATH || process.env.PATH || ''}`;
        clearRuntimeCache();
      }
      await spawnWithOutput('go', ['mod', 'download'], { cwd, env: processEnv }, onOutput);
      break;
    case 'rust':
      await spawnWithOutput('cargo', ['build', '--release'], { cwd, env: processEnv }, onOutput);
      break;
    case 'ruby':
      if (existsSync(join(cwd, 'Gemfile'))) {
        await spawnWithOutput('bundle', ['install'], { cwd, env: processEnv }, onOutput);
      }
      break;
    case 'node':
      await spawnWithOutput('npm', ['install'], { cwd, env: processEnv }, onOutput);
      break;
    default:
      if (runtime.install) {
        const [cmd, ...args] = runtime.install.split(' ');
        await spawnWithOutput(cmd, args, { cwd, env: processEnv }, onOutput);
      }
  }
}

/**
 * Build the [command, args] to start a service on `hostPort`.
 * May set port-related vars on `processEnv` (e.g. Flask, Next.js read PORT).
 */
function buildStartCommand({ runtime, hostPort, processEnv }) {
  const isWin = process.platform === 'win32';
  const venvPython = isWin ? join('.venv', 'Scripts', 'python.exe') : join('.venv', 'bin', 'python');
  switch (runtime.id) {
    case 'python-flask':
      processEnv.FLASK_RUN_PORT = String(hostPort);
      processEnv.FLASK_RUN_HOST = '0.0.0.0';
      return { startCmd: venvPython, startArgs: [runtime.start?.split(' ').pop() || 'app.py'] };
    case 'python-fastapi': {
      const venvUvicorn = isWin ? join('.venv', 'Scripts', 'uvicorn.exe') : join('.venv', 'bin', 'uvicorn');
      const modulePart = runtime.start?.match(/uvicorn\s+(\S+)/)?.[1] || 'main:app';
      return { startCmd: venvUvicorn, startArgs: [modulePart, '--host', '0.0.0.0', '--port', String(hostPort)] };
    }
    case 'python-django':
      return { startCmd: venvPython, startArgs: ['manage.py', 'runserver', `0.0.0.0:${hostPort}`] };
    case 'python-streamlit': {
      const venvStreamlit = isWin ? join('.venv', 'Scripts', 'streamlit.exe') : join('.venv', 'bin', 'streamlit');
      const appFile = runtime.start?.match(/streamlit\s+run\s+(\S+)/)?.[1] || 'app.py';
      return { startCmd: venvStreamlit, startArgs: ['run', appFile, '--server.port', String(hostPort), '--server.headless', 'true', '--server.address', '0.0.0.0'] };
    }

    case 'python-gradio': {
      // Gradio reads these env vars, so `demo.launch()` binds our port/host.
      processEnv.GRADIO_SERVER_PORT = String(hostPort);
      processEnv.GRADIO_SERVER_NAME = '0.0.0.0';
      const appFile = runtime.start?.split(' ').pop() || 'app.py';
      return { startCmd: venvPython, startArgs: [appFile] };
    }
    case 'python':
      return { startCmd: venvPython, startArgs: [runtime.start?.split(' ').pop() || 'main.py'] };
    case 'go':
      return { startCmd: 'go', startArgs: ['run', '.'] };
    case 'rust':
      return { startCmd: 'cargo', startArgs: ['run', '--release'] };
    default: {
      if (runtime.start) {
        const parts = runtime.start.split(' ');
        return { startCmd: parts[0], startArgs: parts.slice(1) };
      }
      throw new Error(`No start command configured for ${runtime.label}`);
    }
  }
}

/** Spawn a service process and stream its output. Returns the child process. */
function spawnApp({ startCmd, startArgs, cwd, processEnv, onOutput }) {
  onOutput(`$ ${startCmd} ${startArgs.join(' ')}\n`);
  const proc = spawn(startCmd, startArgs, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: processEnv,
    shell: true,
  });
  proc.stdout.on('data', (data) => onOutput(data.toString()));
  proc.stderr.on('data', (data) => onOutput(data.toString()));
  proc.on('error', (err) => onOutput(`\n[error] Process error: ${err.message}\n`));
  return proc;
}

/**
 * Find a requirements file, tolerating common misspellings/variants
 * (requirments.txt, requirement.txt, requirements-dev.txt, ...). Prefers the
 * correctly-spelled name when present.
 */
function findRequirementsFile(cwd) {
  try {
    const files = readdirSync(cwd);
    const exact = files.find((f) => f.toLowerCase() === 'requirements.txt');
    if (exact) return exact;
    // Fuzzy: anything that starts like "requir…" and ends in .txt.
    return files.find((f) => /^requir\w*\.txt$/i.test(f)) || null;
  } catch {
    return null;
  }
}

// Map Python import names to their pip package names when they differ.
const IMPORT_TO_PIP = {
  cv2: 'opencv-python', PIL: 'pillow', sklearn: 'scikit-learn', skimage: 'scikit-image',
  bs4: 'beautifulsoup4', yaml: 'pyyaml', dotenv: 'python-dotenv', Crypto: 'pycryptodome',
  serial: 'pyserial', dateutil: 'python-dateutil', jwt: 'PyJWT', OpenGL: 'PyOpenGL',
};

const PY_STDLIB = new Set([
  'os', 'sys', 'json', 're', 'math', 'random', 'datetime', 'collections', 'itertools',
  'functools', 'pathlib', 'typing', 'subprocess', 'threading', 'multiprocessing', 'time',
  'logging', 'argparse', 'csv', 'io', 'glob', 'shutil', 'socket', 'http', 'urllib',
  'unittest', 'abc', 'enum', 'dataclasses', 'asyncio', 'warnings', 'copy', 'pickle',
  'hashlib', 'base64', 'string', 'traceback', 'contextlib', 'operator', 'tempfile',
  'uuid', 'decimal', 'statistics', 'queue', 'signal', 'platform', 'inspect', 'importlib',
  'ast', 'types', 'textwrap', 'struct', 'array', 'bisect', 'heapq', 'weakref', 'gc',
  'ctypes', 'sqlite3', 'xml', 'html', 'email', 'ssl', 'select', 'fnmatch', '__future__',
  'concurrent', 'secrets', 'getpass', 'zipfile', 'tarfile', 'binascii', 'codecs',
]);

/**
 * Best-effort: infer third-party pip packages a repo needs by scanning its
 * Python imports, so scripts with no requirements file (e.g. ML pipelines)
 * still get their dependencies. Excludes stdlib and the repo's own modules.
 */
function inferPipPackages(cwd) {
  const localNames = new Set();
  try {
    for (const f of readdirSync(cwd, { withFileTypes: true })) {
      if (f.isDirectory()) localNames.add(f.name);
      else if (f.name.endsWith('.py')) localNames.add(f.name.slice(0, -3));
    }
  } catch {
    // ignore
  }

  const files = collectSources(cwd, new Set(['.py'])).slice(0, 100);
  const mods = new Set();
  const re = /^\s*(?:from\s+([a-zA-Z_]\w*)|import\s+([a-zA-Z_]\w*))/gm;
  for (const rel of files) {
    let content;
    try {
      content = readFileSync(join(cwd, rel), 'utf8');
    } catch {
      continue;
    }
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(content))) {
      const mod = m[1] || m[2];
      if (mod && !PY_STDLIB.has(mod) && !localNames.has(mod)) mods.add(mod);
    }
  }

  const pkgs = new Set();
  for (const mod of mods) pkgs.add(IMPORT_TO_PIP[mod] || mod);
  return [...pkgs].filter(Boolean);
}

/** Write user-provided env vars to a .env file in `cwd` (if any). */
function writeEnvFile(cwd, envVars, onOutput) {
  if (envVars && Object.keys(envVars).length > 0) {
    const content = Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n');
    writeFileSync(join(cwd, '.env'), content);
    onOutput(`Wrote .env with ${Object.keys(envVars).length} variable(s)\n`);
  }
}

// Common env var names frameworks use to locate their API/backend, so a
// frontend can reach a locally-started backend without any manual config.
const API_URL_ENV_KEYS = [
  'NEXT_PUBLIC_API_URL', 'VITE_API_URL', 'REACT_APP_API_URL',
  'API_URL', 'API_BASE_URL', 'BACKEND_URL', 'PUBLIC_API_URL',
];

/** Recursively collect source files with the given extensions under `dir`. */
function collectSources(dir, exts, base = dir, out = []) {
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) {
      if (!SOURCE_SKIP_DIRS.has(it.name)) collectSources(p, exts, base, out);
    } else {
      const dot = it.name.lastIndexOf('.');
      if (dot >= 0 && exts.has(it.name.slice(dot))) {
        out.push(relative(base, p));
      }
    }
  }
  return out;
}

const SOURCE_SKIP_DIRS = new Set(['.git', 'build', 'bin', 'obj', 'node_modules', '.vscode', 'cmake-build-debug']);

/**
 * Compile and run a C/C++ console program, streaming its output to the
 * terminal. Console programs have no web server, so there's no preview port —
 * `hostPort` is null and the UI shows the terminal output only.
 */
async function startConsoleApp({ sessionId, repoDir, runtime, cwd, envVars, runtimes, onOutput }) {
  const processEnv = { ...process.env, ...(envVars || {}) };
  const isWin = process.platform === 'win32';

  if (runtime.id === 'cpp') {
    const compiler = runtimes.cppCompiler;
    if (!compiler) {
      throw new Error('No C/C++ compiler found. Install g++ (MinGW-w64 on Windows) or use Docker.');
    }
    const cppSources = collectSources(cwd, new Set(['.cpp', '.cc', '.cxx']));
    const cSources = cppSources.length === 0 ? collectSources(cwd, new Set(['.c'])) : [];
    const sources = cppSources.length ? cppSources : cSources;
    if (sources.length === 0) throw new Error('No C/C++ source files found to compile.');

    const outBin = isWin ? 'repo-runner-app.exe' : 'repo-runner-app';
    const useC = cppSources.length === 0;
    const cc = useC ? (isCommandAvailable('gcc') ? 'gcc' : compiler) : compiler;
    const std = useC ? '-std=c11' : '-std=c++17';

    onOutput(`\n[build] Compiling ${sources.length} source file(s) with ${cc}...\n`);
    const compile = await spawnWithOutput(cc, [...sources, '-O2', std, '-o', outBin], { cwd, env: processEnv }, onOutput);
    if (compile.code !== 0) {
      throw new Error(`Compilation failed (exit code ${compile.code}). See the errors above.`);
    }
    onOutput(`\n[ready] Compiled successfully. Running the program:\n`);
    onOutput(`\x1b[2m(this is a console program — output appears here; it has no web preview)\x1b[0m\n\n`);

    const runPath = isWin ? outBin : `./${outBin}`;
    const proc = spawnApp({ startCmd: runPath, startArgs: [], cwd, processEnv, onOutput });

    const cleanupTimer = setTimeout(() => {
      stopNativeProcess(sessionId, (msg) => console.log(`[auto-cleanup] ${msg}`));
    }, SESSION_TIMEOUT_MS);

    nativeSessions.set(sessionId, {
      processes: [proc], hostPort: null, ports: [], runtime, repoDir, cleanupTimer, mode: 'native-console',
    });

    proc.on('exit', (code) => onOutput(`\n\x1b[2m[process exited with code ${code}]\x1b[0m\n`));
    return { hostPort: null, console: true };
  }

  throw new Error(`Console runtime ${runtime.label} is not supported yet.`);
}

/**
 * Serve a plain static website (HTML/CSS/JS, no build step) over HTTP using
 * Python's built-in server. If the landing page isn't index.html (e.g.
 * home.html), copy it to index.html so it loads at "/".
 */
async function startStaticSite({ sessionId, repoDir, runtime, cwd, runtimes, onOutput }) {
  const hostPort = getAvailablePort();

  // Ensure Python is available (auto-provision on Windows if needed).
  if (!runtimes.python) {
    await provisionPython(onOutput);
    clearRuntimeCache();
    Object.assign(runtimes, checkNativeRuntimes());
  }
  const python = runtimes.pythonCmd || 'python';

  const entry = runtime.entry || 'index.html';
  if (entry !== 'index.html' && !existsSync(join(cwd, 'index.html'))) {
    try {
      copyFileSync(join(cwd, entry), join(cwd, 'index.html'));
      onOutput(`\n[info] Using ${entry} as the home page (served at /).\n`);
    } catch {
      // If the copy fails, the site is still reachable at /<entry>.
    }
  }

  onOutput(`\n[serve] Serving static site on port ${hostPort}...\n`);
  const proc = spawnApp({
    startCmd: python,
    startArgs: ['-m', 'http.server', String(hostPort), '--bind', '0.0.0.0'],
    cwd,
    processEnv: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    onOutput,
  });

  const cleanupTimer = setTimeout(() => {
    stopNativeProcess(sessionId, (msg) => console.log(`[auto-cleanup] ${msg}`));
  }, SESSION_TIMEOUT_MS);

  const session = {
    processes: [proc], hostPort, ports: [hostPort], runtime, repoDir, cleanupTimer, mode: 'native-static',
  };
  nativeSessions.set(sessionId, session);

  try {
    await waitForPort(hostPort, 30000);
    onOutput(`\n[ready] Static site is live on port ${hostPort}!\n`);
  } catch {
    onOutput(`\n[warning] Port ${hostPort} not detected — the server may still be starting.\n`);
  }
  return { hostPort };
}

/**
 * Start a native process for a repo (no Docker needed).
 */
export async function startNativeProcess({ sessionId, repoDir, runtime, envVars, onOutput }) {
  const runtimes = checkNativeRuntimes();

  // The runnable app may live in a subfolder (monorepo) — run everything there.
  const cwd = runtime.workdir ? join(repoDir, runtime.workdir) : repoDir;
  if (runtime.workdir) {
    onOutput(`\n[info] Project detected in ./${runtime.workdir} — running there.\n`);
  }

  // Console programs (C/C++) have no web server — compile & run to the terminal.
  if (runtime.console) {
    return startConsoleApp({ sessionId, repoDir, runtime, cwd, envVars, runtimes, onOutput });
  }

  // Plain static website — serve the files over HTTP.
  if (runtime.static) {
    return startStaticSite({ sessionId, repoDir, runtime, cwd, runtimes, onOutput });
  }

  const hostPort = getAvailablePort();

  // Write .env file if needed
  writeEnvFile(cwd, envVars, onOutput);

  // Build environment variables for the process
  const processEnv = {
    ...process.env,
    // Force UTF-8 so Python apps that print emoji/Unicode don't crash on
    // Windows' legacy cp1252 console encoding.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    ...(envVars || {}),
    PORT: String(hostPort),
  };

  // ─── Install dependencies ───
  onOutput(`\n[install] Installing dependencies...\n`);
  try {
    await installDeps({ runtime, cwd, processEnv, runtimes, onOutput });
  } catch (err) {
    onOutput(`\n[warning] Install warning: ${err.message}\n`);
    // Continue anyway — some projects work without full install
  }

  // ─── Start the app ───
  onOutput(`\n[start] Starting app on port ${hostPort}...\n`);
  const { startCmd, startArgs } = buildStartCommand({ runtime, hostPort, processEnv });
  const observer = createPortObserver();
  const appProcess = spawnApp({
    startCmd, startArgs, cwd, processEnv,
    onOutput: (t) => { observer.scan(t); onOutput(t); },
  });

  // Set auto-cleanup timer
  const cleanupTimer = setTimeout(() => {
    stopNativeProcess(sessionId, (msg) => console.log(`[auto-cleanup] ${msg}`));
  }, SESSION_TIMEOUT_MS);

  const session = {
    processes: [appProcess],
    hostPort,
    ports: [hostPort], // allocated port(s) to release on stop
    runtime,
    repoDir,
    cleanupTimer,
    mode: 'native',
  };
  nativeSessions.set(sessionId, session);

  // Detect when (and on which port) the server actually comes up.
  const readyPort = await waitForServer({ hostPort, observedPorts: observer.ports, timeoutMs: 60000, onOutput });
  if (readyPort) {
    session.hostPort = readyPort;
    onOutput(`\n[ready] App is live on port ${readyPort}!\n`);
    return { hostPort: readyPort };
  }
  onOutput(`\n[warning] No open port detected — the app may have failed to start (check the logs above).\n`);
  return { hostPort: null, failed: true };
}

/**
 * Run a multi-service repo (e.g. a frontend + a backend in separate folders)
 * natively: start the backend first, then start the frontend wired to it via
 * common API-URL env vars. Returns the frontend's port as the preview URL.
 */
export async function startCompoundNative({ sessionId, repoDir, services, envVars, onOutput }) {
  const runtimes = checkNativeRuntimes();
  const baseEnv = {
    ...process.env,
    // Force UTF-8 for Python apps (see startNativeProcess for why).
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    ...(envVars || {}),
  };
  const processes = [];
  const ports = [];

  const backend = services.find((s) => s.role === 'backend');
  const frontend = services.find((s) => s.role === 'frontend') || services.find((s) => s !== backend);

  // ── Backend first ──
  let apiUrl = '';
  if (backend) {
    const backendPort = getAvailablePort();
    ports.push(backendPort);
    const cwd = backend.workdir ? join(repoDir, backend.workdir) : repoDir;
    onOutput(`\n[info] Backend: ${backend.runtime.label} in ./${backend.workdir || '.'} → port ${backendPort}\n`);
    const bEnv = { ...baseEnv, PORT: String(backendPort) };
    writeEnvFile(cwd, envVars, onOutput);
    onOutput(`\n[install] Installing backend dependencies...\n`);
    try {
      await installDeps({ runtime: backend.runtime, cwd, processEnv: bEnv, runtimes, onOutput });
    } catch (err) {
      onOutput(`\n[warning] Backend install warning: ${err.message}\n`);
    }
    const { startCmd, startArgs } = buildStartCommand({ runtime: backend.runtime, hostPort: backendPort, processEnv: bEnv });
    onOutput(`\n[start] Starting backend...\n`);
    processes.push(spawnApp({ startCmd, startArgs, cwd, processEnv: bEnv, onOutput }));
    try {
      await waitForPort(backendPort, 120000);
      onOutput(`\n[ready] Backend live on port ${backendPort}\n`);
    } catch {
      onOutput(`\n[warning] Backend port ${backendPort} not detected — continuing to start the frontend anyway.\n`);
    }
    apiUrl = `http://127.0.0.1:${backendPort}`;
  }

  // ── Frontend, wired to the backend ──
  const frontPort = getAvailablePort();
  ports.push(frontPort);
  const fcwd = frontend.workdir ? join(repoDir, frontend.workdir) : repoDir;
  const fEnv = { ...baseEnv, PORT: String(frontPort) };
  if (apiUrl) {
    for (const k of API_URL_ENV_KEYS) fEnv[k] = apiUrl;
    onOutput(`\n[info] Wiring frontend → backend at ${apiUrl}\n`);
  }
  onOutput(`\n[info] Frontend: ${frontend.runtime.label} in ./${frontend.workdir || '.'} → port ${frontPort}\n`);
  writeEnvFile(fcwd, envVars, onOutput);
  onOutput(`\n[install] Installing frontend dependencies...\n`);
  try {
    await installDeps({ runtime: frontend.runtime, cwd: fcwd, processEnv: fEnv, runtimes, onOutput });
  } catch (err) {
    onOutput(`\n[warning] Frontend install warning: ${err.message}\n`);
  }
  const { startCmd, startArgs } = buildStartCommand({ runtime: frontend.runtime, hostPort: frontPort, processEnv: fEnv });
  onOutput(`\n[start] Starting frontend...\n`);
  const observer = createPortObserver();
  processes.push(spawnApp({
    startCmd, startArgs, cwd: fcwd, processEnv: fEnv,
    onOutput: (t) => { observer.scan(t); onOutput(t); },
  }));

  const cleanupTimer = setTimeout(() => {
    stopNativeProcess(sessionId, (msg) => console.log(`[auto-cleanup] ${msg}`));
  }, SESSION_TIMEOUT_MS);

  const session = {
    processes,
    hostPort: frontPort,
    ports,
    runtime: frontend.runtime,
    repoDir,
    cleanupTimer,
    mode: 'native-compound',
  };
  nativeSessions.set(sessionId, session);

  const readyPort = await waitForServer({ hostPort: frontPort, observedPorts: observer.ports, timeoutMs: 120000, onOutput });
  if (readyPort) {
    session.hostPort = readyPort; // preview port; `ports` keeps the allocated ones for release
    onOutput(`\n✅ App is live on port ${readyPort}!\n`);
    return { hostPort: readyPort };
  }
  onOutput(`\n⚠ Port ${frontPort} not detected — the app may have failed to start (check the logs above).\n`);
  return { hostPort: null, failed: true };
}

/**
 * Stop a native process.
 */
export async function stopNativeProcess(sessionId, onOutput) {
  const session = nativeSessions.get(sessionId);
  if (!session) {
    onOutput?.('Session not found.\n');
    return;
  }

  clearTimeout(session.cleanupTimer);

  // A session may run one or several processes (compound apps).
  const procs = session.processes || (session.process ? [session.process] : []);
  for (const proc of procs) {
    try {
      if (process.platform === 'win32') {
        // On Windows, use taskkill to kill the process tree
        try {
          execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          proc.kill('SIGKILL');
        }
      } else {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
        }, 3000);
      }
    } catch {
      // already stopped
    }
  }
  onOutput?.('Process(es) stopped.\n');

  for (const port of session.ports || [session.hostPort]) {
    releasePort(port);
  }
  nativeSessions.delete(sessionId);
  onOutput?.('Session cleaned up.\n');
}

/**
 * Get a native session.
 */
export function getNativeSession(sessionId) {
  return nativeSessions.get(sessionId) || null;
}

/**
 * Clean up all native sessions.
 */
export async function cleanupAllNative() {
  for (const [id] of nativeSessions) {
    await stopNativeProcess(id, console.log);
  }
}
