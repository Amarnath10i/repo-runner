import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { parseGithubUrl, getDefaultBranch, fetchRepoTree, hydrateAllFiles, detectEnvVars } from './lib/github.js';
import { runRepo } from './lib/runner.js';
import { analyzeRepo, checkOllamaAvailable } from './lib/ollama.js';
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
  { key: 'fetch', label: 'Fetch' },
  { key: 'analyze', label: 'Detect' },
  { key: 'build', label: 'Build' },
  { key: 'run', label: 'Run' },
  { key: 'live', label: 'Live' },
];

const SUPPORTED_RUNTIMES = [
  { label: 'Node.js', color: '#68a063' },
  { label: 'Python', color: '#3776ab' },
  { label: 'Streamlit', color: '#ff4b4b' },
  { label: 'FastAPI', color: '#009688' },
  { label: 'Go', color: '#00add8' },
  { label: 'Rust', color: '#dea584' },
  { label: 'Ruby', color: '#cc342d' },
  { label: 'PHP', color: '#777bb4' },
  { label: 'Java', color: '#f89820' },
  { label: '.NET', color: '#512bd4' },
  { label: 'Docker', color: '#2496ed' },
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
  // Pre-fill the GitHub token from a local .env (VITE_GITHUB_TOKEN) so it
  // doesn't have to be entered every time. Still editable in the UI.
  const [token, setToken] = useState(import.meta.env.VITE_GITHUB_TOKEN || '');
  const [ollamaEndpoint] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('llama3.1');
  // Auto-enabled when a local Ollama server is detected (no manual toggle).
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
  const [isTerminalOpen, setIsTerminalOpen] = useState(true);

  const treeRef = useRef(null);
  const blobsRef = useRef(null);
  const repoMetaRef = useRef(null);
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

  // Auto-enable Ollama analysis when a local Ollama server is detected — no UI
  // toggle needed. Falls back silently to the built-in heuristic otherwise.
  useEffect(() => {
    let cancelled = false;
    checkOllamaAvailable(ollamaEndpoint).then(({ available, models }) => {
      if (cancelled || !available) return;
      setUseOllama(true);
      // Prefer the configured model, else the first one the server has.
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
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: '#030508',
        foreground: '#8b95a8',
        cursor: '#5a7aee',
        cursorAccent: '#030508',
        selectionBackground: 'rgba(90, 122, 238, 0.15)',
        black: '#0e1218',
        brightBlack: '#2a3040',
        red: '#c04848',
        brightRed: '#e05252',
        green: '#2bb87a',
        brightGreen: '#4cc98e',
        yellow: '#c89520',
        brightYellow: '#d4a020',
        blue: '#5a7aee',
        brightBlue: '#7a96f0',
        magenta: '#8b72e0',
        brightMagenta: '#a68ef0',
        cyan: '#1ab8d4',
        brightCyan: '#40c8e0',
        white: '#a0a8b8',
        brightWhite: '#c8cdd8',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    
    if (termRef.current) {
      term.open(termRef.current);
      try { fit.fit(); } catch (e) {}
    }
    
    termInstance.current = term;
    fitAddon.current = fit;

    const onResize = () => {
      try { fit.fit(); } catch (e) {}
    };

    let resizeObserver = null;
    if (termRef.current) {
      // Use ResizeObserver so xterm automatically fits when the drawer toggles or un-hides
      resizeObserver = new ResizeObserver(() => {
        window.requestAnimationFrame(() => onResize());
      });
      resizeObserver.observe(termRef.current);
    }

    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (resizeObserver) resizeObserver.disconnect();
      term.dispose();
    };
  }, []);

  const [terminalProgress, setTerminalProgress] = useState(null);

  const writeLog = useCallback((text) => {
    // Parse backend logs to update progress more accurately
    if (text.includes('[setup]')) {
      setTerminalProgress({ percent: 20, eta: '~ 20s' });
    } else if (text.includes('[install]')) {
      setTerminalProgress({ percent: 40, eta: '~ 30s' });
    } else if (text.includes('[build]')) {
      setTerminalProgress({ percent: 60, eta: '~ 15s' });
    } else if (text.includes('[start]')) {
      setTerminalProgress({ percent: 80, eta: '~ 5s' });
    } else if (text.includes('[serve]')) {
      setTerminalProgress({ percent: 85, eta: '~ 2s' });
    } else if (text.includes('[ready]')) {
      setTerminalProgress({ percent: 100, eta: 'Done' });
    }
    termInstance.current?.write(text.replace(/\n/g, '\r\n'));
  }, []);

  useEffect(() => {
    if (stage === STAGES.READY) {
      setIsTerminalOpen(false);
    }
  }, [stage]);

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

      // Fetch just the file list + manifest contents to analyze. Full file
      // contents are only downloaded later if we run in-browser (WebContainer).
      writeLog(`\x1b[1;36m▸ Fetching repository files...\x1b[0m\n`);
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
        writeLog(`\x1b[1;32m✓ Detected: ${backendAnalysis.runtime.label}\x1b[0m\n`);

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
    try {
      // Now that we know it's a Node project, download the full file contents
      // (only the manifests were fetched during analysis).
      if (blobsRef.current && repoMetaRef.current) {
        writeLog(`\n\x1b[1;36m▸ Downloading project files...\x1b[0m\n`);
        await hydrateAllFiles({
          ...repoMetaRef.current,
          tree,
          blobs: blobsRef.current,
          onProgress: (msg) => writeLog(`  ${msg}\n`),
        });
      }
      writeLog(`\n\x1b[1;36m▸ Booting WebContainer sandbox...\x1b[0m\n`);
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
  const { progress: progressPct, eta: progressEta } = useSimulatedProgress(stage, terminalProgress);

  return (
    <div className="app">
      <header className="topbar transparent">
        <div className="brand">
          <svg className="github-icon" viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
          <div className="brand-text">
            <span className="brand-git">GIT</span>
            <span className="brand-live">Live</span>
          </div>
        </div>
        
        <div className="topbar-center">
          {stage !== STAGES.IDLE && currentStepIdx >= 0 && (
            <div className="active-step-only">
              <span className="step-dot active"></span>
              {PIPELINE_STEPS[currentStepIdx].label}
            </div>
          )}
        </div>

        <div className="topbar-right">
          {stage !== STAGES.IDLE && (
            <button className="btn-stop-global" type="button" onClick={handleStop}>
              <span className="stop-icon">■</span> Stop
            </button>
          )}
          <div className={`backend-badge ${dockerOnline ? 'online' : serverOnline ? 'warning' : 'offline'}`}>
            <span className="badge-dot" />
            {dockerOnline ? 'Docker Online' : serverOnline ? 'Docker Offline' : 'Server Offline'}
          </div>
        </div>
      </header>

      <main className={`hero-layout ${stage !== STAGES.IDLE ? 'hidden' : ''}`}>
        <div className="hero-content">
          <form onSubmit={handleFetchRepo} className="hero-form">
            <div className="hero-input-group">
              <input
                id="repo-url"
                type="url"
                placeholder="https://github.com/owner/repository"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                disabled={isBusy}
                required
                className="hero-input"
              />
              <button className="btn-hero-primary" type="submit" disabled={isBusy || !repoUrl}>
                {isBusy ? <span className="spinner" /> : 'Go Live'}
              </button>
            </div>
          </form>
          <p className="hero-tagline">Experience a frictionless</p>
        </div>
      </main>

      <main className={`workspace-layout ${stage === STAGES.IDLE ? 'hidden' : ''}`}>
        
        {/* Main workspace area (Preview takes over) */}
        <div className="workspace-main">
          
          {/* Loading Overlay (Horizontal Pipeline) */}
          {stage !== STAGES.READY && stage !== STAGES.IDLE && (
            <div className="loading-overlay">
              <div className="workspace-status-bar">
                <div className="workspace-status-content">
                  <div className="status-line compact">
                    <StatusDot stage={stage} />
                    <span>{statusLabel(stage)}</span>
                    {isBusy && progressEta && <span className="eta-text">ETA: {progressEta}</span>}
                  </div>
                  
                  {runtimeInfo && (
                    <div className="runtime-badge compact" style={{ color: runtimeInfo.color, borderColor: runtimeInfo.color + '22', background: runtimeInfo.color + '08' }}>
                      {runtimeInfo.label}
                      {executionMode && (
                        <span style={{ opacity: 0.5, fontSize: '0.6rem', marginLeft: '0.15rem' }}>
                          via {executionMode === 'webcontainer' ? 'WebContainer' : executionMode === 'native' ? 'Native' : 'Docker'}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                
                {/* Integrated Progress Bar */}
                {(isBusy || stage === STAGES.NEEDS_ENV) && (
                  <div className="status-progress-track">
                    <div 
                      className={`status-progress-fill ${stage === STAGES.READY ? 'done' : ''}`} 
                      style={{ width: `${progressPct}%` }} 
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {previewUrl ? (
             <iframe
               key={executionMode === 'webcontainer' ? 'wc' : 'ext'}
               title="preview"
               src={previewUrl}
               className="preview-frame full"
               {...(executionMode === 'webcontainer' ? {} : { credentialless: '' })}
               allow="accelerometer; camera; encrypted-media; geolocation; gyroscope; microphone; clipboard-read; clipboard-write"
             />
           ) : (
             <div className="preview-empty full">
               {isBusy && (
                 <div className="building-state">
                   <span className="spinner large" />
                   <div className="building-text">Preparing Sandbox...</div>
                 </div>
               )}
               {stage === STAGES.ERROR && (errorMsg || '').startsWith('docker_offline:') ? (() => {
                  const runtimeName = errorMsg.split(':')[1];
                  const isUnknown = !runtimeName || /^unknown$/i.test(runtimeName);
                  return (
                    <div className="docker-banner">
                      <div className="docker-banner-icon">D</div>
                      <div className="docker-banner-content">
                        {isUnknown ? (
                          <>
                            <h4>Couldn't detect how to run this repo</h4>
                            <p>No recognized runtime was found. Start Docker Desktop so it can build from a Dockerfile.</p>
                          </>
                        ) : (
                          <>
                            <h4>{runtimeName} Runtime Not Found</h4>
                            <p>Install {runtimeName} locally or start Docker Desktop to run in a sandbox.</p>
                          </>
                        )}
                        <button className="btn-check-again" onClick={async () => {
                          const status = await refreshBackendStatus(0);
                          if (status.dockerOnline) {
                            setStage(STAGES.IDLE);
                            setErrorMsg('');
                          }
                        }}>
                          <span className="refresh-icon">↻</span> Check Again
                        </button>
                      </div>
                    </div>
                  );
                })() : stage === STAGES.ERROR ? (
                  <div className="error-box">{errorMsg}</div>
                ) : !isBusy && (
                  <div className="preview-empty-text">
                    The live preview will appear here once your app starts running.
                  </div>
                )}
             </div>
           )}
        </div>

        {/* Terminal Side Panel (Right) */}
        <div className={`terminal-side-panel ${isTerminalOpen ? 'open' : 'closed'}`}>
          <div className="side-header" onClick={() => setIsTerminalOpen(!isTerminalOpen)}>
            <div className="side-header-content">
              <div className="window-dots">
                <span className="window-dot red" />
                <span className="window-dot yellow" />
                <span className="window-dot green" />
              </div>
              Terminal
            </div>
            <div className="side-header-right">
              <button className="btn-toggle-side">
                {isTerminalOpen ? '▶' : '◀'}
              </button>
            </div>
          </div>
          
          <div className="drawer-content">
            <div className="terminal-wrap" ref={termRef} />
          </div>
        </div>
        
        {/* Environment Variables Modal */}
        {stage === STAGES.NEEDS_ENV && (
          <div className="modal-overlay">
            <div className="env-form modal-content">
              <h3>Environment Variables Required</h3>
              <p className="hint">Detected from .env.example. Values stay in memory only.</p>
              {detectedKeys.map((key) => (
                <div className="env-row" key={key}>
                  <label htmlFor={`env-${key}`}>{key}</label>
                  <input
                    id={`env-${key}`}
                    type="password"
                    value={envValues[key] || ''}
                    onChange={(e) => setEnvValues((prev) => ({ ...prev, [key]: e.target.value }))}
                    placeholder="Enter value..."
                  />
                </div>
              ))}
              <button className="btn-primary" onClick={handleRunWithEnv}>
                Run with these values
              </button>
            </div>
          </div>
        )}

      </main>

      {/* Footer only in idle state */}
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

function statusLabel(stage) {
  switch (stage) {
    case STAGES.IDLE: return 'Ready — paste a repo URL to begin';
    case STAGES.FETCHING: return 'Cloning repository from GitHub…';
    case STAGES.ANALYZING: return 'Detecting runtime & dependencies…';
    case STAGES.NEEDS_ENV: return 'Waiting for environment variables';
    case STAGES.BUILDING: return 'Building sandbox…';
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

function getProgressDetails(stage) {
  switch (stage) {
    case STAGES.FETCHING: return { percent: 25, eta: '~ 3s' };
    case STAGES.ANALYZING: return { percent: 45, eta: '~ 2s' };
    case STAGES.NEEDS_ENV: return { percent: 45, eta: 'Paused' };
    case STAGES.BUILDING: return { percent: 75, eta: '~ 30s' };
    case STAGES.RUNNING: return { percent: 95, eta: '~ 10s' };
    case STAGES.READY: return { percent: 100, eta: 'Done' };
    default: return { percent: 0, eta: '' };
  }
}

function useSimulatedProgress(stage, terminalProgress) {
  const [progress, setProgress] = useState(0);
  const [eta, setEta] = useState('');

  useEffect(() => {
    const details = terminalProgress || getProgressDetails(stage);
    setEta(details.eta);

    if (stage === STAGES.READY || stage === STAGES.ERROR || stage === STAGES.IDLE) {
      setProgress(details.percent);
      return;
    }

    const target = details.percent;
    const interval = setInterval(() => {
      setProgress(p => {
        const diff = target - p;
        if (diff > 0.1) {
          return p + Math.max(0.1, diff * 0.05);
        }
        return p;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [stage, terminalProgress]);

  return { progress, eta };
}
