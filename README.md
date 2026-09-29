# Repo Runner

🚀 **[Live Demo → github-runner-kappa.vercel.app](https://github-runner-kappa.vercel.app)**

**Paste a GitHub URL → get a live demo.** Repo Runner detects a repo's stack,
installs its dependencies, runs it, and shows a live preview — automatically.

## Where repos run

Many repos run **entirely in your browser**, with no server at all:

| Stack | How |
|---|---|
| Node / Vite / React / Express | WebContainers (in-browser Node) |
| Static sites (HTML/CSS/JS) | Served from an in-browser web server |
| Python scripts | Pyodide (Python in WebAssembly) — `input()` works in the terminal |
| Jupyter notebooks | Run top to bottom in Pyodide; matplotlib figures are shown |
| Streamlit | stlite (Streamlit on Pyodide) |
| Anything else | A browsable file listing with the README |

Everything else runs on the **runner engine** (`backend/`), which installs each
language on first use — no manual setup:

| Stack | Engine |
|---|---|
| Python — Flask / FastAPI / Django / Gradio / Streamlit, any package | uv-managed Python |
| Java — Maven / Gradle / Spring Boot / Quarkus / plain `.java` | Temurin JDK 11 / 17 / 21 |
| Go · Rust · Ruby (Rails, Sinatra) · PHP (Laravel, Composer) · Bun · Deno | Portable toolchains |
| C / C++ — CMake, Makefile or loose sources | MinGW-w64 (Windows) / system GCC |
| .NET · Next.js · Node with native addons | Installed runtime |
| Monorepos (frontend + backend) | Both, wired together |
| Docker / compose | Docker Desktop, or the app inside it natively |

With the engine connected, Python repos use it too (full CPython, any package).
Console programs stream to the terminal, and you can type into it to answer prompts.

## Run it locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in Chrome or Edge. The engine auto-starts on port 3001.
Optionally copy `.env.example` to `.env` and add `VITE_GITHUB_TOKEN` for private repos.

Runtimes the engine downloads are kept in `backend/.runtimes` (on Windows, when
that path contains spaces, in `%LOCALAPPDATA%\repo-runner\runtimes`; set
`REPO_RUNNER_RUNTIMES` to choose another folder).

## Limits

- No GPU. Desktop GUI programs (tkinter, pygame, Qt) need a real display.
- In the browser sandbox, Next.js 15.5+ runs as Next.js 15.4 (newer versions don't
  work in WebContainers yet) with webpack instead of Turbopack; Bun, Turborepo and
  git-URL dependencies need the engine. The engine always uses the repo's own versions.
- Apps that need a real database or third-party keys may show errors until those
  are provided (Laravel demos fall back to SQLite automatically).
- In the browser, Python packages must have Pyodide builds or pure-Python wheels
  (numpy, pandas, matplotlib, scikit-learn and most pure packages work; PyTorch doesn't).
- On Windows with Smart App Control on, Windows may block programs the engine
  compiles (C/C++, Rust); the terminal says so when it happens.
- ⚠️ The engine runs repo code **natively, not sandboxed** — only run repos you trust.

## Structure

```
src/          UI — App.jsx; lib/: github (fetch), heuristics + browser-plan (routing),
              runner + static-runner (WebContainers), python-runner + python.worker (Pyodide),
              backend-runner (engine client)
backend/      server.js, detector.js, native-runner.js, auto-provision.js,
              preview-proxy.js, sandbox.js (Docker), Dockerfile
```

See [DEPLOY.md](DEPLOY.md) to deploy the UI and the engine.
