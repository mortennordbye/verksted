# syntax=docker/dockerfile:1

# ---------- whisper: speech to text on the pod, so voice never leaves the network ----------
# Built in its own stage and copied in as two files: the compile needs cmake and
# the whole source tree, none of which belongs in the image that ships.
FROM debian:trixie-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
      git build-essential cmake ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.9.2 https://github.com/ggml-org/whisper.cpp /src \
    # GGML_NATIVE=OFF: with it on, ggml compiles fp16 NEON intrinsics that gcc
    # on aarch64 refuses to inline without an explicit -march, and the build dies.
    # Off also means the binary does not assume the CPU that built it, which
    # matters when this is built on an arm64 laptop and runs on an amd64 node.
    && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF \
       -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_SERVER=OFF \
    && cmake --build /src/build --config Release -j "$(nproc)" \
    && test -x /src/build/bin/whisper-cli
# base.en: the smallest model that transcribes a spoken sentence reliably. The
# larger ones are minutes of CPU per clip on a homelab node, which is not a
# thing you wait for mid-conversation.
RUN curl -fsSL -o /ggml-base.en.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
    && test -s /ggml-base.en.bin

# ---------- base: tmux + gh + agent CLIs + toolchains (shared by dev and runtime) ----------
# python3/make/g++ also compile node-pty (no prebuilds).
FROM node:24-trixie-slim AS base
# Without a UTF-8 locale tmux renders every multibyte glyph as "_" (TUI borders,
# spinners, the Claude logo). C.UTF-8 ships with the base image.
#
# TZ because cron patterns are wall-clock time, and so is every timestamp an
# agent reads inside a session. Left unset the container runs UTC, which fires
# "0 7 * * *" two hours late for half the year without saying so. tzdata is
# already in the base image; override with -e TZ for a bench somewhere else.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=Europe/Oslo
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
# The npm cache mount is never committed to a layer, so the ~300MB of tarballs
# these downloads leave behind stays out of the image and is reused on rebuild.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @anthropic-ai/claude-code @openai/codex

# Headless Chromium for the per-session browser pane (backend/src/browser.ts)
# and for agents' own playwright use. Fixed path because HOME is a volume at
# runtime; the version must match playwright-core in backend/package.json.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# --with-deps runs apt-get itself, so the lists it leaves behind are cleaned
# here rather than in the apt layers above.
RUN --mount=type=cache,target=/root/.npm \
    npx --yes playwright@1.62.1 install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# uv, for projects that pin a Python this image does not ship. trixie gives
# 3.13; a project asking for 3.12 gets a standalone build fetched into uv's
# cache on the first `uv venv --python 3.12`. That cache lives under HOME, which
# is a volume, so it survives a restart and is not baked in here — one
# interpreter per project, none of them in the image.
RUN curl -fsSL https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    && uv --version

# Playwright MCP server: wired to each session's browser via claude --mcp-config
# (see backend/src/claude-hooks.ts). Connects over CDP; never launches browsers.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g @playwright/mcp@0.0.79

# Docker CLI + compose for the sessions. No daemon in this image: DOCKER_HOST
# points at a docker:dind sibling (dev: compose service "dind"; prod: a
# privileged sidecar in the pod — see BACKLOG).
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    # Suite read from the base image rather than hardcoded, so a Debian bump
    # cannot silently leave this pointing at the previous release.
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       docker-ce-cli docker-compose-plugin docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*
# The installer drops a 180MB binary under /root/.local and we copy it out, so
# without the cleanup the layer carries the same binary twice. /root is not the
# runtime HOME (that is /data/home, a volume), so nothing reads what is removed.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
    && AGY="$(command -v agy || find /root -name agy -type f 2>/dev/null | head -1)" \
    && test -n "$AGY" \
    && cp "$AGY" /usr/local/bin/agy \
    && chmod +x /usr/local/bin/agy \
    && /usr/local/bin/agy --version \
    && rm -rf /root/.local /root/.cache /root/.npm /tmp/*

# What a session needs to know about its own environment, and a command that
# reports the live version of it. The daemon is a sibling, so a bind mount of a
# path it cannot see is mounted empty instead of failing — an agent that does
# not know that loses an afternoon to it. sandbox-doc.ts points every agent's
# global memory file here.
COPY runtime/SANDBOX.md /etc/verksted/SANDBOX.md
COPY runtime/vk /usr/local/bin/vk
# The assistant's toolset (assistant.ts spawns it over stdio). Baked into the
# image rather than resolved out of the build output, so the path is the same
# under tsx in dev and under node in the runtime image.
COPY runtime/verksted-mcp.mjs /etc/verksted/verksted-mcp.mjs
RUN chmod 0755 /usr/local/bin/vk

# Speech to text for the assistant's voice mode. ffmpeg is what turns whatever
# the browser recorded (webm/opus on Chrome, mp4/aac on Safari) into the 16 kHz
# mono WAV whisper wants; libgomp is whisper-cli's only runtime dependency.
# tini rides along here: node as PID 1 never reaps chromium's orphans (zombie
# build-up) and it does. Late enough that neither busts the chromium layer.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 tini \
    && rm -rf /var/lib/apt/lists/*
# The whole build output directory: whisper-cli links half a dozen ggml shared
# objects that live beside it, and cherry-picking them is how this broke once.
COPY --from=whisper /src/build/bin/ /opt/whisper/
COPY --from=whisper /ggml-base.en.bin /usr/local/share/whisper/ggml-base.en.bin
RUN echo /opt/whisper > /etc/ld.so.conf.d/whisper.conf \
    && ldconfig \
    && ln -s /opt/whisper/whisper-cli /usr/local/bin/whisper-cli \
    # Fails the build rather than the first person who tries to talk to it.
    && whisper-cli --help >/dev/null

# tmux draws no status bar; the web UI has its own. Its scrollback is also the
# only one the browser terminal has (see tmux.ts scrollHistory), and 2000 lines
# — the default — is a short afternoon of agent output.
RUN printf 'set -g status off\nset -g history-limit 20000\n' > /etc/tmux.conf

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
FROM node:24-trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN --mount=type=cache,target=/root/.npm npm ci
COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend
RUN npm run build --workspace frontend && npm run build --workspace backend
RUN --mount=type=cache,target=/root/.npm \
    rm -rf node_modules backend/node_modules frontend/node_modules \
    && npm ci --omit=dev --workspace backend \
    && mkdir -p backend/node_modules

# ---------- runtime: base + the built app ----------
FROM base AS runtime
ENV NODE_ENV=production \
    HOME=/data/home \
    PORT=8080 \
    REPOS_DIR=/data/repos \
    SESSIONS_DIR=/data/sessions \
    SCHEDULES_DIR=/data/schedules \
    STATIC_DIR=/app/frontend/dist \
    TERM=xterm-256color
# /data is an NFS volume, and libuv's default 4 threads run every fs call the
# backend makes — including the static index.html the health check reads. Four
# slow NFS reads would queue the health check behind them and get the pod
# restarted, taking every tmux session with it.
ENV UV_THREADPOOL_SIZE=16
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "backend/dist/backend/src/index.js"]
