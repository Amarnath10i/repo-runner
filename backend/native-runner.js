// Native process runner — runs projects directly on the host machine
// without Docker. Runtimes that aren't installed (Python, Go, Java, PHP, Ruby,
// Rust, C/C++, Bun, Deno) are downloaded on first use by auto-provision.js.

import { spawn, execSync } from 'child_process';
import { createServer } from 'http';
import { join, relative, delimiter, basename, extname, resolve, sep, dirname } from 'path';
import {
  writeFileSync, existsSync, copyFileSync, readdirSync, readFileSync, statSync, renameSync, createReadStream, rmSync,
} from 'fs';
import { createConnection } from 'net';
import { ensureTool, canProvision, ensureDotnetSdk } from './auto-provision.js';

// Track active native sessions
const nativeSessions = new Map();

const IS_WIN = process.platform === 'win32';
const PORT_RANGE_START = 10000;
const PORT_RANGE_END = 11000;
const usedPorts = new Set();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
// Keep watching for a web server this long after the initial wait gives up,
// so slow starters (Spring Boot, first-time builds) still get a preview.
const LATE_PORT_WINDOW_MS = 20 * 60 * 1000;
// The runner's own ports — an app printing these (e.g. a CORS origin) must not
// be mistaken for the app's server.
const RESERVED_PORTS = new Set([Number(process.env.PORT) || 3001, 5173]);

// cmd.exe may be configured (NoDefaultCurrentDirectoryInExePath) not to run
// programs from the current folder by bare name, so always give a path.
const local = (file) => (IS_WIN ? `.\\${file}` : `./${file}`);


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

const _commandCache = new Map();

/** Is `command` on PATH? Cached; cleared with clearRuntimeCache(). */
function isCommandAvailable(command) {
  if (_commandCache.has(command)) return _commandCache.get(command);
  let found;
  try {
    execSync(IS_WIN ? `where ${command}` : `command -v ${command}`, { stdio: 'ignore' });
    found = true;
  } catch {
    found = false;
  }
  _commandCache.set(command, found);
  return found;
}

/**
 * Check if a Python command actually works (not a Windows Store stub).
 * Windows Store stubs for python.exe exist in PATH but just open the Store.
 */
function isPythonReal(command) {
  try {
    const result = execSync(`${command} --version`, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    return result.toString().trim().toLowerCase().startsWith('python');
  } catch {
    return false;
  }
}

function getPythonCmd() {
  if (IS_WIN && isPythonReal('py')) return 'py';
  if (isPythonReal('python3')) return 'python3';
  if (isPythonReal('python')) return 'python';
  return null;
}

// ─── Which tools each runtime needs ───
// [tool to provision (null = can't be provisioned), command to look for].

const PYTHON_TOOLS = [['uv', 'uv']];
const RUNTIME_TOOLS = {
  'python': PYTHON_TOOLS,
  'python-flask': PYTHON_TOOLS,
  'python-fastapi': PYTHON_TOOLS,
  'python-django': PYTHON_TOOLS,
  'python-streamlit': PYTHON_TOOLS,
  'python-gradio': PYTHON_TOOLS,
  'python-notebook': PYTHON_TOOLS,
  'go': [['go', 'go']],
  'rust': [['rust', 'cargo']],
  'ruby': [['ruby', 'ruby']],
  'php': [['php', 'php']],
  'java-maven': [['java', 'javac'], ['maven', 'mvn']],
  'java-gradle': [['java', 'javac']],
  'java': [['java', 'javac']],
  'deno': [['deno', 'deno']],
  'cpp': [['cpp', 'g++']],
  'dotnet': [], // SDK handled in prepareToolchain (installed per channel)
  'node': [[null, 'node']],
  'static': [],
};

let _cachedRuntimes = null;
export function clearRuntimeCache() {
  _cachedRuntimes = null;
  _commandCache.clear();
}

/** What's installed on this host, plus what can be auto-installed on demand. */
export function checkNativeRuntimes() {
  if (_cachedRuntimes) return _cachedRuntimes;

  const python = getPythonCmd();
  _cachedRuntimes = {
    python: !!python,
    pythonCmd: python,
    pipCmd: python === 'py' ? 'py -m pip' : python ? `${python} -m pip` : null,
    go: isCommandAvailable('go'),
    rust: isCommandAvailable('cargo'),
    ruby: isCommandAvailable('ruby'),
    php: isCommandAvailable('php'),
    java: isCommandAvailable('javac'),
    dotnet: isCommandAvailable('dotnet'),
    node: isCommandAvailable('node'),
    cppCompiler: isCommandAvailable('g++') ? 'g++' : isCommandAvailable('clang++') ? 'clang++' : null,
    autoInstall: ['uv', 'go', 'java', 'maven', 'gradle', 'php', 'ruby', 'rust', 'cpp', 'bun', 'deno'].filter(canProvision),
  };
  _cachedRuntimes.cpp = !!_cachedRuntimes.cppCompiler;

  const found = Object.entries(_cachedRuntimes)
    .filter(([k, v]) => v === true && !k.endsWith('Cmd'))
    .map(([k]) => k);
  console.log(`  Native runtimes detected: ${found.length > 0 ? found.join(', ') : 'none'}`);
  console.log(`  Auto-installable on demand: ${_cachedRuntimes.autoInstall.join(', ') || 'none'}`);
  return _cachedRuntimes;
}

/** Can this runtime run natively — installed already, or auto-installable? */
export function canRunNatively(runtimeId) {
  const tools = RUNTIME_TOOLS[runtimeId];
  if (!tools) return false;
  if (runtimeId === 'cpp' && (isCommandAvailable('g++') || isCommandAvailable('clang++') || isCommandAvailable('gcc'))) return true;
  return tools.every(([tool, cmd]) => isCommandAvailable(cmd) || (tool && canProvision(tool)));
}

/** The tools a specific checkout needs (wrappers, lockfiles and versions matter). */
function toolsForRun(runtime, cwd) {
  let tools = [...(RUNTIME_TOOLS[runtime.id] || [])];
  if (runtime.id === 'node' && runtime.manager === 'bun') tools.push(['bun', 'bun']);
  if (runtime.id === 'java-maven' && existsSync(join(cwd, IS_WIN ? 'mvnw.cmd' : 'mvnw'))) {
    tools = tools.filter(([t]) => t !== 'maven');
  }
  if (runtime.id === 'java-gradle') {
    const wrapper = readGradleWrapperVersion(cwd);
    if (wrapper === null) tools.push(['gradle', 'gradle']);
    // Gradle only runs on JDKs it knows: < 7.3 → 11, < 8.5 → 17.
    else if (wrapper < 500) tools = [['java8', 'javac']]; // Gradle 4 and older can't parse Java 11+ versions
    else if (wrapper < 703) tools = [['java11', 'javac']];
    else if (wrapper < 805) tools = [['java17', 'javac']];
  }
  if (runtime.id === 'cpp' && (isCommandAvailable('g++') || isCommandAvailable('clang++'))) tools = [];
  // Our Windows Rust uses the GNU toolchain; crates that compile C code
  // (via cc-rs) also need gcc and dlltool, which the MinGW toolchain provides.
  if (runtime.id === 'rust' && IS_WIN && !isCommandAvailable('cargo')) tools.push(['cpp', 'gcc']);
  return tools;
}

function readGradleWrapperVersion(cwd) {
  const props = join(cwd, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  if (!existsSync(props) || !existsSync(join(cwd, IS_WIN ? 'gradlew.bat' : 'gradlew'))) return null;
  const m = readFileSafe(props)?.match(/gradle-(\d+)\.(\d+)/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 9999; // 8.5 → 805
}

/**
 * .NET: the project needs an SDK at least as new as its TargetFramework
 * (older targets build on .NET 8 and run with roll-forward). A machine may
 * have only the runtime, or an older SDK — install one when so.
 */
async function prepareDotnet({ runtime, cwd, processEnv, onOutput }) {
  const proj = readFileSafe(join(cwd, runtime.project || '')) || '';
  const tfm = proj.match(/<TargetFrameworks?>\s*net(\d+)\.\d/i);
  const need = Math.max(8, tfm ? Number(tfm[1]) : 8);
  const listed = await captureOutput('dotnet', ['--list-sdks'], { cwd, env: processEnv });
  const majors = (listed.stdout.match(/^\d+/gm) || []).map(Number);
  if (majors.some((m) => m >= need)) return;
  applyToolEnv(processEnv, await ensureDotnetSdk(`${need}.0`, onOutput));
}

/** Is `command` on the PATH of `env` (which may include provisioned tools)? */
function onPath(command, env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  return (env[key] || '').split(delimiter).some((dir) => dir && exts.some((ext) => existsSync(join(dir, command + ext))));
}

/** Put a tool's bin dirs on PATH and set its env vars (JAVA_HOME, CARGO_HOME...). */
function applyToolEnv(processEnv, { pathDirs, vars }) {
  Object.assign(processEnv, vars);
  const key = Object.keys(processEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  processEnv[key] = [...pathDirs, processEnv[key] || ''].join(delimiter);
}

/**
 * Make every tool this runtime needs available in `processEnv`, downloading
 * missing ones. Throws (with a clear message) if one can't be provided.
 */
async function prepareToolchain({ runtime, cwd, processEnv, onOutput }) {
  for (const [tool, cmd] of toolsForRun(runtime, cwd)) {
    // A specific JDK (java8/11/17) is always provisioned: the system one may be too new.
    if (isCommandAvailable(cmd) && !/^java\d/.test(tool || '')) continue;
    if (!tool || !canProvision(tool)) {
      throw new Error(`${runtime.label} needs "${cmd}", which isn't installed and can't be auto-installed on this OS. Install it and try again.`);
    }
    applyToolEnv(processEnv, await ensureTool(tool, onOutput));
  }
  if (runtime.id === 'dotnet') await prepareDotnet({ runtime, cwd, processEnv, onOutput });
  // Composer comes bundled with the PHP we provision; use that PHP if the
  // system one has no Composer.
  if (runtime.id === 'php' && existsSync(join(cwd, 'composer.json')) && !isCommandAvailable('composer') && canProvision('php')) {
    applyToolEnv(processEnv, await ensureTool('php', onOutput));
  }
}

// ─── Waiting for the app's web server ───

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

// Ports commonly hardcoded by dev servers, tried as a last resort.
const COMMON_APP_PORTS = [4000, 3000, 5000, 8000, 8080, 8501, 8888, 9000, 4200, 3333];

/**
 * Watch app output for a port it announces (e.g. "http://localhost:4000",
 * "listening on port 4000"). Only local URLs count, so a printed DB/API URL
 * the app *connects to* isn't mistaken for its own port.
 */
function createPortObserver({ avoid = [] } = {}) {
  // Dev servers announce the page to open on a "Local:" line (Vite, Next,
  // Angular, CRA) — prefer those over API servers that start alongside.
  const preferred = new Set();
  const others = new Set();
  const avoidSet = new Set(avoid);
  const started = Date.now();
  const patterns = [
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/gi,
    /listening on\s+(?:port\s*)?:?\s*(\d{2,5})/gi,
    /(?:server|app|running).{0,20}?\bport\s*[:=]?\s*(\d{2,5})/gi,
  ];
  const scan = (text) => {
    // Strip colors first: Vite prints the port in bold (localhost:\x1b[1m3000\x1b[22m).
    // eslint-disable-next-line no-control-regex
    const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    for (const line of plain.split(/\r?\n/)) {
      const target = /\bLocal:|➜|ready - started server|On Your Network/i.test(line) ? preferred : others;
      for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line))) {
          const p = Number(m[1]);
          if (p > 0 && p < 65536 && !RESERVED_PORTS.has(p)) target.add(p);
        }
      }
    }
  };
  // Known backend ports (from an orchestrating script) are only used if
  // nothing else turns up for a while.
  const ports = {
    *[Symbol.iterator]() {
      yield* preferred;
      for (const p of others) {
        if (!preferred.has(p) && (!avoidSet.has(p) || Date.now() - started > 45000)) yield p;
      }
    },
  };
  return { ports, scan };
}

/**
 * Wait for the app's server to come up. Prefers the port we allocated (apps
 * that respect $PORT), then any port announced in the app's output, then a
 * short list of common hardcoded ports. Gives up early if the process exits.
 */
async function waitForServer({ hostPort, observedPorts, timeoutMs = 90000, onOutput, exitInfo }) {
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
    if (exitInfo?.code !== undefined) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const p of COMMON_APP_PORTS) {
    if (p === hostPort) continue;
    if (await isPortOpen(p)) {
      onOutput?.(`\n[info] Detected app on port ${p} — using that for the preview.\n`);
      return p;
    }
  }
  return null;
}

/** After the initial wait, keep polling so a slow server still gets a preview. */
function watchForLatePort({ sessionId, session, hostPort, observer, exitInfo, onOutput, onReady }) {
  const deadline = Date.now() + LATE_PORT_WINDOW_MS;
  const tick = async () => {
    if (nativeSessions.get(sessionId) !== session || exitInfo.code !== undefined || Date.now() > deadline) return;
    for (const p of [hostPort, ...observer.ports]) {
      if (await isPortOpen(p)) {
        session.hostPort = p;
        onOutput(`\n[ready] App is now live on port ${p}!\n`);
        onReady?.(p);
        return;
      }
    }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 2000);
}

// ─── Spawning ───

/** Quote an argument for the shell if it contains spaces (e.g. "Git Runner"). */
function q(arg) {
  const s = String(arg);
  return /\s/.test(s) && !/^".*"$/.test(s) ? `"${s}"` : s;
}

/** Run a command to completion, streaming output. Resolves { code }. */
function spawnWithOutput(cmd, args, opts, onOutput) {
  return new Promise((resolve, reject) => {
    onOutput(`$ ${cmd} ${args.join(' ')}\n`);
    const proc = spawn(q(cmd), args.map(q), { ...opts, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    proc.stdout.on('data', (data) => onOutput(data.toString()));
    proc.stderr.on('data', (data) => onOutput(data.toString()));
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => resolve({ code, process: proc }));
  });
}

/** Run a step and throw if it fails. */
async function mustRun(cmd, args, opts, onOutput, what) {
  const { code } = await spawnWithOutput(cmd, args, opts, onOutput);
  if (code !== 0) throw new Error(`${what} failed (exit code ${code}). See the output above.`);
}

/**
 * Spawn a long-running app process and stream its output. stdin stays open so
 * console programs can read what the user types in the terminal.
 */
function spawnApp({ startCmd, startArgs, cwd, processEnv, onOutput }) {
  onOutput(`$ ${startCmd} ${startArgs.join(' ')}\n`);
  const proc = spawn(q(startCmd), startArgs.map(q), {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: processEnv,
    shell: true,
  });
  proc.stdout.on('data', (data) => onOutput(data.toString()));
  proc.stderr.on('data', (data) => onOutput(data.toString()));
  proc.stdin.on('error', () => {}); // writing after the program exits
  proc.on('error', (err) => onOutput(`\n[error] Process error: ${err.message}\n`));
  proc.on('exit', (code) => onOutput(`\n\x1b[2m[process exited with code ${code}]\x1b[0m\n`));
  return proc;
}

// ─── Installing dependencies / building ───

/**
 * Install a service's dependencies (and build it, for compiled languages).
 * Returns a `prepared` object that buildStartCommand uses (e.g. the compiled
 * program's path or the Java main class).
 */
async function installDeps({ runtime, cwd, processEnv, onOutput }) {
  const opts = { cwd, env: processEnv };
  switch (runtime.id) {
    case 'python':
    case 'python-flask':
    case 'python-fastapi':
    case 'python-django':
    case 'python-streamlit':
    case 'python-gradio':
    case 'python-notebook':
      return installPython({ runtime, cwd, processEnv, onOutput });

    case 'node': {
      const [cmd, ...pre] = nodeManagerCommand(runtime.manager || 'npm');
      const { code } = await spawnWithOutput(cmd, [...pre, 'install'], opts, onOutput);
      // npm 7+ refuses conflicting peer deps that older projects shipped with.
      if (code !== 0 && cmd === 'npm') {
        onOutput('\n[install] Retrying with --legacy-peer-deps...\n');
        await spawnWithOutput('npm', ['install', '--legacy-peer-deps'], opts, onOutput);
      }
      if (runtime.orchestrated?.pythonDirs?.length) await prepareOrchestratedPython({ runtime, cwd, processEnv, onOutput });
      return {};
    }

    case 'deno':
      return {};

    case 'go':
      if (existsSync(join(cwd, 'go.mod'))) await spawnWithOutput('go', ['mod', 'download'], opts, onOutput);
      return { goTarget: findGoMain(cwd) };

    case 'rust':
      await mustRun('cargo', ['build', '--release'], opts, onOutput, 'cargo build');
      return {};

    case 'ruby':
      // Ruby 1.9+ dropped '.' from the load path; older apps `require` their
      // own files by bare name (require 'helpers').
      processEnv.RUBYLIB = [cwd, join(cwd, 'lib'), processEnv.RUBYLIB].filter(Boolean).join(delimiter);
      return installRuby({ runtime, cwd, opts, onOutput });

    case 'php':
      return installPhp({ runtime, cwd, opts, onOutput });

    case 'java-maven':
      return installMaven({ runtime, cwd, opts, onOutput });

    case 'java-gradle':
      return installGradle({ runtime, cwd, opts, onOutput });

    case 'java':
      return compilePlainJava({ cwd, opts, onOutput });

    case 'dotnet':
      fixDotnetGlobalJson(cwd, onOutput);
      return buildDotnet({ runtime, cwd, opts, onOutput });

    case 'cpp':
      return buildCpp({ cwd, opts, onOutput });

    default:
      return {};
  }
}

// ── Node ──

/** How to invoke a package manager that may not be installed globally. */
function nodeManagerCommand(manager) {
  if (manager === 'npm' || manager === 'bun' || isCommandAvailable(manager)) return [manager];
  if (isCommandAvailable('corepack')) return ['corepack', manager];
  return ['npx', '--yes', manager === 'yarn' ? 'yarn@1' : manager];
}

/**
 * The repo's own dev script also starts Python services (e.g. `python -m
 * uvicorn agents.main:app`): install their dependencies and put that Python
 * first on PATH, so the script's `python` finds them.
 */
async function prepareOrchestratedPython({ runtime, cwd, processEnv, onOutput }) {
  if (!isCommandAvailable('uv')) applyToolEnv(processEnv, await ensureTool('uv', onOutput));
  const script = runtime.orchestrated.script;
  const text = JSON.parse(readFileSafe(join(cwd, 'package.json')) || '{}').scripts?.[script] || '';
  // Servers the script calls must be installed even if requirements.txt omits them.
  const pyRuntime = { id: /uvicorn/.test(text) ? 'python-fastapi' : 'python' };
  let python = null;
  for (const dir of runtime.orchestrated.pythonDirs) {
    onOutput(`\n[install] Python dependencies for ./${dir || '.'} (used by "npm run ${script}")...\n`);
    ({ python } = await installPython({ runtime: pyRuntime, cwd: join(cwd, dir), processEnv, onOutput }));
  }
  if (python) applyToolEnv(processEnv, { pathDirs: [dirname(python)], vars: {} });
}

// ── Python (via uv) ──

/** Python version the repo asks for, else one with broad wheel support. */
function pickPythonVersion(cwd) {
  const pinned = readFileSafe(join(cwd, '.python-version'))?.match(/(\d+\.\d+)/)?.[1]
    || readFileSafe(join(cwd, 'runtime.txt'))?.match(/python-(\d+\.\d+)/)?.[1];
  let version = pinned;
  if (!version) {
    const req = readFileSafe(join(cwd, 'pyproject.toml'))?.match(/requires-python\s*=\s*["']([^"']+)["']/)?.[1] || '';
    const upper = req.match(/<\s*3\.(\d+)/);
    const lower = req.match(/>=?\s*3\.(\d+)/);
    if (upper && Number(upper[1]) <= 12) version = `3.${Number(upper[1]) - 1}`;
    else if (lower && Number(lower[1]) > 12) version = `3.${lower[1]}`;
  }
  const minor = Number(version?.split('.')[1]);
  if (!version || !version.startsWith('3.') || minor < 8) return '3.12';
  return version;
}

/** Run a command and collect its stdout (for tools whose output we parse). */
function captureOutput(cmd, args, opts) {
  return new Promise((resolve) => {
    let stdout = '';
    const proc = spawn(q(cmd), args.map(q), { ...opts, stdio: ['ignore', 'pipe', 'ignore'], shell: true });
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.on('error', () => resolve({ code: -1, stdout }));
    proc.on('exit', (code) => resolve({ code, stdout }));
  });
}

// A project's packages go here (uv pip install --target) and are put on
// PYTHONPATH. No per-project venv: its copied python.exe/uvicorn.exe
// launchers are unsigned, and Windows Smart App Control blocks them, while
// the base interpreter runs fine. Tools are started with `python -m …`.
const PY_SITE = '.rr-site';

// Two runs installing the same Python at once trip over uv's install lock, so
// interpreter setup is serialized.
let pythonSetupQueue = Promise.resolve();

function resolvePython(version, opts, onOutput) {
  const job = pythonSetupQueue.then(async () => {
    await spawnWithOutput('uv', ['python', 'install', version], opts, onOutput);
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await captureOutput('uv', ['python', 'find', '--no-project', version], opts);
      const python = found.stdout.trim().split(/\r?\n/).pop();
      if (found.code === 0 && python) return python;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw Object.assign(new Error(`Couldn't get a Python ${version} interpreter.`), { fatal: true });
  });
  pythonSetupQueue = job.catch(() => {});
  return job;
}

async function installPython({ runtime, cwd, processEnv, onOutput }) {
  const opts = { cwd, env: processEnv };
  const version = pickPythonVersion(cwd);
  onOutput(`\n[setup] Getting Python ${version} (uv downloads it if needed)...\n`);
  const python = await resolvePython(version, opts, onOutput);
  onOutput(`Using ${python}\n`);

  const site = join(cwd, PY_SITE);
  const pathKey = Object.keys(processEnv).find((k) => k.toUpperCase() === 'PYTHONPATH') || 'PYTHONPATH';
  // src/ layouts import their packages by name from there.
  const srcDir = existsSync(join(cwd, 'src')) && !existsSync(join(cwd, 'src', '__init__.py')) ? join(cwd, 'src') : null;
  processEnv[pathKey] = [cwd, srcDir, site, processEnv[pathKey]].filter(Boolean).join(delimiter);
  processEnv.PYTHONNOUSERSITE = '1';

  const pip = async (args) => (await spawnWithOutput('uv', ['pip', 'install', '--python', python, '--target', PY_SITE, ...args], opts, onOutput)).code === 0;

  // Install a package list; if resolution fails as a whole, go one by one so
  // a single bad/unavailable package doesn't block everything else.
  const installEach = async (pkgs) => {
    if (!pkgs.length || (await pip(pkgs))) return;
    onOutput('\n[install] Installing packages individually...\n');
    for (const p of pkgs) await pip([p]);
  };

  const reqFile = findRequirementsFile(cwd);
  if (reqFile) {
    if (!(await pip(['-r', reqFile]))) {
      // Old pins often have no wheels for current Python — retry unpinned.
      onOutput('\n[install] Pinned requirements failed — retrying with version pins relaxed...\n');
      await installEach(unpinRequirements(readFileSafe(join(cwd, reqFile)) || ''));
    }
  } else if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py'))) {
    if (!(await pip(['.']))) await installEach(inferPipPackages(cwd));
  } else if (existsSync(join(cwd, 'Pipfile'))) {
    await installEach(parsePipfile(readFileSafe(join(cwd, 'Pipfile')) || ''));
  } else if (existsSync(join(cwd, 'environment.yml')) || existsSync(join(cwd, 'environment.yaml'))) {
    const envFile = existsSync(join(cwd, 'environment.yml')) ? 'environment.yml' : 'environment.yaml';
    await installEach(parseCondaEnv(readFileSafe(join(cwd, envFile)) || ''));
  } else {
    // No manifest — install the third-party packages the code imports so
    // scripts (e.g. ML pipelines) don't die on ModuleNotFoundError.
    const pkgs = inferPipPackages(cwd);
    if (pkgs.length) {
      onOutput(`\n[install] No requirements file — installing inferred packages: ${pkgs.join(', ')}\n`);
      await installEach(pkgs);
    }
  }

  const extra = {
    'python-fastapi': ['uvicorn'],
    'python-streamlit': ['streamlit'],
    'python-gradio': ['gradio'],
    'python-notebook': ['jupyterlab'],
  }[runtime.id];
  if (extra) await pip(extra);

  if (runtime.id === 'python-django') {
    const manage = runtime.manage || 'manage.py';
    onOutput('\n[setup] Applying Django migrations...\n');
    await spawnWithOutput(python, [manage, 'migrate', '--noinput'], opts, onOutput);
    // Manifest static storage (e.g. WhiteNoise) 500s until static files are collected.
    const settings = collectSources(cwd, new Set(['.py'])).filter((f) => /settings/.test(f));
    if (settings.some((f) => /STATIC_ROOT/.test(readFileSafe(join(cwd, f)) || ''))) {
      await spawnWithOutput(python, [manage, 'collectstatic', '--noinput'], opts, onOutput);
    }
  }
  return { python };
}

/** Requirement lines reduced to bare package names (drops ==/>= pins). */
function unpinRequirements(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l && !l.startsWith('-'))
    .map((l) => (/^(git\+|https?:)/.test(l) ? l : l.split(/[<>=!~;\[\s]/)[0]))
    .filter(Boolean);
}

/** Package specs from a Pipfile's [packages] section. */
function parsePipfile(text) {
  const section = text.split(/^\[packages\]\s*$/m)[1]?.split(/^\[/m)[0] || '';
  const pkgs = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\s*"?([A-Za-z0-9_.\-]+)"?\s*=\s*(.+)$/);
    if (!m) continue;
    const spec = m[2].trim().match(/^"([^"]*)"$/)?.[1];
    pkgs.push(spec && spec !== '*' ? `${m[1]}${spec}` : m[1]);
  }
  return pkgs;
}

// Conda package names that differ on PyPI (or aren't Python packages at all).
const CONDA_TO_PIP = { pytorch: 'torch', 'py-opencv': 'opencv-python', opencv: 'opencv-python', 'tensorflow-gpu': 'tensorflow' };
const CONDA_SKIP = /^(python|pip|cudatoolkit|cudnn|pytorch-cuda|mkl.*|libgcc.*|_libgcc.*|vc|vs\d+.*|ca-certificates|openssl|setuptools|wheel)$/;

/** pip-installable names from a conda environment.yml (conda + pip sections). */
function parseCondaEnv(text) {
  const pkgs = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*([A-Za-z0-9_.\-]+)(?:[=<>!].*)?\s*$/);
    if (!m || m[1] === 'pip' || line.includes('::')) continue;
    const name = m[1].toLowerCase();
    if (CONDA_SKIP.test(name)) continue;
    pkgs.push(CONDA_TO_PIP[name] || name);
  }
  return [...new Set(pkgs)];
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
  telegram: 'python-telegram-bot', discord: 'discord.py', dns: 'dnspython', docx: 'python-docx',
  pptx: 'python-pptx', fitz: 'pymupdf', attr: 'attrs', win32api: 'pywin32', magic: 'python-magic',
  Levenshtein: 'python-Levenshtein', google: 'google-generativeai', speech_recognition: 'SpeechRecognition',
};

const PY_STDLIB = new Set(`
  __future__ __main__ _thread abc argparse array ast asyncio atexit base64 bisect builtins bz2 calendar
  cmath code codecs codeop collections colorsys concurrent configparser contextlib contextvars copy copyreg
  cProfile csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email enum errno
  faulthandler fcntl filecmp fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp
  gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache
  locale logging lzma mailbox marshal math mimetypes mmap msvcrt multiprocessing netrc numbers operator
  optparse os pathlib pdb pickle pkgutil platform plistlib poplib posixpath pprint profile pty pwd queue
  random re readline reprlib resource runpy sched secrets select selectors shelve shlex shutil signal site
  smtplib socket socketserver sqlite3 ssl stat statistics string struct subprocess symtable sys sysconfig
  syslog tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib traceback
  tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg
  winsound wsgiref xml xmlrpc zipfile zipimport zlib zoneinfo
`.trim().split(/\s+/));

/**
 * Best-effort: infer third-party pip packages a repo needs by scanning its
 * Python imports (scripts and notebooks). Excludes stdlib and the repo's own
 * modules.
 */
function inferPipPackages(cwd) {
  const files = collectSources(cwd, new Set(['.py', '.ipynb'])).slice(0, 150);
  const localNames = new Set();
  for (const rel of files) {
    for (const part of rel.split(/[\\/]/)) localNames.add(part.replace(/\.(py|ipynb)$/, ''));
  }

  const mods = new Set();
  const re = /^\s*(?:from\s+([a-zA-Z_]\w*)|import\s+([a-zA-Z_]\w*))/gm;
  for (const rel of files) {
    let content = readFileSafe(join(cwd, rel));
    if (!content) continue;
    if (rel.endsWith('.ipynb')) {
      try {
        content = JSON.parse(content).cells
          .filter((c) => c.cell_type === 'code')
          .map((c) => (Array.isArray(c.source) ? c.source.join('') : c.source))
          .join('\n');
      } catch {
        continue;
      }
    }
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(content))) {
      const mod = m[1] || m[2];
      if (mod && !PY_STDLIB.has(mod) && !localNames.has(mod)) mods.add(mod);
    }
  }
  return [...new Set([...mods].map((mod) => IMPORT_TO_PIP[mod] || mod))];
}

// ── Go ──

/** `.` if the root is package main, else the first cmd/<name> with a main. */
function findGoMain(cwd) {
  const isMainPkg = (dir) => {
    try {
      return readdirSync(dir).some((f) => f.endsWith('.go') && !f.endsWith('_test.go') && /^package main\b/m.test(readFileSafe(join(dir, f)) || ''));
    } catch {
      return false;
    }
  };
  if (isMainPkg(cwd)) return '.';
  for (const base of ['cmd', '.']) {
    try {
      for (const e of readdirSync(join(cwd, base), { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && isMainPkg(join(cwd, base, e.name))) return `./${base === '.' ? '' : 'cmd/'}${e.name}`;
      }
    } catch {
      // no such folder
    }
  }
  return '.';
}

// ── Ruby ──

const RUBY_STDLIB = new Set(`
  json net/http uri open-uri securerandom digest set date time yaml psych erb logger fileutils pp socket
  openssl benchmark optparse ostruct pathname tempfile English io/console zlib stringio strscan shellwords
  open3 timeout monitor forwardable singleton delegate observer tmpdir find etc rbconfig ripper coverage
  objspace weakref cgi resolv ipaddr digest/md5 digest/sha1 digest/sha2 net/https
`.trim().split(/\s+/));

// Sinatra 4 ships without a web server; these make `ruby app.rb` serve.
const SINATRA_SERVER_GEMS = ['rackup', 'webrick'];

/** Gems a Gemfile-less repo needs: from an old-style .gems file or its requires. */
function inferGems(cwd) {
  const dotGems = readFileSafe(join(cwd, '.gems'));
  if (dotGems) return dotGems.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  const local = new Set(collectSources(cwd, new Set(['.rb'])).map((f) => f.replace(/\\/g, '/').replace(/\.rb$/, '')));
  const gems = new Set();
  for (const f of collectSources(cwd, new Set(['.rb']))) {
    for (const m of (readFileSafe(join(cwd, f)) || '').matchAll(/^\s*require\s+['"]([^'"]+)['"]/gm)) {
      const lib = m[1];
      if (RUBY_STDLIB.has(lib) || local.has(lib) || lib.startsWith('.')) continue;
      gems.add(lib.split('/')[0].replace(/^sinatra.*/, 'sinatra'));
    }
  }
  if (gems.has('sinatra')) SINATRA_SERVER_GEMS.forEach((g) => gems.add(g));
  return [...gems];
}

async function installRuby({ runtime, cwd, opts, onOutput }) {
  const gemfile = join(cwd, 'Gemfile');
  if (!existsSync(gemfile)) {
    const gems = inferGems(cwd);
    if (gems.length) {
      onOutput(`\n[install] No Gemfile — installing required gems: ${gems.join(', ')}\n`);
      await spawnWithOutput('gem', ['install', '--no-document', ...gems], opts, onOutput);
    }
    return {};
  }
  // A Gemfile pinning an exact Ruby (`ruby '3.1.2'`) refuses any other
  // version; this clone is disposable, so relax the pin.
  let text = readFileSafe(gemfile) || '';
  if (/^\s*ruby\s+['"]/m.test(text)) {
    text = text.replace(/^(\s*ruby\s+['"].*)$/m, '# $1  # relaxed by Repo Runner');
  }
  if (/gem\s+['"]sinatra['"]/.test(text) && !/gem\s+['"](puma|thin|webrick|falcon)['"]/.test(text)) {
    text += `\n${SINATRA_SERVER_GEMS.map((g) => `gem '${g}'`).join('\n')}  # added by Repo Runner\n`;
    rmSync(join(cwd, 'Gemfile.lock'), { force: true });
  }
  writeFileSync(gemfile, text);
  await mustRun('bundle', ['install'], opts, onOutput, 'bundle install');
  if (runtime.rails) {
    onOutput('\n[setup] Preparing the Rails database...\n');
    await spawnWithOutput('bundle', ['exec', 'rails', 'db:prepare'], opts, onOutput);
  }
  return {};
}

// ── PHP ──

async function installPhp({ runtime, cwd, opts, onOutput }) {
  if (existsSync(join(cwd, 'composer.json'))) {
    await spawnWithOutput('composer', ['install', '--no-interaction', '--prefer-dist', '--ignore-platform-reqs'], opts, onOutput);
  }
  if (runtime.artisan) {
    // Laravel needs an .env with an app key, and a database to migrate.
    if (!existsSync(join(cwd, '.env')) && existsSync(join(cwd, '.env.example'))) {
      copyFileSync(join(cwd, '.env.example'), join(cwd, '.env'));
    }
    let env = readFileSafe(join(cwd, '.env')) || '';
    const db = join(cwd, 'database', 'database.sqlite');
    // A MySQL/Postgres config with no password given points at a server that
    // isn't there — run the demo on SQLite instead.
    if (/^DB_CONNECTION=(mysql|mariadb|pgsql|sqlsrv)/m.test(env) && /^DB_PASSWORD=\s*$/m.test(env)) {
      env = env
        .replace(/^DB_CONNECTION=.*$/m, 'DB_CONNECTION=sqlite')
        .replace(/^DB_DATABASE=.*$/m, `DB_DATABASE="${db.replace(/\\/g, '/')}"`)
        .replace(/^(DB_(HOST|PORT|USERNAME|PASSWORD)=.*)$/gm, '# $1');
      if (!/^DB_DATABASE=/m.test(env)) env += `\nDB_DATABASE="${db.replace(/\\/g, '/')}"\n`;
      writeFileSync(join(cwd, '.env'), env);
      onOutput('\n[setup] No database server configured — running on SQLite.\n');
    }
    if (/^DB_CONNECTION=sqlite/m.test(env) || !/^DB_CONNECTION=/m.test(env)) {
      if (existsSync(join(cwd, 'database')) && !existsSync(db)) writeFileSync(db, '');
    }
    await spawnWithOutput('php', ['artisan', 'key:generate', '--force'], opts, onOutput);
    await spawnWithOutput('php', ['artisan', 'migrate', '--force'], opts, onOutput);
    // Blade's @vite / mix() need the frontend assets built, or every page 500s.
    const pkg = JSON.parse(readFileSafe(join(cwd, 'package.json')) || '{}');
    const assetScript = pkg.scripts?.build ? 'build' : pkg.scripts?.production ? 'production' : pkg.scripts?.prod ? 'prod' : null;
    if (assetScript && isCommandAvailable('npm')) {
      onOutput('\n[build] Building frontend assets...\n');
      if ((await spawnWithOutput('npm', ['install', '--no-audit', '--no-fund'], opts, onOutput)).code !== 0) {
        await spawnWithOutput('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], opts, onOutput);
      }
      await spawnWithOutput('npm', ['run', assetScript], opts, onOutput);
    }
  }
  return {};
}

// ── Java ──

const JAVA_SKIP_DIRS = new Set(['test', 'tests', 'androidTest']);

/** Fully-qualified name of the class with a main() method, preferring Main/App. */
function findJavaMainClass(root) {
  const files = collectSources(root, new Set(['.java'])).filter(
    (f) => !f.split(/[\\/]/).some((part) => JAVA_SKIP_DIRS.has(part))
  );
  const mains = files.filter((f) => /static\s+void\s+main\s*\(/.test(readFileSafe(join(root, f)) || ''));
  if (!mains.length) return null;
  const preferred = mains.find((f) => /^(Main|App|Application)\.java$/.test(basename(f)))
    || mains.find((f) => /Application\.java$/.test(f))
    || mains[0];
  const pkg = readFileSafe(join(root, preferred))?.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
  const cls = basename(preferred, '.java');
  return pkg ? `${pkg}.${cls}` : cls;
}

/** Write a java @argfile (paths may contain spaces; argfiles need / or \\). */
function writeJavaArgfile(cwd, classpath, mainClass) {
  const cp = classpath.map((p) => p.replace(/\\/g, '/')).join(delimiter);
  writeFileSync(join(cwd, '.rr-java-args'), `-cp "${cp}"\n${mainClass}\n`);
  return { startCmd: 'java', startArgs: ['@.rr-java-args'] };
}

async function installMaven({ runtime, cwd, opts, onOutput }) {
  const mvn = existsSync(join(cwd, IS_WIN ? 'mvnw.cmd' : 'mvnw')) ? local(IS_WIN ? 'mvnw.cmd' : 'mvnw') : 'mvn';
  // Spring Boot / Quarkus run straight from their plugins (which compile too).
  if (runtime.framework) return { mvn };

  await mustRun(mvn, ['-B', '-DskipTests', 'package'], opts, onOutput, 'Maven build');
  await spawnWithOutput(mvn, ['-B', '-q', 'dependency:build-classpath', '-Dmdep.outputFile=.rr-classpath.txt'], opts, onOutput);
  const deps = (readFileSafe(join(cwd, '.rr-classpath.txt')) || '').trim().split(delimiter).filter(Boolean);
  const mainClass = findJavaMainClass(join(cwd, 'src', 'main', 'java')) || findJavaMainClass(cwd);
  if (!mainClass) throw new Error('Built the project, but found no class with a main() method to run.');
  return { mvn, java: writeJavaArgfile(cwd, [join('target', 'classes'), ...deps], mainClass) };
}

async function installGradle({ runtime, cwd, opts, onOutput }) {
  if (runtime.framework === 'android') {
    throw new Error('This is an Android app — it needs an Android device or emulator, so it can\'t be previewed here.');
  }
  const wrapper = existsSync(join(cwd, IS_WIN ? 'gradlew.bat' : 'gradlew'));
  const gradle = wrapper ? local(IS_WIN ? 'gradlew.bat' : 'gradlew') : 'gradle';
  if (runtime.task) return { gradle };

  await mustRun(gradle, ['build', '-x', 'test', '--console=plain'], opts, onOutput, 'Gradle build');
  const mainClass = findJavaMainClass(join(cwd, 'src', 'main', 'java')) || findJavaMainClass(cwd);
  if (!mainClass) throw new Error('Built the project, but found no class with a main() method to run.');
  const classes = [join('build', 'classes', 'java', 'main'), join('build', 'resources', 'main')];
  return { gradle, java: writeJavaArgfile(cwd, classes, mainClass) };
}

/** Plain .java files with no build tool: javac everything, run the main class. */
async function compilePlainJava({ cwd, opts, onOutput }) {
  const sources = collectSources(cwd, new Set(['.java'])).filter(
    (f) => !f.split(/[\\/]/).some((part) => JAVA_SKIP_DIRS.has(part))
  );
  const mainClass = findJavaMainClass(cwd);
  if (!mainClass) throw new Error('No Java class with a main() method was found.');
  const libs = collectSources(cwd, new Set(['.jar']));
  writeFileSync(join(cwd, '.rr-javac-sources'), sources.map((s) => `"${s.replace(/\\/g, '/')}"`).join('\n'));
  const cpArgs = libs.length ? ['-cp', libs.join(delimiter)] : [];
  onOutput(`\n[build] Compiling ${sources.length} Java file(s)...\n`);
  await mustRun('javac', ['-encoding', 'UTF-8', '-d', '.rr-classes', ...cpArgs, '@.rr-javac-sources'], opts, onOutput, 'Java compilation');
  return { java: writeJavaArgfile(cwd, ['.rr-classes', ...libs], mainClass) };
}

// ── .NET ──

/**
 * Build to a DLL and run it with `dotnet app.dll`: `dotnet run` launches the
 * app's own unsigned .exe host, which Windows Smart App Control blocks, while
 * dotnet.exe is signed by Microsoft.
 */
async function buildDotnet({ runtime, cwd, opts, onOutput }) {
  const project = runtime.project;
  if (!project) throw new Error('No .NET project file (.csproj) was found.');
  await mustRun('dotnet', ['build', project, '-c', 'Debug', '-p:UseAppHost=false', '-o', '.rr-out', '--nologo'], opts, onOutput, '.NET build');
  const assembly = (readFileSafe(join(cwd, project)) || '').match(/<AssemblyName>\s*([^<\s]+)\s*<\/AssemblyName>/)?.[1]
    || basename(project).replace(/\.(cs|fs|vb)proj$/, '');
  const dll = join('.rr-out', `${assembly}.dll`);
  if (!existsSync(join(cwd, dll))) throw new Error(`Built the project, but ${dll} wasn't produced.`);
  const projectDir = project.includes('/') ? project.slice(0, project.lastIndexOf('/')) : '.';
  return { dll, contentRoot: join(cwd, projectDir) };
}

/** A global.json pinning an SDK that isn't installed makes every dotnet command fail. */
function fixDotnetGlobalJson(cwd, onOutput) {
  const gj = join(cwd, 'global.json');
  if (!existsSync(gj)) return;
  try {
    execSync('dotnet --version', { cwd, stdio: 'ignore' });
  } catch {
    renameSync(gj, `${gj}.disabled`);
    onOutput('\n[info] global.json pins a .NET SDK that isn\'t installed — using the installed SDK instead.\n');
  }
}

// ── C / C++ ──

const OUT_BIN = IS_WIN ? 'repo-runner-app.exe' : 'repo-runner-app';

/** Newest executable under `dir` modified after `since` (build output). */
function findNewestExecutable(dir, since) {
  let best = null;
  const walk = (d, depth) => {
    let items;
    try {
      items = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = join(d, it.name);
      if (it.isDirectory()) {
        if (depth < 4 && !['CMakeFiles', '.git', 'node_modules'].includes(it.name)) walk(p, depth + 1);
        continue;
      }
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      const isExe = IS_WIN ? it.name.endsWith('.exe') : (st.mode & 0o111) && !extname(it.name);
      if (isExe && st.mtimeMs >= since && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs };
    }
  };
  walk(dir, 0);
  return best?.path || null;
}

/**
 * Build a C/C++ project: CMake if it has a CMakeLists.txt, else its Makefile,
 * else compile the sources directly. Returns the program to run.
 */
async function buildCpp({ cwd, opts, onOutput }) {
  const started = Date.now() - 1000;
  if (IS_WIN) opts.env.LDFLAGS = [opts.env.LDFLAGS, '-static'].filter(Boolean).join(' ');

  const has = (cmd) => onPath(cmd, opts.env);
  if (existsSync(join(cwd, 'CMakeLists.txt')) && has('cmake')) {
    const gen = IS_WIN && has('mingw32-make') ? ['-G', 'MinGW Makefiles'] : [];
    const configured = await spawnWithOutput('cmake', ['-S', '.', '-B', 'build-rr', ...gen, '-DCMAKE_BUILD_TYPE=Release'], opts, onOutput);
    if (configured.code === 0 && (await spawnWithOutput('cmake', ['--build', 'build-rr', '-j', '4'], opts, onOutput)).code === 0) {
      const program = findNewestExecutable(join(cwd, 'build-rr'), started);
      if (program) return { program: relative(cwd, program) };
    }
    onOutput('\n[build] CMake build didn\'t produce a program — compiling the sources directly.\n');
  } else if (existsSync(join(cwd, 'Makefile')) || existsSync(join(cwd, 'makefile'))) {
    const make = has('make') ? 'make' : 'mingw32-make';
    if ((await spawnWithOutput(make, [], opts, onOutput)).code === 0) {
      const program = findNewestExecutable(cwd, started);
      if (program) return { program: relative(cwd, program) };
    }
    onOutput('\n[build] make didn\'t produce a program — compiling the sources directly.\n');
  }

  const cppSources = collectSources(cwd, new Set(['.cpp', '.cc', '.cxx']));
  const useC = cppSources.length === 0;
  let sources = useC ? collectSources(cwd, new Set(['.c'])) : cppSources;
  if (sources.length === 0) throw new Error('No C/C++ source files found to compile.');

  // Repos of standalone exercises have many files each with its own main();
  // link all the non-main files with just one of them.
  const hasMain = (f) => /\b(int|void)\s+main\s*\(/.test(readFileSafe(join(cwd, f)) || '');
  const mains = sources.filter(hasMain);
  if (mains.length > 1) {
    const chosen = mains.find((f) => /^main\.(c|cpp|cc|cxx)$/.test(basename(f))) || mains[0];
    onOutput(`\n[build] ${mains.length} files define main() — building ${chosen}.\n`);
    sources = [...sources.filter((f) => !mains.includes(f)), chosen];
  }

  const compiler = useC ? (has('gcc') ? 'gcc' : 'clang') : (has('g++') ? 'g++' : 'clang++');
  const includes = ['.', 'include', 'src'].filter((d) => existsSync(join(cwd, d))).map((d) => `-I${d}`);
  const code = sources.map((f) => readFileSafe(join(cwd, f)) || '').join('\n');
  // Static on Windows: the program then doesn't need MinGW's DLLs at run time.
  const libs = IS_WIN ? ['-static'] : [];
  if (IS_WIN && /winsock2?\.h/i.test(code)) libs.push('-lws2_32');
  if (!IS_WIN && useC) libs.push('-lm');
  if (/<(thread|pthread\.h)>/.test(code)) libs.push('-pthread');

  onOutput(`\n[build] Compiling ${sources.length} source file(s) with ${compiler}...\n`);
  await mustRun(compiler, [...sources, ...includes, '-O2', useC ? '-std=c17' : '-std=c++20', '-o', OUT_BIN, ...libs], opts, onOutput, 'Compilation');
  return { program: OUT_BIN };
}

// ─── Start commands ───

/**
 * How to import a Python file. A file that uses relative imports
 * (`from . import x`) only works as part of its package, so it's imported as
 * `pkg.module` from the folder above the package — e.g. agents/main.py becomes
 * `agents.main`, run from the repo root. Returns { module, runCwd, inPackage }.
 */
function pythonImportTarget(cwd, relFile) {
  const stem = basename(relFile).replace(/\.py$/, '');
  const src = readFileSafe(join(cwd, relFile)) || '';
  if (!/^\s*from\s+\.+[\w.]*\s+import\s/m.test(src)) {
    return { module: relFile.replace(/\.py$/, '').replace(/[\\/]/g, '.'), runCwd: cwd, inPackage: false };
  }
  // The package reaches up through every folder that has an __init__.py.
  let top = dirname(join(cwd, relFile));
  const names = [basename(top)];
  while (existsSync(join(dirname(top), '__init__.py')) && dirname(top) !== top) {
    top = dirname(top);
    names.unshift(basename(top));
  }
  return { module: [...names, stem].join('.'), runCwd: dirname(top), inPackage: true };
}

/**
 * Build the [command, args] to start a service on `hostPort`, using what
 * installDeps prepared. Also sets port-related env vars each stack reads.
 */
function buildStartCommand({ runtime, hostPort, processEnv, cwd, prepared = {} }) {
  const port = String(hostPort);
  // The interpreter installPython resolved (packages are on PYTHONPATH).
  const PY = prepared.python || (IS_WIN ? 'python' : 'python3');
  switch (runtime.id) {
    case 'python-flask': {
      processEnv.FLASK_RUN_PORT = port;
      processEnv.FLASK_RUN_HOST = '0.0.0.0';
      const appFile = runtime.start?.split(' ').pop() || 'app.py';
      const target = pythonImportTarget(cwd, appFile);
      // An app with no app.run() / __main__ block exits immediately when run
      // as a script — serve it through `flask run` instead.
      const src = readFileSafe(join(cwd, appFile)) || '';
      if (!/\.run\(|__main__/.test(src)) {
        return { startCmd: PY, startArgs: ['-m', 'flask', '--app', target.module, 'run', '--host', '0.0.0.0', '--port', port], cwd: target.runCwd };
      }
      return target.inPackage
        ? { startCmd: PY, startArgs: ['-m', target.module], cwd: target.runCwd }
        : { startCmd: PY, startArgs: [appFile] };
    }
    case 'python-fastapi': {
      const [modulePath, declaredVar] = (runtime.start?.match(/uvicorn\s+(\S+)/)?.[1] || 'main:app').split(':');
      const file = `${modulePath.replace(/\./g, '/')}.py`;
      const target = pythonImportTarget(cwd, file);
      // An app built by a factory (def create_app(): ...) with no module-level
      // FastAPI instance is served with --factory.
      const src = readFileSafe(join(cwd, file)) || '';
      const hasInstance = new RegExp(`^${declaredVar || 'app'}\\s*=`, 'm').test(src);
      const factory = !hasInstance && src.match(/^def\s+(create_app|get_app|make_app|build_app)\s*\(/m)?.[1];
      const spec = `${target.module}:${factory || declaredVar || 'app'}`;
      return {
        startCmd: PY,
        startArgs: ['-m', 'uvicorn', spec, ...(factory ? ['--factory'] : []), '--host', '0.0.0.0', '--port', port],
        cwd: target.runCwd,
      };
    }
    case 'python-django':
      return { startCmd: PY, startArgs: [runtime.manage || 'manage.py', 'runserver', `0.0.0.0:${port}`] };
    case 'python-streamlit': {
      const appFile = runtime.start?.match(/streamlit\s+run\s+(\S+)/)?.[1] || 'app.py';
      return { startCmd: PY, startArgs: ['-m', 'streamlit', 'run', appFile, '--server.port', port, '--server.headless', 'true', '--server.address', '0.0.0.0', '--global.developmentMode', 'false'] };
    }
    case 'python-gradio': {
      processEnv.GRADIO_SERVER_PORT = port;
      processEnv.GRADIO_SERVER_NAME = '0.0.0.0';
      return { startCmd: PY, startArgs: [runtime.start?.split(' ').pop() || 'app.py'] };
    }
    case 'python-notebook': {
      // Config file (not CLI flags) so no quoting is needed for the iframe CSP.
      writeFileSync(join(cwd, '.rr-jupyter-config.py'), [
        "c.ServerApp.token = ''",
        "c.ServerApp.password = ''",
        "c.IdentityProvider.token = ''",
        'c.ServerApp.open_browser = False',
        "c.ServerApp.ip = '127.0.0.1'",
        `c.ServerApp.port = ${port}`,
        "c.ServerApp.allow_origin = '*'",
        'c.ServerApp.disable_check_xsrf = True',
        "c.ServerApp.tornado_settings = {'headers': {'Content-Security-Policy': 'frame-ancestors *'}}",
      ].join('\n'));
      return { startCmd: PY, startArgs: ['-m', 'jupyterlab', '--config=.rr-jupyter-config.py'] };
    }
    case 'python': {
      const entry = runtime.start?.split(' ').pop() || 'main.py';
      const target = pythonImportTarget(cwd, entry);
      return target.inPackage
        ? { startCmd: PY, startArgs: ['-m', target.module], cwd: target.runCwd }
        : { startCmd: PY, startArgs: [entry] };
    }

    case 'node': {
      processEnv.BROWSER = 'none'; // create-react-app would open a browser tab
      // webpack 4-era tooling crashes on Node 17+ (ERR_OSSL_EVP_UNSUPPORTED)
      // unless the legacy OpenSSL provider is on.
      const pkg = JSON.parse(readFileSafe(join(cwd, 'package.json')) || '{}');
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const major = (name) => Number(deps[name]?.match(/(\d+)/)?.[1]);
      if (major('react-scripts') < 5 || major('@vue/cli-service') < 5 || major('next') < 12 || major('webpack') < 5) {
        processEnv.NODE_OPTIONS = [processEnv.NODE_OPTIONS, '--openssl-legacy-provider'].filter(Boolean).join(' ');
      }
      const [first, ...rest] = (runtime.start || 'npm start').split(' ');
      const cmd = ['npm', 'pnpm', 'yarn', 'bun'].includes(first) ? nodeManagerCommand(first) : [first];
      return { startCmd: cmd[0], startArgs: [...cmd.slice(1), ...rest] };
    }
    case 'deno': {
      const [cmd, ...args] = (runtime.start || 'deno run -A main.ts').split(' ');
      return { startCmd: cmd, startArgs: args };
    }
    case 'go':
      return { startCmd: 'go', startArgs: ['run', prepared.goTarget || '.'] };
    case 'rust':
      return { startCmd: 'cargo', startArgs: ['run', '--release'] };

    case 'ruby': {
      const bundled = existsSync(join(cwd, 'Gemfile'));
      const exec = (args) => (bundled ? { startCmd: 'bundle', startArgs: ['exec', ...args] } : { startCmd: args[0], startArgs: args.slice(1) });
      if (runtime.rails) return exec(['rails', 'server', '-b', '0.0.0.0', '-p', port]);
      if (runtime.rackup) return exec(['rackup', '-o', '0.0.0.0', '-p', port]);
      return exec(['ruby', runtime.entry || 'app.rb']); // Sinatra reads $PORT
    }
    case 'php':
      if (runtime.artisan) return { startCmd: 'php', startArgs: ['artisan', 'serve', '--host=127.0.0.1', `--port=${port}`] };
      return { startCmd: 'php', startArgs: ['-S', `0.0.0.0:${port}`, '-t', runtime.docroot || '.'] };

    case 'java-maven':
    case 'java-gradle':
      processEnv.SERVER_PORT = port;        // Spring Boot
      processEnv.QUARKUS_HTTP_PORT = port;  // Quarkus
      processEnv.MICRONAUT_SERVER_PORT = port;
      if (prepared.java) return prepared.java;
      if (runtime.id === 'java-maven') {
        const goal = runtime.framework === 'quarkus' ? 'quarkus:dev' : 'spring-boot:run';
        return { startCmd: prepared.mvn || 'mvn', startArgs: ['-B', goal] };
      }
      return { startCmd: prepared.gradle || 'gradle', startArgs: [runtime.task || 'run', '--console=plain'] };
    case 'java':
      if (!prepared.java) throw new Error('The Java program failed to compile — see the errors above.');
      return prepared.java;

    case 'dotnet': {
      processEnv.ASPNETCORE_URLS = `http://127.0.0.1:${port}`;
      processEnv.DOTNET_ROLL_FORWARD = 'Major'; // run older targets on the installed runtime
      processEnv.ASPNETCORE_ENVIRONMENT ||= 'Development'; // most templates only enable Swagger here
      processEnv.DOTNET_NOLOGO = '1';
      processEnv.DOTNET_CLI_TELEMETRY_OPTOUT = '1';
      if (!prepared.dll) throw new Error('The .NET project failed to build — see the errors above.');
      return {
        startCmd: 'dotnet',
        startArgs: [prepared.dll, '--urls', `http://127.0.0.1:${port}`, '--contentRoot', prepared.contentRoot],
      };
    }

    case 'cpp':
      if (!prepared.program) throw new Error('The C/C++ program failed to build — see the errors above.');
      return { startCmd: local(prepared.program), startArgs: [] };

    default: {
      if (runtime.start) {
        const parts = runtime.start.split(' ');
        return { startCmd: parts[0], startArgs: parts.slice(1) };
      }
      throw new Error(`No start command configured for ${runtime.label}`);
    }
  }
}

// ─── Helpers ───

function readFileSafe(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Write user-provided env vars to a .env file in `cwd` (if any). */
/**
 * Write .env: start from the repo's .env.example (its defaults are why we
 * didn't prompt for those keys), then apply the values the user entered.
 */
function writeEnvFile(cwd, envVars, onOutput) {
  const given = Object.entries(envVars || {}).filter(([, v]) => v !== '');
  const envPath = join(cwd, '.env');
  const example = ['.env.example', '.env.sample', '.env.template'].map((f) => join(cwd, f)).find(existsSync);
  if (!given.length && (existsSync(envPath) || !example)) return;

  const lines = existsSync(envPath) ? readFileSafe(envPath).split(/\r?\n/) : example ? readFileSafe(example).split(/\r?\n/) : [];
  for (const [key, value] of given) {
    const i = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(envPath, lines.join('\n'));
  onOutput(example && !given.length
    ? `Created .env from ${example.split(/[\\/]/).pop()}\n`
    : `Wrote .env with ${given.length} value(s)\n`);
}

// Common env var names frameworks use to locate their API/backend, so a
// frontend can reach a locally-started backend without any manual config.
const API_URL_ENV_KEYS = [
  'NEXT_PUBLIC_API_URL', 'VITE_API_URL', 'REACT_APP_API_URL',
  'API_URL', 'API_BASE_URL', 'BACKEND_URL', 'PUBLIC_API_URL',
];

const SOURCE_SKIP_DIRS = new Set(['.git', 'build', 'bin', 'obj', 'node_modules', '.vscode', 'cmake-build-debug', '.venv', 'venv', 'build-rr', 'target', '.rr-site', '.rr-out']);

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
      if (dot >= 0 && exts.has(it.name.slice(dot))) out.push(relative(base, p));
    }
  }
  return out;
}

function baseProcessEnv(envVars) {
  return {
    ...process.env,
    // Force UTF-8 so Python apps that print emoji/Unicode don't crash on
    // Windows' legacy cp1252 console encoding.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    UV_LINK_MODE: 'copy', // uv's cache and the repos may sit on different drives
    ...(envVars || {}),
  };
}

// ─── Static sites / file browser ───

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.xml': 'application/xml',
};

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function directoryListing(dir, urlPath) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== '.git')
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const base = urlPath.endsWith('/') ? urlPath : `${urlPath}/`;
  const rows = entries.map((e) => {
    const name = escapeHtml(e.name) + (e.isDirectory() ? '/' : '');
    return `<li><a href="${base}${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${e.isDirectory() ? '📁' : '📄'} ${name}</a></li>`;
  }).join('');
  const readme = entries.find((e) => /^readme(\.md|\.txt)?$/i.test(e.name));
  const readmeText = readme ? readFileSafe(join(dir, readme.name)) : null;
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(urlPath)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#0d1117;color:#e6edf3}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}ul{list-style:none;padding:0;margin:0 0 24px;
border:1px solid #30363d;border-radius:8px;overflow:hidden}li{padding:8px 14px;border-top:1px solid #21262d}li:first-child{border-top:0}
h1{font-size:16px;font-weight:600}pre{white-space:pre-wrap;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}</style>
<h1>${escapeHtml(urlPath)}</h1><ul>${urlPath !== '/' ? '<li><a href="../">⬆ ..</a></li>' : ''}${rows}</ul>
${readmeText ? `<pre>${escapeHtml(readmeText.slice(0, 20000))}</pre>` : ''}`;
}

/** A tiny static file server (index.html, or a directory listing). */
function createStaticServer(root) {
  const rootAbs = resolve(root);
  return createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const target = resolve(rootAbs, `.${urlPath}`);
    if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
      res.writeHead(403).end();
      return;
    }
    let st;
    try {
      st = statSync(target);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    if (st.isDirectory()) {
      if (!urlPath.endsWith('/')) {
        res.writeHead(301, { Location: `${urlPath}/` }).end();
        return;
      }
      const index = join(target, 'index.html');
      if (existsSync(index)) {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        createReadStream(index).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(directoryListing(target, urlPath));
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' });
    createReadStream(target).pipe(res);
  });
}

async function startStaticSite({ sessionId, repoDir, runtime, cwd, onOutput }) {
  const hostPort = getAvailablePort();

  const entry = runtime.entry || 'index.html';
  if (entry !== 'index.html' && !existsSync(join(cwd, 'index.html')) && existsSync(join(cwd, entry))) {
    copyFileSync(join(cwd, entry), join(cwd, 'index.html'));
    onOutput(`\n[info] Using ${entry} as the home page (served at /).\n`);
  }
  if (runtime.browse) {
    onOutput('\n[info] No runnable app detected — showing the repository files instead.\n');
  }

  const server = createStaticServer(cwd);
  await new Promise((res, rej) => server.once('error', rej).listen(hostPort, '127.0.0.1', res));
  onOutput(`\n[serve] Serving ${runtime.browse ? 'files' : 'static site'} on port ${hostPort}...\n`);

  const cleanupTimer = setTimeout(() => {
    stopNativeProcess(sessionId, (msg) => console.log(`[auto-cleanup] ${msg}`));
  }, SESSION_TIMEOUT_MS);

  nativeSessions.set(sessionId, {
    processes: [], servers: [server], hostPort, ports: [hostPort], runtime, repoDir, cleanupTimer, mode: 'native-static',
  });
  onOutput(`\n[ready] Live on port ${hostPort}!\n`);
  return { hostPort };
}

// ─── Entry points ───

/**
 * Start a native process for a repo (no Docker needed). `onReady(port)` is
 * called if the app's web server only comes up after this returns.
 *
 * Returns { hostPort } when a web server is up; { hostPort: null } for a
 * console program (finished or still running); { hostPort: null, failed }
 * when it crashed.
 */
export async function startNativeProcess({ sessionId, repoDir, runtime, envVars, onOutput, onReady }) {
  const cwd = runtime.workdir ? join(repoDir, runtime.workdir) : repoDir;
  if (runtime.workdir) {
    onOutput(`\n[info] Project detected in ./${runtime.workdir} — running there.\n`);
  }

  if (runtime.static) {
    return startStaticSite({ sessionId, repoDir, runtime, cwd, onOutput });
  }

  const hostPort = getAvailablePort();
  try {
    writeEnvFile(cwd, envVars, onOutput);
    const processEnv = { ...baseProcessEnv(envVars), PORT: String(hostPort) };
    // An orchestrating script gives each service its own port; a shared PORT
    // would make them collide.
    if (runtime.orchestrated) delete processEnv.PORT;

    await prepareToolchain({ runtime, cwd, processEnv, onOutput });

    onOutput(`\n[install] Installing dependencies...\n`);
    let prepared = {};
    try {
      prepared = (await installDeps({ runtime, cwd, processEnv, onOutput })) || {};
    } catch (err) {
      if (err.fatal) throw err;
      onOutput(`\n[warning] ${err.message}\n`);
      // Interpreted stacks may still start; compiled ones fail in buildStartCommand.
    }

    onOutput(`\n[start] Starting app on port ${hostPort}...\n`);
    const { startCmd, startArgs, cwd: runCwd } = buildStartCommand({ runtime, hostPort, processEnv, cwd, prepared });
    const observer = createPortObserver({ avoid: runtime.orchestrated?.backendPorts });
    let policyBlocked = false;
    const appProcess = spawnApp({
      startCmd, startArgs, cwd: runCwd || cwd, processEnv,
      onOutput: (t) => {
        observer.scan(t);
        if (/Application Control policy has blocked|Device Guard policy/i.test(t)) policyBlocked = true;
        onOutput(t);
      },
    });
    const exitInfo = { code: undefined };
    appProcess.on('exit', (code) => { exitInfo.code = code ?? 1; });
    appProcess.on('error', () => { exitInfo.code = 1; });

    const cleanupTimer = setTimeout(() => {
      stopNativeProcess(sessionId, (msg) => console.log(`[auto-cleanup] ${msg}`));
    }, SESSION_TIMEOUT_MS);

    const session = {
      processes: [appProcess], hostPort, ports: [hostPort], runtime, repoDir, cleanupTimer, mode: 'native',
    };
    nativeSessions.set(sessionId, session);

    // Compiled console programs and plain scripts rarely serve HTTP, so hand
    // over to the terminal quickly; the late-port watcher still catches servers.
    const timeoutMs = ['cpp', 'java'].includes(runtime.id) ? 8000
      : runtime.id === 'python' ? 20000
      : runtime.id.startsWith('java') || runtime.id === 'dotnet' ? 180000
      : 90000;
    const readyPort = await waitForServer({ hostPort, observedPorts: observer.ports, timeoutMs, onOutput, exitInfo });
    if (readyPort) {
      session.hostPort = readyPort;
      onOutput(`\n[ready] App is live on port ${readyPort}!\n`);
      return { hostPort: readyPort };
    }
    if (exitInfo.code === 0) {
      onOutput('\n[done] The program ran and finished — it has no web server, so its output above is the result.\n');
      return { hostPort: null, finished: true };
    }
    if (exitInfo.code !== undefined) {
      if (policyBlocked || exitInfo.code === 3236495362 || exitInfo.code === 4551) {
        onOutput('\n[error] Windows blocked a program this project built (Smart App Control / Application Control policy). ' +
          'That is a security setting on this PC; the same repo runs on machines without it or on the Linux backend.\n');
      }
      onOutput(`\n[error] The app exited with code ${exitInfo.code} before opening a web server (see the logs above).\n`);
      return { hostPort: null, failed: true, blocked: policyBlocked || [4551, 3236495362].includes(exitInfo.code) };
    }
    onOutput('\n[info] Still running, no web server detected yet — showing console output. The preview opens automatically if it starts listening.\n');
    watchForLatePort({ sessionId, session, hostPort, observer, exitInfo, onOutput, onReady });
    return { hostPort: null };
  } catch (err) {
    if (!nativeSessions.has(sessionId)) releasePort(hostPort);
    throw err;
  }
}

/**
 * Run a multi-service repo (e.g. a frontend + a backend in separate folders)
 * natively: start the backend first, then start the frontend wired to it via
 * common API-URL env vars. Returns the frontend's port as the preview URL.
 */
export async function startCompoundNative({ sessionId, repoDir, services, envVars, onOutput }) {
  const baseEnv = baseProcessEnv(envVars);
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
    await prepareToolchain({ runtime: backend.runtime, cwd, processEnv: bEnv, onOutput });
    onOutput(`\n[install] Installing backend dependencies...\n`);
    let prepared = {};
    try {
      prepared = (await installDeps({ runtime: backend.runtime, cwd, processEnv: bEnv, onOutput })) || {};
    } catch (err) {
      onOutput(`\n[warning] Backend install warning: ${err.message}\n`);
    }
    const { startCmd, startArgs, cwd: runCwd } = buildStartCommand({ runtime: backend.runtime, hostPort: backendPort, processEnv: bEnv, cwd, prepared });
    onOutput(`\n[start] Starting backend...\n`);
    processes.push(spawnApp({ startCmd, startArgs, cwd: runCwd || cwd, processEnv: bEnv, onOutput }));
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

  // Plain-HTML frontend: serve its files; the page talks to the backend itself.
  if (frontend.runtime.static) {
    const server = createStaticServer(fcwd);
    await new Promise((res, rej) => server.once('error', rej).listen(frontPort, '127.0.0.1', res));
    const cleanupTimer = setTimeout(() => {
      stopNativeProcess(sessionId, (msg) => console.log(`[auto-cleanup] ${msg}`));
    }, SESSION_TIMEOUT_MS);
    nativeSessions.set(sessionId, {
      processes, servers: [server], hostPort: frontPort, ports, runtime: frontend.runtime, repoDir, cleanupTimer, mode: 'native-compound',
    });
    onOutput(`\n✅ App is live on port ${frontPort}!\n`);
    return { hostPort: frontPort };
  }

  writeEnvFile(fcwd, envVars, onOutput);
  await prepareToolchain({ runtime: frontend.runtime, cwd: fcwd, processEnv: fEnv, onOutput });
  onOutput(`\n[install] Installing frontend dependencies...\n`);
  let fPrepared = {};
  try {
    fPrepared = (await installDeps({ runtime: frontend.runtime, cwd: fcwd, processEnv: fEnv, onOutput })) || {};
  } catch (err) {
    onOutput(`\n[warning] Frontend install warning: ${err.message}\n`);
  }
  const { startCmd, startArgs, cwd: fRunCwd } = buildStartCommand({ runtime: frontend.runtime, hostPort: frontPort, processEnv: fEnv, cwd: fcwd, prepared: fPrepared });
  onOutput(`\n[start] Starting frontend...\n`);
  const observer = createPortObserver();
  processes.push(spawnApp({
    startCmd, startArgs, cwd: fRunCwd || fcwd, processEnv: fEnv,
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

  for (const proc of session.processes || []) {
    try {
      if (IS_WIN) {
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
  for (const server of session.servers || []) {
    server.closeAllConnections?.();
    server.close();
  }
  onOutput?.('Process(es) stopped.\n');

  for (const port of session.ports || [session.hostPort]) {
    releasePort(port);
  }
  nativeSessions.delete(sessionId);
  onOutput?.('Session cleaned up.\n');
}

/** Send terminal input to a session's app process (the last one started). */
export function writeToSession(sessionId, data) {
  const proc = nativeSessions.get(sessionId)?.processes?.at(-1);
  if (proc?.stdin?.writable) proc.stdin.write(data);
}

/** Ids of sessions currently serving a web preview. */
export function listPreviewSessions() {
  return [...nativeSessions.entries()].filter(([, s]) => s.hostPort).map(([id]) => id);
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
