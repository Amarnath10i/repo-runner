// Runtime detection for cloned repositories.
// Scans the repo directory to determine what stack it uses and how to run it.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const RUNTIME_CONFIGS = [
  {
    id: 'docker-compose',
    label: 'Docker Compose',
    icon: '🐳',
    color: '#2496ed',
    detect: (dir) =>
      ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some((f) =>
        existsSync(join(dir, f))
      ),
    getCommands: (dir) => {
      const file = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].find(
        (f) => existsSync(join(dir, f))
      );
      return {
        install: null,
        start: `docker compose -f ${file} up --build`,
        dockerfile: null, // uses compose directly
      };
    },
  },
  {
    id: 'dockerfile',
    label: 'Docker',
    icon: '🐳',
    color: '#2496ed',
    detect: (dir) => existsSync(join(dir, 'Dockerfile')),
    getCommands: () => ({
      install: null,
      start: null, // handled by building/running the Dockerfile
      dockerfile: 'Dockerfile',
    }),
  },
  {
    id: 'node',
    label: 'Node.js',
    icon: '⬢',
    color: '#68a063',
    detect: (dir) => existsSync(join(dir, 'package.json')),
    getCommands: (dir) => {
      const pkg = readJsonSafe(join(dir, 'package.json'));
      const scripts = pkg?.scripts ?? {};
      const manager = existsSync(join(dir, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : existsSync(join(dir, 'yarn.lock'))
          ? 'yarn'
          : 'npm';

      const startScript = scripts.dev
        ? 'dev'
        : scripts.start
          ? 'start'
          : scripts.preview
            ? 'preview'
            : scripts.serve
              ? 'serve'
              : null;

      return {
        install: `${manager} install`,
        start: startScript ? `${manager} run ${startScript}` : 'node index.js',
        dockerfile: null,
      };
    },
  },
  {
    id: 'python-streamlit',
    label: 'Streamlit',
    icon: '🎈',
    color: '#ff4b4b',
    detect: (dir) => {
      if (!existsSync(join(dir, 'requirements.txt'))) return false;
      try {
        const req = readFileSync(join(dir, 'requirements.txt'), 'utf8');
        return req.toLowerCase().includes('streamlit');
      } catch {
        return false;
      }
    },
    getCommands: (dir) => {
      const appFile = findPythonEntry(dir, ['app.py', 'streamlit_app.py', 'main.py']);
      return {
        install: 'pip install -r requirements.txt',
        start: `streamlit run ${appFile} --server.port=8501 --server.headless=true --server.address=0.0.0.0`,
        dockerfile: null,
      };
    },
  },
  {
    id: 'python-flask',
    label: 'Flask',
    icon: '🐍',
    color: '#3776ab',
    detect: (dir) => {
      const req = readFileSafe(join(dir, 'requirements.txt'));
      return req?.toLowerCase().includes('flask') || false;
    },
    getCommands: (dir) => {
      const appFile = findPythonEntry(dir, ['app.py', 'main.py', 'server.py', 'run.py']);
      return {
        install: 'pip install -r requirements.txt',
        start: `python ${appFile}`,
        dockerfile: null,
      };
    },
  },
  {
    id: 'python-fastapi',
    label: 'FastAPI',
    icon: '⚡',
    color: '#009688',
    detect: (dir) => {
      const req = readFileSafe(join(dir, 'requirements.txt'));
      return req?.toLowerCase().includes('fastapi') || false;
    },
    getCommands: (dir) => {
      const appFile = findPythonEntry(dir, ['main.py', 'app.py', 'server.py']);
      const moduleName = appFile.replace('.py', '').replace('/', '.');
      return {
        install: 'pip install -r requirements.txt uvicorn',
        start: `uvicorn ${moduleName}:app --host 0.0.0.0 --port 8000 --reload`,
        dockerfile: null,
      };
    },
  },
  {
    id: 'python-django',
    label: 'Django',
    icon: '🎸',
    color: '#092e20',
    detect: (dir) => {
      const req = readFileSafe(join(dir, 'requirements.txt'));
      return req?.toLowerCase().includes('django') || existsSync(join(dir, 'manage.py'));
    },
    getCommands: () => ({
      install: 'pip install -r requirements.txt',
      start: 'python manage.py runserver 0.0.0.0:8000',
      dockerfile: null,
    }),
  },
  {
    id: 'python',
    label: 'Python',
    icon: '🐍',
    color: '#3776ab',
    detect: (dir) => {
      if (
        findFileRecursive(dir, 'requirements.txt') ||
        findFileRecursive(dir, 'pyproject.toml') ||
        findFileRecursive(dir, 'Pipfile') ||
        findFileRecursive(dir, 'environment.yml') ||
        findFileRecursive(dir, 'setup.py')
      ) return true;
      return findFileRecursive(dir, '.py', true) !== null;
    },
    getCommands: (dir) => {
      const installCmd = findFileRecursive(dir, 'requirements.txt')
        ? 'pip install -r requirements.txt'
        : findFileRecursive(dir, 'pyproject.toml')
          ? 'pip install .'
          : findFileRecursive(dir, 'Pipfile')
            ? 'pip install pipenv && pipenv install'
            : 'pip install .';
      const appFile = findPythonEntry(dir, ['app.py', 'main.py', 'run.py', 'server.py', 'manage.py']);
      return {
        install: installCmd,
        start: `python ${appFile}`,
        dockerfile: null,
      };
    },
  },
  {
    id: 'go',
    label: 'Go',
    icon: '🔵',
    color: '#00add8',
    detect: (dir) => existsSync(join(dir, 'go.mod')),
    getCommands: () => ({
      install: 'go mod download',
      start: 'go run .',
      dockerfile: null,
    }),
  },
  {
    id: 'rust',
    label: 'Rust',
    icon: '🦀',
    color: '#dea584',
    detect: (dir) => existsSync(join(dir, 'Cargo.toml')),
    getCommands: () => ({
      install: null,
      start: 'cargo run',
      dockerfile: null,
    }),
  },
  {
    id: 'ruby',
    label: 'Ruby',
    icon: '💎',
    color: '#cc342d',
    detect: (dir) => existsSync(join(dir, 'Gemfile')),
    getCommands: (dir) => {
      const isRails = existsSync(join(dir, 'config', 'routes.rb'));
      return {
        install: 'bundle install',
        start: isRails ? 'rails server -b 0.0.0.0 -p 3000' : 'ruby app.rb',
        dockerfile: null,
      };
    },
  },
  {
    id: 'php',
    label: 'PHP',
    icon: '🐘',
    color: '#777bb4',
    detect: (dir) => existsSync(join(dir, 'composer.json')) || existsSync(join(dir, 'index.php')),
    getCommands: (dir) => {
      const hasComposer = existsSync(join(dir, 'composer.json'));
      const hasArtisan = existsSync(join(dir, 'artisan'));
      return {
        install: hasComposer ? 'composer install' : null,
        start: hasArtisan
          ? 'php artisan serve --host=0.0.0.0 --port=8000'
          : 'php -S 0.0.0.0:8000',
        dockerfile: null,
      };
    },
  },
  {
    id: 'java-maven',
    label: 'Java (Maven)',
    icon: '☕',
    color: '#f89820',
    detect: (dir) => existsSync(join(dir, 'pom.xml')),
    getCommands: () => ({
      install: 'mvn clean package -DskipTests',
      start: 'mvn spring-boot:run',
      dockerfile: null,
    }),
  },
  {
    id: 'java-gradle',
    label: 'Java (Gradle)',
    icon: '☕',
    color: '#f89820',
    detect: (dir) => existsSync(join(dir, 'build.gradle')) || existsSync(join(dir, 'build.gradle.kts')),
    getCommands: () => ({
      install: './gradlew build -x test',
      start: './gradlew bootRun',
      dockerfile: null,
    }),
  },
  {
    id: 'dotnet',
    label: '.NET / C#',
    icon: '🟣',
    color: '#512bd4',
    detect: (dir) => {
      try {
        const files = readdirSync(dir);
        return files.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'));
      } catch {
        return false;
      }
    },
    getCommands: () => ({
      install: 'dotnet restore',
      start: 'dotnet run --urls http://0.0.0.0:5000',
      dockerfile: null,
    }),
  },
];

// Docker-based runtimes need a Docker daemon; everything else can run natively.
const DOCKER_RUNTIME_IDS = new Set(['docker-compose', 'dockerfile']);

// Common subfolders that hold the actual runnable app in a monorepo, in the
// order we prefer them (a web-visible app first, then the API/server).
const COMMON_SUBDIRS = [
  'frontend', 'web', 'client', 'app', 'ui',
  'backend', 'server', 'api', 'src', 'service',
];

/**
 * Run every runtime config against a single directory and return the first
 * match (config + resolved commands), or null when nothing matches.
 */
function matchRuntimeAt(dir, { skipDocker = false } = {}) {
  for (const config of RUNTIME_CONFIGS) {
    if (skipDocker && DOCKER_RUNTIME_IDS.has(config.id)) continue;
    try {
      if (config.detect(dir)) {
        return { config, commands: config.getCommands(dir) };
      }
    } catch {
      // A broken detector for one runtime shouldn't stop the others.
    }
  }
  return null;
}

/** Turn a matched config into the flat runtime object the rest of the app uses. */
function toRuntime(match, workdir) {
  const { config, commands } = match;
  return {
    id: config.id,
    label: config.label,
    icon: config.icon,
    color: config.color,
    workdir: workdir || '',
    ...commands,
  };
}

/**
 * Look for a runnable, non-Docker (natively runnable) app at the repo root or
 * one level down in a common subfolder. Returns a runtime object with the
 * `workdir` set, or null. This is what lets us still run a repo whose root only
 * has a Dockerfile when Docker isn't available.
 */
function findNativeRuntime(repoDir) {
  // Root first. Skip Docker so a repo whose root (or subfolder) also carries a
  // Dockerfile still surfaces its underlying language runtime.
  const root = matchRuntimeAt(repoDir, { skipDocker: true });
  if (root) return toRuntime(root, '');

  // Then common subfolders, then any remaining immediate subdirectory.
  const seen = new Set(COMMON_SUBDIRS);
  let extras = [];
  try {
    extras = readdirSync(repoDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !seen.has(e.name))
      .map((e) => e.name);
  } catch {
    // ignore
  }

  for (const sub of [...COMMON_SUBDIRS, ...extras]) {
    const subPath = join(repoDir, sub);
    if (!existsSync(subPath)) continue;
    const match = matchRuntimeAt(subPath, { skipDocker: true });
    if (match) return toRuntime(match, sub);
  }
  return null;
}

/**
 * Detect the runtime of a cloned repo and return run configuration.
 *
 * The returned object always carries a `workdir` (relative to the repo root,
 * '' for the root itself) and, when the primary runtime needs Docker, a
 * `nativeFallback` describing how to run the same repo without Docker.
 */
export function detectRuntime(repoDir) {
  const rootMatch = matchRuntimeAt(repoDir);

  if (rootMatch) {
    const runtime = toRuntime(rootMatch, '');
    // If the root wants Docker, also work out a no-Docker way to run it so the
    // server can fall back when the Docker daemon isn't available.
    if (DOCKER_RUNTIME_IDS.has(rootMatch.config.id)) {
      const fallback = findNativeRuntime(repoDir);
      if (fallback) runtime.nativeFallback = fallback;
    }
    return runtime;
  }

  // Nothing at the root — maybe the real project lives in a subfolder.
  const nested = findNativeRuntime(repoDir);
  if (nested) return nested;

  return {
    id: 'unknown',
    label: 'Unknown',
    icon: '❓',
    color: '#888',
    workdir: '',
    install: null,
    start: null,
    dockerfile: null,
  };
}

// Hints for classifying a service as the user-facing frontend vs. the API/backend.
const FRONTEND_HINT_DIRS = new Set(['frontend', 'web', 'client', 'ui', 'www']);
const BACKEND_HINT_DIRS = new Set(['backend', 'server', 'api', 'service']);
const FRONTEND_DEP_MARKERS = [
  'next', 'vite', 'react-scripts', 'nuxt', 'vue', '@angular/core',
  'svelte', '@sveltejs/kit', 'gatsby', 'react-dom',
];

function classifyRole(dirName, runtime, absDir) {
  const lower = (dirName || '').toLowerCase();
  if (FRONTEND_HINT_DIRS.has(lower)) return 'frontend';
  if (BACKEND_HINT_DIRS.has(lower)) return 'backend';
  if (runtime.id === 'node') {
    const pkg = readJsonSafe(join(absDir, 'package.json'));
    const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
    if (FRONTEND_DEP_MARKERS.some((d) => deps[d])) return 'frontend';
    return 'backend';
  }
  // Python / Go / Ruby / etc. are almost always the backend half.
  return 'backend';
}

/**
 * Detect all natively-runnable services in a repo (root + immediate
 * subfolders), each tagged as 'frontend' or 'backend'. Used to run monorepos
 * (e.g. a Next.js frontend + a FastAPI backend) as one wired-up live demo.
 */
export function detectServices(repoDir) {
  let subdirs = [];
  try {
    subdirs = readdirSync(repoDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .map((e) => e.name);
  } catch {
    // ignore
  }

  const asService = (d) => {
    const absDir = d ? join(repoDir, d) : repoDir;
    const match = matchRuntimeAt(absDir, { skipDocker: true });
    if (!match) return null;
    const runtime = toRuntime(match, d);
    return { role: classifyRole(d, runtime, absDir), runtime, workdir: d };
  };

  const subServices = subdirs.map(asService).filter(Boolean);

  // In a monorepo where subfolders already provide both a frontend and a
  // backend, trust them and ignore loose root-level files (e.g. a leftover
  // script) that would otherwise be mistaken for a third service.
  const subHasFront = subServices.some((s) => s.role === 'frontend');
  const subHasBack = subServices.some((s) => s.role === 'backend');
  if (subHasFront && subHasBack) return subServices;

  const rootService = asService('');
  return rootService ? [rootService, ...subServices] : subServices;
}

/**
 * Detect env vars from .env.example / .env.sample files, scanning the repo root
 * and immediate subfolders (so a monorepo's frontend/backend keys are found).
 */
export function detectEnvVars(repoDir) {
  const candidates = ['.env.example', '.env.sample', '.env.template'];
  const keys = new Set();

  const dirs = [repoDir];
  try {
    for (const e of readdirSync(repoDir, { withFileTypes: true })) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) dirs.push(join(repoDir, e.name));
    }
  } catch {
    // ignore
  }

  for (const dir of dirs) {
    for (const name of candidates) {
      const filePath = join(dir, name);
      if (!existsSync(filePath)) continue;
      try {
        readFileSync(filePath, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && l.includes('='))
          .forEach((l) => keys.add(l.split('=')[0].trim()));
      } catch {
        // ignore unreadable files
      }
    }
  }
  return [...keys];
}

/**
 * Get the base Docker image for a runtime.
 */
export function getDockerImage(runtimeId) {
  const images = {
    'node': 'node:20-alpine',
    'python': 'python:3.11-slim',
    'python-flask': 'python:3.11-slim',
    'python-fastapi': 'python:3.11-slim',
    'python-django': 'python:3.11-slim',
    'python-streamlit': 'python:3.11-slim',
    'go': 'golang:1.22-alpine',
    'rust': 'rust:1-slim',
    'ruby': 'ruby:3.3-slim',
    'php': 'php:8.3-cli',
    'java-maven': 'maven:3.9-eclipse-temurin-21',
    'java-gradle': 'gradle:8-jdk21',
    'dotnet': 'mcr.microsoft.com/dotnet/sdk:8.0',
  };
  return images[runtimeId] || 'ubuntu:22.04';
}

// --- Helpers ---

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readFileSafe(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function findPythonEntry(dir, candidates) {
  for (const name of candidates) {
    if (existsSync(join(dir, name))) return name;
  }
  // If none found, look for any .py file in the root
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.py'));
    if (files.length > 0) return files[0];
  } catch {
    // ignore
  }
  // Fallback: look recursively for ANY .py file
  const recursivePy = findFileRecursive(dir, '.py', true);
  if (recursivePy) return recursivePy;
  
  return 'main.py';
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  'vendor', '__pycache__', '.venv', 'venv',
  'target', 'bin', 'obj',
]);

/**
 * Searches recursively for a file.
 * If `endsWith` is true, it treats `fileName` as an extension (e.g. '.py').
 * Returns the relative path if found, or null.
 */
function findFileRecursive(dir, fileName, endsWith = false) {
  const queue = [{ currentDir: dir, relPath: '' }];
  while (queue.length > 0) {
    const { currentDir, relPath } = queue.shift();
    try {
      const items = readdirSync(currentDir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          if (!SKIP_DIRS.has(item.name)) {
            queue.push({
              currentDir: join(currentDir, item.name),
              relPath: relPath ? `${relPath}/${item.name}` : item.name
            });
          }
        } else {
          if (endsWith ? item.name.endsWith(fileName) : item.name === fileName) {
            return relPath ? `${relPath}/${item.name}` : item.name;
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }
  return null;
}
