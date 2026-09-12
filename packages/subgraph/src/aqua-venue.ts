import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  AquaSwapSettlementBuffer,
  AquaVenueAdapter,
  StrategyFeeAccruedEvent,
  StrategyPrincipalSoldEvent
} from "../generated/schema";

// Ids shared by the AquaAdapter and AquaSwapVMRouter mappings.

export function aquaStrategyEntityId(adapter: Address, strategyId: Bytes): string {
  return adapter.toHexString() + "-" + strategyId.toHexString();
}

export function aquaOrderEntityId(maker: Address, orderHash: Bytes): string {
  return maker.toHexString() + "-" + orderHash.toHexString();
}

// Swap settlement threading.
//
// During an Aqua swap the adapter's maker hooks call `AssetVault.settleVenueOut` on the tokenOut vault and
// `settleVenueCredit` on the tokenIn vault. Each call first emits its per-LP rows (`StrategyPrincipalSold` /
// `StrategyFeeAccrued`) and then one `ClassVenueSettled(vault, classId, venue=adapter, delta)`. The router emits
// `Swapped` only after both hooks ran, so every settlement log precedes the fill log in the same transaction.
// Graph Node processes triggers in log order, so one singleton buffer is enough:
//   - per-LP rows land in `pending*`;
//   - a `ClassVenueSettled` from an indexed Aqua0 adapter promotes the pending rows for the same
//     (vault, classId) and records the settlement, then clears `pending*`;
//   - `Swapped` consumes everything promoted in this transaction and resets the buffer.
// The buffer is reset whenever a log from a different transaction arrives.

const BUFFER_ID = "pending";

function resetLists(buffer: AquaSwapSettlementBuffer): void {
  buffer.pendingPrincipalSales = new Array<string>();
  buffer.pendingFeeAccruals = new Array<string>();
  buffer.venueSettlements = new Array<string>();
  buffer.principalSales = new Array<string>();
  buffer.feeAccruals = new Array<string>();
}

export function loadSwapBuffer(event: ethereum.Event): AquaSwapSettlementBuffer {
  let buffer = AquaSwapSettlementBuffer.load(BUFFER_ID);
  if (buffer == null) {
    buffer = new AquaSwapSettlementBuffer(BUFFER_ID);
    buffer.txHash = event.transaction.hash;
    resetLists(buffer);
    return buffer;
  }
  if (buffer.txHash.toHexString() != event.transaction.hash.toHexString()) {
    buffer.txHash = event.transaction.hash;
    resetLists(buffer);
  }
  return buffer;
}

export function resetSwapBuffer(buffer: AquaSwapSettlementBuffer): void {
  resetLists(buffer);
}

export function bufferPrincipalSale(event: ethereum.Event, historyId: string): void {
  const buffer = loadSwapBuffer(event);
  const pending = buffer.pendingPrincipalSales;
  pending.push(historyId);
  buffer.pendingPrincipalSales = pending;
  buffer.save();
}

export function bufferFeeAccrual(event: ethereum.Event, historyId: string): void {
  const buffer = loadSwapBuffer(event);
  const pending = buffer.pendingFeeAccruals;
  pending.push(historyId);
  buffer.pendingFeeAccruals = pending;
  buffer.save();
}

export function bufferVenueSettlement(
  event: ethereum.Event,
  historyId: string,
  vault: Address,
  strategyId: BigInt,
  venue: Address
): void {
  const buffer = loadSwapBuffer(event);
  const pendingSales = buffer.pendingPrincipalSales;
  const pendingFees = buffer.pendingFeeAccruals;

  if (AquaVenueAdapter.load(venue.toHexString()) != null) {
    const vaultHex = vault.toHexString();

    const settlements = buffer.venueSettlements;
    settlements.push(historyId);
    buffer.venueSettlements = settlements;

    const sales = buffer.principalSales;
    for (let i = 0; i < pendingSales.length; i++) {
      const row = StrategyPrincipalSoldEvent.load(pendingSales[i]);
      if (row != null && row.vault.toHexString() == vaultHex && row.strategyId.equals(strategyId)) {
        sales.push(pendingSales[i]);
      }
    }
    buffer.principalSales = sales;

    const fees = buffer.feeAccruals;
    for (let i = 0; i < pendingFees.length; i++) {
      const row = StrategyFeeAccruedEvent.load(pendingFees[i]);
      if (row != null && row.vault.toHexString() == vaultHex && row.strategyId.equals(strategyId)) {
        fees.push(pendingFees[i]);
      }
    }
    buffer.feeAccruals = fees;
  }

  buffer.pendingPrincipalSales = new Array<string>();
  buffer.pendingFeeAccruals = new Array<string>();
  buffer.save();
}
