# Arc Testnet Deployment

The Shape-C core is live on Arc Testnet (chain `5042002`). Public addresses are committed in `deployments/arc-testnet.json`.

The deployment used the existing Aqua0 Shape-C contracts at source commit `8a9f1c2`. It deployed the registry, factory, composer, filler registry, shared AssetVault beacon/implementation, the Arc USDC vault, and two demo FX asset vaults (ARGt and BRAt). The venue/FXSwap adapter is intentionally separate and can be added to the Graph manifest later without inventing an address.

On-chain verification after deployment confirmed:

- all 28 deployment transactions succeeded;
- the registry reports three vaults and maps USDC/ARGt/BRAt to the expected vaults;
- the factory points to the deployed registry and beacon;
- the factory holds `REGISTRAR_ROLE` on the registry;
- the composer points to the deployed registry and filler registry;
- all three vaults grant `COMPOSER_ROLE` to the deployed composer.

Generate the Arc subgraph directly from the canonical Base manifest so event coverage cannot drift:

```bash
PUBLIC_ARC_VAULT_FACTORY=0x879C0c90205172a8DD66afB8124994D866372FBa \
PUBLIC_ARC_VAULT_REGISTRY=0x9E094b21C4263e0BE5BEffa0f8296B3fd982fFFf \
PUBLIC_ARC_COMPOSER=0x656F28021a624aDfA0d92dDFdBb20577674aFEC7 \
PUBLIC_ARC_FILLER_REGISTRY=0xa8e08346DD7b6809C47A920c365bCC987Ea91297 \
PUBLIC_ARC_START_BLOCK=60613306 \
pnpm --filter @aqua0/subgraph generate:arc
```

`PUBLIC_ARC_AQUA_ADAPTER` and `PUBLIC_ARC_V4_ADAPTER` are optional. Set them only after real adapter deployments exist; otherwise those data sources are omitted while the Shape-C core remains fully indexed.
