# Repo Runner backend with the common language toolchains preinstalled.
# Go, Java, Rust, Bun and Deno are downloaded on first use by auto-provision.js
# (into /app/.runtimes — mount a volume there to keep them between deploys).
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl unzip ca-certificates \
      python3 python3-venv python3-pip \
      php-cli php-mbstring php-xml php-curl php-zip php-sqlite3 php-intl composer \
      ruby-full \
      build-essential cmake \
    && rm -rf /var/lib/apt/lists/*

# uv creates each Python project's environment (and fetches other Python versions).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN gem install bundler --no-document

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server.js"]
