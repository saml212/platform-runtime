#!/usr/bin/env bash
# Translate platform-skills/ into the on-disk layout the official `claude`
# (and `codex`) binaries expect: ~/.claude/skills/<name>/SKILL.md.
#
# Inputs:
#   $1  source  : path to a checkout of platform-skills
#   $2  dest    : destination home root (will populate <dest>/.claude/ and <dest>/.codex/)
#
# Layout decisions:
#   - skills/<name>/        → ~/.claude/skills/<name>/  (SKILL.md + assets land verbatim)
#   - hooks/                → ~/.claude/hooks/           (verbatim — claude reads via settings.json)
#   - memory/               → ~/.claude/platform-memory/ (off-spec but useful; init_db.sh runs at first start)
#   - templates/            → ~/.claude/platform-templates/
#   - scripts/              → ~/.claude/platform-scripts/
#
# Each skill that exposes a slash command (i.e. has SKILL.md whose YAML
# frontmatter declares a `name:`) gets a stub commands/<name>.md so
# `/<name>` works in the official CLI.

set -euo pipefail

SRC="${1:?source path required}"
DEST="${2:?destination path required}"

if [ ! -d "$SRC/skills" ]; then
  echo "ERROR: $SRC/skills/ does not exist; is this platform-skills?" >&2
  exit 1
fi

CLAUDE_HOME="$DEST/.claude"
CODEX_HOME="$DEST/.codex"

mkdir -p "$CLAUDE_HOME/skills" "$CLAUDE_HOME/commands" "$CLAUDE_HOME/hooks"
mkdir -p "$CODEX_HOME/skills" "$CODEX_HOME/commands"

# Copy each skill verbatim; if `cp -a` rejects perms (read-only mounts),
# fall back to a tar pipe.
for skill_dir in "$SRC"/skills/*/; do
  [ -d "$skill_dir" ] || continue
  name="$(basename "$skill_dir")"
  cp -a "$skill_dir" "$CLAUDE_HOME/skills/$name"
  cp -a "$skill_dir" "$CODEX_HOME/skills/$name"

  # Generate a commands/<name>.md stub that delegates to the skill.
  # This is the standard pattern Claude Code uses to expose a slash command.
  if [ -f "$skill_dir/SKILL.md" ]; then
    cat > "$CLAUDE_HOME/commands/$name.md" <<EOF
---
description: Run the $name skill from platform-skills.
---

Invoke the \`$name\` skill (see ~/.claude/skills/$name/SKILL.md) with the
arguments below.

\$ARGUMENTS
EOF
    cp "$CLAUDE_HOME/commands/$name.md" "$CODEX_HOME/commands/$name.md"
  fi
done

# Copy auxiliary trees that skills reach into.
for sub in hooks memory templates scripts docs; do
  if [ -d "$SRC/$sub" ]; then
    case "$sub" in
      hooks)
        cp -a "$SRC/$sub/." "$CLAUDE_HOME/hooks/"
        ;;
      *)
        mkdir -p "$CLAUDE_HOME/platform-$sub"
        cp -a "$SRC/$sub/." "$CLAUDE_HOME/platform-$sub/"
        ;;
    esac
  fi
done

echo "Skills assembled into $CLAUDE_HOME and $CODEX_HOME"
ls "$CLAUDE_HOME/skills" | sed 's/^/  skill: /'
