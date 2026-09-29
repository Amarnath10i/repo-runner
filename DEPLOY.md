# Deploying Repo Runner

There are two parts:

- **The UI** (Vite app at the repo root) — deploy it to Vercel. On its own it runs
  Node, static sites, Python scripts, notebooks and Streamlit in the visitor's browser.
- **The runner engine** (`backend/`) — optional. Deploy it to run everything else
  (Java, Go, Rust, C/C++, PHP, Ruby, .NET, Python web apps…).

⚠️ The engine executes arbitrary repo code. Only expose one you're prepared to
have anyone run code on; keep it private (or behind your own auth) otherwise.

## UI → Vercel

1. Vercel dashboard → **New Project → Import** this repo.
2. Framework preset: **Vite**. `vercel.json` already sets the build and the
   COOP/COEP headers the in-browser runtimes need.
3. Environment variables (optional):
   - `VITE_BACKEND_URL` — your deployed engine's URL (see below).
   - `VITE_GITHUB_TOKEN` — only for private use; it's bundled into the page.
4. Deploy.

Without `VITE_BACKEND_URL`, visitors can still connect an engine running on
their own machine: when a repo needs one, the page shows the command to start it
and a **Connect local engine** button. The page never contacts the visitor's
localhost before they click it (browsers ask permission for that).

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
