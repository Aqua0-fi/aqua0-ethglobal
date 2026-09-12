/**
 * Wakes the keeper on real trades: polls the forex router's Swapped logs (Arc's public RPC has no subscriptions) from
 * the last seen block and returns swaps on the watched strategies. Swapped.orderHash is the strategy id. The keeper's
 * own swaps are ignored so a rebalance does not wake it again.
 */
import { getAddress, parseAbiItem, type Address } from "viem";

import { USDC_ERC20_INTERFACE_ADDRESS, type KeeperStrategyRef, type ReadClient } from "@aqua0/shared";

import type { SwapEvent } from "./policy.js";

export const swappedEvent = parseAbiItem(
  "event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)"
);

export type SwappedLog = {
  args: { orderHash?: string; taker?: string; tokenIn?: string; tokenOut?: string; amountIn?: bigint; amountOut?: bigint };
  transactionHash: string | null;
  blockNumber: bigint | null;
};

export function swapsFromLogs(
  logs: readonly SwappedLog[],
  strategies: readonly KeeperStrategyRef[],
  ignoreTaker?: string
): SwapEvent[] {
  const byId = new Map(strategies.map((strategy) => [strategy.strategyId.toLowerCase(), strategy]));
  const ignored = ignoreTaker?.toLowerCase();
  const usdc = USDC_ERC20_INTERFACE_ADDRESS.toLowerCase();
  const events: SwapEvent[] = [];
  for (const log of logs) {
    const strategy = byId.get(String(log.args.orderHash ?? "").toLowerCase());
    const taker = String(log.args.taker ?? "").toLowerCase();
    if (!strategy || !log.transactionHash || (ignored && taker === ignored)) {
      continue;
    }
    events.push({
      pair: strategy.pair,
      strategyId: strategy.strategyId,
      txHash: log.transactionHash,
      blockNumber: (log.blockNumber ?? 0n).toString(),
      taker,
      direction: String(log.args.tokenIn ?? "").toLowerCase() === usdc ? "usdc-in" : "fx-in",
      amountIn: (log.args.amountIn ?? 0n).toString(),
      amountOut: (log.args.amountOut ?? 0n).toString()
    });
  }
  return events;
}

export class SwapWatcher {
  readonly #client: ReadClient;
  readonly #router: Address;
  readonly #strategies: readonly KeeperStrategyRef[];
  readonly #ignoreTaker: string | undefined;
  #lastBlock: bigint | undefined;

  constructor(options: { client: ReadClient; router: string; strategies: readonly KeeperStrategyRef[]; ignoreTaker?: string; fromBlock?: bigint }) {
    this.#client = options.client;
    this.#router = getAddress(options.router);
    this.#strategies = options.strategies;
    this.#ignoreTaker = options.ignoreTaker;
    this.#lastBlock = options.fromBlock;
  }

  get lastBlock(): bigint | undefined {
    return this.#lastBlock;
  }

  /** New swaps since the previous poll (the first poll only records the head block). */
  async poll(): Promise<SwapEvent[]> {
    const head = await this.#client.getBlockNumber();
    if (this.#lastBlock === undefined) {
      this.#lastBlock = head;
      return [];
    }
    if (head <= this.#lastBlock) {
      return [];
    }
    const fromBlock = this.#lastBlock + 1n;
    const toBlock = head - fromBlock > 9_999n ? fromBlock + 9_999n : head;
    const logs = await this.#client.getLogs({ address: this.#router, event: swappedEvent, fromBlock, toBlock });
    this.#lastBlock = toBlock;
    return swapsFromLogs(logs as unknown as SwappedLog[], this.#strategies, this.#ignoreTaker);
  }
}
