import { Address, BigInt, Bytes, dataSource, ethereum } from "@graphprotocol/graph-ts";
import {
  AquaSwapSettlementBuffer,
  AquaVenueAdapter,
  StrategyFeeAccruedEvent,
  StrategyPrincipalSoldEvent
} from "../generated/schema";

// Ids shared by the AquaAdapter and AquaSwapVMRouter mappings. Both include the adapter (maker) address, so the
// pegged and FXSwap adapters never collide.

export function aquaStrategyEntityId(adapter: Address, strategyId: Bytes): string {
  return adapter.toHexString() + "-" + strategyId.toHexString();
}

export function aquaOrderEntityId(maker: Address, orderHash: Bytes): string {
  return maker.toHexString() + "-" + orderHash.toHexString();
}

// Venue label ("pegged" | "fxswap") from the `venue` data source context the Arc manifest generator sets on each
// adapter and router data source. Manifests without that context (Base) leave it null.
export function contextVenue(): string | null {
  const value = dataSource.context().get("venue");
  if (value == null) return null;
  return value.toString();
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
//     (vault, classId), tagging each with that adapter, records the settlement, then clears `pending*`;
//   - `Swapped` consumes only the settlements and rows tagged with its maker adapter (adapter + vault + class),
//     leaving any other adapter's entries in place, so the pegged and FXSwap venues can share vaults and classes.
// The buffer is reset whenever a log from a different transaction arrives.

const BUFFER_ID = "pending";

function resetLists(buffer: AquaSwapSettlementBuffer): void {
  buffer.pendingPrincipalSales = new Array<string>();
  buffer.pendingFeeAccruals = new Array<string>();
  buffer.venueSettlements = new Array<string>();
  buffer.principalSales = new Array<string>();
  buffer.principalSaleVenues = new Array<string>();
  buffer.feeAccruals = new Array<string>();
  buffer.feeAccrualVenues = new Array<string>();
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
    const venueHex = venue.toHexString();

    const settlements = buffer.venueSettlements;
    settlements.push(historyId);
    buffer.venueSettlements = settlements;

    const sales = buffer.principalSales;
    const saleVenues = buffer.principalSaleVenues;
    for (let i = 0; i < pendingSales.length; i++) {
      const row = StrategyPrincipalSoldEvent.load(pendingSales[i]);
      if (row != null && row.vault.toHexString() == vaultHex && row.strategyId.equals(strategyId)) {
        sales.push(pendingSales[i]);
        saleVenues.push(venueHex);
      }
    }
    buffer.principalSales = sales;
    buffer.principalSaleVenues = saleVenues;

    const fees = buffer.feeAccruals;
    const feeVenues = buffer.feeAccrualVenues;
    for (let i = 0; i < pendingFees.length; i++) {
      const row = StrategyFeeAccruedEvent.load(pendingFees[i]);
      if (row != null && row.vault.toHexString() == vaultHex && row.strategyId.equals(strategyId)) {
        fees.push(pendingFees[i]);
        feeVenues.push(venueHex);
      }
    }
    buffer.feeAccruals = fees;
    buffer.feeAccrualVenues = feeVenues;
  }

  buffer.pendingPrincipalSales = new Array<string>();
  buffer.pendingFeeAccruals = new Array<string>();
  buffer.save();
}
