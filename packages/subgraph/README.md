# Aqua0 Shape-C Subgraph

This package indexes the current Aqua0 Shape-C shared-pool `AssetVault` fleet. It is not an old SLP subgraph.

## Base Mainnet

`subgraph.base.yaml` is the live Base manifest for Graph qualification.

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

## Arc Testnet

Arc contract addresses are not hard-coded. When the Arc deployments land, generate `subgraph.arc.yaml` with public environment variables:

```sh
PUBLIC_ARC_VAULT_FACTORY=0x... \
PUBLIC_ARC_VAULT_REGISTRY=0x... \
PUBLIC_ARC_COMPOSER=0x... \
PUBLIC_ARC_FILLER_REGISTRY=0x... \
PUBLIC_ARC_AQUA_ADAPTER=0x... \
PUBLIC_ARC_V4_ADAPTER=0x... \
PUBLIC_ARC_START_BLOCK=123456 \
pnpm --filter @aqua0/subgraph generate:arc
```

The generated manifest uses Graph network `arc-testnet`. Arc chain id `5042002` and RPC configuration live in `@aqua0/shared`.

## Development

```sh
pnpm install
pnpm --filter @aqua0/subgraph codegen
pnpm --filter @aqua0/subgraph graph:build
```

Root workspace helpers:

```sh
pnpm graph:codegen
pnpm graph:build
```

## Graph Studio

Use your own Studio slug and deploy key:

```sh
graph auth --studio <DEPLOY_KEY>
graph codegen packages/subgraph/subgraph.base.yaml
graph build packages/subgraph/subgraph.base.yaml
graph deploy --studio <SUBGRAPH_SLUG> packages/subgraph/subgraph.base.yaml
```

For Arc after addresses exist:

```sh
pnpm --filter @aqua0/subgraph generate:arc
graph codegen packages/subgraph/subgraph.arc.yaml
graph build packages/subgraph/subgraph.arc.yaml
graph deploy --studio <ARC_SUBGRAPH_SLUG> packages/subgraph/subgraph.arc.yaml
```
