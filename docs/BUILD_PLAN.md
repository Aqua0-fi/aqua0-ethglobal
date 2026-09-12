# Build plan

The pitch, demo, architecture and prize mapping are in the [README](../README.md). This page tracks workstreams and the engineering boundaries they share.

## Workstreams

| Workstream | Owner | Status |
| --- | --- | --- |
| Aqua0 vault subgraph, Arc manifest, Arc RPC proxy | Rithik | **Live** (self-hosted Graph Node) |
| Subgraph Studio publishing | Rithik | **In progress** (needs the team's Studio key) |
| MCP server, CLI, dashboard, public AWS deployment | Rithik | **Live** (public endpoint on the earlier prepare-only build) |
| Arc deployment of the Aqua0 vault core | Tomás | **Live** |
| Aqua + AquaSwapVMRouter + AquaAdapter on Arc | Yudhishthra | **Deployed, awaiting wiring** |
| Arc SwapVM integration: strategy scripts, MCP SwapVM tools, Aqua venue indexing | Yudhishthra | **Fork-proven** (scripts, tools); indexing **Built, not yet deployed** |
| FXSwap opcode and `AquaFXSwapVMRouter` | Yudhishthra | **Built, not yet deployed** |
| FX formulas and FXSwap reference vectors | Tomás | **In progress** |

## Operational checklist

1. Set `GRAPH_ENDPOINT`. For the Graph prize, use the Subgraph Studio query endpoint.
2. Set `WRITE_RPC_URL` and `WRITE_CHAIN_ID`; the Arc venue addresses default from `deployments/arc-testnet.json`.
3. Leave `MCP_WRITE_MODE=prepare` unless deliberately testing guarded execution.
4. For HTTP deployments, run with `MCP_TRANSPORT=http`, route `/mcp`, and use `/health` for Graph-backed reachability.
5. Run `pnpm typecheck`, `pnpm build`, `pnpm lint` and `pnpm test` before release.

## Boundaries

- Analytics tools read The Graph only. On-chain reads (`classForStrategy`, quotes, `get_shared_backing`) are labelled as such.
- Write tools send only with `MCP_WRITE_MODE=execute` on Arc Testnet or a local fork, and `dryRun: true` always prepares. `prepare_withdraw` is preparation-only.
- `create_strategy` is idempotent: finished steps are reported as skipped.
- `swap` always quotes first and enforces a minimum output on-chain.
- Secrets come from environment variables and are omitted from `info` and logs.
- Documentation never claims something is live before it is on Arc Testnet or the public endpoints.
