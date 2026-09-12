# Continuity scope

Aqua0 is an existing DeFi protocol. Its vault contracts and the AquaAdapter live in the private Aqua0 contracts repository and are referenced here as external sources, not re-committed.

This repository separates that pre-existing work from what was built during ETHGlobal, and only the event work should be judged. The event history is this repository's git log, which starts on 2026-09-05 and has commits from every team member.

## Pre-existing Aqua0 work (not submitted for judging)

| Item | Notes |
| --- | --- |
| AssetVault shared-capital contracts: VaultRegistry, VaultFactory, Composer, FillerRegistry, AssetVault | Aqua0 contracts repository. The Arc deployment used source commit `8a9f1c2`. |
| Aqua0 `AquaAdapter`: maker hooks `preTransferOut` / `postTransferIn`, `shipStrategyWithFee`, EIP-712 strategist signatures | Aqua0 contracts repository. Compiled from a local checkout by `packages/contracts/script/deploy-arc-aqua-venue.sh` and `deploy-arc-fx-venue.sh`. |
| Non-subtractive commitment model (`setCommitment`, `committedBacking`, `availableFor`) and venue settlement (`settleVenueOut`, `settleVenueCredit`) | Aqua0 contracts repository |
| Base mainnet Aqua0 vault deployment | Addresses in `packages/subgraph/subgraph.base.yaml` |
| Strategy-key derivation used by the Aqua0 web app | Re-implemented and tested here |
| 1inch Aqua and SwapVM | Official 1inch sources |

## Built during ETHGlobal

| Item | Location | Status |
| --- | --- | --- |
| Aqua0 vault subgraph schema and mappings, canonical event indexing, required-events check | `packages/subgraph` | **Live** on Subgraph Studio |
| Arc manifest generation from the canonical Base manifest | `packages/subgraph/scripts/generate-arc-manifest.mjs` | **Live** |
| Subgraph Studio deployment for Arc | `scripts/deploy-graph-studio.sh`, `deployments/graph-studio-arc-testnet.json` | **Live** (earlier schema) |
| Both-venue Aqua indexing: `AquaStrategy`, `AquaOrder`, `AquaFill` with a `venue` label, per-LP fill stats and fees | `packages/subgraph` | **Built, not yet deployed** |
| Arc RPC topic-splitting and rate-pacing proxy for a self-hosted Graph Node | `infra/arc-rpc-proxy` | Development fallback |
| Graph-backed typed service: analytics, strategy keys, SwapVM and FXSwap programs, calldata, execution guard | `packages/shared` | **Live** |
| MCP server (stdio + Streamable HTTP) and public deployment | `apps/mcp`, `deploy/aws` | **Live**; public endpoint on the earlier prepare-only build |
| MCP SwapVM tools: `create_strategy`, `deposit`, `quote_swap`, `swap`, `get_shared_backing` | `packages/shared`, `apps/mcp`, `apps/cli` | **Live** on Arc (pegged venue, via the CLI) |
| MCP FXSwap tools: `opcode:"fxswap"`, `get_fx_prices`, `set_fx_price`, oracle and spread pricing | `packages/shared`, `apps/mcp`, `apps/cli` | **Fork-proven** |
| CLI with MCP parity | `apps/cli` | **Live** |
| Agent skill | `skills/aqua0/SKILL.md` | **Live** |
| Judge dashboard (web MVP) | `apps/dashboard` | **Live** |
| Arc Testnet deployment of the Aqua0 vault core and USDC/ARGt/BRAt vaults | `deployments/arc-testnet.json` | **Live** |
| 1inch Aqua 0.1.0 + AquaSwapVMRouter (swap-vm v1.0.2) + AquaAdapter on Arc, wired | `packages/contracts` | **Live** |
| One USDC deposit, two FX strategies shipped and filled on Arc Testnet | `deployments/arc-testnet-strategies.json` (`liveVenueRun`) | **Live** |
| Arc strategy scripts and fork proofs | `packages/contracts/script/ArcFxStrategies.s.sol`, `scripts/test-arc-fork-strategies.sh`, `scripts/test-arc-fork-fxswap.sh` | **Fork-proven** |
| Base-fork proof that one principal backs two FX classes | `scripts/test-shared-backing-fork.sh` | **Fork-proven** |
| FXSwap SwapVM instruction, `AquaFXSwapVMRouter`, 46 tests | `packages/contracts/src`, `packages/contracts/test` | CI green; validation against reference vectors **In progress** |
| FXSwap venue on Arc: router, FXSwap AquaAdapter, ARS/USD and BRL/USD feeds | `packages/contracts/script/deploy-arc-fx-venue.sh` | **Deployed, awaiting wiring** |
