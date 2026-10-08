# Per-repo harbor task Dockerfile for human-essentials (rubyforgood, Rails 8.0 / Ruby 3.4.3).
#
# Mirrors the Explore container's runtime stack (Ruby 3.4.3 + Postgres @ en_US.UTF-8 +
# Chromium) so workers authoring code-execution tasks against human-essentials can run
# rspec/rake inside the harbor task container. Unlike the Explore image (bind-mount +
# deps at post-create), the harbor image BAKES the workspace (COPY workspace/) and
# installs deps at build, then git-commits a baseline so the grader diffs agent changes.
FROM ruby:3.4.3
ARG TOOLKIT_BUILD_ID=dev

# System deps: Postgres bundled in-image, libpq for the pg gem, chromium for Cuprite
# system specs (chromium works on amd64 + arm64; google-chrome is amd64-only), locales
# for the en_US.UTF-8 collation fix, python3 (bookworm ships 3.11 ≥ 3.10, which the
# reduced-toolset str_replace_editor needs), jq for test.sh.
RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql postgresql-client libpq-dev \
      chromium fonts-liberation \
      locales python3 \
      git sudo curl ca-certificates gnupg xz-utils jq \
 && rm -rf /var/lib/apt/lists/*

# Ferrum (Cuprite) auto-detects the browser by name; symlink the google-chrome names.
RUN ln -sf /usr/bin/chromium /usr/local/bin/google-chrome \
 && ln -sf /usr/bin/chromium /usr/local/bin/google-chrome-stable

# Node 18 (arch-aware) — parity with the Explore image; also covers asset tooling.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) nodearch=x64;; arm64) nodearch=arm64;; *) echo "unsupported arch: $arch" >&2; exit 1;; esac; \
    curl -fsSL "https://nodejs.org/dist/v18.20.5/node-v18.20.5-linux-${nodearch}.tar.xz" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.xz; node --version

# Match Gemfile.lock "BUNDLED WITH 2.7.1".
RUN gem install bundler -v 2.7.1

# Locale + Postgres collation: rebuild the cluster under en_US.UTF-8 (the apt cluster
# defaults to C.UTF-8 → byte-order, which breaks specs asserting locale-aware ordering
# like "laRue" before "Ste. Anne"). Matches the collation CI's postgres image uses.
RUN sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
 && locale-gen \
 && PG_VERSION=$(ls /etc/postgresql) \
 && pg_dropcluster "${PG_VERSION}" main \
 && LANG=en_US.UTF-8 pg_createcluster --locale en_US.UTF-8 "${PG_VERSION}" main
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Postgres trust auth (applied AFTER pg_createcluster, which regenerates these files).
RUN PG_VERSION=$(ls /etc/postgresql) \
 && printf 'local all all trust\nhost all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\nhost all all 0.0.0.0/0 trust\n' > "/etc/postgresql/${PG_VERSION}/main/pg_hba.conf" \
 && echo "listen_addresses='*'" >> "/etc/postgresql/${PG_VERSION}/main/postgresql.conf"

# config/database.yml reads PG_USERNAME (default postgres) / PG_HOST (default localhost).
ENV PG_USERNAME=postgres
ENV PG_HOST=localhost
# spec/rails_helper.rb passes Chrome --no-sandbox only when ENV["DOCKER"] is set.
ENV DOCKER=1

# Install Claude Code globally (the grader in test.sh runs `claude`). Retry, then FAIL
# THE BUILD if `claude` isn't on PATH — a missing grader CLI silently zeros every reward,
# so a broken image must never be cached. Download-to-file (not `curl | bash`) so curl's
# real exit gates the retry.
ARG CLAUDE_CODE_MIN=2.1.251
RUN for i in 1 2 3; do \
      if curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh && bash /tmp/claude-install.sh; then break; fi; \
      echo "WARNING: claude install attempt $i failed; retrying in 5s" >&2; sleep 5; \
    done; \
    rm -f /tmp/claude-install.sh; \
    for p in /root/.claude-code/claude /root/.local/bin/claude "$(find /root -name claude -type f 2>/dev/null | head -1)"; do \
      [ -n "$p" ] && [ -x "$p" ] && ln -sf "$p" /usr/local/bin/claude && break; \
    done; \
    command -v claude >/dev/null 2>&1 || { echo "FATAL: claude CLI not installed — the grader (test.sh) needs it" >&2; exit 1; }; \
    _v="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"; \
    [ "$(printf '%s\n%s\n' "$CLAUDE_CODE_MIN" "$_v" | sort -V | head -1)" = "$CLAUDE_CODE_MIN" ] \
      || { echo "FATAL: claude $_v is older than $CLAUDE_CODE_MIN, the minimum the grader needs" >&2; exit 1; }; \
    echo "claude $_v installed at $(command -v claude)"

USER root

# --- Playwright + Chromium, when the task opts in ----------------------------
# Installed only when task.toml sets `[metadata] browser = true`. A Dockerfile cannot read
# task.toml, so build-workspace.sh writes that answer to environment/browser-optin.
# Self-contained under /opt — the member's own runtime is untouched.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
COPY browser-optin /tmp/browser-optin
RUN set -eu; \
    if [ "$(cat /tmp/browser-optin)" != "1" ]; then echo "browser: task did not opt in; skipping Playwright"; exit 0; fi; \
    set -x; \
    apt-get update -qq; \
    apt-get install -y -qq --no-install-recommends \
       xz-utils \
       libxcomposite1 \
       libxdamage1 \
       libxfixes3 \
       libxrandr2 \
       libasound2 \
       libatk1.0-0 \
       libatk-bridge2.0-0 \
       libatspi2.0-0 \
       libcups2 \
       libdbus-1-3 \
       libgbm1 \
       libnspr4 \
       libnss3 \
       libxkbcommon0 \
       libpango-1.0-0 \
       libcairo2 \
       libxshmfence1 \
       libx11-xcb1 \
       libxcb-dri3-0 \
       libdrm2; \
    rm -rf /var/lib/apt/lists/*; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) nodearch=x64;; arm64) nodearch=arm64;; *) echo "unsupported arch: $arch" >&2; exit 1;; esac; \
    curl -fsSL "https://nodejs.org/dist/v20.19.5/node-v20.19.5-linux-${nodearch}.tar.xz" -o /tmp/pw-node.tar.xz; \
    mkdir -p /opt/pw-node; \
    tar -xJf /tmp/pw-node.tar.xz -C /opt/pw-node --strip-components=1; \
    rm /tmp/pw-node.tar.xz; \
    export npm_config_prefix=/opt/pw-node PATH="/opt/pw-node/bin:$PATH"; \
    /opt/pw-node/bin/npm install -g playwright@1.56.0; \
    test -d /opt/pw-node/lib/node_modules/playwright; \
    /opt/pw-node/bin/node /opt/pw-node/lib/node_modules/playwright/cli.js install chromium; \
    printf '#!/bin/sh\nNODE_PATH=/opt/pw-node/lib/node_modules exec /opt/pw-node/bin/node "$@"\n' > /usr/local/bin/pw; \
    chmod +x /usr/local/bin/pw; \
    printf 'const{chromium}=require("playwright");(async()=>{const b=await chromium.launch();const p=await b.newPage();await p.setContent("<h1 id=t>ok</h1>");if(await p.textContent("#t")!=="ok")throw new Error("bad render");await b.close();console.log("chromium OK");})()\n' > /tmp/pw-check.js; \
    pw /tmp/pw-check.js; \
    rm -f /tmp/pw-check.js

WORKDIR /workspace
COPY workspace/ .

# Block CC's network tools — agent should execute code locally, not fetch.
RUN mkdir -p .claude && \
    echo '{"permissions":{"deny":["WebFetch","WebSearch"]}}' > .claude/settings.json

# .env is gitignored in the repo; materialize it from .env.example (public reCAPTCHA
# test keys etc.) and strip the empty PG_USERNAME/PG_PASSWORD lines so they don't
# override the image ENV.
RUN if [ -f .env.example ] && [ ! -f .env ]; then \
      cp .env.example .env && sed -i '/^PG_USERNAME=/d; /^PG_PASSWORD=/d' .env; \
    fi

RUN git init -q && \
    git config user.email "dev@agent" && \
    git config user.name "Dev" && \
    git add -A && \
    git commit -m "initial" --quiet

# Install gems. Add linux platforms to the lockfile (host archives are often darwin).
RUN bundle config set --local frozen false \
    && bundle lock --add-platform x86_64-linux \
    && bundle lock --add-platform aarch64-linux \
    && bundle install --jobs 4 --retry 3

# Fail loudly if any load-bearing tool is missing.
RUN for t in ruby bundle node psql claude chromium python3; do \
      command -v "$t" >/dev/null 2>&1 || { echo "FATAL: required tool '$t' missing from image" >&2; exit 1; }; \
    done; \
    echo "toolchain OK: ruby=$(ruby --version) node=$(node --version) claude=$(command -v claude)"

# db:seed (dev only, offline via Faker) is what gives diaper_dev a usable login: the app has
# no working self-service signup, so an unseeded dev DB is a dead end. Parity with Explore.
RUN service postgresql start \
 && until pg_isready -h localhost -p 5432 -U postgres >/dev/null 2>&1; do sleep 0.5; done \
 && su postgres -c "psql -qc \"CREATE DATABASE diaper_dev OWNER postgres;\"" \
 && su postgres -c "psql -qc \"CREATE DATABASE diaper_test OWNER postgres;\"" \
 && bundle exec rails db:schema:load \
 && RAILS_ENV=test bundle exec rails db:schema:load \
 && bundle exec rails db:seed \
 && su postgres -c "psql -d diaper_test -tAc \"select to_regclass('items')\"" | grep -qx items \
 && [ "$(su postgres -c "psql -d diaper_dev -tAc \"select count(*) from users\"")" -gt 0 ] \
 && service postgresql stop

# Fold the setup edits (.env, Gemfile.lock platform locks) into the baseline commit so
# the grader's working-tree diff attributes only the agent's changes. node_modules/
# .bundle stay gitignored; no-op when the tree is clean.
RUN git add -A && git commit --amend --no-edit --quiet

# Startup: the schema is baked into the datadir; this only brings postgres up.
RUN cat > /usr/local/bin/start-services.sh <<'EOF'
#!/bin/bash
set -e
service postgresql start
until pg_isready -h localhost -p 5432 -U postgres >/dev/null 2>&1; do sleep 0.5; done
exec "$@"
EOF
RUN chmod +x /usr/local/bin/start-services.sh

# Install the Codex CLI at BUILD time, for the same reason claude is: the agent-setup
# install needs the network, which the trial DNS jail blocks. Hard-fail rather than let a
# codex-less image cache and break every trial on that repo at agent-setup.
RUN for i in 1 2 3; do \
      if curl -fsSL https://chatgpt.com/codex/install.sh -o /tmp/codex-install.sh \
         && CODEX_INSTALL_DIR=/usr/local/bin CODEX_NON_INTERACTIVE=true sh /tmp/codex-install.sh; then break; fi; \
      echo "WARNING: codex install attempt $i failed; retrying in 5s" >&2; sleep 5; \
    done; \
    rm -f /tmp/codex-install.sh; \
    if ! command -v codex >/dev/null 2>&1 && [ -x "$HOME/.local/bin/codex" ]; then \
      ln -sf "$HOME/.local/bin/codex" /usr/local/bin/codex; \
    fi; \
    if ! command -v codex >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then \
      npm install -g @openai/codex@latest || true; \
    fi; \
    command -v codex >/dev/null 2>&1 \
      && echo "codex installed at $(command -v codex)" \
      || echo "WARNING: codex CLI not installed (see the install output above)" >&2

# Restrict DNS to the model endpoint when DNSJAIL_ALLOW is set (the agent supplies it).
# Source: scripts/lib/dns-jail-container.sh, staged here by build-workspace.sh.
COPY dns-jail/ /opt/raccoon-dns-jail/
RUN if [ -f /opt/raccoon-dns-jail/dns-jail-container.sh ]; then \
      install -m 0755 /opt/raccoon-dns-jail/dns-jail-container.sh /usr/local/bin/raccoon-dns-jail \
      && sh -n /usr/local/bin/raccoon-dns-jail; \
    else echo "NOTE: no DNS jail script staged; trials on this image run unjailed" >&2; fi


ENTRYPOINT ["/usr/local/bin/start-services.sh"]
# Resolver for the trial DNS allowlist (scripts/lib/dns-jail.sh); if this
# does not land, trials just run unjailed.
RUN (command -v apk >/dev/null 2>&1 && apk add --no-cache dnsmasq bind-tools) \
    || (apt-get update && apt-get install -y --no-install-recommends dnsmasq-base dnsutils \
        && rm -rf /var/lib/apt/lists/*) \
    || true

CMD ["sleep", "infinity"]
