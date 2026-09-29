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

  // Write .env into the project's own directory, not blindly at the root.
  if (envVars && Object.keys(envVars).length > 0) {
    const envContent = Object.entries(envVars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const envPath = workdir ? `${workdir}/.env` : '.env';
    await container.fs.writeFile(envPath, envContent);
    onOutput(`Wrote ${envPath} with provided values.\n`);
  }

  const pkg = readPackageJsonAt(tree, workdir);

  // Next.js/Turbopack projects often run best with `next dev`.
  // If heuristic/LLM failed to detect a start script, try a safe fallback.
  const hasNext = Boolean(pkg?.dependencies?.next || pkg?.devDependencies?.next);
  const nextDevFallback = hasNext ? ['npx', 'next', 'dev'] : null;

  const installArgv = analysis?.installCmd ? splitCommand(analysis.installCmd) : ['npm', 'install'];

  onOutput(`Installing dependencies (${installArgv.join(' ')})...\n`);
  const install = await container.spawn(installArgv[0], installArgv.slice(1), spawnOpts(workdir));
  await pipeToOutput(install, onOutput);
  const installExit = await install.exit;
  if (installExit !== 0) {
    throw new Error(`${installArgv.join(' ')} failed with exit code ${installExit}`);
  }

  const startScript = pickStartScript(pkg);
  const startArgv = analysis?.startCmd
    ? splitCommand(analysis.startCmd)
    : startScript
      ? ['npm', 'run', startScript]
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

function spawnOpts(workdir) {
  return workdir ? { cwd: workdir } : {};
}

async function pipeToOutput(process, onOutput) {
  const reader = process.output.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    onOutput(value);
  }
}

