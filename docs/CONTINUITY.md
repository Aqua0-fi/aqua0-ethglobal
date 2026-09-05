# Continuity scope

Aqua0 is an existing open-source DeFi project. This ETHGlobal repository deliberately separates pre-existing protocol work from the feature work built for the Continuity event.

## Pre-existing Aqua0 work

- Shape-C / AssetVault shared-capital contracts and registry/factory/composer architecture.
- Existing Aqua / venue adapter work and Aqua0 product contracts outside this repository.
- Existing Base deployments used as a realistic live-data source and local-fork reference.

## Built for this Continuity submission

- A dedicated Shape-C Subgraph schema and mappings for vault, LP, strategy, fee, settlement, fronting, Aqua lifecycle, and V4 settlement state.
- Canonical library-event ABI indexing plus an automated event-coverage regression check.
- Graph-backed analytics service and agent-facing MCP tools.
- CLI parity for analytics and Shape-C write preparation.
- Exact current Aqua0 strategy-key derivation and guarded Arc/local execution.
- Streamable HTTP MCP deployment path and live AWS deployment.
- Local-fork proof that one principal balance can back two FX strategy classes concurrently.
- Live Arc Testnet Shape-C deployment with USDC, ARGt, and BRAt vaults.
- Arc Subgraph generation from the canonical Base manifest.
- Arc RPC topic-splitting compatibility proxy so Graph Node can retain full event coverage against the public Arc RPC.
- Hackathon deployment/runbooks and provider deployment path.

The FXSwap SwapVM opcode itself is a separate track workstream; this repository's agent/indexing layer is designed to expose it once its real deployment/adapter addresses exist rather than inventing placeholder venue addresses.
