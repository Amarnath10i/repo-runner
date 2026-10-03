# Repo Runner backend with the common language toolchains preinstalled.
# Go, Java, Rust, Bun and Deno are downloaded on first use by auto-provision.js
# (into /app/.runtimes — mount a volume there to keep them between deploys).
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git git-lfs curl unzip ca-certificates \
      python3 python3-venv python3-pip \
      php-cli php-mbstring php-xml php-curl php-zip php-sqlite3 php-intl composer \
      ruby-full \
      build-essential cmake \
    && rm -rf /var/lib/apt/lists/*

# uv creates each Python project's environment (and fetches other Python versions).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN gem install bundler --no-document && git lfs install --system

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# BUNDLE_PATH: gems go inside each cloned repo, so bundle install needs no root.
ENV NODE_ENV=production \
    HOME=/home/node \
    BUNDLE_PATH=vendor/bundle

# Run as the image's non-root user (uid 1000), as Hugging Face Spaces require.
# Clones and downloaded toolchains are written under /app.
RUN mkdir -p .repos .runtimes && chown -R node:node /app
USER node

EXPOSE 3001
CMD ["node", "server.js"]
