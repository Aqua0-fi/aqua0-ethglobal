import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { Swapped } from "../generated/AquaSwapVMRouter/AquaSwapVMRouter";
import {
  AquaFill,
  AquaLPFillStats,
  AquaLPVaultFillStats,
  AquaOrder,
  AquaStrategy,
  AquaVenueAdapter,
  ClassVenueSettledEvent,
  StrategyFeeAccruedEvent,
  StrategyPrincipalSoldEvent
} from "../generated/schema";
import { aquaOrderEntityId, contextVenue, loadSwapBuffer } from "./aqua-venue";
import { eventId, network, strategyEntityId } from "./common";

const ONE = BigInt.fromI32(1);

function hasSettlement(vaults: Array<string>, classIds: Array<string>, vault: Bytes, classId: BigInt): boolean {
  const vaultHex = vault.toHexString();
  const classHex = classId.toString();
  for (let i = 0; i < vaults.length; i++) {
    if (vaults[i] == vaultHex && classIds[i] == classHex) return true;
  }
  return false;
}

function recordLpFill(
  lp: Bytes,
  vault: Bytes,
  principalSold: BigInt,
  feesCredited: BigInt,
  seenLps: Array<string>,
  seenLpVaults: Array<string>,
  event: ethereum.Event
): void {
  const lpId = lp.toHexString();
  if (!seenLps.includes(lpId)) {
    seenLps.push(lpId);
    let stats = AquaLPFillStats.load(lpId);
    if (stats == null) {
      stats = new AquaLPFillStats(lpId);
      stats.lp = lp;
      stats.network = network();
      stats.fillCount = BigInt.zero();
      stats.firstFillBlock = event.block.number;
    }
    stats.fillCount = stats.fillCount.plus(ONE);
    stats.lastFillBlock = event.block.number;
    stats.lastFillTimestamp = event.block.timestamp;
    stats.save();
  }

  const lpVaultId = vault.toHexString() + "-" + lpId;
  let vaultStats = AquaLPVaultFillStats.load(lpVaultId);
  if (vaultStats == null) {
    vaultStats = new AquaLPVaultFillStats(lpVaultId);
    vaultStats.vault = vault;
    vaultStats.lp = lp;
    vaultStats.network = network();
    vaultStats.fillCount = BigInt.zero();
    vaultStats.principalSold = BigInt.zero();
    vaultStats.feesCredited = BigInt.zero();
  }
  if (!seenLpVaults.includes(lpVaultId)) {
    seenLpVaults.push(lpVaultId);
    vaultStats.fillCount = vaultStats.fillCount.plus(ONE);
  }
  vaultStats.principalSold = vaultStats.principalSold.plus(principalSold);
  vaultStats.feesCredited = vaultStats.feesCredited.plus(feesCredited);
  vaultStats.lastFillBlock = event.block.number;
  vaultStats.lastFillTimestamp = event.block.timestamp;
  vaultStats.save();
}

export function handleSwapped(event: Swapped): void {
  const params = event.params;

  const fill = new AquaFill(eventId(event));
  fill.txHash = event.transaction.hash;
  fill.logIndex = event.logIndex;
  fill.blockNumber = event.block.number;
  fill.timestamp = event.block.timestamp;
  fill.network = network();
  fill.router = event.address;
  fill.venue = contextVenue();
  fill.orderHash = params.orderHash;
  fill.maker = params.maker;
  fill.taker = params.taker;
  fill.tokenIn = params.tokenIn;
  fill.tokenOut = params.tokenOut;
  fill.amountIn = params.amountIn;
  fill.amountOut = params.amountOut;
  fill.servedByAqua0 = false;

  const settlementIds = new Array<string>();
  const saleIds = new Array<string>();
  const feeIds = new Array<string>();
  const lps = new Array<Bytes>();
  let principalSold = BigInt.zero();
  let feesCredited = BigInt.zero();

  const adapter = AquaVenueAdapter.load(params.maker.toHexString());
  if (adapter != null) {
    fill.adapter = adapter.id;
    if (fill.venue === null) fill.venue = adapter.venue;
    adapter.fillCount = adapter.fillCount.plus(ONE);
    adapter.updatedAtBlock = event.block.number;
    adapter.updatedAtTimestamp = event.block.timestamp;
    adapter.save();

    const order = AquaOrder.load(aquaOrderEntityId(params.maker, params.orderHash));
    if (order != null) {
      fill.servedByAqua0 = true;
      fill.order = order.id;
      order.fillCount = order.fillCount.plus(ONE);
      order.save();

      const strategy = AquaStrategy.load(order.aquaStrategy);
      if (strategy != null) {
        fill.aquaStrategy = strategy.id;
        fill.aquaStrategyId = strategy.strategyId;
        const classId = strategy.classId;
        if (classId !== null) {
          fill.strategyClassId = classId;
          fill.strategy = strategyEntityId(classId);
        }
        strategy.fillCount = strategy.fillCount.plus(ONE);
        strategy.updatedAtBlock = event.block.number;
        strategy.updatedAtTimestamp = event.block.timestamp;
        strategy.save();
      }
    }

    // Attach the vault settlements THIS adapter booked inside the swap's maker hooks (adapter + vault + class).
    // Entries tagged with another adapter stay buffered for that adapter's own Swapped.
    const buffer = loadSwapBuffer(event);
    const makerHex = params.maker.toHexString();
    const settledVaults = new Array<string>();
    const settledClasses = new Array<string>();

    const bufferedSettlements = buffer.venueSettlements;
    const keptSettlements = new Array<string>();
    for (let i = 0; i < bufferedSettlements.length; i++) {
      const row = ClassVenueSettledEvent.load(bufferedSettlements[i]);
      if (row == null) continue;
      if (row.venue.toHexString() != makerHex) {
        keptSettlements.push(bufferedSettlements[i]);
        continue;
      }
      settlementIds.push(row.id);
      settledVaults.push(row.vault.toHexString());
      settledClasses.push(row.strategyId.toString());
      if (row.netToStrategy.lt(BigInt.zero())) fill.vaultOut = row.vault;
      else fill.vaultIn = row.vault;
      if (fill.strategyClassId === null) {
        fill.strategyClassId = row.strategyId;
        fill.strategy = strategyEntityId(row.strategyId);
      }
    }

    const seenLps = new Array<string>();
    const seenLpVaults = new Array<string>();

    const bufferedSales = buffer.principalSales;
    const saleVenues = buffer.principalSaleVenues;
    const keptSales = new Array<string>();
    const keptSaleVenues = new Array<string>();
    for (let i = 0; i < bufferedSales.length; i++) {
      if (saleVenues[i] != makerHex) {
        keptSales.push(bufferedSales[i]);
        keptSaleVenues.push(saleVenues[i]);
        continue;
      }
      const row = StrategyPrincipalSoldEvent.load(bufferedSales[i]);
      if (row == null || !hasSettlement(settledVaults, settledClasses, row.vault, row.strategyId)) continue;
      saleIds.push(row.id);
      principalSold = principalSold.plus(row.sold);
      if (!seenLps.includes(row.lp.toHexString())) lps.push(row.lp);
      recordLpFill(row.lp, row.vault, row.sold, BigInt.zero(), seenLps, seenLpVaults, event);
    }

    const bufferedFees = buffer.feeAccruals;
    const feeVenues = buffer.feeAccrualVenues;
    const keptFees = new Array<string>();
    const keptFeeVenues = new Array<string>();
    for (let i = 0; i < bufferedFees.length; i++) {
      if (feeVenues[i] != makerHex) {
        keptFees.push(bufferedFees[i]);
        keptFeeVenues.push(feeVenues[i]);
        continue;
      }
      const row = StrategyFeeAccruedEvent.load(bufferedFees[i]);
      if (row == null || !hasSettlement(settledVaults, settledClasses, row.vault, row.strategyId)) continue;
      feeIds.push(row.id);
      feesCredited = feesCredited.plus(row.credited);
      if (!seenLps.includes(row.lp.toHexString())) lps.push(row.lp);
      recordLpFill(row.lp, row.vault, BigInt.zero(), row.credited, seenLps, seenLpVaults, event);
    }

    buffer.venueSettlements = keptSettlements;
    buffer.principalSales = keptSales;
    buffer.principalSaleVenues = keptSaleVenues;
    buffer.feeAccruals = keptFees;
    buffer.feeAccrualVenues = keptFeeVenues;
    buffer.save();
  }

  fill.venueSettlements = settlementIds;
  fill.principalSales = saleIds;
  fill.feeAccruals = feeIds;
  fill.lps = lps;
  fill.principalSold = principalSold;
  fill.feesCredited = feesCredited;
  fill.save();
}
