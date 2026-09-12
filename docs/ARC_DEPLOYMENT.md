# Arc Testnet deployment

Arc Testnet, chain id `5042002`, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`. Public addresses are committed in [`deployments/arc-testnet.json`](../deployments/arc-testnet.json).

## 1. Aqua0 vault core: Live

The team deployed the pre-existing Aqua0 vault contracts (source commit `8a9f1c2`) at start block `60613306`. The vaults are not funded yet.

| Contract | Address |
| --- | --- |
| VaultRegistry | [`0x9E094b21C4263e0BE5BEffa0f8296B3fd982fFFf`](https://testnet.arcscan.app/address/0x9E094b21C4263e0BE5BEffa0f8296B3fd982fFFf) |
| VaultFactory | [`0x879C0c90205172a8DD66afB8124994D866372FBa`](https://testnet.arcscan.app/address/0x879C0c90205172a8DD66afB8124994D866372FBa) |
| Composer | [`0x656F28021a624aDfA0d92dDFdBb20577674aFEC7`](https://testnet.arcscan.app/address/0x656F28021a624aDfA0d92dDFdBb20577674aFEC7) |
| FillerRegistry | [`0xa8e08346DD7b6809C47A920c365bCC987Ea91297`](https://testnet.arcscan.app/address/0xa8e08346DD7b6809C47A920c365bCC987Ea91297) |
| USDC AssetVault | [`0x99c2ab427b29dB1Cc14D228d970596015d1C4429`](https://testnet.arcscan.app/address/0x99c2ab427b29dB1Cc14D228d970596015d1C4429) |
| ARGt AssetVault | [`0x8a3d6188C58d7877499592E179DfE3bd80c4F460`](https://testnet.arcscan.app/address/0x8a3d6188C58d7877499592E179DfE3bd80c4F460) |
| BRAt AssetVault | [`0xEcB132648B781ec5742b582c526243Eeef900785`](https://testnet.arcscan.app/address/0xEcB132648B781ec5742b582c526243Eeef900785) |
| UpgradeableBeacon | [`0x77C04851838cb7f675e0366CEA253fEf08001C21`](https://testnet.arcscan.app/address/0x77C04851838cb7f675e0366CEA253fEf08001C21) |
| AssetVault implementation | [`0xc2F0D96Ba81C67baFaD6530A6A2C5236c7b66EEd`](https://testnet.arcscan.app/address/0xc2F0D96Ba81C67baFaD6530A6A2C5236c7b66EEd) |

Post-deployment checks confirmed:

- all 28 deployment transactions succeeded;
- the registry reports three vaults and maps USDC, ARGt and BRAt to the expected vaults;
- the factory points to the deployed registry and beacon, and holds `REGISTRAR_ROLE` on the registry;
- the composer points to the deployed registry and filler registry;
- all three vaults grant `COMPOSER_ROLE` to the composer.

Tokens:

| Token | Address | Decimals | Notes |
| --- | --- | --- | --- |
| USDC | [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) | 6 | Arc's native USDC, exposed through its ERC-20 interface |
| ARGt | [`0xd8dE250970842A581f89E885dA0F5165037714Ef`](https://testnet.arcscan.app/address/0xd8dE250970842A581f89E885dA0F5165037714Ef) | 18 | Open-mint testnet demo token standing in for an ARS stablecoin |
| BRAt | [`0xa9482a878A3784663512f0Bf8d0be17aD6DEA38E`](https://testnet.arcscan.app/address/0xa9482a878A3784663512f0Bf8d0be17aD6DEA38E) | 18 | Open-mint testnet demo token standing in for a BRL stablecoin |

ARGt and BRAt are testnet demo tokens, not issued stablecoins.

## 2. 1inch Aqua venue and Aqua0 AquaAdapter: Deployed, awaiting wiring

Deployed from [`packages/contracts`](../packages/contracts) with [`script/deploy-arc-aqua-venue.sh`](../packages/contracts/script/deploy-arc-aqua-venue.sh).

| Contract | Source | Address | Deploy tx |
| --- | --- | --- | --- |
| Aqua (`AquaRouter`) | 1inch aqua 0.1.0 | [`0x490d2eceD9aCF99e1db6090f820775bFa70020D4`](https://testnet.arcscan.app/address/0x490d2eceD9aCF99e1db6090f820775bFa70020D4) | [`0x4368a8bf…7280`](https://testnet.arcscan.app/tx/0x4368a8bfc17f05fc87466b555c2d7b3b8786643ab64aea0bb6ee25f4deb67280) (block 61679218) |
| `AquaSwapVMRouter` | 1inch swap-vm v1.0.2, unmodified | [`0xb20bc70b485eC1352C190d26fCaB1959d219F763`](https://testnet.arcscan.app/address/0xb20bc70b485eC1352C190d26fCaB1959d219F763) | [`0x95032e02…cf10`](https://testnet.arcscan.app/tx/0x95032e025ec80cf64d0fdebc527b911ee939644471718058f0f4ecaf892ccf10) (block 61679223) |
| Aqua0 `AquaAdapter` | Pre-existing Aqua0 contract | [`0xbF72D34b804636496c3308796908152b82624Ca5`](https://testnet.arcscan.app/address/0xbF72D34b804636496c3308796908152b82624Ca5) | [`0x24a8f224…88d9`](https://testnet.arcscan.app/tx/0x24a8f224e81b86c1f1827e3247912ff5dde01e7f47108521b6ac73581e4188d9) |

The venue broadcast is committed at [`packages/contracts/broadcast/DeployAquaVenue.s.sol/5042002/run-latest.json`](../packages/contracts/broadcast/DeployAquaVenue.s.sol/5042002/run-latest.json).

**"Verified" means on-chain post-deploy checks, not arcscan source verification.** The checks cover:
- `router.AQUA() == aqua`;
- the adapter's `aqua()`, `aquaSwapVMRouter()` and `registry()` bindings;
- `adapter.oneStrategyPerToken() == false`.

The adapter ships with `oneStrategyPerToken` on, which would stop one token from backing a second live strategy, so the adapter admin turns it off. The vault's settle-time debit and outflow limit remain the capital bound.

### Pending admin wiring: four transactions

These calls need `DEFAULT_ADMIN_ROLE` on the registry and `CAPITAL_ADMIN_ROLE` on the vaults, which only the core admin holds. The adapter is inert until they land.

1. `VaultRegistry.setAdapterAllowed(0xbF72D34b804636496c3308796908152b82624Ca5, true)`
2. `grantRole(keccak256("VENUE_SETTLER_ROLE"), 0xbF72D34b804636496c3308796908152b82624Ca5)` on the USDC AssetVault
3. The same on the ARGt AssetVault
4. The same on the BRAt AssetVault

`deploy-arc-aqua-venue.sh` with `MODE=arc` prints the exact calldata. With `MODE=fork` it impersonates the admin and sends the calls on a local fork.

To send writes from the MCP in execute mode, the signer also needs `OPERATOR_ROLE` on the adapter. It must be an address without contract code: an EIP-7702-delegated address is checked through ERC-1271 and rejected.

## 3. Strategy classes on Arc

| Class | Pair | Status |
| --- | --- | --- |
| 1 | USDC / ARGt ("FXSwap ARS", key `0x9b16e2b3…802b`) | Legacy. Registered earlier by the core deployer with both vault legs. Not funded. See [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json). |
| n/a | USDC / BRAt ("FXSwap BRL", key `0x104b36f3…dad8`) | A prepared `registerStrategyClass` transaction recorded as `prepared-not-broadcast`. Never sent. |

Class ids are assigned at registration. The key is `keccak256(abi.encode(strategist, chainId, sorted tokens, keccak256(label)))`, so the class ids a run gets depend on the signing strategist.

## 4. Two FX strategies on one USDC deposit: Fork-proven

Proven twice on a local fork of Arc, with real Arc bytecode and state. Only USDC is stubbed, because Arc's USDC calls native precompiles that a local fork lacks.

1. **Foundry path:** [`packages/contracts/script/run-arc-fx-strategies.sh`](../packages/contracts/script/run-arc-fx-strategies.sh) runs [`ArcFxStrategies.s.sol`](../packages/contracts/script/ArcFxStrategies.s.sol).
2. **MCP service path:** [`scripts/test-arc-fork-strategies.sh`](../scripts/test-arc-fork-strategies.sh) drives `deposit`, `create_strategy` (twice), `quote_swap`, `swap` and `get_shared_backing` through the CLI, which calls the same service functions as the MCP tools, and asserts the result.

Each run:

1. deposits 2 USDC once into the USDC AssetVault and commits it to two classes, USDC/ARGt and USDC/BRAt;
2. deposits and commits each FX leg;
3. ships a `[FlatFeeAmountIn 30 bps][PeggedSwap]` SwapVM program per class through `AquaAdapter.shipStrategyWithFee` (EIP-712 strategist signature);
4. swaps through `AquaSwapVMRouter`: 0.1 USDC → 139.248 ARGt and 0.1 USDC → 0.547 BRAt, both settled through the vault hooks;
5. reads back 2 USDC committed backing on both classes.

On Arc Testnet the same flow runs once the wiring in section 2 lands (`run-arc-fx-strategies.sh` with `MODE=arc`, or the MCP in execute mode).

## 5. FXSwap router: Built, not yet deployed

[`script/DeployFXVenue.s.sol`](../packages/contracts/script/DeployFXVenue.s.sol) deploys two demo `ManualFxOracle` feeds (ARS / USD and BRL / USD, Chainlink-style) and an `AquaFXSwapVMRouter` bound to the existing Aqua.

- FXSwap is instruction index 34.
- The router uses EIP-712 name `AquaSwapVMRouter` and version `1.0.2-fx`, so the AquaAdapter accepts it.
- The runtime is 24,434 bytes, under EIP-170.

After deployment, set `FXSWAP_ROUTER_ADDRESS` so the MCP accepts `opcode:"fxswap"`. Details are in the [README](../README.md#fxswap-in-brief).

## 6. Arc subgraph manifest

Generate `subgraph.arc.yaml` from the canonical Base manifest so event coverage cannot drift:

```bash
PUBLIC_ARC_VAULT_FACTORY=0x879C0c90205172a8DD66afB8124994D866372FBa \
PUBLIC_ARC_VAULT_REGISTRY=0x9E094b21C4263e0BE5BEffa0f8296B3fd982fFFf \
PUBLIC_ARC_COMPOSER=0x656F28021a624aDfA0d92dDFdBb20577674aFEC7 \
PUBLIC_ARC_FILLER_REGISTRY=0xa8e08346DD7b6809C47A920c365bCC987Ea91297 \
PUBLIC_ARC_START_BLOCK=60613306 \
PUBLIC_ARC_AQUA_ADAPTER=0xbF72D34b804636496c3308796908152b82624Ca5 \
PUBLIC_ARC_AQUA_ADAPTER_START_BLOCK=61679229 \
PUBLIC_ARC_AQUA_SWAPVM_ROUTER=0xb20bc70b485eC1352C190d26fCaB1959d219F763 \
PUBLIC_ARC_AQUA_SWAPVM_ROUTER_START_BLOCK=61679223 \
pnpm --filter @aqua0/subgraph generate:arc
```

| Scope | Status |
| --- | --- |
| Vault core: VaultFactory, VaultRegistry, Composer, FillerRegistry, AssetVault template | **Live** on a self-hosted Graph Node |
| Aqua venue: AquaAdapter strategies and router `Swapped` fills (`AquaStrategy`, `AquaOrder`, `AquaFill`, per-LP fill stats); router data source is Arc-only | **Built, not yet deployed** |
| Subgraph Studio publishing (`NETWORK=arc ./scripts/deploy-graph-studio.sh`) | **In progress**, needs the team's Studio key |

See [`packages/subgraph/README.md`](../packages/subgraph/README.md) and [`THE_GRAPH_TRACK.md`](THE_GRAPH_TRACK.md).
