# syntax=docker/dockerfile:1

# ---------- whisper: speech to text on the pod, so voice never leaves the network ----------
# Built in its own stage and copied in as two files: the compile needs cmake and
# the whole source tree, none of which belongs in the image that ships.
# Digest as well as tag on every FROM: a tag is a pointer the publisher can move,
# and "the image CI built" and "the image a laptop built an hour later" were only
# the same thing by luck. Dependabot updates both halves together.
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a AS whisper
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
#
# By revision rather than `resolve/main`, which is a branch and therefore a
# pointer anyone with write access to that repository can move. A revision is
# the content, so there is nothing left to checksum.
ARG WHISPER_MODEL_REV=5359861c739e955e79d9a303bcbc70fb988958b1
RUN curl -fsSL -o /ggml-base.en.bin \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REV}/ggml-base.en.bin" \
    && test -s /ggml-base.en.bin

# ---------- base: tmux + gh + agent CLIs + toolchains (shared by dev and runtime) ----------
# python3/make/g++ also compile node-pty (no prebuilds).
FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS base
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
      # pdftotext and pandoc: how the documents on the share become text the
      # assistant can search (backend/src/docs.ts). Both read; neither writes.
      poppler-utils pandoc \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system credential."https://github.com".helper "!gh auth git-credential"

# Headless Chromium for the per-session browser pane (backend/src/browser.ts)
# and for agents' own playwright use. Fixed path because HOME is a volume at
# runtime; the version must match playwright-core in backend/package.json.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# --with-deps runs apt-get itself, so the lists it leaves behind are cleaned
# here rather than in the apt layers above.
RUN --mount=type=cache,target=/root/.npm \
    npx --yes playwright@1.63.0 install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# uv, for projects that pin a Python this image does not ship. trixie gives
# 3.13; a project asking for 3.12 gets a standalone build fetched into uv's
# cache on the first `uv venv --python 3.12`. That cache lives under HOME, which
# is a volume, so it survives a restart and is not baked in here — one
# interpreter per project, none of them in the image.
#
# Pinned, and by a versioned URL rather than a checksum of the script: astral
# serves each release's installer at its own path, and that installer will only
# fetch the matching release. `curl | sh` of the unversioned one was a promise
# that whatever they publish next is what this image runs.
ARG UV_VERSION=0.12.17
RUN curl -fsSL "https://astral.sh/uv/${UV_VERSION}/install.sh" \
      | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    && uv --version | grep -q "$UV_VERSION"

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

# kubectl, for sessions that run in the cluster this image is deployed to. In
# the pod there is no kubeconfig to write: kubectl finds the projected
# ServiceAccount token by itself, so what it can do is decided entirely by the
# RBAC bound to that account (homelab: k8s/talos/apps/verksted/rbac.yaml).
# Outside the pod — a laptop, CI — there is no token and every command simply
# fails to find a cluster, which is the correct outcome.
#
# The minor is pinned to the cluster's (Genesis is on 1.35): pkgs.k8s.io serves
# one repository per minor, and kubectl only promises to work one minor either
# side of the apiserver. Bump this together with a Talos/Kubernetes upgrade.
RUN curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key \
      -o /etc/apt/keyrings/kubernetes.asc \
    && chmod a+r /etc/apt/keyrings/kubernetes.asc \
    # Armored key referenced directly, as in the docker block above — this image
    # has no gnupg, so there is nothing to dearmor with.
    && echo "deb [signed-by=/etc/apt/keyrings/kubernetes.asc] https://pkgs.k8s.io/core:/stable:/v1.35/deb/ /" \
       > /etc/apt/sources.list.d/kubernetes.list \
    && apt-get update && apt-get install -y --no-install-recommends kubectl \
    && rm -rf /var/lib/apt/lists/* \
    && kubectl version --client

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

# Text to speech, the other direction, and on the pod for the same reason: the
# browser's speechSynthesis is the one part of voice mode that sounded like a
# machine, and on iOS it is also the worst of the three — Safari never exposes
# Siri or the enhanced voices to a web page, so the picker could only choose
# between bad ones. Kokoro is a small neural model that sounds like a person.
#
# fp16 rather than the int8 build of the same model: measured on this image,
# int8 runs at 1.66x real time and fp16 at 0.39x, so the smaller file is four
# times slower — CPUs compute in floats and the quantised ops are not
# accelerated. Phonemisation comes from espeakng-loader inside the wheel, so
# there is no espeak-ng package to install and keep in step.
ENV KOKORO_HOME=/usr/local/share/kokoro
# The model files are two release assets and a release asset can be replaced in
# place, so `test -s` was checking that something arrived rather than that the
# right thing did. Both are the fp16 build of kokoro v1.0; the sums were taken
# from the published files on 2026-09-20.
ARG KOKORO_ONNX_SHA256=c1610a859f3bdea01107e73e50100685af38fff88f5cd8e5c56df109ec880204
ARG KOKORO_VOICES_SHA256=bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d
COPY runtime/kokoro-requirements.txt /etc/verksted/kokoro-requirements.txt
RUN uv venv /opt/kokoro/venv -q \
    && uv pip install -q --python /opt/kokoro/venv/bin/python \
       -r /etc/verksted/kokoro-requirements.txt \
    && mkdir -p "$KOKORO_HOME" \
    && curl -fsSL -o "$KOKORO_HOME/kokoro.onnx" \
       https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx \
    && curl -fsSL -o "$KOKORO_HOME/voices.bin" \
       https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin \
    && echo "$KOKORO_ONNX_SHA256  $KOKORO_HOME/kokoro.onnx" | sha256sum -c - \
    && echo "$KOKORO_VOICES_SHA256  $KOKORO_HOME/voices.bin" | sha256sum -c -
# What a laptop's shell has and a slim image does not. Everyday tools for the
# terminal panes and the agents in them: fd/bat/fzf/tree for finding and
# reading, htop for "what is eating the pod", shellcheck for the scripts they
# write, sqlite3 and psql for the databases the projects here use, dig/nc/ping
# for "is it the network", rsync/zip/xz for moving things, and bash-completion
# so kubectl and gh can be driven with a thumb on a phone keyboard. Late in the
# stage, after the heavy layers, so adding a tool here never rebuilds chromium
# or the voice models.
RUN apt-get update && apt-get install -y --no-install-recommends \
      fd-find bat fzf tree htop shellcheck sqlite3 postgresql-client \
      bind9-dnsutils netcat-openbsd iputils-ping rsync zip xz-utils file \
      bash-completion \
    && rm -rf /var/lib/apt/lists/* \
    # Debian namespaces these two; nobody types "fdfind".
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && ln -s /usr/bin/batcat /usr/local/bin/bat
# yq for the manifests every session here ends up editing, and helm for the
# charts ArgoCD renders — "helm template" is how a change is checked before the
# cluster sees it. Both are single static binaries pinned by version; bump by
# hand with a look at the changelog, like kubectl above.
#
# Both are checked against the sum published with the release, per
# architecture, because this image is built on an arm64 laptop as well as an
# amd64 runner. helm is piped into tar, so it is written to a file first: a
# checksum after the extract would be checking what the archive already got to
# do.
ARG YQ_VERSION=v4.53.6
ARG HELM_VERSION=v4.2.4
ARG YQ_SHA256_amd64=c5f056448f973ae7d39b5401949648a78f2dc1947d6a8eb65be60d5c504b9385
ARG YQ_SHA256_arm64=88a1016bc1d657375a35864e4f44b6f333df8ff97b559f51bba0adcb2169df09
ARG HELM_SHA256_amd64=c306b46f719b0a4da32d0f78ee21bf90ce8d602f15b22ab753f0674d1670a7f3
ARG HELM_SHA256_arm64=564de2191b881e9f71b5606b25345821ea1682f06ab90499d3ab22b530176da1
RUN arch="$(dpkg --print-architecture)" \
    && eval "yq_sha=\$YQ_SHA256_${arch}" \
    && eval "helm_sha=\$HELM_SHA256_${arch}" \
    && test -n "$yq_sha" && test -n "$helm_sha" \
    && curl -fsSL -o /usr/local/bin/yq \
       "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${arch}" \
    && echo "$yq_sha  /usr/local/bin/yq" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/yq \
    && curl -fsSL -o /tmp/helm.tar.gz \
       "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz" \
    && echo "$helm_sha  /tmp/helm.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/helm.tar.gz -C /usr/local/bin --strip-components=1 "linux-${arch}/helm" \
    && rm -f /tmp/helm.tar.gz \
    && yq --version && helm version --short
# pnpm and yarn through corepack, so a project's packageManager field is
# honoured instead of failing on the first install. Shims only: the versions
# themselves download on first use into $HOME, which is the volume.
RUN corepack enable
# Completions generated once here, into the directory bash-completion loads
# from lazily on the first Tab after each command — not /etc/bash_completion.d,
# which is sourced whole on every shell start. kubectl's alone is 15k lines of
# bash, and a tmux pane opening on a phone should not pay for that each time.
RUN d=/usr/share/bash-completion/completions && mkdir -p "$d" \
    && kubectl completion bash > "$d/kubectl" \
    && helm completion bash > "$d/helm" \
    && gh completion -s bash > "$d/gh" \
    && docker completion bash > "$d/docker"

# tmux draws no status bar; the web UI has its own. Its scrollback is also the
# only one the browser terminal has (see tmux.ts scrollHistory), and 2000 lines
# — the default — is a short afternoon of agent output.
RUN printf 'set -g status off\nset -g history-limit 20000\n' > /etc/tmux.conf

# Colored prompt (user, cwd, git branch, ❯) + color ls/grep for the shell panes.
# System-wide so it applies regardless of what $HOME on the volume contains.
RUN cat >> /etc/bash.bashrc <<'EOF'

# verksted shell profile
export EDITOR=vim
if [ -n "$PS1" ]; then
  . /usr/lib/git-core/git-sh-prompt 2>/dev/null || true
  PS1='\[\e[38;5;179m\]\u\[\e[0m\] \[\e[38;5;110m\]\w\[\e[38;5;245m\]$(__git_ps1 " ⎇ %s" 2>/dev/null)\[\e[0m\]\n\[\e[38;5;114m\]❯\[\e[0m\] '
  alias ls='ls --color=auto'
  alias ll='ls -lah --color=auto'
  alias grep='grep --color=auto'
  alias k=kubectl
  # Tab completion for git, gh, kubectl, helm, docker and the rest. The k alias
  # gets kubectl's on its first Tab: the lazy loader only knows command names.
  . /usr/share/bash-completion/bash_completion 2>/dev/null || true
  _k() {
    _comp_load kubectl 2>/dev/null || __load_completion kubectl 2>/dev/null
    complete -o default -F __start_kubectl k && __start_kubectl "$@"
  }
  complete -o default -F _k k
  # Ctrl-R history search and Ctrl-T file pick through fzf.
  eval "$(fzf --bash 2>/dev/null)" || true
  # One history for every pane, written as it happens: HOME is the volume, so
  # what was typed in a session last week is still there, and a pane that
  # dies with the pod does not take its commands with it.
  HISTSIZE=100000
  HISTFILESIZE=200000
  HISTCONTROL=ignoreboth
  shopt -s histappend
  PROMPT_COMMAND="history -a${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
EOF

# ---------- the volatile tail of the base stage ----------
# Everything below changes often — a CLI pin, a prompt, the MCP server — and
# everything above it does not. Kept in this order so a bump rebuilds these
# layers alone instead of chromium, whisper and the voice models behind them
# (the audit's O-11: verksted-mcp.mjs alone had 23 commits since August, and
# each one used to re-download the lot).

# Agent CLIs. claude + codex are npm packages, as is the playwright MCP server
# that wires each session's browser to claude (backend/src/claude-hooks.ts);
# antigravity (agy) is a Go binary whose install script drops it under the
# invoking user's home — moved to /usr/local/bin because HOME is a volume mount
# at runtime.
#
# The three npm ones are pinned in runtime/cli/package.json, so which version
# ships is a line in a file dependabot watches rather than whatever the registry
# served on the day a layer was cached. agy has no version to pin: its installer
# takes no version argument and the binary self-updates in the background on the
# pod anyway, so what is here is a starting point rather than a pin.
#
# The npm cache mount is never committed to a layer, so the ~300MB of tarballs
# these downloads leave behind stays out of the image and is reused on rebuild.
COPY runtime/cli/package.json /etc/verksted/agent-clis.json
RUN --mount=type=cache,target=/root/.npm \
    set -- $(node -p "const d=require('/etc/verksted/agent-clis.json').dependencies; Object.entries(d).map(([n,v]) => n + '@' + v).join(' ')") \
    && test "$#" -eq 3 \
    && npm install -g "$@" \
    && claude --version && codex --version
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
# Strips AI attribution from every commit a session makes, in every repo. The
# ban lives in CLAUDE.md, but that is an instruction to an agent rather than a
# guarantee: one Co-authored-by got through and put "claude" in the repo's
# GitHub contributors, which cost a 47-commit rewrite to undo. System-wide
# because the commits come from agents in REPOS_DIR, not from this repo alone.
COPY runtime/git-hooks/ /etc/verksted/git-hooks/
# The maintainer: the prompts its scheduled stages run (maintainer.ts reads
# them from MAINTAINER_DIR) and the PreToolUse hook that stands in for the
# permission prompts an unattended run has nobody to answer (claude-hooks.ts).
COPY runtime/maintainer/ /etc/verksted/maintainer/
COPY runtime/vk-guard /usr/local/bin/vk-guard
COPY runtime/vk-signoff /usr/local/bin/vk-signoff
RUN chmod 0755 /usr/local/bin/vk /usr/local/bin/vk-guard /usr/local/bin/vk-signoff /etc/verksted/git-hooks/* \
    && git config --system core.hooksPath /etc/verksted/git-hooks

# The worker the backend talks to (see backend/src/tts.ts). Baked in beside the
# other runtime pieces rather than resolved out of the build output, so the path
# is the same under tsx in dev and under node in the image.
COPY runtime/vk-say.py /etc/verksted/vk-say.py
# Loads the model and synthesises one line, which fails the build rather than
# the first person who asks it to speak.
RUN echo '{"text":"build check","voice":"af_heart","out":"/tmp/build-check.wav"}' \
      | /opt/kokoro/venv/bin/python /etc/verksted/vk-say.py \
    && test -s /tmp/build-check.wav && rm -f /tmp/build-check.wav

# ---------- dev: compose services run this with source bind-mounted ----------
FROM base AS dev
WORKDIR /app

# ---------- build: compile frontend + backend, prod deps for backend ----------
# Same node base as runtime so node-pty's compiled .node binary matches the ABI.
FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS build
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
# The production install skips install scripts and takes node-pty's build from
# the install above. node-pty is the only production dependency with a script,
# it has no prebuilds, and compiling it a second time here produced the same
# binary the first install had just built.
RUN --mount=type=cache,target=/root/.npm \
    mv node_modules/node-pty/build /tmp/node-pty-build \
    && rm -rf node_modules backend/node_modules frontend/node_modules \
    && npm ci --omit=dev --workspace backend --ignore-scripts \
    && mv /tmp/node-pty-build node_modules/node-pty/build \
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
# For `docker run` and compose; the cluster uses its own probes. The health route
# answers from the process, not the volume, so a slow NFS read does not fail it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health > /dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "backend/dist/backend/src/index.js"]
