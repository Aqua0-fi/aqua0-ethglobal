import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  AdapterOneStrategyPerTokenSet,
  AdapterStrategyDocked,
  AdapterStrategyEmergencyDocked,
  AdapterStrategyForceCleared,
  AdapterStrategyReconciled,
  AdapterStrategyReshipped,
  AdapterStrategyShipped,
  AquaAdapter as AquaAdapterContract
} from "../generated/AquaAdapter/AquaAdapter";
import {
  AquaAdapterOneStrategyPerTokenSetEvent,
  AquaOrder,
  AquaStrategy,
  AquaStrategyDockedEvent,
  AquaStrategyForceClearedEvent,
  AquaStrategyReconciledEvent,
  AquaStrategyReshippedEvent,
  AquaStrategyShippedEvent,
  AquaVenueAdapter
} from "../generated/schema";
import { aquaOrderEntityId, aquaStrategyEntityId, contextVenue } from "./aqua-venue";
import { addressesToBytes, eventId, network, strategyEntityId } from "./common";

const ONE = BigInt.fromI32(1);

function touchAdapter(adapter: Address, event: ethereum.Event): AquaVenueAdapter {
  const id = adapter.toHexString();
  let entity = AquaVenueAdapter.load(id);
  if (entity == null) {
    entity = new AquaVenueAdapter(id);
    entity.address = adapter;
    entity.network = network();
    entity.strategyCount = BigInt.zero();
    entity.fillCount = BigInt.zero();
    entity.firstSeenBlock = event.block.number;
    // "pegged" | "fxswap" from the data source context (null on manifests without it, e.g. Base).
    entity.venue = contextVenue();

    const contract = AquaAdapterContract.bind(adapter);
    const aqua = contract.try_aqua();
    if (!aqua.reverted) entity.aqua = aqua.value;
    const router = contract.try_aquaSwapVMRouter();
    if (!router.reverted) entity.swapVMRouter = router.value;
    const oneStrategyPerToken = contract.try_oneStrategyPerToken();
    if (!oneStrategyPerToken.reverted) entity.oneStrategyPerToken = oneStrategyPerToken.value;
  }
  entity.updatedAtBlock = event.block.number;
  entity.updatedAtTimestamp = event.block.timestamp;
  return entity;
}

function loadOrCreateStrategy(adapter: AquaVenueAdapter, strategyId: Bytes, event: ethereum.Event): AquaStrategy {
  const id = aquaStrategyEntityId(Address.fromBytes(adapter.address), strategyId);
  let entity = AquaStrategy.load(id);
  if (entity == null) {
    entity = new AquaStrategy(id);
    entity.adapter = adapter.id;
    entity.strategyId = strategyId;
    entity.venue = adapter.venue;
    entity.network = network();
    entity.status = "LIVE";
    entity.tokens = new Array<Bytes>();
    entity.shippedAmounts = new Array<BigInt>();
    entity.shipCount = BigInt.zero();
    entity.reshipCount = BigInt.zero();
    entity.fillCount = BigInt.zero();
    entity.shippedAtBlock = event.block.number;
    entity.shippedAtTimestamp = event.block.timestamp;
    entity.shippedAtTxHash = event.transaction.hash;
    adapter.strategyCount = adapter.strategyCount.plus(ONE);
  }
  entity.updatedAtBlock = event.block.number;
  entity.updatedAtTimestamp = event.block.timestamp;
  return entity;
}

// Class id and fee are adapter storage, not event params: read them at the ship/reship block. A strategy docked
// in the same block reads back zero; the class id then falls back to the fill's vault settlement.
function refreshStrategyTerms(strategy: AquaStrategy, adapter: Address, strategyId: Bytes): void {
  const contract = AquaAdapterContract.bind(adapter);
  const classId = contract.try_strategyClassId(strategyId);
  if (!classId.reverted && !classId.value.isZero()) {
    strategy.classId = classId.value;
    strategy.strategy = strategyEntityId(classId.value);
  }
  const feePpb = contract.try_strategyFeePpb(strategyId);
  if (!feePpb.reverted) strategy.feePpb = feePpb.value;
}

function activateOrder(
  adapter: AquaVenueAdapter,
  strategy: AquaStrategy,
  orderHash: Bytes,
  event: ethereum.Event
): void {
  const maker = Address.fromBytes(adapter.address);
  const id = aquaOrderEntityId(maker, orderHash);
  let order = AquaOrder.load(id);
  if (order == null) {
    order = new AquaOrder(id);
    order.orderHash = orderHash;
    order.maker = maker;
    order.adapter = adapter.id;
    order.network = network();
    order.fillCount = BigInt.zero();
  }
  order.aquaStrategy = strategy.id;
  order.active = true;
  order.shippedAtBlock = event.block.number;
  order.shippedAtTimestamp = event.block.timestamp;
  order.shippedAtTxHash = event.transaction.hash;
  order.retiredAtBlock = null;
  order.retiredAtTimestamp = null;
  order.save();

  strategy.currentOrderHash = orderHash;
  strategy.currentOrder = id;
}

function retireOrder(adapter: Address, orderHash: Bytes, event: ethereum.Event): void {
  const order = AquaOrder.load(aquaOrderEntityId(adapter, orderHash));
  if (order == null) return;
  order.active = false;
  order.retiredAtBlock = event.block.number;
  order.retiredAtTimestamp = event.block.timestamp;
  order.save();
}

function closeStrategy(
  adapterAddress: Address,
  strategyId: Bytes,
  lastHash: Bytes,
  status: string,
  event: ethereum.Event
): void {
  const adapter = touchAdapter(adapterAddress, event);
  const strategy = loadOrCreateStrategy(adapter, strategyId, event);
  retireOrder(adapterAddress, lastHash, event);
  strategy.status = status;
  strategy.currentOrderHash = null;
  strategy.currentOrder = null;
  strategy.save();
  adapter.save();
}

export function handleAdapterStrategyShipped(event: AdapterStrategyShipped): void {
  const history = new AquaStrategyShippedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.adapter = event.params.adapter;
  history.strategyId = event.params.strategyId;
  history.tokens = addressesToBytes(event.params.tokens);
  history.amounts = event.params.amounts;
  history.save();

  const adapter = touchAdapter(event.address, event);
  const strategy = loadOrCreateStrategy(adapter, event.params.strategyId, event);
  strategy.status = "LIVE";
  strategy.tokens = addressesToBytes(event.params.tokens);
  strategy.shippedAmounts = event.params.amounts;
  strategy.shipCount = strategy.shipCount.plus(ONE);
  strategy.shippedAtBlock = event.block.number;
  strategy.shippedAtTimestamp = event.block.timestamp;
  strategy.shippedAtTxHash = event.transaction.hash;
  refreshStrategyTerms(strategy, event.address, event.params.strategyId);
  // A fresh ship's Aqua order hash is the strategy id (keccak256 of the shipped order bytes).
  activateOrder(adapter, strategy, event.params.strategyId, event);
  strategy.save();
  adapter.save();
}

export function handleAdapterStrategyDocked(event: AdapterStrategyDocked): void {
  saveDocked(event, false);
  closeStrategy(event.address, event.params.strategyId, event.params.aquaHash, "DOCKED", event);
}

export function handleAdapterStrategyEmergencyDocked(event: AdapterStrategyEmergencyDocked): void {
  const history = new AquaStrategyDockedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.adapter = event.params.adapter;
  history.strategyId = event.params.strategyId;
  history.aquaHash = event.params.aquaHash;
  history.emergency = true;
  history.save();

  closeStrategy(event.address, event.params.strategyId, event.params.aquaHash, "EMERGENCY_DOCKED", event);
}

export function handleAdapterStrategyReshipped(event: AdapterStrategyReshipped): void {
  const history = new AquaStrategyReshippedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.adapter = event.params.adapter;
  history.strategyId = event.params.strategyId;
  history.oldAquaHash = event.params.oldAquaHash;
  history.newAquaHash = event.params.newAquaHash;
  history.amounts = event.params.amounts;
  history.save();

  const adapter = touchAdapter(event.address, event);
  const strategy = loadOrCreateStrategy(adapter, event.params.strategyId, event);
  retireOrder(event.address, event.params.oldAquaHash, event);
  strategy.status = "LIVE";
  strategy.shippedAmounts = event.params.amounts;
  strategy.reshipCount = strategy.reshipCount.plus(ONE);
  if (strategy.classId === null) refreshStrategyTerms(strategy, event.address, event.params.strategyId);
  // After a reship the live hash is `newAquaHash`, no longer the strategy id; fills resolve through AquaOrder.
  activateOrder(adapter, strategy, event.params.newAquaHash, event);
  strategy.save();
  adapter.save();
}

export function handleAdapterStrategyReconciled(event: AdapterStrategyReconciled): void {
  const history = new AquaStrategyReconciledEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.adapter = event.params.adapter;
  history.strategyId = event.params.strategyId;
  history.tokens = addressesToBytes(event.params.tokens);
  history.shipped = event.params.shipped;
  history.venueReturned = event.params.venueReturned;
  history.save();
}

export function handleAdapterStrategyForceCleared(event: AdapterStrategyForceCleared): void {
  const history = new AquaStrategyForceClearedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.adapter = event.params.adapter;
  history.strategyId = event.params.strategyId;
  history.lastHash = event.params.lastHash;
  history.dockAttempted = event.params.dockAttempted;
  history.save();

  closeStrategy(event.address, event.params.strategyId, event.params.lastHash, "FORCE_CLEARED", event);
}

export function handleAdapterOneStrategyPerTokenSet(event: AdapterOneStrategyPerTokenSet): void {
  const history = new AquaAdapterOneStrategyPerTokenSetEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.adapter = event.params.adapter;
  history.enabled = event.params.enabled;
  history.save();

  const adapter = touchAdapter(event.address, event);
  adapter.oneStrategyPerToken = event.params.enabled;
  adapter.save();
}

function saveDocked(event: AdapterStrategyDocked, emergency: boolean): void {
  const history = new AquaStrategyDockedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.adapter = event.params.adapter;
  history.strategyId = event.params.strategyId;
  history.aquaHash = event.params.aquaHash;
  history.emergency = emergency;
  history.save();
}
