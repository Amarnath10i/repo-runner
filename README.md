# Repo Runner — run Node.js GitHub repos instantly, in the browser

Paste a GitHub URL. It clones the repo entirely client-side (via GitHub's API),
optionally asks a **local Ollama model** to read the README/manifests and work
out the real install/start commands, lets you fill in any env vars it needs,
then boots a real Node environment **inside your browser tab** (via
[WebContainers](https://webcontainer.io)), installs dependencies, and shows a
live preview. No backend required for Node projects.

## Two different tokens, two different jobs

- **GitHub personal access token** (Advanced panel, "GitHub"): raises the
  GitHub API rate limit from 60 req/hour to 5,000 req/hour, and is required
  for private repos. Read-only, `public_repo` scope is enough.
- **Ollama**: not a token at all — it's a local LLM server on your own
  machine (`http://localhost:11434` by default). It reads the repo's README
  and manifest files and tells this app what to actually run. These two are
  unrelated; you can use either, both, or neither.

## What this can and can't do (read this first)

- ✅ Works for **Node.js / npm / yarn / pnpm** projects (Vite, Next.js\*, Express, React, etc.)
- ✅ No server required for Node projects — runs entirely in the visitor's browser tab
- ✅ With Ollama enabled: reads the README + `package.json` + other manifests
  and figures out real install/start commands, instead of guessing
- ✅ Auto-detects env vars from `.env.example` / `.env.sample`, plus any the
  LLM spots mentioned in the README
- ✅ Tells you clearly, before attempting anything, when a repo **can't** run
  in a browser sandbox (see below) — instead of failing confusingly halfway
  through an install
- ❌ **Cannot run non-Node stacks** — Python, ML/training repos, anything
  needing a GPU, Docker, or compiled native dependencies. This is a hard limit
  of WebContainers (a browser-based Node.js sandbox), not something more
  README-parsing can fix. Running those for real needs an actual backend
  (a Docker container or cloud sandbox service) — a different, larger project
  than this frontend-only scaffold.
- ❌ Binary files (images, fonts) come through as text and may be mangled —
  fine for running the app's code, not a general-purpose git clone
- ❌ Unauthenticated GitHub API calls are capped at 60/hour per IP — add a
  personal access token in the "Advanced" panel in the UI if you hit this
- ⚠️ Next.js works for `npm run dev` but WebContainers has some rough edges
  with certain native bindings — pure Vite/React/Express repos are the most
  reliable starting point
- ⚠️ A "public repo" is not the same as "safe to run." Anyone can put
  malicious code in a public repo. Your actual safety boundary here is the
  browser sandbox (WebContainers), not the fact that the URL is public —
  worth knowing even though this MVP has no other security controls.

## Using the Ollama analyzer

1. Install [Ollama](https://ollama.com) and pull a model, e.g. `ollama pull llama3.1`
2. Start it with CORS open to this app's origin (required, or the browser
   will block the request):
   ```bash
   OLLAMA_ORIGINS=* ollama serve
   ```
3. In the app's "Advanced: local Ollama" panel, make sure it's enabled and the
   endpoint/model match your setup (defaults: `http://localhost:11434`, `llama3.1`)
4. Paste a repo URL and run — the terminal will show the model's reasoning and,
   if the repo isn't runnable in-browser, exactly why.

If Ollama isn't running or isn't reachable, the app automatically falls back
to the old heuristic (`npm install` + first of `dev`/`start`/`preview` scripts)
so it still works without it.

## Requirements

- Node.js 18+ and npm
- A **Chromium-based browser** (Chrome, Edge, Arc) — WebContainers does not
  currently support Firefox or Safari
- VS Code (optional, just for editing)

## Run it in VS Code

1. Open this folder in VS Code (`File → Open Folder...`)
2. Open the integrated terminal (`` Ctrl+` `` / `` Cmd+` ``)
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the dev server:
   ```bash
   npm run dev
   ```
5. Open the printed URL (usually `http://localhost:5173`) in **Chrome or Edge**
6. Paste a GitHub repo URL, e.g. `https://github.com/vitejs/vite-plugin-react-starter`
   and click **Fetch & run**

That's it — no `.env` file, no API keys needed to run this app itself. The
only keys you'll ever be asked for are the ones a *target repo* needs, and
those are entered per-run in the UI, kept in memory only, and never sent to
any server other than being written into that repo's own sandbox filesystem.

## Why some repos take a few seconds the first time

There's no backend cache in this MVP, so the very first run of any given repo
does a real `npm install` inside the WebContainer (same as running it
locally). We talked through caching strategies (lockfile-hash caching,
pre-warmed sandbox pools, snapshot/fork) to make this near-instant on repeat
runs — those are the natural next layer to add once this base is working end
to end.

## Project structure

```
github-runner/
├── index.html
├── vite.config.js        # sets COOP/COEP headers — required for WebContainers
├── src/
│   ├── main.jsx
│   ├── App.jsx            # UI: URL form, env var form, terminal, preview
│   ├── App.css
│   └── lib/
│       ├── github.js      # GitHub API: parse URL, fetch tree, decode blobs
│       └── runner.js       # WebContainer boot, mount, install, run
```

## Troubleshooting

- **Blank preview / WebContainer fails to boot**: check the browser console —
  it's almost always the COOP/COEP headers missing (only an issue if you've
  changed the Vite config or are serving through some other proxy).
- **"GitHub API rate limit hit"**: add a token in the Advanced panel (read-only,
  public repo scope is enough): https://github.com/settings/tokens
- **`npm install` hangs on a huge repo**: some very large monorepos are slow
  even locally — this isn't WebContainer-specific.
