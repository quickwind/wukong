#!/usr/bin/env bash
# Builds the web UI with the Irix brand into <out-dir> and leaves the working tree as it was.
# For trying Irix locally without publishing; point the daemon at the result with
# `features.webUi.distDir` in its config.json.
#
# Usage: irix/scripts/build-branded-ui.sh <out-dir>
set -euo pipefail

out="${1:?usage: build-branded-ui.sh <out-dir>}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has changes; commit or stash them first (the brand is applied in place and reverted afterwards)." >&2
  exit 1
fi

# The brand rewrites tracked files and adds one new file under icons/; put both back.
trap 'git checkout -q -- . && git clean -fdq packages/app/src/components/icons' EXIT

node irix/scripts/brand.mjs
EXPO_PUBLIC_IRIX=1 npm run build:web --workspace=@getpaseo/app

rm -rf "$out"
mkdir -p "$out"
cp -R packages/app/dist/. "$out"
echo "Branded web UI written to $out"
