# Deploying Repo Runner

There are two parts:

- **The UI** (Vite app at the repo root) — deploy it to Vercel. On its own it runs
  Node, static sites, Python scripts, notebooks and Streamlit in the visitor's browser.
- **The runner engine** (`backend/`) — optional. Deploy it to run everything else
  (Java, Go, Rust, C/C++, PHP, Ruby, .NET, Python web apps…).

⚠️ The engine executes arbitrary repo code. Only expose one you're prepared to
have anyone run code on; keep it private (or behind your own auth) otherwise.

## UI → Vercel

1. Vercel dashboard → **New Project → Import** this repo (leave Root Directory empty).
2. Nothing to configure for the build: `vercel.json` sets the Vite build, the
   COOP/COEP headers the in-browser runtimes need, SPA routing, asset caching,
   and the `/api/github` function.
3. Environment variables (all optional):
   - `GITHUB_TOKEN` — a read-only GitHub token (fine-grained, public repos). Used
     server-side by `api/github.js` when a visitor's own 60 requests/hour run out;
     it's never sent to the browser. Recommended.
   - `VITE_BACKEND_URL` — your deployed engine's URL (see below).
   - `VITE_GITHUB_TOKEN` — don't set this on a public deployment: it's bundled
     into the page. Visitors can enter their own token with the **Token** button.
4. Deploy.

Without `VITE_BACKEND_URL`, visitors can still connect an engine: when a repo
needs one, the page shows the command to run it locally and a URL box
(`http://localhost:3001` by default, or any deployed engine) with a **Connect
engine** button. The page never contacts the visitor's localhost before they click
it — Chrome asks them to allow local network access at that point.

Browsers: Chrome, Edge and Firefox run everything. Safari can't isolate the page
(no `credentialless` COEP), so Node repos don't run in it in-browser; the page
says so.

WebContainers (the in-browser Node runtime) are free for personal and
open-source use; a commercial, for-profit deployment needs a
[StackBlitz license](https://webcontainers.io/enterprise).

## Engine → Railway / Render / Fly

`backend/Dockerfile` builds an image with Python, PHP + Composer, Ruby, GCC and
CMake preinstalled; Go, Java, Rust, Bun and Deno are downloaded on first use.

**Railway:** New Project → Deploy from GitHub repo → set **Root Directory** to
`backend` (the Dockerfile is picked up automatically) → generate a public domain.
Railway injects `PORT`; the server listens on it.

**Render / Fly:** point a Docker service at `backend/Dockerfile`.

Then set `VITE_BACKEND_URL` on Vercel to the engine's public URL and redeploy.

Previews from a deployed engine are served under
`https://<engine>/preview/<session>/` on the same port. Mount a volume at
`/app/.runtimes` to keep downloaded toolchains between deploys.

## Local engine

```bash
git clone https://github.com/Amarnath10i/repo-runner
cd repo-runner/backend && npm install && npm start
```

Each preview gets its own port on `localhost`.
