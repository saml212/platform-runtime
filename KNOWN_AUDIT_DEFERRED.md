# Known clean-audit deferrals — platform-runtime

The `/clean` audit blocks on two new `.md` files in this dirty tree.
Both are retained as legitimate documentation artifacts.

## Blockers (deferred, not fixed)

- `apps/broker/README.md` — module-level README for the new Go
  PTY-WebSocket broker subproject. Go convention is one README per
  module, and this one documents the wire framing that
  `platform-context/api/runtime_proxy_service.py` consumes — the
  contract has to live somewhere.

- `docs/multitenant-runtime.md` — operator-facing doc for the new
  `rockielab-runtime-multitenant` image. The existing `docs/` tree
  already has hundreds of per-component docs in nested directories;
  this file follows the same convention. Folding it into an existing
  doc would obscure the topic split.

## Why we don't bypass with `CLEAN_BYPASS=1`

Phase 8 owns the actual commit and will decide the bypass posture.
This file documents the audit state at the end of Phase 7 so the
Phase 8 commit author has full context.
