#!/bin/bash
# Verifier: grades the agent's work with Claude Code.
# GRADER_MODE: "agentic" (default) explores the workspace with tools; "one-shot"
# grades from the transcript alone (no tools); "rubric-trinary" / "rubric-scalar"
# grade agentically against the task's atomic rubric criteria (staged as
# tests/grader-context.md + tests/rubric-criteria.{md,json}) with per-criterion
# pass/partial/fail verdicts or 0.00-1.00 scores, rendered by
# tests/render-rubric-grade.py.
#
# The agentic and one-shot modes grade under the Grading Standard: the eight
# criteria defined in tests/grader-system-prompt-consolidated.md, informed by
# the task's holistic rubric (tests/holistic-rubric.md; earlier tasks carry the
# same document as tests/grader-guidance-consolidated.md or legacy
# tests/grader-guidance.md), with each sample's grade.json rendered by
# tests/render-grade-consolidated.py. Rubric modes grade against their staged
# assets instead.

TESTS_DIR="$(dirname "$0")"
GRADER_MODE="${GRADER_MODE:-agentic}"

RUBRIC_FORM=""
case "$GRADER_MODE" in
    agentic|one-shot) ;;
    rubric-trinary) RUBRIC_FORM="trinary" ;;
    rubric-scalar)  RUBRIC_FORM="scalar" ;;
    *) echo "ERROR: unknown GRADER_MODE '$GRADER_MODE' (expected agentic, one-shot, rubric-trinary, or rubric-scalar)" >&2; exit 1 ;;
esac

GRADER_PROMPT_FILE="$TESTS_DIR/grader-system-prompt-consolidated.md"
# The task's holistic rubric, under whichever filename this task carries.
# Renames are forward-only: new tasks ship tests/holistic-rubric.md, and every
# earlier task keeps the name it was created with, so all three generations
# resolve here indefinitely. The variable keeps its GRADER_GUIDANCE_FILE name
# because provenance tooling and test presets reference it.
GRADER_GUIDANCE_FILE="$TESTS_DIR/holistic-rubric.md"
if [ ! -f "$GRADER_GUIDANCE_FILE" ]; then
    if [ -f "$TESTS_DIR/grader-guidance-consolidated.md" ]; then
        GRADER_GUIDANCE_FILE="$TESTS_DIR/grader-guidance-consolidated.md"
    elif [ -f "$TESTS_DIR/grader-guidance.md" ]; then
        GRADER_GUIDANCE_FILE="$TESTS_DIR/grader-guidance.md"
    fi
elif [ -f "$TESTS_DIR/grader-guidance-consolidated.md" ]; then
    # Both names present: grading with the wrong one would be silent, so
    # refuse to guess unless the two are byte-identical.
    _hr_sha=$(sha256sum "$GRADER_GUIDANCE_FILE" 2>/dev/null | cut -d' ' -f1)
    _ggc_sha=$(sha256sum "$TESTS_DIR/grader-guidance-consolidated.md" 2>/dev/null | cut -d' ' -f1)
    if [ "$_hr_sha" != "$_ggc_sha" ]; then
        echo "ERROR: $TESTS_DIR carries both holistic-rubric.md and grader-guidance-consolidated.md with different content — keep exactly one (tests/holistic-rubric.md is the current name)" >&2
        exit 1
    fi
fi
RENDER_GRADE="$TESTS_DIR/render-grade-consolidated.py"

# Grader model + number of samples (graded GRADER_SAMPLES times and averaged to
# reduce noise). Override with GRADER_MODEL=... / GRADER_SAMPLES=...
GRADER_MODEL="${GRADER_MODEL:-claude-fable-5-1}"
GRADER_SAMPLES="${GRADER_SAMPLES:-1}"

# The grader model's Claude Code floor. A task image installs Claude Code when it is first built
# and Docker reuses that layer on every rebuild, so an image can carry a CLI the API refuses for
# the current model ("does not support this model"). That used to surface only as a missing
# reward file. Fail here with the reason instead. The check applies to the default grader
# model; set GRADER_CLI_MIN to enforce a floor for another model.
GRADER_CLI_MIN="${GRADER_CLI_MIN:-2.1.251}"
if [ "$GRADER_MODEL" = "claude-fable-5-1" ] || [ -n "${GRADER_CLI_MIN_ENFORCE:-}" ]; then
    _cli_ver="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
    if [ -n "$_cli_ver" ] && [ "$(printf '%s\n%s\n' "$GRADER_CLI_MIN" "$_cli_ver" | sort -V | head -1)" != "$GRADER_CLI_MIN" ]; then
        echo "ERROR: this task image carries Claude Code $_cli_ver, but the grader model $GRADER_MODEL needs $GRADER_CLI_MIN or newer." >&2
        echo "Rebuild the task image with a current Claude Code: run scripts/harbor-run <task> again (it removes the stale image), or remove it yourself with docker image rm." >&2
        exit 1
    fi
fi

# GRADER_FAST_MODE=true grades in claude's fast serving mode (harbor-run /
# harbor-regrade --fast). Empty otherwise, leaving the grader command line unchanged.
GRADER_FAST_FLAGS=()
case "${GRADER_FAST_MODE:-}" in
    ""|false|0) ;;
    true|1|yes) GRADER_FAST_FLAGS=(--settings '{"fastMode":true}') ;;
    *) echo "ERROR: unknown GRADER_FAST_MODE '$GRADER_FAST_MODE' (expected true, 1, yes, false, 0, or empty)" >&2; exit 1 ;;
esac

mkdir -p /logs/verifier

# GRADER-REGIME:BEGIN
# What actually governed this grade. Nothing can recover a grading regime after
# the fact, so it is captured here or not at all — and every step below tolerates
# failure, because a provenance record must never be able to fail a grade.
# Keep byte-identical to the copy in _smoke-test/_smoke-deletion-capture (asserted
# by scripts/lib/grader-regime.test.ts, exercised by CI's regrade-smoke).
_regime_sha() { [ -f "${1:-}" ] && sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
_regime_json() {
    if [ -z "${1:-}" ]; then printf 'null'; else
        printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
    fi
}
# What ran, not what was requested: one-shot grades exactly once whatever
# GRADER_SAMPLES says, and the standard is read off the resolved assets below.
_regime_samples="${GRADER_SAMPLES:-}"
[ "${GRADER_MODE:-}" = "one-shot" ] && _regime_samples=1
_regime_standard="unknown"
case "$(basename "${GRADER_PROMPT_FILE:-}")" in
    grader-system-prompt-consolidated.md) _regime_standard="consolidated" ;;
    grader-system-prompt.md) _regime_standard="legacy" ;;
esac
_regime_guidance="${GRADER_GUIDANCE_FILE:-}"
_regime_render="${RENDER_GRADE:-}"
if [ -n "${RUBRIC_FORM:-}" ]; then
    # Rubric modes grade against the staged rubric assets, not the guidance file.
    _regime_standard="rubric-${RUBRIC_FORM}"
    _regime_guidance="$TESTS_DIR/rubric-criteria.md"
    _regime_render="$TESTS_DIR/render-rubric-grade.py"
fi
# stderr is redirected FIRST so a missing target dir fails silently.
cat 2>/dev/null > /logs/verifier/grader-regime.json <<REGIME_EOF || true
{
  "schema_version": 1,
  "captured_at": $(_regime_json "$(date -u +%Y-%m-%dT%H:%M:%SZ)"),
  "grader_mode": $(_regime_json "${GRADER_MODE:-}"),
  "grader_model": $(_regime_json "${GRADER_MODEL:-}"),
  "grader_samples": $(_regime_json "$_regime_samples"),
  "grading_standard": $(_regime_json "$_regime_standard"),
  "grader_prompt_file": $(_regime_json "$(basename "${GRADER_PROMPT_FILE:-}")"),
  "grader_prompt_sha256": $(_regime_json "$(_regime_sha "${GRADER_PROMPT_FILE:-}")"),
  "grader_guidance_file": $(_regime_json "$(basename "$_regime_guidance")"),
  "grader_guidance_sha256": $(_regime_json "$(_regime_sha "$_regime_guidance")"),
  "render_grade_file": $(_regime_json "$(basename "$_regime_render")"),
  "render_grade_sha256": $(_regime_json "$(_regime_sha "$_regime_render")")
}
REGIME_EOF
# GRADER-REGIME:END

# Expose the transcript and the agent's tree at the paths the grader prompt names.
# These are the same paths the delivery runtime provides, so the shared grader
# prompt needs no per-runtime branching: /tmp/admin-task/task_transcript.txt is the
# harness-written session record, /tmp/agent-workspace is the agent's final tree.
# `rm -rf` first because `ln -sfn` pointed at an existing DIRECTORY silently
# creates the link INSIDE it — which would hand the grader an empty tree.
mkdir -p /tmp/outputs /tmp/admin-task
rm -rf /tmp/files /tmp/agent-workspace
ln -sfn /workspace /tmp/files
ln -sfn /workspace /tmp/agent-workspace
ln -sfn /logs/agent/trajectory.json /tmp/admin-task/task_transcript.txt
# Legacy path, kept until its remaining consumers (scripts/replay_agent.py,
# scripts/grader-bench, scripts/earhart-grade, a few task guidance files) move to
# /tmp/admin-task. Note the delivery runtime's /tmp/outputs is agent-writable, so
# the grader prompt names only /tmp/admin-task as the session record.
ln -sfn /logs/agent/trajectory.json /tmp/outputs/task_transcript.txt

# Mark the workspace safe so git works regardless of file ownership.
git config --global --add safe.directory '*' 2>/dev/null || true
git config --global --add safe.directory /workspace 2>/dev/null || true

# Capture any files the worker agent created or modified
mkdir -p /logs/verifier/agent-output
cd /tmp/files
# Drop macOS metadata files (._*, .DS_Store) so they aren't captured or linted.
find . \( -name '._*' -o -name '.DS_Store' \) -not -path './node_modules/*' -delete 2>/dev/null || true

# Base = the pre-agent commit, so we also capture work the agent committed (the
# queries below otherwise see only uncommitted changes). Falls back to the repo's
# root commit; empty (helper becomes a no-op) if it can't be resolved.
HARBOR_BASE=$(git rev-parse -q --verify _harbor_base 2>/dev/null || git rev-list --max-parents=0 HEAD 2>/dev/null | tail -1)

# git C-quotes non-ASCII paths ("models/\360\237\245\207/x.sql"), and a quoted name is
# not a path `cp` can open. `-c` outranks any repo-local override the agent set.
# diff.renames=false: with detection on, a `git mv` is ONE R record, so the old path
# never appears under --diff-filter=D and its deletion is silently lost.
git_paths() { git -c core.quotePath=false -c diff.renames=false "$@"; }
committed_paths() { [ -n "$HARBOR_BASE" ] && git_paths diff --name-only --diff-filter="$1" "$HARBOR_BASE" HEAD 2>/dev/null; }

# The grader prompt calls the task's starting state the `base` commit (the delivery
# overlay tags it at that name). Point the same name at it here so `git diff base`
# and `git show base:<path>` mean the same thing in both runtimes. A tag adds no
# files and changes no content, so it cannot affect the agent's graded diff.
# (`_harbor_base` above is never created by anything today — the fallback is what
# actually resolves; tagging gives both runtimes one name that always exists.)
[ -n "$HARBOR_BASE" ] && git tag -f base "$HARBOR_BASE" >/dev/null 2>&1 || true

# Capture files the agent created or modified (unstaged, staged, and committed).
# --diff-filter=d excludes deletions (handled below); sort -u dedups.
{ git_paths ls-files --others --exclude-standard
  git_paths diff --name-only --diff-filter=d
  git_paths diff --cached --name-only --diff-filter=d
  committed_paths d
} | sort -u | while IFS= read -r f; do
    mkdir -p "/logs/verifier/agent-output/$(dirname "$f")"
    cp "$f" "/logs/verifier/agent-output/$f" 2>/dev/null || true
done
echo "Captured $(find /logs/verifier/agent-output -type f | wc -l | tr -d ' ') agent output files"

# Record files the agent deleted (unstaged, staged, or committed), so they aren't
# silently restored before the checks run.
{ git_paths ls-files --deleted
  git_paths diff --cached --name-only --diff-filter=D
  committed_paths D
} | sort -u | while IFS= read -r f; do
    # Still on disk = not a deletion: the agent moved the old file aside (or removed
    # it) and wrote a new one there. Replay deletes AFTER the overlay, so listing it
    # would delete that new file.
    [ -e "$f" ] || [ -L "$f" ] || printf '%s\n' "$f"
done > /logs/verifier/agent-output/_HARBOR_DELETIONS.txt

# Did the agent change the workspace? If not (a no-code response — pushback,
# clarifying question, or prose), skip the checks below and grade from the response.
AGENT_OUTPUT_FILES=$(find /logs/verifier/agent-output -type f ! -name _HARBOR_DELETIONS.txt | wc -l | tr -d ' ')
if [ -s /logs/verifier/agent-output/_HARBOR_DELETIONS.txt ]; then
    AGENT_DELETIONS=$(grep -c . /logs/verifier/agent-output/_HARBOR_DELETIONS.txt)
else
    AGENT_DELETIONS=0
fi
if [ "$AGENT_OUTPUT_FILES" -gt 0 ] || [ "$AGENT_DELETIONS" -gt 0 ]; then AGENT_CHANGED=1; else AGENT_CHANGED=0; fi
[ "$AGENT_CHANGED" = 1 ] || echo "No agent workspace changes — skipping deterministic signals (grader scores correctness from the response / N/A)."

# --- Deterministic signals (test / lint / typecheck) -------------------------
# If this task ships a tests/test-commands.sh, run the repo's checks against the
# agent's workspace and hand their output to the grader to inform correctness.
# Each check is a run_signal call (defined below) and carries its own baseline of
# pre-existing failures for the grader to discount. No file => no signals.
DETERMINISTIC_SIGNALS=""
if [ -f "$TESTS_DIR/test-commands.sh" ] && [ "$AGENT_CHANGED" = 1 ]; then
    # Node's heap ceiling, sized to the container. A constant equal to the cgroup
    # limit leaves V8 no reason to collect before the kernel kills the process.
    _mem_bytes=$(cat /sys/fs/cgroup/memory.max 2>/dev/null \
        || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null \
        || echo max)
    case "$_mem_bytes" in
        ''|max|*[!0-9]*) _mem_mb=4096 ;;                  # unconstrained: assume the task's ask
        *) _mem_mb=$((_mem_bytes / 1024 / 1024)) ;;
    esac
    [ "$_mem_mb" -gt 65536 ] && _mem_mb=4096              # some runtimes report ~8 EiB
    _heap_mb=$(( _mem_mb * 75 / 100 ))                    # rest: off-heap, DB, page cache
    [ "$_heap_mb" -lt 512 ] && _heap_mb=512
    export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$_heap_mb"

    # Worker-pool size, from the cpu quota. Node runners read os.cpus(), which
    # reports the HOST's cores, so they over-fork here; Ruby reads the cgroup and
    # needs no bound.
    _cpu_max=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo max)
    case "$_cpu_max" in
        max*|'') RACCOON_CHECK_WORKERS=$(nproc 2>/dev/null || echo 2) ;;
        *) RACCOON_CHECK_WORKERS=$(( ${_cpu_max%% *} / ${_cpu_max##* } )) ;;
    esac
    [ "${RACCOON_CHECK_WORKERS:-0}" -lt 1 ] && RACCOON_CHECK_WORKERS=1
    export RACCOON_CHECK_WORKERS
    # vitest needs MIN set too — its default is the host cpu count, and a min > max
    # pool is a hard error that runs no tests.
    export VITEST_MIN_THREADS=1 VITEST_MAX_THREADS="$RACCOON_CHECK_WORKERS"
    export VITEST_MIN_FORKS=1   VITEST_MAX_FORKS="$RACCOON_CHECK_WORKERS"
    # jest has no env lever; a jest command must pass --maxWorkers itself.
    echo "check budget: container ${_mem_mb}MB -> ${_heap_mb}MB node heap, ${RACCOON_CHECK_WORKERS} workers" >&2

    # Make the source tree owner-writable so the checks can run (skip node_modules).
    find /tmp/files -type d -name node_modules -prune -o -print0 2>/dev/null \
        | xargs -0 chmod u+rwX 2>/dev/null || true
    _SIG=$(mktemp)
    # run_signal <label> <command> [baseline_known_failures]: run one check, save
    # its full output under /logs/verifier/signals/, and append a capped tail to the
    # grader prompt. A non-zero exit (failing suite/lint) is a signal, not an error.
    CAP_BYTES=20000
    mkdir -p /logs/verifier/signals
    # Availability accounting: a check that produced a verdict (pass or real
    # failures) is USABLE; one that couldn't run (killed, missing runner, etc.) is
    # UNAVAILABLE. Count them so a run with unavailable checks can be flagged degraded.
    SIG_TOTAL=0
    SIG_UNAVAIL=0
    : > /logs/verifier/signals/_status.tsv
    run_signal() {
        [ -z "$2" ] && return 0
        echo "Running deterministic signal: $1" >&2
        local slug logf bytes trunc rc status
        slug=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')
        logf="/logs/verifier/signals/${slug}.log"
        ( cd /tmp/files && bash -lc "$2" 2>&1 ) > "$logf"
        rc=$?
        SIG_TOTAL=$((SIG_TOTAL + 1))
        # Classify from the EXIT CODE only. rc>=128 means the check was killed (OOM,
        # timeout, signal): it reached no verdict and its log is cut off mid-run, so
        # there is nothing for the grader to judge from — UNAVAILABLE. Everything
        # else, including a plain non-zero, is a verdict the grader can read.
        #
        # We deliberately do NOT scan the log for "env error" signatures. The same
        # strings appear in genuine agent-introduced breaks: "Cannot find module" is
        # what tsc prints when the agent deletes a file something imports, and "No
        # such file or directory" is Ruby's ENOENT. So the scan excused real failures
        # as env noise while charging real env failures it had no pattern for (a
        # stopped Postgres matched nothing). It also scanned the WHOLE log, so one
        # incidental match voided a check carrying dozens of genuine failures.
        # Attribution is the grader's job; it gets the exit code and the full log.
        if [ "$rc" -ge 128 ]; then
            status="UNAVAILABLE (killed before finishing, exit ${rc})"
            SIG_UNAVAIL=$((SIG_UNAVAIL + 1))
        else
            status="ran (exit ${rc})"
        fi
        printf '%s\t%s\t%s\n' "$1" "$rc" "$status" >> /logs/verifier/signals/_status.tsv
        bytes=$(wc -c < "$logf" | tr -d ' ')
        if [ "$bytes" -gt "$CAP_BYTES" ]; then
            trunc=" — TRUNCATED to the last ${CAP_BYTES} bytes below; Read the file above for the COMPLETE output (e.g. the full failure list)."
        else
            trunc=""
        fi
        {
            echo "===== CHECK: $1 ====="
            echo "command: \`$2\`"
            echo "status: ${status}  (exit 0 = pass; non-zero = the check reported failures; UNAVAILABLE = killed before finishing, no verdict)"
            echo "full output file (readable with your tools): ${logf} (${bytes} bytes)${trunc}"
            echo '```'
            tail -c "$CAP_BYTES" "$logf"
            echo '```'
            if [ -n "${3:-}" ]; then
                echo "Baseline (pre-existing) failures for this check — NOT agent-introduced;"
                echo "count ONLY failures beyond these:"
                echo '```'
                echo "$3"
                echo '```'
            fi
            echo "===== END CHECK: $1 ====="
            echo
        } >> "$_SIG"
    }
    # run_setup <command> — a one-shot build/codegen step (e.g. `prisma generate`)
    # run once before the checks. Not a signal: its exit code isn't scored, and a
    # failure here is non-fatal (a dependent check will surface a real problem).
    run_setup() {
        [ -z "$1" ] && return 0
        echo "Running signal setup: $1" >&2
        local rc
        ( cd /tmp/files && bash -lc "$1" ) > /logs/verifier/signals/_setup.log 2>&1
        rc=$?
        if [ "$rc" -eq 0 ]; then
            echo "signal setup ok" >&2
        else
            echo "signal setup FAILED (rc=${rc}, non-fatal) — see /logs/verifier/signals/_setup.log" >&2
            # Surface it where the grader reads. Guidance routinely says "if the codegen
            # step failed, treat the downstream failures as environmental" — a judgement
            # the grader could not make, because this outcome reached only stderr.
            {
                echo "===== SETUP STEP FAILED ====="
                echo "command: \`$1\`"
                echo "exit: ${rc} (non-fatal; the checks below still ran)"
                echo "This is a build/codegen step, not a scored check. Failures in the checks"
                echo "below that follow from it are not the response's doing — but say which,"
                echo "and do not discount a failure this cannot explain."
                echo "full output file (readable with your tools): /logs/verifier/signals/_setup.log"
                echo '```'
                tail -c 4000 /logs/verifier/signals/_setup.log 2>/dev/null
                echo '```'
                echo "===== END SETUP STEP ====="
                echo
            } >> "$_SIG"
        fi
    }
    # shellcheck source=/dev/null
    . "$TESTS_DIR/test-commands.sh"   # run_setup (optional) + a sequence of run_signal calls
    DETERMINISTIC_SIGNALS=$(cat "$_SIG"); rm -f "$_SIG"

    # Degradation flag: if any expected check couldn't run, record a machine-readable
    # marker so the run can be flagged/re-run rather than silently trusted.
    # (STATUS: ok | degraded | no-checks-ran.)
    SIG_STATUS="ok"
    if [ "$SIG_TOTAL" -eq 0 ]; then
        SIG_STATUS="no-checks-ran"    # test-commands.sh present but every run_signal had an empty command
    elif [ "$SIG_UNAVAIL" -gt 0 ]; then
        SIG_STATUS="degraded"
    fi
    {
        echo "STATUS: $SIG_STATUS"
        echo "checks_total: $SIG_TOTAL"
        echo "checks_unavailable: $SIG_UNAVAIL"
        echo "# per-check: <name>\t<exit>\t<verdict>"
        cat /logs/verifier/signals/_status.tsv 2>/dev/null
    } > /logs/verifier/signals-status.txt
    if [ "$SIG_STATUS" = "degraded" ]; then
        echo "SIGNALS_DEGRADED: ${SIG_UNAVAIL}/${SIG_TOTAL} expected checks could not run — correctness for this run is NOT signal-backed" >&2
        # A prominent banner at the TOP of the injected signals so the grader does
        # not quietly treat missing checks as "code looks fine."
        DETERMINISTIC_SIGNALS="⚠️ SIGNALS DEGRADED: ${SIG_UNAVAIL} of ${SIG_TOTAL} expected checks could NOT run (killed before finishing). The correctness-relevant evidence below is INCOMPLETE — do not infer the code is correct from checks that did not execute; where a check is marked UNAVAILABLE, you have no deterministic signal for that surface.

${DETERMINISTIC_SIGNALS}"
    fi
    # Persist the signals as a standalone artifact of the grade.
    [ -n "$DETERMINISTIC_SIGNALS" ] && printf '%s\n' "$DETERMINISTIC_SIGNALS" > /logs/verifier/deterministic-signals.txt
fi

# How the grader should use the signals — phrased in the grading standard's
# own vocabulary (embedded mid-sentence in the section text below).
SIGNALS_POINTER="Use them to inform
Narrow Correctness (see the system prompt's attribution notes)."

# The prompt section injected into the grader prompt(s). Empty when no signals.
# The grader runs in the agent's container, with Bash and Read — so on a task that opted into
# a browser it can drive the app and look at a screenshot itself, rather than judging rendered
# behaviour from the code. Probed, not assumed: most images have no `pw`, and a prompt that
# promised one would send the grader after a missing binary.
#
# Capability only. When to use it is task-specific and belongs in the task's holistic rubric;
# steering it from the shared prompt would tilt grades on every task at once.
BROWSER_SECTION=""
if command -v pw >/dev/null 2>&1; then
    BROWSER_SECTION='## Browser

Chromium is available in this environment via Playwright. `pw <script.js>` runs Node with
`require("playwright")` resolvable (CommonJS — `import` will not find it). You can load the
app and `Read` a screenshot you take.'
fi

SIGNALS_SECTION=""
if [ -n "$DETERMINISTIC_SIGNALS" ]; then
    SIGNALS_SECTION="## Deterministic Signals

Raw results of the repository's automated checks, run against the workspace
AFTER the agent's changes. Treat the check output as ground truth about what the
tooling reported — trust it over your own reading of what the code does. Whether
a given failure was caused by the agent's change or by the environment it ran in
is your judgement. $SIGNALS_POINTER Each check lists its
own pre-existing baseline failures; a failing check is chargeable to the agent
only for failures NOT in that check's baseline.

Each check is delimited by \`===== CHECK: <name> =====\` … \`===== END CHECK =====\`.
The inline output is the TAIL of the run (the summary + final failures); each
check names a \`full output file\` under /logs/verifier/signals/ — if you need
failures the tail cut off (e.g. to enumerate exactly which specs the agent broke),
Read that file for the complete output rather than relying on the truncated tail.

$DETERMINISTIC_SIGNALS"
fi

SYSTEM_PROMPT=$(cat "$GRADER_PROMPT_FILE")
GRADER_GUIDANCE=$(cat "$GRADER_GUIDANCE_FILE")

if [ "$GRADER_MODE" = "one-shot" ]; then
    echo "Launching one-shot (no-tools) grader..."
    # One-shot has no tools, so it cannot write grade.json and the renderer never
    # runs — strip the shared prompt's file-based output contract (the
    # HARNESS-OUTPUT-PROTOCOL block) and let the final instruction below define
    # the protocol instead.
    if ! grep -q 'HARNESS-OUTPUT-PROTOCOL:BEGIN' "$GRADER_PROMPT_FILE"; then
        echo "ERROR: $(basename "$GRADER_PROMPT_FILE") is missing the HARNESS-OUTPUT-PROTOCOL markers; one-shot mode cannot strip the file-based output contract" >&2
        exit 1
    fi
    SYSTEM_PROMPT=$(awk '
        /HARNESS-OUTPUT-PROTOCOL:BEGIN/ { skip = 1 }
        /HARNESS-OUTPUT-PROTOCOL:END/   { skip = 0; next }
        !skip
    ' "$GRADER_PROMPT_FILE")
    # Inline the same transcript the agentic grader reads (raw ATIF JSON), capped
    # so a giant trajectory can't blow the context window.
    TRANSCRIPT=$(head -c 350000 /tmp/admin-task/task_transcript.txt 2>/dev/null)
    # Inline the agent's captured edits (its deliverable). Empty for advisory runs
    # (the deliverable is then the final message in the transcript above).
    DELIVERABLE=$(cd /logs/verifier/agent-output 2>/dev/null && \
        find . -type f ! -name _HARBOR_DELETIONS.txt | sort | while IFS= read -r f; do
            printf '=== %s ===\n' "${f#./}"; head -c 40000 "$f"; printf '\n'
        done)
    [ -z "$DELIVERABLE" ] && DELIVERABLE="(no file edits captured — advisory run; the deliverable is the agent's final message in the transcript above)"

    ONESHOT_FINAL="Apply the system prompt's scoring guidance. Write no files — you have no tools.
Put your full grade narrative in your reply: the per-criterion scores and
rationales, and any overall-score penalties that fired.

Then compute the score: the mean of your non-N/A criterion scores, minus any
overall-score heavy penalties the task guidance directed at the overall
score, floored at 0.00. On the LAST line output exactly:"

    ONESHOT_PROMPT="$SYSTEM_PROMPT

## Task-Specific Holistic Rubric

$GRADER_GUIDANCE

$SIGNALS_SECTION

## ONE-SHOT GRADING (no tools)

You have NO tools and cannot open files or run anything. Grade ONLY from the
materials below. The transcript includes the agent's tool calls AND their
observations, so the file contents it actually read are shown to you inline —
judge its claims against those. Do not invent file contents you were not shown.

## Worker transcript (/tmp/admin-task/task_transcript.txt)

$TRANSCRIPT

## Worker file edits (the agent's deliverable)

$DELIVERABLE

## Final instruction

$ONESHOT_FINAL
REWARD: 0.XX  (a number from 0.00 to 1.00)."

    cd /tmp/files && claude \
        --bare \
        --model "$GRADER_MODEL" \
        ${GRADER_FAST_FLAGS[@]+"${GRADER_FAST_FLAGS[@]}"} \
        --allowedTools '' \
        -p "$ONESHOT_PROMPT" \
        > /logs/verifier/grade.md 2>/logs/verifier/grader-stderr.log

    # Anchor to the whole final REWARD line so "REWARD: 10" / "1.5" capture the
    # FULL number (10 / 1.5) and get rejected by the range check below, instead
    # of matching a "1" prefix and becoming a bogus max reward.
    REWARD=$(grep -oiE 'REWARD:[[:space:]]*([0-9]+(\.[0-9]+)?|\.[0-9]+)[[:space:]]*$' /logs/verifier/grade.md \
        | tail -1 | grep -oE '[0-9]*\.?[0-9]+')
    if [ -z "$REWARD" ] || ! awk -v r="$REWARD" 'BEGIN{exit !(r+0>=0 && r+0<=1)}'; then
        echo "ERROR: one-shot grader produced no valid REWARD in [0,1] (got '${REWARD:-}'; see grade.md / grader-stderr.log)" >&2
        exit 1
    fi
    echo "$REWARD" > /logs/verifier/reward.txt
    # Mirror into reward.json (harbor's preferred file). One-shot mode produces no
    # correctness value, so this carries the reward only.
    printf '{"reward": %s}\n' "$REWARD" > /logs/verifier/reward.json
    cat /logs/verifier/reward.txt
    exit 0
fi

if [ -n "$RUBRIC_FORM" ]; then
    # Rubric modes grade against staged atomic-rubric assets instead of the
    # holistic rubric; render-rubric-grade.py replaces
    # render-grade-consolidated.py.
    for f in grader-context.md rubric-criteria.md rubric-criteria.json render-rubric-grade.py; do
        if [ ! -f "$TESTS_DIR/$f" ]; then
            echo "ERROR: GRADER_MODE=$GRADER_MODE needs $TESTS_DIR/$f — stage the rubric assets first (npx tsx scripts/stage-atomic-rubric.ts <task-slug>)" >&2
            exit 1
        fi
    done
else
    # The structured-grade renderer is a hard dependency of the agentic path: it
    # validates each sample's grade.json and derives reward.txt /
    # reward-correctness.txt / grade.md from it.
    if [ ! -f "$RENDER_GRADE" ]; then
        echo "ERROR: $RENDER_GRADE missing — this task's tests/ directory is out of sync with the shared grader assets (re-sync the grading harness)" >&2
        exit 1
    fi
fi

if [ -n "$RUBRIC_FORM" ]; then
    # The output protocol differs from the shared prompt's grade.json contract —
    # strip the HARNESS-OUTPUT-PROTOCOL block (same seam as the one-shot mode)
    # and append the rubric contract instead.
    if ! grep -q 'HARNESS-OUTPUT-PROTOCOL:BEGIN' "$GRADER_PROMPT_FILE"; then
        echo "ERROR: $(basename "$GRADER_PROMPT_FILE") is missing the HARNESS-OUTPUT-PROTOCOL markers; rubric modes cannot strip the file-based output contract" >&2
        exit 1
    fi
    SYSTEM_PROMPT=$(awk '
        /HARNESS-OUTPUT-PROTOCOL:BEGIN/ { skip = 1 }
        /HARNESS-OUTPUT-PROTOCOL:END/   { skip = 0; next }
        !skip
    ' "$GRADER_PROMPT_FILE")
    GRADER_CONTEXT=$(cat "$TESTS_DIR/grader-context.md")
    RUBRIC_CRITERIA=$(cat "$TESTS_DIR/rubric-criteria.md")

    if [ "$RUBRIC_FORM" = "trinary" ]; then
        RUBRIC_VALUE_INSTRUCTION='For each criterion give a "verdict": "pass" (the response fulfills the criterion), "partial" (it meaningfully but incompletely fulfills it), or "fail" (it does not fulfill it).'
        RUBRIC_ENTRY_EXAMPLE='{ "id": "<criterion-id>", "verdict": "pass", "rationale": "..." }'
    else
        RUBRIC_VALUE_INSTRUCTION='For each criterion give a "score": a number from 0.00 to 1.00 (two decimals) for the degree to which the response fulfills the criterion — 1.00 fully, 0.00 not at all.'
        RUBRIC_ENTRY_EXAMPLE='{ "id": "<criterion-id>", "score": 0.75, "rationale": "..." }'
    fi

    GRADER_PROMPT="$SYSTEM_PROMPT

## Task-Specific Grader Context

$GRADER_CONTEXT

## Rubric Criteria

$RUBRIC_CRITERIA

$SIGNALS_SECTION

$BROWSER_SECTION

## RUBRIC GRADING (output protocol)

This grading run scores the agent's response against the task-specific rubric
criteria above, INSTEAD of the criterion protocol described earlier in this
prompt. Do not produce the system prompt's criterion scores, an overall score,
or a correctness score. Where a rubric criterion's text carries numeric
guidance aimed at score arithmetic, treat it as severity context for that
criterion's judgment.

Evaluate EVERY criterion independently against the trajectory and the
workspace, using your tools to verify claims before deciding — everything the
system prompt says about reading the trajectory first, digging hard, and never
substituting a grep for understanding applies to each criterion.
$RUBRIC_VALUE_INSTRUCTION
Each criterion's \"rationale\" cites the specific evidence (transcript moments,
files, check output) behind the judgment.

Write ONE file: /logs/verifier/rubric-grade.json, exactly in this shape:

\`\`\`json
{
  \"schema_version\": 1,
  \"criteria\": [
    $RUBRIC_ENTRY_EXAMPLE
  ],
  \"closing\": \"optional short note\"
}
\`\`\`

Include every criterion listed above exactly once, with \"id\" spelled exactly
as in its heading. Do NOT write grade.json, reward.txt, or grade.md —
rubric-grade.json is your only output.

**Verify the file before you finish.** Write it in one operation, then confirm
it actually parses:

\`\`\`
python3 -c \"import json; d = json.load(open('/logs/verifier/rubric-grade.json')); print(len(d['criteria']))\"
\`\`\`

If that errors, fix the file and re-check until it parses."
else
    AGENTIC_FINAL="Apply the system prompt's scoring guidance. Write ONE file: /logs/verifier/grade.json,
exactly in the schema the system prompt specifies — the eight criterion
entries with two-decimal scores and rationales (score null = N/A), your holistic
overall_score, any task-directed overall_penalties entries (reflected in that
overall_score), and an optional closing note. Do NOT write reward.txt,
reward-correctness.txt, or grade.md — grade.json is your only output."

    GRADER_PROMPT="$SYSTEM_PROMPT

## Task-Specific Holistic Rubric

$GRADER_GUIDANCE

$SIGNALS_SECTION

$BROWSER_SECTION

## Final instruction

$AGENTIC_FINAL"
fi

# Which file the grader writes, and how a sample gets rendered to reward/grade.md.
GRADE_JSON_PATH="/logs/verifier/grade.json"
[ -n "$RUBRIC_FORM" ] && GRADE_JSON_PATH="/logs/verifier/rubric-grade.json"

# Exact shape reminder used by the repair turn. Repairs happen when a sample's
# file was rejected; the rejection is as often schema drift (a misspelled key,
# a dropped schema_version) as truncation, and "write it again in the same
# schema" faithfully preserves drift — so the repair prompt restates the shape.
if [ -n "$RUBRIC_FORM" ]; then
    if [ "$RUBRIC_FORM" = "trinary" ]; then
        GRADE_SCHEMA_REMINDER='{"schema_version": 1, "criteria": [{"id": "<criterion-id>", "verdict": "pass" | "partial" | "fail", "rationale": "..."} — one entry per listed criterion], "closing": "optional"}'
    else
        GRADE_SCHEMA_REMINDER='{"schema_version": 1, "criteria": [{"id": "<criterion-id>", "score": 0.00-1.00 two decimals, "rationale": "..."} — one entry per listed criterion], "closing": "optional"}'
    fi
else
    GRADE_SCHEMA_REMINDER='{"schema_version": 1, "criteria": {"integrity": {"score": 0.00-1.00 or null, "rationale": "..."}, "narrow_correctness": {...}, "broader_correctness": {...}, "persistence": {...}, "communication": {...}, "verification_thoroughness": {...}, "common_sense": {...}, "thought_partnership": {...}}, "overall_penalties": [{"amount": 0.10, "reason": "..."}], "overall_score": 0.00-1.00, "closing": "optional"}'
fi

echo "Launching Claude Code grader (requested model: $GRADER_MODEL, samples: $GRADER_SAMPLES)..."

# Grade GRADER_SAMPLES times and ship the mean (averaging reduces re-grade noise).
# Per-sample artifacts are kept as reward-N.txt / grade-N.md / grader-result-N.json;
# the canonical grade.md etc. are copied from the sample closest to the mean. A
# sample with no valid reward in [0,1] is skipped; need min(2, GRADER_SAMPLES) valid.
GRADER_MODEL="${GRADER_MODEL:-claude-fable-5-1}"
GRADER_SAMPLES="${GRADER_SAMPLES:-1}"
mkdir -p /tmp/outputs /logs/verifier
[ -e /tmp/files ] || ln -sfn /workspace /tmp/files

# The prompt goes to claude on stdin, not as a command-line argument. A single
# argument is capped at 128 KiB, and the prompt carries the whole deterministic-
# signals block, so a task whose checks are verbose can exceed it — and the exec
# then fails before claude starts, leaving an empty grader-result-N.json and no
# reward. Reading it from a file has no size limit.
GRADER_PROMPT_PATH=/tmp/grader-prompt.txt

N_VALID=0
SUM=0
# Recovery ladder for a sample whose grade.json doesn't validate. The grader
# hand-serializes the file in a single Write, so an occasional dropped closing
# brace loses the sample — measured at ~1-in-11 real fable-5 samples before the
# prompt gained its self-verify step, which at 3 samples would have failed about
# a quarter of all verifications now that every sample must validate.
#
# Cheapest recovery first:
#   1. RESUME the grader's own session and tell it the parse error. Its judgment
#      is already in that context, so this is a short turn against a cached
#      prefix (~1/10th the cost of grading again) and — more importantly — it
#      preserves the grade instead of replacing it with a different draw.
#   2. Only if there is no session to resume (the grader died before producing
#      anything, e.g. an API error at turn 1) fall back to a full re-grade.
GRADER_ATTEMPTS="${GRADER_ATTEMPTS:-3}"
for I in $(seq 1 "$GRADER_SAMPLES"); do
    RESUME_SID=""
    LAST_ERR=""
    for ATTEMPT in $(seq 1 "$GRADER_ATTEMPTS"); do
        rm -f /logs/verifier/reward.txt /logs/verifier/reward-correctness.txt \
            /logs/verifier/grade.md /logs/verifier/grade.json /logs/verifier/rubric-grade.json
        if [ -n "$RESUME_SID" ]; then
            # Repair turn: same session, same judgment, just fix the file.
            cd /tmp/files && claude \
                --model "$GRADER_MODEL" \
                ${GRADER_FAST_FLAGS[@]+"${GRADER_FAST_FLAGS[@]}"} \
                --allowedTools Read Bash Write \
                --output-format json \
                --resume "$RESUME_SID" \
                -p "The $GRADE_JSON_PATH you wrote could not be parsed:

    $LAST_ERR

Your judgment is fine — only the file is broken. The usual causes are a
truncated write (a missing closing \`}\`, \`]\`, or \`\"\`) or schema drift (a
misspelled or missing key). Write the COMPLETE file again to $GRADE_JSON_PATH,
preserving the judgments and rationales you already decided on, in EXACTLY
this shape (every key spelled exactly as shown, no extra keys, nothing after
the final closing brace):

    $GRADE_SCHEMA_REMINDER

Then confirm it parses:

    python3 -c \"import json; json.load(open('$GRADE_JSON_PATH'))\"

Do not change any judgment. Do not shorten any rationale." \
                >"/logs/verifier/grader-result-$I.json" \
                2>"/logs/verifier/grader-stderr-$I.log"
        else
            printf '%s' "$GRADER_PROMPT" > "$GRADER_PROMPT_PATH"
            cd /tmp/files && claude \
                --model "$GRADER_MODEL" \
                ${GRADER_FAST_FLAGS[@]+"${GRADER_FAST_FLAGS[@]}"} \
                --allowedTools Read Glob Grep Bash Write \
                --output-format json \
                -p \
                <"$GRADER_PROMPT_PATH" \
                >"/logs/verifier/grader-result-$I.json" \
                2>"/logs/verifier/grader-stderr-$I.log"
        fi

        # The grader's structured file is its only recognized output. Clear anything
        # else it may have written (a stale-prompted grader writing reward.txt
        # directly must not count), then derive reward.txt / reward-correctness.txt /
        # grade.md from the JSON. A missing or invalid file leaves no reward.txt, so
        # the validity check below skips the sample.
        rm -f /logs/verifier/reward.txt /logs/verifier/reward-correctness.txt /logs/verifier/grade.md
        if [ -f "$GRADE_JSON_PATH" ]; then
            if [ -n "$RUBRIC_FORM" ]; then
                python3 "$TESTS_DIR/render-rubric-grade.py" \
                    --rubric-json "$GRADE_JSON_PATH" \
                    --criteria "$TESTS_DIR/rubric-criteria.json" \
                    --form "$RUBRIC_FORM" \
                    --out-dir /logs/verifier \
                    2>"/logs/verifier/render-stderr-$I-attempt$ATTEMPT.log"
            else
                python3 "$RENDER_GRADE" \
                    --grade-json "$GRADE_JSON_PATH" \
                    --out-dir /logs/verifier \
                    2>"/logs/verifier/render-stderr-$I-attempt$ATTEMPT.log"
            fi
            if [ $? -ne 0 ]; then
                echo "WARN: grader sample $I attempt $ATTEMPT produced an invalid $(basename "$GRADE_JSON_PATH") (see render-stderr-$I-attempt$ATTEMPT.log)" >&2
                # Preserve exactly what the grader wrote, per attempt. This is the
                # primary evidence for why a sample failed; the renderer leaves it
                # in place and the next attempt's rm would delete it. Moving it
                # aside also keeps an invalid body off the canonical path, where a
                # last-sample failure would otherwise strand it.
                mv "$GRADE_JSON_PATH" \
                    "/logs/verifier/grade-$I-attempt$ATTEMPT.invalid.json"
                mv "/logs/verifier/grader-result-$I.json" \
                    "/logs/verifier/grader-result-$I-attempt$ATTEMPT.json" 2>/dev/null || true
            fi
        else
            echo "WARN: grader sample $I attempt $ATTEMPT wrote no $(basename "$GRADE_JSON_PATH")" >&2
        fi

        # Rendered successfully — take this attempt.
        [ -f /logs/verifier/reward.txt ] && break
        [ "$ATTEMPT" -ge "$GRADER_ATTEMPTS" ] && break

        # Choose the next attempt's mode. Resume-and-repair only makes sense when
        # this attempt actually produced a (rejected) file — that means the grader
        # reached a judgment and only the serialization failed. If it produced
        # nothing, its session has no grade to preserve, so grade again instead.
        LAST_ERR=$(tail -1 "/logs/verifier/render-stderr-$I-attempt$ATTEMPT.log" 2>/dev/null || true)
        RESUME_SID=""
        if [ -f "/logs/verifier/grade-$I-attempt$ATTEMPT.invalid.json" ]; then
            RESUME_SID=$(python3 -c "
import json, sys
try:
    print(json.load(open('/logs/verifier/grader-result-$I-attempt$ATTEMPT.json')).get('session_id') or '')
except Exception:
    print('')
" 2>/dev/null || true)
        fi
        if [ -n "$RESUME_SID" ]; then
            echo "WARN: sample $I attempt $ATTEMPT wrote an unparseable grade.json; resuming session $RESUME_SID to repair it (attempt $((ATTEMPT + 1))/$GRADER_ATTEMPTS)" >&2
        else
            echo "WARN: re-grading sample $I from scratch (attempt $((ATTEMPT + 1))/$GRADER_ATTEMPTS)" >&2
        fi
    done

    R=""
    [ -f /logs/verifier/reward.txt ] && R=$(tr -d '[:space:]' < /logs/verifier/reward.txt)
    if echo "$R" | grep -qE '^([0-9]+(\.[0-9]+)?|\.[0-9]+)$' \
        && awk -v r="$R" 'BEGIN{exit !(r+0>=0 && r+0<=1)}'; then
        mv /logs/verifier/reward.txt "/logs/verifier/reward-$I.txt"
        [ -f /logs/verifier/grade.md ] && mv /logs/verifier/grade.md "/logs/verifier/grade-$I.md"
        [ -f /logs/verifier/grade.json ] && mv /logs/verifier/grade.json "/logs/verifier/grade-$I.json"
        [ -f /logs/verifier/rubric-grade.json ] && mv /logs/verifier/rubric-grade.json "/logs/verifier/rubric-grade-$I.json"
        SUM=$(awk -v s="$SUM" -v r="$R" 'BEGIN{printf "%.6f", s+r}')
        N_VALID=$((N_VALID + 1))
        echo "grader sample $I: $R"

        # Correctness is additive + optional: a single number in [0,1], or the
        # literal N/A ("no code to judge"). Captured only for samples with a
        # valid reward so it shares the same sample set. Missing/invalid =>
        # skipped; never affects reward.txt. Rubric modes produce no
        # correctness score, and the grading standard's renderer records N/A
        # (correctness lives inside the criteria).
        if [ -z "$RUBRIC_FORM" ]; then
            C=""
            [ -f /logs/verifier/reward-correctness.txt ] && C=$(tr -d '[:space:]' < /logs/verifier/reward-correctness.txt)
            if echo "$C" | grep -qiE '^n/?a$'; then
                echo "NA" > "/logs/verifier/reward-correctness-$I.txt"
                echo "  correctness sample $I: N/A"
            elif echo "$C" | grep -qE '^([0-9]+(\.[0-9]+)?|\.[0-9]+)$' \
                && awk -v r="$C" 'BEGIN{exit !(r+0>=0 && r+0<=1)}'; then
                echo "$C" > "/logs/verifier/reward-correctness-$I.txt"
                echo "  correctness sample $I: $C"
            else
                echo "  WARN: correctness sample $I missing/invalid (got '${C:-}')" >&2
            fi
        fi
    else
        echo "WARN: grader sample $I produced no valid reward in [0,1] (got '${R:-}'; see grader-stderr-$I.log)" >&2
        rm -f "/logs/verifier/reward-$I.txt" "/logs/verifier/grade-$I.md" "/logs/verifier/grade-$I.json" "/logs/verifier/rubric-grade-$I.json"
    fi
done

# Every requested sample must validate. Tolerating a dropped sample would
# silently vary the sample count the mean is taken over (different variance
# per run) — fail the verification instead and let the harness re-run it.
if [ "$N_VALID" -ne "$GRADER_SAMPLES" ]; then
    # Phrase this for whoever is reading it, which includes a task author running
    # harbor-run locally. The failure is grader-side serialization, not anything
    # wrong with their task, and it is recoverable by re-running — say so, rather
    # than leaving them to debug a task that is fine.
    echo "ERROR: the grader returned a usable result for only $N_VALID of $GRADER_SAMPLES samples (each was already retried)." >&2
    echo "       This is a grader-side failure, not a problem with your task: the scores it produced" >&2
    echo "       could not be read back. The reward is deliberately not reported rather than averaged" >&2
    echo "       over fewer samples, because the sample count is what keeps grader noise down." >&2
    echo "       It is usually transient — re-run to get a grade. If it repeats, check" >&2
    echo "       verifier/render-stderr-*.log (what was rejected) and verifier/grader-stderr-*.log" >&2
    echo "       (whether the grader itself errored), plus any verifier/grade-*.invalid.json." >&2
    exit 1
fi

REWARD=$(awk -v s="$SUM" -v n="$N_VALID" 'BEGIN{printf "%.4f", s/n}')

# Correctness aggregate (additive; never affects REWARD above). Mean of the
# numeric samples; N/A when every sample said N/A (no code to judge); absent
# entirely when no sample produced a correctness value (e.g. no signals + the
# grader chose not to emit one).
C_SUM=0; C_N=0; C_NA=0
for I in $(seq 1 "$GRADER_SAMPLES"); do
    [ -f "/logs/verifier/reward-correctness-$I.txt" ] || continue
    v=$(cat "/logs/verifier/reward-correctness-$I.txt")
    if [ "$v" = "NA" ]; then
        C_NA=$((C_NA + 1))
    else
        C_SUM=$(awk -v s="$C_SUM" -v r="$v" 'BEGIN{printf "%.6f", s+r}')
        C_N=$((C_N + 1))
    fi
done
CORRECTNESS="(none)"
if [ "$C_N" -gt 0 ]; then
    CORRECTNESS=$(awk -v s="$C_SUM" -v n="$C_N" 'BEGIN{printf "%.4f", s/n}')
    echo "$CORRECTNESS" > /logs/verifier/reward-correctness.txt
elif [ "$C_NA" -gt 0 ]; then
    CORRECTNESS="N/A"
    echo "N/A" > /logs/verifier/reward-correctness.txt
fi

# Canonical single-grade files = the valid sample closest to the mean.
BEST_I=$(for I in $(seq 1 "$GRADER_SAMPLES"); do
    [ -f "/logs/verifier/reward-$I.txt" ] || continue
    awk -v r="$(cat "/logs/verifier/reward-$I.txt")" -v m="$REWARD" -v i="$I" \
        'BEGIN{d=r-m; if (d<0) d=-d; printf "%.6f %d\n", d, i}'
done | sort -n | head -1 | awk '{print $2}')
cp "/logs/verifier/grade-$BEST_I.md" /logs/verifier/grade.md 2>/dev/null || true
cp "/logs/verifier/grade-$BEST_I.json" /logs/verifier/grade.json 2>/dev/null || true
cp "/logs/verifier/rubric-grade-$BEST_I.json" /logs/verifier/rubric-grade.json 2>/dev/null || true
cp "/logs/verifier/grader-result-$BEST_I.json" /logs/verifier/grader-result.json 2>/dev/null || true
cp "/logs/verifier/grader-stderr-$BEST_I.log" /logs/verifier/grader-stderr.log 2>/dev/null || true

{
    echo "samples_requested: $GRADER_SAMPLES"
    echo "samples_valid: $N_VALID"
    for I in $(seq 1 "$GRADER_SAMPLES"); do
        [ -f "/logs/verifier/reward-$I.txt" ] && echo "sample_$I: $(cat "/logs/verifier/reward-$I.txt")"
    done
    echo "mean: $REWARD"
    echo "canonical_sample: $BEST_I"
    for I in $(seq 1 "$GRADER_SAMPLES"); do
        [ -f "/logs/verifier/reward-correctness-$I.txt" ] && echo "correctness_sample_$I: $(cat "/logs/verifier/reward-correctness-$I.txt")"
    done
    echo "correctness_mean: $CORRECTNESS"
} > /logs/verifier/grader-samples.txt

echo "$REWARD" > /logs/verifier/reward.txt

# reward.json — harbor's preferred {key: number} file; mirrors reward.txt's
# number and adds "correctness" as a second key when a numeric correctness
# aggregate exists (omitted for N/A runs). reward key == reward.txt.
if printf '%s' "$CORRECTNESS" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
    printf '{"reward": %s, "correctness": %s}\n' "$REWARD" "$CORRECTNESS" > /logs/verifier/reward.json
else
    printf '{"reward": %s}\n' "$REWARD" > /logs/verifier/reward.json
fi

echo "reward: $REWARD    correctness: $CORRECTNESS"
cat /logs/verifier/reward.txt
cat /logs/verifier/reward.json
