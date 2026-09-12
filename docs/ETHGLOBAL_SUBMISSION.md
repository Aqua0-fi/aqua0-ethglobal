# ETHGlobal submission copy

Aqua0 is registered in the **Continuity** track. The existing product is a cross-chain shared-liquidity layer; the work below is the Arc, 1inch and The Graph extension built during ETHOnline 2026. See [`CONTINUITY.md`](CONTINUITY.md) for the exact pre-existing/event-work split.

## How it's made

Aqua0 is a cross-chain shared-liquidity layer where an LP deposits an asset once and the same principal can back multiple trading strategies without splitting capital into separate pools. For ETHOnline Continuity, we brought that model to **Arc** and made the FX workflow agent-native.

On **Arc Testnet**, we deployed the Aqua0 vault core with native USDC as the shared quote asset, plus ARS and BRL demo-token vaults. The same USDC principal can back multiple FX strategies simultaneously, while real tokens only leave a vault just in time when a swap settles. We also wired Circle developer-controlled wallets and signed FX price data so the flow can be driven from an agentic terminal.

For **1inch**, we integrated the official **Aqua** and **SwapVM** contracts and built a dedicated `ForexCurve` SwapVM instruction (opcode 34) for FX. Aqua0's adapter ships the strategy into Aqua as virtual balances; maker hooks pull output from the AssetVault only when a fill happens and sweep the taker's input back into the vault. We have live USDC/ARS and USDC/BRL strategies and on-chain fills on Arc.

For **The Graph**, we built and deployed an Arc subgraph to Subgraph Studio that indexes Aqua0 deposits, LP commitments, strategy classes, deployed strategies, fills and fees across both Aqua venues. The Graph is the load-bearing read model for our MCP. Agents can ask for liquidity depth, backing, fees and opportunities, get swap quotes, prepare or create strategies, and reason over the indexed state instead of scraping RPC logs. `benchmark_fx_strategy` also composes the Aqua0 Arc subgraph with Messari standardized DEX subgraphs through The Graph Network gateway, so one agent query can compare an Aqua0 FX strategy against on-chain market depth across protocols and chains.

The result is an agent-facing liquidity and execution layer: an agent can inspect available liquidity, compare FX pricing, quote a swap and prepare the on-chain action. That makes workflows such as cross-border payment routing or service payments much smoother: the agent can discover the best available liquidity and move from intent to a verifiable on-chain quote without a human manually stitching together venues, indexers and wallets.

## Partner integrations

### Arc — Best DeFi or Agentic Application (Continuity)

- Arc Testnet is the live execution environment (`chainId 5042002`).
- Arc-native USDC is the shared quote asset and gas asset.
- The deployed MVP includes frontend, backend/MCP, architecture diagram, Circle developer-controlled wallet flows and live FX swaps.
- The extension is meaningful to the existing Aqua0 product: shared liquidity, FX strategies and agent-driven execution are now live on Arc.

Proof and addresses: [README: Arc prize tracks](../README.md#arc-best-defi--onchain-finance-application), [`ARC_TRACK.md`](ARC_TRACK.md), [`../deployments/arc-testnet.json`](../deployments/arc-testnet.json).

### 1inch — Build an Aqua App - Continuity Track

- Uses the official 1inch Aqua and SwapVM contracts.
- Adds a custom SwapVM instruction, `ForexCurve` opcode 34, designed for FX pricing with flat-band, inventory-fee and halt-band behaviour.
- Aqua0's AquaAdapter ships shared-backed strategies into Aqua and settles fills just in time from the vaults.
- Live Arc Testnet token transfers demonstrate the strategy end to end; fork tests cover the curve regimes that the small live demo does not reach.

Proof: [README: 1inch prize track](../README.md#1inch-build-an-aqua-app-and-continuity), [`../packages/contracts`](../packages/contracts), [`../scripts/test-arc-fork-forex.sh`](../scripts/test-arc-fork-forex.sh).

### The Graph — Best AI Tooling or AI Use Case with The Graph (Continuity)

- The Arc subgraph is deployed to Subgraph Studio and is the public MCP/dashboard read model.
- It indexes liquidity commitments and deployments as well as vault positions, strategies, fills and fees.
- The reusable MCP + agent skill lets Claude Code, Codex and other MCP clients reason over live Graph data, quote swaps and construct strategy actions.
- `benchmark_fx_strategy` uses The Graph Network gateway and a single Messari standardized schema to compare Aqua0 FX liquidity with DEX liquidity across protocols/chains, then returns a market verdict rather than a raw GraphQL dump.

Proof: [README: The Graph prize tracks](../README.md#the-graph-best-ai-tooling-or-ai-use-case), [`THE_GRAPH_TRACK.md`](THE_GRAPH_TRACK.md), [`../packages/subgraph`](../packages/subgraph), [`../apps/mcp`](../apps/mcp).

## Demo framing

The shortest partner story is:

1. **Arc:** one USDC principal on Arc backs both ARS and BRL FX strategies.
2. **1inch:** those strategies are real Aqua/SwapVM positions; the FX venue uses our new `ForexCurve` opcode and settles a live swap.
3. **The Graph:** the fill and shared backing appear in the Arc subgraph; an agent queries them through the MCP and can benchmark/quote the next action.

That gives one continuous demo instead of three disconnected sponsor integrations.
