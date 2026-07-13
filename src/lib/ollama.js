// Uses a locally-running Ollama server to read a repo's README + manifest
// files and figure out how to actually install/run it, instead of guessing
// from package.json scripts alone.
//
// IMPORTANT: Ollama must be started with CORS allowed for this browser tab's
// origin, e.g.:
//   OLLAMA_ORIGINS=* ollama serve
// Otherwise the browser will block the fetch() call below and you'll see a
// CORS error in the console — that's not a bug in this app, it's Ollama's
// default (it only allows localhost origins by default in some versions).

import { findPackageJsonDir } from './heuristics.js';

const MANIFEST_CANDIDATES = [
  'README.md', 'README', 'readme.md', 'Readme.md',
  'package.json',
  'requirements.txt', 'Pipfile', 'pyproject.toml', 'environment.yml',
  'Dockerfile', 'docker-compose.yml',
  'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile',
];

const MAX_CHARS_PER_FILE = 4000;

const SYSTEM_PROMPT = `You analyze a GitHub repository's README and manifest files to determine how to install and run it.

Respond with ONLY raw JSON (no markdown fences, no commentary) matching exactly this shape:
{
  "runtime": "node" | "python" | "other" | "unknown",
  "canRunInBrowserSandbox": boolean,
  "installCmd": string | null,
  "startCmd": string | null,
  "envVarsMentioned": string[],
  "reasoning": string
}

Rules:
- "canRunInBrowserSandbox" must be true ONLY if the project is pure Node.js/npm
  (or yarn/pnpm) with no native bindings, no GPU/CUDA requirement, no Docker
  requirement, and no other system-level service. It runs inside a WebContainer:
  an in-browser Node.js sandbox with no Python, no Docker, no GPU.
- If the project needs Python, a GPU, Docker, or any compiled native dependency,
  set "canRunInBrowserSandbox" to false, "runtime" accordingly, and explain briefly
  in "reasoning" what would actually be needed to run it (e.g. "needs Docker and a
  GPU for training, not runnable in a browser sandbox").
- installCmd / startCmd should be the literal shell commands (e.g. "npm install",
  "npm run dev"), or null if unknown.
- "reasoning" must be at most 2 short sentences.
- Output nothing but the JSON object.`;

/**
 * Quick check whether an Ollama server is reachable, and which models it has.
 * Used to auto-enable Ollama analysis only when it's actually running.
 */
export async function checkOllamaAvailable(endpoint) {
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { available: false, models: [] };
    const data = await res.json();
    return { available: true, models: (data.models || []).map((m) => m.name) };
  } catch {
    return { available: false, models: [] };
  }
}

export async function analyzeRepo({ tree, endpoint, model, onProgress }) {
  const context = collectContext(tree);

  if (Object.keys(context).length === 0) {
    return {
      ok: false,
      reason: 'No README or manifest files found to analyze.',
    };
  }

  const userContent = Object.entries(context)
    .map(([path, content]) => `--- ${path} ---\n${content}`)
    .join('\n\n');

  onProgress?.('Asking local Ollama model to read the README and figure out how to run this repo...\n');

  let res;
  try {
    res = await fetch(`${endpoint.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    });
  } catch (err) {
    return {
      ok: false,
      reason:
        `Could not reach Ollama at ${endpoint} (${err.message}). Is "ollama serve" ` +
        `running, and was it started with OLLAMA_ORIGINS=* so this browser tab is allowed to call it?`,
    };
  }

  if (!res.ok) {
    return { ok: false, reason: `Ollama returned ${res.status} ${res.statusText}` };
  }

  const data = await res.json();
  const raw = data?.message?.content ?? '';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'Ollama did not return valid JSON — falling back to defaults.' };
  }

  // Even when the LLM says it's runnable, resolve the actual working directory
  // from the file tree so a nested Node app installs in the right place, and
  // never report "runnable" if there is no package.json anywhere.
  const workdir = findPackageJsonDir(tree);

  return {
    ok: true,
    source: 'ollama',
    runtime: parsed.runtime ?? 'unknown',
    canRunInBrowserSandbox: Boolean(parsed.canRunInBrowserSandbox) && workdir !== null,
    workdir,
    installCmd: parsed.installCmd || null,
    startCmd: parsed.startCmd || null,
    envVarsMentioned: Array.isArray(parsed.envVarsMentioned) ? parsed.envVarsMentioned : [],
    reasoning: parsed.reasoning || '',
  };
}

function collectContext(tree) {
  const context = {};
  for (const name of MANIFEST_CANDIDATES) {
    const node = tree[name];
    if (node?.file?.contents) {
      context[name] = node.file.contents.slice(0, MAX_CHARS_PER_FILE);
    }
  }
  return context;
}

// Splits a simple shell command string into argv, e.g. "npm run dev" ->
// ["npm", "run", "dev"]. Deliberately naive (no quote handling) — good enough
// for the install/start commands an LLM is likely to suggest.
export function splitCommand(cmd) {
  return cmd.trim().split(/\s+/);
}
