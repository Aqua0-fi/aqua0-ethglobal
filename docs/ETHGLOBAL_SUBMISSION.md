# ETHGlobal submission copy

Aqua0 is registered in the **Continuity** track. The existing product is a cross-chain shared-liquidity layer; the work below is the Arc, 1inch and The Graph extension built during ETHOnline 2026. See [`CONTINUITY.md`](CONTINUITY.md) for the exact split between pre-existing work and event work.

## How it's made

Aqua0 is a cross-chain shared-liquidity layer: an LP deposits an asset once, and the same principal backs several trading strategies without splitting capital into separate pools. For ETHOnline Continuity, we brought that model to **Arc** and made the FX workflow agent-native.

On **Arc Testnet**, we deployed the Aqua0 vault core with native USDC as the shared quote asset, plus ARS and BRL demo-token vaults. The same USDC principal backs several FX strategies at once, and real tokens leave a vault only when a swap settles, just in time. Users sign in with Privy and trade through Circle developer-controlled wallets, and FX prices come from RedStone signed market data pushed on-chain before each swap.

For **1inch**, we integrated the official **Aqua** and **SwapVM** contracts and built a new `ForexCurve` SwapVM instruction (opcode 34) for FX: the oracle price inside a flat band, an inventory fee past it, and a halt band. Aqua0's adapter ships each strategy into Aqua as virtual balances; its maker hooks pull the output from the AssetVault only when a fill happens and sweep the taker's input back into the vault. Live USDC/ARS and USDC/BRL strategies fill on Arc.

We also built an **autonomous FX book keeper**. It holds its own Circle developer-controlled wallet, wakes when a swap tilts a forex book, buys oracle and book signals per call with **Circle Nanopayments** (x402, batched by Circle Gateway on Arc Testnet), and lets OpenAI `gpt-5-nano` choose an action inside limits enforced in code, with a rules policy as fallback. It rebalances the book from its own wallet, is funded with **App Kit** `send`, and has an **ERC-8004** identity (agent 894559) that receives reputation feedback after each rebalance. In the live run a 0.1 USDC swap tilted USDC/BRL to 265.53 bps, and the keeper brought it back to 29.99 bps with no human in the loop.

For **The Graph**, we built and deployed an Arc subgraph to Subgraph Studio that indexes Aqua0 deposits, LP commitments, strategy classes, deployed strategies, fills and fees across both Aqua venues. It is the load-bearing read model for our MCP server: agents ask for liquidity, backing, fees and opportunities, get swap quotes, and prepare or create strategies from indexed state instead of scraping RPC logs. `benchmark_fx_strategy` composes the Aqua0 subgraph with Messari standardized DEX subgraphs through The Graph Network gateway, so one agent query compares an Aqua0 FX strategy with onchain market depth across protocols and chains. The MCP server installs in one step, as a Claude Code plugin or with `npx -y @aqua0/mcp`.

The result is an agent-facing liquidity and execution layer. An agent can inspect liquidity, compare FX pricing, quote a swap and prepare or send the on-chain action, while a second agent keeps the books healthy. That makes workflows such as cross-border payment routing smoother: an agent moves from intent to a verifiable on-chain quote without a human stitching together venues, indexers and wallets.

## Partner integrations

### Arc: Best DeFi or Agentic Application (Continuity)

- Arc Testnet is the live execution environment (chain id `5042002`), and Arc-native USDC is the shared quote and gas asset.
- The MVP has a frontend (judge dashboard), a backend (MCP server and service), an architecture diagram, Circle developer-controlled wallet flows with Privy sign-in, and live FX swaps.
- An autonomous FX book keeper transacts on Arc from its own Circle wallet: it pays per signal with Circle Nanopayments, is funded with App Kit, holds an ERC-8004 identity, and decides with OpenAI `gpt-5-nano` inside limits enforced in code.
- The extension is meaningful to the existing Aqua0 product: shared liquidity, FX strategies and agent-driven execution now run on Arc.

Proof and addresses: [README: Arc prize tracks](../README.md#arc-best-defi--onchain-finance-application), [`ARC_TRACK.md`](ARC_TRACK.md), [`../deployments/arc-testnet.json`](../deployments/arc-testnet.json), `keeperRun` in [`../deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json).

### 1inch: Build an Aqua App, Continuity Track

- Uses the official 1inch Aqua and SwapVM contracts.
- Adds a custom SwapVM instruction, `ForexCurve` opcode 34, for FX pricing with flat-band, inventory-fee and halt-band behaviour, matching 979 reference vectors within a few wei.
- Aqua0's AquaAdapter ships shared-backed strategies into Aqua and settles fills just in time from the vaults.
- Live Arc Testnet token transfers show the strategy end to end; fork tests cover the curve regimes that small live swaps do not reach.

Proof: [README: 1inch prize track](../README.md#1inch-build-an-aqua-app-and-continuity), [`../packages/contracts`](../packages/contracts), [`../scripts/test-arc-fork-forex.sh`](../scripts/test-arc-fork-forex.sh).

### The Graph: Best AI Tooling or AI Use Case with The Graph (Continuity)

- The Arc subgraph is deployed to Subgraph Studio and is the read model for the hosted MCP server and dashboard.
- It indexes liquidity commitments and deployments as well as vault positions, strategies, fills and fees.
- The reusable MCP server and agent skill let Claude Code, Codex and other MCP clients reason over live Graph data, quote swaps and build strategy actions. Install it as a Claude Code plugin (`/plugin marketplace add Aqua0-fi/aqua0-ethglobal`, then `/plugin install aqua0@aqua0`) or from npm (`claude mcp add aqua0 -- npx -y @aqua0/mcp`).
- `benchmark_fx_strategy` uses The Graph Network gateway and one Messari standardized schema to compare Aqua0 FX liquidity with DEX liquidity across protocols and chains, and returns a market verdict rather than a raw GraphQL dump.

Proof: [README: The Graph prize tracks](../README.md#the-graph-best-ai-tooling-or-ai-use-case), [`THE_GRAPH_TRACK.md`](THE_GRAPH_TRACK.md), [`../packages/subgraph`](../packages/subgraph), [`../apps/mcp`](../apps/mcp).

## Demo framing

The shortest partner story:

1. **Arc:** one USDC principal on Arc backs both ARS and BRL FX strategies, traded through Circle wallets.
2. **1inch:** those strategies are real Aqua and SwapVM positions on our new `ForexCurve` opcode, and a live swap settles through the vaults.
3. **The Graph:** the fill and shared backing appear in the Arc subgraph; an agent queries them through the MCP server and benchmarks the next action.
4. **Agentic Arc:** the swap tilts the book, and the keeper pays for a signal, decides and rebalances on its own.

That is one continuous demo instead of disconnected sponsor integrations. Aqua0 runs on Arc Testnet; it is not deployed to Arc Mainnet.
