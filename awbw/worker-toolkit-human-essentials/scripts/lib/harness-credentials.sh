#!/bin/bash
# Read the harness registry and derive per-harness credentials from it.
#
# Source it — the whole point is exporting into the caller's environment, which a subshell
# would lose:
#
#     HARNESS_SCRIPTS_DIR=/workspace/scripts . /workspace/scripts/lib/harness-credentials.sh
#     harness_setup_credentials
#
# Three callers: `harbor-run`, which needs only this; `refresh-harness-auth`, which
# re-derives and rewrites the auth files before an interactive launch; and
# `setup-harnesses.sh`, which sources it and adds installs, config writing and launchers
# on top.
#
# No -e here — this file is SOURCED, and shell options belong to the caller's shell (both
# post-creates run with -e). An unguarded failure below therefore aborts container
# creation, which is why every failure site is individually guarded rather than relying on
# this line.
set -uo pipefail

_HARNESS_REGISTRY_DIR="${HARNESS_SCRIPTS_DIR:-/workspace/scripts}"

# The registry is read with tomllib (stdlib from 3.11), and `python3` is not always new
# enough — macOS ships 3.9, and a container may symlink an older managed interpreter. Pick
# the first one that can actually import it rather than assuming.
_raccoon_python() {
    local p
    for p in "${RACCOON_PYTHON:-}" python3 python3.13 python3.12 python3.11; do
        [ -n "$p" ] || continue
        command -v "$p" >/dev/null 2>&1 || continue
        if "$p" -c "import tomllib" >/dev/null 2>&1; then
            printf '%s' "$p"
            return 0
        fi
    done
    return 1
}

_harness_query() {
    local py
    py=$(_raccoon_python) || return 1
    "$py" "$_HARNESS_REGISTRY_DIR/resolve_harness.py" "$@"
}

# Drop every whitespace character from a value read out of .env. A Windows-saved .env leaves a
# \r on each value, which reaches the proxy as a 401; no key or base URL legitimately contains
# whitespace anywhere, so deleting rather than trimming needs no cases.
_harness_trim() {
    local out
    # Fall back to the raw value: a trim that cannot run must never turn a working key into an
    # empty one, which is what an unavailable `tr` would otherwise do to every caller.
    out="$(printf '%s' "$1" | tr -d '[:space:]' 2>/dev/null)" || out="$1"
    printf '%s' "${out:-$1}"
}

# The proxy root: the worker's ANTHROPIC_BASE_URL minus its provider path.
_harness_proxy_root() {
    local base_url
    base_url="$(_harness_trim "${ANTHROPIC_BASE_URL:-}")"
    [ -n "$base_url" ] || return 1
    base_url="${base_url%"${base_url##*[!/]}"}"
    # ".../llm_proxy/projects/<id>/anthropic" -> ".../llm_proxy/projects/<id>", so each
    # harness's proxy_path composes onto the project route. Requires a path to strip: a base
    # URL that is a bare host with no path — a provider's own API root rather than the
    # proxy — would yield "https:/", handed to codex as a base URL and failing obscurely.
    case "${base_url#*://}" in
        */*) printf '%s' "${base_url%/*}" ;;
        *) return 2 ;;
    esac
}

harness_setup_credentials() {
    # `|| rc=$?` and not a bare assignment: this is sourced into a `set -e` shell (see the
    # note at the top), and a bare failing assignment would exit the caller's post-create
    # outright — silently, since the failure paths below are what do the explaining.
    local root rc=0
    root="$(_harness_proxy_root)" || rc=$?
    if [ "$rc" -ne 0 ]; then
        if [ "$rc" -eq 2 ]; then
            echo "harness-setup: ANTHROPIC_BASE_URL (${ANTHROPIC_BASE_URL:-}) has no provider" >&2
            echo "harness-setup:   path, so it is not the proxy URL other harnesses derive their" >&2
            echo "harness-setup:   credentials from. claude will work; codex will not be" >&2
            echo "harness-setup:   authenticated. Use the base URL you were given." >&2
        else
            echo "harness-setup: ANTHROPIC_BASE_URL unset — skipping credential derivation" >&2
        fi
        return 0
    fi
    ANTHROPIC_BASE_URL="$(_harness_trim "${ANTHROPIC_BASE_URL:-}")"
    export ANTHROPIC_BASE_URL
    local key
    key="$(_harness_trim "${ANTHROPIC_API_KEY:-}")"
    if [ -z "$key" ]; then
        echo "harness-setup: ANTHROPIC_API_KEY unset — skipping credential derivation" >&2
        return 0
    fi
    # harbor-run sources .env itself and passes ANTHROPIC_* through to the trial sandbox, so
    # cleaning only the derived per-harness copies would leave a claude trial carrying the CR.
    export ANTHROPIC_API_KEY="$key"

    local id key_env base_url_env proxy_path
    while IFS=$'\t' read -r id key_env base_url_env proxy_path; do
        [ -n "$key_env" ] || continue
        # ${!name} is an indirect expansion. Only set when empty: an explicit key wins.
        if [ -z "${!key_env:-}" ]; then
            export "$key_env=$key"
        fi
        if [ -n "$base_url_env" ] && [ -n "$proxy_path" ] && [ -z "${!base_url_env:-}" ]; then
            export "$base_url_env=$root/$proxy_path"
        fi
        echo "harness-setup: $id credentials ready ($key_env, ${base_url_env:-no base url})" >&2
    done < <(_harness_query --authoring-credentials 2>/dev/null || true)
}

# Write the auth file for harnesses that read credentials from disk rather than $ENV.
harness_write_auth() {
    local id auth_path key_env target key py
    py=$(_raccoon_python) || {
        echo "harness-setup: no python3.11+ with tomllib — skipping auth files" >&2
        return 0
    }
    while IFS=$'\t' read -r id auth_path key_env; do
        [ -n "$auth_path" ] && [ -n "$key_env" ] || continue
        # Last mile: an explicit OPENAI_API_KEY bypasses the derivation above, so trim here
        # too — this is the value that reaches the file the harness authenticates with.
        key="$(_harness_trim "${!key_env:-}")"
        if [ -z "$key" ]; then
            echo "harness-setup: $key_env unset — skipping $id auth file" >&2
            continue
        fi
        target=$(eval "printf '%s' \"$auth_path\"") || {
            echo "harness-setup: WARNING $id auth_path could not be expanded — skipping" >&2
            continue
        }
        mkdir -p "$(dirname "$target")" || {
            echo "harness-setup: WARNING $id auth dir not creatable — skipping $target" >&2
            continue
        }
        # json.dumps, not printf: a key containing a quote or backslash would otherwise
        # produce a file the CLI cannot parse, and the failure would surface as an auth
        # error rather than a malformed file.
        # 0600 tmp + rename, never a redirect onto the target: a redirect truncates the live
        # file first, so a write dying mid-flight leaves codex an EMPTY auth.json.
        if ! RACCOON_AUTH_K="$key_env" RACCOON_AUTH_V="$key" RACCOON_AUTH_TARGET="$target" \
            "$py" -c 'import json, os
target = os.environ["RACCOON_AUTH_TARGET"]
tmp = target + ".raccoon-tmp." + str(os.getpid())
try:
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
        json.dump({os.environ["RACCOON_AUTH_K"]: os.environ["RACCOON_AUTH_V"]}, fh)
        fh.write("\n")
    os.replace(tmp, target)
except OSError:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise SystemExit(1)
'; then
            echo "harness-setup: WARNING $id auth file NOT written — $target unwritable." >&2
            echo "harness-setup:   the key already on disk (if any) is left untouched." >&2
            continue
        fi
        echo "harness-setup: $id auth -> $target" >&2
    done < <(_harness_query --auth-files 2>/dev/null || true)
}

# Re-set just the root keys of a harness's config file (codex's `openai_base_url`),
# leaving every other line — the explore surface's [hooks] table included — untouched.
harness_refresh_config_keys() {
    local id config_path blob target py
    py=$(_raccoon_python) || return 0
    # The surface only decides what a CREATE writes. An update takes the root keys off the
    # front of the same blob, so a surface's tables survive byte-for-byte either way.
    while IFS=$'\t' read -r id config_path blob; do
        [ -n "$config_path" ] && [ -n "$blob" ] || continue
        target=$(eval "printf '%s' \"$config_path\"") || continue
        mkdir -p "$(dirname "$target")" || continue
        if printf '%s' "$blob" | base64 -d |
            RACCOON_CONFIG_TARGET="$target" "$py" -c '
import os, re, sys, tomllib

HEADER = "# Generated from harness-registry.toml — edits here are overwritten."

target = os.environ["RACCOON_CONFIG_TARGET"]
text = sys.stdin.read()
# Empty counts as unresolved: writing an empty base URL would break a container whose
# config is currently right, which is the one thing this must never do.
if [m for m in re.finditer(r"\$\{(\w+)\}", text) if not os.environ.get(m.group(1))]:
    raise SystemExit(1)
text = os.path.expandvars(text)

# Root keys, plus keys inside a [model_providers.*] table: codex reserves its built-in
# provider ids, so the proxy URL it must follow lives in a provider table, not at the
# root. Every other table, [hooks] on the explore surface included, is left alone.
REFRESHABLE_TABLE = re.compile(r"\[model_providers\.[^]]+\]$")
wanted = []
section = None
for line in text.splitlines():
    stripped = line.strip()
    if stripped.startswith("["):
        section = stripped if REFRESHABLE_TABLE.match(stripped) else False
        continue
    if section is False:
        continue
    m = re.match(r"\s*\"?([A-Za-z0-9_.-]+)\"?\s*=", line)
    if m:
        wanted.append((section, m.group(1), line.rstrip()))
if not wanted:
    raise SystemExit(0)


def section_path(header):
    """[model_providers.llm-proxy] -> ("model_providers", "llm-proxy")."""
    return tuple(header.strip("[]").split("."))


def lookup(doc, header, key):
    """The value a parsed config holds for a wanted key, or KeyError."""
    node = doc
    if header:
        for part in section_path(header):
            node = node[part]
    return node[key]

mode = None
if os.path.exists(target):
    try:
        with open(target, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        mode = os.stat(target).st_mode & 0o777
    except OSError:
        raise SystemExit(1)
    def span(header):
        """The line range a section owns, or None when the file has no such section.

        Root is everything above the first table header: a key appended below one
        would be reparented into it, so searches and inserts stay inside the span.
        """
        heads = [i for i, l in enumerate(lines) if l.lstrip().startswith("[")]
        if header is None:
            return 0, (heads[0] if heads else len(lines))
        at = next((i for i in heads if lines[i].strip() == header), None)
        if at is None:
            return None
        after = next((i for i in heads if i > at), len(lines))
        return at + 1, after

    # Grouped, root first, so a section this file lacks can be written whole.
    grouped = {}
    for header, key, line in wanted:
        grouped.setdefault(header, []).append((key, line))
    ordered = sorted(grouped, key=lambda h: (h is not None, h or ""))

    changed = False
    for header in ordered:
        if span(header) is None:
            # A config written before this section existed. Write the whole table
            # rather than leave a root key naming a provider that is not there.
            if lines and lines[-1].strip():
                lines.append("")
            lines.append(header)
            lines.extend(line for _, line in grouped[header])
            changed = True
            continue
        for key, line in grouped[header]:
            # Re-read the span: an insert for an earlier key moved it.
            start, end = span(header)
            # The quoted spelling is the same key: replace rather than duplicate.
            pat = re.compile(r"\s*\"?" + re.escape(key) + r"\"?\s*=")
            at = next((i for i in range(start, end) if pat.match(lines[i])), None)
            if at is None:
                if end < len(lines) and lines[end].strip():
                    lines.insert(end, "")
                lines.insert(end, line)
                changed = True
            elif lines[at] != line:
                lines[at] = line
                changed = True
    if not changed:
        raise SystemExit(0)
    out = "\n".join(lines).rstrip("\n") + "\n"
else:
    # No file means container-create could not write one, so write what it would have:
    # on the explore surface that is the capture hooks too, not just the root keys.
    out = HEADER + "\n" + text

try:
    doc = tomllib.loads(out)
except tomllib.TOMLDecodeError:
    raise SystemExit(1)
# Parsing is not enough: a line edit can land inside a multi-line value, which still
# parses while leaving the key unset. Require every key to have landed on the value the
# blob asks for, in its own section — skipping sections this file does not carry.
blob_doc = tomllib.loads(text)
for header, key, _ in wanted:
    try:
        expected = lookup(blob_doc, header, key)
    except (KeyError, TypeError):
        raise SystemExit(1)
    try:
        got = lookup(doc, header, key)
    except (KeyError, TypeError):
        if header is None:
            raise SystemExit(1)
        continue
    if got != expected:
        raise SystemExit(1)

# Pid-suffixed: two launches at once must not write the same scratch path.
tmp = target + ".raccoon-tmp." + str(os.getpid())
try:
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(out)
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, target)
except OSError:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise SystemExit(1)
'; then
            echo "harness-setup: $id config keys refreshed -> $target" >&2
        fi
    done < <(_harness_query --container-configs --surface "${RACCOON_SURFACE:-authoring}" 2>/dev/null || true)
}
