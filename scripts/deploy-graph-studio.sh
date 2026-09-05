#!/bin/sh
set -eu

: "${GRAPH_STUDIO_DEPLOY_KEY:?Set GRAPH_STUDIO_DEPLOY_KEY from Subgraph Studio}"
: "${GRAPH_STUDIO_SLUG:?Set GRAPH_STUDIO_SLUG from Subgraph Studio}"
VERSION_LABEL=${GRAPH_STUDIO_VERSION:-ethglobal-$(git rev-parse --short HEAD)}

pnpm --filter @aqua0/subgraph exec graph codegen subgraph.base.yaml
pnpm --filter @aqua0/subgraph exec graph build subgraph.base.yaml
pnpm --filter @aqua0/subgraph exec graph deploy \
  --deploy-key "$GRAPH_STUDIO_DEPLOY_KEY" \
  --version-label "$VERSION_LABEL" \
  "$GRAPH_STUDIO_SLUG" \
  subgraph.base.yaml
