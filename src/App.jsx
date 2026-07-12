import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { parseGithubUrl, getDefaultBranch, buildFileSystemTree, detectEnvVars } from './lib/github.js';
import { runRepo } from './lib/runner.js';
import { analyzeRepo } from './lib/ollama.js';
import { analyzeTreeLocally } from './lib/heuristics.js';
import {
  analyzeRepoBackend,
  runRepoBackend,
  runRepoNative,
  stopRepoBackend,
  connectWebSocket,
  getPreviewUrl,
  checkBackendStatus,
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

const PIPELINE_STEPS = [
  { key: 'fetch', label: 'Fetch', icon: '📥' },
  { key: 'analyze', label: 'Detect', icon: '🔍' },
  { key: 'build', label: 'Build', icon: '🔨' },
  { key: 'run', label: 'Run', icon: '▶' },
  { key: 'live', label: 'Live', icon: '🟢' },
];

const SUPPORTED_RUNTIMES = [
  { icon: '⬢', label: 'Node.js', color: '#68a063' },
  { icon: '🐍', label: 'Python', color: '#3776ab' },
  { icon: '🎈', label: 'Streamlit', color: '#ff4b4b' },
  { icon: '⚡', label: 'FastAPI', color: '#009688' },
  { icon: '🔵', label: 'Go', color: '#00add8' },
  { icon: '🦀', label: 'Rust', color: '#dea584' },
  { icon: '💎', label: 'Ruby', color: '#cc342d' },
  { icon: '🐘', label: 'PHP', color: '#777bb4' },
  { icon: '☕', label: 'Java', color: '#f89820' },
  { icon: '🟣', label: '.NET', color: '#512bd4' },
  { icon: '🐳', label: 'Docker', color: '#2496ed' },
];

function stageToStep(stage) {
  switch (stage) {
    case STAGES.FETCHING: return 'fetch';
    case STAGES.ANALYZING: return 'analyze';
    case STAGES.BUILDING: return 'build';
    case STAGES.RUNNING: return 'run';
    case STAGES.READY: return 'live';
    default: return null;
  }
}

function stepIndex(key) {
  return PIPELINE_STEPS.findIndex((s) => s.key === key);
}

export default function App() {
  const [repoUrl, setRepoUrl] = useState('');
  const [token, setToken] = useState('');
  const [ollamaEndpoint, setOllamaEndpoint] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('llama3.1');
  const [useOllama, setUseOllama] = useState(false);
  const [stage, setStage] = useState(STAGES.IDLE);
  const [errorMsg, setErrorMsg] = useState('');
  const [detectedKeys, setDetectedKeys] = useState([]);
  const [envValues, setEnvValues] = useState({});
  const [previewUrl, setPreviewUrl] = useState('');
  const [runtimeInfo, setRuntimeInfo] = useState(null);
  const [serverOnline, setServerOnline] = useState(false);
  const [dockerOnline, setDockerOnline] = useState(false);
  const [nativeRuntimes, setNativeRuntimes] = useState({});
  const [executionMode, setExecutionMode] = useState(null); // 'webcontainer' | 'docker' | 'native'

  const treeRef = useRef(null);
  const analysisRef = useRef(null);
  const termRef = useRef(null);
  const termInstance = useRef(null);
  const fitAddon = useRef(null);
  const sessionRef = useRef(null);
  const wsRef = useRef(null);

  // Check backend availability on mount (with retries for auto-start race condition)
  const refreshBackendStatus = useCallback(async (retries = 1) => {
    const status = await checkBackendStatus({ maxRetries: retries, retryDelayMs: 2000 });
    setServerOnline(status.serverOnline);
    setDockerOnline(status.dockerOnline);
    setNativeRuntimes(status.nativeRuntimes || {});
    return status;
  }, []);

  useEffect(() => {
    // On first load, retry a few times because the Vite plugin may still be starting the backend
    refreshBackendStatus(3);
    const interval = setInterval(() => refreshBackendStatus(0), 10000);
    return () => clearInterval(interval);
  }, [refreshBackendStatus]);

  // Terminal setup
  useEffect(() => {
    const term = new Terminal({
      convertEol: true,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: '#0a0c14',
        foreground: '#c8cfe0',
        cursor: '#6c8cff',
        cursorAccent: '#0a0c14',
        selectionBackground: 'rgba(108, 140, 255, 0.25)',
        black: '#1a1e2e',
        brightBlack: '#3a3f54',
        red: '#f87171',
        brightRed: '#fca5a5',
        green: '#34d399',
        brightGreen: '#6ee7b7',
        yellow: '#fbbf24',
        brightYellow: '#fcd34d',
        blue: '#6c8cff',
        brightBlue: '#93b4ff',
        magenta: '#a78bfa',
        brightMagenta: '#c4b5fd',
        cyan: '#22d3ee',
        brightCyan: '#67e8f9',
        white: '#e8ecf4',
        brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    fit.fit();
    termInstance.current = term;
    fitAddon.current = fit;

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      term.dispose();
    };
  }, []);

  const writeLog = useCallback((text) => {
    termInstance.current?.write(text.replace(/\n/g, '\r\n'));
  }, []);

  // ─── Main Flow ───

  async function handleFetchRepo(e) {
    e.preventDefault();
    setErrorMsg('');
    setRuntimeInfo(null);
    setPreviewUrl('');
    setExecutionMode(null);
    analysisRef.current = null;
    sessionRef.current = null;
    termInstance.current?.clear();
    setStage(STAGES.FETCHING);

    try {
      const { owner, repo, branch: urlBranch } = parseGithubUrl(repoUrl);
      writeLog(`\x1b[1;36m▸ Resolving ${owner}/${repo}...\x1b[0m\n`);
      const branch = urlBranch || (await getDefaultBranch(owner, repo, token));
      writeLog(`  Branch: \x1b[33m${branch}\x1b[0m\n`);

      // Fetch the tree to analyze
      writeLog(`\x1b[1;36m▸ Fetching repository files...\x1b[0m\n`);
      const tree = await buildFileSystemTree({
        owner,
        repo,
        branch,
        token,
        onProgress: (msg) => writeLog(`  ${msg}\n`),
      });
      treeRef.current = tree;

      // ── Analysis phase ──
      setStage(STAGES.ANALYZING);

      let analysis = null;

      // Try Ollama first if enabled
      if (useOllama) {
        writeLog(`\n\x1b[1;35m▸ Asking Ollama to analyze the repo...\x1b[0m\n`);
        const ollamaResult = await analyzeRepo({
          tree,
          endpoint: ollamaEndpoint,
          model: ollamaModel,
          onProgress: (msg) => writeLog(msg),
        });

        if (ollamaResult.ok) {
          analysis = ollamaResult;
          writeLog(`\n  Runtime: \x1b[33m${analysis.runtime}\x1b[0m\n`);
          writeLog(`  Can run in browser: \x1b[33m${analysis.canRunInBrowserSandbox}\x1b[0m\n`);
          if (analysis.reasoning) writeLog(`  Reasoning: ${analysis.reasoning}\n`);
        } else {
          writeLog(`  Ollama unavailable: ${ollamaResult.reason}\n`);
        }
      }

      // Fallback to local heuristic
      if (!analysis) {
        analysis = analyzeTreeLocally(tree);
        writeLog(`\n\x1b[1;35m▸ Detected: ${analysis.runtime} project\x1b[0m\n`);
        if (analysis.reasoning) writeLog(`  ${analysis.reasoning}\n`);
      }

      analysisRef.current = analysis;

      // ── Decide execution mode ──
      if (analysis.canRunInBrowserSandbox) {
        // Node.js project — run in WebContainers
        setExecutionMode('webcontainer');
        setRuntimeInfo({
          id: 'node',
          label: 'Node.js',
          icon: '⬢',
          color: '#68a063',
        });
        writeLog(`\n\x1b[1;32m✓ This is a Node.js project — running in-browser via WebContainers\x1b[0m\n`);
      } else {
        // Non-Node project — needs backend server
        const currentStatus = await refreshBackendStatus(0);

        if (!currentStatus.serverOnline) {
          setErrorMsg(
            `This is a ${analysis.runtime === 'unknown' ? '' : analysis.runtime + ' '}project. ` +
            'The backend server is not running. It should auto-start with the dev server. ' +
            'Try restarting with: npm run dev'
          );
          setStage(STAGES.ERROR);
          writeLog(`\n\x1b[1;31m✗ Backend server is not available.\x1b[0m\n`);
          return;
        }

        // Analyze on backend (clone + detect)
        writeLog(`\n\x1b[1;33m▸ Cloning repository on backend...\x1b[0m\n`);
        const backendAnalysis = await analyzeRepoBackend({ repoUrl, token });
        sessionRef.current = backendAnalysis.sessionId;
        setRuntimeInfo(backendAnalysis.runtime);
        writeLog(`\x1b[1;32m✓ Detected: ${backendAnalysis.runtime.icon} ${backendAnalysis.runtime.label}\x1b[0m\n`);

        // Check for env vars
        const frontendKeys = detectEnvVars(tree);
        const allKeys = Array.from(new Set([
          ...frontendKeys,
          ...(backendAnalysis.envVars || []),
          ...(analysis.envVarsMentioned || []),
        ]));

        // Decide: native or Docker?
        const canNative = backendAnalysis.nativeAvailable;
        const canDocker = currentStatus.dockerOnline;

        if (canNative) {
          // Prefer native — no Docker needed!
          setExecutionMode('native');
          writeLog(`\n\x1b[1;32m✓ ${backendAnalysis.runtime.label} is installed locally — running natively (no Docker needed)\x1b[0m\n`);
        } else if (canDocker) {
          setExecutionMode('docker');
          writeLog(`\n\x1b[1;33m▸ Running via Docker sandbox...\x1b[0m\n`);
        } else {
          // Neither native nor Docker available — use the backend's detected
          // runtime label (not the coarse frontend heuristic, which is often
          // "unknown") so the message is accurate.
          setErrorMsg(`docker_offline:${backendAnalysis.runtime.label}`);
          setStage(STAGES.ERROR);
          writeLog(`\n\x1b[1;33m⚠ ${backendAnalysis.runtime.label} is not installed locally and Docker is offline.\x1b[0m\n`);
          return;
        }

        if (allKeys.length > 0) {
          setDetectedKeys(allKeys);
          setEnvValues(Object.fromEntries(allKeys.map((k) => [k, ''])));
          setStage(STAGES.NEEDS_ENV);
          writeLog(`\n\x1b[1;33m⚠ Detected ${allKeys.length} env var(s) — fill them in below, then run.\x1b[0m\n`);
          return;
        }

        // No env vars — run directly
        if (canNative) {
          await startNativeRun(backendAnalysis.sessionId, {});
        } else {
          await startDockerRun(backendAnalysis.sessionId, {});
        }
        return;
      }

      // ── Handle env vars for WebContainer path ──
      const keys = detectEnvVars(tree);
      const mentionedByLLM = analysis?.envVarsMentioned ?? [];
      const allKeys = Array.from(new Set([...keys, ...mentionedByLLM]));

      if (allKeys.length > 0) {
        setDetectedKeys(allKeys);
        setEnvValues(Object.fromEntries(allKeys.map((k) => [k, ''])));
        setStage(STAGES.NEEDS_ENV);
        writeLog(`\n\x1b[1;33m⚠ Detected ${allKeys.length} env var(s) — fill them in below, then run.\x1b[0m\n`);
      } else {
        await startWebContainerRun(tree, {});
      }
    } catch (err) {
      setErrorMsg(err.message);
      setStage(STAGES.ERROR);
      writeLog(`\n\x1b[1;31m✗ Error: ${err.message}\x1b[0m\n`);
    }
  }

  // ─── WebContainer execution (Node.js) ───

  async function startWebContainerRun(tree, envVars) {
    setStage(STAGES.RUNNING);
    writeLog(`\n\x1b[1;36m▸ Booting WebContainer sandbox...\x1b[0m\n`);
    try {
      await runRepo({
        tree,
        envVars,
        analysis: analysisRef.current,
        onOutput: writeLog,
        onServerReady: (url) => {
          setPreviewUrl(url);
          setStage(STAGES.READY);
          writeLog(`\n\x1b[1;32m✓ App is live at ${url}\x1b[0m\n`);
        },
      });
    } catch (err) {
      setErrorMsg(err.message);
      setStage(STAGES.ERROR);
      writeLog(`\n\x1b[1;31m✗ Error: ${err.message}\x1b[0m\n`);
    }
  }

  // ─── Docker execution ───

  async function startDockerRun(sessionId, envVars) {
    setStage(STAGES.BUILDING);
    writeLog(`\n\x1b[1;36m▸ Building Docker sandbox...\x1b[0m\n`);

    const wsConnection = connectWebSocket({
      sessionId,
      onOutput: writeLog,
      onStage: (data) => {
        if (data.stage === 'ready') {
          setStage(STAGES.READY);
        } else if (data.stage === 'building') {
          setStage(STAGES.BUILDING);
        }
        writeLog(`\x1b[1;35m[${data.stage}]\x1b[0m ${data.message}\n`);
      },
      onServerReady: (url) => {
        setPreviewUrl(getPreviewUrl(sessionId));
        setStage(STAGES.READY);
        writeLog(`\n\x1b[1;32m✓ App is live! Preview available.\x1b[0m\n`);
      },
      onError: (msg) => {
        setErrorMsg(msg);
        setStage(STAGES.ERROR);
        writeLog(`\n\x1b[1;31m✗ ${msg}\x1b[0m\n`);
      },
    });
    wsRef.current = wsConnection;

    try {
      await runRepoBackend({ sessionId, envVars });
    } catch (err) {
      setErrorMsg(err.message);
      setStage(STAGES.ERROR);
      writeLog(`\n\x1b[1;31m✗ ${err.message}\x1b[0m\n`);
    }
  }

  // ─── Native execution (no Docker) ───

  async function startNativeRun(sessionId, envVars) {
    setStage(STAGES.BUILDING);
    writeLog(`\n\x1b[1;36m▸ Setting up native environment...\x1b[0m\n`);

    const wsConnection = connectWebSocket({
      sessionId,
      onOutput: writeLog,
      onStage: (data) => {
        if (data.stage === 'ready') {
          setStage(STAGES.READY);
        } else if (data.stage === 'building') {
          setStage(STAGES.BUILDING);
        }
        writeLog(`\x1b[1;35m[${data.stage}]\x1b[0m ${data.message}\n`);
      },
      onServerReady: (url) => {
        setPreviewUrl(url);
        setStage(STAGES.READY);
        writeLog(`\n\x1b[1;32m✓ App is live! Preview available.\x1b[0m\n`);
      },
      onError: (msg) => {
        setErrorMsg(msg);
        setStage(STAGES.ERROR);
        writeLog(`\n\x1b[1;31m✗ ${msg}\x1b[0m\n`);
      },
    });
    wsRef.current = wsConnection;

    try {
      await runRepoNative({ sessionId, envVars });
    } catch (err) {
      setErrorMsg(err.message);
      setStage(STAGES.ERROR);
      writeLog(`\n\x1b[1;31m✗ ${err.message}\x1b[0m\n`);
    }
  }

  // ─── Env vars submit ───

  function handleRunWithEnv() {
    if (executionMode === 'native' && sessionRef.current) {
      startNativeRun(sessionRef.current, envValues);
    } else if (executionMode === 'docker' && sessionRef.current) {
      startDockerRun(sessionRef.current, envValues);
    } else {
      startWebContainerRun(treeRef.current, envValues);
    }
  }

  // ─── Stop ───

  async function handleStop() {
    if (sessionRef.current) {
      writeLog(`\n\x1b[1;33m▸ Stopping container...\x1b[0m\n`);
      await stopRepoBackend(sessionRef.current);
      wsRef.current?.close();
    }
    setStage(STAGES.IDLE);
    setPreviewUrl('');
    setRuntimeInfo(null);
    setExecutionMode(null);
  }

  const isBusy = [STAGES.FETCHING, STAGES.ANALYZING, STAGES.BUILDING, STAGES.RUNNING].includes(stage);
  const currentStep = stageToStep(stage);
  const currentStepIdx = currentStep ? stepIndex(currentStep) : -1;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">⌁</div>
          <span className="brand-name">Repo Runner</span>
        </div>
        <span className="brand-tag">paste a GitHub URL → instant live demo</span>

        <div className="topbar-right">
          <div className={`backend-badge ${dockerOnline ? 'online' : serverOnline ? 'warning' : 'offline'}`}>
            <span className="badge-dot" />
            {dockerOnline ? 'Docker Online' : serverOnline ? 'Docker Offline' : 'Server Offline'}
          </div>
        </div>
      </header>

      <main className="layout">
        {/* ── Control Pane ── */}
        <section className="control-pane">
          {/* Pipeline indicator */}
          <div className="pipeline">
            {PIPELINE_STEPS.map((step, i) => {
              const idx = stepIndex(step.key);
              let cls = '';
              if (stage === STAGES.ERROR && currentStepIdx >= 0 && idx === currentStepIdx) cls = 'error';
              else if (stage === STAGES.READY && idx <= stepIndex('live')) cls = 'done';
              else if (currentStepIdx >= 0 && idx < currentStepIdx) cls = 'done';
              else if (currentStepIdx >= 0 && idx === currentStepIdx) cls = 'active';

              return (
                <span key={step.key} style={{ display: 'contents' }}>
                  {i > 0 && (
                    <span
                      className={`pipeline-connector${
                        cls === 'done' ? ' done' : cls === 'active' ? ' active' : ''
                      }`}
                    />
                  )}
                  <span className={`pipeline-stage ${cls}`}>
                    <span className="stage-icon">{step.icon}</span>
                    {step.label}
                  </span>
                </span>
              );
            })}
          </div>

          {/* Runtime badge */}
          {runtimeInfo && (
            <div
              className="runtime-badge"
              style={{
                color: runtimeInfo.color,
                borderColor: runtimeInfo.color + '44',
                background: runtimeInfo.color + '12',
              }}
            >
              <span>{runtimeInfo.icon}</span>
              {runtimeInfo.label}
              {executionMode && (
                <span style={{ opacity: 0.6, fontSize: '0.65rem', marginLeft: '0.25rem' }}>
                  via {executionMode === 'webcontainer' ? 'WebContainer' : executionMode === 'native' ? 'Native' : 'Docker'}
                </span>
              )}
            </div>
          )}

          {/* Progress bar */}
          {isBusy && (
            <div className="progress-bar">
              <div className="progress-bar-fill" />
            </div>
          )}

          {/* Repo URL form */}
          <form onSubmit={handleFetchRepo} className="repo-form">
            <label className="form-label" htmlFor="repo-url">
              GitHub Repository URL
            </label>
            <div className="input-group">
              <input
                id="repo-url"
                type="url"
                placeholder="https://github.com/owner/repo"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                disabled={isBusy}
                required
              />
            </div>

            {/* GitHub Token */}
            <details className="advanced">
              <summary>GitHub Token (optional)</summary>
              <div className="advanced-content">
                <p className="hint">
                  Raises GitHub API rate limit from 60 to 5,000 req/hour. Required for private repos.
                  Stored in memory only.
                </p>
                <input
                  type="password"
                  placeholder="ghp_..."
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={isBusy}
                />
              </div>
            </details>

            {/* Ollama */}
            <details className="advanced">
              <summary>Local Ollama (smart analysis)</summary>
              <div className="advanced-content">
                <p className="hint">
                  Uses a local LLM to read the README and figure out the real install/start
                  commands instead of guessing.
                </p>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={useOllama}
                    onChange={(e) => setUseOllama(e.target.checked)}
                    disabled={isBusy}
                  />
                  Enable Ollama analysis
                </label>
                {useOllama && (
                  <>
                    <label className="form-label" htmlFor="ollama-endpoint">Endpoint</label>
                    <input
                      id="ollama-endpoint"
                      type="text"
                      value={ollamaEndpoint}
                      onChange={(e) => setOllamaEndpoint(e.target.value)}
                      disabled={isBusy}
                    />
                    <label className="form-label" htmlFor="ollama-model">Model</label>
                    <input
                      id="ollama-model"
                      type="text"
                      value={ollamaModel}
                      onChange={(e) => setOllamaModel(e.target.value)}
                      disabled={isBusy}
                    />
                    <p className="hint">
                      Requires: <code>OLLAMA_ORIGINS=* ollama serve</code>
                    </p>
                  </>
                )}
              </div>
            </details>

            <div className="btn-row">
              <button className="btn-primary" type="submit" disabled={isBusy || !repoUrl}>
                {isBusy ? (
                  <>
                    <span className="spinner" /> Working…
                  </>
                ) : (
                  'Fetch & Run'
                )}
              </button>
              {(stage === STAGES.READY || stage === STAGES.RUNNING || stage === STAGES.BUILDING) && (
                <button className="btn-stop" type="button" onClick={handleStop}>
                  Stop
                </button>
              )}
            </div>
          </form>

          {/* Env vars form */}
          {stage === STAGES.NEEDS_ENV && (
            <div className="env-form">
              <h3>🔑 Environment Variables Required</h3>
              <p className="hint">
                Detected from .env.example. Values stay in memory only — never sent to external
                servers.
              </p>
              {detectedKeys.map((key) => (
                <div className="env-row" key={key}>
                  <label htmlFor={`env-${key}`}>{key}</label>
                  <input
                    id={`env-${key}`}
                    type="password"
                    value={envValues[key] || ''}
                    onChange={(e) =>
                      setEnvValues((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    placeholder="Enter value..."
                  />
                </div>
              ))}
              <button className="btn-primary" onClick={handleRunWithEnv}>
                Run with these values
              </button>
            </div>
          )}

          {/* Error — show runtime unavailable banner or generic error */}
          {stage === STAGES.ERROR && errorMsg.startsWith('docker_offline:') ? (() => {
            const runtimeName = errorMsg.split(':')[1];
            const isUnknown = !runtimeName || /^unknown$/i.test(runtimeName);
            return (
              <div className="docker-banner">
                <div className="docker-banner-icon">🐳</div>
                <div className="docker-banner-content">
                  {isUnknown ? (
                    <>
                      <h4>Couldn't detect how to run this repo</h4>
                      <p>
                        No recognized runtime (package.json, requirements.txt,
                        go.mod, Dockerfile, etc.) was found. To run it anyway:
                      </p>
                      <ul className="docker-banner-options">
                        <li>Start <strong>Docker Desktop</strong> so it can build from a Dockerfile/compose file</li>
                        <li>Or double-check the repo URL points at a runnable app</li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <h4>{runtimeName} Runtime Not Found</h4>
                      <p>
                        This is a <strong>{runtimeName}</strong> project. To run it, either:
                      </p>
                      <ul className="docker-banner-options">
                        <li>Install <strong>{runtimeName}</strong> on your machine (recommended — fastest)</li>
                        <li>Or start <strong>Docker Desktop</strong> to run in a sandbox</li>
                      </ul>
                    </>
                  )}
                  <button
                    className="btn-check-again"
                    onClick={async () => {
                      const status = await refreshBackendStatus(0);
                      if (status.dockerOnline) {
                        setStage(STAGES.IDLE);
                        setErrorMsg('');
                      }
                    }}
                  >
                    <span className="refresh-icon">↻</span> Check Again
                  </button>
                </div>
              </div>
            );
          })() : stage === STAGES.ERROR ? (
            <div className="error-box">❌ {errorMsg}</div>
          ) : null}

          {/* How it works — idle state */}
          {stage === STAGES.IDLE && (
            <div className="how-it-works">
              <h4>How it works</h4>
              <div className="how-step">
                <span className="how-step-num">1</span>
                <span>Paste any GitHub repo URL and click "Fetch & Run"</span>
              </div>
              <div className="how-step">
                <span className="how-step-num">2</span>
                <span>We clone and auto-detect the runtime & dependencies</span>
              </div>
              <div className="how-step">
                <span className="how-step-num">3</span>
                <span>Node.js runs in-browser. Python, Go, Rust, etc. run in Docker</span>
              </div>
              <div className="how-step">
                <span className="how-step-num">4</span>
                <span>See the live preview instantly — no setup needed</span>
              </div>
              <div className="runtimes-grid">
                {SUPPORTED_RUNTIMES.map((r) => (
                  <span key={r.label} className="runtime-chip">
                    {r.icon} {r.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Status */}
          <div className="status-line">
            <StatusDot stage={stage} />
            <span>{statusLabel(stage)}</span>
          </div>
        </section>

        {/* ── Terminal Pane ── */}
        <section className="output-pane">
          <div className="pane-header">
            <span className="pane-header-icon">⌨</span>
            Terminal
          </div>
          <div className="terminal-wrap" ref={termRef} />
        </section>

        {/* ── Preview Pane ── */}
        <section className={`preview-pane${previewUrl ? ' live' : ''}`}>
          <div className="pane-header">
            <span className="pane-header-icon">👁</span>
            Live Preview
            {previewUrl && (
              <a className="url-chip" href={previewUrl} target="_blank" rel="noreferrer">
                {previewUrl} ↗
              </a>
            )}
          </div>
          {previewUrl ? (
            <iframe
              title="preview"
              src={previewUrl}
              className="preview-frame"
              // `credentialless` lets this cross-origin-isolated page (COOP/COEP,
              // needed for WebContainers) embed a cross-origin localhost app that
              // doesn't send COEP itself. Without it the browser blocks the frame.
              credentialless=""
              ref={(el) => el && el.setAttribute('credentialless', '')}
              allow="accelerometer; camera; encrypted-media; geolocation; gyroscope; microphone; clipboard-read; clipboard-write"
            />
          ) : (
            <div className="preview-empty">
              <div className="preview-empty-icon">🌐</div>
              <div className="preview-empty-text">
                The live preview will appear here once your app starts running.
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function statusLabel(stage) {
  switch (stage) {
    case STAGES.IDLE: return 'Ready — paste a repo URL to begin';
    case STAGES.FETCHING: return 'Cloning repository from GitHub…';
    case STAGES.ANALYZING: return 'Detecting runtime & dependencies…';
    case STAGES.NEEDS_ENV: return 'Waiting for environment variables';
    case STAGES.BUILDING: return 'Building Docker sandbox…';
    case STAGES.RUNNING: return 'Installing dependencies & starting…';
    case STAGES.READY: return 'App is running';
    case STAGES.ERROR: return 'Something went wrong';
    default: return '';
  }
}

function StatusDot({ stage }) {
  const cls = {
    [STAGES.IDLE]: 'dot-idle',
    [STAGES.FETCHING]: 'dot-busy',
    [STAGES.ANALYZING]: 'dot-busy',
    [STAGES.NEEDS_ENV]: 'dot-busy',
    [STAGES.BUILDING]: 'dot-busy',
    [STAGES.RUNNING]: 'dot-busy',
    [STAGES.READY]: 'dot-ready',
    [STAGES.ERROR]: 'dot-error',
  }[stage] || 'dot-idle';
  return <span className={`status-dot ${cls}`} />;
}
