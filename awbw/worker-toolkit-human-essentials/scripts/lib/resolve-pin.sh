# shellcheck shell=bash
#
# resolve_pin — turn a task's pinned commit into a SHA that exists in the repo,
# translating through a commit map when history has been rewritten under it.
#
# A task pins a commit in task.toml. If that repo's history is later rewritten
# (to strip something that should never have shipped, say), every rewritten
# commit gets a new SHA and the pin stops resolving — including on machines we
# cannot reach, holding tasks we cannot edit. A commit map lets those pins keep
# working: `<old-sha> <new-sha>` per line, at task-shared/commit-maps/<member>.map,
# <member> being the task's `repo` key — a standalone toolkit checks its repo out
# at repo/, so the directory name is not the member name and cannot be the key.
#
# The map is only consulted when the pin does not resolve, so it carries only
# rewritten commits — an unchanged commit resolves on its own and its identity
# row could never be read.
#
# Usage (source, then call):
#   . "$(dirname "$0")/lib/resolve-pin.sh"
#   sha=$(resolve_pin "$REPO_DIR" "$COMMIT" "$TOOLKIT_ROOT/task-shared/commit-maps" "$MEMBER") || exit 1
#
# Writes the resolved SHA to stdout, notes on stderr. Returns non-zero if the
# pin cannot be resolved, having explained why.

RESOLVE_PIN_MAX_HOPS="${RESOLVE_PIN_MAX_HOPS:-25}"
_RESOLVE_PIN_ZERO='0000000000000000000000000000000000000000'

# Look one hop: echo the successor of $1 in map $2, or nothing. Fails if the
# prefix is ambiguous, which would otherwise pick an arbitrary commit.
_resolve_pin_hop() {
    local from="$1" map="$2" hits
    hits=$(awk -v p="$from" '
        /^#/ || NF < 2 { next }
        index($1, p) == 1 { print $2 }
    ' "$map" | sort -u)
    [ -z "$hits" ] && return 1
    if [ "$(printf '%s\n' "$hits" | wc -l | tr -d ' ')" -gt 1 ]; then
        echo "  pin $from is ambiguous in $(basename "$map") — use a longer SHA" >&2
        return 2
    fi
    printf '%s\n' "$hits"
}

resolve_pin() {
    local repo_dir="$1" commit="$2" map_dir="${3:-}" key="${4:-}" sha map cur hops next rc

    # Present in the repo: nothing to translate.
    if sha=$(git -C "$repo_dir" rev-parse --quiet --verify "$commit^{commit}" 2>/dev/null); then
        printf '%s\n' "$sha"
        return 0
    fi

    map=""
    if [ -n "$map_dir" ]; then
        if [ -n "$key" ] && [ -f "$map_dir/$key.map" ]; then
            map="$map_dir/$key.map"
        elif [ -f "$map_dir/$(basename "$repo_dir").map" ]; then
            map="$map_dir/$(basename "$repo_dir").map"
        fi
    fi
    if [ -z "$map" ]; then
        echo "Error: pinned commit $commit is not in $repo_dir, and no commit map is available." >&2
        echo "       The repo may be a shallow or partial copy — try a full clone." >&2
        return 1
    fi

    # Follow the chain: a commit rewritten more than once maps forward a hop per
    # rewrite, so keep going until the SHA exists or the trail ends.
    cur="$commit"
    hops=0
    while [ "$hops" -lt "$RESOLVE_PIN_MAX_HOPS" ]; do
        next=$(_resolve_pin_hop "$cur" "$map"); rc=$?
        [ "$rc" -eq 2 ] && return 1
        if [ "$rc" -ne 0 ]; then
            echo "Error: pinned commit $commit is not in $repo_dir and is not in $(basename "$map")." >&2
            echo "       It predates the map, or came from a repo copy this toolkit was not built from." >&2
            return 1
        fi
        if [ "$next" = "$_RESOLVE_PIN_ZERO" ]; then
            echo "Error: pinned commit $commit was deleted by a history rewrite, not rewritten." >&2
            echo "       Re-pin this task to a commit that still exists." >&2
            return 1
        fi
        if sha=$(git -C "$repo_dir" rev-parse --quiet --verify "$next^{commit}" 2>/dev/null); then
            echo "  Pin $commit was rewritten; using $sha" >&2
            printf '%s\n' "$sha"
            return 0
        fi
        cur="$next"
        hops=$((hops + 1))
    done

    echo "Error: pinned commit $commit did not settle after $RESOLVE_PIN_MAX_HOPS hops." >&2
    echo "       $(basename "$map") may contain a cycle." >&2
    return 1
}
