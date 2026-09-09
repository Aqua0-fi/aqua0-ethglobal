import { Address, BigInt, Entity, ethereum, Value } from "@graphprotocol/graph-ts";
import {
  ClassBridgeSettled,
  ClassAdapterSettled,
  ClassCapitalDeployed,
  ClassCapitalReturned,
  ClassClampHit,
  ClassGuardianVeto,
  ClassPaused,
  ClassPnLReported,
  ClassReconciliationMismatch,
  ClassRegistered,
  ClassSettlementClaimed,
  ClassSettlementRequested,
  ClassStrategistSet,
  ClassUnpaused,
  ClassVenueSettled,
  CompositionConverted,
  FrontAborted,
  FrontCancelled,
  FrontCommitted,
  FrontLandingCredited,
  FrontLandingShortfall,
  FrontLandingUnderpaid,
  FrontLocked,
  FrontObligationAborted,
  FrontObligationOpened,
  FrontObligationSettled,
  FrontReleased,
  FrontingReleaseLimitSet,
  Paused,
  SegregatedFeesReconciled,
  SetBoundsUpdated,
  SettlementRouteSet,
  StrategyCapitalReturned,
  StrategyCapitalSourced,
  StrategyCommitmentSet,
  StrategyDeployShortfall,
  StrategyFeeAccrued,
  StrategyPnLClaimed,
  StrategyPrincipalSold,
  StrategyReturnLoss,
  Unpaused,
  VaultDeposit,
  VaultWithdraw,
  VenueOutflowLimitSet
} from "../generated/templates/AssetVault/Events";
import {
  ClassAdapterSettledEvent,
  ClassBridgeSettledEvent,
  ClassCapitalDeployedEvent,
  ClassCapitalReturnedEvent,
  ClassClampHitEvent,
  ClassGuardianVetoEvent,
  ClassPausedEvent,
  ClassPnLReportedEvent,
  ClassReconciliationMismatchEvent,
  ClassRegisteredEvent,
  ClassSettlementClaimedEvent,
  ClassSettlementRequestedEvent,
  ClassStrategistSetEvent,
  ClassUnpausedEvent,
  ClassVenueSettledEvent,
  CompositionConvertedEvent,
  FrontLandingShortfallEvent,
  FrontLifecycleEvent,
  StrategyCapitalReturnedEvent,
  StrategyCapitalSourcedEvent,
  StrategyCommitmentSetEvent,
  StrategyDeployShortfallEvent,
  StrategyFeeAccruedEvent,
  StrategyPrincipalSoldEvent,
  StrategyReturnLossEvent,
  VaultDepositEvent,
  VaultWithdrawalEvent
} from "../generated/schema";
import {
  eventId,
  network,
  refreshLPStrategyPosition,
  refreshLPVaultPosition,
  refreshStrategyVault,
  refreshVault
} from "./common";

function stamp(history: Entity, event: ethereum.Event): void {
  history.set("txHash", Value.fromBytes(event.transaction.hash));
  history.set("logIndex", Value.fromBigInt(event.logIndex));
  history.set("blockNumber", Value.fromBigInt(event.block.number));
  history.set("timestamp", Value.fromBigInt(event.block.timestamp));
  history.set("network", Value.fromString(network()));
}

function refreshStrategyState(vault: Address, strategyId: BigInt, event: ethereum.Event): void {
  refreshVault(vault, event);
  refreshStrategyVault(vault, strategyId, event);
}

function refreshLPState(vault: Address, lp: Address, strategyId: BigInt, event: ethereum.Event): void {
  refreshLPVaultPosition(vault, lp, event);
  refreshLPStrategyPosition(vault, lp, strategyId, event);
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toHexString() == right.toHexString();
}

export function handleVaultPaused(event: Paused): void {
  refreshVault(event.address, event);
}

export function handleVaultUnpaused(event: Unpaused): void {
  refreshVault(event.address, event);
}

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

export function handleVaultWithdraw(event: VaultWithdraw): void {
  const history = new VaultWithdrawalEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.vault = event.params.vault;
  history.caller = event.params.caller;
  history.receiver = event.params.receiver;
  history.owner = event.params.owner;
  history.assets = event.params.assets;
  history.set("fromPrincipal", Value.fromBigInt(event.params.fromPrincipal));
  history.set("fromCredit", Value.fromBigInt(event.params.fromCredit));
  history.save();

  refreshVault(event.params.vault, event);
  refreshLPVaultPosition(event.params.vault, event.params.owner, event);
  if (!sameAddress(event.params.caller, event.params.owner)) {
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

  refreshVault(event.params.vault, event);
  refreshStrategyVault(event.params.vault, event.params.strategyId, event);
}

export function handleStrategyCommitmentSet(event: StrategyCommitmentSet): void {
  const history = new StrategyCommitmentSetEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.lp = event.params.lp;
  history.strategyId = event.params.strategyId;
  history.committed = event.params.backing;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.lp, event.params.strategyId, event);
}

export function handleStrategyCapitalSourced(event: StrategyCapitalSourced): void {
  const history = new StrategyCapitalSourcedEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.lp = event.params.lp;
  history.amount = event.params.amount;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.lp, event.params.strategyId, event);
}

export function handleStrategyCapitalReturned(event: StrategyCapitalReturned): void {
  const history = new StrategyCapitalReturnedEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.lp = event.params.lp;
  history.amount = event.params.amount;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.lp, event.params.strategyId, event);
}

export function handleStrategyDeployShortfall(event: StrategyDeployShortfall): void {
  const history = new StrategyDeployShortfallEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.lp = event.params.lp;
  history.charged = event.params.charged;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.lp, event.params.strategyId, event);
}

export function handleStrategyReturnLoss(event: StrategyReturnLoss): void {
  const history = new StrategyReturnLossEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.lp = event.params.lp;
  history.loss = event.params.loss;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.lp, event.params.strategyId, event);
}

export function handleStrategyPrincipalSold(event: StrategyPrincipalSold): void {
  const history = new StrategyPrincipalSoldEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.lp = event.params.lp;
  history.sold = event.params.sold;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.lp, event.params.strategyId, event);
}

export function handleStrategyFeeAccrued(event: StrategyFeeAccrued): void {
  const history = new StrategyFeeAccruedEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.lp = event.params.lp;
  history.credited = event.params.credited;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.lp, event.params.strategyId, event);
}

export function handleClassPnLReported(event: ClassPnLReported): void {
  const history = new ClassPnLReportedEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.epoch = event.params.epoch;
  history.xChainDelta = event.params.xChainDelta;
  history.sharePriceRayAfter = event.params.sharePriceRayAfter;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
}

export function handleClassGuardianVeto(event: ClassGuardianVeto): void {
  const history = new ClassGuardianVetoEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.guardian = event.params.guardian;
  history.reason = event.params.reason;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
}

export function handleClassClampHit(event: ClassClampHit): void {
  const history = new ClassClampHitEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.epoch = event.params.epoch;
  history.requestedDelta = event.params.requestedDelta;
  history.clampedDelta = event.params.clampedDelta;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
}

export function handleClassReconciliationMismatch(event: ClassReconciliationMismatch): void {
  const history = new ClassReconciliationMismatchEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.route = event.params.route;
  history.reportedDelta = event.params.reportedDelta;
  history.settledDelta = event.params.settledDelta;
  history.clawbackFromUnvested = event.params.clawbackFromUnvested;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
}

export function handleClassBridgeSettled(event: ClassBridgeSettled): void {
  const history = new ClassBridgeSettledEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.route = event.params.route;
  history.settlementId = event.params.settlementId;
  history.settledDelta = event.params.settledDelta;
  history.lossNetting = event.params.lossNetting;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
}

export function handleClassSettlementRequested(event: ClassSettlementRequested): void {
  const history = new ClassSettlementRequestedEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.controller = event.params.controller;
  history.requestId = event.params.requestId;
  history.assets = event.params.assets;
  history.route = event.params.route;
  history.requestedAt = event.params.requestedAt;
  history.claimableAt = event.params.claimableAt;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.controller, event.params.strategyId, event);
}

export function handleClassSettlementClaimed(event: ClassSettlementClaimed): void {
  const history = new ClassSettlementClaimedEvent(eventId(event));
  stamp(history, event);
  history.vault = event.params.vault;
  history.strategyId = event.params.strategyId;
  history.controller = event.params.controller;
  history.requestId = event.params.requestId;
  history.assets = event.params.assets;
  history.composerStruck = event.params.composerStruck;
  history.owner = event.params.owner;
  history.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.controller, event.params.strategyId, event);
  if (!sameAddress(event.params.controller, event.params.owner)) {
    refreshLPState(event.params.vault, event.params.owner, event.params.strategyId, event);
  }
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

export function handleFrontLocked(event: FrontLocked): void {
  const lifecycle = new FrontLifecycleEvent(eventId(event));
  stamp(lifecycle, event);
  lifecycle.vault = event.params.vault;
  lifecycle.strategyId = event.params.strategyId;
  lifecycle.frontId = event.params.frontId;
  lifecycle.owner = event.params.owner;
  lifecycle.amount = event.params.amount;
  lifecycle.action = "LOCKED";
  lifecycle.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.owner, event.params.strategyId, event);
}

export function handleFrontCommitted(event: FrontCommitted): void {
  const lifecycle = new FrontLifecycleEvent(eventId(event));
  stamp(lifecycle, event);
  lifecycle.vault = event.params.vault;
  lifecycle.strategyId = event.params.strategyId;
  lifecycle.frontId = event.params.frontId;
  lifecycle.action = "COMMITTED";
  lifecycle.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
}

export function handleFrontReleased(event: FrontReleased): void {
  const lifecycle = new FrontLifecycleEvent(eventId(event));
  stamp(lifecycle, event);
  lifecycle.vault = event.params.vault;
  lifecycle.strategyId = event.params.strategyId;
  lifecycle.frontId = event.params.frontId;
  lifecycle.assets = event.params.assets;
  lifecycle.action = "RELEASED";
  lifecycle.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
}

export function handleFrontCancelled(event: FrontCancelled): void {
  const lifecycle = new FrontLifecycleEvent(eventId(event));
  stamp(lifecycle, event);
  lifecycle.vault = event.params.vault;
  lifecycle.strategyId = event.params.strategyId;
  lifecycle.frontId = event.params.frontId;
  lifecycle.amountReturned = event.params.amountReturned;
  lifecycle.action = "CANCELLED";
  lifecycle.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
}

export function handleFrontAborted(event: FrontAborted): void {
  const lifecycle = new FrontLifecycleEvent(eventId(event));
  stamp(lifecycle, event);
  lifecycle.vault = event.params.vault;
  lifecycle.strategyId = event.params.strategyId;
  lifecycle.frontId = event.params.frontId;
  lifecycle.amountReturned = event.params.amountReturned;
  lifecycle.action = "ABORTED";
  lifecycle.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
}

export function handleFrontObligationOpened(event: FrontObligationOpened): void {
  const lifecycle = new FrontLifecycleEvent(eventId(event));
  stamp(lifecycle, event);
  lifecycle.vault = event.params.vault;
  lifecycle.strategyId = event.params.strategyId;
  lifecycle.frontId = event.params.frontId;
  lifecycle.filler = event.params.filler;
  lifecycle.beneficiary = event.params.beneficiary;
  lifecycle.pledged = event.params.pledged;
  lifecycle.feeOwed = event.params.feeOwed;
  lifecycle.action = "OBLIGATION_OPENED";
  lifecycle.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.filler, event.params.strategyId, event);
  if (!sameAddress(event.params.filler, event.params.beneficiary)) {
    refreshLPState(event.params.vault, event.params.beneficiary, event.params.strategyId, event);
  }
}

export function handleFrontObligationSettled(event: FrontObligationSettled): void {
  const lifecycle = new FrontLifecycleEvent(eventId(event));
  stamp(lifecycle, event);
  lifecycle.vault = event.params.vault;
  lifecycle.strategyId = event.params.strategyId;
  lifecycle.frontId = event.params.frontId;
  lifecycle.filler = event.params.filler;
  lifecycle.restored = event.params.restored;
  lifecycle.feeOwed = event.params.feeOwed;
  lifecycle.action = "OBLIGATION_SETTLED";
  lifecycle.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.filler, event.params.strategyId, event);
}

export function handleFrontObligationAborted(event: FrontObligationAborted): void {
  const lifecycle = new FrontLifecycleEvent(eventId(event));
  stamp(lifecycle, event);
  lifecycle.vault = event.params.vault;
  lifecycle.strategyId = event.params.strategyId;
  lifecycle.frontId = event.params.frontId;
  lifecycle.filler = event.params.filler;
  lifecycle.restored = event.params.restored;
  lifecycle.feePaid = event.params.feePaid;
  lifecycle.unrecovered = event.params.unrecovered;
  lifecycle.action = "OBLIGATION_ABORTED";
  lifecycle.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
  refreshLPState(event.params.vault, event.params.filler, event.params.strategyId, event);
}

export function handleFrontLandingUnderpaid(event: FrontLandingUnderpaid): void {
  const lifecycle = new FrontLifecycleEvent(eventId(event));
  stamp(lifecycle, event);
  lifecycle.vault = event.params.vault;
  lifecycle.strategyId = event.params.strategyId;
  lifecycle.frontId = event.params.frontId;
  lifecycle.required = event.params.required;
  lifecycle.received = event.params.received;
  lifecycle.action = "LANDING_UNDERPAID";
  lifecycle.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
}

export function handleFrontLandingCredited(event: FrontLandingCredited): void {
  const lifecycle = new FrontLifecycleEvent(eventId(event));
  stamp(lifecycle, event);
  lifecycle.vault = event.params.vault;
  lifecycle.strategyId = event.params.strategyId;
  lifecycle.frontId = event.params.frontId;
  lifecycle.settlementId = event.params.settlementId;
  lifecycle.credited = event.params.credited;
  lifecycle.action = "LANDING_CREDITED";
  lifecycle.save();

  refreshStrategyState(event.params.vault, event.params.strategyId, event);
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
