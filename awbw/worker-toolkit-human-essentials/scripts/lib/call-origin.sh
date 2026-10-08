# shellcheck shell=bash
# call-origin.sh — build the X-Surge-Client-Metadata header value.
#
# Which surface a proxy call came from (a trial agent, the grader, Explore, a
# dev box). Separate from llm-proxy-env.sh, which carries the project id and the
# proxy routes: those are platform-internal, this is not, so this file is the
# half that ships in the worker toolkit — worker runs go through the same proxy
# and are attributed the same way.
#
#   . scripts/lib/call-origin.sh
#   meta="$(LLM_CALL_ORIGIN=harbor-grading call_origin_metadata)"
#
# The proxy rejects the WHOLE CALL over a malformed metadata header (400
# invalid_client_metadata), so an origin that is not a plain slug yields an
# empty string and the caller sends no header at all: losing attribution beats
# failing the call.

CALL_ORIGIN_HEADER="X-Surge-Client-Metadata"
# An unlabelled call is still a real call, so it gets a bucket rather than no
# header: a missing origin in the audit log then means an unplumbed surface.
DEFAULT_CALL_ORIGIN="local"

# Compact JSON for the header, or empty when LLM_CALL_ORIGIN is unusable.
# Only a slug matching this pattern is ever interpolated, so nothing needs
# JSON-escaping and this stays dependency-free (it is sourced in worker
# containers, which have no python).
call_origin_metadata() {
    local origin="${LLM_CALL_ORIGIN:-$DEFAULT_CALL_ORIGIN}"
    case "$origin" in
        "" | *[!a-z0-9._-]* | [!a-z0-9]*) return 0 ;;
    esac
    [ "${#origin}" -le 64 ] || return 0
    printf '{"origin":"%s"}' "$origin"
}
