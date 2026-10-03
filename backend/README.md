---
title: GitLive Engine
emoji: 🚀
colorFrom: red
colorTo: indigo
sdk: docker
app_port: 3001
pinned: false
short_description: Runner engine for GitLive — runs GitHub repos server-side
---

# GitLive runner engine

The server half of [GitLive](https://github.com/Amarnath10i/repo-runner): it clones a
GitHub repo, installs its toolchain and dependencies, starts it, and serves the running
app under `/preview/<session>/`. The GitLive UI uses it for repos a browser tab can't run
(Python web apps, PyTorch, Java, Go, Rust, C/C++, PHP, Ruby, .NET).

The block at the top of this file is the Hugging Face Space config, so this folder can be
uploaded to a Docker Space as-is. Deployment steps are in [DEPLOY.md](https://github.com/Amarnath10i/repo-runner/blob/main/DEPLOY.md).

Health check: `GET /api/status/health-check`.
