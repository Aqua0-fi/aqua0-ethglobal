#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(dirname "$SCRIPT_DIR")
SECRETS_FILE=${GRAPH_STUDIO_ENV_FILE:-"$ROOT_DIR/.secrets/graph-studio.env"}

if [ -f "$SECRETS_FILE" ]; then
  set -a
  . "$SECRETS_FILE"
  set +a
fi

: "${GRAPH_STUDIO_DEPLOY_KEY:?Set GRAPH_STUDIO_DEPLOY_KEY in .secrets/graph-studio.env or the environment}"
: "${GRAPH_STUDIO_SLUG:?Set GRAPH_STUDIO_SLUG in .secrets/graph-studio.env or the environment}"

cd "$ROOT_DIR"
VERSION_LABEL=${GRAPH_STUDIO_VERSION:-ethglobal-$(git rev-parse --short HEAD)}

pnpm --filter @aqua0/subgraph exec graph codegen subgraph.arc.yaml
pnpm --filter @aqua0/subgraph exec graph build subgraph.arc.yaml
pnpm --filter @aqua0/subgraph exec graph deploy \
  --deploy-key "$GRAPH_STUDIO_DEPLOY_KEY" \
  --version-label "$VERSION_LABEL" \
  "$GRAPH_STUDIO_SLUG" \
  subgraph.arc.yaml
