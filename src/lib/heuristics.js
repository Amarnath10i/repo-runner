// Static, no-server analysis of a repo's file tree. This is what makes the
// runner work for *every* repo instead of blindly running `npm install` at the
// root (which crashes with ENOENT the moment a repo has no root package.json —
// e.g. a Python/ML repo, or a Node app nested in a subfolder).
//
// It answers three questions without needing Ollama:
//   1. Where does the Node project actually live? (root, a subfolder, or nowhere)
//   2. What runtime is this repo? (node / python / go / rust / php / ruby / docker / java / dotnet / unknown)
//   3. Can it realistically boot inside a browser WebContainer?

// Directories we never descend into when hunting for a manifest.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  'vendor', '__pycache__', '.venv', 'venv',
  'target', 'bin', 'obj',
]);

/**
 * Breadth-first search for the shallowest directory that contains a
 * `package.json`. Returns the relative directory path ('' for the repo root),
 * or `null` when there is no package.json anywhere in the tree.
 */
export function findPackageJsonDir(tree) {
  const queue = [{ prefix: '', node: tree }];
  while (queue.length > 0) {
    const { prefix, node } = queue.shift();
    if (node['package.json']?.file) return prefix;
    for (const [name, child] of Object.entries(node)) {
      if (SKIP_DIRS.has(name)) continue;
      if (child.directory) {
        queue.push({ prefix: prefix ? `${prefix}/${name}` : name, node: child.directory });
      }
    }
  }
  return null;
}

/** True if a file with the given name exists anywhere in the tree. */
export function treeHasFile(tree, fileName) {
  const queue = [tree];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node[fileName]?.file) return true;
    for (const [name, child] of Object.entries(node)) {
      if (SKIP_DIRS.has(name)) continue;
      if (child.directory) queue.push(child.directory);
    }
  }
  return false;
}

const RUNTIME_SIGNATURES = [
  { runtime: 'python', files: ['*.py', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'environment.yml', 'setup.py'], label: 'Python' },
  { runtime: 'go', files: ['go.mod'], label: 'Go' },
  { runtime: 'rust', files: ['Cargo.toml'], label: 'Rust' },
  { runtime: 'php', files: ['composer.json'], label: 'PHP' },
  { runtime: 'ruby', files: ['Gemfile'], label: 'Ruby' },
  { runtime: 'java', files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], label: 'Java' },
  { runtime: 'dotnet', files: ['*.csproj', '*.sln'], label: '.NET / C#' },
  { runtime: 'cpp', files: ['CMakeLists.txt', '*.cpp', '*.cc', '*.cxx'], label: 'C / C++' },
  { runtime: 'docker', files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml'], label: 'Docker-based' },
];

/** Best-effort guess of what stack a non-Node repo uses, for helpful messaging. */
export function detectStack(tree) {
  for (const sig of RUNTIME_SIGNATURES) {
    for (const f of sig.files) {
      if (f.includes('*')) {
        // Glob pattern — check root level for matching extensions
        const ext = f.replace('*', '');
        const rootFiles = Object.keys(tree);
        if (rootFiles.some((name) => name.endsWith(ext) && tree[name]?.file)) {
          return { runtime: sig.runtime, label: sig.label };
        }
      } else if (treeHasFile(tree, f)) {
        return { runtime: sig.runtime, label: sig.label };
      }
    }
  }
  return { runtime: 'unknown', label: 'unknown' };
}

export function analyzeTreeLocally(tree) {
  const stack = detectStack(tree);

  // A runnable JavaScript app at the root (dev/start script) is what the repo
  // shows people, even when a Python API, a Dockerfile or other services sit
  // beside it (e.g. Vite + FastAPI). The browser can run that app; the engine,
  // when connected, runs the whole thing (see otherServices).
  const rootPkg = tree['package.json']?.file ? readPackageJsonAt(tree, '') : null;
  const rootScript = pickStartScript(rootPkg);
  if (rootScript && stack.runtime !== 'unknown') {
    const manager = detectPackageManager(tree, '');
    const blocker = treeWebContainerBlocker(tree);
    return {
      ok: true,
      source: 'heuristic',
      runtime: 'node',
      canRunInBrowserSandbox: !blocker,
      workdir: '',
      installCmd: `${manager} install`,
      startCmd: manager === 'npm' ? `npm run ${rootScript}` : `${manager} ${rootScript}`,
      envVarsMentioned: [],
      otherServices: stack.label,
      reasoning: blocker
        ? `${blocker} — running on the engine with real Node instead of in-browser.`
        : `Full-stack repo: its JavaScript app runs in your browser; the ${stack.label} part needs the runner engine.`,
    };
  }

  if (stack.runtime !== 'unknown') {
    return {
      ok: true,
      source: 'heuristic',
      runtime: stack.runtime,
      canRunInBrowserSandbox: false,
      workdir: null,
      installCmd: null,
      startCmd: null,
      envVarsMentioned: [],
      reasoning: `Detected ${stack.label} dependencies. WebContainers can only run pure Node.js, so this will be routed to the Docker backend.`,
    };
  }

  // If no other backend is detected, see if it's a pure Node.js project
  const workdir = findPackageJsonDir(tree);

  if (workdir === null) {
    return {
      ok: true,
      source: 'heuristic',
      runtime: 'unknown',
      canRunInBrowserSandbox: false,
      workdir: null,
      installCmd: null,
      startCmd: null,
      envVarsMentioned: [],
      reasoning: 'No recognized project manifest found. Try running with the Docker backend for custom setups.',
    };
  }

  const pkg = readPackageJsonAt(tree, workdir);
  const startScript = pickStartScript(pkg);
  const manager = detectPackageManager(tree, workdir);

  // Some Node projects can't run in a browser WebContainer — Next.js (native
  // Turbopack/SWC WASM bindings) and any package with a native (node-gyp) addon
  // like bcrypt/sqlite3/canvas. Scan every package.json in the repo (deps may
  // live in a subfolder), and route those to the backend to run on real Node.
  const incompatible = treeWebContainerBlocker(tree);

  const startCmd = startScript
    ? manager === 'npm'
      ? `npm run ${startScript}`
      : `${manager} ${startScript}`
    : null;

  if (incompatible) {
    return {
      ok: true,
      source: 'heuristic',
      runtime: 'node',
      canRunInBrowserSandbox: false,
      workdir,
      installCmd: `${manager} install`,
      startCmd,
      envVarsMentioned: [],
      reasoning: `${incompatible} — running on the backend with real Node instead of in-browser.`,
    };
  }

  return {
    ok: true,
    source: 'heuristic',
    runtime: 'node',
    canRunInBrowserSandbox: true,
    workdir,
    installCmd: `${manager} install`,
    startCmd,
    envVarsMentioned: [],
    reasoning: workdir
      ? `Node.js project detected in "${workdir}/". Running in-browser via WebContainers.`
      : 'Node.js project detected at the repo root. Running in-browser via WebContainers.',
  };
}

/**
 * Return a human-readable reason if a Node project can't run in a browser
 * WebContainer (so it should go to the backend), or null if it's fine.
 */
// Only prompt the user for real secrets (API keys, tokens, DB URIs). Base URLs,
// host/port, and other config are auto-wired or left to the app's defaults.
const _DB_CONN_RE = /(MONGO|DATABASE|POSTGRES|POSTGRESQL|MYSQL|MARIADB|REDIS|MSSQL|SQLALCHEMY|DB)[_A-Z0-9]*(URL|URI|CONNECTION|DSN)|CONNECTION[_-]?STRING/i;
const _CONFIG_URL_RE = /(_URL|_URI|_ENDPOINT|_HOST|_PORT|BASE[_-]?URL)$|^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_)/i;
const _SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE|AUTH|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|API[_-]?KEY|DSN)/i;

export function isPromptableSecret(name) {
  if (_DB_CONN_RE.test(name)) return true;
  if (_CONFIG_URL_RE.test(name)) return false;
  if (_SECRET_RE.test(name)) return true;
  return false;
}

// Packages with native (node-gyp / prebuilt .node) addons that a browser
// WebContainer can't load — they must run on real Node.
const NATIVE_ADDON_DEPS = new Set([
  'bcrypt', 'sqlite3', 'better-sqlite3', 'canvas', 'sharp', 'node-sass',
  'grpc', 'robotjs', 'serialport', 'usb', 'node-hid', 'ffi-napi', 'ref-napi',
  'zeromq', 'leveldown', 'node-gyp', 'bufferutil', 'utf-8-validate', 'sqlite',
  'puppeteer', 'playwright',
]);

export function webContainerIncompatibleReason(pkg) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const scripts = Object.values(pkg?.scripts || {}).join(' ');
  // Only the script that starts the app matters ("test": "bun test" doesn't);
  // a bun.lockb alone is fine — npm installs from package.json.
  const startScript = pkg?.scripts?.[pickStartScript(pkg)] || '';
  if (/(^|\s|&&|;)bunx?\s/.test(startScript)) {
    return 'This app starts with Bun, and Bun can\'t run in the browser sandbox';
  }
  if (deps.turbo && /\bturbo\s/.test(scripts)) return 'Turborepo is a native program that can\'t run in the browser sandbox';
  if (deps.next) return 'Next.js uses native/WASM bindings that break in-browser';
  if (deps.prisma || deps['@prisma/client']) return 'Prisma downloads native database engines, which the browser sandbox can\'t run';
  const native = Object.keys(deps).find((d) => NATIVE_ADDON_DEPS.has(d));
  if (native) return `"${native}" is a native module that can't load in a browser sandbox`;
  return null;
}

/** Scan every package.json in the tree (root + subfolders) for a blocker. */
export function treeWebContainerBlocker(tree) {
  const queue = [tree];
  while (queue.length) {
    const node = queue.shift();
    const pkgNode = node['package.json'];
    if (pkgNode?.file?.contents) {
      try {
        const raw = typeof pkgNode.file.contents === 'string'
          ? pkgNode.file.contents
          : new TextDecoder().decode(pkgNode.file.contents);
        const reason = webContainerIncompatibleReason(JSON.parse(raw));
        if (reason) return reason;
      } catch {
        // ignore unparseable package.json
      }
    }
    for (const [name, child] of Object.entries(node)) {
      if (!SKIP_DIRS.has(name) && child.directory) queue.push(child.directory);
    }
  }
  return null;
}

export function readPackageJsonAt(tree, dir) {
  let node = tree;
  if (dir) {
    for (const part of dir.split('/')) {
      const next = node[part];
      if (!next || !next.directory) return null;
      node = next.directory;
    }
  }
  const pkg = node['package.json'];
  if (!pkg?.file) return null;
  try {
    const contents =
      typeof pkg.file.contents === 'string'
        ? pkg.file.contents
        : new TextDecoder().decode(pkg.file.contents);
    return JSON.parse(contents);
  } catch {
    return null;
  }
}

export function pickStartScript(pkg) {
  const scripts = pkg?.scripts ?? {};
  if (scripts.dev) return 'dev';
  if (scripts.start) return 'start';
  // "serve" is usually a dev server; "preview" only serves an existing build.
  if (scripts.serve) return 'serve';
  if (scripts.preview) return 'preview';
  return null;
}

function detectPackageManager(tree, dir) {
  const has = (name) => dirHasFile(tree, dir, name);
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  return 'npm';
}

function dirHasFile(tree, dir, fileName) {
  let node = tree;
  if (dir) {
    for (const part of dir.split('/')) {
      const next = node[part];
      if (!next || !next.directory) return false;
      node = next.directory;
    }
  }
  return !!node[fileName]?.file;
}

/**
 * Splits a simple shell command string into argv, e.g. "npm run dev" ->
 * ["npm", "run", "dev"]. Naive (no quote handling) — good enough for the
 * install/start commands a heuristic or LLM produces.
 */
export function splitCommand(cmd) {
  return cmd.trim().split(/\s+/).filter(Boolean);
}
