import { PausedAll, VaultCreated, VaultFactory } from "../generated/VaultFactory/VaultFactory";
import { AssetVault as AssetVaultTemplate } from "../generated/templates";
import { VaultCreatedEvent } from "../generated/schema";
import { eventId, network, refreshVault } from "./common";

export function handleVaultCreated(event: VaultCreated): void {
  const vault = refreshVault(event.params.vault, event);
  vault.asset = event.params.asset;
  vault.name = event.params.name;
  vault.symbol = event.params.symbol;
  vault.createdAtTxHash = event.transaction.hash;
  vault.createdAtBlock = event.block.number;
  vault.createdAtTimestamp = event.block.timestamp;
  vault.save();

  const history = new VaultCreatedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.asset = event.params.asset;
  history.vault = event.params.vault;
  history.name = event.params.name;
  history.symbol = event.params.symbol;
  history.save();

  AssetVaultTemplate.create(event.params.vault);
}

export function handlePausedAll(event: PausedAll): void {
  const factory = VaultFactory.bind(event.address);
  const vaults = factory.try_vaults();
  if (vaults.reverted) return;
  for (let i = 0; i < vaults.value.length; i += 1) {
    refreshVault(vaults.value[i], event);
  }
}
