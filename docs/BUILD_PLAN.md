# Build plan

The pitch, demo, architecture and prize mapping are in the [README](../README.md). This page tracks the workstreams and the engineering boundaries they share.

## Workstreams

| Workstream | Owner | Status |
| --- | --- | --- |
| Aqua0 vault subgraph, Arc manifest, Arc RPC proxy | Rithik | Live (self-hosted Graph Node) |
| AquaAdapter + router fill indexing on Arc; Subgraph Studio publishing | Rithik | In progress |
| MCP server, CLI, dashboard, public AWS deployment | Rithik | Live (prepare-only) |
| MCP SwapVM strategy tools: create strategy, deposit, quote, swap, shared-backing read | Rithik | In progress |
| Arc deployment of the Aqua0 vault core | Tomás | Live |
| Aqua + AquaSwapVMRouter + AquaAdapter on Arc | Yudhishthra | Deployed, awaiting admin wiring |
| Two FX strategies on one USDC deposit (Arc strategy scripts) | Yudhishthra | Fork-proven |
| FXSwap SwapVM instruction and FX formulas | Yudhishthra, Tomás | In progress |

<!-- TODO(coordinator): confirm workstream owners for the MCP SwapVM tools and FXSwap formulas, and update statuses as work lands. -->

## Operational checklist

1. Configure `GRAPH_ENDPOINT`. For the Graph prize, use the Subgraph Studio query endpoint.
2. Configure `WRITE_RPC_URL`, `WRITE_CHAIN_ID` and `VAULT_REGISTRY_ADDRESS` for write preparation.
3. Leave `MCP_WRITE_MODE=prepare` unless deliberately testing guarded execution.
4. For HTTP deployments, run with `MCP_TRANSPORT=http`, route `/mcp`, and use `/health` for Graph-backed reachability.
5. Run `pnpm typecheck`, `pnpm build`, `pnpm lint` and `pnpm test` before release.

## Boundaries

- Analytics tools read The Graph only.
- Raw units are returned as integer strings. Token decimals are never invented.
- `create_strategy` executes only after the guard passes, and re-reads class ids after mining.
- Deposit and withdraw are preparation-only in the MCP.
- Secrets come from environment variables and are omitted from `info` and normal logs.
- Documentation never claims something is live before it is on Arc Testnet or the public endpoints.
