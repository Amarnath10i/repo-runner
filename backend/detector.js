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
    // Laravel, Rails and Django apps often carry a package.json just for their
    // frontend assets — those are PHP/Ruby/Python apps, not Node ones.
    detect: (dir) =>
      existsSync(join(dir, 'package.json')) &&
      !existsSync(join(dir, 'artisan')) &&
      !existsSync(join(dir, 'manage.py')) &&
      !(existsSync(join(dir, 'Gemfile')) && existsSync(join(dir, 'config', 'routes.rb'))),
    getCommands: (dir) => {
      const pkg = readJsonSafe(join(dir, 'package.json'));
      const scripts = pkg?.scripts ?? {};
      const manager = detectNodeManager(dir, pkg);

      const startScript = scripts.dev
        ? 'dev'
        : scripts.start
          ? 'start'
          : scripts.preview
            ? 'preview'
            : scripts.serve
              ? 'serve'
              : null;

      let start;
      if (startScript) {
        start = `${manager} run ${startScript}`;
      } else if (pkg?.workspaces) {
        // npm workspaces monorepo: install at root, run a runnable workspace
        // (prefer a frontend so there's a visible preview).
        const ws = findRunnableWorkspace(dir, pkg);
        start = ws
          ? `${manager} run ${ws.script} --workspace ${ws.name}`
          : `${manager} start`;
      } else {
        const entry = findNodeEntry(dir, pkg);
        if (!entry) start = `${manager} start`;
        else if (manager === 'bun') start = `bun ${entry}`;
        else if (/\.[cm]?ts$/.test(entry)) start = `npx --yes tsx ${entry}`;
        else start = `node ${entry}`;
      }

      return {
        install: `${manager} install`,
        start,
        manager,
        dockerfile: null,
      };
    },
  },
  {
    id: 'deno',
    label: 'Deno',
    icon: '🦕',
    color: '#70ffaf',
    detect: (dir) =>
      !existsSync(join(dir, 'package.json')) &&
      ['deno.json', 'deno.jsonc'].some((f) => existsSync(join(dir, f))),
    getCommands: (dir) => {
      const cfgFile = ['deno.json', 'deno.jsonc'].find((f) => existsSync(join(dir, f)));
      const cfg = readJsoncSafe(join(dir, cfgFile)) || {};
      const task = ['dev', 'start', 'serve'].find((t) => cfg.tasks?.[t]);
      const entry = ['main.ts', 'server.ts', 'mod.ts', 'index.ts', 'app.ts', 'main.js', 'src/main.ts']
        .find((f) => existsSync(join(dir, f))) || 'main.ts';
      return {
        install: null,
        start: task ? `deno task ${task}` : `deno run -A ${entry}`,
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
      if (readSpaceConfig(dir).sdk === 'streamlit') return true;
      const req = readFileSafe(join(dir, 'requirements.txt')) || readFileSafe(join(dir, 'pyproject.toml')) || '';
      return req.toLowerCase().includes('streamlit');
    },
    getCommands: (dir) => {
      const appFile = readSpaceConfig(dir).app_file || findPythonEntry(dir, ['app.py', 'streamlit_app.py', 'main.py', 'Home.py']);
      return {
        install: 'pip install -r requirements.txt',
        start: `streamlit run ${appFile} --server.port=8501 --server.headless=true --server.address=0.0.0.0`,
        dockerfile: null,
      };
    },
  },
  {
    id: 'python-gradio',
    label: 'Gradio',
    icon: '🤗',
    color: '#ff7c00',
    detect: (dir) => {
      if (readSpaceConfig(dir).sdk === 'gradio') return true;
      const req = readFileSafe(join(dir, 'requirements.txt'));
      if (req?.toLowerCase().includes('gradio')) return true;
      const pyproject = readFileSafe(join(dir, 'pyproject.toml'));
      return pyproject?.toLowerCase().includes('gradio') || false;
    },
    getCommands: (dir) => {
      const appFile = readSpaceConfig(dir).app_file || findPythonEntry(dir, ['app.py', 'main.py', 'demo.py', 'run.py', 'gradio_app.py']);
      return {
        install: 'pip install -r requirements.txt',
        start: `python ${appFile}`,
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
      const appFile = findFastApiApp(dir) || findPythonEntry(dir, ['main.py', 'app.py', 'server.py']);
      const moduleName = appFile.replace(/\.py$/, '').replace(/\//g, '.');
      const appVar = readFileSafe(join(dir, appFile))?.match(/^(\w+)\s*=\s*FastAPI\(/m)?.[1] || 'app';
      return {
        install: 'pip install -r requirements.txt uvicorn',
        start: `uvicorn ${moduleName}:${appVar} --host 0.0.0.0 --port 8000 --reload`,
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
    getCommands: (dir) => {
      const manage = existsSync(join(dir, 'manage.py')) ? 'manage.py' : findFileRecursive(dir, 'manage.py') || 'manage.py';
      return {
        install: 'pip install -r requirements.txt',
        start: `python ${manage} runserver 0.0.0.0:8000`,
        manage,
        dockerfile: null,
      };
    },
  },
  {
    // Notebook-only repos (common for ML/data work): serve them in JupyterLab.
    // Only chosen when there's no conventional script entry point to run.
    id: 'python-notebook',
    label: 'Jupyter Notebooks',
    icon: '📓',
    color: '#f37626',
    detect: (dir) =>
      findFileRecursive(dir, '.ipynb', true) !== null &&
      !['app.py', 'main.py', 'run.py', 'server.py', 'manage.py'].some((f) => existsSync(join(dir, f))),
    getCommands: () => ({
      install: 'pip install jupyterlab',
      start: 'jupyter lab',
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
    detect: (dir) => {
      if (existsSync(join(dir, 'Gemfile'))) return true;
      try {
        return readdirSync(dir).some((f) => f.endsWith('.rb'));
      } catch {
        return false;
      }
    },
    getCommands: (dir) => {
      const isRails = existsSync(join(dir, 'config', 'routes.rb'));
      const hasRackup = existsSync(join(dir, 'config.ru'));
      const entry = ['app.rb', 'main.rb', 'server.rb', 'application.rb']
        .find((f) => existsSync(join(dir, f))) || findFileRecursive(dir, '.rb', true) || 'app.rb';
      let start;
      if (isRails) start = 'bundle exec rails server -b 0.0.0.0 -p 3000';
      else if (hasRackup) start = 'bundle exec rackup -o 0.0.0.0 -p 9292';
      else start = `bundle exec ruby ${entry}`;
      return { install: 'bundle install', start, rails: isRails, rackup: hasRackup, entry, dockerfile: null };
    },
  },
  {
    id: 'php',
    label: 'PHP',
    icon: '🐘',
    color: '#777bb4',
    detect: (dir) =>
      existsSync(join(dir, 'composer.json')) ||
      ['.', ...PHP_DOCROOTS].some((d) => existsSync(join(dir, d, 'index.php'))),
    getCommands: (dir) => {
      const hasComposer = existsSync(join(dir, 'composer.json'));
      const hasArtisan = existsSync(join(dir, 'artisan'));
      // Frameworks (Laravel, Symfony, Slim) serve from public/ or web/.
      const docroot = PHP_DOCROOTS.find((d) => existsSync(join(dir, d, 'index.php'))) || '.';
      return {
        install: hasComposer ? 'composer install' : null,
        start: hasArtisan
          ? 'php artisan serve --host=0.0.0.0 --port=8000'
          : `php -S 0.0.0.0:8000 -t ${docroot}`,
        artisan: hasArtisan,
        docroot,
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
    getCommands: (dir) => {
      const pom = readFileSafe(join(dir, 'pom.xml')) || '';
      const framework = javaFramework(pom);
      return {
        install: 'mvn -DskipTests package',
        start: framework === 'spring' ? 'mvn spring-boot:run' : framework === 'quarkus' ? 'mvn quarkus:dev' : 'java <main class>',
        framework,
        dockerfile: null,
      };
    },
  },
  {
    id: 'java-gradle',
    label: 'Java (Gradle)',
    icon: '☕',
    color: '#f89820',
    detect: (dir) => existsSync(join(dir, 'build.gradle')) || existsSync(join(dir, 'build.gradle.kts')),
    getCommands: (dir) => {
      const build = readFileSafe(join(dir, 'build.gradle')) || readFileSafe(join(dir, 'build.gradle.kts')) || '';
      const framework = /com\.android\./.test(build) ? 'android' : javaFramework(build);
      const task = framework === 'spring' ? 'bootRun' : framework === 'quarkus' ? 'quarkusDev' : /\bapplication\b/.test(build) ? 'run' : null;
      return {
        install: task ? null : 'gradle build -x test',
        start: task ? `gradle ${task}` : 'java <main class>',
        framework,
        task,
        dockerfile: null,
      };
    },
  },
  {
    id: 'dotnet',
    label: '.NET / C#',
    icon: '🟣',
    color: '#512bd4',
    detect: (dir) => findDotnetProject(dir) !== null,
    getCommands: (dir) => {
      const project = findDotnetProject(dir);
      return {
        install: `dotnet restore "${project}"`,
        start: `dotnet run --project "${project}" --urls http://0.0.0.0:5000`,
        project,
        dockerfile: null,
      };
    },
  },
  {
    // Plain Java sources with no build tool (typical for coursework): compiled
    // with javac and the class with a main() method is run.
    id: 'java',
    label: 'Java',
    icon: '☕',
    color: '#f89820',
    detect: (dir) => findFileRecursive(dir, '.java', true) !== null,
    getCommands: () => ({ install: 'javac', start: 'java <main class>', dockerfile: null }),
  },
  {
    id: 'cpp',
    label: 'C / C++',
    icon: '🔧',
    color: '#00599c',
    detect: (dir) =>
      existsSync(join(dir, 'CMakeLists.txt')) ||
      findFileRecursive(dir, '.cpp', true) !== null ||
      findFileRecursive(dir, '.cc', true) !== null ||
      findFileRecursive(dir, '.cxx', true) !== null ||
      findFileRecursive(dir, '.c', true) !== null,
    getCommands: (dir) => {
      // The native runner builds (CMake → Makefile → direct compile) and runs
      // the resulting program; console programs just stream to the terminal.
      if (existsSync(join(dir, 'CMakeLists.txt'))) {
        return { install: 'cmake --build', start: '<built program>', dockerfile: null };
      }
      if (existsSync(join(dir, 'Makefile')) || existsSync(join(dir, 'makefile'))) {
        return { install: 'make', start: '<built program>', dockerfile: null };
      }
      return { install: 'g++ / gcc', start: '<compiled program>', dockerfile: null };
    },
  },
  {
    // Kept last: a plain static website (HTML/CSS/JS, no build step). Only
    // matches when nothing else did, so real apps aren't misread as static.
    id: 'static',
    label: 'Static Site',
    icon: '🌐',
    color: '#e34f26',
    detect: (dir) => {
      if (existsSync(join(dir, 'index.html'))) return true;
      try {
        return readdirSync(dir).some((f) => f.toLowerCase().endsWith('.html'));
      } catch {
        return false;
      }
    },
    getCommands: (dir) => {
      let entry = 'index.html';
      if (!existsSync(join(dir, 'index.html'))) {
        try {
          const html = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.html'));
          // Prefer a conventional landing page name if present.
          entry = html.find((f) => /^(home|index|main)\.html$/i.test(f)) || html[0] || 'index.html';
        } catch {
          // keep default
        }
      }
      return { install: null, start: null, dockerfile: null, static: true, entry };
    },
  },
];

const PHP_DOCROOTS = ['public', 'web', 'public_html', 'www'];

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

  // No runnable app (docs, dotfiles, a language we can't run): serve the
  // repository as a browsable file listing rather than failing outright.
  return {
    id: 'static',
    label: 'Repository Files',
    icon: '📁',
    color: '#8b949e',
    workdir: '',
    install: null,
    start: null,
    dockerfile: null,
    static: true,
    browse: true,
    entry: 'index.html',
  };
}

// Hints for classifying a service as the user-facing frontend vs. the API/backend.
const FRONTEND_HINT_DIRS = new Set(['frontend', 'web', 'client', 'ui', 'www']);
const BACKEND_HINT_DIRS = new Set(['backend', 'server', 'api', 'service']);
const FRONTEND_DEP_MARKERS = [
  'next', 'vite', 'react-scripts', 'nuxt', 'vue', '@angular/core',
  'svelte', '@sveltejs/kit', 'gatsby', 'react-dom',
];

const SERVICE_MANIFESTS = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'manage.py', 'go.mod', 'Cargo.toml',
  'composer.json', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'deno.json', 'deno.jsonc',
];

function classifyRole(dirName, runtime, absDir) {
  const lower = (dirName || '').toLowerCase();
  if (runtime.static) return 'frontend';
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

  // A subfolder is its own service only if it's a project in its own right
  // (has a manifest) or a plain-HTML frontend folder. Otherwise it's part of
  // the root app — a PHP docroot like web/, a templates/ or views/ folder.
  const isStandalone = (d) => {
    const absDir = join(repoDir, d);
    if (SERVICE_MANIFESTS.some((f) => existsSync(join(absDir, f)))) return true;
    try {
      if (readdirSync(absDir).some((f) => /\.(cs|fs)proj$/.test(f))) return true;
    } catch {
      return false;
    }
    return FRONTEND_HINT_DIRS.has(d.toLowerCase()) && existsSync(join(absDir, 'index.html'));
  };

  // A workspaces monorepo (npm/pnpm/yarn/bun) is one project: installed once
  // at the root, where its dev script starts every package together.
  const rootPkg = readJsonSafe(join(repoDir, 'package.json'));
  if (rootPkg?.workspaces || existsSync(join(repoDir, 'pnpm-workspace.yaml'))) {
    const root = asService('');
    return root ? [root] : [];
  }

  const subServices = subdirs.filter(isStandalone).map(asService).filter(Boolean);

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
  const { missing } = scanEnvExamples(repoDir);
  return [...missing];
}

/**
 * Keys that .env.example files give a value for — those need no prompt, since
 * the runner starts the app with the example's values as defaults.
 */
export function envKeysWithDefaults(repoDir) {
  return scanEnvExamples(repoDir).defaults;
}

function scanEnvExamples(repoDir) {
  const candidates = ['.env.example', '.env.sample', '.env.template'];
  const missing = new Set();
  const defaults = new Set();

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
          .forEach((l) => {
            const key = l.split('=')[0].replace(/^export\s+/, '').trim();
            const value = l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
            // Placeholders like "your-api-key" or "<token>" still need a real value.
            if (value && !/^(your|<|xxx|changeme|replace|todo|\*+$)/i.test(value)) defaults.add(key);
            else missing.add(key);
          });
      } catch {
        // ignore unreadable files
      }
    }
  }
  for (const k of defaults) missing.delete(k);
  return { missing, defaults };
}

// Ways code reads an env var, across JS/TS/Bun/Vite and Python.
const ENV_REF_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
  /Bun\.env\.([A-Z][A-Z0-9_]+)/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
  /os\.environ\.get\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /os\.environ\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
];

// System/framework vars the runner sets itself or that need no user input.
const ENV_IGNORE = new Set([
  'NODE_ENV', 'PORT', 'HOST', 'HOSTNAME', 'PWD', 'HOME', 'PATH', 'CI', 'TZ',
  'PYTHONUTF8', 'PYTHONIOENCODING', 'PYTHONPATH', 'VIRTUAL_ENV',
  'FLASK_RUN_PORT', 'FLASK_RUN_HOST', 'PUBLIC_URL', 'BASE_URL',
  // Auto-injected by the runner when wiring a monorepo's frontend to its
  // backend — don't prompt the user for these.
  'NEXT_PUBLIC_API_URL', 'VITE_API_URL', 'REACT_APP_API_URL',
  'API_URL', 'API_BASE_URL', 'BACKEND_URL', 'PUBLIC_API_URL',
  'GRADIO_SERVER_PORT', 'GRADIO_SERVER_NAME',
]);

// Database/connection strings — the user must supply these (they carry creds).
const DB_CONN_RE = /(MONGO|DATABASE|POSTGRES|POSTGRESQL|MYSQL|MARIADB|REDIS|MSSQL|SQLALCHEMY|DB)[_A-Z0-9]*(URL|URI|CONNECTION|DSN)|CONNECTION[_-]?STRING/i;
// Plain config the runner can fill or the app defaults: base URLs, host, port.
const CONFIG_URL_RE = /(_URL|_URI|_ENDPOINT|_HOST|_PORT|BASE[_-]?URL)$|^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_)/i;
// Generic secrets — keys, tokens, passwords.
const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE|AUTH|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|API[_-]?KEY|DSN)/i;

/**
 * Should the user be prompted for this env var? True for secrets/DB URIs the
 * runner can't know; false for base URLs/host/port config the runner wires up
 * or the app defaults itself.
 */
export function isPromptableSecret(name) {
  if (DB_CONN_RE.test(name)) return true;     // DB connection string → ask
  if (CONFIG_URL_RE.test(name)) return false; // base URL / host / port → auto
  if (SECRET_RE.test(name)) return true;      // API key / token / secret → ask
  return false;                               // everything else (config) → auto
}

const CODE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rb', '.php', '.vue', '.svelte', '.astro',
]);

/**
 * Find env vars a repo actually reads from its source code (process.env.X,
 * Bun.env.X, import.meta.env.X, os.environ[...], etc.). This surfaces required
 * config — DB URIs, API keys — even when the repo ships no .env.example, so the
 * user can supply the values instead of the app crashing on a missing var.
 */
export function detectEnvVarsFromCode(repoDir) {
  const keys = new Set();
  const queue = [repoDir];
  let scanned = 0;
  const MAX_FILES = 600;

  while (queue.length > 0 && scanned < MAX_FILES) {
    const dir = queue.shift();
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      const p = join(dir, it.name);
      if (it.isDirectory()) {
        if (!SKIP_DIRS.has(it.name)) queue.push(p);
        continue;
      }
      const dot = it.name.lastIndexOf('.');
      const ext = dot >= 0 ? it.name.slice(dot) : '';
      if (!CODE_EXTS.has(ext)) continue;
      if (++scanned > MAX_FILES) break;
      let content;
      try {
        content = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      if (content.length > 500_000) continue;
      for (const re of ENV_REF_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(content))) {
          if (!ENV_IGNORE.has(m[1])) keys.add(m[1]);
        }
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
    'python-gradio': 'python:3.11-slim',
    'python-notebook': 'python:3.11-slim',
    'deno': 'denoland/deno:latest',
    'java': 'eclipse-temurin:21-jdk',
    'go': 'golang:1.22-alpine',
    'rust': 'rust:1-slim',
    'ruby': 'ruby:3.3-slim',
    'php': 'php:8.3-cli',
    'java-maven': 'maven:3.9-eclipse-temurin-21',
    'java-gradle': 'gradle:8-jdk21',
    'cpp': 'gcc:latest',
    'static': 'python:3.11-slim',
    'dotnet': 'mcr.microsoft.com/dotnet/sdk:8.0',
  };
  return images[runtimeId] || 'ubuntu:22.04';
}

/**
 * Full-stack repos often start everything from one root script, e.g.
 *   "dev": "concurrently \"vite dev\" \"python -m uvicorn agents.main:app --port 8787\""
 * Running that script is the most faithful way to run them: the frontend
 * already expects the backend where the script puts it. Returns
 * { script, pythonDirs, backendPorts } or null.
 */
export function detectOrchestratedScript(repoDir) {
  const pkg = readJsonSafe(join(repoDir, 'package.json'));
  const name = pkg?.scripts?.dev ? 'dev' : pkg?.scripts?.start ? 'start' : null;
  const script = name ? pkg.scripts[name] : '';
  const launchesOther = /\b(uvicorn|gunicorn|flask\s+run|python3?\s|py\s+-|manage\.py|go\s+run|cargo\s+run|dotnet\s+run|php\s+artisan|rails\s+s)/.test(script);
  const runsSeveral = /concurrently|npm-run-all|run-p\b|\s&\s|turbo\s/.test(script);
  if (!launchesOther || !runsSeveral) return null;

  // Python deps: the root, plus folders the script names (agents.main → agents/).
  const pythonDirs = [];
  const hasPyManifest = (d) => ['requirements.txt', 'pyproject.toml'].some((f) => existsSync(join(repoDir, d, f)));
  if (hasPyManifest('')) pythonDirs.push('');
  for (const m of script.matchAll(/(?:^|[\s"'(/])([A-Za-z_][\w-]*)(?:[./][\w.]+)*:[A-Za-z_]\w*|cd\s+([\w./-]+)|([\w-]+)\/[\w/-]+\.py/g)) {
    const dir = (m[1] || m[2] || m[3] || '').replace(/\/+$/, '');
    if (dir && !pythonDirs.includes(dir) && existsSync(join(repoDir, dir)) && hasPyManifest(dir)) pythonDirs.push(dir);
  }
  const backendPorts = [...script.matchAll(/(?:--port|-p|--bind\s+[\d.]+:|PORT=)\s*=?\s*(\d{2,5})/g)].map((m) => Number(m[1]));
  return { script: name, pythonDirs, backendPorts };
}

// --- Helpers ---

/**
 * Hugging Face Spaces declare how they run in README front matter:
 *   ---
 *   sdk: gradio
 *   app_file: app.py
 *   ---
 * (Spaces preinstall the SDK, so it's often missing from requirements.txt.)
 */
function readSpaceConfig(dir) {
  const readme = readFileSafe(join(dir, 'README.md')) || '';
  const front = readme.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
  const get = (key) => front.match(new RegExp(`^${key}:\\s*["']?([^"'\\r\\n#]+)`, 'm'))?.[1]?.trim();
  return { sdk: get('sdk'), app_file: get('app_file') };
}

/** npm / pnpm / yarn / bun, from the lockfile or package.json "packageManager". */
function detectNodeManager(dir, pkg) {
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return 'bun';
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  const declared = pkg?.packageManager?.split('@')[0];
  return ['pnpm', 'yarn', 'bun'].includes(declared) ? declared : 'npm';
}

/** Which JVM web framework (if any) a build file pulls in. */
function javaFramework(buildFile) {
  if (/spring-boot|org\.springframework\.boot/.test(buildFile)) return 'spring';
  if (/io\.quarkus/.test(buildFile)) return 'quarkus';
  return null;
}

/**
 * Find the .NET project to run: prefer a web project, skip test projects.
 * Searches the root and two levels down (solutions usually nest projects).
 */
function findDotnetProject(dir) {
  const projects = [];
  const walk = (d, rel, depth) => {
    let items;
    try {
      items = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if (depth < 2 && !SKIP_DIRS.has(it.name) && !it.name.startsWith('.')) walk(join(d, it.name), r, depth + 1);
      } else if (/\.(cs|fs|vb)proj$/.test(it.name)) {
        projects.push(r);
      }
    }
  };
  walk(dir, '', 0);
  const runnable = projects.filter((p) => !/test/i.test(p));
  if (!runnable.length) return null;
  const isWeb = (p) => /Sdk="Microsoft\.NET\.Sdk\.(Web|BlazorWebAssembly|Razor)"/.test(readFileSafe(join(dir, p)) || '');
  const isExe = (p) => /<OutputType>\s*(Win)?Exe\s*<\/OutputType>/i.test(readFileSafe(join(dir, p)) || '');
  return runnable.find(isWeb) || runnable.find(isExe) || runnable[0];
}

/** The .py file that creates the FastAPI app, if any. */
function findFastApiApp(dir) {
  for (const f of ['main.py', 'app.py', 'server.py', 'app/main.py', 'src/main.py', 'api/main.py', 'backend/main.py']) {
    if (/=\s*FastAPI\(/.test(readFileSafe(join(dir, f)) || '')) return f;
  }
  return null;
}

/** JSON with comments (deno.jsonc, tsconfig-style). */
function readJsoncSafe(filePath) {
  const text = readFileSafe(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
  } catch {
    return null;
  }
}

/**
 * Find a Node app's real entry file when package.json has no start script.
 * Prefers package.json "main", then common server/entry filenames — so we
 * don't blindly run "node index.js" when there is no index.js.
 */
function findNodeEntry(dir, pkg) {
  const candidates = [];
  if (pkg?.main) candidates.push(pkg.main);
  candidates.push(
    'index.js', 'server.js', 'app.js', 'main.js', 'index.mjs', 'index.cjs',
    'src/index.js', 'src/server.js', 'src/app.js', 'src/main.js',
    'app/index.js', 'server/index.js', 'bin/www', 'dist/index.js',
    'index.ts', 'server.ts', 'app.ts', 'main.ts',
    'src/index.ts', 'src/server.ts', 'src/app.ts', 'src/main.ts',
  );
  for (const c of candidates) {
    if (c && existsSync(join(dir, c))) return c;
  }
  return null;
}

/**
 * For an npm-workspaces monorepo, pick a runnable workspace — preferring a
 * frontend (Vite/Next/React) so there's a visible preview. Returns
 * { name, script } to run as `npm run <script> --workspace <name>`.
 */
function findRunnableWorkspace(dir, pkg) {
  const patterns = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : pkg.workspaces?.packages || [];
  const wsDirs = [];
  for (const pat of patterns) {
    if (pat.endsWith('/*')) {
      const base = pat.slice(0, -2);
      try {
        for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
          if (e.isDirectory()) wsDirs.push(`${base}/${e.name}`);
        }
      } catch {
        // ignore
      }
    } else {
      wsDirs.push(pat);
    }
  }

  const FRONTEND_DEPS = ['vite', 'next', 'react-scripts', '@sveltejs/kit', 'nuxt', 'vue', '@angular/core'];
  const candidates = [];
  for (const rel of wsDirs) {
    const wpkg = readJsonSafe(join(dir, rel, 'package.json'));
    if (!wpkg?.name) continue;
    const scripts = wpkg.scripts || {};
    const script = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : scripts.preview ? 'preview' : null;
    if (!script) continue;
    const deps = { ...(wpkg.dependencies || {}), ...(wpkg.devDependencies || {}) };
    candidates.push({ name: wpkg.name, script, isFrontend: FRONTEND_DEPS.some((d) => deps[d]) });
  }
  return candidates.find((c) => c.isFrontend) || candidates[0] || null;
}

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
  // If none found, pick a root .py file — preferring one with a __main__ guard,
  // and never packaging/test helpers like setup.py or conftest.py.
  try {
    const files = readdirSync(dir).filter(
      (f) => f.endsWith('.py') && !/^(setup|conftest|__init__)\.py$|^test_/.test(f)
    );
    const withMain = files.find((f) => /__name__\s*==\s*['"]__main__['"]/.test(readFileSafe(join(dir, f)) || ''));
    if (withMain || files.length > 0) return withMain || files[0];
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
  'target', 'bin', 'obj', '.rr-site',
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
