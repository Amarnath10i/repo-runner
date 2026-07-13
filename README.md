# Repo Runner

🚀 **[Live Demo → github-runner-kappa.vercel.app](https://github-runner-kappa.vercel.app)**

**Paste a GitHub URL → get a live demo.** Repo Runner detects a repo's stack,
installs its dependencies, runs it, and shows a live preview — automatically.

### Deployed on
- **Frontend**: [Vercel](https://github-runner-kappa.vercel.app)
- **Backend**: [Railway](https://repo-runner-production.up.railway.app)

## About

A zero-config runner for GitHub repos. It picks one of two paths on its own:

- **In-browser** (WebContainers) for pure Node.js/Vite/React/Express apps.
- **Local backend** (native, no Docker needed) for everything else — it clones
  with `git` and runs the app on your machine.

Just paste a URL and click **Fetch & Run**.

## Runs non-Node stacks too

| Stack | How |
|---|---|
| Node / Vite / React / Express | In-browser |
| Next.js · Bun | Native |
| Python — Flask / FastAPI / Django | Native |
| Python — **Streamlit / Gradio** (ML demos) | Native |
| Static sites (HTML/CSS/JS) | Served over HTTP |
| C / C++ | Compiled & run |
| Monorepos (frontend + backend) | Both, wired together |
| Docker / compose | Via Docker Desktop |

Also: token auto-loaded from `.env`, required env vars detected from code,
ports auto-detected, misspelled `requirements.txt` tolerated, Ollama used
automatically when running.

## Limits

- No GPU; Docker-only repos need Docker running; uninstalled runtimes (Go, Ruby,
  PHP, Java, C/C++ compiler) must be installed — it tells you which.
- Console/ML scripts run to the terminal but have no web preview.
- ⚠️ The backend runs repo code **natively, not sandboxed** — only run repos you
  trust.

## Run it

```bash
# optional: cp .env.example .env  and add VITE_GITHUB_TOKEN=...
npm install
npm run dev
```

Open `http://localhost:5173` in Chrome/Edge (backend auto-starts on 3001).

## Structure

```
src/          frontend — App.jsx, lib/{github,heuristics,ollama,runner,backend-runner}.js
backend/      server.js, detector.js, native-runner.js, sandbox.js, auto-provision.js
```
