import { WebContainer } from '@webcontainer/api';
import {
  splitCommand,
  findPackageJsonDir,
  detectStack,
  readPackageJsonAt,
  pickStartScript,
} from './heuristics.js';

let containerInstance = null;
// The container outlives a run, so the previous run's process and
// server-ready listener must be cleaned up before the next one starts.
let activeRun = { process: null, unsubscribe: null };

/** Stop whatever the last in-browser run started. */
export function stopActiveRun() {
  try { activeRun.process?.kill(); } catch {}
  try { activeRun.unsubscribe?.(); } catch {}
  activeRun = { process: null, unsubscribe: null };
}

/** Empty the container's filesystem so a new repo doesn't mix with the last one. */
export async function clearContainerFs(container) {
  for (const name of await container.fs.readdir('.')) {
    await container.fs.rm(name, { recursive: true, force: true }).catch(() => {});
  }
}

/** Remember a run's process/listener so stopActiveRun() can clean it up. */
export function trackRun(run) {
  activeRun = { ...activeRun, ...run };
}

// Boot is expensive and WebContainer only allows one instance per tab, so we
// reuse it across runs instead of booting fresh every time.
export async function getContainer() {
  if (!containerInstance) {
    if (typeof window !== 'undefined' && !window.crossOriginIsolated) {
      throw new Error(
        'This page is not cross-origin isolated, so the in-browser Node sandbox (WebContainers) ' +
          "can't boot. Make sure the dev server sends the COOP/COEP headers (see vite.config.js) " +
          'and use a Chromium-based browser (Chrome, Edge, Arc).'
      );
    }
    // "credentialless" COEP lets the sandbox load cross-origin assets without
    // every one needing a CORP header — and matches the header in vite.config.js.
    containerInstance = await WebContainer.boot({ coep: 'credentialless' });
  }
  return containerInstance;
}

// `analysis` is the result of ollama.js's analyzeRepo() OR heuristics.js's
// analyzeTreeLocally(). Either way it may carry an installCmd, startCmd and the
// workdir (the directory the Node project actually lives in). We always locate
// package.json before running so a repo whose app is nested in a subfolder — or
// which has no package.json at all — is handled correctly instead of crashing
// with a confusing `npm install` ENOENT.
export async function runRepo({ tree, envVars, analysis, onOutput, onServerReady, onExit }) {
  const container = await getContainer();
  stopActiveRun();
  await clearContainerFs(container);

  onOutput('Mounting repo files into the container...\n');
  await container.mount(tree);

  // --- Fix: locate WHERE the Node project actually lives. ---
  const workdir = analysis?.workdir ?? findPackageJsonDir(tree);

  if (workdir === null) {
    const { runtime, label } = detectStack(tree);
    throw new Error(
      runtime === 'unknown'
        ? "No package.json found anywhere in this repo, so there's no Node.js app to install " +
          'or start. WebContainers can only run Node.js projects.'
        : `This looks like a ${label} project — no package.json exists anywhere in it. ` +
          'WebContainers can only run Node.js in the browser, so this repo needs a real backend ' +
          '(Docker, a server, or a cloud sandbox) to run for real.'
    );
  }

  if (workdir) {
    onOutput(`Node project found in "${workdir}/" — installing and starting there.\n`);
  }

  // Write .env into the project's own directory: the .env.example defaults
  // (why those keys weren't prompted for) plus the values the user entered.
  const envPath = joinPath(workdir, '.env');
  const given = Object.entries(envVars || {}).filter(([, v]) => v !== '');
  const hasEnv = await container.fs.readFile(envPath, 'utf-8').then(() => true, () => false);
  let example = null;
  for (const name of ['.env.example', '.env.sample', '.env.template']) {
    example = await container.fs.readFile(joinPath(workdir, name), 'utf-8').catch(() => null);
    if (example !== null) break;
  }
  if (given.length || (!hasEnv && example !== null)) {
    const lines = hasEnv ? (await container.fs.readFile(envPath, 'utf-8')).split(/\r?\n/) : (example || '').split(/\r?\n/);
    for (const [key, value] of given) {
      const i = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
      if (i >= 0) lines[i] = `${key}=${value}`;
      else lines.push(`${key}=${value}`);
    }
    await container.fs.writeFile(envPath, lines.join('\n'));
    onOutput(`Wrote ${envPath}${given.length ? ` with ${given.length} value(s)` : ' from the example file'}.\n`);
  }

  const pkg = readPackageJsonAt(tree, workdir);

  const hasNext = Boolean(pkg?.dependencies?.next || pkg?.devDependencies?.next);
  legacyOpenssl = needsLegacyOpenssl(pkg);
  if (legacyOpenssl) onOutput('Older webpack tooling: enabling Node\'s legacy OpenSSL provider.\n');
  const nextDevFallback = hasNext ? ['npx', 'next', 'dev'] : null;

  const installArgv = analysis?.installCmd ? splitCommand(analysis.installCmd) : ['npm', 'install'];
  if (hasNext) await pinNextForBrowser(container, workdir, onOutput);
  await upgradeOldEsbuild(container, workdir, onOutput);
  await installDependencies(container, installArgv, workdir, onOutput);
  if (hasNext) await patchNextScripts(container, workdir, onOutput);

  const startScript = pickStartScript(pkg);
  const workspace = !startScript && pkg?.workspaces ? await pickWorkspace(container, workdir, pkg) : null;
  const startArgv = analysis?.startCmd
    ? splitCommand(analysis.startCmd)
    : startScript
      ? ['npm', 'run', startScript]
      : workspace
        ? ['npm', 'run', workspace.script, '--workspace', workspace.name]
        : nextDevFallback;

  if (!startArgv) {
    // Last-resort fallback for projects without scripts.
    // If it's Next.js, we would have returned nextDevFallback already.
    throw new Error(
      'This repo has no runnable start command. It does not define dev/start/preview/serve scripts in package.json and it is not detected as a Next.js app.'
    );
  }

  onOutput(`Starting the app (${startArgv.join(' ')})...\n`);

  trackRun({ unsubscribe: container.on('server-ready', (port, url) => onServerReady(url, port)) });

  // If the repo crashes immediately (e.g. Next.js/Turbopack WASM limitations),
  // surface a clearer error instead of leaving the user with a dead terminal.
  const run = await container.spawn(startArgv[0], startArgv.slice(1), spawnOpts(workdir));
  trackRun({ process: run });
  pipeToOutput(run, onOutput); // don't await — this runs indefinitely

  run.exit
    .then((code) => {
      onOutput(`\nProcess exited with code ${code}.\n`);
      // The dev server shouldn't exit on its own — if it did, it crashed
      // (e.g. a native module WebContainers can't load). Signal for fallback.
      onExit?.(code);
    })
    .catch(() => {
      onExit?.(-1);
    });

  return { container, process: run };
}

// BROWSER=none: create-react-app & co. would otherwise try to open a tab.
const SANDBOX_ENV = { BROWSER: 'none' };

/**
 * webpack 4-era tooling (react-scripts < 5, Vue CLI < 5, Next < 12, webpack
 * < 5) uses a hash Node 17+ disables — it crashes with ERR_OSSL_EVP_UNSUPPORTED
 * unless the legacy OpenSSL provider is enabled.
 */
export function needsLegacyOpenssl(pkg) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const major = (name) => Number(deps[name]?.match(/(\d+)/)?.[1]);
  return major('react-scripts') < 5 || major('@vue/cli-service') < 5 || major('next') < 12 || major('webpack') < 5;
}

let legacyOpenssl = false;

function spawnOpts(workdir) {
  const env = legacyOpenssl ? { ...SANDBOX_ENV, NODE_OPTIONS: '--openssl-legacy-provider' } : SANDBOX_ENV;
  return { ...(workdir ? { cwd: workdir } : {}), env };
}

const joinPath = (dir, file) => (dir ? `${dir}/${file}` : file);

/**
 * Install with the repo's package manager. npm 7+ rejects the conflicting
 * peer dependencies many older projects shipped with, and pnpm/yarn setups
 * sometimes fail in the sandbox — retry with npm's lenient mode before giving up.
 */
async function installDependencies(container, argv, workdir, onOutput) {
  onOutput(`Installing dependencies (${argv.join(' ')})...\n`);
  let proc = await container.spawn(argv[0], argv.slice(1), spawnOpts(workdir));
  await pipeToOutput(proc, onOutput);
  if ((await proc.exit) === 0) return;

  onOutput('\nInstall failed — retrying with npm install --legacy-peer-deps...\n');
  let log = '';
  proc = await container.spawn('npm', ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'], spawnOpts(workdir));
  await pipeToOutput(proc, (text) => {
    log = (log + text).slice(-20000);
    onOutput(text);
  });
  const code = await proc.exit;
  if (code === 0) return;
  if (/codeload\.github\.com|git\+|github:|Unsupported URL Type "git/i.test(log)) {
    throw new Error('A dependency is downloaded straight from a git repository, which the browser sandbox can\'t do — it needs the runner engine.');
  }
  if (/Unsupported URL Type "workspace:/i.test(log)) {
    throw new Error('This monorepo uses "workspace:" dependencies that need pnpm or Bun — it needs the runner engine.');
  }
  throw new Error(`Installing dependencies failed (exit code ${code}).`);
}

// Next.js 15.5+ fails inside WebContainers ("Expected workStore to be
// initialized", vercel/next.js#84026); 15.4 is the newest release that works.
const NEXT_BROWSER_VERSION = '15.4.11';

/** Does a dependency range ask for Next 15.5 or newer ("latest", "^16", "15.5.2")? */
function needsOlderNext(range) {
  if (!range || /latest|canary|rc/.test(range)) return !!range;
  const m = range.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2] || 0)];
  return major > 15 || (major === 15 && minor >= 5);
}

/**
 * Before install: pin Next.js to the newest version that runs in the browser
 * sandbox. The repo's own version still runs on the engine.
 */
async function pinNextForBrowser(container, workdir, onOutput) {
  const pkgPath = joinPath(workdir, 'package.json');
  const pkg = JSON.parse(await container.fs.readFile(pkgPath, 'utf-8'));
  const section = pkg.dependencies?.next ? 'dependencies' : 'devDependencies';
  const range = pkg[section]?.next;
  if (!needsOlderNext(range)) return;
  pkg[section].next = NEXT_BROWSER_VERSION;
  for (const key of ['dependencies', 'devDependencies']) {
    if (pkg[key]?.['eslint-config-next']) pkg[key]['eslint-config-next'] = NEXT_BROWSER_VERSION;
  }
  await container.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  onOutput(`Next.js ${range} can't run in the browser sandbox yet — using Next.js ${NEXT_BROWSER_VERSION} here (the runner engine uses the repo's own version).\n`);
}

/**
 * After install: Turbopack needs native bindings the sandbox doesn't have
 * ("turbo.createProject is not supported by the wasm bindings"), so drop
 * --turbo/--turbopack and let `next dev` use webpack.
 */
async function patchNextScripts(container, workdir, onOutput) {
  const pkgPath = joinPath(workdir, 'package.json');
  const pkg = JSON.parse(await container.fs.readFile(pkgPath, 'utf-8'));
  let changed = false;
  for (const [name, script] of Object.entries(pkg.scripts || {})) {
    const fixed = script.replace(/\s--turbo(pack)?\b/g, '').replace(/\s--webpack\b/g, '');
    if (fixed !== script) {
      pkg.scripts[name] = fixed;
      changed = true;
    }
  }
  if (changed) {
    await container.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    onOutput('Using webpack instead of Turbopack (Turbopack can\'t run in the browser sandbox).\n');
  }
}

// esbuild before ~0.17 (pulled in by Vite 2/3) dies in WebContainers with
// "The service was stopped"; Vite only uses its stable transform/build API,
// so a newer esbuild works in its place.
const ESBUILD_FOR_OLD_VITE = '0.18.20';

async function upgradeOldEsbuild(container, workdir, onOutput) {
  const pkgPath = joinPath(workdir, 'package.json');
  const pkg = JSON.parse(await container.fs.readFile(pkgPath, 'utf-8'));
  const vite = pkg.devDependencies?.vite || pkg.dependencies?.vite;
  const major = Number(vite?.match(/(\d+)/)?.[1]);
  if (!vite || !(major <= 3)) return;
  pkg.overrides = { ...(pkg.overrides || {}), esbuild: ESBUILD_FOR_OLD_VITE };
  await container.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  // The lockfile pins the old esbuild; let npm re-resolve.
  await container.fs.rm(joinPath(workdir, 'package-lock.json'), { force: true }).catch(() => {});
  onOutput(`Vite ${major}: using esbuild ${ESBUILD_FOR_OLD_VITE} (its original esbuild can't run in the browser sandbox).\n`);
}

/** For an npm-workspaces root without scripts: a workspace to run, preferring a frontend. */
async function pickWorkspace(container, workdir, pkg) {
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages || [];
  const dirs = [];
  for (const pat of patterns) {
    if (pat.endsWith('/*')) {
      const base = pat.slice(0, -2);
      try {
        for (const e of await container.fs.readdir(joinPath(workdir, base), { withFileTypes: true })) {
          if (e.isDirectory()) dirs.push(`${base}/${e.name}`);
        }
      } catch {
        // missing folder
      }
    } else {
      dirs.push(pat);
    }
  }
  const FRONTEND = ['vite', 'next', 'react-scripts', '@sveltejs/kit', 'nuxt', 'vue', '@angular/core'];
  const candidates = [];
  for (const dir of dirs) {
    try {
      const wpkg = JSON.parse(await container.fs.readFile(joinPath(workdir, `${dir}/package.json`), 'utf-8'));
      const script = pickStartScript(wpkg);
      if (!wpkg.name || !script) continue;
      const deps = { ...(wpkg.dependencies || {}), ...(wpkg.devDependencies || {}) };
      candidates.push({ name: wpkg.name, script, frontend: FRONTEND.some((d) => deps[d]) });
    } catch {
      // no package.json there
    }
  }
  return candidates.find((c) => c.frontend) || candidates[0] || null;
}

async function pipeToOutput(process, onOutput) {
  const reader = process.output.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    onOutput(value);
  }
}

