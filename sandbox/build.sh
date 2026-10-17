#!/usr/bin/env bash
# Build the wa-orchestrator-sandbox image and verify pi + bd + hugo inside.
set -euo pipefail
cd "$(dirname "$0")"

BD_BIN="${BD_BIN:-$HOME/.local/bin/bd}"
IMAGE="${IMAGE:-wa-orchestrator-sandbox}"

# Stage the pinned bd binary into the build context (gitignored)
cp -f "$BD_BIN" ./bd
# Stage the gd provider package (gitignored)
rm -rf ./pi-provider-gd && cp -r "$HOME/code/pi-provider-gd" ./pi-provider-gd

docker build -t "$IMAGE" -f Dockerfile .

echo "=== in-container verification ==="
docker run --rm "$IMAGE" pi --version
docker run --rm --entrypoint bd "$IMAGE" --version
docker run --rm --entrypoint node "$IMAGE" --version
docker run --rm --entrypoint jq "$IMAGE" --version
docker run --rm --entrypoint hugo "$IMAGE" version
docker run --rm --entrypoint herdr "$IMAGE" --version
docker run --rm --entrypoint sh "$IMAGE" -c 'ls /opt/pi-subagents/index.js /opt/pi-herdr/src/index.ts'
