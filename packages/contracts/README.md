# @aqua0/contracts

Foundry package that puts 1inch Aqua + SwapVM on Arc Testnet and connects them to the live Aqua0 vault core
recorded in [`deployments/arc-testnet.json`](../../deployments/arc-testnet.json).

- `lib/swap-vm` — 1inch swap-vm **v1.0.2** (git submodule). Pinned because it is the build 1inch's own router
  runs elsewhere and the one Aqua0's `AquaAdapter` is tested against. It pins `@1inch/aqua` 0.1.0.
- `script/DeployAquaVenue.s.sol` — deploys `AquaRouter` (Aqua) and a stock `AquaSwapVMRouter`.
- `script/deploy-arc-aqua-venue.sh` — step 1: venue + Aqua0 `AquaAdapter` + wiring + verification.
- `script/ArcFxStrategies.s.sol`, `script/run-arc-fx-strategies.sh` — step 2: one USDC deposit backing a
  USDC/ARGt and a USDC/BRAt strategy, each shipped through the adapter and filled once.

## Setup

```bash
git submodule update --init packages/contracts/lib/swap-vm
(cd packages/contracts/lib/swap-vm && npm install --ignore-scripts)
(cd packages/contracts && forge build)
```

`AquaAdapter` is pre-existing Aqua0 code and is compiled from a local Aqua0 contracts checkout
(`AQUA0_CONTRACTS_DIR`).

## Step 1 — venue and adapter

```bash
# Dry run on a local fork (impersonates the core admin for the wiring)
anvil --fork-url https://rpc.testnet.arc.network --port 8577
MODE=fork AQUA0_CONTRACTS_DIR=../../../Aqua0/contracts DEPLOYER=0x... ./script/deploy-arc-aqua-venue.sh

# Arc Testnet (deploys, records addresses, prints the admin wiring calldata)
MODE=arc AQUA0_CONTRACTS_DIR=... DEPLOYER=0x... \
KEYSTORE_ACCOUNT=<keystore-name> KEYSTORE_PASSWORD_FILE=<path-to-password-file> \
./script/deploy-arc-aqua-venue.sh
```

The wiring (`VaultRegistry.setAdapterAllowed` and `VENUE_SETTLER_ROLE` on each vault) needs the core admin, so
on Arc it is printed rather than sent. The adapter is inert until it lands.

The deployer also turns off the adapter's `oneStrategyPerToken` knob. Left on, a token that backs one live
strategy cannot back a second, which is precisely the shared-backing property the demo shows. The vault's
settle-time debit and venue outflow limit remain the capital bound.

## Step 2 — two FX strategies on one USDC deposit

```bash
MODE=fork DEPLOYER=0x... KEYSTORE_ACCOUNT=<keystore-name> KEYSTORE_PASSWORD_FILE=<path-to-password-file> \
AQUA_ADAPTER=0x... AQUA_SWAPVM_ROUTER=0x... ./script/run-arc-fx-strategies.sh

MODE=arc DEPLOYER=0x... KEYSTORE_ACCOUNT=<keystore-name> KEYSTORE_PASSWORD_FILE=<path-to-password-file> ./script/run-arc-fx-strategies.sh
```

Tunables (env): `USDC_DEPOSIT`, `USDC_SHIP`, `USDC_SWAP_IN`, `FEE_PPB` (1e9 = 100%), `LINEAR_WIDTH` (1e27 scale),
`ARS_PER_USDC_E2`, `BRL_PER_USDC_E2`.

Each strategy is `[FlatFeeAmountIn][PeggedSwap]`. USDC's pegged-curve rate multiplier carries both the 12-decimal
gap and the FX price, so the flat zone sits at the configured price. It is a fixed-price stable strategy: it does
not follow a moving FX rate.

## RedStone FX feeds

FXSwap strategies price from RedStone `redstone-primary-prod` data: free signed prices from RedStone's public
gateways, no API key and no keeper of our own.

- `src/oracles/AquaRedStoneFeeds.sol`: `AquaRedStoneMultiFeedAdapter` stores the values, and one
  `AquaRedStonePriceFeed` per symbol exposes Chainlink-style `latestRoundData` for FXSwap (oracle kind 0). `BRL`
  quotes USD per 1 BRL, so FXSwap sets its invert flag; `MXNe` quotes MXN per 1 USD. Both use 8 decimals.
- Anyone refreshes a feed by calling `updateDataFeedsValuesPartial(bytes32[])` with a signed payload appended to
  the calldata. A value is stored only when 3 of the 5 primary-prod signers agree and the data is newer than the
  stored value and at most 3 minutes old. Reads revert after 30 hours without an update.
- `script/DeployRedStoneFeeds.s.sol` deploys the adapter and both feeds. There is no owner and nothing to wire.
- `test/AquaRedStoneFeeds.t.sol` replays the update sent on Arc (`test/fixtures/redstone-arc-update.json`), so the
  signature, threshold and median checks run without a fork.
- RedStone sources are vendored under `lib/redstone` (see its README).

```bash
forge script script/DeployRedStoneFeeds.s.sol --rpc-url https://rpc.testnet.arc.network \
  --account <keystore-name> --password-file <path-to-password-file> --broadcast
```

## Wire facts (swap-vm v1.0.2 `AquaSwapVMRouter`)

| Item | Value |
| --- | --- |
| `FlatFeeAmountIn` opcode | 21 (args: `uint32` fee, 1e9 = 100%) |
| `PeggedSwap` opcode | 31 (args: `x0, y0, linearWidth, rateLt, rateGt`, 5 × `uint256`) |
| Maker traits accepted by `AquaAdapter` | `useAqua (1<<254) \| postTransferIn (1<<251) \| preTransferOut (1<<250)` |
| Taker data for an exact-in swap | 22-byte header: `uint160(0) ++ uint16(0x0041)` (isExactIn \| transferFrom + Aqua push) |
| Taker approval target | the router (it pulls tokenIn and pushes it into Aqua) |

## Fork caveat

Arc's USDC ERC-20 interface calls native precompiles that anvil does not implement, so USDC transfers revert on
a local fork. `run-arc-fx-strategies.sh` with `MODE=fork` stands a plain ERC-20 in at the USDC address for the
fork only. Everything else on the fork is the real Arc bytecode and state.
