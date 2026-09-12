# The Graph track notes

For the full prize mapping see [README: Prize tracks](../README.md#prize-tracks). This page covers the Graph-specific details: what is indexed, where it is served, and how to deploy to a Graph provider.

## The Graph is load-bearing

Every analytics tool in the MCP server, CLI and dashboard reads indexed subgraph entities through [`packages/shared/src/graph.ts`](../packages/shared/src/graph.ts) and [`packages/shared/src/service.ts`](../packages/shared/src/service.ts): `health`, `get_balance`, `get_strategies`, `get_fees`, `list_opportunities`, `protocol_snapshot`, `graph_query`. None of them fall back to RPC if a Graph query fails; the error is surfaced to the agent. Agents use the results to decide which strategy classes have capital, whether a class already exists, and what changed after a transaction. They also get `graph_query` for ad-hoc questions the typed tools do not cover.

## What is indexed

| Scope | Manifest | Status |
| --- | --- | --- |
| Arc Testnet Shape-C core: VaultFactory, VaultRegistry, Composer, FillerRegistry, AssetVault template | `subgraph.arc.yaml` generated from `subgraph.base.yaml` by `pnpm --filter @aqua0/subgraph generate:arc` | Live on a self-hosted Graph Node (AWS) |
| Arc Testnet AquaAdapter lifecycle events and AquaSwapVMRouter fills | Arc manifest | In progress |
| Base Shape-C deployment, including AquaAdapter and V4Adapter (pre-existing Aqua0 deployment) | `subgraph.base.yaml` | Provider-ready manifest |

The schema ([`packages/subgraph/schema.graphql`](../packages/subgraph/schema.graphql)) covers vaults, LP vault positions, strategies, strategy-vault legs, LP strategy positions, fee accrual, capital sourced and returned, principal sold, class lifecycle, venue settlement, fronting, Aqua strategy ship/dock/reship/reconcile, and V4 settlement. `pnpm --filter @aqua0/subgraph test:required-events` guards the canonical accounting event set, so an ABI change cannot silently drop history.

Arc's public RPC limits topic-OR lists in `eth_getLogs`. The Graph Node indexes through [`infra/arc-rpc-proxy`](../infra/arc-rpc-proxy), which splits only oversized log filters.

## Graph provider status

The prize requires live data from a Graph provider such as Subgraph Studio. A self-hosted node does not qualify.

- **Today:** the public MCP (`https://ethglobal-mcp.18-207-103-187.nip.io/mcp`) and the dashboard read the Arc subgraph from the team's self-hosted Graph Node.
- **In progress:** publishing the Arc subgraph to Subgraph Studio, then pointing the public MCP's `GRAPH_ENDPOINT` at the Studio query URL.

<!-- TODO(coordinator): when the Studio deployment is live, record the Studio subgraph URL (without API key) and switch the "Today" line above. -->

The repository helper [`scripts/deploy-graph-studio.sh`](../scripts/deploy-graph-studio.sh) runs codegen, build, and `graph deploy` with a Studio deploy key taken from the environment. Base (`subgraph.base.yaml`) is the default. An Arc target is being added as part of the in-progress Studio work: `NETWORK=arc` deploys `subgraph.arc.yaml`, regenerating it first when `PUBLIC_ARC_*` is set, and `DRY_RUN=1` builds and prints the deploy command without a key.

```bash
NETWORK=arc \
GRAPH_STUDIO_SLUG=<studio-slug> \
GRAPH_STUDIO_DEPLOY_KEY=<deploy-key-from-studio> \
./scripts/deploy-graph-studio.sh
```

Keep deploy keys and query API keys out of git. Pass a query key to the MCP as `GRAPH_AUTH_TOKEN`. It is sent as a bearer token and never returned by `info`.

## Judge flow

1. Connect an MCP client to the public endpoint: `claude mcp add --transport http aqua0 https://ethglobal-mcp.18-207-103-187.nip.io/mcp`.
2. Ask: *"Check Aqua0 health, show the protocol snapshot, list strategy opportunities, and tell me which data came from The Graph."* Expected tools: `health`, `protocol_snapshot`, `list_opportunities`.
3. Ask for a strategy: *"Prepare a USDC/BRAt strategy on Arc for strategist 0x… with the USDC and BRAt vaults. Do not broadcast."* The agent calls `prepare_create_strategy`, which derives the strategy key and reads `classForStrategy` so the class id is never guessed.
4. After any real transaction is mined and indexed, ask the agent what changed. It re-queries The Graph, using `graph_query` if needed.

## Composable / standardized Graph products (stretch, not achieved)

Aqua0 does not yet compose two Graph products or use a standardized schema. A qualifying extension would add an MCP tool that combines the Aqua0 subgraph with The Graph's Subgraph MCP, or with a standardized DEX subgraph on a network that has one. It would benchmark an Aqua0 strategy's fees and fill prices against the same pair on other venues, and let the agent recommend where to commit capital. Status: **Planned**.
