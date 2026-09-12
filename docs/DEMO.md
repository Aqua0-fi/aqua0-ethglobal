# ETHGlobal demo runbook

The demo is a conversation in an agentic terminal (Claude Code, Codex or any MCP client) and needs no web UI. This runbook keeps Live, Fork-proven and Deployed-awaiting-wiring work apart, so the demo never shows fake state. Agents can load [`skills/aqua0/SKILL.md`](../skills/aqua0/SKILL.md) for the tool map and safety rules.

| Part | Status |
| --- | --- |
| Pegged flow on Arc Testnet: deposit, two strategies on one USDC, one swap each, shared-backing read | **Live** |
| RedStone BRL and MXNe price feeds on Arc, read with `get_fx_prices` | **Live** |
| Forex venue on Arc (`AquaForexSwapVMRouter` and its AquaAdapter, verified on Arcscan) | **Deployed, awaiting wiring** |
| Forex-curve flow through the MCP service path: USDC/BRL priced from RedStone, flat band, inventory fee and halt band, `set_fx_price` → `quote_swap` on ARS | **Fork-proven** |
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

The pegged venue, forex venue and FX feed addresses default to the Arc deployment. Override `FXSWAP_ROUTER_ADDRESS` and `FXSWAP_AQUA_ADAPTER_ADDRESS` (the forex router and adapter; the names are kept) and `FX_ORACLE_ARS_USD` only for a fork. Leave `FX_ORACLE_BRL_USD` unset so BRL prices from RedStone; setting it replaces RedStone with a hand-set BRL-per-USD feed.

**To transact live**, the presenter restarts the server with `MCP_WRITE_MODE=execute` and a throwaway `WRITE_PRIVATE_KEY` in the server's environment, never in the chat. The signer must:
- be an address without contract code (an EIP-7702-delegated address is rejected through ERC-1271);
- hold `OPERATOR_ROLE` on the AquaAdapter it ships through;
- own the ARS/USD feed, for `set_fx_price` to send.

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

Until the forex adapter is wired, the response carries an `opcodeNote` saying it used the pegged venue, a `[FlatFeeAmountIn 30 bps][PeggedSwap]` program at a fixed price. Say so out loud. The live run registered class 2, strategy `0x384f3266…3c3c` ([ship tx](https://testnet.arcscan.app/tx/0x97d5fea443f9090f6b9dd2432036bdfbc2ed58d636e8ac802742d2e499968471)). A re-run reports every step as skipped. **Live**.

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

### Step 5 (optional): the real BRL rate

> "What's the real BRL rate right now?"

`get_fx_prices {"pair":"BRL"}` shows the latest RedStone price signed by 3 of its 5 primary-prod signers (signing time, the three signer values, also as BRL per USD) and the value stored on-chain. The pegged strategy above sits at a fixed 5.5 BRL per USD whatever that rate does; forex strategies trade at the signed price (Part 2). **Live**.

## Part 2: forex-curve flow, once the adapter is wired

The forex venue is **Deployed, awaiting wiring** on Arc:
- `AquaForexSwapVMRouter` `0x0661435C2684Dcf62c547bA75a3300f928701E3d` (ForexCurve, opcode 34), verified on Arcscan;
- forex AquaAdapter `0x7b426DbbD15Aa6a62077feCb463B731a2bd8fE80`, verified on Arcscan, with `OPERATOR_ROLE` granted to the shared Circle operator;
- ARS/USD `ManualFxOracle` `0xc05A3Fb016f973C82b0232EF50336d4C0466E70C` at 1400, owned by the demo wallet;
- RedStone BRL feed `0xac4D10eE7FF790c2E505fBBD6A72d15D7Cbc1796` (USD per 1 BRL), **Live**, updated only from signed RedStone prices.

The core admin must allowlist the adapter and grant it `VENUE_SETTLER_ROLE` on the three vaults (see [`ARC_DEPLOYMENT.md`](ARC_DEPLOYMENT.md#pending-wiring-for-the-forex-adapter)). Until then, run this part on a fork and present it as **Fork-proven**. Step 1 also works live on Arc.

| # | Say | Tool call |
| --- | --- | --- |
| 1 | "What's the real BRL rate right now?" | `get_fx_prices {"pair":"BRL"}` |
| 2 | "Create a peso strategy that tracks the oracle." | `create_strategy {"pair":"USDC/ARS","opcode":"forex"}` |
| 3 | "Same USDC with reais, at the real rate." | `create_strategy {"pair":"usdc to brl","opcode":"forex"}` |
| 4 | "How many reais for 0.1 USDC right now?" | `quote_swap {"pair":"USDC/BRL","amount":"0.1"}` |
| 5 | "Swap it." | `swap {"pair":"USDC/BRL","amount":"0.1"}` |
| 6 | "How many pesos for 0.1 USDC? Show the oracle price and spread." | `quote_swap {"pair":"USDC/ARS","amount":"0.1"}` |
| 7 | "And for 0.3 USDC? And 0.8?" | `quote_swap {"pair":"USDC/ARS","amount":"0.3"}`, then `quote_swap {"pair":"USDC/ARS","amount":"0.8"}` |
| 8 | "Push the ARS/USD price up 5% and quote again." | `set_fx_price {"pair":"ARS","changePercent":5}`, then `quote_swap {"pair":"USDC/ARS","amount":"0.1"}` |
| 9 | "Is my USDC still backing both?" | `get_shared_backing {}` |

At steps 3 to 5, say where the BRL price comes from. `create_strategy` sizes the BRL leg from the live RedStone price. The feed quotes USD per BRL, which is already the curve's USDC-per-BRL price, so the invert-price flag stays off. `quote_swap` applies the latest signed payload as an `eth_call` state override and sends nothing. `swap` first pushes that payload on-chain (about 130k gas), because there is no keeper. BRL is never set by hand.

At steps 6 and 7, explain the curve. Each strategy ships 1 USDC plus its value in FX, so the book starts at an even split. While each balance stays within 15% of its ideal (half the book's value), the price is the oracle less the 30 bps fee. Past that flat band an inventory fee grows with the imbalance, capped at 25%, and 30% of it goes back to trades that rebalance the book. A trade that would leave a balance more than 50% from its ideal reverts: that is the halt band, and the 0.8 USDC quote hits it.

At step 8, name the trust assumption: the ARS feed is an owner-set demo oracle, because RedStone has no ARS feed. Forex strategies trade at whatever their feed says within their price band and staleness window.

Expected results from the fork proof ([`scripts/test-arc-fork-forex.sh`](../scripts/test-arc-fork-forex.sh)):
- one 2 USDC deposit backs forex USDC/ARS and USDC/BRL;
- inside the flat band a swap costs 30 bps;
- a trade past the flat band paid 666 bps, the inventory fee;
- a trade past the halt band reverts with `ForexCurveUpperHalt()`;
- the feed owner moves ARS/USD +5% and the quote moves by exactly 5%;
- USDC/BRL: `swap` pushes a signed RedStone BRL price, then fills at its quote;
- quotes agree with the reference `scripts/fxforex_math.py` to about 1e-16.

The live BRL rate moves, so a new run gives slightly different BRL figures.

Strategy defaults: `α` 0.5 (halt band), `β` 0.15 (flat band), `δ` 0.5 (fee slope), `maxFee` 0.25, `λ` 0.3 (rebate share), fee `ε` 30 bps. ARS: band half to double 1400 ARS per USD, max feed age 7 days. BRL: band 0.0909–0.3636 USD per BRL, max feed age 1 hour.

```bash
pnpm install && pnpm build
./scripts/test-arc-fork-forex.sh   # deploys the forex venue on an Arc fork and runs the flow
```

For a live conversation on the fork, start `anvil --fork-url https://rpc.testnet.arc.network --port 8580` yourself and run the script with `REUSE_ANVIL=1`, so the fork stays up. Then point a local execute-mode MCP at `WRITE_RPC_URL=http://127.0.0.1:8580`, with `FXSWAP_ROUTER_ADDRESS` and `FXSWAP_AQUA_ADAPTER_ADDRESS` set to the router and adapter the script prints.

## Fallbacks

- **Forex adapter not wired:** use the pegged venue for the live part. Say explicitly that this curve sits at a fixed price and does not track a moving FX rate, and show the forex curve on the fork.
- **Arc RPC or execute key unavailable:** run [`scripts/test-arc-fork-strategies.sh`](../scripts/test-arc-fork-strategies.sh) and point at the recorded live hashes in [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json).
- **Public endpoint only:** use the read steps and `prepare_*` tools, and say that the strategy and swap tools run in the local build.

## Close the loop

After any real transaction is mined:

> "Query The Graph again and explain what changed in Aqua0's vault and strategy state."

Natural-language request → typed tool → Arc → The Graph → natural-language explanation. Until Studio serves the Aqua venue entities, the venue side of that explanation comes from `get_shared_backing`.
