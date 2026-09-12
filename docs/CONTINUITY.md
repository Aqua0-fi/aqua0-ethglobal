# Continuity scope

Aqua0 is an existing DeFi protocol. Its vault contracts and the AquaAdapter live in the private Aqua0 contracts repository and are referenced here as external sources, not re-committed.

This repository separates that pre-existing work from what was built during ETHGlobal, and only the event work should be judged. The event history is this repository's git log, which starts on 2026-09-05 and has commits from every team member.

## Pre-existing Aqua0 work (not submitted for judging)

| Item | Notes |
| --- | --- |
| AssetVault shared-capital contracts: VaultRegistry, VaultFactory, Composer, FillerRegistry, AssetVault | Aqua0 contracts repository. The Arc deployment used source commit `8a9f1c2`. |
| Aqua0 `AquaAdapter`: maker hooks `preTransferOut` / `postTransferIn`, `shipStrategyWithFee`, EIP-712 strategist signatures | Aqua0 contracts repository. Compiled from a local checkout by `packages/contracts/script/deploy-arc-aqua-venue.sh` and `deploy-arc-forex-venue.sh`. |
| Non-subtractive commitment model (`setCommitment`, `committedBacking`, `availableFor`) and venue settlement (`settleVenueOut`, `settleVenueCredit`) | Aqua0 contracts repository |
| Base mainnet Aqua0 vault deployment | Addresses in `packages/subgraph/subgraph.base.yaml` |
| Strategy-key derivation used by the Aqua0 web app | Re-implemented and tested here |
| 1inch Aqua and SwapVM | Official 1inch sources |
| RedStone `evm-connector` and `on-chain-relayer` contracts | Vendored unmodified under `packages/contracts/lib/redstone` (BUSL-1.1) |

## Built during ETHGlobal

| Item | Location | Status |
| --- | --- | --- |
| Aqua0 vault subgraph schema and mappings, canonical event indexing, required-events check | `packages/subgraph` | **Live** on Subgraph Studio |
| Arc manifest generation from the canonical Base manifest | `packages/subgraph/scripts/generate-arc-manifest.mjs` | **Live** |
| Subgraph Studio deployment for Arc | `scripts/deploy-graph-studio.sh`, `deployments/graph-studio-arc-testnet.json` | **Live** (version `ethglobal-arc-3d0b9ef`) |
| Both-venue Aqua indexing: `AquaStrategy`, `AquaOrder`, `AquaFill` with a `venue` label, per-LP fill stats and fees | `packages/subgraph` | **Live** on Subgraph Studio |
| Arc RPC topic-splitting and rate-pacing proxy for a self-hosted Graph Node | `infra/arc-rpc-proxy` | Development fallback |
| Graph-backed typed service: analytics, strategy keys, SwapVM programs (pegged and forex curve), calldata, execution guard | `packages/shared` | **Live** |
| MCP server (stdio + Streamable HTTP) and public deployment | `apps/mcp`, `deploy/aws` | **Live**; public endpoint is the current prepare-only build (23 tools, no signer) |
| MCP SwapVM tools: `create_strategy`, `deposit`, `quote_swap`, `swap`, `get_shared_backing` | `packages/shared`, `apps/mcp`, `apps/cli` | **Live** on Arc (pegged and forex venues, via the CLI) |
| MCP forex tools: `opcode:"forex"` (the default), `get_fx_prices`, `set_fx_price`, oracle and spread pricing, RedStone payload push and quote state override | `packages/shared`, `apps/mcp`, `apps/cli` | **Live** on Arc; `set_fx_price` **Fork-proven** |
| CLI with MCP parity | `apps/cli` | **Live** |
| Agent skill | `skills/aqua0/SKILL.md` | **Live** |
| Graph-standardized FX benchmark (`benchmark_fx_strategy`): Aqua0 Arc subgraph + Messari DEX AMM subgraphs through The Graph Network gateway | `packages/shared/src/graph-benchmark.ts`, `apps/mcp` | **Live** on the public MCP |
| Judge dashboard (web MVP) | `apps/dashboard` | **Live** |
| Arc Testnet deployment of the Aqua0 vault core and USDC/ARGt/BRAt vaults | `deployments/arc-testnet.json` | **Live** |
| 1inch Aqua 0.1.0 + AquaSwapVMRouter (swap-vm v1.0.2) + AquaAdapter on Arc, wired | `packages/contracts` | **Live** |
| One USDC deposit, two FX strategies shipped and filled on Arc Testnet | `deployments/arc-testnet-strategies.json` (`liveVenueRun`) | **Live** |
| Forex strategies shipped by default and filled on Arc Testnet, one USDC principal backing three classes | `deployments/arc-testnet-strategies.json` (`forexLiveRun`) | **Live** |
| Arc strategy scripts and fork proofs | `packages/contracts/script/ArcFxStrategies.s.sol`, `scripts/test-arc-fork-strategies.sh`, `scripts/test-arc-fork-forex.sh` | **Fork-proven** |
| Base-fork proof that one principal backs two FX classes | `scripts/test-shared-backing-fork.sh` | **Fork-proven** |
| ForexCurve SwapVM instruction (Tomás's forex curve) and `AquaForexSwapVMRouter` | `packages/contracts/src`, `packages/contracts/test` | Matches all 979 reference vectors within a few wei; 83 Foundry tests pass |
| Forex venue on Arc: `AquaForexSwapVMRouter` and forex AquaAdapter (verified on Arcscan), and the ARS/USD feed it reads | `packages/contracts/script` | **Live** (wired into the vaults) |
| RedStone BRL and MXNe price feeds on Arc (`AquaRedStoneFeeds`), deploy script, Arc-calldata replay test (5 tests) | `packages/contracts/src/oracles`, `packages/contracts/script/DeployRedStoneFeeds.s.sol`, `packages/contracts/test/AquaRedStoneFeeds.t.sol` | **Live** |
