# ETHGlobal submission copy

Aqua0 is registered in the **Continuity** track. The existing product is a cross-chain shared-liquidity layer; the work below is the Arc, 1inch and The Graph extension built during ETHOnline 2026.

This page is the single reference for the submission portal and the pitch deck: links first, then portal-ready text for each prize, each pointing at its proof.

## Links

| What | Link |
| --- | --- |
| Repository | https://github.com/Aqua0-fi/aqua0-ethglobal |
| Demo video | Added at submission |
| Judge dashboard | https://ethglobal-demo.18-207-103-187.nip.io/ |
| Hosted MCP server (prepare-only) | https://ethglobal-mcp.18-207-103-187.nip.io/mcp |
| npm package | https://www.npmjs.com/package/@aqua0/mcp (`claude mcp add aqua0 -- npx -y @aqua0/mcp`) |
| Claude Code plugin | `/plugin marketplace add Aqua0-fi/aqua0-ethglobal`, then `/plugin install aqua0@aqua0` |
| Aqua0 subgraph on Subgraph Studio | https://thegraph.com/studio/subgraph/aqua-0-ethglobal-arc-testnet |
| Arc Testnet explorer | https://testnet.arcscan.app |

## Proof files

Everything below points into these places; nothing else is needed.

| File | What it holds |
| --- | --- |
| [`README.md`](../README.md) | How it works, the architecture diagram, and proof for each prize under [Prize tracks](../README.md#prize-tracks) |
| [`docs/FX_OPCODE_HANDOFF.md`](FX_OPCODE_HANDOFF.md) | Pitch context: the problem, the solution, how it works and the forex curve maths, with proof points |
| [`docs/CONTINUITY.md`](CONTINUITY.md) | What pre-existed and what was built during the event |
| [`docs/DEMO.md`](DEMO.md) | The demo runbook, including the two-session keeper demo |
| [`deployments/`](../deployments) | Addresses and transactions: `arc-testnet.json` (contracts), `arc-testnet-strategies.json` (live runs, with the keeper run as `keeperRun`) |

## On-chain proof

All on Arc Testnet (chain id `5042002`).

| Proof | Arcscan |
| --- | --- |
| `AquaForexSwapVMRouter` with the new `ForexCurve` instruction (opcode 34) | [`0x475d0E48…4187e`](https://testnet.arcscan.app/address/0x475d0E487779743Fb52c8E7729A1718934D4187e) |
| Official 1inch Aqua (`AquaRouter`) and `AquaSwapVMRouter` | [`0x490d2ece…20D4`](https://testnet.arcscan.app/address/0x490d2eceD9aCF99e1db6090f820775bFa70020D4), [`0xb20bc70b…F763`](https://testnet.arcscan.app/address/0xb20bc70b485eC1352C190d26fCaB1959d219F763) |
| Forex fill, USDC to ARGt | [`0x54f61cb5…7554`](https://testnet.arcscan.app/tx/0x54f61cb5ddbeea9ea6cdeef75346aba69fe08c9f59f1d2f0eea4dd89e3ef7554) |
| Forex fill, USDC to BRAt | [`0xe28f4014…172a`](https://testnet.arcscan.app/tx/0xe28f401465a86dd8557ddd8de548366b0ad5e1fe20db74f71e56cd4a6bcc172a) |
| Pegged fill, USDC to ARGt | [`0x24d95d61…02fb`](https://testnet.arcscan.app/tx/0x24d95d61c83e3dfdf5ffa8530350635eb9c9b5f71b51835f31b98eb61c5102fb) |
| Swap that tilted the USDC/BRL book to 265.53 bps | [`0xa1ed7419…0e1c`](https://testnet.arcscan.app/tx/0xa1ed7419b56c1888ce80b60af125579e82877d247f38dcd366cacc61d3b80e1c) |
| Keeper rebalance back to 29.99 bps, from its own Circle wallet | [`0xa3a786f8…65e4`](https://testnet.arcscan.app/tx/0xa3a786f86937bb03ab6f5bc6dbb5745b7f22ab3cbf03a8dca164362a4ea165e4) |
| Keeper funded with App Kit `send` | [`0x3fdc1d70…b3d0`](https://testnet.arcscan.app/tx/0x3fdc1d70e7aee510d345b1d168cdf635d136b33d0a80a64530f231e8f643b3d0) |
| Keeper ERC-8004 registration (agent 894559) and reputation feedback | [`0x149d5e54…97ff`](https://testnet.arcscan.app/tx/0x149d5e54c40c5d48bc912383cf341525dea93e84df7f905c6e58a2cbe03797ff), [`0x76f1b72b…57c2`](https://testnet.arcscan.app/tx/0x76f1b72bde3dedea7ab054ed60cfb30208902c033a7f38287aa8735299c657c2) |

Nanopayments settle in Circle Gateway batches rather than one transaction per call; their settlement ids are under `keeperRun.nanopayments` in `deployments/arc-testnet-strategies.json`.

## How it's made

Aqua0 is a cross-chain shared-liquidity layer: an LP deposits an asset once, and the same principal backs several trading strategies without splitting capital into separate pools. For ETHOnline Continuity, we brought that model to **Arc** and made the FX workflow agent-native.

On **Arc Testnet**, we deployed the Aqua0 vault core with native USDC as the shared quote asset, plus ARS and BRL demo-token vaults. The same USDC principal backs several FX strategies at once, and real tokens leave a vault only when a swap settles, just in time. Users sign in with Privy and trade through Circle developer-controlled wallets, and FX prices come from RedStone signed market data pushed on-chain before each swap.

For **1inch**, we integrated the official **Aqua** and **SwapVM** contracts and built a new `ForexCurve` SwapVM instruction (opcode 34) for FX: the oracle price inside a flat band, an inventory fee past it, and a halt band. Aqua0's adapter ships each strategy into Aqua as virtual balances; its maker hooks pull the output from the AssetVault only when a fill happens and sweep the taker's input back into the vault. Live USDC/ARS and USDC/BRL strategies fill on Arc.

We also built an **autonomous FX book keeper**. It holds its own Circle developer-controlled wallet, wakes when a swap tilts a forex book, buys oracle and book signals per call with **Circle Nanopayments** (x402, batched by Circle Gateway on Arc Testnet), and lets OpenAI `gpt-5-nano` choose an action inside limits enforced in code, with a rules policy as fallback. It rebalances the book from its own wallet, is funded with **App Kit** `send`, and has an **ERC-8004** identity (agent 894559) that receives reputation feedback after each rebalance. In the live run a 0.1 USDC swap tilted USDC/BRL to 265.53 bps, and the keeper brought it back to 29.99 bps with no human in the loop.

For **The Graph**, we built and deployed an Arc subgraph to Subgraph Studio that indexes Aqua0 deposits, LP commitments, strategy classes, deployed strategies, fills and fees across both Aqua venues. It is the load-bearing read model for our MCP server: agents ask for liquidity, backing, fees and opportunities, get swap quotes, and prepare or create strategies from indexed state instead of scraping RPC logs. `benchmark_fx_strategy` composes the Aqua0 subgraph with Messari standardized DEX subgraphs through The Graph Network gateway, so one agent query compares an Aqua0 FX strategy with onchain market depth across protocols and chains. The MCP server installs in one step, as a Claude Code plugin or with `npx -y @aqua0/mcp`.

The result is an agent-facing liquidity and execution layer. An agent can inspect liquidity, compare FX pricing, quote a swap and prepare or send the on-chain action, while a second agent keeps the books healthy. That makes workflows such as cross-border payment routing smoother: an agent moves from intent to a verifiable on-chain quote without a human stitching together venues, indexers and wallets.

## Partner integrations

Every Arc prize also needs a video demo, which is added at submission. Aqua0 runs on Arc Testnet and is not deployed to Arc Mainnet, which the mainnet-conditional share of each Arc prize requires by September 30.

### Arc: Best DeFi / Onchain Finance Application

- Stablecoin-native FX liquidity: Arc's native USDC is the shared quote asset, and one USDC balance makes markets in several local currencies. Principal, fees and gas are all USDC.
- Multi-step atomic settlement: one swap runs the maker program, pulls the output from the vault just in time, pushes the taker's input into Aqua, sweeps it into the counter vault and credits the LPs that sold.
- Conditional fills: the forex curve refuses a stale or out-of-band oracle price and reverts a swap that would push the book past its halt band.
- Real FX market data: RedStone BRL and MXNe feeds on Arc accept only prices signed by 3 of RedStone's 5 primary-prod signers. USDC/ARS uses a hand-set feed because RedStone has no ARS feed.
- Circle Wallets: a user signs in with Privy and trades through a Circle developer-controlled wallet; a shared Circle operator wallet sends the strategies users sign.
- A working MVP: the judge dashboard (frontend), a Node API and the MCP server (backend), and an architecture diagram in the README.

Proof: [README: Arc DeFi](../README.md#arc-best-defi--onchain-finance-application), with the fills and addresses in [On-chain proof](#on-chain-proof).

### Arc: Best Agentic Economy Application with Circle Agent Stack

- An autonomous agent that transacts: the FX book keeper rebalances a tilted book from its own Circle wallet with no human in the loop (265.53 bps back to 29.99 bps in the live run).
- Decisions tied to real signals: book tilt and oracle age from the router and feeds, balances from the chain. `gpt-5-nano` chooses from a closed set of actions; budget, trade size, cooldown, allowed actions and spend caps are enforced in code, with a rules policy as fallback.
- Nanopayments: the keeper pays per signal ($0.0005 to $0.001) through Circle Gateway batched x402 on Arc Testnet, signed by its Circle developer-controlled wallet.
- Circle Wallets and App Kit: the keeper, the demo user and the operator are Circle developer-controlled wallets; App Kit `send` funded the keeper and handles its capped top-ups.
- ERC-8004: the keeper is agent 894559, and the operator records reputation feedback after each rebalance.
- Not used: the Agent Stack starter kits, and Paymaster, which is not on Arc. The keeper and its signals seller run locally.

Proof: [README: Arc Agentic](../README.md#arc-best-agentic-economy-application-with-circle-agent-stack), `keeperRun` in [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json), and the two-session demo in [`DEMO.md`](DEMO.md#two-session-demo-autonomous-keeper).

### Arc: Best DeFi or Agentic Application (Continuity)

- Arc Testnet is the live execution environment (chain id `5042002`), and Arc-native USDC is the shared quote and gas asset.
- The MVP has a frontend (judge dashboard), a backend (MCP server and service), an architecture diagram, Circle developer-controlled wallet flows with Privy sign-in, and live FX swaps.
- An autonomous FX book keeper transacts on Arc from its own Circle wallet: it pays per signal with Circle Nanopayments, is funded with App Kit, holds an ERC-8004 identity, and decides with OpenAI `gpt-5-nano` inside limits enforced in code.
- The extension is meaningful to the existing Aqua0 product: shared liquidity, FX strategies and agent-driven execution now run on Arc. The Aqua0 vault contracts and AquaAdapter pre-exist; the rest was built during the event.

Proof: [README: Arc Continuity](../README.md#arc-best-defi-or-agentic-application-continuity) and [`CONTINUITY.md`](CONTINUITY.md).

### 1inch: Build an Aqua App (and Continuity)

- Uses the official 1inch Aqua (aqua 0.1.0) and SwapVM (swap-vm v1.0.2) contracts, built from unmodified upstream source.
- Adds a custom SwapVM instruction, `ForexCurve` opcode 34, for FX pricing with flat-band, inventory-fee and halt-band behaviour, matching all 979 reference vectors within a few wei.
- Sophisticated position: one vault deposit backs several SwapVM strategies that the AquaAdapter ships into Aqua as maker, settled just in time through maker hooks.
- Two SwapVM programs run live strategies: `[ForexCurve]` and `[FlatFeeAmountIn][PeggedSwap]`.
- Real ARGt, BRAt and USDC move out of and into the vaults on every fill; fork tests cover the curve regimes that small live swaps do not reach.

Proof: [README: 1inch](../README.md#1inch-build-an-aqua-app-and-continuity), with the router and fills in [On-chain proof](#on-chain-proof).

### The Graph: Best AI Tooling or AI Use Case (Continuity pool)

- The Arc subgraph is deployed to Subgraph Studio and is the read model for the hosted MCP server and dashboard. It indexes vault positions, liquidity commitments, strategy classes, deployed strategies, fills and fees across both Aqua venues.
- The Graph is load-bearing: the read tools query subgraph entities, and a Graph failure is surfaced as an error, with no silent RPC fallback.
- Reusable MCP infrastructure: 25 tools over stdio or Streamable HTTP, published on npm (`@aqua0/mcp`), as a Claude Code plugin and as a hosted endpoint.
- An agent skill tells Claude Code, Codex and similar agents when to use Aqua0, which tool answers which job, and how to stay safe. The plugin installs it.
- Meaningful work: the agent maps a loose request ("usdc to brl") to a pair, checks which venue can ship, runs a multi-step setup idempotently, and turns market data into a verdict.

Proof: [README: The Graph AI Tooling](../README.md#the-graph-best-ai-tooling-or-ai-use-case) and [`THE_GRAPH_TRACK.md`](THE_GRAPH_TRACK.md).

### The Graph: Composable or Standardized Graph Products

- One standardized schema across protocols and chains: `benchmark_fx_strategy` sends one Messari DEX AMM query pattern unchanged through The Graph Network gateway to 12 standardized subgraphs (Uniswap v3 on six chains, Curve on Ethereum, SushiSwap on four chains, Velodrome v2 on Optimism).
- Composed with the Aqua0 subgraph: the same call reads Aqua0's live forex strategies and fills from Subgraph Studio next to the market pools, and adds a live Arc Testnet router quote for USDC/ARS and USDC/BRL.
- What the standard made easier: one query and one parser cover four protocols on six chains; adding a protocol or chain is a subgraph id and token addresses.
- Decisions from the data: a verdict (liquid, thin or none) with the numbers behind it, naming every source that failed. In the 2026-09-12 run EUR came back liquid, BRL thin, and MXN and ARS none.

Proof: [README: The Graph Composable](../README.md#the-graph-composable-or-standardized-graph-products) and the live run in [`THE_GRAPH_TRACK.md`](THE_GRAPH_TRACK.md#composable-and-standardized-graph-products).

## Demo framing

The shortest partner story:

1. **Arc:** one USDC principal on Arc backs both ARS and BRL FX strategies, traded through Circle wallets.
2. **1inch:** those strategies are real Aqua and SwapVM positions on our new `ForexCurve` opcode, and a live swap settles through the vaults.
3. **The Graph:** the fill and shared backing appear in the Arc subgraph; an agent queries them through the MCP server and benchmarks the next action.
4. **Agentic Arc:** the swap tilts the book, and the keeper pays for a signal, decides and rebalances on its own.

That is one continuous demo instead of disconnected sponsor integrations.
