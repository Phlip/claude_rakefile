#!/bin/bash
# Build a task's workspace from the local repo.
#
# Usage: scripts/build-workspace.sh <task-slug> [commit]
# Example: scripts/build-workspace.sh my-cool-task 3af4366a6
#
# If commit is omitted, reads it from the task's task.toml.

set -euo pipefail

TOOLKIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$TOOLKIT_ROOT/repo"

TASK_SLUG="$1"
TASK_DIR="$TOOLKIT_ROOT/harbor-tasks/$TASK_SLUG"

if [ ! -d "$TASK_DIR" ]; then
    echo "Error: task directory not found at $TASK_DIR" >&2
    exit 1
fi

# The member this task targets, per task.toml ([metadata].repo). Used to resolve both
# the source repo (polyglot) and the member's deterministic checks (below).
# `|| true` is load-bearing: a task.toml with no `repo =` line is perfectly valid
# (single-repo tasks don't need one), but under `set -o pipefail` grep's exit 1
# propagates out of the pipeline and `set -e` would kill the script here.
MEMBER=""
if [ -f "$TASK_DIR/task.toml" ]; then
    MEMBER=$(grep -E '^repo[[:space:]]*=' "$TASK_DIR/task.toml" | head -1 | sed -E 's/.*=[[:space:]]*"?([^"]+)"?.*/\1/' || true)
fi

# Single-repo toolkits keep the repo at $ROOT/repo; a polyglot toolkit keeps each member
# at $ROOT/repos/<member>. If the single-repo path is absent, use the member from task.toml
# so a graded task builds against the right member repo.
if [ ! -d "$REPO_DIR/.git" ] && [ -n "$MEMBER" ]; then
    if [ -d "$TOOLKIT_ROOT/repos/$MEMBER/.git" ]; then
        REPO_DIR="$TOOLKIT_ROOT/repos/$MEMBER"
    fi
fi

if [ ! -d "$REPO_DIR/.git" ]; then
    echo "Error: repo not found at $REPO_DIR" >&2
    exit 1
fi

# Get commit from arg or task.toml
if [ -n "${2:-}" ]; then
    COMMIT="$2"
else
    # `|| true` for the same reason as MEMBER above: without it, pipefail turns a
    # task.toml with no `commit` line into a bare `set -e` abort, and the explicit
    # error below never gets a chance to print.
    COMMIT=$(grep 'commit' "$TASK_DIR/task.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/' || true)
    if [ -z "$COMMIT" ]; then
        echo "Error: no commit specified and could not read from task.toml" >&2
        exit 1
    fi
fi

WORKSPACE="$TASK_DIR/environment/workspace"

echo "Building workspace for $TASK_SLUG"
echo "  Commit: $COMMIT"

# `browser = true` in task.toml gives the trial Playwright + Chromium. The build has no way
# to read task.toml — a Dockerfile can only see its build context — so the answer is written
# here as a file the Dockerfile COPYs.
#
# ALWAYS write it, including the "0" case: the COPY is unconditional, and a missing source
# fails the build. Accepts `true` and `"true"`, since the quoted form is a plausible hand-edit
# and rejecting it would silently give a task no browser after its author asked for one.
BROWSER_OPTIN=0
if [ -f "$TASK_DIR/task.toml" ] &&
    grep -qE '^[[:space:]]*browser[[:space:]]*=[[:space:]]*"?true"?[[:space:]]*$' "$TASK_DIR/task.toml"; then
    BROWSER_OPTIN=1
fi
mkdir -p "$TASK_DIR/environment"
printf '%s\n' "$BROWSER_OPTIN" > "$TASK_DIR/environment/browser-optin"

# --- DNS jail script staging -------------------------------------------------
# The Dockerfile COPYs this directory, so it must always exist (same rule as the marker
# above: a missing COPY source fails the build). The script itself is optional -- without it
# the image installs no resolver and trials simply run with normal network access.
mkdir -p "$TASK_DIR/environment/dns-jail"
if [ -f "$TOOLKIT_ROOT/task-shared/dns-jail-container.sh" ]; then
    cp "$TOOLKIT_ROOT/task-shared/dns-jail-container.sh" \
       "$TASK_DIR/environment/dns-jail/dns-jail-container.sh"
fi
# Not every member's image ships a browser, and the Explore container has one either way — so
# a task can ask for a browser it will not get. Say so here rather than let it pass silently.
if [ "$BROWSER_OPTIN" = "1" ]; then
    if grep -q "COPY browser-optin" "$TASK_DIR/environment/Dockerfile" 2>/dev/null; then
        echo "  Browser: Playwright + Chromium (browser = true)"
    else
        echo "  WARNING: browser = true, but this task's Dockerfile has no browser. The agent" >&2
        echo "           will get the Read tool and no Chromium. Either drop the flag, or use a" >&2
        echo "           member whose image ships one:" >&2
        echo "           grep -l 'COPY browser-optin' task-shared/Dockerfile.*" >&2
    fi
fi

# Resolve commit. Goes through resolve_pin so a task pinned before a history
# rewrite still builds: the pin is translated via task-shared/commit-maps/.
# shellcheck source=lib/resolve-pin.sh
. "$(dirname "$0")/lib/resolve-pin.sh"
RESOLVED_SHA=$(resolve_pin "$REPO_DIR" "$COMMIT" "$TOOLKIT_ROOT/task-shared/commit-maps" "$MEMBER") || exit 1
echo "  Resolved SHA: $RESOLVED_SHA"

# --- Member-specific setup ---------------------------------------------------
#
# A polyglot _task-scaffold can't know which member a task targets, so anything
# member-specific is resolved here instead of left to the author to remember. This is
# the one step every task runs on both the manual and snapshot paths, and task.toml
# already tells us the member. Both actions below are idempotent and never clobber
# authored content, so re-running is always safe.
SHARED_DIR="$TOOLKIT_ROOT/task-shared"
MEMBER_LC=$(echo "${MEMBER:-}" | tr '[:upper:]' '[:lower:]')

# 1. Base image. Replace the placeholder Dockerfile with the member's real base. Guarded
# on the placeholder marker so an authored Dockerfile is never touched — snapshot tasks
# append session staging to theirs, and any task may be customized by hand. The marker
# must match POLYGLOT_SCAFFOLD_DOCKERFILE in package-worker-toolkit.ts; a packaging test
# asserts the two agree so this can't silently stop matching.
TASK_DOCKERFILE="$TASK_DIR/environment/Dockerfile"
if [ -f "$TASK_DOCKERFILE" ] && grep -q 'POLYGLOT TOOLKIT' "$TASK_DOCKERFILE"; then
    if [ -n "$MEMBER_LC" ] && [ -f "$SHARED_DIR/Dockerfile.$MEMBER_LC" ]; then
        cp "$SHARED_DIR/Dockerfile.$MEMBER_LC" "$TASK_DOCKERFILE"
        echo "  Set base image: environment/Dockerfile (from Dockerfile.$MEMBER_LC)"
    else
        echo "  WARN: environment/Dockerfile is still the scaffold placeholder and no" >&2
        echo "        task-shared/Dockerfile.${MEMBER_LC:-<member>} exists to replace it with." >&2
        echo "        Set [metadata].repo in task.toml to your member, then re-run this script." >&2
        echo "        Members: $(cd "$SHARED_DIR" 2>/dev/null && ls Dockerfile.* 2>/dev/null | sed 's/Dockerfile\.//' | tr '\n' ' ')" >&2
    fi
fi

# 2. Deterministic checks (tests/typecheck/lint). tests/test.sh sources this file and
# hands its output to the grader as evidence for the CORRECTNESS score, so a task without
# it gets a correctness score judged from the code alone — no test signal behind it. The
# absent-only guard leaves an existing file untouched (a single-repo scaffold ships one).
if [ ! -f "$TASK_DIR/tests/test-commands.sh" ]; then
    CHECKS_SRC=""
    if [ -n "$MEMBER_LC" ] && [ -f "$SHARED_DIR/test-commands.$MEMBER_LC.sh" ]; then
        CHECKS_SRC="$SHARED_DIR/test-commands.$MEMBER_LC.sh"
    elif [ -f "$SHARED_DIR/test-commands.sh" ]; then
        CHECKS_SRC="$SHARED_DIR/test-commands.sh"
    fi
    if [ -n "$CHECKS_SRC" ]; then
        mkdir -p "$TASK_DIR/tests"
        cp "$CHECKS_SRC" "$TASK_DIR/tests/test-commands.sh"
        chmod +x "$TASK_DIR/tests/test-commands.sh"
        echo "  Staged deterministic checks: tests/test-commands.sh (from $(basename "$CHECKS_SRC"))"
    else
        # Say it out loud. Absence is legitimate for members with no runnable checks, but
        # silence is indistinguishable from a mistake — and it changes how the correctness
        # score is arrived at, so the author should know either way.
        echo "  NOTE: no deterministic checks available for ${MEMBER:-this repo} — the grader will"
        echo "        score correctness from the code alone, with no test/typecheck/lint signal."
    fi
fi

# Clean and recreate
rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE"

# Export repo at target commit (no git history).
# --no-same-owner: `git archive` stamps every entry as uid/gid 0, so GNU tar
# running as (container) root tries to chown files back to 0/0. On nested /
# rootless / Sysbox runtimes the container "root" is a userns-mapped uid with no
# CAP_CHOWN, so that chown fails with EPERM. --no-same-owner skips the restore
# (files are owned by the extracting user) — a no-op for real root and for
# non-root extraction, and the fix for the mapped-root case.
git -C "$REPO_DIR" archive "$RESOLVED_SHA" | tar -x --no-same-owner -C "$WORKSPACE"

# Apply workspace patch if one exists
PATCH_FILE="$TASK_DIR/environment/workspace.patch"
if [ -f "$PATCH_FILE" ]; then
    echo "  Applying workspace.patch..."
    cd "$WORKSPACE"
    # gc.auto=0 / maintenance.auto=false / gc.autoDetach=false prevent git
    # from launching background processes (gc, commit-graph, fsmonitor) that
    # can write into .git/objects after the foreground command returns. If
    # such a write races with the `rm -rf .git` below, rmdir trips on
    # "Directory not empty" and the build fails non-deterministically.
    GIT_FLAGS=(-c gc.auto=0 -c gc.autoDetach=false -c maintenance.auto=false)
    git "${GIT_FLAGS[@]}" init --quiet
    git "${GIT_FLAGS[@]}" add -A
    # Inject identity inline so this works on containers without a global
    # git config (e.g., native Linux Docker, fresh container images).
    # The .git directory is deleted on the next line, so these values are
    # throwaway and never reach the patch, the workspace, or the agent.
    git "${GIT_FLAGS[@]}" -c user.email=toolkit@local -c user.name=Toolkit commit -m "base" --quiet
    git "${GIT_FLAGS[@]}" apply "$PATCH_FILE"
    # Belt-and-suspenders: retry rm a few times in case anything still races.
    for _ in 1 2 3; do
        if rm -rf .git 2>/dev/null; then
            break
        fi
        sleep 0.5
    done
    # Final attempt without swallowing errors, so a genuine failure surfaces.
    if [ -d .git ]; then
        rm -rf .git
    fi
    cd "$TOOLKIT_ROOT"
    echo "  Patch applied."
fi

# Bundle transitive poetry sibling deps. Some polyglot Python members poetry-depend on
# sibling repos via `ssh://git@github.com/AskZeta/<name>`, which can't resolve in a single-member
# harbor image (no SSH key / network). Archive the transitive closure into workspace/.zeta-siblings/<name>/
# from the toolkit's repos/zeta-<name>/ (members are packaged under their display name zeta-<name>);
# the generated Dockerfile rewrites those git deps to
# these local paths before `poetry install`. No-op for members without such deps.
if [ -f "$WORKSPACE/pyproject.toml" ]; then
    SIB_DIR="$WORKSPACE/.zeta-siblings"
    queue=("$WORKSPACE/pyproject.toml")
    seen=" "
    while [ "${#queue[@]}" -gt 0 ]; do
        pp="${queue[0]}"; queue=("${queue[@]:1}")
        [ -f "$pp" ] || continue
        for name in $(grep -oE 'ssh://git@github\.com/AskZeta/[A-Za-z0-9._-]+' "$pp" 2>/dev/null | sed -E 's#.*/AskZeta/##; s#\.git$##' | sort -u); do
            case "$seen" in *" $name "*) continue ;; esac
            seen="$seen$name "
            sib="$TOOLKIT_ROOT/repos/zeta-$name"
            [ -e "$sib/.git" ] || { echo "  WARN: sibling repo not found: $name" >&2; continue; }
            mkdir -p "$SIB_DIR/$name"
            git -C "$sib" archive HEAD | tar -x --no-same-owner -C "$SIB_DIR/$name"
            queue+=("$SIB_DIR/$name/pyproject.toml")
        done
    done
    [ -d "$SIB_DIR" ] && echo "  Bundled siblings:$(printf '%s' "${seen# }" | sed 's/ $//' | sed 's/^/ /')"
fi

# Bundle Maven sibling libs. The swingbell-polyglot Java services depend on sibling shared
# artifacts (com.swingbell*: common-repository, common-aws-service, jasper-report from
# `reports`, jwt-encryption-decryption) at 0.0.1-SNAPSHOT — resolvable only from a local
# reactor install, never a registry. Walk the dependency closure (a bundled provider's own
# pom can name further siblings — `reports` needs common-repository) into
# workspace/.sbl-siblings/<name>/ with an ORDER file in install order (commons before
# consumers); the generated java Dockerfile `mvn install`s them into ~/.m2 before building
# the member. No-op without a pom or refs.
#
# Twin forks: the book-my-minutes-* repos publish the SAME coordinates as the swingbell
# commons (com.swingbell.common:common-repository:0.0.1-SNAPSHOT etc. — the twin naming is
# repo-level only, invisible to Maven), so an artifactId resolves to the provider from the
# member's own family.
if [ -f "$WORKSPACE/pom.xml" ] && grep -q 'com\.swingbell' "$WORKSPACE/pom.xml" 2>/dev/null; then
    SBL_DIR="$WORKSPACE/.sbl-siblings"
    case "$MEMBER" in book-my-minutes-*) SBL_TWIN=book-my-minutes- ;; *) SBL_TWIN= ;; esac
    queue=("$WORKSPACE/pom.xml")
    seen=" "
    while [ "${#queue[@]}" -gt 0 ]; do
        pom="${queue[0]}"; queue=("${queue[@]:1}")
        [ -f "$pom" ] || continue
        for artifact in $(grep -oE '<artifactId>(common-repository|common-aws-service|jasper-report|jwt-encryption-decryption)</artifactId>' "$pom" 2>/dev/null | sed -E 's#</?artifactId>##g' | sort -u); do
            case "$artifact" in
                common-repository|common-aws-service) provider="$SBL_TWIN$artifact" ;;
                jasper-report) provider=reports ;;
                jwt-encryption-decryption) provider=jwt-encryption-decryption ;;
            esac
            case "$seen" in *" $provider "*) continue ;; esac
            # never bundle the member into itself: the pom's OWN <artifactId> declaration
            # matches the grep above just like a dependency would ($MEMBER is the task repo)
            [ "$provider" = "$MEMBER" ] && continue
            seen="$seen$provider "
            sib="$TOOLKIT_ROOT/repos/$provider"
            [ -e "$sib/.git" ] || { echo "  WARN: maven sibling repo not found: $provider" >&2; continue; }
            mkdir -p "$SBL_DIR/$provider"
            git -C "$sib" archive HEAD | tar -x --no-same-owner -C "$SBL_DIR/$provider"
            queue+=("$SBL_DIR/$provider/pom.xml")
        done
    done
    # ORDER = canonical install order (providers before their consumers), filtered to the
    # closure just bundled — discovery order is consumer-first, which is backwards for install.
    for provider in "${SBL_TWIN}common-repository" "${SBL_TWIN}common-aws-service" jwt-encryption-decryption reports; do
        case "$seen" in *" $provider "*) echo "$provider" >> "$SBL_DIR/ORDER" ;; esac
    done
    [ -f "$SBL_DIR/ORDER" ] && echo "  Bundled maven siblings: $(tr '\n' ' ' < "$SBL_DIR/ORDER")"
fi

# --- Reference-data corpus: mounted at /data/zeta-corpus in the trial -----------------------
# If this toolkit ships the supplementary data corpus, it's included in every trial — staged into
# the build context + a COPY added to the Dockerfile, so what you see while authoring (bind-mounted
# at /data/zeta-corpus) is exactly what the trial sees. Toolkits without a corpus never include it.
CORPUS_SRC=""
for cand in "${ZETA_CORPUS_DIR:-}" "$TOOLKIT_ROOT/data/zeta-corpus" "/data/zeta-corpus"; do
    [ -n "$cand" ] && [ -d "$cand" ] && { CORPUS_SRC="$cand"; break; }
done
if [ -n "$CORPUS_SRC" ]; then
    CORPUS_STAGE="$TASK_DIR/environment/corpus"
    rm -rf "$CORPUS_STAGE"
    # hardlink-stage (cp -al ~free, same filesystem as the toolkit); full copy fallback.
    cp -al "$CORPUS_SRC/." "$CORPUS_STAGE" 2>/dev/null || cp -a "$CORPUS_SRC/." "$CORPUS_STAGE"
    DF="$TASK_DIR/environment/Dockerfile"
    # Wrapped in toolkit-managed sentinels so scripts/check-task-infra.ts can tell
    # this append apart from an author's edit — see scripts/lib/task-infra-integrity.ts.
    if [ -f "$DF" ] && ! grep -qF 'COPY corpus/ /data/zeta-corpus' "$DF"; then
        { echo ""; echo "# >>> toolkit-managed: corpus >>>"; \
          echo "# Reference-data corpus at /data/zeta-corpus (staged by build-workspace)."; \
          echo "COPY corpus/ /data/zeta-corpus/"; \
          echo "# <<< toolkit-managed <<<"; } >> "$DF"
    fi
    if [ -f "$TASK_DIR/task.toml" ]; then
        CUR=$(grep -oE '^[[:space:]]*storage_mb[[:space:]]*=[[:space:]]*[0-9]+' "$TASK_DIR/task.toml" | grep -oE '[0-9]+' | head -1 || echo 0)
        # 10240 = the sandbox disk ceiling (a higher request is rejected downstream).
        if [ "${CUR:-0}" -lt 10240 ] && grep -qE '^[[:space:]]*storage_mb[[:space:]]*=' "$TASK_DIR/task.toml"; then
            sed -i.bak -E 's/^([[:space:]]*storage_mb[[:space:]]*=[[:space:]]*)[0-9]+/\110240/' "$TASK_DIR/task.toml"
            rm -f "$TASK_DIR/task.toml.bak"
        fi
    fi
    echo "  Corpus: staged from $CORPUS_SRC -> environment/corpus + Dockerfile COPY (storage_mb>=10240)"
fi

FILE_COUNT=$(find "$WORKSPACE" -type f | wc -l | tr -d ' ')
echo "  Workspace: $WORKSPACE ($FILE_COUNT files)"

# Toolkit-managed files. Stamp them if they aren't already (tasks copied from
# _task-scaffold arrive stamped; this covers the ones built by snapshot-to-task), then
# report. Advisory only — this script writes to the Dockerfile itself, so it never
# blocks; harbor-run and submit-task do.
CHECK_INFRA="$TOOLKIT_ROOT/scripts/check-task-infra.ts"
if [ -f "$CHECK_INFRA" ]; then
    (cd "$TOOLKIT_ROOT" && npx tsx "$CHECK_INFRA" --stamp "$TASK_SLUG") || true
    (cd "$TOOLKIT_ROOT" && npx tsx "$CHECK_INFRA" "$TASK_SLUG") || true
fi

echo "Done."
