#!/bin/bash
# Welcome banner for raccoon dev containers

CYAN='\033[1;36m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
RESET='\033[0m'

CONTAINER_TYPE="${1:-explore}"

if [ "$CONTAINER_TYPE" = "explore" ]; then
    COLOR="$CYAN"
else
    COLOR="$YELLOW"
fi

cat << 'RACCOON'

 .----------------.  .----------------.  .----------------.  .----------------.  .----------------.  .----------------.  .-----------------.
| .--------------. || .--------------. || .--------------. || .--------------. || .--------------. || .--------------. || .--------------. |
| |  _______     | || |      __      | || |     ______   | || |     ______   | || |     ____     | || |     ____     | || | ____  _____  | |
| | |_   __ \    | || |     /  \     | || |   .' ___  |  | || |   .' ___  |  | || |   .'    `.   | || |   .'    `.   | || ||_   \|_   _| | |
| |   | |__) |   | || |    / /\ \    | || |  / .'   \_|  | || |  / .'   \_|  | || |  /  .--.  \  | || |  /  .--.  \  | || |  |   \ | |   | |
| |   |  __ /    | || |   / ____ \   | || |  | |         | || |  | |         | || |  | |    | |  | || |  | |    | |  | || |  | |\ \| |   | |
| |  _| |  \ \_  | || | _/ /    \ \_ | || |  \ `.___.'\  | || |  \ `.___.'\  | || |  \  `--'  /  | || |  \  `--'  /  | || | _| |_\   |_  | |
| | |____| |___| | || ||____|  |____|| || |   `._____.'  | || |   `._____.'  | || |   `.____.'   | || |   `.____.'   | || ||_____|\____| | |
| |              | || |              | || |              | || |              | || |              | || |              | || |              | |
| '--------------' || '--------------' || '--------------' || '--------------' || '--------------' || '--------------' || '--------------' |
 '----------------'  '----------------'  '----------------'  '----------------'  '----------------'  '----------------'  '----------------' 

                 __        .-.
             .-"` .`'.    /\\|
     _(\-/)_" ,  .   ,\  /\\\/
    {(#b^d#)} .   ./,  |/\\\/
    `-.(Y).-`  ,  |  , |\.-`
         /~/,_/~~~\,__.-`
        ////~    // ~\\
      ==`==`   ==`   ==`
------------------------------------------------

RACCOON

# Per-repo notes. Two kinds of thing surface here:
#
#  1. Setup side effects — some source repos need their toolchain adapted to the
#     container at setup time (e.g. a pinned language version the base image
#     doesn't ship, or a dependency incompatible with the base image's OpenSSL).
#     Those adjustments touch tracked files, so a fresh container can show a
#     non-empty `git status` even though the worker hasn't changed anything.
#     Calling it out here keeps it reading as expected setup, not the worker's
#     own edits.
#  2. How to run the app locally — the commands to bring the app up in the
#     browser so the worker can click through the real workflows while they
#     explore. Ports are published by the explore devcontainer.json, and the
#     dev DB is seeded during post-create so login works out of the box.
REPO=$(node -e "try{process.stdout.write(require('/workspace/toolkit.json').repo)}catch{}" 2>/dev/null)
# Prefer the live host port exported into the container ($EXPLORE_CLIENT_PORT),
# falling back to the toolkit.json default then 3000 for older containers.
CLIENT_PORT="${EXPLORE_CLIENT_PORT:-$(node -e "try{process.stdout.write(String(require('/workspace/toolkit.json').explorePorts.clientHost))}catch{process.stdout.write('3000')}" 2>/dev/null || echo 3000)}"
IS_POLYGLOT=$(node -e "try{process.stdout.write(require('/workspace/toolkit.json').polyglot?'1':'')}catch{}" 2>/dev/null)

# Reference-data corpus viewer (zeta toolkits): a small always-on web UI + search index
# over the shipped corpus. Only mentioned when this build actually carries the index.
CORPUS_PORT="${EXPLORE_CORPUS_PORT:-$(node -e "try{const p=require('/workspace/toolkit.json').explorePorts.corpusHost;if(p)process.stdout.write(String(p))}catch{}" 2>/dev/null)}"
corpus_banner() {
    if [ -f /workspace/data/corpus-index/corpus.db ]; then
        printf "${COLOR}Reference-data corpus:${RESET} real company slack/jira/email/support data at ${GRAY}/data/zeta-corpus${RESET}.\n"
        printf "Browse + search it at ${GRAY}http://localhost:${CORPUS_PORT:-3002}${RESET} (auto-started; ${GRAY}view-corpus --help${RESET} to manage),\n"
        printf "or query the index directly — see ${GRAY}/workspace/corpus-viewer/README.md${RESET}. Great for anchoring\n"
        printf "a task in a real incident, ticket, or support thread.\n\n"
    fi
}
if [ -n "$IS_POLYGLOT" ]; then
    DEF=$(node -e "try{process.stdout.write(require('/workspace/toolkit.json').defaultRepo||'')}catch{}" 2>/dev/null)
    printf "${COLOR}This toolkit hosts several repos.${RESET} Pick one to explore and run:\n"
    node -e "require('/workspace/toolkit.json').repos.forEach(r=>console.log('   • '+r.repo))" 2>/dev/null
    printf "\n${COLOR}To work on one repo:${RESET}\n"
    printf "  1. ${GRAY}run-app ${DEF}${RESET}                installs deps + prepares the DB on first use, then boots the app\n"
    printf "     ${GRAY}(it prints the URL to open, and how to sign in when the app needs a login)${RESET}\n"
    printf "  2. ${GRAY}cd /workspace/repos/${DEF}${RESET}    focus your shell on that repo\n"
    printf "  3. ${GRAY}codex${RESET}                         launch it FROM the repo dir, so it works there without being told the path (${GRAY}claude${RESET} also available)\n"
    printf "Then open ${GRAY}http://localhost:${CLIENT_PORT}${RESET}. Switch repos: ${GRAY}run-app --stop${RESET}, then repeat for another.\n"
    printf "Some repos ship a runnable test suite, many don't — ${GRAY}run-app${RESET} tells you what each one has.\n"
    printf "Where a suite exists the grader runs it for the deterministic checks behind the correctness\n"
    printf "score; where none does, correctness is judged from the code alone.\n\n"
    corpus_banner
    printf "${GRAY}Want another container in parallel (its own copy of every member repo, e.g. a different commit / repo state)?${RESET}\n"
    printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
    return 0 2>/dev/null || exit 0
fi
case "$REPO" in
    ZenBill-006)
        printf "${YELLOW}Heads up:${RESET} first-time setup adapts this app to the container's Ruby/OpenSSL,\n"
        printf "modifying a few tracked files — ${GRAY}Gemfile${RESET}, ${GRAY}Gemfile.lock${RESET}, ${GRAY}db/schema.rb${RESET}.\n"
        printf "They show in ${GRAY}git status${RESET}, but that's expected setup — not your changes.\n\n"
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET}  (this app routes by subdomain —\n"
        printf "plain ${GRAY}localhost${RESET} shows only the Rails welcome page; see the README for /etc/hosts setup).\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
    zeta-heimdall)
        printf "${YELLOW}Heads up:${RESET} first-time setup installs gems and prepares the DB, which can\n"
        printf "touch tracked files (${GRAY}Gemfile${RESET}, ${GRAY}Gemfile.lock${RESET}, ${GRAY}db/schema.rb${RESET}, ${GRAY}config/database.yml${RESET}).\n"
        printf "They show in ${GRAY}git status${RESET}, but that's expected setup — not your changes.\n\n"
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET}. It's a JSON API (no UI) on\n"
        printf "${GRAY}http://localhost:${CLIENT_PORT}${RESET} — hit an endpoint rather than expecting a page.\n"
        printf "Runnable test suite: ${GRAY}bundle exec rspec${RESET} — the grader draws on it for the\n"
        printf "deterministic checks behind the correctness score.\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
    zeta-platform)
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET} — boots the React UI on ${GRAY}http://localhost:${CLIENT_PORT}${RESET}\n"
        printf "plus the Rails API it proxies to (on :5000 inside the container).\n"
        printf "Runnable test suite: ${GRAY}bundle exec rspec${RESET} (large suite; Postgres + Redis are baked in;\n"
        printf "rspec needs neither the client nor the running server).\n\n"
        printf "${YELLOW}About this codebase:${RESET} a handful of specs are red here for reasons unrelated to\n"
        printf "any task (timestamp precision, one stale model-method reference, and specs needing\n"
        printf "third-party credentials this copy doesn't carry). They're skipped in\n"
        printf "${GRAY}spec/support/known_failing_specs.rb${RESET}, so ${GRAY}bundle exec rspec${RESET} is green out of the box.\n"
        printf "Scope your task's deterministic checks to the specs relevant to your task rather than\n"
        printf "the whole suite.\n\n"
        corpus_banner
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
    Palolo-031)
        printf "${COLOR}Run the app${RESET} in one command:\n"
        printf "  ${GRAY}run-app${RESET}    (starts the server + client, waits until ready, prints the URL)\n"
        printf "Then open ${GRAY}http://localhost:${CLIENT_PORT}${RESET} and log in as ${GRAY}zaniyah@exhalefi.com${RESET} / ${GRAY}test${RESET}.\n"
        printf "${GRAY}Stop it with ${RESET}${GRAY}run-app --stop${RESET}${GRAY}; follow logs with ${RESET}${GRAY}run-app --logs${RESET}${GRAY}.${RESET}\n"
        printf "${GRAY}(The dev DB is seeded automatically during setup — re-run the seed with${RESET}\n"
        printf "${GRAY} DEFAULT_BAAS_PROVIDER=Liquid PUBLIC_BAAS_ENABLED=yes TESTING_SEED=yes pnpm run seed --small.)${RESET}\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n"
        printf "${GRAY}  (it runs for exploring, but its browser app calls the first container's API.)${RESET}\n\n"
        ;;
    human-essentials)
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET} — boots the Rails UI on\n"
        printf "${GRAY}http://localhost:${CLIENT_PORT}${RESET}. The dev DB is seeded during setup; log in at\n"
        printf "${GRAY}/users/sign_in${RESET} as ${GRAY}test@example.com${RESET} / ${GRAY}password!${RESET} (there's no self-service\n"
        printf "signup — re-seed with ${GRAY}bin/rails db:seed${RESET}). Verifier: ${GRAY}bundle exec rspec${RESET}.\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
    endsideout)
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET} — boots the Rails UI on\n"
        printf "${GRAY}http://localhost:${CLIENT_PORT}${RESET}. The dev DB (SQLite) is seeded during setup; log in at\n"
        printf "${GRAY}/session/new${RESET} as ${GRAY}admin@example.com${RESET} / ${GRAY}password${RESET} (there's no self-service\n"
        printf "signup — re-seed with ${GRAY}bin/rails db:seed${RESET}). Verifier: ${GRAY}bin/rails test${RESET}.\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
    community-foundation)
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET} — boots the Rails UI. This app is\n"
        printf "${YELLOW}multi-tenant by subdomain${RESET}: plain ${GRAY}localhost${RESET} shows only the apex landing page.\n"
        printf "Open the seeded tenant at ${GRAY}http://arlington.lvh.me:${CLIENT_PORT}/${RESET} and log in as\n"
        printf "${GRAY}owner@example.com${RESET} / ${GRAY}password${RESET} (seeded during setup; no self-service signup —\n"
        printf "re-seed with ${GRAY}bin/rails db:seed${RESET}). Verifier: ${GRAY}bin/rails test${RESET}.\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
    stocks-in-the-future)
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET} — boots the Rails UI on\n"
        printf "${GRAY}http://localhost:${CLIENT_PORT}${RESET}. The dev DB is seeded during setup; log in at\n"
        printf "${GRAY}/users/sign_in${RESET} as username ${GRAY}admin${RESET} / ${GRAY}password${RESET} (login is by ${YELLOW}username${RESET}, not\n"
        printf "email; no self-service signup — re-seed with ${GRAY}bin/rails db:seed${RESET}). Verifier: ${GRAY}bin/rails test${RESET}.\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
    casa)
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET} — boots the Rails UI on\n"
        printf "${GRAY}http://localhost:${CLIENT_PORT}${RESET}. The dev DB is seeded during setup; log in at\n"
        printf "${GRAY}/users/sign_in${RESET} as ${GRAY}casa_admin1@example.com${RESET} / ${GRAY}12345678${RESET} (users are admin-invited,\n"
        printf "no self-service signup — re-seed with ${GRAY}bin/rails db:seed${RESET}). Verifier: ${GRAY}bundle exec rspec${RESET}.\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
    awbw)
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET} — boots the Rails UI on\n"
        printf "${GRAY}http://localhost:${CLIENT_PORT}${RESET}. The dev DB is seeded during setup; log in at\n"
        printf "${GRAY}/users/sign_in${RESET} as ${GRAY}umberto.user@example.com${RESET} / ${GRAY}password${RESET} (there's no self-service\n"
        printf "signup — re-seed with ${GRAY}bin/rails db:seed${RESET}). Verifier: ${GRAY}bundle exec rspec${RESET}.\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
    flaredown)
        printf "${YELLOW}Heads up:${RESET} this app has two parts — a Rails API in ${GRAY}backend/${RESET} and an Ember\n"
        printf "client in ${GRAY}frontend/${RESET} (not at the repo root). First-time setup installs gems +\n"
        printf "JS deps and migrates the databases, which can touch tracked files.\n\n"
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET} — boots the Ember UI on\n"
        printf "${GRAY}http://localhost:${CLIENT_PORT}${RESET} plus the Rails API it proxies to (on :5000 inside the\n"
        printf "container). Three datastores are baked in: ${GRAY}Postgres${RESET} + ${GRAY}Redis${RESET} (Sidekiq) + ${GRAY}MongoDB${RESET}\n"
        printf "(Mongoid, the primary store). The backend test suite is the API verifier:\n"
        printf "${GRAY}cd backend && bundle exec rspec${RESET} (needs neither the client nor the running server).\n\n"
        printf "The repo's own ${GRAY}CLAUDE.md${RESET} / ${GRAY}README${RESET} describe running it with ${GRAY}make${RESET} + ${GRAY}docker compose${RESET}.\n"
        printf "That's the upstream workflow, for your host — ${YELLOW}there's no Docker daemon in here${RESET}, so\n"
        printf "use ${GRAY}run-app${RESET} and ${GRAY}bundle exec rspec${RESET} instead. Everything is already installed.\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
    alongwithyou)
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET} — boots the Rails UI on\n"
        printf "${GRAY}http://localhost:${CLIENT_PORT}${RESET}. This is a ${YELLOW}young app${RESET} (a fresh Rails 8.1 scaffold\n"
        printf "being built with the Dewberry Cancer Center) — no routes or auth exist yet, so\n"
        printf "the browser shows the default Rails welcome page. It grows over time.\n"
        printf "Verifier: ${GRAY}bin/rails test${RESET} (SQLite; no external services).\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
    breezy-complete)
        printf "${COLOR}Run the app${RESET} in one command: ${GRAY}run-app${RESET} — boots the Rails API (${GRAY}backend/${RESET}) and the\n"
        printf "Next.js frontend (${GRAY}frontend/${RESET}). Open ${GRAY}http://localhost:${CLIENT_PORT}/pro_signin${RESET} — auth is\n"
        printf "bypassed offline and it auto-redirects to the seeded professional's dashboard\n"
        printf "(no login needed; re-seed with ${GRAY}cd backend && bundle exec rails db:seed${RESET}).\n"
        printf "Verifier: ${GRAY}cd backend && RAILS_ENV=test bundle exec rspec${RESET} (RSpec is the suite of record).\n"
        printf "${YELLOW}Don't${RESET} export ${GRAY}DISABLE_CLERK${RESET}/${GRAY}CLERK_SKIP_RAILTIE${RESET}/${GRAY}DATABASE_URL${RESET} into your shell — several\n"
        printf "controller specs 403 under the Clerk bypass; run-app scopes it to the servers.\n\n"
        printf "${GRAY}Want another container with its own separate working tree (e.g. a different commit / repo state)?${RESET}\n"
        printf "${GRAY}On the host, from explore/:  node instance.js b   then: node instance.js shell b${RESET}\n\n"
        ;;
esac