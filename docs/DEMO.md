# ETHGlobal demo runbook

The demo is a conversation in an agentic terminal (Claude Code, Codex or any MCP client) and needs no web UI. This runbook keeps Live, Fork-proven and Deployed-awaiting-wiring work apart, so the demo never shows fake state. Agents can load [`skills/aqua0/SKILL.md`](../skills/aqua0/SKILL.md) for the tool map and safety rules.

| Part | Status |
| --- | --- |
| Pegged flow on Arc Testnet: deposit, two strategies on one USDC, one swap each, shared-backing read | **Live** |
| FXSwap venue on Arc (router, FXSwap AquaAdapter, ARS/USD and BRL/USD feeds) | **Deployed, awaiting wiring** |
| FXSwap flow through the MCP service path, including `set_fx_price` → `quote_swap` | **Fork-proven** |
| Graph reads from Subgraph Studio | **Live** (earlier schema; Aqua venue entities **Built, not yet deployed**) |
| Public MCP endpoint and dashboard | **Live** on the earlier 12-tool prepare-only build |

## Setup

### Local MCP (19 tools)

```bash
pnpm install && pnpm build
```

`~/.claude.json`-style or Codex-style config for a prepare-mode server:

```json
{
  "mcpServers": {
    "aqua0": {
      "command": "node",
      "args": ["<repo>/apps/mcp/dist/index.js"],
      "env": {
        "GRAPH_ENDPOINT": "https://api.studio.thegraph.com/query/1760183/aqua-0-ethglobal-arc-testnet/version/latest",
        "WRITE_RPC_URL": "https://rpc.testnet.arc.network",
        "WRITE_CHAIN_ID": "5042002",
        "MCP_WRITE_MODE": "prepare"
      }
    }
  }
}
```

Or from the command line:

```bash
claude mcp add aqua0 \
  -e GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/1760183/aqua-0-ethglobal-arc-testnet/version/latest \
  -e WRITE_RPC_URL=https://rpc.testnet.arc.network \
  -e WRITE_CHAIN_ID=5042002 \
  -e MCP_WRITE_MODE=prepare \
  -- node <repo>/apps/mcp/dist/index.js
```

The pegged venue, FXSwap venue and FX feed addresses default to the Arc deployment. Override `FXSWAP_ROUTER_ADDRESS`, `FXSWAP_AQUA_ADAPTER_ADDRESS`, `FX_ORACLE_ARS_USD` and `FX_ORACLE_BRL_USD` only for a fork.

**To transact live**, the presenter restarts the server with `MCP_WRITE_MODE=execute` and a throwaway `WRITE_PRIVATE_KEY` in the server's environment, never in the chat. The signer must:
- be an address without contract code (an EIP-7702-delegated address is rejected through ERC-1271);
- hold `OPERATOR_ROLE` on the AquaAdapter it ships through;
- own the feed, for `set_fx_price` to send.

### Public endpoint (read-only)

```bash
claude mcp add --transport http aqua0 https://ethglobal-mcp.18-207-103-187.nip.io/mcp
```

- MCP health: `https://ethglobal-mcp.18-207-103-187.nip.io/health`
- Judge dashboard: `https://ethglobal-demo.18-207-103-187.nip.io/`

It has 12 tools (reads and `prepare_*`), no signer, and no strategy, swap or FX tools until the hosted redeploy (**Planned**).

## Part 1: pegged flow, live on Arc Testnet

This is the flow the demo wallet `0xAFF7Da673820fAA38289de8B03984A9cf20fb02c` ran on 2026-09-12. It was driven through the `aqua0` CLI in execute mode, which uses the same service functions as the MCP tools. Hashes are in [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json) under `liveVenueRun`.

### Step 1: query state

> "What does Aqua0 hold on Arc, and what is my USDC backing? Tell me which data came from The Graph."

- **Tools:** `health`, `protocol_snapshot`, `get_balance` (The Graph, Subgraph Studio); `get_shared_backing` (on-chain reads).
- **Status:** **Live**.

Deposit once first: *"Deposit 2 USDC."* → `deposit {"token":"USDC","amount":"2"}` ([tx](https://testnet.arcscan.app/tx/0x088fb34b8147f936b7c10ac8066de4a59773f7d393f33eda64a4defeb8f6c6bd)).

### Step 2: USDC / Argentine peso strategy

> "Create a USDC to Argentine peso strategy with half a USDC."

`create_strategy {"pair":"USDC/ARS","params":{"usdcAmount":"0.5"}}` runs:
1. register the class;
2. register the vault legs;
3. fund the ARGt leg (open-mint demo token);
4. commit;
5. sign EIP-712;
6. call `AquaAdapter.shipStrategyWithFee`.

Until the FXSwap adapter is wired, the response carries an `opcodeNote` saying it used the pegged venue, a `[FlatFeeAmountIn 30 bps][PeggedSwap]` program at a fixed price. Say so out loud. The live run registered class 2, strategy `0x384f3266…3c3c` ([ship tx](https://testnet.arcscan.app/tx/0x97d5fea443f9090f6b9dd2432036bdfbc2ed58d636e8ac802742d2e499968471)). A re-run reports every step as skipped. **Live**.

### Step 3: USDC / Brazilian real strategy on the same USDC

> "Now the same USDC with Brazilian reais."

`create_strategy {"pair":"usdc to brl","params":{"usdcAmount":"0.5"}}` registers class 3, strategy `0x3fbcd975…716e`, and commits the **same** USDC deposit to it ([ship tx](https://testnet.arcscan.app/tx/0x7571eea087df535b0a4391a48d510abeb9ed0084cc3816946040c05214aa2293)). Nothing is withdrawn or split. **Live**.

### Step 4: swap and query again

> "Swap 0.1 USDC on each, then query my backing again."

| Call | Live result |
| --- | --- |
| `quote_swap` then `swap {"pair":"USDC/ARS","amount":"0.1"}` | 0.1 USDC → 138.912644 ARGt ([tx](https://testnet.arcscan.app/tx/0x24d95d61c83e3dfdf5ffa8530350635eb9c9b5f71b51835f31b98eb61c5102fb)) |
| `quote_swap` then `swap {"pair":"USDC/BRL","amount":"0.1"}` | 0.1 USDC → 0.545728 BRAt ([tx](https://testnet.arcscan.app/tx/0x811e5fd474e554e7a3330f09f34edb09f40ca50475028be89c4de3e6cfd32539)) |
| `get_shared_backing {"address":"0xAFF7Da673820fAA38289de8B03984A9cf20fb02c"}` | 2 USDC principal counted once; 2 USDC committed to class 2 and to class 3 |

`swap` enforces a minimum output on-chain (default 50 bps slippage). Both tools report the fixed price, execution price and effective spread.

Closing line: *"One capital, Argentine pesos and Brazilian reais, both live on Arc, all from a terminal."*

## Part 2: FXSwap flow, once the adapter is wired

The FXSwap venue is **Deployed, awaiting wiring** on Arc:
- router `0xb54AE15d2372F27718f32e9f6990330cdD3edaEB`;
- FXSwap AquaAdapter `0x8236cfFDD17D7b41F41c820f5E4b7DA6d5F243D5`;
- ARS/USD feed `0xc05A3Fb016f973C82b0232EF50336d4C0466E70C` at 1400;
- BRL/USD feed `0x1AE6542b9da89Ed2AEf00600710Bba75DbFF5e71` at 5.50;
- feed owner: the demo wallet.

The core admin must allowlist the adapter and grant it `VENUE_SETTLER_ROLE` on the three vaults (see [`ARC_DEPLOYMENT.md`](ARC_DEPLOYMENT.md#pending-wiring-for-the-fxswap-adapter)). Until then, run this part on a fork and present it as **Fork-proven**.

| # | Say | Tool call |
| --- | --- | --- |
| 1 | "What rates are the FX feeds on, and are they fresh?" | `get_fx_prices {}` |
| 2 | "Create a peso strategy that tracks the oracle." | `create_strategy {"pair":"USDC/ARS","opcode":"fxswap"}` |
| 3 | "Same USDC with reais." | `create_strategy {"pair":"usdc to brl","opcode":"fxswap"}` |
| 4 | "How many pesos for 0.1 USDC? Show the oracle price and spread." | `quote_swap {"pair":"USDC/ARS","amount":"0.1"}` |
| 5 | "Swap it." | `swap {"pair":"USDC/ARS","amount":"0.1"}` |
| 6 | "Push the ARS/USD price up 5% and quote again." | `set_fx_price {"pair":"ARS","changePercent":5}`, then `quote_swap {"pair":"USDC/ARS","amount":"0.1"}` |
| 7 | "Is my USDC still backing both?" | `get_shared_backing {}` |

At step 6, name the trust assumption: the feed is an owner-set demo oracle, and FXSwap strategies trade at whatever it says within their price band and staleness window.

Expected figures from the fork proof ([`scripts/test-arc-fork-fxswap.sh`](../scripts/test-arc-fork-fxswap.sh)):
- one 2 USDC deposit backs FXSwap USDC/ARS and USDC/BRL;
- 0.1 USDC → 139.462 ARGt at oracle 1400, with an effective spread of about 38 bps;
- the feed owner moves ARS/USD +5% and the quote rises 4.79%;
- a non-owner update is refused.

Strategy defaults: A 100, γ 0.1, fee 10 bps rising to 1% with imbalance, band 0.5x–2x, max feed age 7 days.

```bash
pnpm install && pnpm build
./scripts/test-arc-fork-fxswap.sh                    # fresh FX venue deployed on the fork
FX_VENUE=deployed ./scripts/test-arc-fork-fxswap.sh  # the real Arc FX contracts, on the fork
```

For a live conversation on the fork, start the fork the way the script does (`REUSE_ANVIL=1` keeps it up), then point a local execute-mode MCP at it with `WRITE_RPC_URL=http://127.0.0.1:8579`.

## Fallbacks

- **FXSwap adapter not wired:** use the pegged venue for the live part. Say explicitly that this curve sits at a fixed price and does not track a moving FX rate, and show FXSwap on the fork.
- **Arc RPC or execute key unavailable:** run [`scripts/test-arc-fork-strategies.sh`](../scripts/test-arc-fork-strategies.sh) and point at the recorded live hashes in [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json).
- **Public endpoint only:** use the read steps and `prepare_*` tools, and say that the strategy and swap tools run in the local build.

## Close the loop

After any real transaction is mined:

> "Query The Graph again and explain what changed in Aqua0's vault and strategy state."

Natural-language request → typed tool → Arc → The Graph → natural-language explanation. Until Studio serves the Aqua venue entities, the venue side of that explanation comes from `get_shared_backing`.
