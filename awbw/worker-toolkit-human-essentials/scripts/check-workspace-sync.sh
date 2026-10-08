#!/bin/bash
# Check that a task's live environment/workspace matches what a rebuild from
# the pinned commit + environment/workspace.patch would produce — i.e. the
# workspace every downstream consumer of the task actually sees. Files edited
# (or added/deleted) directly in the built workspace are visible to your local
# trials but do NOT survive packaging: your own tarball may carry them, but
# the finalized task keeps only the rebuild inputs (the workspace/ dir itself
# is gitignored), and everywhere downstream the workspace is rebuilt from the
# gitref in task.toml plus workspace.patch (see build-workspace.sh) — anything
# not captured there is silently dropped.
#
# Usage:
#   bash scripts/check-workspace-sync.sh <task-dir>                  # check (advisory)
#   bash scripts/check-workspace-sync.sh --update-patch <task-dir>   # fold live edits into workspace.patch
#
# Check mode is run automatically at the start of every `scripts/harbor-run`.
# It warns loudly when the workspace has uncaptured changes, and always exits
# 0 — it never blocks a run. It also exits 0 (silently) when it can't resolve
# the source repo or the pinned commit, since it can't tell anything useful
# then.
#
# --update-patch regenerates environment/workspace.patch as the full diff from
# the pinned commit to the live workspace (the previous patch's changes are
# preserved — they're part of that diff). After updating the patch, re-run
# your trials: reference runs should be captured against the workspace every
# downstream rebuild produces.
#
# Mechanics: the pinned commit's tree is read into a THROWAWAY git index (with
# a throwaway object directory layered over the repo's, so the source repo is
# never written to), workspace.patch is applied to that index, and the live
# workspace directory is compared against it. Files matched by the repo's
# .gitignore are not considered — they can't be captured in workspace.patch
# either, so they never ship either way. File-mode-only changes are ignored
# (core.fileMode=false), matching how patches are generated here.

set -euo pipefail

MODE="check"
if [ "${1:-}" = "--update-patch" ]; then
    MODE="update"
    shift
fi

if [ -z "${1:-}" ]; then
    echo "Usage: $0 [--update-patch] <task-dir>" >&2
    exit 1
fi

# Normalize the task dir (tolerates relative paths and trailing slashes).
TASK_DIR="$(cd "$1" 2>/dev/null && pwd)" || {
    echo "Error: task directory not found: $1" >&2
    exit 1
}
SLUG="$(basename "$TASK_DIR")"
# Tasks live at <root>/harbor-tasks/<slug> in every layout this script ships to.
ROOT="$(cd "$TASK_DIR/../.." && pwd)"

WORKSPACE="$TASK_DIR/environment/workspace"
PATCH_FILE="$TASK_DIR/environment/workspace.patch"
TASK_TOML="$TASK_DIR/task.toml"

# How to spell this script in the recommendations we print. In a packed
# toolkit it lives at <root>/scripts/ (the worker's usual cwd is <root>), so
# the short form works; anywhere else (e.g. invoked from the internal repo
# layout via harbor-run) fall back to the invoked path.
SELF_DISPLAY="bash scripts/check-workspace-sync.sh"
if [ ! -f "$ROOT/scripts/check-workspace-sync.sh" ]; then
    SELF_DISPLAY="bash $0"
fi

# In check mode every "can't verify" path exits 0 quietly: this is an advisory
# preflight and a task we can't reason about must never break a run. In
# --update-patch mode the same conditions are hard errors — the user asked for
# a patch and we can't produce one.
skip() {
    if [ "$MODE" = "update" ]; then
        echo "Error: $1" >&2
        exit 1
    fi
    exit 0
}

[ -d "$WORKSPACE" ] || skip "workspace not built at $WORKSPACE (run build-workspace.sh first)"
[ -f "$TASK_TOML" ] || skip "no task.toml at $TASK_TOML"

# Pinned commit: the `commit = "..."` line in task.toml. Anchored to the line
# start so prose mentions (e.g. a `source = "... commit abc"` note) don't
# match. No commit line is legitimate for some internally-built tasks — then
# there's nothing to compare against.
COMMIT="$(grep -E '^[[:space:]]*commit[[:space:]]*=' "$TASK_TOML" | head -1 | sed 's/.*"\(.*\)".*/\1/' || true)"
[ -n "$COMMIT" ] || skip "no commit pinned in task.toml"

# The member this task targets, per task.toml ([metadata].repo) — used to
# resolve the source repo in polyglot layouts. Same extraction as
# build-workspace.sh.
MEMBER="$(grep -E '^repo[[:space:]]*=' "$TASK_TOML" | head -1 | sed -E 's/.*=[[:space:]]*"?([^"]+)"?.*/\1/' || true)"

# Source repo resolution, in order:
#   <root>/repo                  — single-repo toolkit
#   <root>/repos/<member>        — polyglot toolkit
#   <root>/repos/<member>/repo   — internal submodule layout
REPO_DIR=""
for cand in "$ROOT/repo" ${MEMBER:+"$ROOT/repos/$MEMBER" "$ROOT/repos/$MEMBER/repo"}; do
    if [ -e "$cand/.git" ]; then
        REPO_DIR="$cand"
        break
    fi
done
[ -n "$REPO_DIR" ] || skip "source repo not found under $ROOT"

# Resolve the repo's real git dir (handles submodules, whose .git is a file).
GITDIR="$(git -C "$REPO_DIR" rev-parse --absolute-git-dir 2>/dev/null)" || skip "not a git repo: $REPO_DIR"
# Via resolve_pin, so a task pinned before a history rewrite keeps being checked
# rather than silently skipping every run once its SHA stops resolving.
# shellcheck source=lib/resolve-pin.sh
. "$(dirname "$0")/lib/resolve-pin.sh"
RESOLVED_SHA="$(resolve_pin "$REPO_DIR" "$COMMIT" "$ROOT/task-shared/commit-maps" "$MEMBER" 2>/dev/null)" || \
    skip "pinned commit $COMMIT not found in $REPO_DIR"

# --- Throwaway git state ------------------------------------------------------
# A temp index + temp object dir (with the real object dir as a read-only
# alternate) lets us build "commit + patch" as an index and diff the live
# workspace against it without ever writing to the source repo or creating a
# .git inside the workspace.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_INDEX_FILE="$TMP/index"
export GIT_OBJECT_DIRECTORY="$TMP/objects"
export GIT_ALTERNATE_OBJECT_DIRECTORIES="$GITDIR/objects"
mkdir -p "$GIT_OBJECT_DIRECTORY"

# Suppress mode-bit and line-ending munging so the comparison is about content,
# and keep non-ASCII paths readable instead of C-quoted ("\360\237...").
GIT_FLAGS=(-c core.fileMode=false -c core.autocrlf=false -c core.quotePath=false)

git --git-dir="$GITDIR" "${GIT_FLAGS[@]}" read-tree "$RESOLVED_SHA"

# `.zeta-siblings/` is staged INTO the workspace by build-workspace.sh on some
# toolkits (bundled sibling deps) — a build artifact, never part of the patch.
# `.raccoon-setup-done` is run-app's per-repo first-use setup marker (polyglot
# toolkits) — authoring-machine state, never task content. run-app git-ignores
# it via the repo's .git/info/exclude, but this script diffs through a
# throwaway --git-dir that never reads that file, so exclude it here too.
# The leading `.` positive pathspec is load-bearing: several git commands
# reject a pathspec made of nothing but exclusions.
EXCLUDES=("." ":(exclude).zeta-siblings" ":(exclude).raccoon-setup-done")

cd "$WORKSPACE"
export GIT_WORK_TREE="$WORKSPACE"

if [ "$MODE" = "update" ]; then
    # Stage the live workspace on top of the pinned tree, then emit the full
    # tree -> index diff as the new workspace.patch. --binary --full-index so
    # binary additions survive a later `git apply`.
    git --git-dir="$GITDIR" "${GIT_FLAGS[@]}" add -A -- "${EXCLUDES[@]}"
    NEW_PATCH="$TMP/workspace.patch"
    git --git-dir="$GITDIR" "${GIT_FLAGS[@]}" diff --cached --binary --full-index "$RESOLVED_SHA" -- "${EXCLUDES[@]}" > "$NEW_PATCH"

    if [ ! -s "$NEW_PATCH" ]; then
        if [ -f "$PATCH_FILE" ]; then
            rm -f "$PATCH_FILE"
            echo "Workspace matches commit $COMMIT exactly — removed the now-empty environment/workspace.patch."
        else
            echo "Workspace matches commit $COMMIT exactly — no workspace.patch needed."
        fi
        exit 0
    fi

    # Verify the regenerated patch applies to the pristine tree before
    # installing it, so we never leave behind a patch build-workspace.sh
    # would choke on.
    GIT_INDEX_FILE="$TMP/verify-index" git --git-dir="$GITDIR" "${GIT_FLAGS[@]}" read-tree "$RESOLVED_SHA"
    GIT_INDEX_FILE="$TMP/verify-index" git --git-dir="$GITDIR" "${GIT_FLAGS[@]}" apply --cached --check "$NEW_PATCH" || {
        echo "Error: regenerated patch does not apply cleanly to $COMMIT — workspace.patch left unchanged." >&2
        exit 1
    }

    cp "$NEW_PATCH" "$PATCH_FILE"
    FILE_COUNT="$(git --git-dir="$GITDIR" "${GIT_FLAGS[@]}" diff --cached --name-only "$RESOLVED_SHA" -- "${EXCLUDES[@]}" | wc -l | tr -d ' ')"
    echo "Wrote environment/workspace.patch: $FILE_COUNT file(s) differ from commit $COMMIT."
    if [ -f "$TASK_DIR/environment/session.jsonl" ]; then
        echo ""
        echo "NOTE: this task was built from a session snapshot, so workspace.patch is"
        echo "meant to mirror the workspace state the captured session describes. Make"
        echo "sure these folded-in changes don't contradict the session transcript —"
        echo "if they belong to the session's story, re-capturing the snapshot"
        echo "(/create-snapshot:snapshot, then scripts/snapshot-to-task.ts) is the"
        echo "cleaner fix."
    fi
    echo ""
    echo "Re-run your trials so your reference runs match what now ships:"
    echo "  scripts/harbor-run harbor-tasks/$SLUG -k 4"
    exit 0
fi

# --- Check mode ---------------------------------------------------------------

# Apply workspace.patch to the throwaway index — the index then holds exactly
# the tree build-workspace.sh would produce. A patch that no longer applies is
# its own (serious) problem: the shipped inputs can't even rebuild.
if [ -s "$PATCH_FILE" ]; then
    if ! git --git-dir="$GITDIR" "${GIT_FLAGS[@]}" apply --cached "$PATCH_FILE" 2>/dev/null; then
        echo "" >&2
        echo "==============================================================================" >&2
        echo "!!  WARNING: environment/workspace.patch does not apply to commit $COMMIT." >&2
        echo "!!  A rebuild of this task from its shipped inputs (build-workspace.sh)" >&2
        echo "!!  would FAIL, and your live workspace can't be checked against them." >&2
        echo "!!  Did the gitref or the patch change after the workspace was built?" >&2
        echo "==============================================================================" >&2
        echo "" >&2
        exit 0
    fi
fi

# Tracked files that differ between the index (commit + patch) and the live
# workspace, plus files that exist only in the live workspace. Both respect
# the repo's .gitignore.
DIFF_RAW="$(git --git-dir="$GITDIR" "${GIT_FLAGS[@]}" diff --name-status -- "${EXCLUDES[@]}")"
UNTRACKED="$(git --git-dir="$GITDIR" "${GIT_FLAGS[@]}" ls-files --others --exclude-standard -- "${EXCLUDES[@]}")"

# Deletions of symlinks are skipped: the internal workspace build prunes
# dangling symlinks after applying the patch, so their absence is expected,
# not a worker edit.
CHANGES=""
while IFS=$'\t' read -r st path; do
    [ -n "$st" ] || continue
    if [ "$st" = "D" ]; then
        entry_mode="$(git --git-dir="$GITDIR" ls-files -s -- "$path" | awk '{print $1}')"
        [ "$entry_mode" = "120000" ] && continue
    fi
    CHANGES="${CHANGES}  ${st}   ${path}
"
done <<< "$DIFF_RAW"
while IFS= read -r path; do
    [ -n "$path" ] || continue
    CHANGES="${CHANGES}  ??  ${path}
"
done <<< "$UNTRACKED"

[ -n "$CHANGES" ] || exit 0

TOTAL="$(printf '%s' "$CHANGES" | wc -l | tr -d ' ')"
LISTED="$(printf '%s' "$CHANGES" | head -25)"

{
    echo ""
    echo "=============================================================================="
    echo "!!  WARNING: environment/workspace has changes that will NOT survive"
    echo "!!  packaging."
    echo "=============================================================================="
    echo ""
    echo "The workspace/ directory itself is never kept: everywhere downstream the"
    echo "task is rebuilt from the commit pinned in task.toml ($COMMIT) plus"
    echo "environment/workspace.patch — exactly what scripts/build-workspace.sh"
    echo "produces. These $TOTAL file(s) differ from that rebuild, so your local trials"
    echo "see them, but they will not survive packaging:"
    echo ""
    echo "$LISTED"
    if [ "$TOTAL" -gt 25 ]; then
        echo "  ... and $((TOTAL - 25)) more"
    fi
    echo ""
    echo "  (M = modified, D = deleted, ?? = only in the live workspace. Files matched"
    echo "   by the repo's .gitignore are not checked — they never ship either way.)"
    echo ""
    if [ -f "$TASK_DIR/environment/session.jsonl" ]; then
        echo "This task was built from a session snapshot, and workspace.patch mirrors"
        echo "the workspace state captured with that session. If these changes belong in"
        echo "the task, the cleanest fix is to make them in the Explore session and"
        echo "re-capture (/create-snapshot:snapshot, then scripts/snapshot-to-task.ts),"
        echo "so the session transcript and the workspace stay consistent."
        echo ""
        echo "To fold them into workspace.patch anyway — only if they don't contradict"
        echo "what the captured session says about the workspace:"
        echo ""
        echo "  $SELF_DISPLAY --update-patch harbor-tasks/$SLUG"
    else
        echo "To fold these changes into workspace.patch so they ship with the task:"
        echo ""
        echo "  $SELF_DISPLAY --update-patch harbor-tasks/$SLUG"
        if [ -f "$ROOT/scripts/build-workspace.sh" ]; then
            echo ""
            echo "To discard them instead (rebuild the workspace from commit + patch):"
            echo ""
            echo "  bash scripts/build-workspace.sh $SLUG"
        fi
    fi
    echo ""
    echo "Either way, re-run your trials afterwards so your reference runs match the"
    echo "workspace every downstream rebuild produces."
    echo "=============================================================================="
    echo ""
} >&2

exit 0
