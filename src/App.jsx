import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { parseGithubUrl, fetchRepoTree, hydrateAllFiles, detectEnvVars, GitHubNetworkError, RateLimitError } from './lib/github.js';
import { runRepo, stopActiveRun } from './lib/runner.js';
import { runStaticSite } from './lib/static-runner.js';
import { runPythonInBrowser, buildStlitePage } from './lib/python-runner.js';
import { planBrowserRun, notebookWithCode } from './lib/browser-plan.js';
import { analyzeRepo, checkOllamaAvailable } from './lib/ollama.js';
import { analyzeTreeLocally, detectStack, isPromptableSecret, treeWebContainerBlocker } from './lib/heuristics.js';
import {
  analyzeRepoBackend,
  runRepoBackend,
  runRepoNative,
  stopRepoBackend,
  connectWebSocket,
  getPreviewUrl,
  checkBackendStatus,
  BACKEND_IS_LOCAL,
  savedEngineUrl,
  setEngineUrl,
} from './lib/backend-runner.js';

const STAGES = {
  IDLE: 'idle',
  FETCHING: 'fetching',
  ANALYZING: 'analyzing',
  NEEDS_ENV: 'needs_env',
  BUILDING: 'building',
  RUNNING: 'running',
  READY: 'ready',
  ERROR: 'error',
};

const STEPS = [
  { key: 'fetch', label: 'Fetch' },
  { key: 'detect', label: 'Detect' },
  { key: 'install', label: 'Install' },
  { key: 'start', label: 'Start' },
  { key: 'live', label: 'Live' },
];

// Rough progress for each step; the bar creeps toward the next value while a
// step runs so long installs still show movement.
const STEP_PROGRESS = { fetch: [4, 18], detect: [18, 30], install: [30, 78], start: [78, 94], live: [100, 100] };

const IN_BROWSER_STACKS = ['Node.js', 'Python', 'Streamlit', 'Notebooks', 'HF pipelines (WebGPU)', 'Static sites'];
const ENGINE_STACKS = ['Java', 'Go', 'Rust', 'C / C++', 'PHP', 'Ruby', '.NET', 'Django', 'Flask', 'FastAPI', 'Gradio'];

const EXAMPLES = [
  { label: 'Express app', url: 'https://github.com/heroku/node-js-getting-started' },
  { label: 'Streamlit demo', url: 'https://github.com/streamlit/streamlit-example' },
  { label: 'Static site', url: 'https://github.com/bradtraversy/50projects50days' },
];

const MODE_LABELS = {
  webcontainer: 'Running in your browser',
  browser: 'Running in your browser',
  native: 'Running on the engine',
  docker: 'Running in Docker',
};

/** Normalize "github.com/o/r", "o/r" or a full URL into https://github.com/o/r[/tree/b]. */
function normalizeRepoUrl(input) {
  const trimmed = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return `https://github.com/${trimmed}`;
  if (/^github\.com\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

// The whole run's output as plain text (for "Copy log"; also handy in devtools).
const fullLog = { text: '' };
if (typeof window !== 'undefined') window.__repoRunnerLog = fullLog;

const TOKEN_KEY = 'repo-runner-github-token';

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // storage unavailable (private mode) — keep it for this page only
  }
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function formatElapsed(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function App() {
  const [repoUrl, setRepoUrl] = useState('');
  const [repoName, setRepoName] = useState('');
  // Pre-fill the GitHub token from a local .env (VITE_GITHUB_TOKEN) so it
  // doesn't have to be entered every time.
  const [token, setToken] = useState(() => import.meta.env.VITE_GITHUB_TOKEN || readStored(TOKEN_KEY) || '');
  const [showToken, setShowToken] = useState(false);
  const [ollamaEndpoint] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('llama3.1');
  // Auto-enabled when a local Ollama server is detected (no manual toggle).
  const [useOllama, setUseOllama] = useState(false);
  const [stage, setStage] = useState(STAGES.IDLE);
  const [errorMsg, setErrorMsg] = useState('');
  const [errorKind, setErrorKind] = useState(null); // null | 'needs-engine'
  const [detectedKeys, setDetectedKeys] = useState([]);
  const [envValues, setEnvValues] = useState({});
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewKey, setPreviewKey] = useState(0);
  const [previewPending, setPreviewPending] = useState(false); // frame loading behind the launch screen
  const [runtimeInfo, setRuntimeInfo] = useState(null);
  const [serverOnline, setServerOnline] = useState(false);
  const [dockerOnline, setDockerOnline] = useState(false);
  const [executionMode, setExecutionMode] = useState(null); // 'webcontainer' | 'browser' | 'docker' | 'native'
  const [isTerminalOpen, setIsTerminalOpen] = useState(true);
  const [phase, setPhase] = useState(null); // 'install' | 'start' — from the logs
  const [activity, setActivity] = useState('');
  const [figures, setFigures] = useState([]);
  const [programDone, setProgramDone] = useState(null); // exit code of a console program
  const [inputEnabled, setInputEnabled] = useState(false);
  const [awaitingInput, setAwaitingInput] = useState(false);

  const treeRef = useRef(null);
  const blobsRef = useRef(null);
  const repoMetaRef = useRef(null);
  const analysisRef = useRef(null);
  const termRef = useRef(null);
  const termInstance = useRef(null);
  const fitAddon = useRef(null);
  const sessionRef = useRef(null);
  const wsRef = useRef(null);
  const fellBackRef = useRef(false);
  const repoUrlRef = useRef('');
  const branchRef = useRef(null);
  const planRef = useRef(null); // how the repo could run in the browser, if at all
  const pythonRef = useRef(null);
  const inputTargetRef = useRef(null); // (line) => void — where terminal input goes
  const lastLineRef = useRef('');
  const blobUrlRef = useRef(null);

  // Check backend availability on mount (with retries for the auto-start race).
  const refreshBackendStatus = useCallback(async (retries = 1) => {
    const status = await checkBackendStatus({ maxRetries: retries, retryDelayMs: 2000 });
    setServerOnline(status.serverOnline);
    setDockerOnline(status.dockerOnline);
    return status;
  }, []);

  useEffect(() => {
    // A deployed UI has no local dev server racing to start, so don't retry.
    let online = false;
    let ticks = 0;
    refreshBackendStatus(BACKEND_IS_LOCAL && import.meta.env.DEV ? 3 : 0).then((s) => { online = s.serverOnline; });
    // Poll often while the engine is up; an unreachable one only every 2 minutes
    // (runs re-check it themselves before they need it).
    const interval = setInterval(async () => {
      if (!online && ++ticks % 8) return;
      online = (await refreshBackendStatus(0)).serverOnline;
    }, 15000);
    return () => clearInterval(interval);
  }, [refreshBackendStatus]);

  // Auto-enable Ollama analysis when a local Ollama server is detected. Only
  // when the UI itself is local: a public site probing the visitor's
  // localhost triggers a browser permission prompt.
  useEffect(() => {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return undefined;
    let cancelled = false;
    checkOllamaAvailable(ollamaEndpoint).then(({ available, models }) => {
      if (cancelled || !available) return;
      setUseOllama(true);
      setOllamaModel((cur) =>
        models.length && !models.some((m) => m.startsWith(cur)) ? models[0] : cur
      );
    });
    return () => {
      cancelled = true;
    };
  }, [ollamaEndpoint]);

  // Terminal setup
  useEffect(() => {
    const term = new Terminal({
      convertEol: true,
      allowTransparency: true,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: 'rgba(0, 0, 0, 0)',
        foreground: '#c9d1d9',
        cursor: '#a78bfa',
        cursorAccent: '#07070a',
        selectionBackground: 'rgba(167, 139, 250, 0.25)',
        black: '#0e1218',
        brightBlack: '#5c6370',
        red: '#f47067',
        brightRed: '#ff8b82',
        green: '#57d68d',
        brightGreen: '#7ee2a8',
        yellow: '#e3b341',
        brightYellow: '#f0c85a',
        blue: '#6cb6ff',
        brightBlue: '#96ccff',
        magenta: '#c49bff',
        brightMagenta: '#dcbdfb',
        cyan: '#56d4dd',
        brightCyan: '#7fe3ea',
        white: '#adbac7',
        brightWhite: '#e6edf3',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (termRef.current) {
      term.open(termRef.current);
      try { fit.fit(); } catch {}
    }
    termInstance.current = term;
    fitAddon.current = fit;

    // Line-buffered input for programs that read stdin (input(), cin, gets…).
    let line = '';
    const onData = term.onData((data) => {
      const send = inputTargetRef.current;
      if (!send) return;
      for (const ch of data) {
        if (ch === '\r') {
          term.write('\r\n');
          send(line);
          line = '';
          setAwaitingInput(false);
        } else if (ch === '\x7f' || ch === '\b') {
          if (line) {
            line = line.slice(0, -1);
            term.write('\b \b');
          }
        } else if (ch >= ' ' || ch === '\t') {
          line += ch;
          term.write(ch);
        }
      }
    });

    const onResize = () => {
      try { fit.fit(); } catch {}
    };
    const resizeObserver = new ResizeObserver(() => window.requestAnimationFrame(onResize));
    if (termRef.current) resizeObserver.observe(termRef.current);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      resizeObserver.disconnect();
      onData.dispose();
      term.dispose();
    };
  }, []);

  const writeLog = useCallback((text) => {
    if (/\[install\]|\[setup\]|\[build\]|Installing|Downloading project files|not found — downloading|Compiling/i.test(text)) {
      setPhase((p) => (p === 'start' ? p : 'install'));
    }
    if (/\[start\]|\[serve\]|Starting the app|▸ Running /.test(text)) setPhase('start');
    const plain = stripAnsi(text);
    const lines = plain.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length) lastLineRef.current = lines[lines.length - 1];
    // Full plain-text log for "Copy log" (the terminal only keeps its scrollback).
    fullLog.text = (fullLog.text + plain).slice(-500_000);
    termInstance.current?.write(text.replace(/\r?\n/g, '\r\n'));
  }, []);

  // Surface the latest log line as "what's happening now" (throttled).
  useEffect(() => {
    const id = setInterval(() => setActivity(lastLineRef.current.slice(0, 160)), 250);
    return () => clearInterval(id);
  }, []);

  // Refit the terminal whenever the panel opens/closes so content isn't clipped.
  useEffect(() => {
    const id = setTimeout(() => { try { fitAddon.current?.fit(); } catch {} }, 320);
    return () => clearTimeout(id);
  }, [isTerminalOpen]);

  function resetRunState() {
    setErrorMsg('');
    setErrorKind(null);
    setRuntimeInfo(null);
    setPreviewUrl('');
    setPreviewPending(false);
    setExecutionMode(null);
    setPhase(null);
    setFigures([]);
    setProgramDone(null);
    setAwaitingInput(false);
    setInputTarget(null);
    lastLineRef.current = '';
    analysisRef.current = null;
    sessionRef.current = null;
    fellBackRef.current = false;
    planRef.current = null;
  }

  function setInputTarget(fn) {
    inputTargetRef.current = fn;
    setInputEnabled(!!fn);
  }

  function fail(message, kind = null) {
    setInputTarget(null);
    setAwaitingInput(false);
    setErrorMsg(message);
    setErrorKind(kind);
    setStage(STAGES.ERROR);
    writeLog(`\n\x1b[1;31m✗ ${message}\x1b[0m\n`);
  }

  // ─── Main Flow ───

  async function handleFetchRepo(e) {
    e?.preventDefault();
    await stopEverything();
    resetRunState();
    termInstance.current?.clear();
    fullLog.text = '';
    setStage(STAGES.FETCHING);

    try {
      const { owner, repo, branch: urlBranch } = parseGithubUrl(normalizeRepoUrl(repoUrl));
      // The engine gets a clean clone URL; a /tree/<branch> is sent separately.
      repoUrlRef.current = `https://github.com/${owner}/${repo}`;
      branchRef.current = urlBranch;
      setRepoName(`${owner}/${repo}`);
      // 'HEAD' is the default branch — saves a GitHub API call.
      const branch = urlBranch || 'HEAD';
      writeLog(`\x1b[1;36m▸ Fetching ${owner}/${repo}${urlBranch ? ` (${urlBranch})` : ''}…\x1b[0m\n`);

      const { tree, blobs } = await fetchRepoTree({
        owner,
        repo,
        branch,
        token,
        onProgress: (msg) => writeLog(`  ${msg}\n`),
      });
      treeRef.current = tree;
      blobsRef.current = blobs;
      repoMetaRef.current = { owner, repo, branch, token };

      // ── Analysis ──
      setStage(STAGES.ANALYZING);
      // The built-in heuristics are instant and reliable for known stacks; a
      // local Ollama model is only consulted when they can't tell.
      let analysis = analyzeTreeLocally(tree);
      if (analysis.runtime === 'unknown' && useOllama) {
        writeLog(`\n\x1b[1;35m▸ Asking Ollama to analyze the repo…\x1b[0m\n`);
        const ollamaResult = await analyzeRepo({
          tree,
          endpoint: ollamaEndpoint,
          model: ollamaModel,
          onProgress: (msg) => writeLog(msg),
        });
        if (ollamaResult.ok) {
          // Never trust a "runs in the browser" answer for a repo with a known blocker.
          const blocker = treeWebContainerBlocker(tree);
          analysis = blocker && ollamaResult.canRunInBrowserSandbox
            ? { ...ollamaResult, canRunInBrowserSandbox: false, reasoning: blocker }
            : ollamaResult;
          if (analysis.reasoning) writeLog(`  ${analysis.reasoning}\n`);
        }
      }
      writeLog(`\n\x1b[1;35m▸ Detected: ${analysis.runtime} project\x1b[0m\n`);
      analysisRef.current = analysis;

      // ── Decide where it runs ──
      // Full-stack repos (a JS app plus e.g. a Python API) run whole on the
      // engine when one is connected; otherwise the JS app runs in the browser.
      const engineForAll = analysis.otherServices && (await refreshBackendStatus(0)).serverOnline;
      if (analysis.canRunInBrowserSandbox && !engineForAll) {
        setExecutionMode('webcontainer');
        setRuntimeInfo({ id: 'node', label: 'Node.js', color: '#68a063' });
        writeLog(analysis.otherServices
          ? `\x1b[1;32m✓ Running the JavaScript app in your browser.\x1b[0m\n\x1b[33m  Its ${analysis.otherServices} part needs the runner engine — connect one to run the whole repo.\x1b[0m\n`
          : `\x1b[1;32m✓ Node.js project — running in your browser (WebContainers)\x1b[0m\n`);
        return await askEnvOrRun(detectEnvVars(tree), analysis, (env) => startWebContainerRun(tree, env));
      }

      const status = await refreshBackendStatus(0);
      const stack = analysis.runtime === 'node' ? 'node' : detectStack(tree).runtime;
      const plan = planBrowserRun(tree, stack);
      planRef.current = plan;

      // Static sites are always served in-browser; Python goes to the engine
      // when there is one (full CPython, any package), otherwise Pyodide.
      if (plan.kind && (plan.kind === 'static' || !status.serverOnline)) {
        return await startBrowserRun(plan);
      }

      if (!status.serverOnline) {
        if (analysis.runtime === 'node' && /Bun|Turborepo/.test(analysis.reasoning || '')) {
          fail(`${analysis.reasoning.split(' — ')[0]}.`, 'needs-engine');
          return;
        }
        if (analysis.runtime === 'node') {
          // No engine to fall back to — the browser sandbox is the best chance.
          writeLog(`\x1b[33m⚠ ${analysis.reasoning} No engine is connected, so trying in the browser anyway.\x1b[0m\n`);
          fellBackRef.current = true;
          setExecutionMode('webcontainer');
          setRuntimeInfo({ id: 'node', label: 'Node.js', color: '#68a063' });
          return await startWebContainerRun(tree, {});
        }
        const label = { go: 'Go', rust: 'Rust', php: 'PHP', ruby: 'Ruby', java: 'Java', dotnet: '.NET', cpp: 'C / C++', docker: 'Docker', python: 'Python' }[stack] || 'This';
        fail(plan.reason || `${label} projects need the runner engine — a browser tab can't run them.`, 'needs-engine');
        return;
      }

      // ── Engine (backend) ──
      writeLog(`\n\x1b[1;33m▸ Cloning on the runner engine…\x1b[0m\n`);
      const backendAnalysis = await analyzeRepoBackend({ repoUrl: repoUrlRef.current, branch: branchRef.current, token });
      sessionRef.current = backendAnalysis.sessionId;
      setRuntimeInfo(backendAnalysis.runtime);
      writeLog(`\x1b[1;32m✓ Detected: ${backendAnalysis.runtime.label}\x1b[0m\n`);

      const keys = [
        ...detectEnvVars(tree),
        ...(backendAnalysis.envVars || []),
        ...(analysis.envVarsMentioned || []),
      ];

      if (backendAnalysis.nativeAvailable) {
        setExecutionMode('native');
        writeLog(`\x1b[1;32m✓ Running natively on the engine (missing runtimes are installed automatically)\x1b[0m\n`);
        return await askEnvOrRun(keys, analysis, (env) => startNativeRun(backendAnalysis.sessionId, env));
      }
      if (status.dockerOnline) {
        setExecutionMode('docker');
        return await askEnvOrRun(keys, analysis, (env) => startDockerRun(backendAnalysis.sessionId, env));
      }
      fail(`${backendAnalysis.runtime.label} can't run on this engine — it isn't installed and can't be installed automatically here.`);
    } catch (err) {
      fail(err.message);
    }
  }

  /** Prompt for secrets the app needs, or run straight away. */
  async function askEnvOrRun(keys, analysis, run) {
    const needed = [...new Set([...keys, ...(analysis?.envVarsMentioned || [])])].filter(isPromptableSecret);
    if (needed.length > 0) {
      setDetectedKeys(needed);
      setEnvValues(Object.fromEntries(needed.map((k) => [k, ''])));
      setStage(STAGES.NEEDS_ENV);
      writeLog(`\n\x1b[1;33m⚠ This app needs ${needed.length} secret(s) — fill them in to continue.\x1b[0m\n`);
      pendingRunRef.current = run;
      return;
    }
    await run({});
  }
  const pendingRunRef = useRef(null);

  // ─── In-browser runs (no backend): static sites and Python ───

  async function startBrowserRun(plan) {
    setStage(STAGES.RUNNING);
    setExecutionMode('browser');
    setRuntimeInfo({ label: plan.label, color: plan.kind === 'static' ? '#e34f26' : '#3776ab' });
    writeLog(`\x1b[1;32m✓ ${plan.reason}\x1b[0m\n`);

    const tree = treeRef.current;
    writeLog(`\n\x1b[1;36m▸ Downloading project files…\x1b[0m\n`);
    await hydrateAllFiles({ ...repoMetaRef.current, tree, blobs: blobsRef.current, onProgress: (m) => writeLog(`  ${m}\n`) });

    if (plan.kind === 'static') {
      setExecutionMode('webcontainer');
      writeLog(`\n\x1b[1;36m▸ Starting an in-browser web server…\x1b[0m\n`);
      await runStaticSite({
        tree,
        onOutput: writeLog,
        onServerReady: (url) => {
          setPreviewUrl(url);
          setStage(STAGES.READY);
          writeLog(`\n\x1b[1;32m✓ Live!\x1b[0m\n`);
        },
      });
      return;
    }

    if (plan.kind === 'stlite') {
      const url = buildStlitePage({ tree, entry: plan.entry });
      blobUrlRef.current = url;
      writeLog(`\n\x1b[1;36m▸ Starting ${plan.entry} — Python loads inside the preview (the first run takes ~30s)\x1b[0m\n`);
      setPhase('start');
      setPreviewUrl(url);
      setStage(STAGES.READY);
      return;
    }

    // Python script or notebook in a Pyodide worker.
    const entry = plan.kind === 'python-notebook' ? notebookWithCode(tree, plan.entry) : plan.entry;
    const ctl = runPythonInBrowser({
      tree,
      entry,
      mode: plan.kind === 'python-notebook' ? 'notebook' : 'script',
      hfBridge: !!plan.hfBridge,
      onOutput: writeLog,
      onFigure: (src) => setFigures((f) => [...f, src]),
      onStatus: (text) => {
        if (text.startsWith('Running')) {
          setStage(STAGES.READY);
          setIsTerminalOpen(true);
        }
      },
      onInputRequest: () => setAwaitingInput(true),
      onDone: (code) => {
        setProgramDone(code ?? 0);
        setAwaitingInput(false);
        setInputTarget(null);
        setStage(STAGES.READY);
        writeLog(`\n\x1b[2m[program exited with code ${code ?? 0}]\x1b[0m\n`);
      },
    });
    pythonRef.current = ctl;
    setInputTarget((line) => ctl.sendInput(line));
  }

  // ─── WebContainer execution (Node.js) ───

  async function startWebContainerRun(tree, envVars) {
    setStage(STAGES.RUNNING);
    let becameReady = false;
    try {
      if (blobsRef.current && repoMetaRef.current) {
        writeLog(`\n\x1b[1;36m▸ Downloading project files…\x1b[0m\n`);
        await hydrateAllFiles({
          ...repoMetaRef.current,
          tree,
          blobs: blobsRef.current,
          onProgress: (msg) => writeLog(`  ${msg}\n`),
        });
      }
      writeLog(`\n\x1b[1;36m▸ Booting the in-browser Node sandbox…\x1b[0m\n`);
      const { process: proc } = await runRepo({
        tree,
        envVars,
        analysis: analysisRef.current,
        onOutput: writeLog,
        onServerReady: (url, port, info) => {
          becameReady = true;
          setPreviewUrl(url);
          if (info?.pending) {
            // The frame loads (and triggers the compile) behind the launch screen.
            setPreviewPending(true);
            setPhase('start');
            return;
          }
          setStage(STAGES.READY);
          writeLog(`\n\x1b[1;32m✓ App is live at ${url}\x1b[0m\n`);
        },
        onPageReady: () => {
          setPreviewPending(false);
          setStage(STAGES.READY);
          writeLog(`\n\x1b[1;32m✓ App is live!\x1b[0m\n`);
        },
        onNoServer: () => {
          stopActiveRun();
          fail('This repo built successfully, but its dev command only rebuilds on file changes — it serves no web page (it looks like a library, not an app). The build output is in the terminal.');
        },
        // If the in-browser process exits before serving, fall back to the engine.
        onExit: (code) => {
          setInputTarget(null);
          if (!becameReady) {
            fallbackToBackend(envVars, code === 0
              ? 'its start command finished without opening a web server — it may be a library or build tool rather than an app'
              : `its start command failed with exit code ${code} — the terminal shows the error`);
          } else {
            // A dev server never exits on its own: it listened, then stopped
            // (e.g. Next.js failing to load its compiler exits with 0).
            // Don't leave a dead preview on screen.
            setPreviewUrl('');
            fail(`The app stopped after starting (exit code ${code}) — the terminal shows why.`);
          }
        },
      });
      const writer = proc.input.getWriter();
      setInputTarget((line) => writer.write(`${line}\n`));
    } catch (err) {
      // Not being able to download from GitHub isn't something the engine fixes.
      if (err instanceof GitHubNetworkError || err instanceof RateLimitError) {
        fail(err.message);
        return;
      }
      await fallbackToBackend(envVars, err.message);
    }
  }

  // ─── Automatic fallback: WebContainer failed → run on the engine ───
  async function fallbackToBackend(envVars, reason) {
    if (fellBackRef.current) {
      fail(`The in-browser run failed: ${reason}`);
      return;
    }
    fellBackRef.current = true;

    writeLog(`\n\x1b[1;33m⚠ In-browser run didn't work (${reason}).\x1b[0m\n`);
    const status = await refreshBackendStatus(0);
    if (!status.serverOnline) {
      fail(`This repo couldn't run in the browser (${reason}). Connect a runner engine to run it on a real server.`, 'needs-engine');
      return;
    }

    writeLog(`\x1b[1;36m▸ Retrying on the runner engine…\x1b[0m\n`);
    setStage(STAGES.ANALYZING);
    try {
      const backendAnalysis = await analyzeRepoBackend({ repoUrl: repoUrlRef.current, branch: branchRef.current, token });
      sessionRef.current = backendAnalysis.sessionId;
      setRuntimeInfo(backendAnalysis.runtime);
      if (backendAnalysis.nativeAvailable) {
        setExecutionMode('native');
        await startNativeRun(backendAnalysis.sessionId, envVars || {});
      } else if (status.dockerOnline) {
        setExecutionMode('docker');
        await startDockerRun(backendAnalysis.sessionId, envVars || {});
      } else {
        fail(`${backendAnalysis.runtime.label} can't run on this engine.`);
      }
    } catch (err) {
      fail(err.message);
    }
  }

  // ─── Engine execution (native or Docker) ───

  function connectEngine(sessionId, { docker = false } = {}) {
    const conn = connectWebSocket({
      sessionId,
      onOutput: writeLog,
      onStage: (data) => {
        if (data.stage === 'ready') setStage(STAGES.READY);
        else if (data.stage === 'building') setStage(STAGES.BUILDING);
        if (/finished/i.test(data.message || '')) setProgramDone(0);
        writeLog(`\x1b[1;35m[${data.stage}]\x1b[0m ${data.message}\n`);
      },
      onServerReady: (url) => {
        setPreviewUrl(docker ? getPreviewUrl(sessionId) : url);
        setStage(STAGES.READY);
        writeLog(`\n\x1b[1;32m✓ App is live!\x1b[0m\n`);
      },
      // When the browser can run this repo too, a failed engine run falls
      // back to it (startNativeRun) instead of ending on an error.
      onError: (msg) => (canRunInBrowser() ? writeLog(`\n\x1b[33m⚠ ${msg}\x1b[0m\n`) : fail(msg)),
    });
    wsRef.current = conn;
    setInputTarget((line) => {
      if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify({ type: 'input', data: `${line}\n` }));
    });
    return conn;
  }

  async function startDockerRun(sessionId, envVars) {
    setStage(STAGES.BUILDING);
    writeLog(`\n\x1b[1;36m▸ Building Docker sandbox…\x1b[0m\n`);
    connectEngine(sessionId, { docker: true });
    try {
      await runRepoBackend({ sessionId, envVars });
    } catch (err) {
      fail(err.message);
    }
  }

  async function startNativeRun(sessionId, envVars) {
    setStage(STAGES.BUILDING);
    writeLog(`\n\x1b[1;36m▸ Setting up the environment…\x1b[0m\n`);
    connectEngine(sessionId);
    let result;
    try {
      result = await runRepoNative({ sessionId, envVars });
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (result?.mode === 'native-console') setIsTerminalOpen(true);
    if (result?.ok !== false) return;
    if (canRunInBrowser()) {
      await fallbackToBrowser(envVars, result.blocked ? 'Windows blocked it on this PC' : 'it failed on the engine');
    } else if (result.error) {
      fail(result.error);
    }
  }

  /** Could this repo run in the browser instead (Python, static site, Node)? */
  function canRunInBrowser() {
    return !!planRef.current?.kind || (analysisRef.current?.runtime === 'node' && !fellBackRef.current);
  }

  /** The engine run failed — run the repo in the browser instead. */
  async function fallbackToBrowser(envVars, reason) {
    writeLog(`\n\x1b[1;33m▸ The engine run didn't work (${reason}) — running it in your browser instead…\x1b[0m\n`);
    const id = sessionRef.current;
    sessionRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    if (id) stopRepoBackend(id).catch(() => {});
    setPreviewUrl('');
    setErrorMsg('');
    if (planRef.current?.kind) {
      const plan = planRef.current;
      planRef.current = null; // don't loop
      await startBrowserRun(plan);
    } else {
      fellBackRef.current = true;
      setExecutionMode('webcontainer');
      await startWebContainerRun(treeRef.current, envVars || {});
    }
  }

  // ─── Env vars submit ───

  function handleRunWithEnv() {
    const run = pendingRunRef.current;
    pendingRunRef.current = null;
    if (run) run(envValues);
  }

  // ─── Stop ───

  async function stopEverything() {
    pythonRef.current?.stop();
    pythonRef.current = null;
    stopActiveRun();
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    if (sessionRef.current) {
      const id = sessionRef.current;
      sessionRef.current = null;
      await stopRepoBackend(id).catch(() => {});
    }
    wsRef.current?.close();
    wsRef.current = null;
  }

  async function handleStop() {
    if (stage !== STAGES.IDLE) writeLog(`\n\x1b[1;33m▸ Stopping…\x1b[0m\n`);
    await stopEverything();
    resetRunState();
    setStage(STAGES.IDLE);
  }

  const isBusy = [STAGES.FETCHING, STAGES.ANALYZING, STAGES.BUILDING, STAGES.RUNNING].includes(stage);
  const currentStep =
    stage === STAGES.FETCHING ? 'fetch'
      : stage === STAGES.ANALYZING ? 'detect'
        : stage === STAGES.BUILDING || stage === STAGES.RUNNING ? (phase || 'install')
          : stage === STAGES.READY ? 'live'
            : null;
  const progress = useStepProgress(currentStep, stage);
  const elapsed = useElapsed(stage);
  const isConsole = stage === STAGES.READY && !previewUrl;

  // Console programs live in the terminal — make sure it's visible.
  useEffect(() => {
    if (isConsole) setIsTerminalOpen(true);
  }, [isConsole]);

  return (
    <div className="app">
      <header className="topbar">
        {stage !== STAGES.IDLE && (
          <button className="brand" type="button" onClick={handleStop} title="Stop and go back">
            <GithubIcon size={24} />
            <span className="brand-text">
              <span className="brand-git">GIT</span>
              <span className="brand-live">Live</span>
            </span>
          </button>
        )}

        <div className="topbar-center">
          {stage !== STAGES.IDLE && repoName && (
            <div className="repo-chip">
              <span className="repo-chip-name">{repoName}</span>
              {runtimeInfo?.label && (
                <span className="runtime-tag" style={{ '--tag': runtimeInfo.color || '#8b949e' }}>
                  {runtimeInfo.label}
                </span>
              )}
              {executionMode && <span className="mode-tag">{MODE_LABELS[executionMode]}</span>}
            </div>
          )}
        </div>

        <div className="topbar-right">
          {stage !== STAGES.IDLE && (
            <button className="btn-ghost danger" type="button" onClick={handleStop}>
              <StopIcon /> Stop
            </button>
          )}
          <div
            className={`engine-badge ${serverOnline ? 'online' : 'web'}`}
            title={serverOnline
              ? `Runner engine connected${dockerOnline ? ' (Docker available)' : ''} — every stack can run.`
              : 'No runner engine connected — Node, Python, Streamlit, notebooks and static sites run in your browser.'}
          >
            <span className="badge-dot" />
            {serverOnline ? 'Engine online' : 'Browser mode'}
          </div>
        </div>
      </header>

      <main className={`hero ${stage === STAGES.IDLE ? '' : 'hidden'}`}>
        <div className="hero-content">
          <div className="hero-brand">
            <GithubIcon size={84} className="hero-icon" />
            <div className="brand-text hero-size">
              <span className="brand-git">
                <span className="brand-g">G</span>
                <span className="brand-it">IT</span>
              </span>
              <span className="brand-live">Live</span>
            </div>
          </div>
          <p className="hero-sub">Paste a GitHub repo — get a running app. No setup.</p>

          <form onSubmit={handleFetchRepo} className="hero-form">
            <div className="hero-input-group">
              <input
                id="repo-url"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck="false"
                placeholder="github.com/owner/repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                required
                className="hero-input"
              />
              <button className="btn-go" type="submit" disabled={!repoUrl.trim()}>
                Go Live <ArrowIcon />
              </button>
            </div>
          </form>

          <div className="examples">
            <span className="examples-label">Try</span>
            {EXAMPLES.map((ex) => (
              <button key={ex.url} type="button" className="example-chip" onClick={() => setRepoUrl(ex.url)}>
                {ex.label}
              </button>
            ))}
            <button
              type="button"
              className={`example-chip token-toggle ${token ? 'set' : ''}`}
              title="GitHub token (optional)"
              onClick={() => setShowToken((v) => !v)}
            >
              <KeyIcon /> {token ? 'Token set' : 'Token'}
            </button>
          </div>

          {showToken && (
            <div className="token-box">
              <input
                type="password"
                autoComplete="off"
                spellCheck="false"
                placeholder="GitHub token — for private repos or more than 60 runs an hour"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value.trim());
                  writeStored(TOKEN_KEY, e.target.value.trim());
                }}
              />
              <p>
                Stays in this browser. A fine-grained token with read-only access is enough —{' '}
                <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">create one</a>.
              </p>
            </div>
          )}

          {!self.crossOriginIsolated && (
            <div className="browser-note">
              This browser can't run Node.js projects in the page (it lacks cross-origin isolation — Safari, for example).
              Python, Streamlit and static sites still work; for everything, use Chrome, Edge or Firefox.
            </div>
          )}

          <div className="stack-groups">
            <div className="stack-group">
              <span className="stack-title">Runs in your browser</span>
              <div className="stack-list">
                {IN_BROWSER_STACKS.map((s) => <span key={s} className="stack-pill">{s}</span>)}
              </div>
            </div>
            <div className={`stack-group ${serverOnline ? '' : 'dim'}`}>
              <span className="stack-title">
                With the runner engine {serverOnline ? <em className="ok">· connected</em> : <em>· not connected</em>}
              </span>
              <div className="stack-list">
                {ENGINE_STACKS.map((s) => <span key={s} className="stack-pill">{s}</span>)}
              </div>
            </div>
          </div>
        </div>
      </main>

      <main className={`workspace ${stage === STAGES.IDLE ? 'hidden' : ''}`}>
        <section className="stage-area">
          {previewUrl && previewPending && (
            // Requests the page through the sandbox so the framework compiles
            // it, while the launch screen stays up.
            <iframe title="Warming up" src={previewUrl} className="warmup-frame" aria-hidden="true" tabIndex={-1} />
          )}
          {previewUrl && !previewPending ? (
            <div className="browser">
              <div className="browser-bar">
                <span className="browser-dots"><i /><i /><i /></span>
                <button className="icon-btn" type="button" title="Reload" onClick={() => setPreviewKey((k) => k + 1)}>
                  <ReloadIcon />
                </button>
                <div className="address">
                  <LockIcon />
                  <span>{displayUrl(previewUrl, repoName)}</span>
                </div>
                {!previewUrl.startsWith('blob:') && (
                  <a className="icon-btn" href={previewUrl} target="_blank" rel="noreferrer" title="Open in a new tab">
                    <ExternalIcon />
                  </a>
                )}
              </div>
              <iframe
                key={`${previewUrl}#${previewKey}`}
                title="Preview"
                src={previewUrl}
                className="preview-frame"
                {...(executionMode === 'native' || executionMode === 'docker' ? { credentialless: '' } : {})}
                allow="accelerometer; camera; encrypted-media; geolocation; gyroscope; microphone; clipboard-read; clipboard-write; cross-origin-isolated"
              />
            </div>
          ) : stage === STAGES.ERROR ? (
            <ErrorPanel
              message={errorMsg}
              kind={errorKind}
              onRetry={() => handleFetchRepo()}
              onConnect={async (url) => {
                setEngineUrl(url);
                const status = await refreshBackendStatus(0);
                if (status.serverOnline) handleFetchRepo();
                else writeLog(`\n\x1b[33mNo engine answered at ${url} — is it running?\x1b[0m\n`);
              }}
              onBack={handleStop}
            />
          ) : isConsole ? (
            <ConsolePanel
              done={programDone}
              figures={figures}
              inputEnabled={inputEnabled}
              awaitingInput={awaitingInput}
              onFocusTerminal={() => {
                setIsTerminalOpen(true);
                termInstance.current?.focus();
              }}
            />
          ) : (
            <LaunchPanel
              repoName={repoName}
              currentStep={currentStep}
              progress={progress}
              activity={activity}
              elapsed={elapsed}
              paused={stage === STAGES.NEEDS_ENV}
            />
          )}

          {stage === STAGES.NEEDS_ENV && (
            <div className="modal-overlay">
              <form
                className="modal"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRunWithEnv();
                }}
              >
                <h3>This app needs a few secrets</h3>
                <p className="modal-hint">They're only sent to where the app runs. Leave blank to skip.</p>
                {detectedKeys.map((key) => (
                  <label className="env-row" key={key}>
                    <span>{key}</span>
                    <input
                      type="password"
                      value={envValues[key] || ''}
                      onChange={(e) => setEnvValues((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder="value"
                    />
                  </label>
                ))}
                <button className="btn-go small" type="submit">Continue <ArrowIcon /></button>
              </form>
            </div>
          )}
        </section>

        <section className={`terminal-panel ${isTerminalOpen ? 'open' : 'closed'}`}>
          <div className="terminal-header" onClick={() => setIsTerminalOpen(!isTerminalOpen)}>
            <div className="terminal-title">
              <TerminalIcon /> Terminal
              {inputEnabled && (
                <span className={`input-hint ${awaitingInput ? 'waiting' : ''}`}>
                  {awaitingInput ? 'waiting for input — type and press Enter' : 'input enabled'}
                </span>
              )}
            </div>
            <div className="terminal-actions">
              <button
                className="icon-btn"
                type="button"
                title="Copy log"
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard?.writeText(fullLog.text).catch(() => {});
                }}
              >
                <CopyIcon />
              </button>
              <button
                className="icon-btn"
                type="button"
                title="Clear"
                onClick={(e) => {
                  e.stopPropagation();
                  termInstance.current?.clear();
                }}
              >
                <ClearIcon />
              </button>
              <button className="icon-btn" type="button" title={isTerminalOpen ? 'Collapse' : 'Expand'}>
                <ChevronIcon up={!isTerminalOpen} />
              </button>
            </div>
          </div>
          <div className="terminal-body" onClick={() => termInstance.current?.focus()}>
            <div className="terminal-wrap" ref={termRef} />
          </div>
        </section>
      </main>

      {stage === STAGES.IDLE && (
        <footer className="app-footer">
          <span>GitLive</span>
          <span className="footer-sep">·</span>
          <a className="footer-link" href="https://github.com/Amarnath10i/repo-runner" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </footer>
      )}
    </div>
  );
}

/** A readable address for the preview bar. */
function displayUrl(url, repoName) {
  if (url.startsWith('blob:')) return `${repoName} · running in your browser`;
  try {
    const u = new URL(url);
    if (/webcontainer/.test(u.host)) return `${repoName} · in-browser server`;
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

// ─── Panels ───

function LaunchPanel({ repoName, currentStep, progress, activity, elapsed, paused }) {
  const activeIdx = STEPS.findIndex((s) => s.key === currentStep);
  return (
    <div className="launch">
      <div className="launch-eyebrow">{paused ? 'Waiting for you' : 'Going live'}</div>
      <h1 className="launch-title" title={repoName}>{repoName || 'Preparing…'}</h1>

      <ol className="steps">
        {STEPS.map((step, i) => {
          const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'todo';
          return (
            <li key={step.key} className={`step ${state}`}>
              <span className="step-marker">{state === 'done' ? <CheckIcon /> : i + 1}</span>
              <span className="step-label">{step.label}</span>
            </li>
          );
        })}
      </ol>

      <div className="launch-progress">
        <div className="bar"><div className="bar-fill" style={{ width: `${progress}%` }} /></div>
        <div className="launch-meta">
          <span>{Math.round(progress)}%</span>
          <span>{formatElapsed(elapsed)}</span>
        </div>
      </div>

      <div className="activity" title={activity}>
        <span className="activity-dot" />
        <span className="activity-text">{activity || 'Starting…'}</span>
      </div>
    </div>
  );
}

function ConsolePanel({ done, figures, inputEnabled, awaitingInput, onFocusTerminal }) {
  const finished = done !== null && done !== undefined;
  return (
    <div className={`console ${figures.length ? 'with-figures' : ''}`}>
      <div className="console-card">
        <div className={`console-icon ${finished ? (done === 0 ? 'ok' : 'bad') : 'live'}`}>
          {finished ? (done === 0 ? <CheckIcon /> : '!') : <TerminalIcon />}
        </div>
        <h2>
          {finished
            ? done === 0 ? 'Program finished' : `Program exited with code ${done}`
            : awaitingInput ? 'Waiting for your input' : 'Running in the terminal'}
        </h2>
        <p>
          {finished
            ? 'This project has no web interface — its output is in the terminal below.'
            : inputEnabled
              ? 'This is a console program. Its output streams to the terminal, and you can type there to answer prompts.'
              : 'This is a console program — its output streams to the terminal below.'}
        </p>
        {inputEnabled && !finished && (
          <button className="btn-ghost" type="button" onClick={onFocusTerminal}>
            <TerminalIcon /> Type in the terminal
          </button>
        )}
      </div>
      {figures.length > 0 && (
        <div className="figures">
          {figures.map((src, i) => (
            <figure key={i}>
              <img src={src} alt={`Figure ${i + 1}`} />
              <figcaption>Figure {i + 1}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorPanel({ message, kind, onRetry, onConnect, onBack }) {
  const [engineUrl, setEngineUrlInput] = useState(savedEngineUrl() || 'http://localhost:3001');
  if (kind === 'needs-engine') {
    return (
      <div className="error-panel">
        <div className="error-icon engine"><ServerIcon /></div>
        <h2>This repo needs the runner engine</h2>
        <p className="error-message">{message}</p>
        <div className="engine-help">
          <p>
            In your browser, GitLive runs <strong>Node.js, Python scripts, Streamlit, notebooks</strong> and{' '}
            <strong>static sites</strong>. Everything else — Java, Go, Rust, C/C++, PHP, Ruby, .NET, and Python
            web servers (Flask, Django, FastAPI, Gradio) — runs on the engine, which installs each language automatically.
          </p>
          <p className="engine-cmd-label">Start the engine on your computer (or use a deployed one), then connect:</p>
          <code className="engine-cmd">git clone https://github.com/Amarnath10i/repo-runner && cd repo-runner/backend && npm install && npm start</code>
          <input
            className="engine-url"
            value={engineUrl}
            onChange={(e) => setEngineUrlInput(e.target.value.trim())}
            spellCheck="false"
            aria-label="Engine URL"
          />
        </div>
        <div className="error-actions">
          <button className="btn-go small" type="button" onClick={() => onConnect(engineUrl.replace(/\/+$/, ''))}>Connect engine</button>
          <button className="btn-ghost" type="button" onClick={onBack}>Back</button>
        </div>
      </div>
    );
  }
  return (
    <div className="error-panel">
      <div className="error-icon">!</div>
      <h2>Couldn't run this repo</h2>
      <p className="error-message">{message}</p>
      <p className="error-hint">The terminal below has the full log.</p>
      <div className="error-actions">
        <button className="btn-go small" type="button" onClick={onRetry}>Try again</button>
        <button className="btn-ghost" type="button" onClick={onBack}>Back</button>
      </div>
    </div>
  );
}

// ─── Hooks ───

/** Progress that creeps within the current step's range. */
function useStepProgress(step, stage) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!step) {
      setProgress(stage === STAGES.ERROR ? (p) => p : 0);
      return undefined;
    }
    const [from, to] = STEP_PROGRESS[step];
    setProgress((p) => Math.max(p, from));
    if (from === to) return undefined;
    const id = setInterval(() => {
      setProgress((p) => (p < to - 0.5 ? p + (to - p) * 0.03 : p));
    }, 200);
    return () => clearInterval(id);
  }, [step, stage]);
  return progress;
}

/** Seconds since the current run started. */
function useElapsed(stage) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(null);
  useEffect(() => {
    if (stage === STAGES.IDLE) {
      startRef.current = null;
      setElapsed(0);
      return undefined;
    }
    if (stage === STAGES.FETCHING || !startRef.current) startRef.current = Date.now();
    if (stage === STAGES.READY || stage === STAGES.ERROR) return undefined;
    const id = setInterval(() => setElapsed((Date.now() - startRef.current) / 1000), 500);
    return () => clearInterval(id);
  }, [stage]);
  return elapsed;
}

// ─── Icons ───

function GithubIcon({ size = 24, className = '' }) {
  return (
    <svg className={`github-icon ${className}`} viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

const svgProps = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
const ArrowIcon = () => <svg {...svgProps}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
const StopIcon = () => <svg {...svgProps} width={14} height={14}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
const ReloadIcon = () => <svg {...svgProps}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>;
const ExternalIcon = () => <svg {...svgProps}><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>;
const LockIcon = () => <svg {...svgProps} width={12} height={12}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
const CheckIcon = () => <svg {...svgProps} width={14} height={14} strokeWidth={3}><path d="M5 12l5 5L20 7" /></svg>;
const TerminalIcon = () => <svg {...svgProps} width={14} height={14}><path d="M4 17l6-5-6-5M12 19h8" /></svg>;
const KeyIcon = () => <svg {...svgProps} width={13} height={13}><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M15 8l2 2" /></svg>;
const CopyIcon = () => <svg {...svgProps} width={14} height={14}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
const ClearIcon = () => <svg {...svgProps} width={14} height={14}><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>;
const ServerIcon = () => <svg {...svgProps} width={26} height={26}><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>;
const ChevronIcon = ({ up }) => <svg {...svgProps} width={14} height={14}>{up ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}</svg>;
