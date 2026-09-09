import { V4SwapSettled } from "../generated/V4Adapter/V4Adapter";
import { V4SwapSettledEvent } from "../generated/schema";
import { eventId, network } from "./common";

export function handleV4SwapSettled(event: V4SwapSettled): void {
  const history = new V4SwapSettledEvent(eventId(event));
  history.txHash = event.transaction.hash;
  history.logIndex = event.logIndex;
  history.blockNumber = event.block.number;
  history.timestamp = event.block.timestamp;
  history.network = network();
  history.adapter = event.params.adapter;
  history.strategyId = event.params.strategyId;
  history.swapId = event.params.swapId;
  history.token0 = event.params.token0;
  history.delta0 = event.params.delta0;
  history.token1 = event.params.token1;
  history.delta1 = event.params.delta1;
  history.save();
}
