import { writeFileSync } from "node:fs";

const required = [
  ["PUBLIC_ARC_VAULT_FACTORY", "VaultFactory"],
  ["PUBLIC_ARC_VAULT_REGISTRY", "VaultRegistry"],
  ["PUBLIC_ARC_COMPOSER", "Composer"],
  ["PUBLIC_ARC_FILLER_REGISTRY", "FillerRegistry"],
  ["PUBLIC_ARC_AQUA_ADAPTER", "AquaAdapter"],
  ["PUBLIC_ARC_V4_ADAPTER", "V4Adapter"],
  ["PUBLIC_ARC_START_BLOCK", "start block"]
];

const values = new Map();
const missing = [];

for (const [envName] of required) {
  const value = process.env[envName];
  if (!value || value.trim() === "") {
    missing.push(envName);
  } else {
    values.set(envName, value.trim());
  }
}

if (missing.length > 0) {
  console.error(
    `Missing Arc manifest environment variables: ${missing.join(", ")}.\n` +
      "Set the public Arc deployment addresses and PUBLIC_ARC_START_BLOCK; this script will not invent contract addresses."
  );
  process.exit(1);
}

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
for (const [envName, label] of required.slice(0, 6)) {
  const value = values.get(envName);
  if (!addressPattern.test(value)) {
    console.error(`${envName} for ${label} must be a 20-byte EVM address, received: ${value}`);
    process.exit(1);
  }
}

const startBlock = values.get("PUBLIC_ARC_START_BLOCK");
if (!/^[0-9]+$/.test(startBlock)) {
  console.error(`PUBLIC_ARC_START_BLOCK must be a non-negative integer, received: ${startBlock}`);
  process.exit(1);
}

const manifest = `specVersion: 1.3.0
indexerHints:
  prune: auto
schema:
  file: ./schema.graphql
dataSources:
  - kind: ethereum/contract
    name: VaultFactory
    network: arc-testnet
    source:
      address: "${values.get("PUBLIC_ARC_VAULT_FACTORY")}"
      abi: VaultFactory
      startBlock: ${startBlock}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      entities:
        - Vault
        - VaultCreatedEvent
      abis:
        - name: VaultFactory
          file: ./abis/VaultFactory.json
        - name: AssetVault
          file: ./abis/AssetVault.json
      eventHandlers:
        - event: VaultCreated(indexed address,indexed address,string,string)
          handler: handleVaultCreated
      file: ./src/vault-factory.ts
  - kind: ethereum/contract
    name: VaultRegistry
    network: arc-testnet
    source:
      address: "${values.get("PUBLIC_ARC_VAULT_REGISTRY")}"
      abi: VaultRegistry
      startBlock: ${startBlock}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      entities:
        - Strategy
        - VaultRegisteredEvent
        - VaultDeregisteredEvent
      abis:
        - name: VaultRegistry
          file: ./abis/VaultRegistry.json
      eventHandlers:
        - event: StrategyClassRegistered(indexed bytes32,indexed uint256)
          handler: handleStrategyClassRegistered
        - event: VaultRegistered(indexed address,indexed address)
          handler: handleVaultRegistered
        - event: VaultDeregistered(indexed address,indexed address)
          handler: handleVaultDeregistered
      file: ./src/vault-registry.ts
  - kind: ethereum/contract
    name: Composer
    network: arc-testnet
    source:
      address: "${values.get("PUBLIC_ARC_COMPOSER")}"
      abi: Composer
      startBlock: ${startBlock}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      entities:
        - ComposerExecutedEvent
        - FrontLifecycleEvent
      abis:
        - name: Composer
          file: ./abis/Composer.json
      eventHandlers:
        - event: ComposerExecuted(indexed address,indexed address,uint8,uint256,int256,uint256)
          handler: handleComposerExecuted
      file: ./src/composer.ts
  - kind: ethereum/contract
    name: FillerRegistry
    network: arc-testnet
    source:
      address: "${values.get("PUBLIC_ARC_FILLER_REGISTRY")}"
      abi: FillerRegistry
      startBlock: ${startBlock}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      entities:
        - FillerParticipant
        - FillerParticipationSetEvent
      abis:
        - name: FillerRegistry
          file: ./abis/FillerRegistry.json
      eventHandlers:
        - event: FillerParticipationSet(indexed address,bool,uint256)
          handler: handleFillerParticipationSet
      file: ./src/filler-registry.ts
  - kind: ethereum/contract
    name: AquaAdapter
    network: arc-testnet
    source:
      address: "${values.get("PUBLIC_ARC_AQUA_ADAPTER")}"
      abi: AquaAdapter
      startBlock: ${startBlock}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      entities:
        - AquaStrategyShippedEvent
        - AquaStrategyDockedEvent
        - AquaStrategyReshippedEvent
        - AquaStrategyReconciledEvent
      abis:
        - name: AquaAdapter
          file: ./abis/AquaAdapter.json
      eventHandlers:
        - event: AdapterStrategyShipped(indexed address,indexed bytes32,address[],uint256[])
          handler: handleAdapterStrategyShipped
        - event: AdapterStrategyDocked(indexed address,indexed bytes32,bytes32)
          handler: handleAdapterStrategyDocked
        - event: AdapterStrategyEmergencyDocked(indexed address,indexed bytes32,bytes32)
          handler: handleAdapterStrategyEmergencyDocked
        - event: AdapterStrategyReshipped(indexed address,indexed bytes32,bytes32,bytes32,uint256[])
          handler: handleAdapterStrategyReshipped
        - event: AdapterStrategyReconciled(indexed address,indexed bytes32,address[],uint256[],uint256[])
          handler: handleAdapterStrategyReconciled
        - event: AdapterStrategyForceCleared(indexed address,indexed bytes32,bytes32,bool)
          handler: handleAdapterStrategyForceCleared
      file: ./src/aqua-adapter.ts
  - kind: ethereum/contract
    name: V4Adapter
    network: arc-testnet
    source:
      address: "${values.get("PUBLIC_ARC_V4_ADAPTER")}"
      abi: V4Adapter
      startBlock: ${startBlock}
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      entities:
        - V4SwapSettledEvent
      abis:
        - name: V4Adapter
          file: ./abis/V4Adapter.json
      eventHandlers:
        - event: V4SwapSettled(indexed address,indexed uint256,indexed bytes32,address,int256,address,int256)
          handler: handleV4SwapSettled
      file: ./src/v4-adapter.ts
templates:
  - kind: ethereum/contract
    name: AssetVault
    network: arc-testnet
    source:
      abi: AssetVault
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      entities:
        - Vault
        - LPVaultPosition
        - Strategy
        - StrategyVault
        - LPStrategyPosition
      abis:
        - name: AssetVault
          file: ./abis/AssetVault.json
      eventHandlers:
        - event: VaultDeposit(indexed address,indexed address,indexed address,uint256)
          handler: handleVaultDeposit
        - event: ClassRegistered(indexed address,indexed uint256)
          handler: handleClassRegistered
        - event: ClassStrategistSet(indexed address,indexed uint256,indexed address)
          handler: handleClassStrategistSet
        - event: ClassPaused(indexed address,indexed uint256)
          handler: handleClassPaused
        - event: ClassUnpaused(indexed address,indexed uint256)
          handler: handleClassUnpaused
        - event: ClassCapitalDeployed(indexed address,indexed uint256,indexed address,uint256)
          handler: handleClassCapitalDeployed
        - event: ClassCapitalReturned(indexed address,indexed uint256,indexed address,uint256)
          handler: handleClassCapitalReturned
        - event: ClassAdapterSettled(indexed address,indexed uint256,indexed address,int256)
          handler: handleClassAdapterSettled
        - event: ClassVenueSettled(indexed address,indexed uint256,indexed address,int256)
          handler: handleClassVenueSettled
        - event: CompositionConverted(indexed address,indexed uint256,indexed address,uint256)
          handler: handleCompositionConverted
        - event: FrontLandingShortfall(indexed address,indexed uint256,indexed bytes32,bytes32,uint256)
          handler: handleFrontLandingShortfall
        - event: FrontingReleaseLimitSet(indexed address,uint256)
          handler: handleFrontingReleaseLimitSet
        - event: VenueOutflowLimitSet(indexed address,uint256)
          handler: handleVenueOutflowLimitSet
        - event: SegregatedFeesReconciled(indexed address,uint256)
          handler: handleSegregatedFeesReconciled
        - event: SetBoundsUpdated(indexed address,uint256,uint256)
          handler: handleSetBoundsUpdated
        - event: SettlementRouteSet(indexed address,indexed uint256,bytes32)
          handler: handleSettlementRouteSet
        - event: StrategyPnLClaimed(indexed address,indexed uint256,indexed address,address,uint256,uint256)
          handler: handleStrategyPnLClaimed
      file: ./src/asset-vault.ts
`;

writeFileSync(new URL("../subgraph.arc.yaml", import.meta.url), manifest);
console.log("Wrote packages/subgraph/subgraph.arc.yaml for Arc testnet (chainId 5042002).");
