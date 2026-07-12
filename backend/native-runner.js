// Native process runner — runs projects directly on the host machine
// without Docker. Supports Python, Go, Rust, Ruby, PHP, Java, .NET.
// Falls back to Docker sandbox if the runtime isn't installed locally.

import { spawn, execSync } from 'child_process';
import { join } from 'path';
import { writeFileSync, existsSync } from 'fs';
import { createConnection } from 'net';

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
export function checkNativeRuntimes() {
  if (_cachedRuntimes) return _cachedRuntimes;

  const python = getPythonCmd();
  const pip = getPipCmd(python);

  _cachedRuntimes = {
    python: !!python,
    pythonCmd: python,
    pipCmd: pip,
    go: isCommandAvailable('go'),
    rust: isCommandAvailable('cargo'),
    ruby: isCommandAvailable('ruby'),
    php: isCommandAvailable('php'),
    java: isCommandAvailable('java'),
    dotnet: isCommandAvailable('dotnet'),
    node: isCommandAvailable('node'),
  };

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
  const runtimeMap = {
    'python': runtimes.python,
    'python-flask': runtimes.python,
    'python-fastapi': runtimes.python,
    'python-django': runtimes.python,
    'python-streamlit': runtimes.python,
    'go': runtimes.go,
    'rust': runtimes.rust,
    'ruby': runtimes.ruby,
    'php': runtimes.php,
    'java-maven': runtimes.java,
    'java-gradle': runtimes.java,
    'dotnet': runtimes.dotnet,
    'node': runtimes.node,
  };
  return runtimeMap[runtimeId] ?? false;
}

/**
 * Wait for a port to become reachable (server startup detection).
 */
function waitForPort(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for port ${port}`));
        } else {
          setTimeout(check, 500);
        }
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for port ${port}`));
        } else {
          setTimeout(check, 500);
        }
      });
    };
    check();
  });
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
 * Start a native process for a repo (no Docker needed).
 */
export async function startNativeProcess({ sessionId, repoDir, runtime, envVars, onOutput }) {
  const hostPort = getAvailablePort();
  const runtimes = checkNativeRuntimes();

  // Write .env file if needed
  if (envVars && Object.keys(envVars).length > 0) {
    const envContent = Object.entries(envVars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    writeFileSync(join(repoDir, '.env'), envContent);
    onOutput(`Wrote .env with ${Object.keys(envVars).length} variable(s)\n`);
  }

  // Build environment variables for the process
  const processEnv = {
    ...process.env,
    ...(envVars || {}),
    PORT: String(hostPort),
  };

  // ─── Install dependencies ───
  onOutput(`\n📦 Installing dependencies...\n`);

  try {
    switch (runtime.id) {
      case 'python':
      case 'python-flask':
      case 'python-fastapi':
      case 'python-django':
      case 'python-streamlit': {
        const python = runtimes.pythonCmd || 'python';

        // Create virtual environment
        onOutput(`\n🐍 Setting up Python virtual environment (using: ${python})...\n`);
        const venvDir = join(repoDir, '.venv');

        if (!existsSync(venvDir)) {
          await spawnWithOutput(python, ['-m', 'venv', '.venv'], { cwd: repoDir, env: processEnv }, onOutput);
        }

        // Determine pip/python paths inside venv
        const isWin = process.platform === 'win32';
        const venvPip = isWin ? join('.venv', 'Scripts', 'pip.exe') : join('.venv', 'bin', 'pip');
        const venvPython = isWin ? join('.venv', 'Scripts', 'python.exe') : join('.venv', 'bin', 'python');

        // Install requirements
        if (existsSync(join(repoDir, 'requirements.txt'))) {
          await spawnWithOutput(venvPip, ['install', '-r', 'requirements.txt'], { cwd: repoDir, env: processEnv }, onOutput);
        } else if (existsSync(join(repoDir, 'pyproject.toml'))) {
          await spawnWithOutput(venvPip, ['install', '.'], { cwd: repoDir, env: processEnv }, onOutput);
        }

        // Install runtime-specific extras
        if (runtime.id === 'python-fastapi') {
          await spawnWithOutput(venvPip, ['install', 'uvicorn'], { cwd: repoDir, env: processEnv }, onOutput);
        }
        if (runtime.id === 'python-streamlit') {
          await spawnWithOutput(venvPip, ['install', 'streamlit'], { cwd: repoDir, env: processEnv }, onOutput);
        }

        break;
      }
      case 'go':
        await spawnWithOutput('go', ['mod', 'download'], { cwd: repoDir, env: processEnv }, onOutput);
        break;
      case 'rust':
        await spawnWithOutput('cargo', ['build', '--release'], { cwd: repoDir, env: processEnv }, onOutput);
        break;
      case 'ruby':
        if (existsSync(join(repoDir, 'Gemfile'))) {
          await spawnWithOutput('bundle', ['install'], { cwd: repoDir, env: processEnv }, onOutput);
        }
        break;
      case 'node':
        await spawnWithOutput('npm', ['install'], { cwd: repoDir, env: processEnv }, onOutput);
        break;
      default:
        if (runtime.install) {
          const [cmd, ...args] = runtime.install.split(' ');
          await spawnWithOutput(cmd, args, { cwd: repoDir, env: processEnv }, onOutput);
        }
    }
  } catch (err) {
    onOutput(`\n⚠ Install warning: ${err.message}\n`);
    // Continue anyway — some projects work without full install
  }

  // ─── Start the app ───
  onOutput(`\n🚀 Starting app on port ${hostPort}...\n`);

  let startCmd, startArgs;

  // Determine start command, injecting the allocated port
  const isWin = process.platform === 'win32';
  const venvPython = isWin ? join('.venv', 'Scripts', 'python.exe') : join('.venv', 'bin', 'python');

  switch (runtime.id) {
    case 'python-flask':
      startCmd = venvPython;
      startArgs = [runtime.start?.split(' ').pop() || 'app.py'];
      processEnv.FLASK_RUN_PORT = String(hostPort);
      processEnv.FLASK_RUN_HOST = '0.0.0.0';
      break;

    case 'python-fastapi': {
      const venvUvicorn = isWin ? join('.venv', 'Scripts', 'uvicorn.exe') : join('.venv', 'bin', 'uvicorn');
      const modulePart = runtime.start?.match(/uvicorn\s+(\S+)/)?.[1] || 'main:app';
      startCmd = venvUvicorn;
      startArgs = [modulePart, '--host', '0.0.0.0', '--port', String(hostPort)];
      break;
    }

    case 'python-django':
      startCmd = venvPython;
      startArgs = ['manage.py', 'runserver', `0.0.0.0:${hostPort}`];
      break;

    case 'python-streamlit': {
      const venvStreamlit = isWin ? join('.venv', 'Scripts', 'streamlit.exe') : join('.venv', 'bin', 'streamlit');
      const appFile = runtime.start?.match(/streamlit\s+run\s+(\S+)/)?.[1] || 'app.py';
      startCmd = venvStreamlit;
      startArgs = ['run', appFile, '--server.port', String(hostPort), '--server.headless', 'true', '--server.address', '0.0.0.0'];
      break;
    }

    case 'python': {
      const appFile = runtime.start?.split(' ').pop() || 'main.py';
      startCmd = venvPython;
      startArgs = [appFile];
      break;
    }

    case 'go':
      startCmd = 'go';
      startArgs = ['run', '.'];
      break;

    case 'rust':
      startCmd = 'cargo';
      startArgs = ['run', '--release'];
      break;

    default: {
      if (runtime.start) {
        const parts = runtime.start.split(' ');
        startCmd = parts[0];
        startArgs = parts.slice(1);
      } else {
        throw new Error(`No start command configured for ${runtime.label}`);
      }
    }
  }

  onOutput(`$ ${startCmd} ${startArgs.join(' ')}\n`);

  const appProcess = spawn(startCmd, startArgs, {
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: processEnv,
    shell: true,
  });

  appProcess.stdout.on('data', (data) => onOutput(data.toString()));
  appProcess.stderr.on('data', (data) => onOutput(data.toString()));

  appProcess.on('error', (err) => {
    onOutput(`\n❌ Process error: ${err.message}\n`);
  });

  // Set auto-cleanup timer
  const cleanupTimer = setTimeout(() => {
    stopNativeProcess(sessionId, (msg) => console.log(`[auto-cleanup] ${msg}`));
  }, SESSION_TIMEOUT_MS);

  nativeSessions.set(sessionId, {
    process: appProcess,
    hostPort,
    runtime,
    repoDir,
    cleanupTimer,
    mode: 'native',
  });

  // Try to detect when the server is ready
  try {
    await waitForPort(hostPort, 60000);
    onOutput(`\n✅ App is live on port ${hostPort}!\n`);
  } catch {
    onOutput(`\n⚠ Port ${hostPort} not detected — the app may use a different port or may still be starting.\n`);
  }

  return { hostPort };
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

  try {
    onOutput?.('Stopping process...\n');

    if (process.platform === 'win32') {
      // On Windows, use taskkill to kill the process tree
      try {
        execSync(`taskkill /pid ${session.process.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        session.process.kill('SIGKILL');
      }
    } else {
      // Send SIGTERM, then SIGKILL after 3s
      session.process.kill('SIGTERM');
      setTimeout(() => {
        try { session.process.kill('SIGKILL'); } catch {}
      }, 3000);
    }

    onOutput?.('Process stopped.\n');
  } catch {
    onOutput?.('Process already stopped.\n');
  }

  releasePort(session.hostPort);
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
