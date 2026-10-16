#!/bin/bash
# Manual run wrapper: headful Chromium under Xvfb (validated in spike org-72rw.1).
set -euo pipefail
cd "$(dirname "$0")"
exec xvfb-run -a /home/alx/.nvm/versions/node/v22.19.0/bin/node index.js
