#!/usr/bin/env bash
set -euo pipefail
PORT="${PORT:-9545}"
FORK_BLOCK="${FORK_BLOCK:-50918000}"
BASE_RPC_URL="${BASE_RPC_URL:-https://mainnet.base.org}"
exec anvil --fork-url "$BASE_RPC_URL" --fork-block-number "$FORK_BLOCK" --port "$PORT" --host 127.0.0.1
