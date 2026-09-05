# Build Plan

## Current Commit

- Scaffold a pnpm TypeScript monorepo for Aqua0's ETHGlobal Continuity work.
- Add shared Shape-C constants for Arc Testnet and Aqua0's graph-facing service boundary.
- Add an MCP stdio server with health/info tools.
- Add a CLI that uses the same service layer as MCP.
- Add environment validation for public configuration only.

## Next Commit

- Add subgraph schema and mappings for the Shape-C shared-pool AssetVault fleet.
- Wire generated Graph types after the schema stabilizes.
- Add integration checks against the configured `GRAPH_ENDPOINT`.

## Boundaries

- Do not add or invent contract addresses.
- Treat Aqua0 contracts and ABIs as pre-existing project assets.
- Keep this repo focused on The Graph indexing, MCP, and terminal workflows for the hackathon submission.
