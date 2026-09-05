# Aqua0 Shape-C Subgraph

This package indexes the current Aqua0 Shape-C shared-capital `AssetVault` fleet.

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

The canonical library-scoped Shape-C accounting events come from `abis/Events.json`. `test:required-events` guards the required event set so an ABI-generation change cannot silently drop accounting/fronting history.

## Arc Testnet

The live Arc deployment is recorded in `../../deployments/arc-testnet.json`. Generate `subgraph.arc.yaml` from the canonical Base manifest with the real core addresses:

```sh
PUBLIC_ARC_VAULT_FACTORY=0x879C0c90205172a8DD66afB8124994D866372FBa \
PUBLIC_ARC_VAULT_REGISTRY=0x9E094b21C4263e0BE5BEffa0f8296B3fd982fFFf \
PUBLIC_ARC_COMPOSER=0x656F28021a624aDfA0d92dDFdBb20577674aFEC7 \
PUBLIC_ARC_FILLER_REGISTRY=0xa8e08346DD7b6809C47A920c365bCC987Ea91297 \
PUBLIC_ARC_START_BLOCK=60613306 \
pnpm --filter @aqua0/subgraph generate:arc
```

`PUBLIC_ARC_AQUA_ADAPTER` and `PUBLIC_ARC_V4_ADAPTER` are optional and are omitted until real adapter deployments exist. The generated manifest uses Graph network `arc-testnet`; Arc chain id is `5042002`.

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

The deploy key stays outside git. After deployment, set the MCP's `GRAPH_ENDPOINT` to the provider query endpoint and rerun the public MCP smoke. See `../../docs/THE_GRAPH_TRACK.md`.
