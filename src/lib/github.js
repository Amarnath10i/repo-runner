// GitHub API calls go straight from the browser (it supports CORS). A run
// costs one API call — file contents come from raw.githubusercontent.com.
// Without a token GitHub allows 60 calls/hour per visitor; if that runs out,
// calls are retried through the site's /api/github proxy (a Vercel function
// that uses the deployment's own GITHUB_TOKEN), when one is deployed.

const API = 'https://api.github.com';
const PROXY = '/api/github';

export class RateLimitError extends Error {}

export function parseGithubUrl(input) {
  // Drop ?tab=readme-ov-file, #readme and a trailing slash or .git — all common
  // in URLs copied from the browser.
  const cleaned = input.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  const match = cleaned.match(
    /github\.com\/([^/\s]+)\/([^/\s]+)(?:\/tree\/([^/\s]+))?/i
  );
  if (!match) {
    throw new Error(
      'Could not parse that as a GitHub URL. Expected something like https://github.com/owner/repo'
    );
  }
  const [, owner, repo, branch] = match;
  return { owner, repo, branch: branch ? decodeURIComponent(branch) : null };
}

const isRateLimited = (res) =>
  res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');

/** The deployment's /api/github proxy, if there is one (else null). */
async function viaProxy(path) {
  try {
    const res = await fetch(`${PROXY}${path}`, { headers: { Accept: 'application/vnd.github+json' } });
    // No proxy deployed (e.g. the dev server answers with index.html).
    if (!(res.headers.get('content-type') || '').includes('json')) return null;
    return res;
  } catch {
    return null;
  }
}

async function ghFetch(path, token) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    throw new Error("Couldn't reach GitHub — check your internet connection.");
  }
  if (!token && isRateLimited(res)) res = (await viaProxy(path)) || res;
  if (!res.ok) {
    if (isRateLimited(res) || res.status === 403) {
      throw new RateLimitError(
        token
          ? 'GitHub rate limit reached for this token. Try again in a while.'
          : 'GitHub allows 60 requests an hour without a token, and that limit is used up. Add a GitHub token (the key button under the search box) to raise it to 5,000.'
      );
    }
    if (res.status === 401) throw new Error('That GitHub token was rejected — check it or remove it.');
    if (res.status === 404 || res.status === 409) {
      throw new Error(
        token
          ? 'Repository or branch not found (check the URL; for a private repo the token needs access to it).'
          : "Repository or branch not found. If it's private, add a GitHub token that can read it."
      );
    }
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function getDefaultBranch(owner, repo, token) {
  const data = await ghFetch(`/repos/${owner}/${repo}`, token);
  return data.default_branch;
}

// Files whose *contents* the analyzer actually needs (manifests, env examples,
// build/config files). Everything else only needs its name for detection.
const KEY_FILENAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'environment.yml',
  'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile', 'pom.xml',
  'build.gradle', 'build.gradle.kts',
  '.env.example', '.env.sample', '.env.template',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml',
  'CMakeLists.txt', 'Makefile', 'tsconfig.json',
  'vite.config.js', 'vite.config.ts', 'next.config.js', 'next.config.mjs',
  'runtime.txt', '.python-version', 'deno.json', 'deno.jsonc',
]);

/**
 * Phase 1: fetch the recursive file list in a single request and build a
 * skeleton tree (file nodes with `contents: null`), then hydrate only the
 * manifest/config files the analyzer needs. This is fast even for repos with
 * hundreds of files — we don't download every blob just to detect the runtime.
 * Returns { tree, blobs } so an in-browser run can later hydrate the rest.
 *
 * `branch` may be 'HEAD' (the default branch) — that saves an API call.
 */
export async function fetchRepoTree({ owner, repo, branch, token, onProgress }) {
  const treeData = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    token
  );

  if (treeData.truncated) {
    onProgress?.(
      'Warning: repo tree was truncated by GitHub (very large repo). Some files may be missing.'
    );
  }

  const blobs = treeData.tree.filter((entry) => entry.type === 'blob');
  const root = {};
  for (const entry of blobs) {
    insertIntoTree(root, entry.path.split('/'), null);
  }
  onProgress?.(`Fetched file list (${blobs.length} files).`);

  // Hydrate only the files analysis needs (plus Python sources, which are
  // small and let the in-browser planner see what a script imports).
  const keyBlobs = blobs.filter((b) =>
    KEY_FILENAMES.has(b.path.split('/').pop()) || (!b.path.includes('/') && b.path.endsWith('.py'))
  );
  await downloadBlobs({ owner, repo, branch, token, tree: root, entries: keyBlobs, onProgress, label: 'manifest file(s)' });

  return { tree: root, blobs };
}

/**
 * Phase 2 (in-browser runs only): download the contents of every remaining
 * blob so the tree can be mounted into the in-browser sandbox.
 */
export async function hydrateAllFiles({ owner, repo, branch = 'HEAD', token, tree, blobs, onProgress }) {
  const pending = blobs.filter((entry) => {
    const node = getNode(tree, entry.path.split('/'));
    return !node?.file || node.file.contents === null;
  });
  const skipped = pending.filter((e) => e.size > MAX_FILE_BYTES);
  for (const e of skipped) {
    insertIntoTree(tree, e.path.split('/'), '');
    onProgress?.(`Skipped ${e.path} (${(e.size / 1048576).toFixed(0)} MB — too large for the browser sandbox)`);
  }
  const entries = pending.filter((e) => !(e.size > MAX_FILE_BYTES));
  await downloadBlobs({ owner, repo, branch, token, tree, entries, onProgress, label: 'files' });
  return tree;
}

// Files larger than this are left empty in the browser sandbox (datasets,
// model weights, videos) — they'd make the run crawl or run out of memory.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|svgz|woff2?|ttf|otf|eot|mp[34]|webm|ogg|wav|flac|m4a|mov|avi|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|so|dll|dylib|exe|bin|wasm|pyc|npy|npz|pkl|pickle|pt|pth|h5|hdf5|onnx|tflite|parquet|feather|sqlite3?|db|xlsx?|docx?|pptx?)$/i;

/**
 * Download file contents. raw.githubusercontent.com serves files with CORS and
 * isn't subject to the 60-requests/hour API limit, so a repo of any size costs
 * no API calls; the blob API is only a fallback (e.g. private repos).
 */
async function downloadBlobs({ owner, repo, branch, token, tree, entries, onProgress, label }) {
  let done = 0;
  const CONCURRENCY = 16;
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      const contents = await fetchFileContents({ owner, repo, branch, token, entry });
      insertIntoTree(tree, entry.path.split('/'), contents);
      done += 1;
      if (done === entries.length || done % 10 === 0) {
        onProgress?.(`Downloaded ${done}/${entries.length} ${label}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
}

async function fetchFileContents({ owner, repo, branch, token, entry }) {
  const binary = BINARY_EXT.test(entry.path);
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const res = await fetch(rawUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    if (res.ok) return binary ? new Uint8Array(await res.arrayBuffer()) : await res.text();
  } catch {
    // fall through to the API
  }
  const blob = await ghFetch(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`, token);
  return decodeBlob(blob, binary);
}

function decodeBlob(blob, binary) {
  if (blob.encoding !== 'base64') return blob.content;
  const bytes = Uint8Array.from(atob(blob.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
  return binary ? bytes : new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function insertIntoTree(root, pathParts, contents) {
  let node = root;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const part = pathParts[i];
    node[part] = node[part] || { directory: {} };
    node = node[part].directory;
  }
  const name = pathParts[pathParts.length - 1];
  const existing = node[name];
  // Preserve already-downloaded contents if we're only re-inserting a skeleton.
  const finalContents =
    contents !== null && contents !== undefined
      ? contents
      : existing?.file?.contents ?? null;
  // Shape kept minimal ({ file: { contents } }) so it mounts cleanly into a
  // WebContainer — shas are tracked separately in the `blobs` list.
  node[name] = { file: { contents: finalContents } };
}

function getNode(root, pathParts) {
  let node = root;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const child = node[pathParts[i]];
    if (!child?.directory) return null;
    node = child.directory;
  }
  return node[pathParts[pathParts.length - 1]] || null;
}

// Scans an already-built tree for likely env var names, by looking at
// .env.example / .env.sample files. Falls back to empty list if none found.
export function detectEnvVars(tree) {
  const candidates = ['.env.example', '.env.sample', '.env.template'];
  for (const name of candidates) {
    if (tree[name]?.file?.contents) {
      return parseEnvKeys(tree[name].file.contents);
    }
  }
  return [];
}

/** Keys the example leaves empty (or as a placeholder) — the ones worth asking for. */
function parseEnvKeys(contents) {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .filter((line) => {
      const value = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
      return !value || /^(your|<|xxx|changeme|replace|todo|\*+$)/i.test(value);
    })
    .map((line) => line.split('=')[0].replace(/^export\s+/, '').trim());
}
