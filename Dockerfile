# syntax=docker/dockerfile:1

# ---------- base: tmux + gh + agent CLIs + toolchains (shared by dev and runtime) ----------
# python3/make/g++ also compile node-pty (no prebuilds).
FROM node:22-slim AS base
# Without a UTF-8 locale tmux renders every multibyte glyph as "_" (TUI borders,
# spinners, the Claude logo). C.UTF-8 ships with the base image.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git curl wget ca-certificates openssh-client procps ripgrep less jq vim \
      python3 python3-pip python3-venv make g++ unzip \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system credential."https://github.com".helper "!gh auth git-credential"

# Agent CLIs. claude + codex are npm packages; antigravity (agy) is a Go binary
# whose install script drops it under the invoking user's home — move it to
# /usr/local/bin because HOME is a volume mount at runtime.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Headless Chromium for the per-session browser pane (backend/src/browser.ts)
# and for agents' own playwright use. Fixed path because HOME is a volume at
# runtime; the version must match playwright-core in backend/package.json.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx --yes playwright@1.61.1 install --with-deps chromium

# Node as PID 1 never reaps chromium's orphans (zombie build-up); tini does.
# Separate layer so it doesn't bust the chromium download cache above.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Playwright MCP server: wired to each session's browser via claude --mcp-config
# (see backend/src/claude-hooks.ts). Connects over CDP; never launches browsers.
RUN npm install -g @playwright/mcp@0.0.78

# Docker CLI + compose for the sessions. No daemon in this image: DOCKER_HOST
# points at a docker:dind sibling (dev: compose service "dind"; prod: a
# privileged sidecar in the pod — see BACKLOG).
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       docker-ce-cli docker-compose-plugin docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
    && AGY="$(command -v agy || find /root -name agy -type f 2>/dev/null | head -1)" \
    && test -n "$AGY" \
    && cp "$AGY" /usr/local/bin/agy \
    && chmod +x /usr/local/bin/agy \
    && /usr/local/bin/agy --version

# tmux draws no status bar; the web UI has its own.
RUN printf 'set -g status off\n' > /etc/tmux.conf

# Colored prompt (user, cwd, git branch, ❯) + color ls/grep for the shell panes.
# System-wide so it applies regardless of what $HOME on the volume contains.
RUN cat >> /etc/bash.bashrc <<'EOF'

# verksted shell profile
if [ -n "$PS1" ]; then
  . /usr/lib/git-core/git-sh-prompt 2>/dev/null || true
  PS1='\[\e[38;5;179m\]\u\[\e[0m\] \[\e[38;5;110m\]\w\[\e[38;5;245m\]$(__git_ps1 " ⎇ %s" 2>/dev/null)\[\e[0m\]\n\[\e[38;5;114m\]❯\[\e[0m\] '
  alias ls='ls --color=auto'
  alias grep='grep --color=auto'
fi
EOF

# ---------- dev: compose services run this with source bind-mounted ----------
FROM base AS dev
WORKDIR /app

# ---------- build: compile frontend + backend, prod deps for backend ----------
# Same node base as runtime so node-pty's compiled .node binary matches the ABI.
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci
COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend
RUN npm run build --workspace frontend && npm run build --workspace backend
RUN rm -rf node_modules backend/node_modules frontend/node_modules \
    && npm ci --omit=dev --workspace backend \
    && mkdir -p backend/node_modules

# ---------- runtime: base + the built app ----------
FROM base AS runtime
ENV NODE_ENV=production \
    HOME=/data/home \
    PORT=8080 \
    REPOS_DIR=/data/repos \
    SESSIONS_DIR=/data/sessions \
    STATIC_DIR=/app/frontend/dist \
    TERM=xterm-256color
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "backend/dist/backend/src/index.js"]
