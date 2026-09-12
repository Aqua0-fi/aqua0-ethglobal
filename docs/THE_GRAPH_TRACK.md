# The Graph track notes

For the full prize mapping, see [README: Prize tracks](../README.md#prize-tracks). This page covers the Graph-specific details: what is indexed, where it is served, and how to deploy to a Graph provider.

## The Graph is load-bearing

These tools in the MCP server, CLI and dashboard read indexed subgraph entities through [`packages/shared/src/graph.ts`](../packages/shared/src/graph.ts) and [`packages/shared/src/service.ts`](../packages/shared/src/service.ts):
- `health`
- `get_balance`
- `get_strategies`
- `get_fees`
- `list_opportunities`
- `protocol_snapshot`
- `graph_query`

None of them fall back to RPC if a Graph query fails; the error is surfaced to the agent. Agents use the results to see which vaults and classes have capital and whether a class already exists. After a transaction, they explain what changed, and `graph_query` covers ad-hoc questions.

`benchmark_fx_strategy` reads the Aqua0 subgraph too, composed with Messari standardized DEX subgraphs on The Graph Network: see [Composable and standardized Graph products](#composable-and-standardized-graph-products).

The SwapVM and FX tools add explicitly labelled on-chain reads. `quote_swap` is a router `eth_call` and `get_fx_prices` reads the feeds. `get_shared_backing` reads vault and adapter state directly, alongside the Aqua venue entities below that Studio serves.

**Agent skill.** [`skills/aqua0/SKILL.md`](../skills/aqua0/SKILL.md) gives Claude Code, Codex and similar agents the tool map for The Graph reads alongside the strategy tools. It includes natural-language examples and a `graph_query` that works on the current Studio schema.

## Live provider: Subgraph Studio

The Arc Testnet subgraph is **Live** on Subgraph Studio, deployed by Rithik. The current version, `ethglobal-arc-3d0b9ef` (deployment `QmWSmaVSWJ1hG8L5ShPj3n7z8fwpExj7mAVYXGfGtZ7gk9`), indexes the vault core and both Aqua venues, including the current forex adapter and router with both live forex fills, and is synced to the Arc head; `/version/latest` serves it. Public metadata is in [`deployments/graph-studio-arc-testnet.json`](../deployments/graph-studio-arc-testnet.json).

- Studio project: `https://thegraph.com/studio/subgraph/aqua-0-ethglobal-arc-testnet`
- Query endpoint (always the latest version): `https://api.studio.thegraph.com/query/1760183/aqua-0-ethglobal-arc-testnet/version/latest`
- Network: `arc-testnet` (`5042002`)
- `_meta.hasIndexingErrors = false`
- The public MCP (`https://ethglobal-mcp.18-207-103-187.nip.io/mcp`, earlier prepare-only build) and the judge dashboard read from this endpoint.

A smoke test through the public MCP used `health`, `protocol_snapshot`, `list_opportunities`, raw `graph_query` and `prepare_create_strategy`. The provider returned live Arc vault, strategy and strategy-vault state.

## What is indexed

| Scope | Manifest | Status |
| --- | --- | --- |
| Arc Testnet Aqua0 vault core: VaultFactory, VaultRegistry, Composer, FillerRegistry, AssetVault template | `subgraph.arc.yaml`, generated from `subgraph.base.yaml` by `pnpm --filter @aqua0/subgraph generate:arc` | **Live** on Subgraph Studio |
| Pegged AquaAdapter lifecycle events: `AquaStrategyShippedEvent`, `AquaStrategyDockedEvent`, `AquaStrategyReshippedEvent`, `AquaStrategyReconciledEvent` | Arc manifest | **Live** on Subgraph Studio, including both strategies shipped on Arc on 2026-09-12 |
| Both Arc Aqua venues: the pegged AquaAdapter + AquaSwapVMRouter and the forex AquaAdapter + AquaForexSwapVMRouter, as `AquaVenueAdapter`, `AquaStrategy`, `AquaOrder`, `AquaFill` (each with a `venue` label, `pegged` or `fxswap`), `AquaLPFillStats`, `AquaLPVaultFillStats` (fees per LP) | Arc manifest; router data sources are Arc-only | **Live** on Subgraph Studio (version `ethglobal-arc-3d0b9ef`) |
| Base Aqua0 vault deployment, including AquaAdapter and V4Adapter (pre-existing Aqua0 deployment) | `subgraph.base.yaml` | Provider-ready manifest |

[`packages/subgraph/schema.graphql`](../packages/subgraph/schema.graphql) covers:
- vaults, LP vault positions, strategies, strategy-vault legs and LP strategy positions;
- fee accrual, capital sourced and returned, and principal sold;
- class lifecycle, venue settlement and fronting;
- Aqua strategy ship, dock, reship and fills;
- V4 settlement.

`pnpm --filter @aqua0/subgraph test:required-events` guards the canonical accounting event set, so an ABI change cannot silently drop history. CI also generates and builds the Arc manifest with both venues.

A self-hosted Graph Node remains as a development fallback. It indexes through [`infra/arc-rpc-proxy`](../infra/arc-rpc-proxy), because Arc's public RPC limits topic-OR lists in `eth_getLogs`; the proxy splits only oversized log filters.

## Deploying to Studio

[`scripts/deploy-graph-studio.sh`](../scripts/deploy-graph-studio.sh) runs codegen, build and `graph deploy`.
- `NETWORK=arc` is the default and deploys `subgraph.arc.yaml`, regenerating it first when `PUBLIC_ARC_*` is set. `NETWORK=base` deploys the Base manifest.
- `GRAPH_STUDIO_SLUG` and `GRAPH_STUDIO_DEPLOY_KEY` come from the environment or the gitignored `.secrets/graph-studio.env`.
- `DRY_RUN=1` builds and prints the deploy command without a key.

```bash
./scripts/deploy-graph-studio.sh
```

Keep deploy keys and query API keys out of git. Pass a query key to the MCP as `GRAPH_AUTH_TOKEN`; it is sent as a bearer token and never returned by `info`.

## Judge flow

1. Connect an MCP client: `claude mcp add --transport http aqua0 https://ethglobal-mcp.18-207-103-187.nip.io/mcp`.
2. Ask: *"Check Aqua0 health, show the protocol snapshot, list strategy opportunities, and tell me which data came from The Graph."* Expected tools: `health`, `protocol_snapshot`, `list_opportunities`.
3. Ask for a strategy: *"Prepare a USDC/BRAt strategy on Arc for strategist 0x… with the USDC and BRAt vaults. Do not broadcast."* The agent calls `prepare_create_strategy`, which derives the strategy key and reads `classForStrategy` so the class id is never guessed. With a local build, `create_strategy {"pair":"USDC/BRL","dryRun":true}` prepares the full SwapVM flow.
4. After any real transaction is mined and indexed, ask the agent what changed. It re-queries The Graph, using `graph_query` if needed.
5. With a local server that has `GRAPH_GATEWAY_API_KEY`, ask: *"Is a 30 bps euro FX strategy competitive onchain? And how deep is BRL liquidity?"* Expected tool: `benchmark_fx_strategy` with `{"pair":"USDC/EUR"}`, then `{"pair":"BRL"}`. The CLI equivalent is `aqua0 benchmark-fx --pair EUR`.

## Composable and standardized Graph products

`benchmark_fx_strategy` (MCP) and `aqua0 benchmark-fx` (CLI) compare an Aqua0 forex strategy with the onchain market for the same currency, using Graph data on both sides. Source: [`packages/shared/src/graph-benchmark.ts`](../packages/shared/src/graph-benchmark.ts).

### One standardized query pattern

The market side uses the [Messari DEX AMM schema](https://github.com/messari/subgraphs). The tool sends the same two queries, unchanged, through The Graph Network gateway to every standardized subgraph on the chosen chains:

1. `liquidityPools(where: { or: [{ inputTokens_contains: [USDC, FX token] }, ...] })` returns id, name, fees, input tokens, balances and TVL.
2. For the pools found, `dailySnapshots` (volume by token, volume and revenue in USD) and `hourlySnapshots` (volume by token).

Only the subgraph id and the chain's token addresses change. Messari ids come from `deployment/deployment.json` in the messari/subgraphs repository (`decentralized-network` query ids). These answered through the gateway on 2026-09-12:

| Protocol | Chains | Schema version |
| --- | --- | --- |
| Uniswap v3 | Ethereum, Base, Polygon, Arbitrum, Optimism, Celo | 4.0.x |
| Curve | Ethereum | 1.3.0 |
| SushiSwap | Ethereum, Polygon, Arbitrum, Celo | 1.3.2 |
| Velodrome v2 | Optimism | 1.3.0 |

Not live then: PancakeSwap v3 and Curve on Optimism ("no allocations"), Balancer v2 on Ethereum (indexing error), Curve on Gnosis (stopped indexing in 2022).

**What the standard made easier.** One query and one parser cover four protocols on six chains, where protocol-specific schemas would need a query and a parser each. Schema 1.3 and 4.0 subgraphs answer the same fields, so a new protocol or chain is a subgraph id plus token addresses. The non-standardized subgraphs make the contrast visible: Aerodrome Base Full and the official Uniswap v3 subgraphs use `pools`, `poolDayData` and `poolHourData`, so they need a second query and parser. They run only as a labelled fallback (`fallback: "auto"`), for a chain where no standardized subgraph answered or none found a pool. Aerodrome has no Messari standardized subgraph, and it holds most EURC/USDC liquidity on Base.

### Composition with the Aqua0 subgraph

The same call reads the Aqua0 subgraph on Subgraph Studio: live forex strategies (`AquaStrategy` with `venue: "fxswap"`) and their fills and credited fees (`AquaFill`), for the Arc Testnet pair of the currency (USDC/ARS or USDC/BRL). The result places them next to the market pools, with the strategy's fee at each trade size and, for ARS and BRL, a live Arc Testnet quote for 0.1 USDC through the router. ARGt and BRAt are testnet demo tokens, so the Arc fills show the strategy working, not market volume.

### How the numbers are computed

- Volume is the USDC leg of each pool, taken as $1, because subgraphs cannot price every FX token (BRLA on Polygon reports `volumeUSD` and TVL as 0).
- Realized fee is fees over volume in USD over the lookback's complete UTC days; it books the fee tier, so dynamic fees may not show.
- The 24h range uses hourly high and low where the schema has them, else hourly volume-weighted prices, leaving out hours more than 3% from the median.
- Price impact per trade size is not computed; the Aqua0 cost is the strategy's fee inside its flat band. The tool never evaluates the forex curve: exact quotes go through the router with `quote_swap`.
- Each source reports its status, `_meta` block, indexing errors, latency and attempts. A "bad indexers" answer or a timeout is retried once, and the verdict names every source that still failed.
- The gateway key (`GRAPH_GATEWAY_API_KEY`) is sent only as a bearer header, never in a URL, and is redacted from every error.

### Live run (2026-09-12)

7-day lookback, a 30 bps Aqua0 strategy:

- **EUR, liquid.** 11 of 12 standardized subgraphs answered; Uniswap v3 on Base timed out. Uniswap v3 EURC/USDC 5 bps on Ethereum: $3.26M TVL, $966k a day, realized fee 5 bps. Uniswap v3 EURCV/USDC 5 bps: $3.42M TVL. Curve EURS/USDC: $4.37M TVL at 45 bps, $55 a day. Fallback Aerodrome EURC/USDC on Base: 5 bps with $3.09M TVL and $3.73M a day, 1 bp with $561k TVL and $1.21M a day. Verdict: a 30 bps strategy is not competitive on price; takers already pay 5 bps.
- **BRL, thin.** Uniswap v3 BRLA/USDC 5 bps on Polygon: $118k TVL, $220k a day. Aerodrome BRZ/USDC 1% on Base: $10k TVL, $4.8k a day. A $100k trade is 85% of the deepest pool's TVL. Aqua0's USDC/BRL forex strategy on Arc Testnet: 30 bps, 2 indexed fills; live quote 0.1 USDC for 0.5135 BRAt at a 30 bps spread to the RedStone price.
- **MXN, none.** No standardized pool. Aerodrome MXNe/USDC 1% on Base: $11.7k TVL, $9.13 of volume in the week.
- **ARS, none.** No standardized pool. Aerodrome ARST/USDC 1% on Base: $5.9k TVL. Aqua0's USDC/ARS forex strategy on Arc Testnet: 30 bps, 2 indexed fills.

### Next to The Graph's Subgraph MCP

An agent client can run The Graph's Subgraph MCP and the Aqua0 MCP side by side. The agent uses the Subgraph MCP to discover more subgraphs and pools, and Aqua0 to benchmark a strategy and act on Arc. The two servers are not integrated in code; the [agent skill](../skills/aqua0/SKILL.md) describes the steps.
