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
| 6 | USDC / ARS (ARGt), forex | Demo Circle wallet `0xb0c0…d952` | **Live**: strategy [`0xc39dd71d…8597`](https://testnet.arcscan.app/tx/0xc74849a497ff73207e70872d3d83ed9d5cbc1babaa8f161ee716f444a9b7071e) shipped with 1 USDC |
| 7 | USDC / BRL (BRAt), forex | Demo Circle wallet `0xb0c0…d952` | **Live**: strategy [`0x87e021d4…2aa1`](https://testnet.arcscan.app/tx/0xb1d40beb277fda1516f39e59eacfd535c9199c0670d78d8181420289f88406b4) shipped with 1 USDC |

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

## 5. Forex venue: Live

Deployed with [`packages/contracts/script/deploy-arc-forex-venue.sh`](../packages/contracts/script/deploy-arc-forex-venue.sh), which runs [`DeployForexVenue.s.sol`](../packages/contracts/script/DeployForexVenue.s.sol) and then deploys a second AquaAdapter bound to the new router, since an adapter binds exactly one router. It deploys no feeds: forex strategies read the RedStone BRL feed ([section 6](#6-redstone-price-feeds-live)) and the ARS/USD `ManualFxOracle` below. Record: `forexVenue` in [`deployments/arc-testnet.json`](../deployments/arc-testnet.json).

This redeploy superseded the first forex venue (router `0x0661…1E3d`, adapter `0x7b42…fE80`, record `forexVenueV1`), whose router enforced a `maxFee` bound stricter than Tomás's spec. That venue is now retired: its two strategies were emergency-docked ([USDC/ARS](https://testnet.arcscan.app/tx/0x771a896751914bff20c29b45ff0a77ad051beee3cc0daa15ee8399e5b2701c1b), [USDC/BRL](https://testnet.arcscan.app/tx/0x454f0f166b77db42d43b740b037df583cff1d898f2d15b4fee1412ff176e8f87)), its adapter was [removed from the VaultRegistry allowlist](https://testnet.arcscan.app/tx/0xe6ed3e31d56fa86387fd0f60dd95659a45e5bd025953d2b3fc8ed5c047240d8c), and its `VENUE_SETTLER_ROLE` was revoked on the three vaults. The current router accepts any `maxFee` below 0.5 (so each quote has one solution), whatever `α` is.

| Contract | Address | Notes |
| --- | --- | --- |
| `AquaForexSwapVMRouter` | [`0x475d0E487779743Fb52c8E7729A1718934D4187e`](https://testnet.arcscan.app/address/0x475d0E487779743Fb52c8E7729A1718934D4187e) | ForexCurve = opcode 34, 24,418 bytes (under EIP-170). EIP-712 name `AquaSwapVMRouter`, version `1.0.2-forex`, bound to the existing Aqua. Deploy tx [`0x6697a936…2809`](https://testnet.arcscan.app/tx/0x6697a9364a485b1f3d09c99d12b929275d1bb564dcf5a656adb463bf885e2809), block 61773156. Verified on Arcscan (full match). |
| Aqua0 `AquaAdapter`, forex venue | [`0xc9cD056FCF2EF46116259fb094BD897c7E7C0EfB`](https://testnet.arcscan.app/address/0xc9cD056FCF2EF46116259fb094BD897c7E7C0EfB) | Bound to the forex router. Deploy tx [`0x9c77d0cd…2ff0`](https://testnet.arcscan.app/tx/0x9c77d0cda621deef452e315b885661024c1402b008cf878f9e1f8aa0d7842ff0), block 61773163. `oneStrategyPerToken` off ([tx](https://testnet.arcscan.app/tx/0xd507ad489dbb007b2defae02112f2ab602c736fe0d553e0fb74c5fd32f8a4a59)). Wired: allowlisted, with `VENUE_SETTLER_ROLE` on the three vaults (below). `OPERATOR_ROLE` granted to the shared Circle operator `0xcdbd…d404` ([tx](https://testnet.arcscan.app/tx/0x7e5e646d0254e31b4bc198c892ad46505f0b522c23803afb8f2930998eca63a8)). Verified on Arcscan (partial match: compiled without CBOR metadata). |
| `ManualFxOracle` ARS/USD | [`0xc05A3Fb016f973C82b0232EF50336d4C0466E70C`](https://testnet.arcscan.app/address/0xc05A3Fb016f973C82b0232EF50336d4C0466E70C) | Answer 1400; owner is the demo wallet |
| `ManualFxOracle` BRL/USD | [`0x1AE6542b9da89Ed2AEf00600710Bba75DbFF5e71`](https://testnet.arcscan.app/address/0x1AE6542b9da89Ed2AEf00600710Bba75DbFF5e71) | Answer 5.50; owner is the demo wallet. No longer the default: BRL prices from RedStone ([section 6](#6-redstone-price-feeds-live)). Set `FX_ORACLE_BRL_USD` to use it. |

The two `ManualFxOracle` feeds were deployed with the earlier FXSwap venue (`AquaFXSwapVMRouter` `0xb54AE15d2372F27718f32e9f6990330cdD3edaEB` and its AquaAdapter `0x8236cfFDD17D7b41F41c820f5E4b7DA6d5F243D5`), which the forex venue supersedes and which was never wired.

The `ManualFxOracle` feeds are Chainlink-compatible and owner-set by hand. Forex strategies trade at whatever their feed reports, bounded by each strategy's price band and staleness window.

### Wiring for the forex adapter: done

The core admin `0xBaA361817C8676b4A8a8C5e6fd050253f81f407C` holds `DEFAULT_ADMIN_ROLE` on the registry and `CAPITAL_ADMIN_ROLE` on the vaults. On 2026-09-12 it granted both roles to the team key `0x7E61A5EbCCd26d9D91690C6037d7224F5384730D`, which holds them and sent the wiring for this adapter:

| Call | Tx |
| --- | --- |
| `VaultRegistry.setAdapterAllowed(0xc9cD056FCF2EF46116259fb094BD897c7E7C0EfB, true)` | [`0xbc5aa29e…d57a`](https://testnet.arcscan.app/tx/0xbc5aa29ed8d56c84d2d376a131b4f772ec3ed0002d9a38f3bedf7a6af43ad57a) |
| `grantRole(keccak256("VENUE_SETTLER_ROLE"), forexAdapter)` on the USDC AssetVault | [`0x7d81d8e2…660f`](https://testnet.arcscan.app/tx/0x7d81d8e29ec9d4d50daf0cb3742157340b85f9e431dacd8cac32878d3d65660f) |
| The same on the ARGt AssetVault | [`0xf311a044…11a6`](https://testnet.arcscan.app/tx/0xf311a04452791477e4d36d10e5ffd02f075fe1ff6b6f15eb74ace4cdc1eb11a6) |
| The same on the BRAt AssetVault | [`0xe8c96205…464b`](https://testnet.arcscan.app/tx/0xe8c96205abe87a026516be364e1887d9bf6d27e157f49d5dcb6910d848c4464b) |

These calls are recorded under `forexVenue.coreWiring` in [`deployments/arc-testnet.json`](../deployments/arc-testnet.json), and the role grants to the team key in the same file. For a fresh adapter, `deploy-arc-forex-venue.sh` with `MODE=arc` prints the same calldata; with `MODE=fork` it impersonates the admin and sends the calls on a local fork. The shared Circle operator holds `OPERATOR_ROLE` on this adapter; any other address that sends ships on it needs that role too.

### Live forex run

On 2026-09-12 the `aqua0` CLI ran with `SIGNER=circle` in execute mode, signing with the demo Circle wallet `0xb0c0687eb013a5ffde4d23a89398a11bc424d952`. `create_strategy` picked `opcode:"forex"` by default, with no fallback, and reused classes 6 and 7. The shared Circle operator sent the ships the wallet signed. Every hash is under `forexLiveRun` in [`deployments/arc-testnet-strategies.json`](../deployments/arc-testnet-strategies.json).

| Step | Result | Tx |
| --- | --- | --- |
| USDC/ARS strategy | Class 6 reused with its vault legs and commitments, ARGt leg topped up, `[Salt][ForexCurve]` shipped with 1 USDC and 1400 ARGt | [`0xc74849a4…071e`](https://testnet.arcscan.app/tx/0xc74849a497ff73207e70872d3d83ed9d5cbc1babaa8f161ee716f444a9b7071e) |
| USDC/BRL strategy | Class 7 reused the same way, the same USDC committed, shipped with 1 USDC and its value in BRAt at the RedStone price | [`0xb1d40beb…06b4`](https://testnet.arcscan.app/tx/0xb1d40beb277fda1516f39e59eacfd535c9199c0670d78d8181420289f88406b4) |
| Swap USDC → ARGt | 0.1 USDC → 139.58 ARGt at oracle 1400, execution 1395.8, spread 29.99 bps | [`0x54f61cb5…7554`](https://testnet.arcscan.app/tx/0x54f61cb5ddbeea9ea6cdeef75346aba69fe08c9f59f1d2f0eea4dd89e3ef7554) |
| Push RedStone BRL price | Signed payload pushed before the BRL swap | [`0x46dbaaa5…8bed`](https://testnet.arcscan.app/tx/0x46dbaaa5685b7365c30c0b815a32e0cb3f5efd856283993c6f11698d74d28bed) |
| Swap USDC → BRAt | 0.1 USDC → 0.513598 BRAt at oracle 5.15143, execution 5.135976, spread 29.99 bps | [`0xe28f4014…172a`](https://testnet.arcscan.app/tx/0xe28f401465a86dd8557ddd8de548366b0ad5e1fe20db74f71e56cd4a6bcc172a) |
| Shared-backing read | 1 USDC principal committed to three classes at once: class 4 (pegged USDC/BRL), class 6 and class 7 | on-chain reads |

Both swaps stayed inside the flat band, so each paid only the 30 bps fee. [`scripts/test-arc-fork-forex.sh`](../scripts/test-arc-fork-forex.sh) remains the repeatable proof of the other curve regimes (inventory fee, halt band, oracle move), which this small run does not reach. Details are in the [README](../README.md#forex-curve-in-brief).

## 6. RedStone price feeds: Live

USDC/BRL forex strategies price from RedStone signed market data instead of a hand-set feed. RedStone's `redstone-primary-prod` gateways are free, need no API key and are verified on Arc Testnet. The alternatives did not fit:
- Pyth's Hermes now needs an API key, and the free tier is not entitled to FX feeds;
- Chainlink Data Feeds exist only on Arc mainnet;
- Circle StableFX covers only USDC/EURC.

RedStone has no ARS feed, so USDC/ARS keeps the `ManualFxOracle` (section 5).

Deployed by `0x7E61A5EbCCd26d9D91690C6037d7224F5384730D` with [`DeployRedStoneFeeds.s.sol`](../packages/contracts/script/DeployRedStoneFeeds.s.sol). The contracts have no owner and nothing to wire. Record: `contracts.redstone` in [`deployments/arc-testnet.json`](../deployments/arc-testnet.json).

| Contract | Address | Notes |
| --- | --- | --- |
| `AquaRedStoneMultiFeedAdapter` | [`0x1a3fff65628048e4188C40dd5cf55A27Fb513ea0`](https://testnet.arcscan.app/address/0x1a3fff65628048e4188C40dd5cf55A27Fb513ea0) | RedStone `MultiFeedAdapterWithoutRoundsPrimaryProd` |
| `AquaRedStonePriceFeed` BRL | [`0xac4D10eE7FF790c2E505fBBD6A72d15D7Cbc1796`](https://testnet.arcscan.app/address/0xac4D10eE7FF790c2E505fBBD6A72d15D7Cbc1796) | USD per 1 BRL, 8 decimals. Default feed for USDC/BRL. |
| `AquaRedStonePriceFeed` MXNe | [`0xc7cDEfF4e7534dAdeEBFc701c80d8C65b91807ad`](https://testnet.arcscan.app/address/0xc7cDEfF4e7534dAdeEBFc701c80d8C65b91807ad) | MXN per 1 USD, 8 decimals, priced from Etherfuse's MXNe stablecoin. No Aqua0 MXN vault exists yet. |

First on-chain update: [`0x3ec11cc0…4ecf`](https://testnet.arcscan.app/tx/0x3ec11cc0830567cb25a5d9b9b1f36c8caa5d966216c552b8a3098fee75d44ecf) stored BRL at 0.19402073 USD and MXNe at 16.97382 MXN per USD.

How it works:
- **Read.** ForexCurve reads a feed as oracle kind 0 (Chainlink-style `latestRoundData`), the only kind it accepts. `updatedAt` is the block time of the last push.
- **Push.** Anyone can call `updateDataFeedsValuesPartial(bytes32[])` with a signed payload appended to the calldata. The adapter stores a value only if 3 of RedStone's 5 primary-prod signers agree, the data is newer than the stored value, and it is at most 3 minutes old. Reads revert after 30 hours without an update.
- **No keeper.** The MCP and CLI `swap` push the latest signed payload right before swapping (about 130k gas). In prepare mode that push is the first prepared transaction.
- **Quote.** `quote_swap` sends nothing. It fetches the latest signed payload, decodes it the way the adapter aggregates it (median), and runs the router quote as an `eth_call` with a state override that places that value in the adapter's storage. Arc's RPC supports state overrides.
- **Create.** `create_strategy` for USDC/BRL sizes the default FX ship amount from the live RedStone price. The feed quotes USD per BRL, which is already the curve's USDC-per-BRL price, so the invert-price flag stays off. The default band is 0.0909–0.3636 USD per BRL (half to double 5.5 BRL per USD) and the default max staleness is 1 hour. The hand-set ARS feed keeps 7 days.
- **Inspect.** `get_fx_prices {"pair":"BRL"}` shows the latest signed price (signing time, the three signer values, also inverted to BRL per USD) and the value stored on-chain. Without a pair it also lists MXNe. `set_fx_price` refuses the RedStone feed.
- **Override.** `FX_ORACLE_BRL_USD`, if set, replaces RedStone for BRL with a BRL-per-USD feed, such as the old `ManualFxOracle` above.

Sources: [`AquaRedStoneFeeds.sol`](../packages/contracts/src/oracles/AquaRedStoneFeeds.sol), with RedStone's contracts vendored under [`packages/contracts/lib/redstone`](../packages/contracts/lib/redstone/README.md) (BUSL-1.1). [`AquaRedStoneFeeds.t.sol`](../packages/contracts/test/AquaRedStoneFeeds.t.sol) replays the real Arc update calldata, so signature, 3-of-5 threshold and median checks run in CI without a fork (5 tests).

| Scope | Status |
| --- | --- |
| Feeds deployed, updated on-chain, readable with `get_fx_prices` | **Live** |
| Forex USDC/BRL on these feeds: `swap` pushed a signed BRL price ([tx](https://testnet.arcscan.app/tx/0x46dbaaa5685b7365c30c0b815a32e0cb3f5efd856283993c6f11698d74d28bed)), then filled 0.1 USDC → 0.513598 BRAt at oracle 5.15143 BRAt per USDC ([tx](https://testnet.arcscan.app/tx/0xe28f401465a86dd8557ddd8de548366b0ad5e1fe20db74f71e56cd4a6bcc172a)) | **Live** (section 5) |

## 7. Arc subgraph

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
PUBLIC_ARC_FX_AQUA_ADAPTER=0xc9cD056FCF2EF46116259fb094BD897c7E7C0EfB \
PUBLIC_ARC_FX_AQUA_ADAPTER_START_BLOCK=61773163 \
PUBLIC_ARC_FXSWAP_ROUTER=0x475d0E487779743Fb52c8E7729A1718934D4187e \
PUBLIC_ARC_FXSWAP_ROUTER_START_BLOCK=61773156 \
pnpm --filter @aqua0/subgraph generate:arc
```

| Scope | Status |
| --- | --- |
| Subgraph Studio: [`aqua-0-ethglobal-arc-testnet`](https://thegraph.com/studio/subgraph/aqua-0-ethglobal-arc-testnet), query endpoint `https://api.studio.thegraph.com/query/1760183/aqua-0-ethglobal-arc-testnet/version/latest`, `_meta.hasIndexingErrors = false` | **Live**: version `ethglobal-arc-3d0b9ef` (deployment `QmWSmaVSWJ1hG8L5ShPj3n7z8fwpExj7mAVYXGfGtZ7gk9`), synced to the Arc head, indexing the current forex adapter and router with both live forex fills; record in [`deployments/graph-studio-arc-testnet.json`](../deployments/graph-studio-arc-testnet.json) |
| Both Aqua venues: `AquaStrategy`, `AquaOrder`, `AquaFill` with a `venue` label (`pegged` / `fxswap`), per-LP fill stats | **Live** on Subgraph Studio |
| Self-hosted Graph Node through the Arc RPC proxy | Development fallback |

Deploy with `./scripts/deploy-graph-studio.sh` (defaults to Arc; credentials from the gitignored `.secrets/graph-studio.env`). See [`packages/subgraph/README.md`](../packages/subgraph/README.md) and [`THE_GRAPH_TRACK.md`](THE_GRAPH_TRACK.md).
