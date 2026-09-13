#!/usr/bin/env bash
# Right terminal: Claude Code with only the Aqua0 MCP, in execute mode as the demo Circle wallet.
# The MCP server is the published npm package, pinned to apps/mcp's version (what judges install).
# AQUA0_MCP_SOURCE=local runs the repo build instead (pnpm build first).
# Fast model, no user hooks or plugins, other MCP servers ignored, Aqua0 tools pre-approved.
# MODEL=opus scripts/demo/terminal-b-agent.sh for Opus (type /fast in the session for fast mode).
set -euo pipefail
. "$(dirname "$0")/env.sh"
export SIGNER=circle CIRCLE_WALLET_ID="$DEMO_CIRCLE_WALLET_ID" MCP_WRITE_MODE=execute
# Load the Aqua0 tools up front instead of through tool search: a few seconds faster per answer.
export ENABLE_TOOL_SEARCH="${ENABLE_TOOL_SEARCH:-false}"

# Run outside the repo so its project config is not loaded.
SESSION_DIR="${AQUA0_DEMO_DIR:-$HOME/.aqua0/demo-session}"
mkdir -p "$SESSION_DIR"
if [ "${AQUA0_MCP_SOURCE:-npm}" = "local" ]; then
  if [ ! -f "$REPO/apps/mcp/dist/index.js" ]; then
    echo "build first: pnpm install && pnpm build" >&2
    exit 1
  fi
  printf '{"mcpServers":{"aqua0":{"command":"node","args":["%s/apps/mcp/dist/index.js"]}}}\n' "$REPO" >"$SESSION_DIR/aqua0-mcp.json"
else
  VERSION="$(node -p "require('$REPO/apps/mcp/package.json').version")"
  printf '{"mcpServers":{"aqua0":{"command":"npx","args":["-y","@aqua0/mcp@%s"]}}}\n' "$VERSION" >"$SESSION_DIR/aqua0-mcp.json"
fi
cd "$SESSION_DIR"

# Presentation rules for the recording: tools first, short answers, bold figures, a status emoji.
DEMO_PROMPT="You are the Aqua0 agent in a recorded demo on Arc Testnet, connected to the aqua0 MCP server.
- Answer every question by calling the aqua0 tools straight away. Never say you lack internet or live data access: the tools are your live data.
- Keep answers short: one headline line, then at most four bullets or a small table. No preamble, no recap of the question.
- Bold the key figures: rates, spreads in bps, amounts, strategy classes.
- Start the headline with one status emoji: 🟢 healthy (spread near 30 bps), 🟡 tilted, 🔴 halted, stale or failed, 🔄 keeper rebalance, 💱 a quote or swap.
- Show transactions as Arcscan links.
- Focus on the forex curve strategies (USDC/ARS and USDC/BRL, SwapVM opcode 34). Do not bring up pegged strategies unless asked.
- USDC/BRL prices come from RedStone signed data; the USDC/ARS feed is a hand-set demo oracle. Mention the ARS caveat only when ARS comes up.
- Never print secrets or API keys."

exec claude \
  --model "${MODEL:-sonnet}" \
  --effort "${EFFORT:-low}" \
  --setting-sources project,local \
  --strict-mcp-config --mcp-config "$SESSION_DIR/aqua0-mcp.json" \
  --allowedTools "mcp__aqua0__*" \
  --append-system-prompt "$DEMO_PROMPT" \
  "$@"
