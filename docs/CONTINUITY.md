# Continuity scope

Aqua0 is an existing open-source DeFi protocol. This repository separates pre-existing protocol work from work built during ETHGlobal, and only the second should be judged. The event history is in this repository's git log, which starts on 2026-09-05 and has commits from all team members. Pre-existing contracts are referenced as external sources, not re-committed here.

## Pre-existing Aqua0 work (not submitted for judging)

| Item | Notes |
| --- | --- |
| AssetVault shared-capital contracts: VaultRegistry, VaultFactory, Composer, FillerRegistry, AssetVault | Aqua0 contracts repository. The Arc deployment used source commit `8a9f1c2`. |
| Aqua0 `AquaAdapter`: maker hooks `preTransferOut` / `postTransferIn`, `shipStrategyWithFee`, EIP-712 strategist signatures | Aqua0 contracts repository. Compiled from a local checkout by `packages/contracts/script/deploy-arc-aqua-venue.sh`. |
| Non-subtractive commitment model (`setCommitment`, `committedBacking`, `availableFor`) and venue settlement (`settleVenueOut`, `settleVenueCredit`) | Aqua0 contracts repository |
| Base mainnet Aqua0 vault deployment | Addresses in `packages/subgraph/subgraph.base.yaml` |
| Strategy-key derivation used by the Aqua0 web app | Re-implemented and tested here |
| 1inch Aqua and SwapVM | Official 1inch sources, used unmodified |

<!-- TODO(coordinator): confirm the public URL of the Aqua0 contracts repository to link here. -->

## Built during ETHGlobal

| Item | Location | Status |
| --- | --- | --- |
| Aqua0 vault subgraph schema + mappings, canonical event ABI indexing, required-events regression check | `packages/subgraph` | Live (self-hosted) |
| Arc manifest generation from the canonical Base manifest | `packages/subgraph/scripts/generate-arc-manifest.mjs` | Live |
| Arc RPC topic-splitting and rate-pacing proxy for Graph Node | `infra/arc-rpc-proxy` | Live |
| Graph-backed typed service: analytics, strategy-key derivation, calldata, execution guard | `packages/shared` | Live |
| MCP server (stdio + Streamable HTTP) and public AWS deployment | `apps/mcp`, `deploy/aws` | Live, prepare-only |
| CLI with analytics and write-preparation parity | `apps/cli` | Live (local) |
| Judge dashboard (web MVP) | `apps/dashboard` | Live |
| Arc Testnet deployment of the Aqua0 vault core and USDC/ARGt/BRAt vaults | `deployments/arc-testnet.json` | Live |
| Base-fork proof that one principal backs two FX classes | `scripts/test-shared-backing-fork.sh` | Fork-proven |
| 1inch Aqua 0.1.0 + AquaSwapVMRouter (swap-vm v1.0.2) + AquaAdapter deployed on Arc | `packages/contracts` | Deployed, awaiting admin wiring |
| Arc strategy scripts: one USDC deposit, two FX strategies shipped through the adapter and filled | `packages/contracts/script/ArcFxStrategies.s.sol` | Fork-proven |
| FXSwap SwapVM instruction | `packages/contracts` | In progress |
| MCP SwapVM strategy tools: create strategy, deposit, quote, swap, shared-backing read | `packages/shared`, `apps/mcp` | In progress |
| AquaAdapter + router fill indexing on Arc, Subgraph Studio publishing | `packages/subgraph` | In progress |
