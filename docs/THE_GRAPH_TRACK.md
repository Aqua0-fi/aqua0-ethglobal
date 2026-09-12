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

The SwapVM tools add explicitly labelled on-chain reads. `quote_swap` is a router `eth_call`. `get_shared_backing` reads vault state directly until the Aqua venue entities below are served by a provider.

## What is indexed

| Scope | Manifest | Status |
| --- | --- | --- |
| Arc Testnet Aqua0 vault core: VaultFactory, VaultRegistry, Composer, FillerRegistry, AssetVault template | `subgraph.arc.yaml`, generated from `subgraph.base.yaml` by `pnpm --filter @aqua0/subgraph generate:arc` | **Live** on a self-hosted Graph Node (AWS) |
| Arc Aqua venue: AquaAdapter strategies and AquaSwapVMRouter fills, as `AquaStrategy`, `AquaOrder`, `AquaFill`, `AquaLPFillStats`, `AquaLPVaultFillStats` (fees per LP) | Arc manifest; router data source is Arc-only | **Built, not yet deployed** |
| Base Aqua0 vault deployment, including AquaAdapter and V4Adapter (pre-existing Aqua0 deployment) | `subgraph.base.yaml` | Provider-ready manifest |

[`packages/subgraph/schema.graphql`](../packages/subgraph/schema.graphql) covers:
- vaults, LP vault positions, strategies, strategy-vault legs and LP strategy positions;
- fee accrual, capital sourced and returned, and principal sold;
- class lifecycle, venue settlement and fronting;
- Aqua strategy ship, dock, reship and fills;
- V4 settlement.

`pnpm --filter @aqua0/subgraph test:required-events` guards the canonical accounting event set, so an ABI change cannot silently drop history.

Arc's public RPC limits topic-OR lists in `eth_getLogs`, so the Graph Node indexes through [`infra/arc-rpc-proxy`](../infra/arc-rpc-proxy), which splits only oversized log filters.

## Graph provider status

The prize requires live data from a Graph provider such as Subgraph Studio. A self-hosted node does not qualify.

- **Today:** the public MCP (`https://ethglobal-mcp.18-207-103-187.nip.io/mcp`, earlier prepare-only build) and the dashboard read the Arc subgraph from the team's self-hosted Graph Node.
- **In progress:** publishing the Arc subgraph, including the venue entities, to Subgraph Studio with the team's Studio key. The public MCP's `GRAPH_ENDPOINT` then moves to the Studio query URL, and the endpoint is redeployed with the SwapVM tools.

[`scripts/deploy-graph-studio.sh`](../scripts/deploy-graph-studio.sh) runs codegen, build and `graph deploy`, with a Studio deploy key taken from the environment.
- Base (`subgraph.base.yaml`) is the default.
- `NETWORK=arc` deploys `subgraph.arc.yaml`, regenerating it first when `PUBLIC_ARC_*` is set.
- `DRY_RUN=1` builds and prints the deploy command without a key.

```bash
NETWORK=arc \
GRAPH_STUDIO_SLUG=<studio-slug> \
GRAPH_STUDIO_DEPLOY_KEY=<deploy-key-from-studio> \
./scripts/deploy-graph-studio.sh
```

Keep deploy keys and query API keys out of git. Pass a query key to the MCP as `GRAPH_AUTH_TOKEN`; it is sent as a bearer token and never returned by `info`.

## Judge flow

1. Connect an MCP client: `claude mcp add --transport http aqua0 https://ethglobal-mcp.18-207-103-187.nip.io/mcp`.
2. Ask: *"Check Aqua0 health, show the protocol snapshot, list strategy opportunities, and tell me which data came from The Graph."* Expected tools: `health`, `protocol_snapshot`, `list_opportunities`.
3. Ask for a strategy: *"Prepare a USDC/BRAt strategy on Arc for strategist 0x… with the USDC and BRAt vaults. Do not broadcast."* The agent calls `prepare_create_strategy`, which derives the strategy key and reads `classForStrategy` so the class id is never guessed. With a local build, `create_strategy {"pair":"USDC/BRL","dryRun":true}` prepares the full SwapVM flow.
4. After any real transaction is mined and indexed, ask the agent what changed. It re-queries The Graph, using `graph_query` if needed.

## Composable / standardized Graph products (stretch, Planned)

Aqua0 does not yet compose two Graph products or use a standardized schema. A qualifying extension would add an MCP tool that combines the Aqua0 subgraph with The Graph's Subgraph MCP, or with a standardized DEX subgraph on a network that has one. It would benchmark an Aqua0 strategy's fees and fill prices against the same pair on other venues, and let the agent recommend where to commit shared capital.
