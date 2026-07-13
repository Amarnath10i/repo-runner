// All calls go directly to api.github.com from the browser (it supports CORS
// for public GET requests), so no backend server is needed for this MVP.
// NOTE: unauthenticated requests are capped at 60/hour per IP by GitHub.
// Pass a personal access token (read-only, "public_repo" scope) via the UI
// to raise that limit to 5,000/hour if you hit it.

const API = 'https://api.github.com';

export function parseGithubUrl(input) {
  const cleaned = input.trim().replace(/\.git$/, '');
  const match = cleaned.match(
    /github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/
  );
  if (!match) {
    throw new Error(
      'Could not parse that as a GitHub URL. Expected something like https://github.com/owner/repo'
    );
  }
  const [, owner, repo, branch] = match;
  return { owner, repo, branch: branch || null };
}

async function ghFetch(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(
        'GitHub API rate limit hit (60 requests/hour without a token). Add a personal access token in the settings panel to raise this to 5,000/hour.'
      );
    }
    if (res.status === 404) {
      throw new Error('Repository or branch not found (is it private or misspelled?).');
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
]);

/**
 * Phase 1: fetch the recursive file list in a single request and build a
 * skeleton tree (file nodes with `contents: null`), then hydrate only the
 * manifest/config files the analyzer needs. This is fast even for repos with
 * hundreds of files — we don't download every blob just to detect the runtime.
 * Returns { tree, blobs } so a WebContainer run can later hydrate the rest.
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

  // Hydrate only the files analysis needs.
  const keyBlobs = blobs.filter((b) => KEY_FILENAMES.has(b.path.split('/').pop()));
  let done = 0;
  const BATCH_SIZE = 8;
  for (let i = 0; i < keyBlobs.length; i += BATCH_SIZE) {
    await Promise.all(
      keyBlobs.slice(i, i + BATCH_SIZE).map(async (entry) => {
        const blob = await ghFetch(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`, token);
        insertIntoTree(root, entry.path.split('/'), decodeBlob(blob));
        done += 1;
        onProgress?.(`Analyzed ${done}/${keyBlobs.length} manifest file(s).`);
      })
    );
  }

  return { tree: root, blobs };
}

/**
 * Phase 2 (WebContainer only): download the contents of every remaining blob
 * so the tree can be mounted into the in-browser Node sandbox.
 */
export async function hydrateAllFiles({ owner, repo, token, tree, blobs, onProgress }) {
  const pending = blobs.filter((entry) => {
    const node = getNode(tree, entry.path.split('/'));
    return !node?.file || node.file.contents === null;
  });

  let done = 0;
  const BATCH_SIZE = 8;
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    await Promise.all(
      pending.slice(i, i + BATCH_SIZE).map(async (entry) => {
        const blob = await ghFetch(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`, token);
        insertIntoTree(tree, entry.path.split('/'), decodeBlob(blob));
        done += 1;
        onProgress?.(`Downloaded ${done}/${pending.length} files: ${entry.path}`);
      })
    );
  }
  return tree;
}

/**
 * Back-compat: fetch the full tree with every blob hydrated in one call.
 */
export async function buildFileSystemTree(opts) {
  const { tree, blobs } = await fetchRepoTree(opts);
  await hydrateAllFiles({ ...opts, tree, blobs });
  return tree;
}

function decodeBlob(blob) {
  if (blob.encoding === 'base64') {
    // Decode as UTF-8 text. Binary files (images, fonts) will come through
    // mangled — fine for running most Node/web repos, not a general VCS clone.
    const binary = atob(blob.content.replace(/\n/g, ''));
    try {
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return binary;
    }
  }
  return blob.content;
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

function parseEnvKeys(contents) {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.split('=')[0].trim());
}
