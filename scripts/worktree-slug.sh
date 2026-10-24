#!/usr/bin/env bash
# Emit a DNS-label-safe slug for the current git worktree.
#
# Rule (Worktree Isolation): the current git branch name,
# lowercased, non-[a-z0-9] runs collapsed to a single hyphen, leading and
# trailing hyphens stripped, truncated to 63 chars. The branch is the stable
# per-worktree identity; the worktree-root basename is the fallback for a
# detached HEAD (no branch to name the stack after).
#
# A non-empty ROME_DEV_SLUG replaces the branch, under the same rule. It suits a
# developer who works in one checkout and switches branches in it: the stack,
# its data, and its <slug>.rome.localhost address stay the same across
# branches.
#
# Consumers:
#   - scripts/dev-up.sh  → Compose project name + Traefik subdomain.
#   - ./r                → locates the running Rome container.
# Keep the output identical across callers.
set -euo pipefail

branch="${ROME_DEV_SLUG:-}"
# `--show-current` is empty on a detached HEAD; fall back to the worktree dir.
if [ -z "$branch" ]; then
  branch="$(git branch --show-current)"
fi
if [ -z "$branch" ]; then
  branch="$(basename "$(git rev-parse --show-toplevel)")"
fi

printf '%s' "$branch" |
  tr '[:upper:]' '[:lower:]' |
  sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' |
  cut -c1-63
