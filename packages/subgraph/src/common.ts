import { Address, BigInt, Bytes, dataSource, ethereum } from "@graphprotocol/graph-ts";
import {
  LPStrategyPosition,
  LPVaultPosition,
  Strategy,
  StrategyVault,
  Vault
} from "../generated/schema";
import { AssetVault } from "../generated/templates/AssetVault/AssetVault";

export function eventId(event: ethereum.Event): string {
  return event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
}

export function network(): string {
  return dataSource.network();
}

export function strategyEntityId(strategyId: BigInt): string {
  return strategyId.toString();
}

export function vaultStrategyId(vault: Address, strategyId: BigInt): string {
  return vault.toHexString() + "-" + strategyId.toString();
}

export function lpVaultPositionId(vault: Address, lp: Address): string {
  return vault.toHexString() + "-" + lp.toHexString();
}

export function lpStrategyPositionId(vault: Address, lp: Address, strategyId: BigInt): string {
  return vault.toHexString() + "-" + lp.toHexString() + "-" + strategyId.toString();
}

export function addressesToBytes(values: Array<Address>): Array<Bytes> {
  const out = new Array<Bytes>();
  for (let i = 0; i < values.length; i++) {
    out.push(values[i]);
  }
  return out;
}

export function touchVault(vault: Address, event: ethereum.Event): Vault {
  let entity = Vault.load(vault.toHexString());
  if (entity == null) {
    entity = new Vault(vault.toHexString());
    entity.address = vault;
    entity.network = network();
    entity.createdAtBlock = event.block.number;
    entity.createdAtTimestamp = event.block.timestamp;
    entity.createdAtTxHash = event.transaction.hash;
  }
  entity.address = vault;
  entity.network = network();
  entity.updatedAtBlock = event.block.number;
  entity.updatedAtTimestamp = event.block.timestamp;
  return entity;
}

export function refreshVault(vault: Address, event: ethereum.Event): Vault {
  const entity = touchVault(vault, event);
  const contract = AssetVault.bind(vault);

  const asset = contract.try_asset();
  if (!asset.reverted) entity.asset = asset.value;

  const name = contract.try_name();
  if (!name.reverted) entity.name = name.value;

  const symbol = contract.try_symbol();
  if (!symbol.reverted) entity.symbol = symbol.value;

  const sharedIdle = contract.try_sharedIdle();
  if (!sharedIdle.reverted) entity.sharedIdle = sharedIdle.value;

  const totalDeployed = contract.try_totalDeployed();
  if (!totalDeployed.reverted) entity.totalDeployed = totalDeployed.value;

  const vaultLiveTvl = contract.try_vaultLiveTvl();
  if (!vaultLiveTvl.reverted) entity.vaultLiveTvl = vaultLiveTvl.value;

  const frontReservedAssets = contract.try_frontReservedAssets();
  if (!frontReservedAssets.reverted) entity.frontReservedAssets = frontReservedAssets.value;

  const segregatedFees = contract.try_segregatedFees();
  if (!segregatedFees.reverted) entity.segregatedFees = segregatedFees.value;

  const orphanedSegregatedFees = contract.try_orphanedSegregatedFees();
  if (!orphanedSegregatedFees.reverted) entity.orphanedSegregatedFees = orphanedSegregatedFees.value;

  const paused = contract.try_paused();
  if (!paused.reverted) entity.paused = paused.value;

  entity.save();
  return entity;
}

export function refreshLPVaultPosition(vault: Address, lp: Address, event: ethereum.Event): LPVaultPosition {
  const id = lpVaultPositionId(vault, lp);
  let entity = LPVaultPosition.load(id);
  if (entity == null) {
    entity = new LPVaultPosition(id);
    entity.vault = vault;
    entity.lp = lp;
    entity.network = network();
  }
  entity.updatedAtBlock = event.block.number;
  entity.updatedAtTimestamp = event.block.timestamp;

  const contract = AssetVault.bind(vault);

  const principal = contract.try_principal(lp);
  if (!principal.reverted) entity.principal = principal.value;

  const credit = contract.try_credit(lp);
  if (!credit.reverted) entity.credit = credit.value;

  const deployedByLp = contract.try_deployedByLp(lp);
  if (!deployedByLp.reverted) entity.deployedByLp = deployedByLp.value;

  const freePrincipal = contract.try_freePrincipal(lp);
  if (!freePrincipal.reverted) entity.freePrincipal = freePrincipal.value;

  const frontHeldPrincipal = contract.try_frontHeldPrincipal(lp);
  if (!frontHeldPrincipal.reverted) entity.frontHeldPrincipal = frontHeldPrincipal.value;

  const asyncHeld = contract.try_asyncHeld(lp);
  if (!asyncHeld.reverted) entity.asyncHeld = asyncHeld.value;

  entity.save();
  return entity;
}

export function touchStrategy(strategyId: BigInt, event: ethereum.Event): Strategy {
  const id = strategyEntityId(strategyId);
  let entity = Strategy.load(id);
  if (entity == null) {
    entity = new Strategy(id);
    entity.strategyId = strategyId;
    entity.network = network();
    entity.firstSeenBlock = event.block.number;
    entity.firstSeenTimestamp = event.block.timestamp;
  }
  entity.updatedAtBlock = event.block.number;
  entity.updatedAtTimestamp = event.block.timestamp;
  entity.save();
  return entity;
}

export function refreshStrategyVault(vault: Address, strategyId: BigInt, event: ethereum.Event): StrategyVault {
  touchStrategy(strategyId, event);

  const id = vaultStrategyId(vault, strategyId);
  let entity = StrategyVault.load(id);
  if (entity == null) {
    entity = new StrategyVault(id);
    entity.vault = vault;
    entity.strategyId = strategyId;
    entity.network = network();
  }
  entity.updatedAtBlock = event.block.number;
  entity.updatedAtTimestamp = event.block.timestamp;

  const contract = AssetVault.bind(vault);

  const exists = contract.try_classExists(strategyId);
  if (!exists.reverted) entity.exists = exists.value;

  const strategist = contract.try_classStrategist(strategyId);
  if (!strategist.reverted) entity.strategist = strategist.value;

  const paused = contract.try_classPaused(strategyId);
  if (!paused.reverted) entity.paused = paused.value;

  const committedBacking = contract.try_committedBacking(strategyId);
  if (!committedBacking.reverted) entity.committedBacking = committedBacking.value;

  const deployedAssets = contract.try_deployedAssets(strategyId);
  if (!deployedAssets.reverted) entity.deployedAssets = deployedAssets.value;

  const availableFor = contract.try_availableFor(strategyId);
  if (!availableFor.reverted) entity.availableFor = availableFor.value;

  const sharePriceRay = contract.try_sharePriceRay(strategyId);
  if (!sharePriceRay.reverted) entity.sharePriceRay = sharePriceRay.value;

  const settlementRoute = contract.try_settlementRoute(strategyId);
  if (!settlementRoute.reverted) entity.settlementRoute = settlementRoute.value;

  entity.save();
  return entity;
}

export function refreshLPStrategyPosition(
  vault: Address,
  lp: Address,
  strategyId: BigInt,
  event: ethereum.Event
): LPStrategyPosition {
  const id = lpStrategyPositionId(vault, lp, strategyId);
  let entity = LPStrategyPosition.load(id);
  if (entity == null) {
    entity = new LPStrategyPosition(id);
    entity.vault = vault;
    entity.lp = lp;
    entity.strategyId = strategyId;
    entity.network = network();
  }
  entity.updatedAtBlock = event.block.number;
  entity.updatedAtTimestamp = event.block.timestamp;

  const contract = AssetVault.bind(vault);

  const committed = contract.try_committed(lp, strategyId);
  if (!committed.reverted) entity.committed = committed.value;

  const deployedInto = contract.try_deployedInto(lp, strategyId);
  if (!deployedInto.reverted) entity.deployedInto = deployedInto.value;

  const composition = contract.try_composition(strategyId, lp);
  if (!composition.reverted) entity.composition = composition.value;

  const feeCheckpointRay = contract.try_feeCheckpointRay(lp, strategyId);
  if (!feeCheckpointRay.reverted) entity.feeCheckpointRay = feeCheckpointRay.value;

  entity.save();
  return entity;
}
