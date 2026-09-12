# ETHGlobal demo runbook

The demo is a conversation in an agentic terminal: Claude Code, Codex, or any MCP client. It needs no web UI. This runbook keeps what is live separate from what is fork-proven or in progress, so the demo never shows fake state.

## Setup

Connect the public MCP. It is prepare-only: it holds no signing key and cannot broadcast transactions.

```bash
claude mcp add --transport http aqua0 https://ethglobal-mcp.18-207-103-187.nip.io/mcp
```

- MCP health: `https://ethglobal-mcp.18-207-103-187.nip.io/health`
- Judge dashboard: `https://ethglobal-demo.18-207-103-187.nip.io/`
- Reverse-proxy pattern: [`deploy/aws/Caddyfile.mcp.example`](../deploy/aws/Caddyfile.mcp.example)

The public endpoint has been smoke-tested over HTTPS with `health`, `protocol_snapshot`, `list_opportunities`, `graph_query` and `prepare_create_strategy`. Today it reads the Arc subgraph from the team's self-hosted Graph Node. Moving it to a Subgraph Studio endpoint is in progress (see [`THE_GRAPH_TRACK.md`](THE_GRAPH_TRACK.md)).

## Step 1: Query Aqua0 state

> "What capital does Aqua0 have on Arc, and which strategies are running? Tell me which data came from The Graph."

Expected tools: `health`, `protocol_snapshot`, `list_opportunities`, and `get_balance` / `get_strategies` for an LP address. Optionally `graph_query` for a follow-up. **Status: Live.**

## Step 2: Create a USDC / Argentine peso strategy with FXSwap

> "Create a strategy on Arc pairing my USDC with ARGt using FXSwap."

| Part | Tooling | Status |
| --- | --- | --- |
| Derive the strategy key, check `classForStrategy`, prepare `registerStrategyClass` or per-vault `registerStrategy` calldata | `prepare_create_strategy` | Live (prepare-only) |
| Prepare USDC deposit and commitment calldata | `prepare_deposit`, `prepare_authorize_strategy` | Live (prepare-only) |
| Build the SwapVM program, sign the EIP-712 ship request, call `AquaAdapter.shipStrategyWithFee`, quote and swap | MCP SwapVM strategy tools | In progress |
| The same on-chain sequence end to end | `packages/contracts/script/run-arc-fx-strategies.sh` | Fork-proven; runs on Arc after admin wiring |
| FXSwap instruction in the program | `packages/contracts` | In progress. The fallback is `[FlatFeeAmountIn][PeggedSwap]` pinned at a configured FX price. |

<!-- TODO(coordinator): replace "MCP SwapVM strategy tools" with the exact tool names once they land in apps/mcp. -->

With the public endpoint the agent returns calldata, which the demo wallet signs. A local MCP started with `MCP_WRITE_MODE=execute` can send the guarded writes itself, on Arc Testnet or a local Anvil only.

## Step 3: Create a USDC / Brazilian real strategy with the same USDC

> "Now create a second strategy with the same USDC, paired with BRAt."

Same tooling and statuses as step 2. The USDC is **not** withdrawn or split. The same deposit is committed to a second class.

## Step 4: Query the balance again

> "Query my Aqua0 balance again. How much USDC backs each strategy?"

Expected answer: the same USDC principal backs both FX strategy classes in full.

| Evidence | Status |
| --- | --- |
| Arc fork: 2 USDC deposit committed to class 2 (USDC/ARGt) and class 3 (USDC/BRAt); 0.1 USDC → 139.25 ARGt and 0.1 USDC → 0.547 BRAt settled through the router and vault hooks; afterwards both classes still show 2 USDC committed backing | Fork-proven |
| Base fork: `./scripts/start-base-fork.sh` then `./scripts/test-shared-backing-fork.sh`. One 100 USDC principal shows 100 USDC `committedBacking` and `availableFor` on both classes | Fork-proven |
| The same read from The Graph on Arc, including AquaAdapter ship and fill events | In progress |

Closing line: *"One capital, Argentine pesos and Brazilian reais, both live, all from a terminal."* Use it live only once steps 2 to 4 have run on Arc Testnet. Until then, present the Arc-fork run as the proof.

## Fallbacks

- **FXSwap not ready:** run the same flow with the pegged/stable program (`FlatFeeAmountIn` opcode 21, `PeggedSwap` opcode 31). Say explicitly that this curve sits at a fixed price and does not track a moving FX rate.
- **Venue wiring not landed:** run `run-arc-fx-strategies.sh` with `MODE=fork` against a local fork of Arc and present it as fork-proven, not as an Arc transaction.
- **Show non-zero USDC on Arc through the existing core only:** `./scripts/prepare-arc-usdc-demo.sh` prints, but never sends, a USDC approval, a 1 USDC vault deposit, and a commitment to class 1. Sign them with the demo wallet, wait for indexing, then re-query.

## Close the loop

After any real transaction is mined:

> "Query The Graph again and explain what changed in Aqua0's vault and strategy state."

Natural-language request → typed tool → Arc → The Graph → natural-language explanation.
