import { BigInt } from "@graphprotocol/graph-ts";
import {
  ClassAdapterSettled,
  ClassCapitalDeployed,
  ClassCapitalReturned,
  ClassPaused,
  ClassRegistered,
  ClassStrategistSet,
  ClassUnpaused,
  ClassVenueSettled,
  CompositionConverted,
  FrontLandingShortfall,
  FrontingReleaseLimitSet,
  SegregatedFeesReconciled,
  SetBoundsUpdated,
  SettlementRouteSet,
  StrategyPnLClaimed,
  VaultDeposit,
  VenueOutflowLimitSet
} from "../generated/templates/AssetVault/AssetVault";
import {
  ClassAdapterSettledEvent,
  ClassCapitalDeployedEvent,
  ClassCapitalReturnedEvent,
  ClassPausedEvent,
  ClassRegisteredEvent,
  ClassStrategistSetEvent,
  ClassUnpausedEvent,
  ClassVenueSettledEvent,
  CompositionConvertedEvent,
  FrontLandingShortfallEvent,
  FrontLifecycleEvent,
  StrategyCapitalReturnedEvent,
  StrategyCapitalSourcedEvent,
  StrategyFeeAccruedEvent,
  StrategyReturnLossEvent,
  VaultDepositEvent
} from "../generated/schema";
import {
  eventId,
  network,
  refreshLPStrategyPosition,
  refreshLPVaultPosition,
  refreshStrategyVault,
  refreshVault
} from "./common";

export function handleVaultDeposit(event: VaultDeposit): void {
  const history = new VaultDepositEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.caller = event.params.caller;
  history.receiver = event.params.receiver;
  history.assets = event.params.assets;
  history.save();

  refreshVault(event.params.vault, event);
  refreshLPVaultPosition(event.params.vault, event.params.receiver, event);
  if (event.params.caller.toHexString() != event.params.receiver.toHexString()) {
    refreshLPVaultPosition(event.params.vault, event.params.caller, event);
  }
}

export function handleClassRegistered(event: ClassRegistered): void {
  const history = new ClassRegisteredEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.save();

  refreshVault(event.params.vault, event);
  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
}

export function handleClassStrategistSet(event: ClassStrategistSet): void {
  const history = new ClassStrategistSetEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.strategist = event.params.strategist;
  history.save();

  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
}

export function handleClassPaused(event: ClassPaused): void {
  const history = new ClassPausedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.save();

  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
}

export function handleClassUnpaused(event: ClassUnpaused): void {
  const history = new ClassUnpausedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.save();

  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
}

export function handleClassCapitalDeployed(event: ClassCapitalDeployed): void {
  const history = new ClassCapitalDeployedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.venue = event.params.venue;
  history.amount = event.params.amount;
  history.save();

  const sourced = new StrategyCapitalSourcedEvent(eventId(event) + "-sourced");
  sourced.txHash = event.transaction.hash;
  sourced.logIndex = event.logIndex;
  sourced.blockNumber = event.block.number;
  sourced.timestamp = event.block.timestamp;
  sourced.network = network();
  sourced.vault = event.params.vault;
  sourced.strategyId = event.params.strategyId;
  sourced.venue = event.params.venue;
  sourced.amount = event.params.amount;
  sourced.save();

  refreshVault(event.params.vault, event);
  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
}

export function handleClassCapitalReturned(event: ClassCapitalReturned): void {
  const history = new ClassCapitalReturnedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.venue = event.params.venue;
  history.amount = event.params.amount;
  history.save();

  const returned = new StrategyCapitalReturnedEvent(eventId(event) + "-returned");
  returned.txHash = event.transaction.hash;
  returned.logIndex = event.logIndex;
  returned.blockNumber = event.block.number;
  returned.timestamp = event.block.timestamp;
  returned.network = network();
  returned.vault = event.params.vault;
  returned.strategyId = event.params.strategyId;
  returned.venue = event.params.venue;
  returned.amount = event.params.amount;
  returned.save();

  refreshVault(event.params.vault, event);
  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
}

export function handleClassAdapterSettled(event: ClassAdapterSettled): void {
  const history = new ClassAdapterSettledEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.adapter = event.params.adapter;
  history.realizedPnL = event.params.realizedPnL;
  history.save();

  if (event.params.realizedPnL.lt(BIGINT_ZERO)) {
    const loss = new StrategyReturnLossEvent(eventId(event) + "-loss");
    loss.txHash = event.transaction.hash;
    loss.logIndex = event.logIndex;
    loss.blockNumber = event.block.number;
    loss.timestamp = event.block.timestamp;
    loss.network = network();
    loss.vault = event.params.vault;
    loss.strategyId = event.params.strategyId;
    loss.amount = event.params.realizedPnL.times(BIGINT_NEG_ONE);
    loss.save();
  }

  refreshVault(event.params.vault, event);
  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
}

export function handleClassVenueSettled(event: ClassVenueSettled): void {
  const history = new ClassVenueSettledEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.venue = event.params.venue;
  history.netToStrategy = event.params.netToStrategy;
  history.save();

  if (event.params.netToStrategy.lt(BIGINT_ZERO)) {
    const loss = new StrategyReturnLossEvent(eventId(event) + "-loss");
    loss.txHash = event.transaction.hash;
    loss.logIndex = event.logIndex;
    loss.blockNumber = event.block.number;
    loss.timestamp = event.block.timestamp;
    loss.network = network();
    loss.vault = event.params.vault;
    loss.strategyId = event.params.strategyId;
    loss.amount = event.params.netToStrategy.times(BIGINT_NEG_ONE);
    loss.save();
  }

  refreshVault(event.params.vault, event);
  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
}

export function handleCompositionConverted(event: CompositionConverted): void {
  const history = new CompositionConvertedEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.lp = event.params.lp;
  history.assets = event.params.assets;
  history.save();

  refreshVault(event.params.vault, event);
  refreshLPVaultPosition(event.params.vault, event.params.lp, event);
  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
  refreshLPStrategyPosition(event.params.vault, event.params.lp, event.params.strategyId, event);
}

export function handleFrontLandingShortfall(event: FrontLandingShortfall): void {
  const history = new FrontLandingShortfallEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.frontId = event.params.frontId;
  history.settlementId = event.params.settlementId;
  history.shortfall = event.params.shortfall;
  history.save();

  const lifecycle = new FrontLifecycleEvent(eventId(event) + "-front");
  lifecycle.txHash = event.transaction.hash;
  lifecycle.logIndex = event.logIndex;
  lifecycle.blockNumber = event.block.number;
  lifecycle.timestamp = event.block.timestamp;
  lifecycle.network = network();
  lifecycle.vault = event.params.vault;
  lifecycle.strategyId = event.params.strategyId;
  lifecycle.frontId = event.params.frontId;
  lifecycle.settlementId = event.params.settlementId;
  lifecycle.action = "LANDING_SHORTFALL";
  lifecycle.shortfall = event.params.shortfall;
  lifecycle.save();

  refreshVault(event.params.vault, event);
  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
}

export function handleFrontingReleaseLimitSet(event: FrontingReleaseLimitSet): void {
  refreshVault(event.params.vault, event);
}

export function handleVenueOutflowLimitSet(event: VenueOutflowLimitSet): void {
  refreshVault(event.params.vault, event);
}

export function handleSegregatedFeesReconciled(event: SegregatedFeesReconciled): void {
  const fee = new StrategyFeeAccruedEvent(eventId(event) + "-segregated-fee");
  fee.txHash = event.transaction.hash;
  fee.logIndex = event.logIndex;
  fee.blockNumber = event.block.number;
  fee.timestamp = event.block.timestamp;
  fee.network = network();
  fee.vault = event.params.vault;
  fee.strategyId = BIGINT_ZERO;
  fee.assets = event.params.amount;
  fee.save();

  refreshVault(event.params.vault, event);
}

export function handleSetBoundsUpdated(event: SetBoundsUpdated): void {
  refreshVault(event.params.vault, event);
}

export function handleSettlementRouteSet(event: SettlementRouteSet): void {
  refreshVault(event.params.vault, event);
  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
}

export function handleStrategyPnLClaimed(event: StrategyPnLClaimed): void {
  refreshVault(event.params.vault, event);
  refreshLPVaultPosition(event.params.vault, event.params.owner, event);
  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
  refreshLPStrategyPosition(event.params.vault, event.params.owner, event.params.strategyId, event);
}

const BIGINT_ZERO = BigInt.fromI32(0);
const BIGINT_NEG_ONE = BigInt.fromI32(-1);
