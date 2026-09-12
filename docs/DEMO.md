# ETHGlobal demo runbook

The demo is a conversation in an agentic terminal (Claude Code, Codex or any MCP client) and needs no web UI. This runbook keeps Live, Fork-proven and not-yet-deployed work apart, so the demo never shows fake state.

## Setup

The SwapVM tools (`create_strategy`, `deposit`, `quote_swap`, `swap`, `get_shared_backing`) are in the local build.

> **Public endpoint:** `https://ethglobal-mcp.18-207-103-187.nip.io/mcp` is **Live** but still runs the earlier prepare-only build (12 tools, no signer) until it is redeployed. Use it for read-only steps. Use a local build for the full flow.

**Full flow (local).** To prove the whole flow end to end in one command, run the fork test. It forks Arc, wires the adapter on the fork only, runs every step below and asserts the result:

```bash
pnpm install && pnpm build
./scripts/test-arc-fork-strategies.sh
```

For a live conversation, run the same fork setup and point a local stdio MCP at the fork RPC with `MCP_WRITE_MODE=execute`. The signer must meet these conditions:
- it is a throwaway key for an address without contract code;
- it holds `OPERATOR_ROLE` on the adapter.

The fork test script shows how both are set up on a fork.

**Read-only (public).**

```bash
claude mcp add --transport http aqua0 https://ethglobal-mcp.18-207-103-187.nip.io/mcp
```

- MCP health: `https://ethglobal-mcp.18-207-103-187.nip.io/health`
- Judge dashboard: `https://ethglobal-demo.18-207-103-187.nip.io/`

## Step 1: Query state

> "What does Aqua0 hold on Arc, and what is my USDC backing? Tell me which data came from The Graph."

- **Tools:** `health`, `protocol_snapshot`, `get_balance`, `get_strategies` (The Graph), and `get_shared_backing` (on-chain reads).
- **Status:** **Live** for Graph reads. `get_shared_backing` is **Fork-proven**.

Before step 2, deposit once: *"Deposit 2 USDC."* This calls `deposit {"token":"USDC","amount":"2"}`.

## Step 2: Create a USDC / Argentine peso strategy

> "Create a USDC to Argentine peso strategy."

`create_strategy {"pair":"USDC/ARS"}` runs:
1. register the class;
2. register the vault legs;
3. fund the ARGt leg;
4. commit;
5. sign EIP-712;
6. call `AquaAdapter.shipStrategyWithFee`.

It is idempotent, so a re-run reports each step as skipped.

| Part | Status |
| --- | --- |
| Full `create_strategy` flow with `opcode:"pegged"` (`[FlatFeeAmountIn 30 bps][PeggedSwap]` at a fixed FX price) | **Fork-proven**; on Arc Testnet once the four wiring transactions land |
| `opcode:"fxswap"` | Refused until `FXSWAP_ROUTER_ADDRESS` is set. FXSwap is **Built, not yet deployed**. |

## Step 3: Create a USDC / Brazilian real strategy with the same USDC

> "Now the same USDC with Brazilian reais."

`create_strategy {"pair":"usdc to brl"}` registers a second class and commits the **same** USDC deposit to it. Nothing is withdrawn or split. **Fork-proven**.

## Step 4: Query again (and swap)

> "Swap 0.1 USDC on each, then query my backing again."

Tools: `quote_swap`, `swap` (enforces minimum output, default 50 bps slippage), `get_shared_backing`.

| Evidence | Status |
| --- | --- |
| Arc fork: 0.1 USDC → 139.248 ARGt and 0.1 USDC → 0.547 BRAt filled through the router and vault hooks; afterwards both classes still show 2 USDC committed backing | **Fork-proven** |
| Base fork: `./scripts/start-base-fork.sh` then `./scripts/test-shared-backing-fork.sh`. One 100 USDC principal shows 100 USDC `committedBacking` and `availableFor` on two classes. | **Fork-proven** |
| The same read from The Graph, via `AquaStrategy` and `AquaFill` entities | **Built, not yet deployed** |

Closing line: *"One capital, Argentine pesos and Brazilian reais, both live, all from a terminal."* Say "live" on Arc Testnet only once steps 2 to 4 have run there. Until then, present the Arc-fork run as fork-proven.

## Fallbacks

- **FXSwap not deployed:** use the default `opcode:"pegged"`. Say explicitly that this curve sits at a fixed price and does not track a moving FX rate.
- **Venue wiring not landed:** run on a local Arc fork (`scripts/test-arc-fork-strategies.sh`, or `run-arc-fx-strategies.sh` with `MODE=fork`) and present it as fork-proven, not as Arc transactions.
- **Show non-zero USDC on Arc through the live core only:** `./scripts/prepare-arc-usdc-demo.sh` prints, but never sends, a USDC approval, a 1 USDC vault deposit and a commitment to class 1. Sign them with the demo wallet, wait for indexing, then re-query.

## Close the loop

After any real transaction is mined:

> "Query The Graph again and explain what changed in Aqua0's vault and strategy state."

Natural-language request → typed tool → Arc → The Graph → natural-language explanation.
