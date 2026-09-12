/**
 * The keeper's decision seam. A policy sees an observation (what woke the keeper, the signals it bought this tick,
 * its balances, cooldowns, limits) and a budget, and returns exactly one decision from a closed set of actions with a
 * reason. Policies never send anything: the executor checks every decision against the guardrails (guard.ts) before
 * acting, so a policy (the deterministic rules below, or a model) is sandboxed by construction.
 */
import type {
  BookSignal,
  KeeperJournalEntry,
  KeeperLlmUsage,
  KeeperSignalLine,
  OracleSignal,
  RebalanceDirection,
  SignalName,
  SignalsSnapshot
} from "@aqua0/shared";

export const ACTIONS = ["rebalance", "wait", "buy_signal", "recommend_dock", "top_up_usdc", "top_up_gateway"] as const;
export type ActionName = (typeof ACTIONS)[number];
export const SIGNAL_NAMES: readonly SignalName[] = ["oracle", "book", "vault"];

export type Decision =
  | { action: "rebalance"; strategyId: string; pair: string; direction: RebalanceDirection; sizeUsdc: number; reason: string }
  | { action: "wait"; reason: string }
  | { action: "buy_signal"; which: SignalName; reason: string }
  | { action: "recommend_dock"; strategyId: string; pair: string; reason: string }
  | { action: "top_up_usdc"; amountUsdc: number; reason: string }
  | { action: "top_up_gateway"; amountUsdc: number; reason: string };

export type WakeKind = "startup" | "swap" | "heartbeat" | "manual";

export type SwapEvent = {
  pair: string;
  strategyId: string;
  txHash: string;
  blockNumber: string;
  taker: string;
  direction: RebalanceDirection;
  amountIn: string;
  amountOut: string;
};

export type Limits = {
  /** A book whose 0.1 USDC probe spread is above this is tilted. */
  tiltThresholdBps: number;
  maxTradeUsdc: number;
  minTradeUsdc: number;
  /** Per strategy, after an executed rebalance. */
  cooldownSeconds: number;
  keeperUsdcFloor: number;
  keeperTopUpUsdc: number;
  gatewayFloorUsdc: number;
  gatewayTopUpUsdc: number;
  /** An oracle reading older than this is bought again before a trade. */
  oracleMaxAgeForTradeSeconds: number;
  bookRefreshSeconds: number;
  vaultRefreshSeconds: number;
  dockRepeatSeconds: number;
  allowedActions: readonly ActionName[];
  /** USDC per paid signal. */
  prices: Record<SignalName, number>;
};

export type BoughtSignal = { at: string; blockNumber: string; snapshot: SignalsSnapshot; spentUsdc: number };

export type Observation = {
  now: string;
  tick: number;
  wake: { kind: WakeKind; swaps: SwapEvent[] };
  keeper: { address: string; usdc: number | null; gatewayUsdc: number | null };
  strategies: Array<{ pair: string; strategyId: string }>;
  /** Signals bought during this tick. */
  bought: Partial<Record<SignalName, BoughtSignal>>;
  /** Seconds since each signal was last bought (any tick); null when never. */
  signalAgeSeconds: Record<SignalName, number | null>;
  /** Compact signal lines from the previous tick. */
  lastKnown: KeeperSignalLine[];
  /** Seconds of cooldown left per strategy id (absent = none). */
  cooldownSeconds: Record<string, number>;
  /** Seconds since a dock was last recommended per strategy id (absent = never). */
  dockRecommendedAgeSeconds: Record<string, number>;
  limits: Limits;
};

export type Budget = {
  dataSpentHourUsdc: number;
  dataBudgetHourUsdc: number;
  dataRemainingUsdc: number;
  topUpsTodayUsdc: number;
  topUpCapDayUsdc: number;
  gatewayDepositsTodayUsdc: number;
  gatewayCapDayUsdc: number;
  llmSpentDayUsd: number;
  llmCapDayUsd: number;
};

export type PolicyOutcome = { decision: Decision; by: string; llm?: KeeperLlmUsage };

export interface Policy {
  readonly name: string;
  readonly model: string | null;
  decide(observation: Observation, budget: Budget, journalTail: readonly KeeperJournalEntry[]): Promise<PolicyOutcome>;
}

export type StrategyView = {
  pair: string;
  strategyId: string;
  oracle: OracleSignal | null;
  book: BookSignal | null;
  /** Oracle status this tick, or from the last tick while the reading is still recent enough to trade on. */
  oracleStatus: string | null;
};

/** This tick's view of each strategy: bought oracle and book signals, falling back to recent oracle status. */
export function strategyViews(observation: Observation): StrategyView[] {
  const oracleRows = observation.bought.oracle?.snapshot.strategies ?? [];
  const bookRows = observation.bought.book?.snapshot.strategies ?? [];
  const recentOracle =
    observation.signalAgeSeconds.oracle !== null &&
    observation.signalAgeSeconds.oracle <= observation.limits.oracleMaxAgeForTradeSeconds;
  return observation.strategies.map((strategy) => {
    const oracle = oracleRows.find((row) => row.strategyId === strategy.strategyId)?.oracle ?? null;
    const book = bookRows.find((row) => row.strategyId === strategy.strategyId)?.book ?? null;
    const previous = observation.lastKnown.find((line) => line.strategyId === strategy.strategyId);
    return {
      ...strategy,
      oracle,
      book,
      oracleStatus: oracle?.status ?? (recentOracle ? (previous?.oracleStatus ?? null) : null)
    };
  });
}

export function tiltedStrategies(observation: Observation): StrategyView[] {
  return strategyViews(observation)
    .filter((view) => view.book?.spreadBps !== null && view.book?.spreadBps !== undefined && view.book.rebalance !== null)
    .filter((view) => (view.book?.spreadBps ?? 0) > observation.limits.tiltThresholdBps)
    .sort((a, b) => (b.book?.spreadBps ?? 0) - (a.book?.spreadBps ?? 0));
}

/** The next signal worth paying for this tick, or null when the keeper has what it needs. */
export function nextSignalToBuy(observation: Observation): { which: SignalName; reason: string } | null {
  const has = (which: SignalName) => observation.bought[which] !== undefined;
  const age = observation.signalAgeSeconds;
  const limits = observation.limits;
  const olderThan = (which: SignalName, seconds: number) => age[which] === null || (age[which] ?? 0) > seconds;
  if (observation.wake.kind === "swap") {
    const pairs = [...new Set(observation.wake.swaps.map((swap) => swap.pair))].join(", ");
    if (!has("book")) {
      return { which: "book", reason: `a swap just moved ${pairs}: read the book tilt` };
    }
    if (tiltedStrategies(observation).length > 0 && !has("oracle") && olderThan("oracle", limits.oracleMaxAgeForTradeSeconds)) {
      return { which: "oracle", reason: "a book is tilted: confirm the oracle is fresh before trading" };
    }
    return null;
  }
  if (!has("oracle")) {
    return { which: "oracle", reason: observation.wake.kind === "heartbeat" ? "heartbeat: check oracle staleness and band" : "startup: read oracle freshness" };
  }
  if (!has("book") && (observation.wake.kind !== "heartbeat" || olderThan("book", limits.bookRefreshSeconds))) {
    return {
      which: "book",
      reason: age.book === null || observation.wake.kind !== "heartbeat" ? "read the book tilt" : `book signal is ${age.book}s old`
    };
  }
  if (!has("vault") && olderThan("vault", limits.vaultRefreshSeconds)) {
    return { which: "vault", reason: age.vault === null ? "read vault backing once" : `vault signal is ${age.vault}s old` };
  }
  return null;
}

/** The deterministic rules policy (default without a model, and the model's fallback). */
export function rulesDecide(observation: Observation, budget: Budget): Decision {
  const limits = observation.limits;
  const allowed = new Set(limits.allowedActions);
  const { usdc, gatewayUsdc } = observation.keeper;

  if (allowed.has("top_up_gateway") && gatewayUsdc !== null && gatewayUsdc < limits.gatewayFloorUsdc) {
    const amount = round6(Math.min(limits.gatewayTopUpUsdc, budget.gatewayCapDayUsdc - budget.gatewayDepositsTodayUsdc));
    if (amount > 0 && usdc !== null && usdc >= amount + 0.05) {
      return {
        action: "top_up_gateway",
        amountUsdc: amount,
        reason: `Gateway balance ${gatewayUsdc} USDC is under the ${limits.gatewayFloorUsdc} floor, so signals cannot be paid for`
      };
    }
  }
  if (allowed.has("top_up_usdc") && usdc !== null && usdc < limits.keeperUsdcFloor) {
    const amount = round6(Math.min(limits.keeperTopUpUsdc, budget.topUpCapDayUsdc - budget.topUpsTodayUsdc));
    if (amount > 0) {
      return {
        action: "top_up_usdc",
        amountUsdc: amount,
        reason: `keeper wallet holds ${usdc} USDC, under the ${limits.keeperUsdcFloor} floor it needs for gas and trades`
      };
    }
  }

  const next = allowed.has("buy_signal") ? nextSignalToBuy(observation) : null;
  if (next) {
    const price = limits.prices[next.which];
    if (price > budget.dataRemainingUsdc) {
      return {
        action: "wait",
        reason: `data budget: ${round6(budget.dataRemainingUsdc)} USDC left this hour, the ${next.which} signal costs ${price}`
      };
    }
    return { action: "buy_signal", which: next.which, reason: next.reason };
  }

  const views = strategyViews(observation);
  if (allowed.has("recommend_dock")) {
    for (const view of views) {
      const status = view.oracle?.status;
      if (status !== "stale" && status !== "out-of-band") {
        continue;
      }
      const sinceLast = observation.dockRecommendedAgeSeconds[view.strategyId];
      if (sinceLast !== undefined && sinceLast < limits.dockRepeatSeconds) {
        continue;
      }
      return {
        action: "recommend_dock",
        strategyId: view.strategyId,
        pair: view.pair,
        reason:
          status === "stale"
            ? `${view.pair} oracle is ${view.oracle?.ageSeconds}s old, past its ${view.oracle?.maxStalenessSeconds}s window: swaps revert until it is refreshed; the strategist should dock it`
            : `${view.pair} oracle price ${view.oracle?.price} is outside the strategy band: the strategist should dock it`
      };
    }
  }

  if (allowed.has("rebalance")) {
    for (const view of tiltedStrategies(observation)) {
      const book = view.book!;
      const plan = book.rebalance!;
      if (view.oracleStatus !== "ok") {
        continue;
      }
      const cooldown = observation.cooldownSeconds[view.strategyId] ?? 0;
      if (cooldown > 0) {
        return { action: "wait", reason: `${view.pair} spread ${book.spreadBps} bps is tilted but the rebalance cooldown has ${cooldown}s left` };
      }
      const size = round6(Math.min(plan.sizeUsdc, limits.maxTradeUsdc));
      if (size < limits.minTradeUsdc) {
        continue;
      }
      if (plan.direction === "usdc-in" && (usdc === null || usdc < size + 0.05)) {
        return { action: "wait", reason: `${view.pair} needs ${size} USDC in to rebalance, the keeper holds ${usdc ?? "unknown"}` };
      }
      return {
        action: "rebalance",
        strategyId: view.strategyId,
        pair: view.pair,
        direction: plan.direction,
        sizeUsdc: size,
        reason: `${view.pair} spread ${book.spreadBps} bps is above ${limits.tiltThresholdBps} (${book.side}, USDC share ${book.usdcShare}); ${plan.direction === "fx-in" ? "sell FX for USDC" : "buy FX with USDC"} worth ${size} USDC to restore an even split`
      };
    }
  }

  const books = views
    .filter((view) => view.book?.spreadBps !== null && view.book?.spreadBps !== undefined)
    .map((view) => `${view.pair} ${view.book?.spreadBps} bps`)
    .join(", ");
  if (observation.wake.kind === "swap") {
    return { action: "wait", reason: books ? `after the swap the books are within threshold ${limits.tiltThresholdBps} bps: ${books}` : "no readable book after the swap" };
  }
  return {
    action: "wait",
    reason: books ? `books within ${limits.tiltThresholdBps} bps (${books}), oracles fresh` : "oracles fresh; book not re-read this heartbeat"
  };
}

export class RulesPolicy implements Policy {
  readonly name = "rules";
  readonly model = null;

  decide(observation: Observation, budget: Budget): Promise<PolicyOutcome> {
    return Promise.resolve({ decision: rulesDecide(observation, budget), by: "rules" });
  }
}

export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
