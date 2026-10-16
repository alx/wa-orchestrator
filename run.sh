#!/bin/bash
# Manual run wrapper: headful Chromium under Xvfb (validated in spike org-72rw.1).
set -euo pipefail
cd "$(dirname "$0")"
# Node must be on PATH (this machine: nvm node). Wrapper is for manual runs only.
exec xvfb-run -a node index.js
