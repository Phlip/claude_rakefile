#!/bin/bash
# run-app — start the source app inside the Explore container with one command.
#
# Before this existed you had to open two shells into the container and start
# the server and client by hand. This wraps that up: it makes sure postgres is
# running, starts each process in the background, waits until they're actually
# listening, and prints the URL to open plus a login. Logs are written to a
# file so the foreground stays clean.
#
# Usage:
#   run-app            start the app (no-op if it's already running)
#   run-app --restart  stop, then start again
#   run-app --stop     stop the app
#   run-app --logs     follow the server + client logs (Ctrl-C to stop following)
#   run-app --status   show whether the app is running
#   run-app --help     this message
set -uo pipefail

RUN_DIR="/tmp/raccoon-app"
mkdir -p "$RUN_DIR"

CYAN='\033[1;36m'; YELLOW='\033[1;33m'; GRAY='\033[0;90m'; RED='\033[1;31m'; RESET='\033[0m'

REPO_NAME=$(node -e "try{process.stdout.write(require('/workspace/toolkit.json').repo)}catch{}" 2>/dev/null || true)
# Host port the browser uses. The app always binds the container ports (3000 /
# 3001); the Explore container publishes them on a host port that defaults per
# repo but can be overridden (so more than one container — even of the same
# repo — can run at once). That live value is exported into the container as
# $EXPLORE_CLIENT_PORT; prefer it, falling back to toolkit.json then 3000 for
# older containers built before this var existed.
CLIENT_HOST_PORT="${EXPLORE_CLIENT_PORT:-$(node -e "try{process.stdout.write(String(require('/workspace/toolkit.json').explorePorts.clientHost))}catch{process.stdout.write('3000')}" 2>/dev/null || echo 3000)}"

# --- process helpers ---------------------------------------------------------

# Is the process recorded in $1 (a pidfile) still alive?
_alive() { local pf="$1"; [ -f "$pf" ] && kill -0 "$(cat "$pf" 2>/dev/null)" 2>/dev/null; }

# Start a backgrounded process group leader so we can later kill the whole
# group (vite/tsx spawn children). setsid makes the started process its own
# session+group leader; we record its pid (== the group id).
_spawn() {
    local name="$1" workdir="$2" cmd="$3"
    local log="$RUN_DIR/$name.log" pf="$RUN_DIR/$name.pid"
    : > "$log"
    if command -v setsid >/dev/null 2>&1; then
        setsid bash -c "cd '$workdir' && exec $cmd" >"$log" 2>&1 &
    else
        # Fallback: no setsid (children may outlive a stop; best-effort).
        ( cd "$workdir" && exec $cmd ) >"$log" 2>&1 &
    fi
    echo $! > "$pf"
}

# Stop the process recorded in pidfile $1 (and its group, when we have one).
_kill_pidfile() {
    local pf="$1"; [ -f "$pf" ] || return 0
    local pid; pid=$(cat "$pf" 2>/dev/null || true)
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
        kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.3; done
        kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$pf"
}

# Wait (bounded) until something is listening on TCP port $1.
_wait_tcp() {
    local port="$1" tries="${2:-180}" i
    for ((i = 0; i < tries; i++)); do
        if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then exec 3>&- 3<&-; return 0; fi
        sleep 1
    done
    return 1
}

# --- actions -----------------------------------------------------------------

stop_app() {
    local stopped=0
    for pf in "$RUN_DIR"/*.pid; do
        [ -e "$pf" ] || continue
        _kill_pidfile "$pf"
        stopped=1
    done
    if [ "$stopped" = 1 ]; then printf "${GRAY}Stopped the app.${RESET}\n"; else printf "${GRAY}Nothing to stop.${RESET}\n"; fi
}

status_app() {
    local any=0
    for pf in "$RUN_DIR"/*.pid; do
        [ -e "$pf" ] || continue
        local name; name=$(basename "$pf" .pid)
        if _alive "$pf"; then printf "  ${GRAY}%-8s${RESET} running (pid %s)\n" "$name" "$(cat "$pf")"; else printf "  ${GRAY}%-8s${RESET} not running\n" "$name"; fi
        any=1
    done
    [ "$any" = 1 ] || printf "${GRAY}App is not running.${RESET}\n"
}

logs_app() {
    local logs=()
    for lf in "$RUN_DIR"/*.log; do [ -e "$lf" ] && logs+=("$lf"); done
    if [ "${#logs[@]}" -eq 0 ]; then printf "${GRAY}No logs yet — start the app first with ${RESET}run-app\n"; return 0; fi
    printf "${GRAY}Following %s (Ctrl-C to stop following; the app keeps running):${RESET}\n" "${logs[*]}"
    tail -n +1 -f "${logs[@]}"
}

# Start helpers per repo. Each starts the process(es) on their container ports.
start_palolo() {
    _spawn server /workspace/repo/packages/server "node --import=tsx src/server.ts"
    _spawn client /workspace/repo/packages/client "npx vite --host 0.0.0.0 --port 3000"
    printf "  ${CYAN}\xe2\x96\xb6${RESET} starting server (packages/server)\xe2\x80\xa6\n"
    printf "  ${CYAN}\xe2\x96\xb6${RESET} starting client (packages/client)\xe2\x80\xa6\n"
    printf "  ${GRAY}\xe2\x8f\xb3 waiting for the app to come up\xe2\x80\xa6${RESET}\n"
    local ok_server=1 ok_client=1
    _wait_tcp 3001 || ok_server=0
    _wait_tcp 3000 || ok_client=0
    if [ "$ok_server" = 1 ] && [ "$ok_client" = 1 ]; then
        printf "  ${CYAN}\xe2\x9c\x85 app is up${RESET}\n"
        printf "     open  ${CYAN}http://localhost:%s${RESET}\n" "$CLIENT_HOST_PORT"
        printf "     login ${GRAY}zaniyah@exhalefi.com${RESET} / ${GRAY}test${RESET}\n"
    else
        printf "  ${RED}\xe2\x9a\xa0 the app didn't come up in time${RESET} (server=%s client=%s)\n" "$ok_server" "$ok_client"
        printf "     check the logs: ${GRAY}run-app --logs${RESET}\n"
    fi
    printf "     logs  ${GRAY}%s/{server,client}.log${RESET}\n" "$RUN_DIR"
    printf "     stop  ${GRAY}run-app --stop${RESET}\n"
}

start_zenbill() {
    _spawn app /workspace/repo "bundle exec rails server -b 0.0.0.0 -p 3000"
    printf "  ${YELLOW}\xe2\x96\xb6${RESET} starting Rails (puma)\xe2\x80\xa6\n"
    printf "  ${GRAY}\xe2\x8f\xb3 waiting for the app to come up\xe2\x80\xa6${RESET}\n"
    if _wait_tcp 3000; then
        printf "  ${YELLOW}\xe2\x9c\x85 app is up${RESET}\n"
        printf "     open  ${YELLOW}http://localhost:%s${RESET}\n" "$CLIENT_HOST_PORT"
        printf "     ${GRAY}note: this app routes by subdomain. Plain localhost shows only the${RESET}\n"
        printf "     ${GRAY}Rails welcome page; the real UI needs /etc/hosts entries for${RESET}\n"
        printf "     ${GRAY}app.dev.zenbill.com etc. (see README \xe2\x86\x92 Running the app).${RESET}\n"
    else
        printf "  ${RED}\xe2\x9a\xa0 the app didn't come up in time${RESET}\n"
        printf "     check the logs: ${GRAY}run-app --logs${RESET}\n"
    fi
    printf "     logs  ${GRAY}%s/app.log${RESET}\n" "$RUN_DIR"
    printf "     stop  ${GRAY}run-app --stop${RESET}\n"
}

start_zeta_heimdall() {
    # API-only Rails app — boots a JSON API on container port 3000 (no separate client).
    _spawn app /workspace/repo "bundle exec rails server -b 0.0.0.0 -p 3000"
    printf "  ${YELLOW}\xe2\x96\xb6${RESET} starting Rails API (puma)\xe2\x80\xa6\n"
    printf "  ${GRAY}\xe2\x8f\xb3 waiting for the app to come up\xe2\x80\xa6${RESET}\n"
    if _wait_tcp 3000; then
        printf "  ${YELLOW}\xe2\x9c\x85 app is up${RESET}\n"
        printf "     base  ${YELLOW}http://localhost:%s${RESET}\n" "$CLIENT_HOST_PORT"
        printf "     ${GRAY}note: this is a JSON API, not a UI \xe2\x80\x94 hit an endpoint (e.g. an auth route)${RESET}\n"
        printf "     ${GRAY}rather than expecting a page in the browser.${RESET}\n"
    else
        printf "  ${RED}\xe2\x9a\xa0 the app didn't come up in time${RESET}\n"
        printf "     check the logs: ${GRAY}run-app --logs${RESET}\n"
    fi
    printf "     logs  ${GRAY}%s/app.log${RESET}\n" "$RUN_DIR"
    printf "     stop  ${GRAY}run-app --stop${RESET}\n"
}

start_zeta_platform() {
    # Boots BOTH the Rails API and the React client so the full UI comes up.
    # The client (Create React App, react-scripts 2.1.1) serves the UI on container
    # :3000 (the published port) and proxies /graphql to the Rails API, which its
    # package.json "proxy" hardcodes at localhost:5000. So Rails binds :5000 (reached
    # only from inside the container — the browser talks solely to the client) and the
    # client binds :3000. rspec doesn't need any of this; it's just the interactive app.
    #
    # react-scripts 2.1.1 is webpack-4 era: on Node 17+ its build hashing crashes
    # without --openssl-legacy-provider. HOST=0.0.0.0 + DANGEROUSLY_DISABLE_HOST_CHECK
    # let the dev server answer requests arriving via the published host port.
    # node_modules is the container-local symlink post-create.sh set up; yarn is v1.
    _spawn server /workspace/repo "env PORT=5000 bundle exec rails server -b 0.0.0.0 -p 5000"
    _spawn client /workspace/repo "env NODE_OPTIONS=--openssl-legacy-provider BROWSER=none CI=false PORT=3000 HOST=0.0.0.0 DANGEROUSLY_DISABLE_HOST_CHECK=true NODE_PATH=src:src/components/ ./node_modules/.bin/react-app-rewired start"
    printf "  ${YELLOW}\xe2\x96\xb6${RESET} starting Rails API (puma) on :5000\xe2\x80\xa6\n"
    printf "  ${CYAN}\xe2\x96\xb6${RESET} starting React client (react-scripts)\xe2\x80\xa6\n"
    printf "  ${GRAY}\xe2\x8f\xb3 waiting for the app to come up (first client compile takes a minute)\xe2\x80\xa6${RESET}\n"
    local ok_server=1 ok_client=1
    _wait_tcp 5000 || ok_server=0
    _wait_tcp 3000 || ok_client=0
    if [ "$ok_server" = 1 ] && [ "$ok_client" = 1 ]; then
        printf "  ${CYAN}\xe2\x9c\x85 app is up${RESET}\n"
        printf "     open  ${CYAN}http://localhost:%s${RESET}\n" "$CLIENT_HOST_PORT"
        printf "     ${GRAY}note: that URL is the React UI. It proxies GraphQL to the Rails API on${RESET}\n"
        printf "     ${GRAY}:5000 inside the container (reach it directly from a container shell at${RESET}\n"
        printf "     ${GRAY}http://localhost:5000). The DB is schema-loaded but unseeded \xe2\x80\x94 you may need${RESET}\n"
        printf "     ${GRAY}to create an account/records to see much in the UI.${RESET}\n"
    else
        printf "  ${RED}\xe2\x9a\xa0 the app didn't come up in time${RESET} (server=%s client=%s)\n" "$ok_server" "$ok_client"
        printf "     check the logs: ${GRAY}run-app --logs${RESET}\n"
    fi
    printf "     logs  ${GRAY}%s/{server,client}.log${RESET}\n" "$RUN_DIR"
    printf "     stop  ${GRAY}run-app --stop${RESET}\n"
}

start_flaredown() {
    # Polyglot single-container app: the Rails API (backend/) + the Ember client (frontend/).
    # The Ember dev server serves the UI on container :3000 (the published port) and proxies
    # API calls to the Rails backend, which docker-compose runs on :3000 too — here the client
    # takes :3000, so the API binds :5000 (reached only from inside the container) and the
    # client proxies to it. rspec needs neither the client nor the running server. Node 14
    # (from nvm) drives ember-cli; Ruby 3.2.3 is the image default. OPENSSL_CONF=/dev/null
    # lets the old webpack md4 hashing run on bookworm's OpenSSL 3.
    local NODE14_BIN
    NODE14_BIN=$(ls -d /usr/local/nvm/versions/node/v14.* 2>/dev/null | sort -V | tail -1)/bin
    # Three settings the browser needs, none of which a curl of the page reveals:
    #   PORT             config/environment.js bakes ENV.apiHost from it. Left at the
    #                    compose-era 3000 the browser's API calls are cross-origin and CORS-fail;
    #                    set to the published host port they're same-origin and ride --proxy.
    #   live-reload-port pinned so it matches the published mapping instead of drifting via
    #                    portfinder — the client injects an absolute livereload.js URL.
    #   FACEBOOK_APP_ID  torii's facebook-connect provider reads appId with no default and
    #                    throws during app boot when it's unset.
    local LR_PORT="${EXPLORE_LIVERELOAD_PORT:-7020}"
    _spawn server /workspace/repo/backend "env PORT=5000 bundle exec rails server -b 0.0.0.0 -p 5000"
    _spawn client /workspace/repo/frontend "env PATH=$NODE14_BIN:\$PATH OPENSSL_CONF=/dev/null FACEBOOK_APP_ID=0 PORT=$CLIENT_HOST_PORT ./node_modules/.bin/ember serve --port 3000 --proxy http://localhost:5000 --live-reload-port $LR_PORT"
    printf "  ${YELLOW}\xe2\x96\xb6${RESET} starting Rails API (puma) on :5000\xe2\x80\xa6\n"
    printf "  ${CYAN}\xe2\x96\xb6${RESET} starting Ember client (ember-cli)\xe2\x80\xa6\n"
    printf "  ${GRAY}\xe2\x8f\xb3 waiting for the app to come up (first Ember build takes a minute)\xe2\x80\xa6${RESET}\n"
    local ok_server=1 ok_client=1
    _wait_tcp 5000 || ok_server=0
    _wait_tcp 3000 || ok_client=0
    if [ "$ok_server" = 1 ] && [ "$ok_client" = 1 ]; then
        printf "  ${CYAN}\xe2\x9c\x85 app is up${RESET}\n"
        printf "     open  ${CYAN}http://localhost:%s${RESET}\n" "$CLIENT_HOST_PORT"
        printf "     ${GRAY}note: that URL is the Ember UI; it proxies API calls to the Rails backend on${RESET}\n"
        printf "     ${GRAY}:5000 inside the container. The DBs (Postgres + MongoDB) are migrated but${RESET}\n"
        printf "     ${GRAY}unseeded \xe2\x80\x94 register a user in the UI to see much.${RESET}\n"
    else
        printf "  ${RED}\xe2\x9a\xa0 the app didn't come up in time${RESET} (server=%s client=%s)\n" "$ok_server" "$ok_client"
        printf "     check the logs: ${GRAY}run-app --logs${RESET}\n"
    fi
    printf "     logs  ${GRAY}%s/{server,client}.log${RESET}\n" "$RUN_DIR"
    printf "     stop  ${GRAY}run-app --stop${RESET}\n"
}

start_breezy_complete() {
    # Monorepo: Rails API (backend/, container :3001) + Next.js frontend (frontend/,
    # container :3000). The offline Clerk-bypass env (DISABLE_CLERK etc.) is injected
    # HERE, not baked into the image, so a worker's bare `bundle exec rspec` keeps
    # upstream CI's env (ambient DISABLE_CLERK 403s several controller specs).
    # NEXT_PUBLIC_BACKEND_URL must be the HOST-visible backend URL — the browser
    # calls it — so derive it from the live published server port. Sidekiq is not
    # started (only needed for background-job behavior; LLM-dependent jobs degrade
    # keyless anyway).
    local server_host_port
    server_host_port="${EXPLORE_SERVER_PORT:-$(node -e "try{process.stdout.write(String(require('/workspace/toolkit.json').explorePorts.serverHost))}catch{process.stdout.write('4001')}" 2>/dev/null || echo 4001)}"
    _spawn server /workspace/repo/backend "env DISABLE_CLERK=true CLERK_SKIP_RAILTIE=true bundle exec rails server -b 0.0.0.0 -p 3001"
    _spawn client /workspace/repo/frontend "env NEXT_PUBLIC_BACKEND_URL=http://localhost:${server_host_port} npm run dev -- -H 0.0.0.0 -p 3000"
    printf "  ${YELLOW}\xe2\x96\xb6${RESET} starting Rails API (backend/) on :3001\xe2\x80\xa6\n"
    printf "  ${CYAN}\xe2\x96\xb6${RESET} starting Next.js frontend (frontend/)\xe2\x80\xa6\n"
    printf "  ${GRAY}\xe2\x8f\xb3 waiting for the app to come up\xe2\x80\xa6${RESET}\n"
    local ok_server=1 ok_client=1
    _wait_tcp 3001 || ok_server=0
    _wait_tcp 3000 || ok_client=0
    if [ "$ok_server" = 1 ] && [ "$ok_client" = 1 ]; then
        printf "  ${CYAN}\xe2\x9c\x85 app is up${RESET}\n"
        printf "     open  ${CYAN}http://localhost:%s/pro_signin${RESET}\n" "$CLIENT_HOST_PORT"
        printf "     ${GRAY}auth is bypassed offline \xe2\x80\x94 /pro_signin auto-redirects to the seeded${RESET}\n"
        printf "     ${GRAY}professional's dashboard (no login needed). Enter via /pro_signin, not a${RESET}\n"
        printf "     ${GRAY}bookmarked dashboard URL \xe2\x80\x94 those embed a token that changes on re-seed.${RESET}\n"
    else
        printf "  ${RED}\xe2\x9a\xa0 the app didn't come up in time${RESET} (server=%s client=%s)\n" "$ok_server" "$ok_client"
        printf "     check the logs: ${GRAY}run-app --logs${RESET}\n"
    fi
    printf "     logs  ${GRAY}%s/{server,client}.log${RESET}\n" "$RUN_DIR"
    printf "     stop  ${GRAY}run-app --stop${RESET}\n"
}

# ---- polyglot mode -----------------------------------------------------------
# A polyglot toolkit (toolkit.json .polyglot=true) hosts many member repos under
# repos/<slug>/. The worker picks one with `run-app <repo>`; its deps + DB install on
# first use (deferred), then its app boots on container port 3000. Dispatch is
# RUNTIME-DRIVEN: each member carries a `runtime` ("ruby:3.2.1" | "node:16" |
# "python:3.10" | "none") and an optional `startCmd` in toolkit.json, so there is no
# per-repo hardcoding (scales to all repos). rbenv/pyenv shims must be on PATH inside
# the backgrounded process (a non-login shell), hence the explicit env prefixes.
RBENV_PATH='/usr/local/rbenv/shims:/usr/local/rbenv/bin'
PYENV_PATH='/usr/local/pyenv/shims:/usr/local/pyenv/bin'
# asdf-based estates (salesform-polyglot: Elixir + Ruby + Node from one manager). asdf shims are
# already on PATH image-wide and ASDF_DIR is exported, so a bare `bundle`/`mix`/`npm` resolves each
# member's own .tool-versions — no per-tool PATH/version juggling. Present ONLY in asdf images: every
# other estate has no /usr/local/asdf, so `_asdf_ok` is false there and the rbenv/pyenv/nvm arms below
# run exactly as before. This is also the only place `elixir` runtimes are handled (asdf-only).
_asdf_ok() { [ -f /usr/local/asdf/asdf.sh ]; }
# Let asdf read legacy .ruby-version/.nvmrc (Rails members ship .ruby-version, not .tool-versions).
_asdf_prep() { grep -qs 'legacy_version_file' "$HOME/.asdfrc" 2>/dev/null || echo 'legacy_version_file = yes' >> "$HOME/.asdfrc"; }
_is_polyglot() { node -e "try{process.exit(require('/workspace/toolkit.json').polyglot?0:1)}catch{process.exit(1)}" 2>/dev/null; }
_poly_repos()   { node -e "require('/workspace/toolkit.json').repos.forEach(r=>console.log(r.repo))" 2>/dev/null; }
_poly_default() { node -e "process.stdout.write(require('/workspace/toolkit.json').defaultRepo||'')" 2>/dev/null; }
# _poly_field <repo> <field> → the member's field value ('' if absent). Args passed via
# argv (not interpolated) so a repo name can't break the JS.
_poly_field()   { node -e "const r=require('/workspace/toolkit.json').repos.find(x=>x.repo===process.argv[1]);process.stdout.write(r&&r[process.argv[2]]!=null?String(r[process.argv[2]]):'')" "$1" "$2" 2>/dev/null; }
# Is rbenv/pyenv version <ver> installed in this image? (EOL runtimes won't be.)
_rb_have() { [ -d "/usr/local/rbenv/versions/$1" ]; }
_py_have() { [ -d "/usr/local/pyenv/versions/$1" ]; }
# Newer estate images ship Python via uv (a system python3 + `uv`) instead of pyenv.
# True when there's no pyenv build for <ver> but uv can provide it — the python arms
# then fall back to a container-local uv venv per member.
_py_uv_ok() { ! _py_have "$1" && command -v uv >/dev/null 2>&1; }
_uv_venv_dir() { printf '/opt/raccoon-venvs/%s' "$1"; }
# Node is multi-version via nvm. Resolve a member's node spec (e.g. "16" or
# "16.20.2") to that major's installed node bin dir, or '' if that major isn't in
# the image (so the selector can fall back to explore-only). Picks the highest
# installed patch of the requested major.
_node_bin() {
    local major="${1%%.*}" nvm_dir="${NVM_DIR:-/usr/local/nvm}" d
    d=$(ls -d "$nvm_dir"/versions/node/v"$major".* 2>/dev/null | sort -V | tail -1)
    [ -n "$d" ] && printf '%s/bin' "$d"
}
# Symlink ./node_modules (cwd = the dir being installed) to a container-local tree keyed by
# <key> — see the ENFILE rationale at the call site. The target must itself be named
# `node_modules` (Node resolves the symlink, then walks ancestors for that literal name),
# and its parent needs a stub manifest: postinstall scripts that locate the project by
# truncating their realpath at `node_modules` require() `<parent>/package.json`.
_nm_link() {
    local root="/opt/raccoon-node-modules/$1"
    [ -L node_modules ] || rm -rf node_modules
    mkdir -p "$root/node_modules"
    [ -f "$root/package.json" ] \
        || printf '{"name":"raccoon-node-modules-root","version":"0.0.0","private":true}\n' > "$root/package.json"
    ln -sfn "$root/node_modules" node_modules
}
# Rewrite poetry deps of the form `<pkg> = { git = "ssh://git@github.com/AskZeta/<name>.git", rev=… }`
# in <pyproject.toml> to a local path dep at /workspace/repos/zeta-<name>. The sibling repo is a
# member of this toolkit, so the path resolves offline (no SSH key / network needed).
# NB: uses `|` as the s/// delimiter, NOT `{}` — the pattern has `[^}]` and the replacement has
# `{ … }`, which break perl's brace-balanced delimiter parsing.
_rewrite_askzeta_git_deps() {
    perl -i -pe 's|=\s*\{\s*git\s*=\s*"ssh://git\@github\.com/AskZeta/([^"]+?)(?:\.git)?"\s*,[^}]*\}|= { path = "/workspace/repos/zeta-\L$1\E", develop = false }|g' "$1" 2>/dev/null || true
}

# Create + schema-load EVERY database of a multi-DB Rails app for one RAILS_ENV ($1).
#
# Rails only defines the namespaced `db:schema:load:<name>` tasks when more than one config
# is VISIBLE to rake, and a config marked `database_tasks: false` is hidden from
# `configs_for`. zeta-plastic marks `source` hidden in development and BOTH connections
# hidden in test, so it has no namespaced tasks at all: the commands below fail with
# `UnrecognizedCommandError`, and plain `db:schema:load` can't reach the extra DB anyway.
# So: try the namespaced path (px-api has it), else walk the configs ourselves.
#
# NEVER db:migrate — its implicit schema:dump regenerates db/source_schema.rb from the
# near-empty source DB, truncating the real file (3487 -> ~77 lines).
_multidb_setup_env() {
    local e="$1"
    RAILS_ENV="$e" DISABLE_SPRING=1 bundle exec rails db:create 2>/dev/null
    if RAILS_ENV="$e" DISABLE_SPRING=1 bundle exec rails db:schema:load:primary >/dev/null 2>&1; then
        RAILS_ENV="$e" DISABLE_SPRING=1 bundle exec rails db:schema:load:source >/dev/null 2>&1 || true
        return 0
    fi
    # Fallback: create and load each config, hidden ones included. Two traps, both hit in
    # practice on zeta-plastic: (1) `create` raises DatabaseAlreadyExists once the db:create
    # above has made the primary DB, and that path leaves ActiveRecord connected to the
    # `postgres` MAINTENANCE database; (2) load_schema does not connect on its own (Rails
    # 7.2) — it loads into whatever connection is current. Without the explicit
    # establish_connection below, the app's tables get created inside `postgres` and the
    # real DB is left empty, with every command still reporting success.
    # Ruby goes to a real temp file, not /dev/stdin — `rails runner` Kernel.loads the path,
    # which needs a seekable file, and a heredoc is a pipe on some shells.
    local rb; rb=$(mktemp /tmp/raccoon-load-schemas.XXXXXX.rb)
    cat > "$rb" <<'RUBY'
ActiveRecord::Base.configurations
  .configs_for(env_name: Rails.env, include_hidden: true)
  .reject(&:replica?).each do |c|
  begin
    ActiveRecord::Tasks::DatabaseTasks.create(c)
  rescue ActiveRecord::DatabaseAlreadyExists, ActiveRecord::StatementInvalid
  end
  dump = c.schema_dump || "schema.rb"
  file = Rails.root.join("db", dump)
  next unless File.exist?(file)
  ActiveRecord::Base.establish_connection(c)
  ActiveRecord::Tasks::DatabaseTasks.load_schema(c, :ruby, file.to_s)
  puts "loaded db/#{dump} -> #{c.database}"
end
RUBY
    # "already exists" is expected for the DB db:create just made — not worth showing.
    RAILS_ENV="$e" DISABLE_SPRING=1 bundle exec rails runner "$rb" 2>&1 \
        | grep -v "already exists" | sed 's/^/  /'
    rm -f "$rb"
    return 0
}

# First-use setup writes to two places with different lifetimes, so it takes two markers:
#   host — the commit checkout, in the bind-mounted repo dir; survives any container.
#   ctr  — deps (node_modules / gems / venv / cargo target), databases and ~/.bashrc; all of
#          these live in this container and die with it.
# Tracking both with one host-side marker makes a second or rebuilt container skip an install
# it never ran, leaving the member pointed at a node_modules that isn't there.
CTR_MARKER_DIR="/opt/raccoon-setup"
# Record <repo> as set up in THIS container. Best-effort: if the marker can't be written the
# only consequence is that setup runs again next time, and every step of it is idempotent.
_mark_ctr_setup() { mkdir -p "$CTR_MARKER_DIR" 2>/dev/null && : > "$CTR_MARKER_DIR/$1.done" 2>/dev/null || true; }
# A member set up but left without its dependencies, so the later arms don't claim otherwise.
_mark_ctr_nodeps() { mkdir -p "$CTR_MARKER_DIR" 2>/dev/null && : > "$CTR_MARKER_DIR/$1.nodeps" 2>/dev/null || true; }
_clear_ctr_nodeps() { rm -f "$CTR_MARKER_DIR/$1.nodeps" 2>/dev/null || true; }
_ctr_nodeps() { [ -f "$CTR_MARKER_DIR/$1.nodeps" ]; }

# First-use setup for a member repo: checkout its commit, install deps, prepare DB.
# The DNS jail (apply-dns-jail.sh) blocks package registries, and the setup below installs
# from them. Lift it for the install, then put it back — including on Ctrl-C, or the
# container would silently keep its network until the next start.
_DNSJAIL_LIFTED=""
_dnsjail_lift() {
    [ -f /tmp/.dnsjail/resolv.orig ] || return 0
    # Already unjailed by hand: leave the worker's choice alone rather than putting the
    # jail back under them when this exits.
    grep -qE '^nameserver[[:space:]]+127\.0\.0\.1[[:space:]]*$' /etc/resolv.conf 2>/dev/null || return 0
    mkdir -p /tmp/.dnsjail/lifts 2>/dev/null || return 0
    : > "/tmp/.dnsjail/lifts/$$" 2>/dev/null || true
    _DNSJAIL_LIFTED=1
    sudo sh -c 'cat /tmp/.dnsjail/resolv.orig > /etc/resolv.conf' 2>/dev/null || true
    if grep -qE '^nameserver[[:space:]]+127\.0\.0\.1[[:space:]]*$' /etc/resolv.conf 2>/dev/null; then
        echo "  (could not unjail DNS for the install — run \`unjail\` and retry)" >&2
    else
        echo "  (DNS unjailed for dependency install)"
    fi
}
# A trap handler that merely returns leaves the shell alive, so re-raise: without this an
# armed INT trap swallows the worker's Ctrl-C entirely.
_dnsjail_onsig() { _dnsjail_restore; trap - "$1" EXIT; kill -"$1" $$; }
_dnsjail_restore() {
    [ -n "$_DNSJAIL_LIFTED" ] || return 0
    rm -f "/tmp/.dnsjail/lifts/$$" 2>/dev/null || true
    # A marker from a killed run-app would otherwise keep the jail off indefinitely.
    for _m in /tmp/.dnsjail/lifts/*; do
        [ -e "$_m" ] || continue
        kill -0 "${_m##*/}" 2>/dev/null || rm -f "$_m" 2>/dev/null || true
    done
    # Another run-app is mid-install: leave the network up for it.
    [ -n "$(ls -A /tmp/.dnsjail/lifts 2>/dev/null)" ] && return 0
    [ -f /tmp/.dnsjail/allow ] || return 0
    sudo env DNSJAIL_ALLOW="$(cat /tmp/.dnsjail/allow)" \
        DNSJAIL_ALLOW_EXTRA="$(cat /tmp/.dnsjail/allow-extra 2>/dev/null)" \
        sh /workspace/.devcontainer/dns-jail-container.sh >/dev/null 2>&1 || true
}

# Runtime-driven; each marker is written only once its own half has succeeded.
setup_repo() {
    local repo="$1" root="/workspace/repos/$1" dir
    local hostmarker="/workspace/repos/$1/.raccoon-setup-done" ctrmarker="$CTR_MARKER_DIR/$1.done"
    [ -f "$ctrmarker" ] && return 0
    _dnsjail_lift
    if [ -n "$_DNSJAIL_LIFTED" ]; then
        trap _dnsjail_restore EXIT
        trap '_dnsjail_onsig INT' INT
        trap '_dnsjail_onsig TERM' TERM
    fi
    local commit runtime kind ver bootenv setupcmd apppath
    commit=$(_poly_field "$repo" defaultCommit)
    runtime=$(_poly_field "$repo" runtime); kind=${runtime%%:*}; ver=${runtime#*:}
    # A member's optional bootEnv ("KEY=val KEY2=val2") supplies dummy values for vars an
    # app reads at class-load that its .env.example omits (e.g. wasabi-platform's IVR_UN/
    # IVR_PW). dotenv does NOT reliably load .env into the rspec process for some apps, so
    # the load-bearing channel is real shell exports in ~/.bashrc (below) — the worker's
    # `bundle exec rspec` then sees them. The .env append (in each runtime case) is belt-
    # and-suspenders for dotenv-loading apps. Keeps real secrets out; just unblocks boot.
    bootenv=$(_poly_field "$repo" bootEnv)
    # A member's optional setupCmd runs ONCE here, after deps are installed, for one-time
    # app preparation that isn't boot (schema push, seeding, generating a gitignored asset).
    # It belongs here rather than in startCmd: startCmd runs on every `run-app`, so seeding
    # from there re-runs on each boot and its output is mixed into the server log. Failure
    # is non-fatal (a warning) — a member that can still be explored shouldn't be blocked by
    # a seed hiccup, mirroring the `|| true` seeds in post-create.sh for single-repo kits.
    setupcmd=$(_poly_field "$repo" setupCmd)
    # A member whose manifest sits in a subdirectory (monorepo: app/, py/, backend/) installs and
    # boots from there. Git state stays at $root; only dependency install and boot use $dir.
    apppath=$(_poly_field "$repo" appPath); dir="$root${apppath:+/$apppath}"
    # Only the first container to reach a given repo dir checks it out: the checkout is host-side
    # state, so redoing it later would move a worker off a commit they had deliberately chosen.
    if [ ! -f "$hostmarker" ] && [ -n "$commit" ] \
       && ! git -C "$root" -c advice.detachedHead=false checkout "$commit" >/dev/null 2>&1; then
        printf "${RED}checkout %s failed for %s${RESET}\n" "$commit" "$repo"; return 1
    fi
    # Keep the setup marker out of `git status` — and out of snapshot patches, which
    # capture the worker's repo state (mirrors post-create's .pnpm-store exclude; the
    # create-snapshot checkpoint hook excludes it as well).
    mkdir -p "$root/.git/info"
    grep -qxF '.raccoon-setup-done' "$root/.git/info/exclude" 2>/dev/null \
        || printf '\n# raccoon-explore: run-app first-use setup marker\n.raccoon-setup-done\n' >> "$root/.git/info/exclude"
    # Same for the node_modules symlink: a `node_modules/` .gitignore entry doesn't match it.
    grep -qxF 'node_modules' "$root/.git/info/exclude" 2>/dev/null \
        || printf '\n# raccoon-explore: run-app node_modules symlink\nnode_modules\n' >> "$root/.git/info/exclude"
    # A member with no lockfile (or only a pnpm one) gets `yarn install`, which writes a
    # lockfile the worker never authored. Excluding only suppresses it while UNTRACKED, so a
    # member that commits its lockfile still reports real changes to it.
    for lock in yarn.lock package-lock.json; do
        grep -qxF "$lock" "$root/.git/info/exclude" 2>/dev/null \
            || printf '\n# raccoon-explore: lockfile generated by run-app'"'"'s install\n%s\n' "$lock" >> "$root/.git/info/exclude"
    done
    touch "$hostmarker" 2>/dev/null || true
    # Persist bootEnv as real exports for ALL the worker's container shells (deduped per repo).
    if [ -n "$bootenv" ] && ! grep -q "raccoon-bootenv:$repo" "$HOME/.bashrc" 2>/dev/null; then
        { echo "# raccoon-bootenv:$repo"; for kv in $bootenv; do echo "export $kv"; done; } >> "$HOME/.bashrc"
    fi
    printf "  ${GRAY}first-time setup for %s (%s) \xe2\x80\x94 runs once\xe2\x80\xa6${RESET}\n" "$repo" "${runtime:-explore-only}"
    case "$kind" in
        elixir)
            # asdf-only (no rbenv/nvm estate has elixir). Version comes from the member's
            # .tool-versions; shims are already on PATH. deps + a MIX_ENV=test compile so the
            # suite is warm and compile errors surface at setup, not mid-explore. bootEnv covers
            # any compile-time env a member reads (e.g. epihub's ZOOM_* module attributes). DB/ecto
            # prep is member-specific → leave it to setupCmd; a worker runs `mix test` with it.
            ( cd "$dir" \
              && for kv in $bootenv; do export "$kv"; done \
              && mix local.hex --force >/dev/null 2>&1 \
              && mix local.rebar --force >/dev/null 2>&1 \
              && { [ -f config/dev.secret.exs.example ] && [ ! -f config/dev.secret.exs ] && cp config/dev.secret.exs.example config/dev.secret.exs; true; } \
              && mix deps.get \
              && MIX_ENV=test mix compile ) || return 1 ;;
        ruby)
            if _asdf_ok; then
                _asdf_prep
                # Version from .ruby-version (legacy) / .tool-versions; shims already on PATH.
                # Regenerate binstubs when the repo ships an empty bin/ (Rails detects an app via
                # bin/rails — without it `bundle exec rails` prints `new` help and won't boot).
                ( cd "$dir" \
                  && { [ -f config/database.yml.example ] && cp -n config/database.yml.example config/database.yml; true; } \
                  && { [ -f .env.example ] && cp -n .env.example .env; true; } \
                  && { for kv in $bootenv; do grep -qxF "$kv" .env 2>/dev/null || echo "$kv" >> .env; done; true; } \
                  && { bundle lock --add-platform x86_64-linux aarch64-linux >/dev/null 2>&1 || true; } \
                  && { bundle install || bundle install --full-index; } \
                  && { [ -f bin/rails ] || bundle binstubs railties --force --path bin >/dev/null 2>&1 || bundle exec rake app:update:bin >/dev/null 2>&1 || true; } \
                  && { bundle exec rails db:prepare 2>/dev/null || bundle exec rails db:create db:schema:load 2>/dev/null || true; \
                       RAILS_ENV=test bundle exec rails db:create 2>/dev/null; \
                       RAILS_ENV=test bundle exec rails db:schema:load 2>/dev/null; \
                       RAILS_ENV=test bundle exec rails db:migrate 2>/dev/null || true; } ) || return 1
            else
            _rb_have "$ver" || { printf "  ${GRAY}(Ruby %s not in this image; skipping deps \xe2\x80\x94 explore-only)${RESET}\n" "$ver"; _mark_ctr_setup "$repo"; return 0; }
            ( cd "$dir" \
              && export PATH="$RBENV_PATH:$PATH" RBENV_VERSION="$ver" \
              && { [ -f config/database.yml.example ] && cp -n config/database.yml.example config/database.yml; true; } \
              && { [ -f .env.example ] && cp -n .env.example .env; true; } \
              && { for kv in $bootenv; do grep -qxF "$kv" .env 2>/dev/null || echo "$kv" >> .env; done; true; } \
              && { bundle lock --add-platform x86_64-linux aarch64-linux >/dev/null 2>&1 || true; } \
              && { bundle install || bundle install --full-index; } \
              && { if [ -f db/source_schema.rb ]; then \
                     # MULTI-DATABASE (px-api, plastic): the `users` etc. live in the `source` DB.
                     # Load EACH db's schema for dev AND test. DISABLE_SPRING so a preloaded
                     # stale connection doesn't make the source load a silent no-op.
                     for e in development test; do \
                       _multidb_setup_env "$e" || true; \
                     done; \
                   else \
                     # Single-DB: prepare the dev DB (rails_helper often needs it present), then
                     # load + migrate the test DB (migrate is a no-op when schema.rb is current,
                     # and applies pending migrations when it's stale).
                     bundle exec rails db:prepare 2>/dev/null || bundle exec rails db:create db:schema:load 2>/dev/null || true; \
                     RAILS_ENV=test bundle exec rails db:create 2>/dev/null; \
                     RAILS_ENV=test bundle exec rails db:schema:load 2>/dev/null; \
                     RAILS_ENV=test bundle exec rails db:migrate 2>/dev/null || true; \
                   fi; } ) || return 1
            fi ;;
        node)
            if _asdf_ok; then
                _asdf_prep
                ( cd "$dir" \
                  && _nm_link "$repo" \
                  && { [ -f .env.example ] && cp -n .env.example .env; true; } \
                  && { for kv in $bootenv; do grep -qxF "$kv" .env 2>/dev/null || echo "$kv" >> .env; done; true; } \
                  && { if [ -f yarn.lock ]; then yarn install; elif [ -f package-lock.json ]; then npm install; else yarn install; fi; } ) || return 1
            else
            nbin=$(_node_bin "$ver")
            [ -z "$nbin" ] && { printf "  ${GRAY}(Node %s not in this image; skipping deps \xe2\x80\x94 explore-only)${RESET}\n" "$ver"; _mark_ctr_setup "$repo"; return 0; }
            # Install node_modules to a CONTAINER-LOCAL path, not the bind-mounted repo dir. On
            # macOS Docker Desktop the repo is a host bind mount; writing a huge node_modules tree
            # across the file-sharing layer is slow AND exhausts the HOST's open-file table (ENFILE
            # "file table overflow"), which can take the whole machine down — not just the install.
            # Keeping node_modules inside the Linux VM confines that churn to the VM. The repo stays
            # bind-mounted (the worker sees their edits); node_modules is reached via a symlink.
            ( cd "$dir" \
              && export PATH="$nbin:$PATH" \
              && _nm_link "$repo" \
              && { [ -f .env.example ] && cp -n .env.example .env; true; } \
              && { for kv in $bootenv; do grep -qxF "$kv" .env 2>/dev/null || echo "$kv" >> .env; done; true; } \
              && { if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
                     # pnpm member: install the locked pnpm tree (matching the graded image), not yarn.
                     if [ "${ver%%.*}" -lt 22 ] 2>/dev/null; then
                       # pnpm@9 (node<22) can't install through the _nm_link node_modules symlink
                       # (ENOTDIR on mkdir), so give it a real node_modules but keep pnpm's heavy
                       # virtual + content stores container-local — the ENFILE protection _nm_link
                       # provides (node_modules then holds only lightweight symlinks).
                       rm -rf node_modules
                       pnpm install --no-frozen-lockfile --config.dangerouslyAllowAllBuilds=true \
                         --virtual-store-dir="/opt/raccoon-node-modules/$repo/.pnpm-vstore" \
                         --store-dir=/opt/raccoon-pnpm-store
                     else
                       # pnpm>=11 (node>=22) follows the _nm_link symlink; node_modules and its .pnpm
                       # store are already container-local through it.
                       pnpm install --no-frozen-lockfile --config.dangerouslyAllowAllBuilds=true
                     fi
                   elif [ -f yarn.lock ]; then yarn install
                   elif [ -f package-lock.json ]; then npm install
                   else yarn install; fi; } ) || return 1
            fi ;;
        python)
            if _py_uv_ok "$ver"; then
                # uv-python image (clockwise-polyglot era): container-local venv per member,
                # deps via uv. `uv pip install -e .` handles poetry-backend pyprojects too — but it
                # resolves from pyproject CONSTRAINTS and ignores poetry.lock, while the graded image
                # runs `poetry install` and gets the locked set. That divergence broke search-api-v2
                # outright (Explore resolved pydantic 2.13.4 against a lock pinning 2.9.2, and the
                # pinned strawberry cannot import on 2.13). Prefer the lock when there is one.
                local vdir; vdir=$(_uv_venv_dir "$repo")
                # --clear: uv >=0.12 won't create over an existing venv, so a failed first setup
                # would wedge the member. setuptools 80.x is the last line shipping pkg_resources.
                ( cd "$dir" \
                  && uv venv --clear "$vdir" -p "$ver" -q \
                  && . "$vdir/bin/activate" \
                  && uv pip install -q 'setuptools==80.9.0' \
                  && { [ -f .env.example ] && cp -n .env.example .env; true; } \
                  && { for kv in $bootenv; do grep -qxF "$kv" .env 2>/dev/null || echo "$kv" >> .env; done; true; } ) || return 1
                # Non-fatal: a manifest that cannot resolve here (a pin with no wheel for this
                # architecture, say) leaves the member readable instead of failing the whole run.
                if ( cd "$dir" && . "$vdir/bin/activate" \
                     && { if [ -f poetry.lock ] && command -v poetry >/dev/null 2>&1 \
                            && POETRY_VIRTUALENVS_CREATE=false poetry install -q --no-interaction --no-root 2>/dev/null; then true; \
                          elif [ -f pyproject.toml ]; then uv pip install -q -e . || uv pip install -q -r requirements.txt 2>/dev/null || true; \
                          elif [ -f requirements.txt ]; then uv pip install -q -r requirements.txt; \
                          elif [ -f server/requirements.txt ]; then uv pip install -q -r server/requirements.txt; \
                          elif [ -f setup.py ]; then uv pip install -q -e .; else true; fi; } ); then
                    _clear_ctr_nodeps "$repo"
                else
                    _mark_ctr_nodeps "$repo"
                    printf "  ${YELLOW}\xe2\x9a\xa0 %s: dependencies did not install${RESET} \xe2\x80\x94 explore-only in this container.\n     ${GRAY}Reading the code, git and the editor still work; running the app or its tests will not.\n     Usually a pin with no build for this machine's architecture. To retry: rm %s/%s.done${RESET}\n" "$repo" "$CTR_MARKER_DIR" "$repo"
                fi
                _mark_ctr_setup "$repo"; return 0
            fi
            _py_have "$ver" || { printf "  ${GRAY}(Python %s not in this image; skipping deps \xe2\x80\x94 explore-only)${RESET}\n" "$ver"; _mark_ctr_setup "$repo"; return 0; }
            # Some poetry repos depend on sibling repos via `git = "ssh://git@github.com/AskZeta/<name>.git"`,
            # which can't resolve in the container (no SSH key, no network). The deps are TRANSITIVE
            # (cx-chatbot → compiler-agent → agent-tools → leaves), so rewrite the target AND every
            # sibling pyproject to local path deps — else poetry shells out to `ssh` for a transitive
            # git dep and fails ("No such file or directory: 'ssh'").
            for pp in /workspace/repos/*/pyproject.toml; do
                [ -f "$pp" ] && _rewrite_askzeta_git_deps "$pp"
            done
            ( cd "$dir" && export PATH="$PYENV_PATH:$PATH" PYENV_VERSION="$ver" \
              && { [ -f .env.example ] && cp -n .env.example .env; true; } \
              && { for kv in $bootenv; do grep -qxF "$kv" .env 2>/dev/null || echo "$kv" >> .env; done; true; } \
              && { if [ -f pyproject.toml ]; then \
                     # Every member Dockerfile sets this; without it poetry builds a .venv here
                     # that the trial image has no equivalent of.
                     poetry config virtualenvs.create false 2>/dev/null || true; \
                     # The git→path rewrite invalidates poetry.lock ("changed significantly"), so
                     # re-lock preserving pins: --no-update on poetry 1.x, the default on 2.x.
                     poetry lock --no-update 2>/dev/null || poetry lock 2>/dev/null || true; \
                     # --no-root: install deps only, not the project package itself. Some members'
                     # pyproject package name doesn't map to a folder poetry can find ("No file/folder
                     # found for package <x>"), which fails the whole install. The worker explores +
                     # runs the code from the repo dir (cwd on path), so the project never needs to be
                     # pip-installed as a package. Mirrors the harbor build.
                     poetry install --no-interaction --no-root; \
                   elif [ -f requirements.txt ]; then pip install -r requirements.txt; \
                   elif [ -f setup.py ]; then pip install -e .; else true; fi; } ) || return 1 ;;
        rust)
            command -v cargo >/dev/null 2>&1 || { printf "  ${GRAY}(Rust not in this image; skipping build \xe2\x80\x94 explore-only)${RESET}\n"; _mark_ctr_setup "$repo"; return 0; }
            # Build to a container-local target dir (same ENFILE/bind-mount rationale as
            # node_modules): a Cargo workspace target tree is huge and rebuilds often.
            ( cd "$dir" \
              && { [ -f .env.example ] && cp -n .env.example .env; true; } \
              && { for kv in $bootenv; do grep -qxF "$kv" .env 2>/dev/null || echo "$kv" >> .env; done; true; } \
              && CARGO_TARGET_DIR="/opt/raccoon-cargo-target/$repo" cargo build --workspace ) || return 1 ;;
        none|"") : ;;  # no-code / explore-only: nothing to install
        *) printf "${YELLOW}unknown runtime '%s' for %s \xe2\x80\x94 explore-only${RESET}\n" "$runtime" "$repo" ;;
    esac
    # Optional one-time app preparation (see setupCmd above), with the member's runtime on
    # PATH and its bootEnv exported — same environment the app boots with.
    if [ -n "$setupcmd" ]; then
        local spath=""
        case "$kind" in
            ruby) spath="$RBENV_PATH" ;;
            node) spath=$(_node_bin "$ver") ;;
            python) spath="$PYENV_PATH" ;;
        esac
        # Output goes to a log, not the worker's terminal: preparation is chatty (an app's
        # own seed can log hundreds of lines about services it can't reach offline, all of
        # them harmless), and a wall of red JSON reads as "something is broken". The log
        # lands in RUN_DIR so `run-app --logs` picks it up like any other.
        mkdir -p "$RUN_DIR"
        local slog="$RUN_DIR/setup-$repo.log"
        printf "  ${GRAY}preparing %s (one-time; details in ${RESET}${GRAY}run-app --logs${RESET}${GRAY})\xe2\x80\xa6${RESET}\n" "$repo"
        if ( cd "$dir" \
             && export PATH="${spath:+$spath:}$PATH" \
             && case "$kind" in ruby) export RBENV_VERSION="$ver" ;; python) export PYENV_VERSION="$ver" ;; esac \
             && { for kv in $bootenv; do export "$kv"; done; } \
             && eval "$setupcmd" ) > "$slog" 2>&1; then
            printf "  ${GRAY}\xe2\x9c\x93 %s prepared${RESET}\n" "$repo"
        else
            printf "  ${YELLOW}setup for %s did not finish cleanly \xe2\x80\x94 the repo is still explorable.${RESET}\n" "$repo"
            printf "  ${GRAY}what went wrong: %s${RESET}\n" "$slog"
        fi
    fi
    _mark_ctr_setup "$repo"
}

start_poly() {
    local repo="${1:-}"
    if [ -z "$repo" ]; then
        repo="$(_poly_default)"
        printf "${GRAY}no repo given — defaulting to '%s'. run-app <repo> picks another: %s${RESET}\n" \
            "$repo" "$(_poly_repos | tr '\n' ' ')"
    fi
    if ! _poly_repos | grep -qx "$repo"; then
        printf "${RED}unknown repo '%s'.${RESET} available: ${GRAY}%s${RESET}\n" "$repo" "$(_poly_repos | tr '\n' ' ')"
        return 1
    fi
    local dir="/workspace/repos/$repo" runtime kind ver startcmd bootenv apppath
    runtime=$(_poly_field "$repo" runtime); kind=${runtime%%:*}; ver=${runtime#*:}
    # Boot from the member's manifest directory when it isn't the repo root — the node arm reads
    # $dir/package.json to pick a dev-server script, and would otherwise find none.
    apppath=$(_poly_field "$repo" appPath); dir="$dir${apppath:+/$apppath}"
    startcmd=$(_poly_field "$repo" startCmd)
    bootenv=$(_poly_field "$repo" bootEnv)  # dummy class-load vars (e.g. IVR_UN); see setup_repo
    # Explore-only members (no-code repos, or no runtime): nothing to boot.
    if [ "$kind" = "none" ] || [ -z "$kind" ]; then
        printf "  ${CYAN}%s${RESET} is explore-only (no app to run). Read it under ${GRAY}/workspace/repos/%s${RESET}.\n" "$repo" "$repo"
        return 0
    fi
    # Runtime not in this image (EOL Ruby 2.6.6 / Python 3.7 / an uninstalled node major):
    # explorable, not runnable here. Python counts as present when EITHER pyenv has the
    # version or uv can provide it (uv-python images ship no pyenv at all — without the
    # _py_uv_ok check this gate refused every python member before the uv setup arm ran).
    if ! _asdf_ok && { { [ "$kind" = ruby ] && ! _rb_have "$ver"; } \
       || { [ "$kind" = python ] && ! _py_have "$ver" && ! _py_uv_ok "$ver"; } \
       || { [ "$kind" = node ] && [ -z "$(_node_bin "$ver")" ]; }; }; then
        printf "  ${YELLOW}%s needs %s, which isn't in this image.${RESET}\n" "$repo" "$runtime"
        printf "  Explore the code under ${GRAY}/workspace/repos/%s${RESET}; to RUN it use that repo's dedicated toolkit.\n" "$repo"
        return 0
    fi
    local running=0; for pf in "$RUN_DIR"/*.pid; do [ -e "$pf" ] && _alive "$pf" && running=1; done
    if [ "$running" = 1 ]; then
        printf "${GRAY}An app is already running.${RESET} Stop it first: ${GRAY}run-app --stop${RESET} (then ${GRAY}run-app %s${RESET}).\n" "$repo"
        return 0
    fi
    bash /workspace/.devcontainer/post-start.sh >/dev/null 2>&1 || true
    # Not --logs: setup runs before any app log exists, so its error is on screen, not in a file.
    setup_repo "$repo" || { printf "${RED}setup failed for %s${RESET} \xe2\x80\x94 ${GRAY}see the error above${RESET}\n" "$repo"; return 1; }
    local cmd=""
    case "$kind" in
        elixir)
            # asdf-only. Boot needs member-specific env/port (Phoenix reads endpoint config), so a
            # startCmd is the reliable path; without one, leave it explore-only — the worker runs
            # `mix test` / `mix phx.server` directly. Version + shims come from .tool-versions.
            if [ -n "$startcmd" ]; then
                cmd="env $bootenv $startcmd"
            else
                printf "  ${GRAY}%s: deps compiled. No startCmd wired \xe2\x80\x94 run it directly (${RESET}${GRAY}mix phx.server${RESET}${GRAY}) or its tests (${RESET}${GRAY}mix test${RESET}${GRAY}).${RESET}\n" "$repo"
                return 0
            fi ;;
        ruby)
            if _asdf_ok; then
                # Version + shims from .tool-versions (no rbenv PATH). setup regenerated bin/rails
                # when the repo shipped an empty bin/, so the app-detection below still holds.
                if   [ -n "$startcmd" ]; then cmd="env $bootenv $startcmd"
                elif [ -f "$dir/bin/rails" ]; then cmd="env $bootenv bundle exec rails server -b 0.0.0.0 -p 3000"
                elif [ -f "$dir/config.ru" ]; then cmd="env $bootenv bundle exec rackup -o 0.0.0.0 -p 3000"
                else
                    printf "  ${GRAY}%s isn't a web app (no bin/rails/config.ru) \xe2\x80\x94 run its tests directly (${RESET}${GRAY}bundle exec rails test${RESET}${GRAY}).${RESET}\n" "$repo"
                    return 0
                fi
            elif [ -n "$startcmd" ]; then
                cmd="env $bootenv PATH=$RBENV_PATH:\$PATH RBENV_VERSION=$ver $startcmd"
            elif [ -f "$dir/bin/rails" ]; then
                cmd="env $bootenv PATH=$RBENV_PATH:\$PATH RBENV_VERSION=$ver bundle exec rails server -b 0.0.0.0 -p 3000"
            elif [ -f "$dir/config.ru" ]; then
                # Rack app that isn't Rails (no bin/rails) — boot via rackup.
                cmd="env $bootenv PATH=$RBENV_PATH:\$PATH RBENV_VERSION=$ver bundle exec rackup -o 0.0.0.0 -p 3000"
            else
                printf "  ${GRAY}%s isn't a web app (no bin/rails/config.ru) \xe2\x80\x94 run its tests directly (${RESET}${GRAY}bundle exec rspec${RESET}${GRAY}).${RESET}\n" "$repo"
                return 0
            fi ;;
        node)
            local nbin sc=""
            nbin=$(_node_bin "$ver")
            if _asdf_ok; then
                # asdf node: shims already on PATH, version from .tool-versions/.nvmrc. Only a
                # startCmd-driven or dev-server boot; RN/static members fall through to explore-only.
                if [ -n "$startcmd" ]; then
                    cmd="env $bootenv PORT=3000 BROWSER=none HOST=0.0.0.0 $startcmd"
                else
                    local s2=""
                    for s2 in start dev develop serve; do
                        if node -e "process.exit((((require('$dir/package.json')||{}).scripts)||{})['$s2']?0:1)" 2>/dev/null; then break; else s2=""; fi
                    done
                    if [ -z "$s2" ]; then
                        printf "  ${GRAY}%s: deps installed, no dev-server script \xe2\x80\x94 run its tests directly (${RESET}${GRAY}yarn test${RESET}${GRAY}).${RESET}\n" "$repo"
                        return 0
                    fi
                    cmd="env $bootenv PORT=3000 BROWSER=none HOST=0.0.0.0 yarn $s2"
                fi
            elif [ -n "$startcmd" ]; then
                cmd="env $bootenv PATH=$nbin:\$PATH PORT=3000 BROWSER=none HOST=0.0.0.0 $startcmd"
            elif [ -f "$dir/metro.config.js" ] || [ -d "$dir/ios" ] || [ -d "$dir/android" ]; then
                # React Native app: no web server in a Linux container; tests still run.
                printf "  ${GRAY}%s is a React Native app (no web server here) \xe2\x80\x94 run its Jest tests directly (${RESET}${GRAY}yarn test${RESET}${GRAY}).${RESET}\n" "$repo"
                return 0
            else
                # CRA / generic: first dev-server script the repo defines, bound to :3000.
                local s
                for s in start dev develop serve; do
                    if node -e "process.exit((((require('$dir/package.json')||{}).scripts)||{})['$s']?0:1)" 2>/dev/null; then sc="$s"; break; fi
                done
                if [ -z "$sc" ]; then
                    printf "  ${GRAY}%s: deps installed, no dev-server script \xe2\x80\x94 run its tests directly (${RESET}${GRAY}yarn test${RESET}${GRAY}).${RESET}\n" "$repo"
                    return 0
                fi
                # A Create-React-App dev server (react-scripts / react-app-rewired) needs extra env
                # to survive in this non-interactive container. We spawn it with stdout redirected
                # to a log, so react-scripts sees a non-TTY and (start.js) registers a stdin-"end"
                # handler that closes the dev server the moment stdin ends — which it does at once
                # when there's no interactive terminal, so the app appears to "crash on boot". The
                # guard is `if (isInteractive || process.env.CI !== 'true')`, so CI=true is what
                # skips it and keeps the server up. CI=true does NOT make `start` treat warnings as
                # errors — that is `build` only (verified against react-scripts 3.4.1). The others:
                #   DANGEROUSLY_DISABLE_HOST_CHECK=true   let the dev server answer requests arriving
                #                                         via the published host port (belt-and-braces;
                #                                         wds3 already allows IP/localhost hosts).
                #   NODE_OPTIONS=--openssl-legacy-provider  webpack-4-era CRA crashes on Node 17+
                #                                         without it; the flag only EXISTS on Node 17+,
                #                                         so gate it on the major — older nodes (e.g.
                #                                         Node 16) abort on "bad option".
                # Non-CRA dev servers (Next.js, vite, …) don't match the test, so they boot unchanged.
                local craenv=""
                if node -e "const s=(((require('$dir/package.json')||{}).scripts)||{})['$sc']||'';process.exit(/react-scripts|react-app-rewired/.test(s)?0:1)" 2>/dev/null; then
                    craenv="CI=true DANGEROUSLY_DISABLE_HOST_CHECK=true"
                    case "${ver%%.*}" in 1[7-9]|[2-9][0-9]) craenv="NODE_OPTIONS=--openssl-legacy-provider $craenv" ;; esac
                fi
                cmd="env $bootenv $craenv PATH=$nbin:\$PATH PORT=3000 BROWSER=none HOST=0.0.0.0 yarn $sc"
            fi ;;
        python)
            if _ctr_nodeps "$repo"; then
                printf "  ${GRAY}%s: explore-only \xe2\x80\x94 its dependencies did not install, so its tests and scripts won't run here.${RESET}\n" "$repo"
                return 0
            fi
            if [ -z "$startcmd" ]; then
                printf "  ${GRAY}%s: Python deps installed. No web server is wired \xe2\x80\x94 run its tests/scripts directly (e.g. pytest).${RESET}\n" "$repo"
                return 0
            fi
            if _py_uv_ok "$ver"; then
                local vdir; vdir=$(_uv_venv_dir "$repo")
                cmd="env $bootenv VIRTUAL_ENV=$vdir PATH=$vdir/bin:\$PATH $startcmd"
            else
                cmd="env $bootenv PATH=$PYENV_PATH:\$PATH PYENV_VERSION=$ver $startcmd"
            fi ;;
        rust)
            if [ -z "$startcmd" ]; then
                printf "  ${GRAY}%s: workspace built. No web server is wired \xe2\x80\x94 run its tests directly (${RESET}${GRAY}cargo test${RESET}${GRAY}).${RESET}\n" "$repo"
                return 0
            fi
            cmd="env $bootenv CARGO_TARGET_DIR=/opt/raccoon-cargo-target/$repo $startcmd" ;;
        *) printf "${YELLOW}runtime '%s' for %s isn't runnable here \xe2\x80\x94 explore-only.${RESET}\n" "$runtime" "$repo"; return 0 ;;
    esac
    printf "  ${CYAN}\xe2\x96\xb6${RESET} starting %s (%s)\xe2\x80\xa6\n" "$repo" "$runtime"
    _spawn app "$dir" "$cmd"
    if _wait_tcp 3000; then
        printf "  ${CYAN}\xe2\x9c\x85 %s is up${RESET}  open ${CYAN}http://localhost:%s${RESET}\n" "$repo" "$CLIENT_HOST_PORT"
        # Per-member "how do I actually get in" notes. Only members whose landing page needs
        # more than the URL need an entry here (e.g. an app whose real sign-in is a hosted
        # third-party login that can't be reached offline).
        case "$repo" in
            strongsuit-app)
                printf "     ${GRAY}Sign-in normally goes through a hosted Auth0 page, which isn't reachable\n"
                printf "     offline, so this app ships a local-only dev-login route. Open\n"
                printf "     ${RESET}${CYAN}http://localhost:%s/dev-login${RESET}${GRAY} to sign in as a seeded admin\n" "$CLIENT_HOST_PORT"
                printf "     (${RESET}${GRAY}?role=MSS${RESET}${GRAY} or ${RESET}${GRAY}?role=MEMBER${RESET}${GRAY} for the other roles). The DB was seeded during setup.${RESET}\n"
                ;;
            ABDM-FE)
                printf "     ${GRAY}This app is served under a ${RESET}${GRAY}/app${RESET}${GRAY} basename, so the bare URL above renders\n"
                printf "     nothing. Open ${RESET}${CYAN}http://localhost:%s/app/login${RESET}${GRAY} instead.\n" "$CLIENT_HOST_PORT"
                printf "     Sign-in itself calls hosted services that aren't reachable offline, so the\n"
                printf "     login page is as far as you can get — read and edit the code from there.${RESET}\n"
                ;;
            search-api-v2)
                printf "     ${GRAY}Browse and try the API at ${RESET}${CYAN}http://localhost:%s/docs${RESET}${GRAY}.\n" "$CLIENT_HOST_PORT"
                printf "     Sign-in goes through a hosted identity provider that isn't reachable offline,\n"
                printf "     and this app ships no local login, so ${RESET}${GRAY}/security/login${RESET}${GRAY} returns a 500 and\n"
                printf "     authenticated routes answer ${RESET}${GRAY}Forbidden access${RESET}${GRAY} — that is expected here, not a\n"
                printf "     broken setup. To exercise authenticated behaviour, run the test suite.${RESET}\n"
                ;;
            potion-app)
                printf "     ${GRAY}Sign-in normally goes through Google or LinkedIn, neither reachable offline,\n"
                printf "     so setup seeded a verified local account. Log in at\n"
                printf "     ${RESET}${CYAN}http://localhost:%s/auth/login${RESET}${GRAY} with ${RESET}${GRAY}dev@example.com${RESET}${GRAY} / ${RESET}${GRAY}devpassword123${RESET}${GRAY}\n" "$CLIENT_HOST_PORT"
                printf "     — note ${RESET}${GRAY}/login${RESET}${GRAY} and ${RESET}${GRAY}/auth${RESET}${GRAY} both redirect elsewhere.${RESET}\n"
                ;;
        esac
    else
        printf "  ${RED}\xe2\x9a\xa0 %s didn't come up in time${RESET} \xe2\x80\x94 ${GRAY}run-app --logs${RESET}\n" "$repo"
    fi
    printf "     stop  ${GRAY}run-app --stop${RESET}   switch  ${GRAY}run-app --stop && run-app <repo>${RESET}\n"
    printf "     focus ${GRAY}cd /workspace/repos/%s && claude${RESET}  (so Claude works in this repo without being told the path)\n" "$repo"
}

# Generic Rails boot for the standard-shape apps (the rubyforgood repos): a single
# `bin/rails server` on container :3000, no separate client. The DB is seeded during
# post-create (none of these expose a working self-service signup), so the caller
# passes the demo login to print. Optional $2 is a one-line note printed above the
# login (e.g. a subdomain caveat).
#   start_rails <login-hint> [url-note]
start_rails() {
    local login_hint="${1:-}" url_note="${2:-}"
    _spawn app /workspace/repo "bin/rails server -b 0.0.0.0 -p 3000"
    printf "  ${YELLOW}\xe2\x96\xb6${RESET} starting Rails (puma)\xe2\x80\xa6\n"
    printf "  ${GRAY}\xe2\x8f\xb3 waiting for the app to come up\xe2\x80\xa6${RESET}\n"
    if _wait_tcp 3000; then
        printf "  ${YELLOW}\xe2\x9c\x85 app is up${RESET}\n"
        printf "     open  ${YELLOW}http://localhost:%s${RESET}\n" "$CLIENT_HOST_PORT"
        [ -n "$url_note" ]   && printf "     ${GRAY}%s${RESET}\n" "$url_note"
        [ -n "$login_hint" ] && printf "     login ${GRAY}%s${RESET}\n" "$login_hint"
    else
        printf "  ${RED}\xe2\x9a\xa0 the app didn't come up in time${RESET}\n"
        printf "     check the logs: ${GRAY}run-app --logs${RESET}\n"
    fi
    printf "     logs  ${GRAY}%s/app.log${RESET}\n" "$RUN_DIR"
    printf "     stop  ${GRAY}run-app --stop${RESET}\n"
}

start_app() {
    # Already running? Don't double-start.
    local running=0
    for pf in "$RUN_DIR"/*.pid; do [ -e "$pf" ] && _alive "$pf" && running=1; done
    if [ "$running" = 1 ]; then
        printf "${GRAY}The app is already running.${RESET} Use ${GRAY}run-app --restart${RESET} to restart, ${GRAY}run-app --status${RESET} to check.\n"
        printf "     open ${CYAN}http://localhost:%s${RESET}\n" "$CLIENT_HOST_PORT"
        return 0
    fi
    # Make sure the database is up before the server tries to connect.
    bash /workspace/.devcontainer/post-start.sh >/dev/null 2>&1 || true
    case "$REPO_NAME" in
        Palolo-031) start_palolo ;;
        ZenBill-006) start_zenbill ;;
        zeta-heimdall) start_zeta_heimdall ;;
        zeta-platform) start_zeta_platform ;;
        human-essentials) start_rails "test@example.com / password!  (sign in at /users/sign_in)" ;;
        endsideout) start_rails "admin@example.com / password  (sign in at /session/new)" ;;
        community-foundation)
            # Multi-tenant: the org is a subdomain, so plain localhost only shows the
            # apex landing page. The seed creates the 'arlington' tenant.
            start_rails "owner@example.com / password" \
                "this app routes by subdomain — open http://arlington.lvh.me:${CLIENT_HOST_PORT}/ (plain localhost shows only the landing page)" ;;
        stocks-in-the-future) start_rails "username admin / password  (sign in at /users/sign_in — login is by USERNAME, not email)" ;;
        casa) start_rails "casa_admin1@example.com / 12345678  (sign in at /users/sign_in)" ;;
        awbw) start_rails "umberto.user@example.com / password  (sign in at /users/sign_in)" ;;
        flaredown) start_flaredown ;;
        alongwithyou)
            # Fresh scaffold: no routes/auth yet, so plain localhost shows the default Rails
            # welcome page. No login to print. The app grows over time.
            start_rails "" "young app — no routes defined yet, so this shows the default Rails welcome page" ;;
        breezy-complete) start_breezy_complete ;;
        *)
            printf "${YELLOW}run-app isn't configured for repo '%s'.${RESET}\n" "${REPO_NAME:-unknown}"
            printf "Start the app with the project's own dev command from ${GRAY}/workspace/repo${RESET}.\n"
            return 1
            ;;
    esac
}

usage() {
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

if _is_polyglot; then
    # `run-app [<repo>] [--restart|--stop|--logs|--status]` — order-independent: the repo
    # name and the action can appear in either order (e.g. `run-app --restart zeta-hook`),
    # and the bare verbs (start/restart/stop/...) are recognized as actions, not repos.
    poly_repo=""; poly_action="start"
    for a in "$@"; do
        case "$a" in
            start) poly_action="start" ;;
            --restart|restart) poly_action="restart" ;;
            --stop|stop) poly_action="stop" ;;
            --logs|logs) poly_action="logs" ;;
            --status|status) poly_action="status" ;;
            -h|--help|help) poly_action="help" ;;
            -*) printf "${RED}Unknown option:${RESET} %s\n\n" "$a"; usage; exit 2 ;;
            *) poly_repo="$a" ;;
        esac
    done
    case "$poly_action" in
        start) start_poly "$poly_repo" ;;
        restart) stop_app; start_poly "$poly_repo" ;;
        stop) stop_app ;;
        logs) logs_app ;;
        status) status_app ;;
        help) usage ;;
    esac
    exit $?
fi

case "${1:-}" in
    ""|start) start_app ;;
    --restart|restart) stop_app; start_app ;;
    --stop|stop) stop_app ;;
    --logs|logs) logs_app ;;
    --status|status) status_app ;;
    -h|--help|help) usage ;;
    *) printf "${RED}Unknown option:${RESET} %s\n\n" "$1"; usage; exit 2 ;;
esac
