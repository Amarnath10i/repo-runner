# Deploying Repo Runner

⚠️ **Read this first.** The "run any repo" backend is designed to run **locally**.
In the cloud it can only reliably do **analyze/detect** and let **Node repos run
in-browser (WebContainers)**. The native "run Python/Go/etc." path needs dynamic
ports and runs untrusted code, which a shared cloud host can't safely expose. So:

- **Vercel (frontend)** → fully works for the in-browser (Node) path. Recommended.
- **Railway (backend)** → optional; gives analyze/detect only.

## Frontend → Vercel

1. Push this repo to GitHub (done: `Amarnath10i/repo-runner`).
2. In the Vercel dashboard: **New Project → Import** this repo.
3. Framework preset: **Vite**. Build/output are already set in `vercel.json`
   (`vite build` → `dist`) along with the required COOP/COEP headers.
4. Env vars (Project → Settings → Environment Variables):
   - `VITE_GITHUB_TOKEN` = your GitHub token (optional; raises API limits)
   - `VITE_BACKEND_URL` = your Railway backend URL (only if you deploy the backend)
5. Deploy.

CLI alternative:
```bash
npm i -g vercel
vercel        # first run links the project
vercel --prod
```

## Backend → Railway (optional)

1. Railway dashboard → **New Project → Deploy from GitHub repo** → this repo.
2. Set **Root Directory** to `backend`.
3. Start command is `npm start` (already in `backend/package.json`).
4. Railway injects `PORT`; the server already binds `process.env.PORT`.
5. Copy the public URL and set it as `VITE_BACKEND_URL` on Vercel.

Note: Railway's Node image has Node only — Python/other runtimes and Docker
aren't available, so only Node analyze and in-browser runs work there.
