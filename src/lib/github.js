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

// Fetches the full recursive file tree, then downloads every blob and
// assembles it into the FileSystemTree shape @webcontainer/api expects:
// { name: { file: { contents } } | { directory: { ...children } } }
export async function buildFileSystemTree({ owner, repo, branch, token, onProgress }) {
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
  let done = 0;

  // Fetch blobs in small batches so we don't blow the rate limit / open
  // connection limit on large repos.
  const BATCH_SIZE = 8;
  for (let i = 0; i < blobs.length; i += BATCH_SIZE) {
    const batch = blobs.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (entry) => {
        const blob = await ghFetch(
          `/repos/${owner}/${repo}/git/blobs/${entry.sha}`,
          token
        );
        const contents = decodeBlob(blob);
        insertIntoTree(root, entry.path.split('/'), contents);
        done += 1;
        onProgress?.(`Downloaded ${done}/${blobs.length} files: ${entry.path}`);
      })
    );
  }

  return root;
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
  node[pathParts[pathParts.length - 1]] = { file: { contents } };
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
