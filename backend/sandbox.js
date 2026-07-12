// Docker sandbox manager — spawns, monitors, and cleans up containers.

import Docker from 'dockerode';
import { join } from 'path';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { getDockerImage } from './detector.js';

const docker = new Docker();

// Track active sessions: sessionId -> { container, port, runtime, cleanup timer }
const sessions = new Map();

const CONTAINER_TIMEOUT_MS = 10 * 60 * 1000; // 10 min idle auto-cleanup
const PORT_RANGE_START = 10000;
const PORT_RANGE_END = 11000;
const usedPorts = new Set();

function getAvailablePort() {
  for (let p = PORT_RANGE_START; p < PORT_RANGE_END; p++) {
    if (!usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  throw new Error('No available ports for sandbox container.');
}

function releasePort(port) {
  usedPorts.delete(port);
}

/**
 * Build a dynamic Dockerfile for the detected runtime.
 */
function generateDockerfile(runtime, repoDir) {
  const baseImage = getDockerImage(runtime.id);

  // If repo has its own Dockerfile, use it directly
  if (runtime.id === 'dockerfile' || (runtime.dockerfile && existsSync(join(repoDir, runtime.dockerfile)))) {
    return null; // signal to use the repo's Dockerfile
  }

  // If it's docker-compose, we handle that differently
  if (runtime.id === 'docker-compose') {
    return null;
  }

  let df = `FROM ${baseImage}\nWORKDIR /app\nCOPY . .\n`;

  // Runtime-specific setup
  switch (runtime.id) {
    case 'node':
      df += `RUN npm install 2>&1\n`;
      break;
    case 'python':
    case 'python-flask':
    case 'python-fastapi':
    case 'python-django':
    case 'python-streamlit':
      df += `RUN pip install --no-cache-dir -r requirements.txt 2>&1 || true\n`;
      if (runtime.id === 'python-fastapi') {
        df += `RUN pip install --no-cache-dir uvicorn 2>&1 || true\n`;
      }
      break;
    case 'go':
      df += `RUN go mod download 2>&1\n`;
      break;
    case 'rust':
      df += `RUN cargo build --release 2>&1\n`;
      break;
    case 'ruby':
      df += `RUN bundle install 2>&1\n`;
      break;
    case 'php':
      if (runtime.install) {
        df += `RUN ${runtime.install} 2>&1\n`;
      }
      break;
    case 'java-maven':
      df += `RUN mvn clean package -DskipTests 2>&1\n`;
      break;
    case 'java-gradle':
      df += `RUN chmod +x gradlew 2>&1 || true\nRUN ./gradlew build -x test 2>&1\n`;
      break;
    case 'dotnet':
      df += `RUN dotnet restore 2>&1\n`;
      break;
    default:
      if (runtime.install) {
        df += `RUN ${runtime.install} 2>&1\n`;
      }
  }

  // Expose common ports
  df += `EXPOSE 3000 5000 8000 8080 8501\n`;

  // Start command
  if (runtime.start) {
    const parts = runtime.start.split(' ');
    df += `CMD [${parts.map((p) => `"${p}"`).join(', ')}]\n`;
  }

  return df;
}

/**
 * Start a sandboxed container for a repo.
 * Returns { sessionId, hostPort } and streams build/run output via onOutput.
 */
export async function startSandbox({ sessionId, repoDir, runtime, envVars, onOutput }) {
  const hostPort = getAvailablePort();

  // Common container ports per runtime
  const containerPort = {
    'node': 3000,
    'python': 8000,
    'python-flask': 5000,
    'python-fastapi': 8000,
    'python-django': 8000,
    'python-streamlit': 8501,
    'go': 8080,
    'rust': 8080,
    'ruby': 3000,
    'php': 8000,
    'java-maven': 8080,
    'java-gradle': 8080,
    'dotnet': 5000,
  }[runtime.id] || 8080;

  // Write .env file if needed
  if (envVars && Object.keys(envVars).length > 0) {
    const envContent = Object.entries(envVars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    writeFileSync(join(repoDir, '.env'), envContent);
    onOutput(`Wrote .env with ${Object.keys(envVars).length} variable(s)\n`);
  }

  const imageName = `repo-runner-${sessionId}`;

  // Generate or use existing Dockerfile
  const generatedDf = generateDockerfile(runtime, repoDir);

  if (runtime.id === 'docker-compose') {
    // For docker-compose projects, use docker compose directly
    onOutput('⚠ Docker Compose projects are complex — building with docker compose...\n');
    // Fall through to single-container mode using the first service
  }

  if (generatedDf !== null) {
    // Write generated Dockerfile
    writeFileSync(join(repoDir, '.repo-runner.Dockerfile'), generatedDf);
    onOutput(`Generated Dockerfile for ${runtime.label}:\n${generatedDf}\n`);
  }

  const dockerfilePath = generatedDf !== null ? '.repo-runner.Dockerfile' : 'Dockerfile';

  // Build the image
  onOutput(`\n🔨 Building Docker image (${runtime.label})...\n`);

  try {
    const buildStream = await docker.buildImage(
      { context: repoDir, src: ['.'] },
      {
        t: imageName,
        dockerfile: dockerfilePath,
        forcerm: true,
      }
    );

    await new Promise((resolve, reject) => {
      docker.modem.followProgress(
        buildStream,
        (err, output) => {
          if (err) reject(err);
          else resolve(output);
        },
        (event) => {
          if (event.stream) {
            onOutput(event.stream);
          }
          if (event.error) {
            onOutput(`❌ Build error: ${event.error}\n`);
          }
        }
      );
    });

    onOutput(`\n✅ Image built successfully\n`);
  } catch (err) {
    onOutput(`\n❌ Docker build failed: ${err.message}\n`);
    releasePort(hostPort);
    throw err;
  }

  // Create and start container
  onOutput(`\n🚀 Starting container on port ${hostPort}...\n`);

  const envArray = envVars
    ? Object.entries(envVars).map(([k, v]) => `${k}=${v}`)
    : [];

  // Add PORT env var for frameworks that use it
  envArray.push(`PORT=${containerPort}`);

  try {
    const container = await docker.createContainer({
      Image: imageName,
      name: `repo-runner-${sessionId}`,
      Env: envArray,
      ExposedPorts: { [`${containerPort}/tcp`]: {} },
      HostConfig: {
        PortBindings: {
          [`${containerPort}/tcp`]: [{ HostPort: String(hostPort) }],
        },
        Memory: 512 * 1024 * 1024, // 512MB limit
        NanoCpus: 1e9, // 1 CPU
        AutoRemove: false,
      },
    });

    await container.start();
    onOutput(`\n✅ Container started! App available on port ${hostPort}\n`);

    // Attach to container output
    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      timestamps: false,
    });

    logStream.on('data', (chunk) => {
      // Docker multiplexed stream: strip the 8-byte header
      const text = chunk.toString('utf8');
      // Remove non-printable header bytes
      const cleaned = text.replace(/[\x00-\x08]/g, '');
      if (cleaned.trim()) {
        onOutput(cleaned);
      }
    });

    logStream.on('error', () => {
      // Container stopped
    });

    // Set auto-cleanup timer
    const cleanupTimer = setTimeout(() => {
      stopSandbox(sessionId, (msg) => console.log(`[auto-cleanup] ${msg}`));
    }, CONTAINER_TIMEOUT_MS);

    sessions.set(sessionId, {
      container,
      hostPort,
      containerPort,
      runtime,
      imageName,
      cleanupTimer,
      repoDir,
    });

    return { hostPort, containerPort };
  } catch (err) {
    onOutput(`\n❌ Container start failed: ${err.message}\n`);
    releasePort(hostPort);
    // Try to remove the image
    try {
      const img = docker.getImage(imageName);
      await img.remove({ force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Stop and clean up a sandbox session.
 */
export async function stopSandbox(sessionId, onOutput) {
  const session = sessions.get(sessionId);
  if (!session) {
    onOutput?.('Session not found.\n');
    return;
  }

  clearTimeout(session.cleanupTimer);

  try {
    onOutput?.('Stopping container...\n');
    await session.container.stop({ t: 5 }).catch(() => {});
    await session.container.remove({ force: true }).catch(() => {});
    onOutput?.('Container stopped.\n');
  } catch {
    onOutput?.('Container already stopped.\n');
  }

  // Remove the built image
  try {
    const img = docker.getImage(session.imageName);
    await img.remove({ force: true });
  } catch {
    // ignore
  }

  releasePort(session.hostPort);
  sessions.delete(sessionId);
  onOutput?.('Session cleaned up.\n');
}

/**
 * Get session info.
 */
export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/**
 * Clean up all sessions (on server shutdown).
 */
export async function cleanupAll() {
  for (const [id] of sessions) {
    await stopSandbox(id, console.log);
  }
}
