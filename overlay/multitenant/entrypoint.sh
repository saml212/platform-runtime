#!/usr/bin/env bash
# Multi-tenant runtime entrypoint.
#
# Selects what runs in this container based on $MODE:
#   - subscription   : official `claude` / `codex` binaries running as the
#                      tenant's Pro/Max OAuth session. The container stays
#                      alive (broker in foreground) so the platform-context
#                      proxy can drive the binaries via the PTY-WS broker.
#   - byok           : OpenClaw gateway authenticated against the tenant's
#                      Anthropic / OpenAI API key (env vars).
#   - open-weights   : OpenClaw gateway pointed at a platform-hosted
#                      open-weights endpoint (cerebras / chutes / etc).
#
# In ALL modes we start the PTY-WebSocket broker (port 7681) in the
# background so the platform-context proxy can spawn claude/codex/bash
# PTYs at any time. In `byok` / `open-weights` the OpenClaw gateway runs
# in the foreground; in `subscription` we `wait -n` so signals propagate.
#
# Any extra args passed to the container are forwarded to the chosen
# command, so `docker run ... claude --version` still works.

set -euo pipefail

MODE="${MODE:-byok}"
OPENCLAW_BIND="${OPENCLAW_BIND:-lan}"
OPENCLAW_PORT="${OPENCLAW_PORT:-3000}"
BROKER_PORT="${BROKER_PORT:-7681}"

log() {
  printf '[entrypoint] %s\n' "$*" >&2
}

# If the caller passed a command (e.g. `docker run image claude --version`),
# just run it. The mode router only kicks in when no command is given.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# --- broker (always-on) -----------------------------------------------------
if [ -x /usr/local/bin/broker ]; then
  if [ -z "${BROKER_TENANT_TOKEN:-}" ]; then
    log "WARN: BROKER_TENANT_TOKEN unset; broker /ws + /spawn will refuse all requests."
  else
    log "broker: tenant token is set (length-only check)"
  fi
  log "broker: starting on :${BROKER_PORT}"
  /usr/local/bin/broker &
  BROKER_PID=$!
else
  log "WARN: /usr/local/bin/broker not present; skipping."
  BROKER_PID=
fi

case "$MODE" in
  subscription)
    log "MODE=subscription; tenant uses official claude/codex CLIs via OAuth."
    log "Available binaries: $(command -v claude || echo 'claude MISSING') / $(command -v codex || echo 'codex MISSING')"
    # The broker is the only foreground process; wait -n so SIGTERM kills it.
    if [ -n "${BROKER_PID:-}" ]; then
      wait -n "$BROKER_PID"
    else
      exec tail -f /dev/null
    fi
    ;;
  byok)
    log "MODE=byok; starting OpenClaw gateway on ${OPENCLAW_BIND}:${OPENCLAW_PORT}."
    cd /app
    exec node /app/dist/index.js gateway --port "$OPENCLAW_PORT" --bind "$OPENCLAW_BIND" --allow-unconfigured
    ;;
  open-weights)
    log "MODE=open-weights; starting OpenClaw gateway on ${OPENCLAW_BIND}:${OPENCLAW_PORT}."
    log "Tenant should configure cerebras/chutes endpoint via env (e.g. CEREBRAS_BASE_URL)."
    cd /app
    exec node /app/dist/index.js gateway --port "$OPENCLAW_PORT" --bind "$OPENCLAW_BIND" --allow-unconfigured
    ;;
  *)
    log "ERROR: unknown MODE=${MODE}; expected one of: subscription, byok, open-weights"
    exit 64
    ;;
esac
