#!/usr/bin/env bash
# Build the per-tenant Rockielab / Pebble ML runtime image.
#
# Inputs (env vars, all optional):
#   PLATFORM_SKILLS_DIR   path to platform-skills checkout
#                         (default: ../platform-skills relative to this repo,
#                          fallback /Users/samuellarson/rocky/platform-skills)
#   IMAGE_TAG             image tag (default: rockielab-runtime-multitenant:dev)
#   OPENCLAW_EXTENSIONS   space-separated list of OpenClaw extensions to bundle
#                         (default: "anthropic codex cerebras chutes")
#
# Usage:
#   scripts/build-multitenant.sh
#   IMAGE_TAG=foo:bar scripts/build-multitenant.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE_TAG="${IMAGE_TAG:-rockielab-runtime-multitenant:dev}"
OPENCLAW_EXTENSIONS="${OPENCLAW_EXTENSIONS:-anthropic codex cerebras chutes}"

# Resolve platform-skills location.
if [ -n "${PLATFORM_SKILLS_DIR:-}" ]; then
  SKILLS_DIR="$PLATFORM_SKILLS_DIR"
elif [ -d "$REPO_ROOT/../platform-skills" ]; then
  SKILLS_DIR="$(cd "$REPO_ROOT/../platform-skills" && pwd)"
elif [ -d "/Users/samuellarson/rocky/platform-skills" ]; then
  SKILLS_DIR="/Users/samuellarson/rocky/platform-skills"
else
  echo "ERROR: Could not locate platform-skills." >&2
  echo "Set PLATFORM_SKILLS_DIR=/path/to/platform-skills and re-run." >&2
  exit 1
fi

if [ ! -d "$SKILLS_DIR/skills" ]; then
  echo "ERROR: $SKILLS_DIR does not look like platform-skills (no skills/ dir)" >&2
  exit 1
fi

echo "==> Building $IMAGE_TAG"
echo "    extensions       : $OPENCLAW_EXTENSIONS"
echo "    platform-skills  : $SKILLS_DIR"
echo "    Dockerfile       : Dockerfile.multitenant"
echo

# `--build-context skills=...` lets the skills assembly stage pull files
# directly from the platform-skills checkout without copying them into the
# main build context (which is the platform-runtime tree).
exec docker build \
  --file Dockerfile.multitenant \
  --tag "$IMAGE_TAG" \
  --build-context "skills=$SKILLS_DIR" \
  --build-arg "OPENCLAW_EXTENSIONS=$OPENCLAW_EXTENSIONS" \
  "$@" \
  .
