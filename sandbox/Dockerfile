# wa-orchestrator-sandbox — pi brain sandbox for the unified WhatsApp bot.
# Adds (vs the base spike image):
#   - jq (JSON filtering for bd --json output)
#   - hugo_extended 0.159.0 (EXACTLY the version used by website-draft's
#     .github/workflows/deploy.yml — the brain builds the site the same way
#     GitHub Pages does before pushing)
# Secret-free image: no ~/.pi/agent baked in. Provider config is provided at
# runtime by brain.js (org-b1g4.4 model).
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep jq wget \
  && rm -rf /var/lib/apt/lists/*

# beads CLI — pinned binary staged into the build context by build.sh
# (host ~/.local/bin/bd, x86-64 glibc, v1.3.0)
COPY bd /usr/local/bin/bd
RUN chmod +x /usr/local/bin/bd

# Custom provider extension package (native pi provider for the LLM gateway).
# Staged by build.sh from the provider package directory (includes node_modules).
COPY pi-provider-gd/ /opt/pi-provider-gd/

# pi coding agent (provides `pi`); docs recommend --ignore-scripts.
# Pinned to 1.2.0: matches the host pi release (verified RPC + gd provider behavior).
# 1.3.0 changed provider/config loading — do NOT float this.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.2.0

# Hugo — must track website-draft/.github/workflows/deploy.yml (HUGO_VERSION).
ARG HUGO_VERSION=0.159.0
RUN wget -qO /tmp/hugo.tar.gz "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-amd64.tar.gz" \
  && tar -xf /tmp/hugo.tar.gz -C /usr/local/bin hugo \
  && rm /tmp/hugo.tar.gz \
  && hugo version

# Run as uid 1000 (== host user) so files written into the MOUNTED
# repos (beads repo, site checkout) stay owned by the host user.
# The official node image ships a `node` user with exactly uid:gid 1000:1000.
ENV HOME=/home/node

WORKDIR /workspace
ENTRYPOINT ["pi"]
# NOTE: no provider packages are installed at runtime; /opt/pi-provider-gd is
# referenced by a local-path entry in the (host-generated) settings.json.
