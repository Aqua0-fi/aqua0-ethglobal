# Aqua0 Vault Subgraph

This package indexes the current Aqua0 shared-capital `AssetVault` fleet.

## Base Mainnet

`subgraph.base.yaml` is the live Base manifest used for The Graph provider deployment.

It indexes:

- `VaultFactory`: `0xc914b9B607F50e153cc1E4a7633f3233B4e57874`
- `VaultRegistry`: `0xd3AdBaFb6C59614C6F6a46F1E7346b9629Dd847C`
- `Composer`: `0x3c6CDc78aB654CaD25873C9eFe9dEDa934Bf9769`
- `FillerRegistry`: `0x0fc6198ea9280A6568CACd4586C864f03505cb89`
- `AquaAdapter`: `0x1a09f7d9B921C93F8fCD4bF04fe448982a3388Ec`
- `V4Adapter`: `0xACaF2945890AB6caea62bDa459d1922532A500C8`
- `startBlock`: `50654875`
- Graph network: `base`

`VaultFactory.VaultCreated` dynamically creates an `AssetVault` template so newly created vaults are discovered automatically.

The mappings are event-sourced for history rows and refresh current state through safe `try_` calls where the current vault ABI exposes getters. If a getter reverts, indexing continues and the previous snapshot value is retained.

The canonical library-scoped vault accounting events come from `abis/Events.json`. `test:required-events` guards the required event set so an ABI-generation change cannot silently drop accounting/fronting history.

## Arc Testnet

The live Arc deployment is recorded in `../../deployments/arc-testnet.json`. Generate `subgraph.arc.yaml` from the canonical Base manifest with the real core addresses:

```sh
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

The adapter, router, FX adapter, FX router and `PUBLIC_ARC_V4_ADAPTER` sources are optional; unset sources are dropped (V4Adapter is not deployed on Arc). The FX sources reuse the pegged sources' mappings and generated types, so `PUBLIC_ARC_FX_AQUA_ADAPTER` needs `PUBLIC_ARC_AQUA_ADAPTER` and `PUBLIC_ARC_FXSWAP_ROUTER` needs `PUBLIC_ARC_AQUA_SWAPVM_ROUTER`. Any source can override its start block with `<ADDRESS_ENV>_START_BLOCK`; otherwise `PUBLIC_ARC_START_BLOCK` applies. The generated manifest uses Graph network `arc-testnet`; Arc chain id is `5042002`.

### Aqua venue entities

- `AquaVenueAdapter`, `AquaStrategy` (`<adapter>-<strategyId>`, with `classId`/`strategy` and `status`), `AquaOrder` (`<maker>-<orderHash>`; a fresh ship's hash is the strategy id, a reship activates `newAquaHash`).
- `AquaFill` from the address-scoped router `Swapped` event. The router data source is Arc-only: it is not in `subgraph.base.yaml` (Base does not index 1inch's shared router) and `generate:arc` appends it from `manifests/aqua-swapvm-router.arc.yaml` when `PUBLIC_ARC_AQUA_SWAPVM_ROUTER` is set. Fills whose maker is an indexed adapter and whose order hash maps to a shipped strategy link the strategy, class, `vaultIn`/`vaultOut`, the `ClassVenueSettledEvent`s the maker hooks booked, and the per-LP `StrategyPrincipalSoldEvent`s / `StrategyFeeAccruedEvent`s that served the swap (`lps`, `principalSold` in tokenOut units, `feesCredited` in tokenIn units).
- `AquaLPFillStats` (per LP) and `AquaLPVaultFillStats` (per vault+LP, asset units) aggregate fills and swap fees.
- Two Arc venues are indexed side by side: pegged (`AquaAdapter` + `AquaSwapVMRouter`) and FXSwap (`FXAquaAdapter` + `AquaFXSwapVMRouter`, cloned from the same adapter block and router template). Each Arc data source carries a `venue` context (`pegged` / `fxswap`) stamped on `AquaVenueAdapter.venue`, `AquaStrategy.venue` and `AquaFill.venue`; `AquaFill.router` and `AquaVenueAdapter.swapVMRouter` keep the raw addresses. Entity ids include the adapter address, and fills attach only the settlements tagged with their own maker adapter, so both venues can share vaults and strategy classes. None of the Arc-only venue sources exist in `subgraph.base.yaml`.

Arc's public RPC limits large topic-OR `eth_getLogs` requests. The AWS Graph Node therefore uses the compatibility shim in `../../infra/arc-rpc-proxy`, which splits only oversized log-filter topic lists and otherwise passes JSON-RPC through unchanged.

## Development

```sh
pnpm install
pnpm --filter @aqua0/subgraph codegen
pnpm --filter @aqua0/subgraph graph:build
pnpm --filter @aqua0/subgraph test:required-events
```

Root workspace helpers:

```sh
pnpm graph:codegen
pnpm graph:build
```

## Subgraph Studio / Graph provider

The Graph Continuity submission should use a real Graph provider endpoint for the judge-facing MCP. The repository helper is:

```sh
GRAPH_STUDIO_SLUG=<studio-slug> \
GRAPH_STUDIO_DEPLOY_KEY=<secret-deploy-key> \
./scripts/deploy-graph-studio.sh
```

`NETWORK=arc` (the default) deploys `subgraph.arc.yaml` (regenerated first when `PUBLIC_ARC_*` is set); `NETWORK=base` deploys the Base manifest. Credentials may also come from the gitignored `.secrets/graph-studio.env`. `DRY_RUN=1` builds and prints the deploy command without a key.

The deploy key stays outside git. After deployment, set the MCP's `GRAPH_ENDPOINT` to the provider query endpoint and rerun the public MCP smoke. See `../../docs/THE_GRAPH_TRACK.md`.
