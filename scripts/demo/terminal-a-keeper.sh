#!/usr/bin/env bash
# Left terminal: the autonomous FX book keeper and its signals seller in one process.
# One line per tick: what woke it, signals bought, each book's spread and oracle age,
# who decided (gpt-5-nano or rules) and why, spreads before and after, and Arcscan links.
set -euo pipefail
. "$(dirname "$0")/env.sh"
exec node "$REPO/apps/cli/dist/index.js" keeper demo --interval "${KEEPER_INTERVAL:-60}" --poll "${KEEPER_POLL:-4}" "$@"
