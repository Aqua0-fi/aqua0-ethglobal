import {
  AdapterStrategyDocked,
  AdapterStrategyEmergencyDocked,
  AdapterStrategyForceCleared,
  AdapterStrategyReconciled,
  AdapterStrategyReshipped,
  AdapterStrategyShipped
} from "../generated/AquaAdapter/AquaAdapter";
import {
  AquaStrategyDockedEvent,
  AquaStrategyForceClearedEvent,
  AquaStrategyReconciledEvent,
  AquaStrategyReshippedEvent,
  AquaStrategyShippedEvent
} from "../generated/schema";
import { addressesToBytes, eventId, network } from "./common";

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
}

export function handleAdapterStrategyDocked(event: AdapterStrategyDocked): void {
  saveDocked(event, false);
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
