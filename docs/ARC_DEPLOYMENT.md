# Arc Testnet deployment

Arc Testnet, chain id `5042002`, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`. Public addresses are committed in [`deployments/arc-testnet.json`](../deployments/arc-testnet.json).

## 1. Aqua0 vault core: Live

The team deployed the pre-existing Aqua0 vault contracts (source commit `8a9f1c2`) at start block `60613306`. The vaults hold the deposits from the live demo run (section 4).

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

## 2. Pegged venue: 1inch Aqua, AquaSwapVMRouter and Aqua0 AquaAdapter: Live

Deployed from [`packages/contracts`](../packages/contracts) with [`script/deploy-arc-aqua-venue.sh`](../packages/contracts/script/deploy-arc-aqua-venue.sh).

| Contract | Source | Address | Deploy tx |
| --- | --- | --- | --- |
| Aqua (`AquaRouter`) | 1inch aqua 0.1.0 | [`0x490d2eceD9aCF99e1db6090f820775bFa70020D4`](https://testnet.arcscan.app/address/0x490d2eceD9aCF99e1db6090f820775bFa70020D4) | [`0x4368a8bf…7280`](https://testnet.arcscan.app/tx/0x4368a8bfc17f05fc87466b555c2d7b3b8786643ab64aea0bb6ee25f4deb67280) (block 61679218) |
| `AquaSwapVMRouter` | 1inch swap-vm v1.0.2, unmodified | [`0xb20bc70b485eC1352C190d26fCaB1959d219F763`](https://testnet.arcscan.app/address/0xb20bc70b485eC1352C190d26fCaB1959d219F763) | [`0x95032e02…cf10`](https://testnet.arcscan.app/tx/0x95032e025ec80cf64d0fdebc527b911ee939644471718058f0f4ecaf892ccf10) (block 61679223) |
| Aqua0 `AquaAdapter` | Pre-existing Aqua0 contract | [`0xbF72D34b804636496c3308796908152b82624Ca5`](https://testnet.arcscan.app/address/0xbF72D34b804636496c3308796908152b82624Ca5) | [`0x24a8f224…88d9`](https://testnet.arcscan.app/tx/0x24a8f224e81b86c1f1827e3247912ff5dde01e7f47108521b6ac73581e4188d9) |

The venue broadcast is committed at [`packages/contracts/broadcast/DeployAquaVenue.s.sol/5042002/run-latest.json`](../packages/contracts/broadcast/DeployAquaVenue.s.sol/5042002/run-latest.json).

**Wired.** The AquaAdapter is allowlisted in the `VaultRegistry` and holds `VENUE_SETTLER_ROLE` on all three AssetVaults, so it settles swaps on Arc Testnet (section 4).

**"Verified" means on-chain post-deploy checks, not arcscan source verification.** The checks cover:
- `router.AQUA() == aqua`;
- the adapter's `aqua()`, `aquaSwapVMRouter()` and `registry()` bindings;
- `adapter.oneStrategyPerToken() == false`.

The adapter ships with `oneStrategyPerToken` on, which would stop one token from backing a second live strategy, so the adapter admin turns it off. The vault's settle-time debit and outflow limit remain the capital bound.

To send writes from the MCP in execute mode, the signer also needs `OPERATOR_ROLE` on the adapter. It must be an address without contract code: an EIP-7702-delegated address is checked through ERC-1271 and rejected.

## 3. Strategy classes on Arc

| Class | Pair | Strategist | Status |
| --- | --- | --- | --- |
| 1 | USDC / ARGt ("FXSwap ARS", key `0x9b16e2b3…802b`) | Core deployer | Legacy. Registered earlier with both vault legs; not funded, no strategy shipped. |
| 2 | USDC / ARS (ARGt), pegged | Demo wallet `0xAFF7…b02c` | **Live**: strategy [`0x384f3266…3c3c`](https://testnet.arcscan.app/tx/0x97d5fea443f9090f6b9dd2432036bdfbc2ed58d636e8ac802742d2e499968471) shipped with 0.5 USDC |
| 3 | USDC / BRL (BRAt), pegged | Demo wallet `0xAFF7…b02c` | **Live**: strategy [`0x3fbcd975…716e`](https://testnet.arcscan.app/tx/0x7571eea087df535b0a4391a48d510abeb9ed0084cc3816946040c05214aa2293) shipped with 0.5 USDC |

The earlier prepared "FXSwap BRL" class registration was never sent and is superseded by class 3. Records: [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json).

Class ids are assigned at registration. The key is `keccak256(abi.encode(strategist, chainId, sorted tokens, keccak256(label)))`, so the class ids a run gets depend on the signing strategist.

## 4. Two FX strategies on one USDC deposit: Live (pegged venue)

On 2026-09-12 the demo wallet `0xAFF7Da673820fAA38289de8B03984A9cf20fb02c` ran the flow on Arc Testnet through the `aqua0` CLI in `MCP_WRITE_MODE=execute`. The CLI calls the same `@aqua0/shared` service functions as the MCP tools. Every hash is under `liveVenueRun` in [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json).

| Step | Result | Tx |
| --- | --- | --- |
| Deposit | 2 USDC into the USDC AssetVault | [`0x088fb34b…c6bd`](https://testnet.arcscan.app/tx/0x088fb34b8147f936b7c10ac8066de4a59773f7d393f33eda64a4defeb8f6c6bd) |
| USDC/ARS strategy | Class 2 registered, legs funded and committed, `[FlatFeeAmountIn 30 bps][PeggedSwap]` shipped with 0.5 USDC | [`0x97d5fea4…8471`](https://testnet.arcscan.app/tx/0x97d5fea443f9090f6b9dd2432036bdfbc2ed58d636e8ac802742d2e499968471) |
| USDC/BRL strategy | Class 3, same steps, the same USDC committed | [`0x7571eea0…2293`](https://testnet.arcscan.app/tx/0x7571eea087df535b0a4391a48d510abeb9ed0084cc3816946040c05214aa2293) |
| Swap USDC → ARGt | 0.1 USDC → 138.912644 ARGt | [`0x24d95d61…02fb`](https://testnet.arcscan.app/tx/0x24d95d61c83e3dfdf5ffa8530350635eb9c9b5f71b51835f31b98eb61c5102fb) |
| Swap USDC → BRAt | 0.1 USDC → 0.545728 BRAt | [`0x811e5fd4…2539`](https://testnet.arcscan.app/tx/0x811e5fd474e554e7a3330f09f34edb09f40ca50475028be89c4de3e6cfd32539) |
| Shared-backing read | 2 USDC principal counted once; 2 USDC committed to class 2 and to class 3 | on-chain reads |

The same flow is repeatable on a local fork, with real Arc bytecode and state. Only USDC is stubbed, because Arc's USDC calls native precompiles that a local fork lacks.

1. **Foundry path:** [`packages/contracts/script/run-arc-fx-strategies.sh`](../packages/contracts/script/run-arc-fx-strategies.sh) runs [`ArcFxStrategies.s.sol`](../packages/contracts/script/ArcFxStrategies.s.sol).
2. **MCP service path:** [`scripts/test-arc-fork-strategies.sh`](../scripts/test-arc-fork-strategies.sh) drives `deposit`, `create_strategy` (twice), `quote_swap`, `swap` and `get_shared_backing` through the CLI and asserts the result.

## 5. FXSwap venue: Deployed, awaiting wiring

Deployed with [`packages/contracts/script/deploy-arc-fx-venue.sh`](../packages/contracts/script/deploy-arc-fx-venue.sh), which runs [`DeployFXVenue.s.sol`](../packages/contracts/script/DeployFXVenue.s.sol) (broadcast: [`run-latest.json`](../packages/contracts/broadcast/DeployFXVenue.s.sol/5042002/run-latest.json)) and then deploys a second AquaAdapter bound to the new router, since an adapter binds exactly one router.

| Contract | Address | Notes |
| --- | --- | --- |
| `AquaFXSwapVMRouter` | [`0xb54AE15d2372F27718f32e9f6990330cdD3edaEB`](https://testnet.arcscan.app/address/0xb54AE15d2372F27718f32e9f6990330cdD3edaEB) | FXSwap = opcode 34, 24,434 bytes (under EIP-170). EIP-712 name `AquaSwapVMRouter`, version `1.0.2-fx`, bound to the existing Aqua. Start block 61725474. |
| Aqua0 `AquaAdapter`, FXSwap venue | [`0x8236cfFDD17D7b41F41c820f5E4b7DA6d5F243D5`](https://testnet.arcscan.app/address/0x8236cfFDD17D7b41F41c820f5E4b7DA6d5F243D5) | Bound to the FXSwap router. Start block 61725501. |
| `ManualFxOracle` ARS/USD | [`0xc05A3Fb016f973C82b0232EF50336d4C0466E70C`](https://testnet.arcscan.app/address/0xc05A3Fb016f973C82b0232EF50336d4C0466E70C) | Answer 1400; owner is the demo wallet |
| `ManualFxOracle` BRL/USD | [`0x1AE6542b9da89Ed2AEf00600710Bba75DbFF5e71`](https://testnet.arcscan.app/address/0x1AE6542b9da89Ed2AEf00600710Bba75DbFF5e71) | Answer 5.50; owner is the demo wallet |

The feeds are Chainlink-compatible and owner-set by hand. FXSwap strategies trade at whatever they report, bounded by each strategy's price band and staleness window.

### Pending wiring for the FXSwap adapter

The core admin holds `DEFAULT_ADMIN_ROLE` on the registry and `CAPITAL_ADMIN_ROLE` on the vaults. It must send these calls, or grant admin roles so the team can send them:

1. `VaultRegistry.setAdapterAllowed(0x8236cfFDD17D7b41F41c820f5E4b7DA6d5F243D5, true)`
2. `grantRole(keccak256("VENUE_SETTLER_ROLE"), 0x8236cfFDD17D7b41F41c820f5E4b7DA6d5F243D5)` on the USDC AssetVault
3. The same on the ARGt AssetVault
4. The same on the BRAt AssetVault

`deploy-arc-fx-venue.sh` with `MODE=arc` prints the exact calldata. With `MODE=fork` it impersonates the admin and sends the calls on a local fork. The strategist also needs `OPERATOR_ROLE` on this adapter.

Until the wiring lands there are no live FXSwap strategies on Arc. The MCP's `create_strategy` then falls back to the pegged venue and explains why in `opcodeNote`. The full FXSwap flow is **Fork-proven** against these exact contracts with `FX_VENUE=deployed ./scripts/test-arc-fork-fxswap.sh`. Details are in the [README](../README.md#fxswap-in-brief).

## 6. Arc subgraph

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
PUBLIC_ARC_FX_AQUA_ADAPTER=0x8236cfFDD17D7b41F41c820f5E4b7DA6d5F243D5 \
PUBLIC_ARC_FX_AQUA_ADAPTER_START_BLOCK=61725501 \
PUBLIC_ARC_FXSWAP_ROUTER=0xb54AE15d2372F27718f32e9f6990330cdD3edaEB \
PUBLIC_ARC_FXSWAP_ROUTER_START_BLOCK=61725474 \
pnpm --filter @aqua0/subgraph generate:arc
```

| Scope | Status |
| --- | --- |
| Subgraph Studio: [`aqua-0-ethglobal-arc-testnet`](https://thegraph.com/studio/subgraph/aqua-0-ethglobal-arc-testnet), query endpoint `https://api.studio.thegraph.com/query/1760183/aqua-0-ethglobal-arc-testnet/version/latest`, `_meta.hasIndexingErrors = false` | **Live** (earlier schema; deployed by Rithik) |
| Both Aqua venues: `AquaStrategy`, `AquaOrder`, `AquaFill` with a `venue` label (`pegged` / `fxswap`), per-LP fill stats | **Built, not yet deployed** (Studio redeploy from this branch pending) |
| Self-hosted Graph Node through the Arc RPC proxy | Development fallback |

Deploy with `./scripts/deploy-graph-studio.sh` (defaults to Arc; credentials from the gitignored `.secrets/graph-studio.env`). See [`packages/subgraph/README.md`](../packages/subgraph/README.md) and [`THE_GRAPH_TRACK.md`](THE_GRAPH_TRACK.md).
