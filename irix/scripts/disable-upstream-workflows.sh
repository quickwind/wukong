#!/usr/bin/env bash
# Disables the upstream workflows that cannot work in the fork (deploys to Cloudflare, Apple and
# Expo release signing, Docker, Nix hash updates, release-notes sync, desktop and Android builds).
# GitHub keeps the files, so upstream syncs never conflict over them. Re-enable one with
# `gh workflow enable <file>`.
#
# Usage: irix/scripts/disable-upstream-workflows.sh <owner/repo>
set -euo pipefail

repo="${1:?usage: disable-upstream-workflows.sh <owner/repo>}"

for workflow in \
  android-apk-release.yml \
  deploy-app.yml \
  deploy-relay.yml \
  deploy-website.yml \
  desktop-packages.yml \
  desktop-release.yml \
  desktop-rollout.yml \
  docker.yml \
  nix-update-hash.yml \
  nix.yml \
  release-notes-sync.yml; do
  echo "disable $workflow"
  gh workflow disable "$workflow" --repo "$repo"
done

echo "Left enabled: ci.yml (upstream's full test suite), irix-publish.yml, irix-sync-upstream.yml"
