#!/bin/sh
# Restrict this container's DNS to the hosts in DNSJAIL_ALLOW (space-separated), leaving
# every other name unresolvable. Runs as root, inside the container.
#
# Baked into the task images and invoked by the agent (scripts/dnsjail.py); shipped to the
# Explore container by the toolkit packaging. Both surfaces run this same file. Supplied from
# outside: DNSJAIL_ALLOW, the hosts the agent will actually dial -- every one must resolve or
# no jail happens -- and DNSJAIL_ALLOW_EXTRA, nice-to-haves that only warn if they do not.
#
# An unreachable model endpoint is a dead trial or a dead session, so nothing here is
# applied before it is verified, and any doubt leaves the container's DNS untouched.
set -u

STATE=/tmp/.dnsjail
CONTROL=example.com   # must NOT resolve through us; proves we reached our own filter

bounded() { if command -v timeout >/dev/null 2>&1; then timeout 5 "$@"; else "$@"; fi; }
# Exact match: docker's own embedded resolver is 127.0.0.11, which a prefix match reads as
# already-jailed — and then resolv.orig is never captured, so unjail has nothing to restore.
jailed_now() { grep -qE '^nameserver[[:space:]]+127\.0\.0\.1[[:space:]]*$' /etc/resolv.conf 2>/dev/null; }

# Stop only the dnsmasq we started, so a declined run leaves nothing bound on :53 that a
# later run could mistake for its own filter.
drop_ours() {
  if [ -s "$STATE/dnsmasq.pid" ]; then
    pid=$(cat "$STATE/dnsmasq.pid")
    # /tmp survives docker stop/start but pids restart at 1, so last boot's pid may now be
    # some service's child. Confirm it is dnsmasq before signalling it.
    case "$(cat "/proc/$pid/comm" 2>/dev/null)" in
      dnsmasq) kill "$pid" 2>/dev/null || true ;;
    esac
    rm -f "$STATE/dnsmasq.pid" 2>/dev/null || true
  fi
}

# Never `exit`: a caller may source this, so bailing out has to fall through rather than
# end the caller's shell.
dnsjail_apply() {
  required="${DNSJAIL_ALLOW:-}"
  extra="${DNSJAIL_ALLOW_EXTRA:-}"
  allow=$(echo $required $extra)   # unquoted: collapses to a single-spaced word list
  # A blank required list means no model endpoint was found: jailing would strand the agent.
  set -- $required
  [ $# -gt 0 ] || return 0

  # Already jailed by us, with our resolver alive and the same allowlist? Do nothing. Tearing
  # down and rebinding :53 races the kernel releasing the socket, and losing that race ends
  # in a fail-open restore -- so a second apply (the codex fresh path, rejail, run-app) would
  # silently UNjail a working container.
  if jailed_now && [ -s "$STATE/dnsmasq.pid" ] &&
     [ "$(cat "/proc/$(cat "$STATE/dnsmasq.pid")/comm" 2>/dev/null)" = "dnsmasq" ] &&
     [ "$(cat "$STATE/allow" 2>/dev/null)" = "$required" ] &&
     [ "$(cat "$STATE/allow-extra" 2>/dev/null)" = "$extra" ]; then
    return 0
  fi

  # The state dir has to work first: it holds what unjail restores, and a failed write here
  # is what would otherwise truncate /etc/resolv.conf. Sticky world-writable so run-app,
  # running as the container user in Explore, can drop its own lift markers.
  mkdir -p "$STATE" 2>/dev/null || return 0
  chmod 1777 "$STATE" 2>/dev/null || true
  : > "$STATE/.probe" 2>/dev/null || return 0
  rm -f "$STATE/.probe" 2>/dev/null || true

  # Never forward to ourselves. Re-applying to an already-jailed container would otherwise
  # read 127.0.0.1 out of resolv.conf and point dnsmasq at its own socket, blackholing
  # every name.
  src=/etc/resolv.conf
  if jailed_now && [ -s "$STATE/resolv.orig" ]; then src="$STATE/resolv.orig"; fi
  up=$(awk '/^nameserver[ \t]+[0-9]+\./{print $2; exit}' "$src" 2>/dev/null)
  [ "$up" = "127.0.0.1" ] && up=""

  if [ -n "$up" ] && command -v dnsmasq >/dev/null 2>&1; then
    srv=""
    for h in $allow; do srv="$srv --server=/$h/$up"; done
    drop_ours
    # cache-size=0: every lookup goes upstream, so a jailed container sees what an unjailed
    # one would rather than an answer this resolver decided to keep.
    dnsmasq --no-resolv --no-hosts --listen-address=127.0.0.1 --bind-interfaces \
            --cache-size=0 --pid-file="$STATE/dnsmasq.pid" --address=/#/ $srv \
            >/dev/null 2>>"$STATE/dnsmasq.err" || true
  fi

  # Ask the resolver directly: the model endpoint must answer and the control must not --
  # otherwise we are looking at somebody else's resolver, not our filter. Only the FIRST
  # host gates the jail: an extra host that CNAMEs outside the allowlist cannot resolve
  # through the catch-all, and one of those must not silently disable the whole jail.
  live=1
  for h in $required; do
    bounded nslookup "$h" 127.0.0.1 >/dev/null 2>&1 || { live=""; break; }
  done
  if [ -n "$live" ] && bounded nslookup "$CONTROL" 127.0.0.1 >/dev/null 2>&1; then live=""; fi
  # The extras are reported, never fatal: one that CNAMEs outside the allowlist cannot
  # resolve through the catch-all, and must not take the whole jail down with it.
  if [ -n "$live" ]; then
    for h in $extra; do
      bounded nslookup "$h" 127.0.0.1 >/dev/null 2>&1 ||
        echo "dns-jail: $h does not resolve through the jail (CNAME outside the allowlist?)" >&2
    done
  fi

  if [ -z "$live" ]; then
    # Say why. A silent decline is indistinguishable from a jail that worked, and the
    # reason is usually one line from dnsmasq (gVisor sandboxes, for instance, have no
    # AF_NETLINK, so dnsmasq cannot start there at all).
    echo "dns-jail: declined, this container keeps normal network access${DNSJAIL_WHY:-}" >&2
    [ -s "$STATE/dnsmasq.err" ] && sed 's/^/dns-jail:   /' "$STATE/dnsmasq.err" >&2
    drop_ours
    # Failing open has to mean actually open, including when an earlier run left this
    # container jailed.
    if jailed_now && [ -s "$STATE/resolv.orig" ]; then
      cat "$STATE/resolv.orig" > /etc/resolv.conf 2>/dev/null || true
    fi
    return 0
  fi

  # Capture what unjail restores — but never overwrite it with an already-jailed file, which
  # would leave unjail a permanent no-op.
  if ! jailed_now; then
    cp /etc/resolv.conf "$STATE/resolv.orig" 2>/dev/null || return 0
  fi
  printf '%s\n' "$required" > "$STATE/allow" 2>/dev/null || true
  printf '%s\n' "$extra" > "$STATE/allow-extra" 2>/dev/null || true
  # A marker from a run-app that was killed would otherwise keep the jail disarmed forever.
  rm -rf "$STATE/lifts" 2>/dev/null || true

  # /etc/resolv.conf is a bind mount, so it is truncated in place, never renamed over —
  # which means the replacement has to be complete BEFORE the write starts. Keep every
  # non-nameserver directive docker set (options, search).
  { printf 'nameserver 127.0.0.1\n'
    grep -vE '^[[:space:]]*nameserver' /etc/resolv.conf
  } > "$STATE/resolv.jailed" 2>/dev/null
  [ -s "$STATE/resolv.jailed" ] || return 0
  cat "$STATE/resolv.jailed" > /etc/resolv.conf
}

dnsjail_apply || true
