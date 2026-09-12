#!/bin/sh
set -eu

# Deploy the Aqua0 subgraph to Subgraph Studio.
#
#   NETWORK=base (default)  -> packages/subgraph/subgraph.base.yaml  (Graph network: base)
#   NETWORK=arc             -> packages/subgraph/subgraph.arc.yaml   (Graph network: arc-testnet, chainId 5042002)
#
# For NETWORK=arc the manifest is regenerated first when PUBLIC_ARC_VAULT_FACTORY is set (see
# packages/subgraph/scripts/generate-arc-manifest.mjs); otherwise the committed subgraph.arc.yaml is used.
# DRY_RUN=1 runs codegen + build and prints the deploy command instead of deploying (no deploy key needed).

NETWORK=${NETWORK:-base}
DRY_RUN=${DRY_RUN:-0}
SHA=$(git rev-parse --short HEAD)

case "$NETWORK" in
  base)
    MANIFEST=subgraph.base.yaml
    GRAPH_NETWORK=base
    DEFAULT_LABEL="ethglobal-$SHA"
    ;;
  arc | arc-testnet)
    MANIFEST=subgraph.arc.yaml
    GRAPH_NETWORK=arc-testnet
    DEFAULT_LABEL="ethglobal-arc-$SHA"
    ;;
  *)
    echo "Unsupported NETWORK=$NETWORK (expected base or arc)" >&2
    exit 1
    ;;
esac

if [ "$DRY_RUN" = "1" ]; then
  GRAPH_STUDIO_SLUG=${GRAPH_STUDIO_SLUG:-<studio-slug>}
else
  : "${GRAPH_STUDIO_DEPLOY_KEY:?Set GRAPH_STUDIO_DEPLOY_KEY from Subgraph Studio}"
  : "${GRAPH_STUDIO_SLUG:?Set GRAPH_STUDIO_SLUG from Subgraph Studio}"
fi
VERSION_LABEL=${GRAPH_STUDIO_VERSION:-$DEFAULT_LABEL}

SUBGRAPH_DIR="$(cd "$(dirname "$0")/.." && pwd)/packages/subgraph"

if [ "$GRAPH_NETWORK" = "arc-testnet" ]; then
  if [ -n "${PUBLIC_ARC_VAULT_FACTORY:-}" ]; then
    pnpm --filter @aqua0/subgraph generate:arc
  else
    echo "PUBLIC_ARC_* not set; deploying the committed $MANIFEST."
  fi
fi

if ! grep -q "network: $GRAPH_NETWORK\$" "$SUBGRAPH_DIR/$MANIFEST"; then
  echo "$MANIFEST does not target Graph network $GRAPH_NETWORK" >&2
  exit 1
fi
if grep -v "network: $GRAPH_NETWORK\$" "$SUBGRAPH_DIR/$MANIFEST" | grep -q "network:"; then
  echo "$MANIFEST mixes Graph networks; expected only $GRAPH_NETWORK" >&2
  exit 1
fi

pnpm --filter @aqua0/subgraph exec graph codegen "$MANIFEST"
pnpm --filter @aqua0/subgraph exec graph build "$MANIFEST"

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY_RUN=1: built $MANIFEST for $GRAPH_NETWORK. Deploy with:"
  echo "  pnpm --filter @aqua0/subgraph exec graph deploy --deploy-key \"\$GRAPH_STUDIO_DEPLOY_KEY\" --version-label \"$VERSION_LABEL\" \"$GRAPH_STUDIO_SLUG\" $MANIFEST"
  exit 0
fi

pnpm --filter @aqua0/subgraph exec graph deploy \
  --deploy-key "$GRAPH_STUDIO_DEPLOY_KEY" \
  --version-label "$VERSION_LABEL" \
  "$GRAPH_STUDIO_SLUG" \
  "$MANIFEST"
