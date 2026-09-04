# prsnooze — virtual PR reviewer
#
# Ships node, git, gh, Claude Code, and Codex CLI. Provider and gh auth are
# completed after startup and persist in named volumes across rebuilds.

FROM node:22-slim

# OS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git openssh-client gnupg less \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) — official install per cli.github.com
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Review providers (npm-distributed)
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# App
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

# Non-root user with persistent home dirs (mounted as volumes)
RUN useradd -m -s /bin/bash prsnooze \
  && mkdir -p /home/prsnooze/.prsnooze \
              /home/prsnooze/.claude \
              /home/prsnooze/.codex \
              /home/prsnooze/.config/gh \
  && chown -R prsnooze:prsnooze /home/prsnooze /app

USER prsnooze
ENV HOME=/home/prsnooze \
    PRSNOOZE_HOME=/home/prsnooze/.prsnooze \
    PORT=8284

EXPOSE 8284

# Skip preflight here — that's for local quickstart. Inside the container,
# you'll run `claude` and `gh auth login` interactively the first time.
CMD ["node", "bin/start.js", "--no-check"]
