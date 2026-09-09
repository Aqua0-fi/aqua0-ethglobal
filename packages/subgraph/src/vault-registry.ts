import {
  StrategyClassRegistered,
  VaultDeregistered,
  VaultRegistered
} from "../generated/VaultRegistry/VaultRegistry";
import { Strategy, VaultDeregisteredEvent, VaultRegisteredEvent } from "../generated/schema";
import { eventId, network, refreshVault, strategyEntityId } from "./common";

export function handleStrategyClassRegistered(event: StrategyClassRegistered): void {
  const id = strategyEntityId(event.params.classId);
  let strategy = Strategy.load(id);
  if (strategy == null) {
    strategy = new Strategy(id);
    strategy.strategyId = event.params.classId;
    strategy.network = network();
    strategy.firstSeenBlock = event.block.number;
    strategy.firstSeenTimestamp = event.block.timestamp;
  }
  strategy.strategyKey = event.params.strategyKey;
  strategy.registry = event.address;
  strategy.updatedAtBlock = event.block.number;
  strategy.updatedAtTimestamp = event.block.timestamp;
  strategy.save();
}

export function handleVaultRegistered(event: VaultRegistered): void {
  const vault = refreshVault(event.params.vault, event);
  vault.asset = event.params.asset;
  vault.save();

  const history = new VaultRegisteredEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.asset = event.params.asset;
  history.vault = event.params.vault;
  history.save();
}

export function handleVaultDeregistered(event: VaultDeregistered): void {
  const history = new VaultDeregisteredEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.asset = event.params.asset;
  history.vault = event.params.vault;
  history.save();
}
