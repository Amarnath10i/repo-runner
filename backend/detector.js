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
      return (req?.toLowerCase().includes('django') && !req?.toLowerCase().includes('djangorestframework') === false) || existsSync(join(dir, 'manage.py'));
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
        existsSync(join(dir, 'requirements.txt')) ||
        existsSync(join(dir, 'pyproject.toml')) ||
        existsSync(join(dir, 'Pipfile')) ||
        existsSync(join(dir, 'environment.yml')) ||
        existsSync(join(dir, 'setup.py'))
      ) return true;
      try {
        return readdirSync(dir).some(f => f.endsWith('.py'));
      } catch {
        return false;
      }
    },
    getCommands: (dir) => {
      const installCmd = existsSync(join(dir, 'requirements.txt'))
        ? 'pip install -r requirements.txt'
        : existsSync(join(dir, 'pyproject.toml'))
          ? 'pip install .'
          : existsSync(join(dir, 'Pipfile'))
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

/**
 * Detect the runtime of a cloned repo and return run configuration.
 */
export function detectRuntime(repoDir) {
  for (const config of RUNTIME_CONFIGS) {
    if (config.detect(repoDir)) {
      const commands = config.getCommands(repoDir);
      return {
        id: config.id,
        label: config.label,
        icon: config.icon,
        color: config.color,
        ...commands,
      };
    }
  }

  return {
    id: 'unknown',
    label: 'Unknown',
    icon: '❓',
    color: '#888',
    install: null,
    start: null,
    dockerfile: null,
  };
}

/**
 * Detect env vars from .env.example or .env.sample files.
 */
export function detectEnvVars(repoDir) {
  const candidates = ['.env.example', '.env.sample', '.env.template'];
  for (const name of candidates) {
    const filePath = join(repoDir, name);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf8');
        return content
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && l.includes('='))
          .map((l) => l.split('=')[0].trim());
      } catch {
        return [];
      }
    }
  }
  return [];
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
  // If none found, look for any .py file
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.py'));
    if (files.length > 0) return files[0];
  } catch {
    // ignore
  }
  return 'main.py';
}
