# Build Plan

## Current State

- Shape-C subgraph schema and mappings live in `packages/subgraph`.
- `packages/shared` owns the native-fetch GraphQL client, typed analytics methods, raw Graph query escape hatch, strategy-key derivation, calldata preparation, and guarded execution helpers.
- `apps/mcp` exposes typed tools over stdio and Streamable HTTP.
- `apps/cli` exposes parity analytics commands and guarded write preparation/execution commands.
- Tests cover strategy-key drift, Graph errors/raw-unit aggregation, and mainnet/Base execution refusal.

## Operational Checklist

1. Configure `GRAPH_ENDPOINT`.
2. Configure `WRITE_RPC_URL`, `WRITE_CHAIN_ID`, and `VAULT_REGISTRY_ADDRESS` for write preparation.
3. Leave `MCP_WRITE_MODE=prepare` unless deliberately testing guarded execution.
4. For AWS-style deployments, run the MCP server with `MCP_TRANSPORT=http` and route `/mcp`; use `/health` for Graph-backed reachability.
5. Run `pnpm typecheck`, `pnpm build`, `pnpm lint`, and `pnpm test` before release.

## Boundaries

- Analytics tools use Graph reads only.
- Raw units are returned as integer strings; token decimals are not invented.
- `create_strategy` may execute only after the guard passes and re-reads class ids after mining.
- Deposit and withdraw are preparation-only.
- Secrets are accepted through environment variables but omitted from `info` and normal logs.
