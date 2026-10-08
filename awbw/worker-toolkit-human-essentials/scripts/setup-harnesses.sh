#!/bin/bash
# Install the harnesses a worker can author with, from scripts/harness-registry.toml.
#
# Source it, then call unpiped — it exports credentials, which a subshell would lose:
#
#     . /workspace/scripts/setup-harnesses.sh
#     harness_setup_all
#
# Registry reading and credential derivation live in lib/harness-credentials.sh, sourced
# below, because `harbor-run` needs those and nothing else here.
#
# No -e here — but this file is SOURCED, and shell options belong to the caller's shell:
# both post-creates run with -e, so that is what is in force. An unguarded failure below
# therefore aborts container creation, which is why every failure site is individually
# guarded (`|| true`, `if !`) rather than relying on this line.
set -uo pipefail

_HARNESS_REGISTRY_DIR="${HARNESS_SCRIPTS_DIR:-/workspace/scripts}"
if [ ! -f "$_HARNESS_REGISTRY_DIR/lib/harness-credentials.sh" ]; then
    echo "harness-setup: FATAL — $_HARNESS_REGISTRY_DIR/lib/harness-credentials.sh is" >&2
    echo "harness-setup: missing, so nothing here can read the registry. Every step below" >&2
    echo "harness-setup: would report a missing interpreter instead of this." >&2
    return 1 2>/dev/null || exit 1
fi
# shellcheck disable=SC1091
. "$_HARNESS_REGISTRY_DIR/lib/harness-credentials.sh"

# Every setup step reads the registry through _harness_query, and each call suppresses
# stderr so one bad row can't abort the container. That means a BROKEN interpreter turns
# the whole of setup into a silent no-op: no credentials, no CLIs, no config, no
# launchers, and no error anywhere. Check it once, loudly, before any of that.
harness_preflight() {
    local err py found=yes
    py=$(_raccoon_python) || { py=python3; found=no; }
    if ! err=$("$py" "$_HARNESS_REGISTRY_DIR/resolve_harness.py" --list 2>&1 >/dev/null); then
        echo "harness-setup: FATAL — cannot read the harness registry, so no agent CLI" >&2
        echo "harness-setup: would be installed. Nothing below will run." >&2
        echo "harness-setup:   interpreter: $(command -v "$py" || echo MISSING) ($("$py" -V 2>&1))" >&2
        if [ "$found" = no ]; then
            echo "harness-setup:   no python3.11+ with tomllib found; set RACCOON_PYTHON to override" >&2
        fi
        echo "harness-setup:   registry: $_HARNESS_REGISTRY_DIR/harness-registry.toml" >&2
        printf 'harness-setup:   %s\n' "$err" >&2
        return 1
    fi
}

# claude installs into $HOME/.local/bin, which is not on PATH during post-create.
case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) export PATH="$HOME/.local/bin:$PATH" ;;
esac

# --- installs ----------------------------------------------------------------
harness_install_clis() {
    local id cli install
    while IFS=$'\t' read -r id cli install; do
        [ -n "$install" ] || continue
        if command -v "$cli" >/dev/null 2>&1; then
            echo "harness-setup: $cli already installed — skipping" >&2
            continue
        fi
        echo "harness-setup: installing $id ($cli)" >&2
        # Reported as unavailable below rather than fatal.
        if ! bash -c "$install" >&2; then
            echo "harness-setup: WARNING $id failed to install — $cli will be unavailable" >&2
        fi
    done < <(_harness_query --authoring-installs 2>/dev/null || true)
}

# Report which CLIs are usable. Non-zero when NONE are: one harness missing is survivable
# (a worker uses the other), but zero means the container cannot author anything at all,
# and that must stop setup rather than read as a couple of warnings.
harness_report() {
    local id cli install ready=0 missing=0
    while IFS=$'\t' read -r id cli install; do
        [ -n "$cli" ] || continue
        if command -v "$cli" >/dev/null 2>&1; then
            echo "  $cli — ready" >&2
            ready=$((ready + 1))
        else
            echo "  $cli — NOT AVAILABLE (install failed; see above)" >&2
            missing=$((missing + 1))
        fi
    done < <(_harness_query --authoring-installs 2>/dev/null || true)

    # A CLI on PATH with no key is worse than a missing one: it starts, then fails at the
    # first request with the harness's own auth error, which says nothing about setup.
    local id key_env base_url_env proxy_path
    while IFS=$'\t' read -r id key_env base_url_env proxy_path; do
        [ -n "$key_env" ] || continue
        if [ -z "${!key_env:-}" ]; then
            echo "  $id — installed but NO CREDENTIALS: $key_env is unset." >&2
            echo "      Derived from ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY; set both in .env." >&2
        fi
    done < <(_harness_query --authoring-credentials 2>/dev/null || true)

    if [ "$ready" -eq 0 ]; then
        echo "harness-setup: FATAL — no agent CLI installed ($missing attempted)." >&2
        echo "harness-setup: This container cannot author a task. Check the install" >&2
        echo "harness-setup: output above: the CLIs download over the network, so a" >&2
        echo "harness-setup: proxy, DNS or upstream change breaks every one at once." >&2
        return 1
    fi
    [ "$missing" -gt 0 ] && echo "harness-setup: $missing harness(es) unavailable; $ready usable" >&2
    return 0
}

# --- Explore launchers -------------------------------------------------------
# One `raccoon-explore-<cli>` per harness, aliased to its `cli`.
harness_install_launchers() {
    local bin="$HOME/.local/bin"
    mkdir -p "$bin"
    # Read at launcher run time so the note stays a file, not a baked-in copy.
    local note_src="${HARNESS_TOOLSET_NOTE:-/workspace/scripts/toolset_note.md}"
    local browser_note_src="${note_src%.md}_browser.md"
    local read_note_src="${note_src%.md}_read.md"
    local agent_cli_dir="${AGENT_CLI_DIR:-/opt/agent-cli}"

    # Which harnesses keep their key in a file rather than reading $ENV per request. Those
    # launchers refresh it first: the file dates from container create, so a key rotated in
    # .env since then would otherwise reach the harness only after a rebuild.
    local file_auth_ids="" aid apath akey
    while IFS=$'\t' read -r aid apath akey; do
        [ -n "$apath" ] || continue
        file_auth_ids="${file_auth_ids:+$file_auth_ids }$aid"
    done < <(_harness_query --auth-files 2>/dev/null || true)

    local id cli launch switchable refresh_line
    while IFS=$'\t' read -r id cli launch; do
        [ -n "$cli" ] && [ -n "$launch" ] || continue
        # `|| true` twice over (here and inside the script): the launcher runs under
        # `set -e`, and a failed refresh must not cost the worker their agent.
        if [[ " $file_auth_ids " == *" $id "* ]]; then
            refresh_line="\"$_HARNESS_REGISTRY_DIR/refresh-harness-auth\" || true"
        else
            refresh_line=""
        fi
        # Whether RACCOON_BROWSER_TASK can change THIS harness's toolset, read off the
        # registry rather than hardcoded: a launch line that interpolates $RACCOON_TOOLS
        # can, and one that doesn't cannot. codex is the second case — it ships view_image,
        # so a browser task needs nothing added and the flag has nothing to switch.
        # Match the whole variable name: a substring test also hits RACCOON_TOOLSET_NOTE,
        # which every launch line references, and every harness would look switchable.
        if [[ "$launch" =~ \$\{?RACCOON_TOOLS\}?([^A-Za-z0-9_]|$) ]]; then
            switchable=1
        else
            switchable=0
        fi
        cat > "$bin/raccoon-explore-$cli" <<LAUNCHER
#!/bin/bash
# GENERATED by scripts/setup-harnesses.sh from harness-registry.toml — do not edit.
set -euo pipefail
# A harness that reads its key from \$ENV per request needs .env in its environment,
# and only an interactive shell sources .bashrc — which is also where PATH picks up
# ~/.local/bin, where the CLI itself lives. Both are set here so a launch works the
# same either way, with the key .env holds right now.
export PATH="\$HOME/.local/bin:\$PATH"
if [ -f "\${RACCOON_ENV_FILE:-/workspace/.env}" ]; then
    set -a
    . "\${RACCOON_ENV_FILE:-/workspace/.env}"
    set +a
fi
if [ -f "\$HOME/.raccoon-call-origin" ]; then
    . "\$HOME/.raccoon-call-origin"
fi
if [ -f "$note_src" ]; then
    RACCOON_TOOLSET_NOTE="\$(sed "s#/opt/agent-cli#$agent_cli_dir#g" "$note_src")"
else
    RACCOON_TOOLSET_NOTE=""
fi
# RACCOON_BROWSER_TASK=1 explores with the toolset a \`browser = true\` task runs under.
# Named for the flag it mirrors: one word, \`browser\`, whether it's set in task.toml or
# here. Per invocation, not per container — authoring a browser task shouldn't need a
# rebuild, and neither should changing your mind. Default off, so ordinary exploring
# still mirrors an ordinary trial.
#
# The correction must be appended AFTER the base note, which says there is no Read tool.
RACCOON_TOOLS="Bash"
if [ "\${RACCOON_BROWSER_TASK:-0}" = "1" ] && [ "$switchable" = "1" ] && [ -f "$read_note_src" ]; then
    RACCOON_TOOLS="Bash,Read"
    RACCOON_TOOLSET_NOTE="\${RACCOON_TOOLSET_NOTE}

\$(cat "$read_note_src")"
fi
export RACCOON_TOOLS
# Only mention the browser on an image that actually has one — most don't. Probed at
# launch, not baked in, so the same launcher is correct in whichever container it runs.
#
# Exported two ways because the harnesses take extra instructions differently: claude
# appends the whole toolset note to --append-system-prompt, while codex has no equivalent
# and takes -c developer_instructions=. codex must NOT get the claude-shaped toolset note
# (it has no str_replace_editor), so the browser part is exported on its own too.
RACCOON_BROWSER_NOTE=""
RACCOON_BROWSER_FLAGS=()
if command -v pw >/dev/null 2>&1 && [ -f "$browser_note_src" ]; then
    RACCOON_BROWSER_NOTE="\$(cat "$browser_note_src")"
    RACCOON_TOOLSET_NOTE="\${RACCOON_TOOLSET_NOTE}

\${RACCOON_BROWSER_NOTE}"
    RACCOON_BROWSER_FLAGS=(-c "developer_instructions=\${RACCOON_BROWSER_NOTE}")
fi
export RACCOON_TOOLSET_NOTE RACCOON_BROWSER_NOTE
export RACCOON_HARNESS="$id"
# These launchers exist only in explore, and a refresh that has to CREATE a config
# needs the surface to know the capture hooks belong in it.
export RACCOON_SURFACE=explore
# No RACCOON_SNAPSHOT_DATA here on purpose. capture-snapshot.mjs and save-session-info.mjs
# already share the same default ($HOME/.raccoon/snapshot-data), which is what codex needs
# — it has no CLAUDE_PLUGIN_* to fall back to. Exporting it ALSO overrode the dir for
# claude, whose slash command pins --plugin-data to the plugin dir, so the hook wrote one
# place and capture read another and the recorded session was silently ignored.
$refresh_line
$launch
LAUNCHER
        chmod +x "$bin/raccoon-explore-$cli"
        echo "harness-setup: launcher raccoon-explore-$cli" >&2
    done < <(_harness_query --explore-launchers 2>/dev/null || true)
}

# Alias lines for ~/.bashrc.
harness_alias_lines() {
    local id cli launch switchable
    local browser_clis=""
    while IFS=$'\t' read -r id cli launch; do
        [ -n "$cli" ] && [ -n "$launch" ] || continue
        echo "alias $cli=\"raccoon-explore-$cli\""
        # Same derivation as the launcher: only a harness whose launch line takes
        # $RACCOON_TOOLS has a toolset the flag can change.
        if [[ "$launch" =~ \$\{?RACCOON_TOOLS\}?([^A-Za-z0-9_]|$) ]]; then
            browser_clis="${browser_clis:+$browser_clis }$cli"
        fi
    done < <(_harness_query --explore-launchers 2>/dev/null || true)

    # The browser hint belongs at the shell prompt, not in the launcher. Claude Code takes the
    # alternate screen buffer, so anything printed just before exec is hidden for the whole
    # session and resurfaces only after quitting — advice arriving exactly too late. Here it
    # lands in ordinary scrollback, before any TUI exists, and there is nothing to quit yet.
    #
    # `pw` is probed at shell start, so one ~/.bashrc is correct in a container with a browser
    # and in one without.
    [ -n "$browser_clis" ] || return 0
    local first="${browser_clis%% *}"
    cat <<HINT
if [[ \$- == *i* ]] && [ "\${RACCOON_BROWSER_TASK:-0}" != "1" ] && command -v pw >/dev/null 2>&1; then
    echo "browser available (Playwright + Chromium, \\\`pw <script.js>\\\`)."
    echo "Authoring a \\\`browser = true\\\` task? Start it with:  RACCOON_BROWSER_TASK=1 $first"
fi
HINT
}

# Write each harness's config file from the registry, replacing whatever was there.
#
# The file is OWNED, not merged: TOML has no way to return to the document root after a
# table header, so appending or prepending around foreign content silently reparents
# root-level keys into whichever table happens to precede them. Owning it also means a
# registry change actually reaches a container that was already set up.
harness_write_configs() {
    local id config_path blob target tmp
    while IFS=$'\t' read -r id config_path blob; do
        [ -n "$config_path" ] && [ -n "$blob" ] || continue
        # Guarded: a bare failing assignment exits the caller's `set -e` post-create with
        # no explanation. A path this cannot expand is one harness's problem, not the
        # container's.
        target=$(eval "printf '%s' \"$config_path\"") || {
            echo "harness-setup: WARNING $id config_path could not be expanded — skipping" >&2
            continue
        }
        mkdir -p "$(dirname "$target")"
        tmp="$target.raccoon-tmp"
        # Expansion is strict: an unset var would otherwise be written through as the
        # literal ${VAR}, which surfaces much later as an unparseable value.
        if ! {
            echo "# Generated from harness-registry.toml — edits here are overwritten."
            printf '%s' "$blob" | base64 -d | python3 -c '
import os, re, sys
text = sys.stdin.read()
missing = sorted(
    {m.group(1) for m in re.finditer(r"\$\{(\w+)\}", text) if m.group(1) not in os.environ}
)
if missing:
    sys.stderr.write("unset: " + ", ".join(missing) + "\n")
    raise SystemExit(1)
sys.stdout.write(os.path.expandvars(text))
'
        } > "$tmp"; then
            rm -f "$tmp"
            echo "harness-setup: WARNING $id config NOT written — a value it needs is unset." >&2
            echo "harness-setup:   run harness_setup_credentials first (harness_setup_all does)." >&2
            continue
        fi
        mv "$tmp" "$target"
        echo "harness-setup: $id config -> $target" >&2
    done < <(_harness_query --container-configs --surface "${RACCOON_SURFACE:-authoring}" 2>/dev/null || true)
}

# Link every available skill into each harness's skills_dir, for harnesses that declare one.
# Both container layouts are covered: the explore container holds the snapshot skill under
# plugins/, the authoring container holds the authoring skills under .claude/skills. Whichever
# directories exist here are the ones this container has.
harness_install_skills() {
    local sources="${RACCOON_SKILL_SOURCE_DIRS:-/workspace/plugins/create-snapshot/skills /workspace/.claude/skills}"
    local id dir target src skill name installed
    while IFS=$'\t' read -r id dir; do
        [ -n "$dir" ] || continue
        target=$(eval "printf '%s' \"$dir\"") || {
            echo "harness-setup: WARNING $id skills_dir could not be expanded — skipping" >&2
            continue
        }
        mkdir -p "$target"
        installed=0
        for src in $sources; do
            [ -d "$src" ] || continue
            for skill in "$src"/*/; do
                [ -f "$skill/SKILL.md" ] || continue
                name=$(basename "$skill")
                ln -sfn "${skill%/}" "$target/$name"
                installed=$((installed + 1))
            done
        done
        echo "harness-setup: $id skills -> $target ($installed linked)" >&2
    done < <(_harness_query --skills-dirs 2>/dev/null || true)
}

# The lines that explain a setup failure are printed as it happens, and the devcontainer
# CLI's own stack trace lands on top of them. Close with a banner so the worker has
# something to look for, and something to send us.
_harness_fatal_banner() {
    echo "" >&2
    echo "  ============================================================" >&2
    echo "   HARNESS SETUP FAILED — this container has no agent CLI." >&2
    echo "" >&2
    echo "   The harness-setup: lines above say why. Anything the" >&2
    echo "   devcontainer prints after this is a consequence, not the" >&2
    echo "   cause; send us the harness-setup: lines." >&2
    echo "  ============================================================" >&2
    echo "" >&2
}

harness_setup_all() {
    harness_preflight || { _harness_fatal_banner; return 1; }
    harness_setup_credentials
    harness_write_auth
    harness_install_clis
    harness_write_configs
    harness_install_skills
    # Launchers are NOT installed here. They are an Explore concern (that container aliases
    # `claude`/`codex` to them), and it passes its own AGENT_CLI_DIR — installing them here
    # too wrote every launcher twice, the first time with the wrong editor path, and left an
    # unused one in the authoring container.
    echo "harness-setup: authoring harnesses" >&2
    harness_report || { _harness_fatal_banner; return 1; }
}
