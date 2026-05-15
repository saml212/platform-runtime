# overlay/

Everything in this directory is what makes `platform-runtime` *"Pebble
ML's OpenClaw"* rather than vanilla `openclaw/openclaw`.

**Hard rule:** nothing outside `overlay/` is modified. Upstream sync —
`git fetch upstream && git merge upstream/main` — must stay clean. Any
unavoidable patch to upstream code is documented in `PATCHES.md` with
rationale, and applied by a build step on top of upstream.

## Why an overlay

OpenClaw is upstream MIT-licensed software. We want:

- a kept-clean upstream sync surface (we can pull bugfixes without
  resolving conflicts in our adaptations every time),
- a single, fenced area where reviewers can audit what Pebble ML adds,
- a tenant-template that bootstraps a runtime instance with our
  platform-skills repo wired in by default.

## Layout

```
overlay/
├── README.md                        (this file)
├── PATCHES.md                       documents any patches into upstream code
├── config/
│   ├── default-skills-source.json   tells the runtime which skills repo + branch to mount
│   └── tenant-template/             scaffold for spinning up a fresh tenant
└── tenant/
    ├── start.sh                     one tenant-daemon up
    ├── stop.sh                      stop a tenant
    └── status.sh                    check a tenant
```

## Skill source pointer

`config/default-skills-source.json` is the single point of truth for
which `platform-skills` revision a tenant runs. The control plane writes
this file when provisioning a tenant; the runtime reads it on start.

```json
{
  "skills_repo": "saml212/platform-skills",
  "branch": "main",
  "fetch_strategy": "managed-hooks-symlink"
}
```

`fetch_strategy` is one of:

- `managed-hooks-symlink` — clone into `~/.openclaw/skills/`, then
  symlink each `hooks/handlers/rockie-*/` dir into `~/.openclaw/hooks/`
  (the managed-hook discovery dir).
- `bundled` — *(future)* package as a hook-pack npm and `openclaw plugins
  install` it. Not yet implemented.

## MCP-server registration paths

Where the `mcp-rockie` tools register with the host LLM depends on `MODE`:

- `MODE=subscription` — `claude` and `codex` binaries read
  `~/.claude/mcp.json` and `~/.codex/mcp.json` respectively. These are
  baked into the image at `Dockerfile.multitenant` (the layer that
  copies `overlay/multitenant/mcp-rockie/` and writes the two JSON
  files). No gateway involvement.
- `MODE=byok` and `MODE=open-weights` — the OpenClaw gateway reads
  the config at `$OPENCLAW_CONFIG_PATH`, which
  `overlay/multitenant/entrypoint.sh` renders at boot via `jq -n` into
  `/home/runtime/.openclaw/openclaw.json`. The rendered file mirrors
  the schema in `overlay/multitenant/openclaw.example.json`. The
  gateway's `--config` flag is NOT used — Commander doesn't declare
  it; only the env var works.
- Tenant flow (`overlay/tenant/start.sh`) — single-tenant single-user
  flow with its own template; out of scope for the multitenant render.

If `pnpm check:multitenant-byok-config` fails, the gateway has lost
its rendered config (likely a regression to `--allow-unconfigured`).

## Tenant scripts

`tenant/start.sh`, `tenant/stop.sh`, `tenant/status.sh` are the contract
the cloud control plane uses to lifecycle a tenant. They wrap
`openclaw gateway` with per-tenant config (port, workspace dir,
log dir) and ensure the platform-skills repo is mounted.

## Upstream sync ritual

```bash
cd platform-runtime
git fetch upstream
git merge upstream/main
# overlay/ untouched ⇒ no conflicts in this dir
# any conflict outside overlay/ ⇒ rationale to PATCHES.md, then resolve
```
