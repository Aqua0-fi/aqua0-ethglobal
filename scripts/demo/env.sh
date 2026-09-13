# Sourced by the demo launchers: loads the demo environment from the gitignored .secrets folder. Never prints values.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for file in circle.env openai.env graph-gateway.env demo.env; do
  if [ ! -f "$REPO/.secrets/$file" ]; then
    echo "missing $REPO/.secrets/$file (see docs/DEMO.md)" >&2
    exit 1
  fi
done
set -a
. "$REPO/.secrets/circle.env"
. "$REPO/.secrets/openai.env"
. "$REPO/.secrets/graph-gateway.env"
. "$REPO/.secrets/demo.env"
set +a
if [ ! -f "$REPO/apps/cli/dist/index.js" ]; then
  echo "build first: pnpm install && pnpm build" >&2
  exit 1
fi
