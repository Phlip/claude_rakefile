# Seeded from the shared checks config for repo `human-essentials` — task-specific checks are
# expected here and are kept; the local build step won't touch this file.
# Sourced by tests/test.sh: each line is one deterministic-signal check.
# run_signal <label> <command> [baseline_known_failures]
# raccoon-sync-hash: d4b95e7b0c617813e77d5e48edd11673f5e3145c7dcaaaeb22c486da300d2d28
# run_setup <command> — one-shot build/codegen before the checks (not scored, not counted)
run_setup 'until pg_isready -h localhost -p 5432 -U postgres >/dev/null 2>&1; do sleep 0.5; done; PG_HOST=localhost PG_USERNAME=postgres RAILS_ENV=test bundle exec rails db:schema:load'
run_signal 'rspec' 'RAILS_ENV=test PG_HOST=localhost PG_USERNAME=postgres bundle exec rspec --exclude-pattern '\''spec/system/**/*,spec/requests/partners/family_requests_requests_spec.rb'\''' ''
